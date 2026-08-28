import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderAuthenticationError,
  ProviderBadResponseError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../../src/application/errors.js';
import { PlanningObservationCompiler } from '../../src/application/planning-observation-compiler.js';
import { PlanningPromptBuilder } from '../../src/application/planning-prompt-builder.js';
import { OpenAICompatibleReasoningProvider } from '../../src/infrastructure/openai-compatible-reasoning-provider.js';
import { startFakeLlmServer, type FakeLlmServer } from '../fixtures/fake-llm-server.js';
import { planningExplorationFixture, validPlanProposal } from '../fixtures/planning-fixtures.js';

let server: FakeLlmServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function request() {
  return {
    prompt: new PlanningPromptBuilder().build(),
    observation: new PlanningObservationCompiler().compile(planningExplorationFixture())
      .observation,
    repair: null,
  } as const;
}

function provider(options?: { apiKey?: string | null; timeoutMs?: number }) {
  if (server === null) throw new Error('Fake provider server is required.');
  return new OpenAICompatibleReasoningProvider({
    baseUrl: server.baseUrl,
    apiKey: options?.apiKey ?? null,
    model: 'fixture-model',
    timeoutMs: options?.timeoutMs ?? 2_000,
  });
}

describe('OpenAICompatibleReasoningProvider', () => {
  it('uses the chat-completions protocol and reads optional usage metadata', async () => {
    server = await startFakeLlmServer(() => ({
      content: JSON.stringify(validPlanProposal()),
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    }));
    const result = await provider({ apiKey: 'local-test-key' }).generatePlan(request());

    expect(JSON.parse(result.content)).toMatchObject({ schemaVersion: '1.0' });
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 20, totalTokens: 50 });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      path: '/v1/chat/completions',
      authorization: 'Bearer local-test-key',
    });
    expect(server.requests[0]?.rawBody).not.toContain('local-test-key');
    expect(server.requests[0]?.rawBody).toContain('UNTRUSTED_APPLICATION_DATA');
  });

  it('omits Authorization for explicitly unauthenticated local endpoints', async () => {
    server = await startFakeLlmServer(() => ({ content: JSON.stringify(validPlanProposal()) }));
    const result = await provider().generatePlan(request());
    expect(result.usage).toBeNull();
    expect(server.requests[0]?.authorization).toBeNull();
  });

  it.each([
    [401, ProviderAuthenticationError],
    [403, ProviderAuthenticationError],
    [429, ProviderRateLimitError],
    [500, ProviderBadResponseError],
  ] as const)('maps HTTP %s to a stable provider error', async (status, ErrorClass) => {
    server = await startFakeLlmServer(() => ({ status }));
    await expect(provider().generatePlan(request())).rejects.toBeInstanceOf(ErrorClass);
  });

  it('rejects malformed HTTP JSON and unexpected completion content', async () => {
    server = await startFakeLlmServer(() => ({ rawHttpBody: '{broken' }));
    await expect(provider().generatePlan(request())).rejects.toBeInstanceOf(
      ProviderBadResponseError,
    );
    await server.close();
    server = await startFakeLlmServer(() => ({
      rawHttpBody: JSON.stringify({ choices: [{ message: { content: 42 } }] }),
    }));
    await expect(provider().generatePlan(request())).rejects.toBeInstanceOf(
      ProviderBadResponseError,
    );
  });

  it('times out with a bounded, provider-specific failure', async () => {
    server = await startFakeLlmServer(() => ({
      content: JSON.stringify(validPlanProposal()),
      delayMs: 250,
    }));
    await expect(provider({ timeoutMs: 100 }).generatePlan(request())).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );
  });

  it('redacts an exact configured secret echoed by the model', async () => {
    server = await startFakeLlmServer(() => ({ content: 'echo local-test-key' }));
    const result = await provider({ apiKey: 'local-test-key' }).generatePlan(request());
    expect(result.content).toBe('echo [REDACTED]');
  });
});
