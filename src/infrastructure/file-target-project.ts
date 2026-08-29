import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ExportTargetSafetyError, ExportWriteError } from '../application/errors.js';
import type {
  ExistingTargetFile,
  TargetExportFilesystem,
  TargetProjectFacts,
  TargetProjectProbe,
} from '../application/export-ports.js';
import type {
  ExportEntry,
  ExportReceiptEntry,
  ExportValidationResult,
  PackageManager,
} from '../domain/export.js';

const execFileAsync = promisify(execFile);
const MAX_STATIC_FILE_BYTES = 1024 * 1024;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 200_000;
const CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mts',
  'playwright.config.mjs',
] as const;
const COMMON_TEST_DIRECTORIES = ['tests', 'e2e', 'tests/e2e', 'playwright'] as const;

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function safeRelativeFile(value: string): string {
  if (
    value === '' ||
    value.startsWith('~') ||
    value.includes('\0') ||
    value.includes('\\') ||
    posix.isAbsolute(value)
  ) {
    throw new ExportTargetSafetyError('Export destination must be a safe relative path.');
  }
  const normalized = posix.normalize(value);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    !/^[-a-zA-Z0-9_./]+$/.test(normalized)
  ) {
    throw new ExportTargetSafetyError('Export destination escapes or violates the target path.');
  }
  return normalized;
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function safeIdentifier(value: string): string {
  const withoutControls = Array.from(value.normalize('NFKC'))
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
    })
    .join('');
  const normalized = withoutControls
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 100);
  return normalized || 'target-project';
}

