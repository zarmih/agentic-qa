import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  ExportSourceError,
  ExportTargetSafetyError,
  ExportWriteError,
} from '../application/errors.js';
import type {
  LoadedRegressionExportSource,
  RegressionExportArtifactWriter,
  RegressionExportSourceReader,
} from '../application/export-ports.js';
import {
  parseSavedRegressionManifest,
  SavedRegressionManifestValidationError,
} from '../application/regression-schema.js';
import type { ExportPlan, ExportReceipt } from '../domain/export.js';
import { FileRegressionArtifacts } from './file-regression-artifacts.js';

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const SAFE_SPEC = /^tests\/DEF-[A-F0-9]{8}\.spec\.ts$/;
const SAFE_EXPORT_ID = /^export-[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
}

async function readJson(path: string): Promise<unknown> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_MANIFEST_BYTES) {
      throw new Error('not a bounded regular file');
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ExportSourceError('manifest.json is not valid JSON.');
    throw new ExportSourceError(`Could not read regression manifest at "${path}".`);
  }
}

export class FileRegressionExportArtifacts
  implements RegressionExportSourceReader, RegressionExportArtifactWriter
{
  private readonly regressions = new FileRegressionArtifacts();

  public async loadExportSource(manifestPath: string): Promise<LoadedRegressionExportSource> {
    const manifestFile = resolve(manifestPath);
    const generationDirectory = dirname(manifestFile);
    const regressionsDirectory = dirname(generationDirectory);
    const runDirectory = dirname(regressionsDirectory);
    if (
      basename(manifestFile) !== 'manifest.json' ||
      basename(regressionsDirectory) !== 'regressions'
    ) {
      throw new ExportSourceError(
        'Export requires artifacts/<run-id>/regressions/<generation-id>/manifest.json.',
      );
    }
    let manifest;
    try {
      manifest = parseSavedRegressionManifest(await readJson(manifestFile));
    } catch (error) {
      if (error instanceof SavedRegressionManifestValidationError) {
        throw new ExportSourceError(error.message);
      }
      throw error;
    }
    if (basename(generationDirectory) !== manifest.generationId) {
      throw new ExportSourceError('Manifest generationId does not match its directory.');
    }
    const canonicalGeneration = await realpath(generationDirectory).catch(() => null);
    const canonicalRun = await realpath(runDirectory).catch(() => null);
    if (
      canonicalGeneration === null ||
      canonicalRun === null ||
      !contained(canonicalRun, canonicalGeneration)
    ) {
      throw new ExportTargetSafetyError('Regression generation path escapes its source run.');
    }
    const generatedFiles = new Map<string, string>();
    for (const entry of manifest.tests) {
      if (entry.file === null) continue;
      if (!SAFE_SPEC.test(entry.file)) {
        throw new ExportSourceError(`Unsafe generated spec path in manifest: ${entry.file}.`);
      }
      const path = join(canonicalGeneration, ...entry.file.split('/'));
      if (!contained(canonicalGeneration, path)) {
        throw new ExportTargetSafetyError(`Generated spec escapes the generation directory.`);
      }
      const canonicalFile = await realpath(path).catch(() => null);
      const details = await lstat(path).catch(() => null);
      if (
        canonicalFile === null ||
        canonicalFile !== path ||
        !contained(canonicalGeneration, canonicalFile) ||
        details === null ||
        details.isSymbolicLink() ||
        !details.isFile() ||
        details.size > MAX_SPEC_BYTES
      ) {
        throw new ExportSourceError(`Generated spec is missing or unsafe: ${entry.file}.`);
      }
      generatedFiles.set(entry.file, await readFile(path, 'utf8'));
    }
    const findingsPath = join(
      canonicalRun,
      'verifications',
      manifest.verificationId,
      'findings.json',
    );
    const regressionSource = await this.regressions.loadRegressionSource(findingsPath);
    return {
      manifest,
      manifestFile,
      generationDirectory: canonicalGeneration,
      runDirectory: canonicalRun,
      regressionSource,
      generatedFiles,
    };
  }

  public async savePlan(generationDirectory: string, plan: ExportPlan): Promise<string> {
    if (!SAFE_EXPORT_ID.test(plan.exportId)) {
      throw new ExportWriteError('Unsafe export identifier.');
    }
    const exportDirectory = join(generationDirectory, 'exports', plan.exportId);
    try {
      await mkdir(dirname(exportDirectory), { recursive: true });
      await mkdir(exportDirectory);
      await this.atomicWrite(
        join(exportDirectory, 'export-plan.json'),
        `${JSON.stringify(plan, null, 2)}\n`,
      );
      return exportDirectory;
    } catch (error) {
      if (error instanceof ExportWriteError) throw error;
      throw new ExportWriteError('Could not persist export-plan.json.', { cause: error });
    }
  }

  public async saveReceipt(exportDirectory: string, receipt: ExportReceipt): Promise<void> {
    try {
      await this.atomicWrite(
        join(exportDirectory, 'export-receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
    } catch (error) {
      throw new ExportWriteError('Could not persist export-receipt.json.', { cause: error });
    }
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
