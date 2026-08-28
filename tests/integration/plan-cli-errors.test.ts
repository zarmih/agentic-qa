import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLlmServer, type FakeLlmServer } from '../fixtures/fake-llm-server.js';
import { planningExplorationFixture } from '../fixtures/planning-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
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
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-plan-cli-error-'));
  const path = join(temporaryDirectory, 'exploration.json');
  await writeFile(path, JSON.stringify(planningExplorationFixture()), 'utf8');
  return path;
}

describe('agentic-qa plan errors', () => {
  it('reports configuration errors without starting a provider request', async () => {
    const execution = await runCli(projectRoot, ['plan', await sourceFile()], {
      AGENTIC_QA_LLM_BASE_URL: '',
      AGENTIC_QA_LLM_MODEL: '',
      AGENTIC_QA_LLM_API_KEY: '',
    });
    expect(execution.code).toBe(1);
    expect(execution.stderr).toContain('AGENTIC_QA_LLM_BASE_URL is required');
    expect(execution.stderr).not.toContain('at ');
  });

  it('does not expose the API key even in debug output for provider failures', async () => {
    const secret = 'cli-error-test-secret';
    server = await startFakeLlmServer(() => ({ status: 401 }));
    const execution = await runCli(
      projectRoot,
      ['plan', await sourceFile(), '--model', 'fixture-model'],
      {
        AGENTIC_QA_LLM_BASE_URL: server.baseUrl,
        AGENTIC_QA_LLM_API_KEY: secret,
        AGENTIC_QA_DEBUG: 'true',
      },
    );
    expect(execution.code).toBe(1);
    expect(execution.stderr).toContain('rejected authentication');
    expect(execution.stderr).not.toContain(secret);
    expect(server.requests[0]?.authorization).toBe(`Bearer ${secret}`);
  });
});
