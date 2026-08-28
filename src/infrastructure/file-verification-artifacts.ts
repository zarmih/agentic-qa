import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ArtifactWriteError, VerificationSourceError } from '../application/errors.js';
import {
  parseSavedExecution,
  SavedExecutionValidationError,
} from '../application/execution-schema.js';
import type {
  LoadedVerificationSource,
  VerificationArtifactLocations,
  VerificationArtifactReader,
  VerificationArtifactWriter,
  VerificationAttemptArtifactTarget,
} from '../application/verification-ports.js';
import type { FindingsArtifact, VerificationRun } from '../domain/verification.js';
import { FileExecutionArtifacts } from './file-execution-artifacts.js';

const MAX_EXECUTION_BYTES = 50 * 1024 * 1024;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;

async function loadJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    const fileStats = await stat(path);
    if (!fileStats.isFile()) throw new Error('Path is not a file');
    if (fileStats.size > MAX_EXECUTION_BYTES) {
      throw new VerificationSourceError('execution.json exceeds its 50 MiB safety limit.');
    }
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof VerificationSourceError) throw error;
    throw new VerificationSourceError(`Could not read execution artifact "${path}".`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new VerificationSourceError('The execution artifact is not valid JSON.');
  }
}

function standardLayout(executionFile: string): {
  readonly runDirectory: string;
  readonly executionDirectory: string;
} {
  const executionDirectory = dirname(executionFile);
  const executionsDirectory = dirname(executionDirectory);
  if (
    basename(executionFile) !== 'execution.json' ||
    basename(executionsDirectory) !== 'executions'
  ) {
    throw new VerificationSourceError(
      'Verification requires the standard artifacts/<run-id>/executions/<execution-id>/execution.json layout.',
    );
  }
  return { executionDirectory, runDirectory: dirname(executionsDirectory) };
}

function assertIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new ArtifactWriteError(label, new Error(`Unsafe ${label} identifier`));
  }
}

export class FileVerificationArtifacts
  implements VerificationArtifactReader, VerificationArtifactWriter
{
  private readonly executions = new FileExecutionArtifacts();

  public async loadVerificationSource(executionPath: string): Promise<LoadedVerificationSource> {
    const executionFile = resolve(executionPath);
    const layout = standardLayout(executionFile);
    const raw = await loadJson(executionFile);
    let execution;
    try {
      execution = parseSavedExecution(raw);
    } catch (error) {
      if (error instanceof SavedExecutionValidationError) {
        throw new VerificationSourceError(error.message);
      }
      throw error;
    }
    if (basename(layout.executionDirectory) !== execution.executionId) {
      throw new VerificationSourceError(
        'The execution directory name does not match executionId in execution.json.',
      );
    }
    const planFile = join(layout.runDirectory, 'planning', 'qa-plan.json');
    const explorationFile = join(layout.runDirectory, 'exploration.json');
    const executionInput = await this.executions.loadExecutionInput(planFile, explorationFile);
    return {
      execution,
      executionFile,
      executionDirectory: layout.executionDirectory,
      sourceExecutionRelativePath: join('..', '..', 'executions', execution.executionId),
      runDirectory: layout.runDirectory,
      planFile,
      explorationFile,
      executionInput,
    };
  }

  public async prepareVerification(
    runDirectory: string,
    verificationId: string,
  ): Promise<VerificationArtifactLocations> {
    assertIdentifier(verificationId, 'verification');
    const directory = join(runDirectory, 'verifications', verificationId);
    try {
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory);
      await mkdir(join(directory, 'attempts'));
      return { directory };
    } catch (error) {
      throw new ArtifactWriteError(directory, error);
    }
  }

  public attemptTarget(
    verificationDirectory: string,
    candidateId: string,
    attemptNumber: number,
  ): VerificationAttemptArtifactTarget {
    assertIdentifier(candidateId, 'candidate');
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 10) {
      throw new ArtifactWriteError(verificationDirectory, new Error('Unsafe attempt number'));
    }
    const relativeDirectory = join(
      'attempts',
      candidateId,
      `attempt-${String(attemptNumber).padStart(3, '0')}`,
    );
    const absoluteDirectory = join(verificationDirectory, relativeDirectory);
    const writer = new FileExecutionArtifacts({
      executionDirectory: () => absoluteDirectory,
    });
    return { writer, relativeDirectory };
  }

  public async saveVerification(
    directory: string,
    result: VerificationRun,
    findings: FindingsArtifact,
    markdown: string,
  ): Promise<void> {
    try {
      await Promise.all([
        this.atomicWrite(join(directory, 'verification.json'), this.json(result)),
        this.atomicWrite(join(directory, 'findings.json'), this.json(findings)),
        this.atomicWrite(join(directory, 'verification.md'), markdown),
      ]);
    } catch (error) {
      throw new ArtifactWriteError(directory, error);
    }
  }

  private json(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
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
