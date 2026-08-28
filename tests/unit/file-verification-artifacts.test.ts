import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileVerificationArtifacts } from '../../src/infrastructure/file-verification-artifacts.js';
import { verificationExecutionFixture } from '../fixtures/verification-fixtures.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function persistedExecution(): Promise<{
  readonly runDirectory: string;
  readonly executionFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'agentic-qa-verification-files-'));
  temporaryDirectories.push(root);
  const loaded = verificationExecutionFixture();
  const runDirectory = join(root, loaded.execution.sourceRunId);
  const planningDirectory = join(runDirectory, 'planning');
  const executionDirectory = join(runDirectory, 'executions', loaded.execution.executionId);
  await Promise.all([
    mkdir(planningDirectory, { recursive: true }),
    mkdir(executionDirectory, { recursive: true }),
  ]);
  const executionFile = join(executionDirectory, 'execution.json');
  await Promise.all([
    writeFile(executionFile, JSON.stringify(loaded.execution)),
    writeFile(join(planningDirectory, 'qa-plan.json'), JSON.stringify(loaded.executionInput.plan)),
    writeFile(
      join(planningDirectory, 'observation.json'),
      JSON.stringify(loaded.executionInput.observation),
    ),
    writeFile(
      join(runDirectory, 'exploration.json'),
      JSON.stringify(loaded.executionInput.exploration),
    ),
    writeFile(
      join(runDirectory, 'graph.json'),
      JSON.stringify(loaded.executionInput.standaloneGraph),
    ),
    writeFile(
      join(runDirectory, 'state-graph.json'),
      JSON.stringify(loaded.executionInput.standaloneStateGraph),
    ),
  ]);
  return { runDirectory, executionFile };
}

describe('FileVerificationArtifacts', () => {
  it('loads only the standard source-linked execution layout', async () => {
    const persisted = await persistedExecution();
    const artifacts = new FileVerificationArtifacts();
    await expect(artifacts.loadVerificationSource(persisted.executionFile)).resolves.toMatchObject({
      runDirectory: persisted.runDirectory,
      sourceExecutionRelativePath: '../../executions/exec-verification-fixture',
    });
    const copied = join(persisted.runDirectory, 'execution-copy.json');
    await writeFile(copied, await readFile(persisted.executionFile));
    await expect(artifacts.loadVerificationSource(copied)).rejects.toThrow(/standard artifacts/);
  });

  it('creates isolated attempt layouts and deterministic reports', async () => {
    const persisted = await persistedExecution();
    const artifacts = new FileVerificationArtifacts();
    const verification = await artifacts.prepareVerification(
      persisted.runDirectory,
      'verify-fixture',
    );
    const target = artifacts.attemptTarget(verification.directory, 'candidate-fixture', 1);
    const locations = await target.writer.prepareExecution(persisted.runDirectory, 'exec-attempt');
    expect(locations.directory).toBe(
      join(verification.directory, 'attempts', 'candidate-fixture', 'attempt-001'),
    );
    expect(target.relativeDirectory).toBe(join('attempts', 'candidate-fixture', 'attempt-001'));
    await expect(
      artifacts.prepareVerification(persisted.runDirectory, 'verify-fixture'),
    ).rejects.toThrow(/artifacts directory/);
  });
});
