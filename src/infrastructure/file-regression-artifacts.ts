import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ArtifactWriteError, RegressionSourceError } from '../application/errors.js';
import type {
  LoadedRegressionSource,
  RegressionArtifactLocations,
  RegressionArtifactReader,
  RegressionArtifactWriter,
  RenderedRegressionTest,
} from '../application/regression-ports.js';
import {
  parseSavedFindings,
  parseSavedVerification,
  SavedVerificationValidationError,
} from '../application/verification-schema.js';
import type { RegressionManifest } from '../domain/regression.js';
import { FileVerificationArtifacts } from './file-verification-artifacts.js';

const MAX_JSON_BYTES = 50 * 1024 * 1024;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
const SAFE_SPEC = /^DEF-[A-F0-9]{8}\.spec\.ts$/;

async function json(path: string, label: string): Promise<unknown> {
  let contents: string;
  try {
    const fileStats = await stat(path);
    if (!fileStats.isFile() || fileStats.size > MAX_JSON_BYTES) {
      throw new Error(`${label} is not a bounded regular file`);
    }
    contents = await readFile(path, 'utf8');
  } catch {
    throw new RegressionSourceError(`Could not read ${label} at "${path}".`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new RegressionSourceError(`${label} is not valid JSON.`);
  }
}

function standardLayout(findingsFile: string): {
  readonly verificationDirectory: string;
  readonly runDirectory: string;
} {
  const verificationDirectory = dirname(findingsFile);
  const verificationsDirectory = dirname(verificationDirectory);
  if (
    basename(findingsFile) !== 'findings.json' ||
    basename(verificationsDirectory) !== 'verifications'
  ) {
    throw new RegressionSourceError(
      'Generation requires the standard artifacts/<run-id>/verifications/<verification-id>/findings.json layout.',
    );
  }
  return { verificationDirectory, runDirectory: dirname(verificationsDirectory) };
}

export class FileRegressionArtifacts implements RegressionArtifactReader, RegressionArtifactWriter {
  private readonly verificationArtifacts = new FileVerificationArtifacts();

  public async loadRegressionSource(findingsPath: string): Promise<LoadedRegressionSource> {
    const findingsFile = resolve(findingsPath);
    const layout = standardLayout(findingsFile);
    const verificationFile = join(layout.verificationDirectory, 'verification.json');
    try {
      const findings = parseSavedFindings(await json(findingsFile, 'findings.json'));
      const verification = parseSavedVerification(
        await json(verificationFile, 'verification.json'),
      );
      if (
        basename(layout.verificationDirectory) !== findings.verificationId ||
        findings.verificationId !== verification.verificationId
      ) {
        throw new RegressionSourceError(
          'The verification directory and findings identifiers do not match.',
        );
      }
      const sourceExecutionFile = join(
        layout.runDirectory,
        'executions',
        verification.sourceExecutionId,
        'execution.json',
      );
      const verificationSource =
        await this.verificationArtifacts.loadVerificationSource(sourceExecutionFile);
      return {
        findings,
        verification,
        findingsFile,
        verificationFile,
        verificationDirectory: layout.verificationDirectory,
        runDirectory: layout.runDirectory,
        verificationSource,
      };
    } catch (error) {
      if (error instanceof RegressionSourceError) throw error;
      if (error instanceof SavedVerificationValidationError) {
        throw new RegressionSourceError(error.message);
      }
      throw error;
    }
  }

  public async prepareGeneration(
    runDirectory: string,
    generationId: string,
  ): Promise<RegressionArtifactLocations> {
    if (!SAFE_IDENTIFIER.test(generationId)) {
      throw new ArtifactWriteError(runDirectory, new Error('Unsafe generation identifier'));
    }
    const directory = join(runDirectory, 'regressions', generationId);
    const testsDirectory = join(directory, 'tests');
    try {
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory);
      await mkdir(testsDirectory);
      return { directory, testsDirectory };
    } catch (error) {
      throw new ArtifactWriteError(directory, error);
    }
  }

  public async saveGeneration(
    locations: RegressionArtifactLocations,
    manifest: RegressionManifest,
    readme: string,
    tests: readonly RenderedRegressionTest[],
  ): Promise<void> {
    try {
      for (const test of tests) {
        if (!SAFE_SPEC.test(test.fileName)) {
          throw new Error(`Unsafe generated test filename: ${test.fileName}`);
        }
      }
      await Promise.all([
        this.atomicWrite(
          join(locations.directory, 'manifest.json'),
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
        this.atomicWrite(join(locations.directory, 'README.md'), readme),
        ...tests.map((test) =>
          this.atomicWrite(join(locations.testsDirectory, test.fileName), test.source),
        ),
      ]);
    } catch (error) {
      throw new ArtifactWriteError(locations.directory, error);
    }
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, contents, 'utf8');
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
