import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanningSourceError } from '../../src/application/errors.js';
import { PlanQa } from '../../src/application/plan-qa.js';
import type { Clock } from '../../src/application/ports.js';
import { FilePlanningArtifacts } from '../../src/infrastructure/file-planning-artifacts.js';
import { FakeReasoningProvider } from '../fixtures/fake-reasoning-provider.js';
import { planningExplorationFixture, validPlanProposal } from '../fixtures/planning-fixtures.js';

let temporaryDirectory: string | null = null;

afterEach(async () => {
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

async function temporaryFile(contents: string): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-planning-artifacts-'));
  const path = join(temporaryDirectory, 'exploration.json');
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('FilePlanningArtifacts', () => {
  it('loads a compatible Stage 3 artifact and rejects malformed or incompatible input', async () => {
    const artifacts = new FilePlanningArtifacts();
    const validPath = await temporaryFile(JSON.stringify(planningExplorationFixture()));
    await expect(artifacts.loadExploration(validPath)).resolves.toMatchObject({
      exploration: { schemaVersion: '3.0', runId: 'run-planning-fixture' },
      runDirectory: temporaryDirectory,
    });
    await writeFile(validPath, '{broken', 'utf8');
    await expect(artifacts.loadExploration(validPath)).rejects.toBeInstanceOf(PlanningSourceError);
    await writeFile(validPath, JSON.stringify({ schemaVersion: '2.0' }), 'utf8');
    await expect(artifacts.loadExploration(validPath)).rejects.toBeInstanceOf(PlanningSourceError);
  });

  it('defensively redacts the configured secret from every planning artifact', async () => {
    const secret = 'artifact-test-secret';
    const exploration = planningExplorationFixture();
    const source = {
      ...exploration,
      graph: {
        ...exploration.graph,
        nodes: exploration.graph.nodes.map((page, index) =>
          index === 0 ? { ...page, title: `Untrusted ${secret}` } : page,
        ),
      },
    };
    const path = await temporaryFile(JSON.stringify(source));
    const proposal = { ...validPlanProposal(), summary: `Provider echoed ${secret}` };
    const provider = new FakeReasoningProvider([
      {
        content: JSON.stringify(proposal),
        durationMs: 1,
        usage: null,
      },
    ]);
    const artifacts = new FilePlanningArtifacts([secret]);
    const clock: Clock = { now: () => new Date('2026-08-28T00:00:00.000Z') };
    await new PlanQa(provider, artifacts, artifacts, clock).execute(path, {
      provider: 'openai-compatible',
      model: 'fixture-model',
    });

    const planningDirectory = join(temporaryDirectory ?? '', 'planning');
    const contents = await Promise.all(
      ['observation.json', 'qa-plan.json', 'qa-plan.md'].map((file) =>
        readFile(join(planningDirectory, file), 'utf8'),
      ),
    );
    expect(contents.every((value) => !value.includes(secret))).toBe(true);
    expect(contents.every((value) => value.includes('[REDACTED]'))).toBe(true);
  });
});
