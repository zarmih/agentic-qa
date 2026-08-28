import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileExecutionArtifacts } from '../../src/infrastructure/file-execution-artifacts.js';
import { executionPlanFixture } from '../fixtures/execution-fixtures.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function persistedFixture(): Promise<{
  readonly root: string;
  readonly runDirectory: string;
  readonly planFile: string;
  readonly explorationFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'agentic-qa-execution-files-'));
  temporaryDirectories.push(root);
  const fixture = executionPlanFixture();
  const runDirectory = join(root, fixture.loaded.exploration.runId);
  const planningDirectory = join(runDirectory, 'planning');
  await mkdir(planningDirectory, { recursive: true });
  const planFile = join(planningDirectory, 'qa-plan.json');
  const explorationFile = join(runDirectory, 'exploration.json');
  await Promise.all([
    writeFile(planFile, JSON.stringify(fixture.plan)),
    writeFile(explorationFile, JSON.stringify(fixture.loaded.exploration)),
    writeFile(
      join(planningDirectory, 'observation.json'),
      JSON.stringify(fixture.loaded.observation),
    ),
    writeFile(join(runDirectory, 'graph.json'), JSON.stringify(fixture.loaded.standaloneGraph)),
    writeFile(
      join(runDirectory, 'state-graph.json'),
      JSON.stringify(fixture.loaded.standaloneStateGraph),
    ),
  ]);
  return { root, runDirectory, planFile, explorationFile };
}

describe('FileExecutionArtifacts', () => {
  it('infers the standard exploration source and loads all bound artifacts', async () => {
    const fixture = await persistedFixture();
    const loaded = await new FileExecutionArtifacts().loadExecutionInput(fixture.planFile);
    expect(loaded.plan.schemaVersion).toBe('1.1');
    expect(loaded.explorationFile).toBe(fixture.explorationFile);
    expect(loaded.observation.source.runId).toBe(loaded.exploration.runId);
    expect(loaded.standaloneStateGraph.nodes.length).toBeGreaterThan(0);
  });

  it('requires an explicit exploration override for a non-standard plan filename', async () => {
    const fixture = await persistedFixture();
    const portablePlan = join(fixture.runDirectory, 'planning', 'portable-plan.json');
    await writeFile(portablePlan, await readFile(fixture.planFile));
    await expect(new FileExecutionArtifacts().loadExecutionInput(portablePlan)).rejects.toThrow(
      /Use --exploration/,
    );
    await expect(
      new FileExecutionArtifacts().loadExecutionInput(portablePlan, fixture.explorationFile),
    ).resolves.toMatchObject({ explorationFile: fixture.explorationFile });
  });

  it('creates independent execution directories and filesystem-safe screenshot paths', async () => {
    const fixture = await persistedFixture();
    const artifacts = new FileExecutionArtifacts();
    const first = await artifacts.prepareExecution(fixture.runDirectory, 'exec-one');
    const second = await artifacts.prepareExecution(fixture.runDirectory, 'exec-two');
    expect(first.directory).not.toBe(second.directory);
    const reference = await artifacts.saveExecutionScreenshot(
      fixture.runDirectory,
      'exec-one',
      'scenario-001',
      '001-fail.png',
      Buffer.from('png'),
    );
    expect(reference).toBe(join('screenshots', 'scenario-001', '001-fail.png'));
    await expect(
      artifacts.saveExecutionScreenshot(
        fixture.runDirectory,
        'exec-one',
        '../escape',
        '001.png',
        Buffer.from('png'),
      ),
    ).rejects.toThrow(/artifacts directory/);
  });
});