function staticString(contents: string, key: string): string | null {
  const quoted = new RegExp(`\\b${key}\\s*:\\s*(["'])((?:\\\\.|(?!\\1).){0,1000})\\1`);
  const match = quoted.exec(contents);
  if (match?.[2] !== undefined) {
    return match[2].replaceAll(/\\([\\"'])/g, '$1');
  }
  const backtick = new RegExp(`\\b${key}\\s*:\\s*\`([^\`]{0,1000})\``).exec(contents);
  const value = backtick?.[1];
  return value !== undefined && !value.includes('${') ? value : null;
}

async function boundedText(path: string): Promise<string | null> {
  const details = await optionalLstat(path);
  if (details === null || !details.isFile() || details.isSymbolicLink()) return null;
  if (details.size > MAX_STATIC_FILE_BYTES) return null;
  return readFile(path, 'utf8');
}

async function git(root: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd: root,
      timeout: 5_000,
      maxBuffer: MAX_COMMAND_OUTPUT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export class FileTargetProject implements TargetProjectProbe, TargetExportFilesystem {
  public async inspect(targetPath: string): Promise<TargetProjectFacts> {
    const requested = resolve(targetPath);
    let rootPath: string;
    try {
      const details = await stat(requested);
      if (!details.isDirectory()) throw new Error('not a directory');
      rootPath = await realpath(requested);
    } catch {
      throw new ExportTargetSafetyError(`Target project directory does not exist: "${requested}".`);
    }
    const warnings: string[] = [];
    const packagePath = join(rootPath, 'package.json');
    const packageContents = await boundedText(packagePath);
    let packageValue: Record<string, unknown> | null = null;
    if (packageContents !== null) {
      try {
        const parsed = JSON.parse(packageContents) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          packageValue = parsed as Record<string, unknown>;
        } else {
          warnings.push('package.json is not a JSON object.');
        }
      } catch {
        warnings.push('package.json could not be parsed; no scripts were executed.');
      }
    }
    const dependencyNames = new Set<string>();
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const value = packageValue?.[section];
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      Object.keys(value)
        .slice(0, 5_000)
        .forEach((name) => dependencyNames.add(name));
    }
    const locks = {
      npm: (await optionalLstat(join(rootPath, 'package-lock.json')))?.isFile() === true,
      pnpm: (await optionalLstat(join(rootPath, 'pnpm-lock.yaml')))?.isFile() === true,
      yarn: (await optionalLstat(join(rootPath, 'yarn.lock')))?.isFile() === true,
    };
    const detectedManagers = (Object.keys(locks) as (keyof typeof locks)[]).filter(
      (manager) => locks[manager],
    );
    if (detectedManagers.length > 1) {
      warnings.push(`Multiple package-manager lockfiles detected: ${detectedManagers.join(', ')}.`);
    }
    const packageManager: PackageManager = locks.npm
      ? 'npm'
      : locks.pnpm
        ? 'pnpm'
        : locks.yarn
          ? 'yarn'
          : 'unknown';

    let playwrightConfig: string | null = null;
    let configContents: string | null = null;
    for (const candidate of CONFIG_FILES) {
      const contents = await boundedText(join(rootPath, candidate));
      if (contents === null) continue;
      playwrightConfig = candidate;
      configContents = contents;
      break;
    }
    const configuredTestDirectory =
      configContents === null ? null : staticString(configContents, 'testDir');
    const configuredBaseUrl =
      configContents === null ? null : staticString(configContents, 'baseURL');
    if (playwrightConfig !== null && configuredTestDirectory === null) {
      warnings.push('Playwright config was detected, but testDir was not a static string literal.');
    }

    const existingTestDirectories: string[] = [];
    for (const candidate of COMMON_TEST_DIRECTORIES) {
      const details = await optionalLstat(join(rootPath, ...candidate.split('/')));
      if (details?.isSymbolicLink()) {
        warnings.push(`Ignored symlinked test directory: ${candidate}.`);
      } else if (details?.isDirectory()) {
        existingTestDirectories.push(candidate);
      }
    }
    const tsconfig = (await optionalLstat(join(rootPath, 'tsconfig.json')))?.isFile() === true;
    const configTypeScript =
      playwrightConfig?.endsWith('.ts') === true || playwrightConfig?.endsWith('.mts') === true;
    const language =
      tsconfig || configTypeScript || dependencyNames.has('typescript')
        ? 'typescript'
        : packageValue !== null
          ? 'javascript'
          : 'unknown';
    const moduleValue = packageValue?.type;
    const moduleType =
      moduleValue === 'module' ? 'module' : moduleValue === 'commonjs' ? 'commonjs' : 'unspecified';

    const topLevel = await git(rootPath, ['rev-parse', '--show-toplevel']);
    let repository = false;
    let branch: string | null = null;
    let dirty: boolean | null = null;
    if (topLevel !== null) {
      try {
        repository = (await realpath(topLevel)) === rootPath;
      } catch {
        repository = false;
      }
    }
    if (repository) {
      branch = await git(rootPath, ['branch', '--show-current']);
      dirty = (await git(rootPath, ['status', '--porcelain=v1'])) !== '';
    }
    return {
      rootPath,
      identifier: safeIdentifier(basename(rootPath)),
      packageJson: packageContents !== null,
      packageManager,
      playwrightDependency: dependencyNames.has('@playwright/test'),
      playwrightConfig,
      configuredTestDirectory,
      configuredBaseUrl,
      tsconfig,
      moduleType,
      language,
      existingTestDirectories,
      git: { repository, branch: branch === '' ? null : branch, dirty },
      warnings,
    };
  }

  public async inspectDestination(
    rootPath: string,
    relativePath: string,
  ): Promise<ExistingTargetFile> {
    const destination = this.destination(rootPath, relativePath);
    await this.assertSafeAncestry(rootPath, destination);
    const details = await optionalLstat(destination);
    if (details === null) {
      return { exists: false, digest: null, contents: null, generatedByAgenticQa: false };
    }
    if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_SPEC_BYTES) {
      throw new ExportTargetSafetyError(`Unsafe existing export destination: ${relativePath}.`);
    }
    const contents = await readFile(destination, 'utf8');
    return {
      exists: true,
      digest: digest(contents),
      contents,
      generatedByAgenticQa: contents.startsWith('// Generated by Agentic QA.'),
    };
  }

  public async apply(
    rootPath: string,
    entries: readonly ExportEntry[],
    sources: ReadonlyMap<string, string>,
    overwrite: boolean,
  ): Promise<readonly ExportReceiptEntry[]> {
    const receipt: ExportReceiptEntry[] = [];
    for (const entry of entries) {
      const contents = sources.get(entry.source);
      if (contents === undefined || digest(contents) !== entry.sourceDigest) {
        throw new ExportWriteError(
          `Validated source bytes are unavailable for ${entry.findingId}.`,
        );
      }
      if (entry.status === 'IDENTICAL') {
        receipt.push({
          findingId: entry.findingId,
          destination: entry.destination,
          action: 'UNCHANGED',
          previousDigest: entry.existingDigest,
          newDigest: entry.sourceDigest,
        });
        continue;
      }
      if (entry.status !== 'NEW' && !overwrite) {
        receipt.push({
          findingId: entry.findingId,
          destination: entry.destination,
          action: 'SKIPPED',
          previousDigest: entry.existingDigest,
          newDigest: null,
        });
        continue;
      }
      const destination = this.destination(rootPath, entry.destination);
      await this.ensureSafeDirectory(rootPath, dirname(destination));
      await this.assertSafeAncestry(rootPath, destination);
      try {
        if (entry.status === 'NEW') {
          const handle = await open(destination, 'wx', 0o644);
          try {
            await handle.writeFile(contents, 'utf8');
          } finally {
            await handle.close();
          }
        } else {
          const existing = await optionalLstat(destination);
          if (existing === null || existing.isSymbolicLink() || !existing.isFile()) {
            throw new ExportTargetSafetyError(
              `Conflict target changed before write: ${entry.destination}.`,
            );
          }
          const temporary = `${destination}.agentic-qa-${randomUUID()}.tmp`;
          const handle = await open(temporary, 'wx', 0o644);
          try {
            await handle.writeFile(contents, 'utf8');
          } finally {
            await handle.close();
          }
          try {
            await rename(temporary, destination);
          } finally {
            await unlink(temporary).catch(() => undefined);
          }
        }
      } catch (error) {
        if (error instanceof ExportTargetSafetyError) throw error;
        throw new ExportWriteError(`Could not write ${entry.destination}.`, { cause: error });
      }
      const written = await this.inspectDestination(rootPath, entry.destination);
      if (written.digest !== entry.sourceDigest) {
        throw new ExportWriteError(`EXPORT_WRITE_INTEGRITY_FAILED for ${entry.destination}.`);
      }
      receipt.push({
        findingId: entry.findingId,
        destination: entry.destination,
        action: entry.status === 'NEW' ? 'WRITTEN' : 'OVERWRITTEN',
        previousDigest: entry.existingDigest,
        newDigest: written.digest,
      });
    }
    return receipt;
  }

  public async validate(
    rootPath: string,
    _packageManager: PackageManager,
    destinations: readonly string[],
    timeoutMs: number,
  ): Promise<ExportValidationResult> {
    const cli = join(rootPath, 'node_modules', '@playwright', 'test', 'cli.js');
    if ((await optionalLstat(cli)) === null) {
      return {
        requested: true,
        status: 'NOT_AVAILABLE',
        command: ['node', '@playwright/test/cli.js', 'test', ...destinations, '--list'],
        durationMs: 0,
        output: '@playwright/test is not installed in the target project.',
      };
    }
    const args = [cli, 'test', ...destinations, '--list'];
    const started = Date.now();
    try {
      const result = await execFileAsync(process.execPath, args, {
        cwd: rootPath,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          CI: '1',
          NO_COLOR: '1',
        },
      });
      return {
        requested: true,
        status: 'PASS',
        command: ['node', '@playwright/test/cli.js', 'test', ...destinations, '--list'],
        durationMs: Date.now() - started,
        output: this.safeOutput(rootPath, `${result.stdout}${result.stderr}`),
      };
    } catch (error) {
      const value = error as Error & { stdout?: string; stderr?: string; killed?: boolean };
      return {
        requested: true,
        status: 'FAIL',
        command: ['node', '@playwright/test/cli.js', 'test', ...destinations, '--list'],
        durationMs: Date.now() - started,
        output: this.safeOutput(
          rootPath,
          `${value.stdout ?? ''}${value.stderr ?? ''}${value.killed ? '\nValidation timed out.' : ''}`,
        ),
      };
    }
  }

  public async gitReview(
    rootPath: string,
    destinations: readonly string[],
  ): Promise<readonly string[]> {
    const topLevel = await git(rootPath, ['rev-parse', '--show-toplevel']);
    if (topLevel === null) return [];
    try {
      if ((await realpath(topLevel)) !== rootPath) return [];
    } catch {
      return [];
    }
    const statusOutput = await git(rootPath, ['status', '--short', '--', ...destinations]);
    const diffOutput = await git(rootPath, ['diff', '--no-ext-diff', '--', ...destinations]);
    return [statusOutput, diffOutput]
      .filter((value): value is string => value !== null && value !== '')
      .map((value) => this.safeOutput(rootPath, value));
  }

  private destination(rootPath: string, relativePath: string): string {
    const safe = safeRelativeFile(relativePath);
    const destination = resolve(rootPath, ...safe.split('/'));
    if (!contained(rootPath, destination)) {
      throw new ExportTargetSafetyError(`Export destination escapes the target: ${relativePath}.`);
    }
    return destination;
  }

  private async assertSafeAncestry(rootPath: string, destination: string): Promise<void> {
    const relativePath = relative(rootPath, destination);
    if (!contained(rootPath, destination)) {
      throw new ExportTargetSafetyError('Export destination escapes the canonical target root.');
    }
    let current = rootPath;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      current = join(current, segment);
      const details = await optionalLstat(current);
      if (details === null) break;
      if (details.isSymbolicLink()) {
        let linked = '<unresolved>';
        try {
          linked = await realpath(current);
        } catch {
          // Keep the non-sensitive placeholder.
        }
        throw new ExportTargetSafetyError(
          contained(rootPath, linked)
            ? `Symlinked export path is rejected: ${relative(rootPath, current)}.`
            : `Symlink escape outside the target is rejected: ${relative(rootPath, current)}.`,
        );
      }
    }
  }

  private async ensureSafeDirectory(rootPath: string, directory: string): Promise<void> {
    if (!contained(rootPath, directory)) {
      throw new ExportTargetSafetyError('Export directory escapes the canonical target root.');
    }
    const parts = relative(rootPath, directory).split(sep).filter(Boolean);
    let current = rootPath;
    for (const part of parts) {
      current = join(current, part);
      const existing = await optionalLstat(current);
      if (existing === null) {
        await mkdir(current);
        const created = await lstat(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new ExportTargetSafetyError(
            `Unsafe directory created at ${relative(rootPath, current)}.`,
          );
        }
      } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new ExportTargetSafetyError(
          `Unsafe export directory: ${relative(rootPath, current)}.`,
        );
      }
    }
  }

  private safeOutput(rootPath: string, output: string): string {
    return output.replaceAll(rootPath, '<target>').replaceAll(homedir(), '<home>').slice(0, 20_000);
  }
}
