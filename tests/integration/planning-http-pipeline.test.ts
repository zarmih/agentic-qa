import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanSchemaInvalidError } from '../../src/application/errors.js';
import { PlanQa } from '../../src/application/plan-qa.js';
import { FilePlanningArtifacts } from '../../src/infrastructure/file-planning-artifacts.js';
import { OpenAICompatibleReasoningProvider } from '../../src/infrastructure/openai-compatible-reasoning-provider.js';
import { SystemClock } from '../../src/infrastructure/run-id.js';
import { startFakeLlmServer, type FakeLlmServer } from '../fixtures/fake-llm-server.js';
import { planningExplorationFixture, validPlanProposal } from '../fixtures/planning-fixtures.js';

let temporaryDirectory: string | null = null;
let server: FakeLlmServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  if (temporaryDirectory !== null) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

async function sourceFile(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-planning-http-'));
  const path = join(temporaryDirectory, 'exploration.json');
  await writeFile(path, `${JSON.stringify(planningExplorationFixture())}\n`, 'utf8');
  return path;
}

function useCase(fakeServer: FakeLlmServer): PlanQa {
  const artifacts = new FilePlanningArtifacts();
  return new PlanQa(
    new OpenAICompatibleReasoningProvider({
      baseUrl: fakeServer.baseUrl,
      apiKey: null,
      model: 'fixture-model',
      timeoutMs: 2_000,
    }),
    artifacts,
    artifacts,
    new SystemClock(),
  );
}

describe('planning pipeline over OpenAI-compatible HTTP', () => {
  it.each([
    ['invalid JSON', 'not-json'],
    ['invalid schema', JSON.stringify({ schemaVersion: '1.0', scenarios: [] })],
  ])('repairs one %s response and accepts a valid second response', async (_case, invalid) => {
    server = await startFakeLlmServer((request) => ({
      content: request.index === 0 ? invalid : JSON.stringify(validPlanProposal()),
    }));
    const outcome = await useCase(server).execute(await sourceFile(), {
      provider: 'openai-compatible',
      model: 'fixture-model',
    });

    expect(outcome.plan.metadata.repairAttempts).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.rawBody).toContain('TRUSTED_REPAIR_REQUEST');
  });

  it('stops after one repair when both model responses are invalid', async () => {
    server = await startFakeLlmServer(() => ({ content: '{}' }));
    await expect(
      useCase(server).execute(await sourceFile(), {
        provider: 'openai-compatible',
        model: 'fixture-model',
      }),
    ).rejects.toBeInstanceOf(PlanSchemaInvalidError);
    expect(server.requests).toHaveLength(2);
  });
});
