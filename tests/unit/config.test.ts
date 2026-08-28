import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/application/errors.js';
import { loadConfig, loadPlanningConfig } from '../../src/infrastructure/config.js';

describe('loadConfig', () => {
  it('provides ready-to-run defaults', () => {
    expect(loadConfig({}, '/workspace')).toEqual({
      navigationTimeoutMs: 30_000,
      headless: true,
      viewport: { width: 1440, height: 900 },
      artifactsDirectory: resolve('/workspace', 'artifacts'),
      maxPages: 25,
      maxDepth: 3,
      maxQueryVariantsPerPath: 5,
      maxStates: 12,
      maxActionsPerState: 4,
      maxStateDepth: 2,
    });
  });

  it('loads environment values', () => {
    expect(
      loadConfig(
        {
          AGENTIC_QA_NAVIGATION_TIMEOUT_MS: '5000',
          AGENTIC_QA_HEADLESS: 'no',
          AGENTIC_QA_VIEWPORT_WIDTH: '1280',
          AGENTIC_QA_VIEWPORT_HEIGHT: '720',
          AGENTIC_QA_ARTIFACTS_DIR: 'output',
          AGENTIC_QA_MAX_PAGES: '20',
          AGENTIC_QA_MAX_DEPTH: '2',
          AGENTIC_QA_MAX_QUERY_VARIANTS_PER_PATH: '4',
          AGENTIC_QA_MAX_STATES: '30',
          AGENTIC_QA_MAX_ACTIONS_PER_STATE: '8',
          AGENTIC_QA_MAX_STATE_DEPTH: '3',
        },
        '/workspace',
      ),
    ).toEqual({
      navigationTimeoutMs: 5000,
      headless: false,
      viewport: { width: 1280, height: 720 },
      artifactsDirectory: resolve('/workspace', 'output'),
      maxPages: 20,
      maxDepth: 2,
      maxQueryVariantsPerPath: 4,
      maxStates: 30,
      maxActionsPerState: 8,
      maxStateDepth: 3,
    });
  });

  it('gives command options precedence', () => {
    const config = loadConfig(
      { AGENTIC_QA_NAVIGATION_TIMEOUT_MS: '5000', AGENTIC_QA_HEADLESS: 'true' },
      '/workspace',
      {
        timeout: '9000',
        headed: true,
        artifactsDirectory: '/tmp/runs',
        maxPages: '12',
        maxDepth: '0',
        maxQueryVariantsPerPath: '3',
        maxStates: '20',
        maxActionsPerState: '6',
        maxStateDepth: '1',
      },
    );
    expect(config.navigationTimeoutMs).toBe(9000);
    expect(config.headless).toBe(false);
    expect(config.artifactsDirectory).toBe('/tmp/runs');
    expect(config.maxPages).toBe(12);
    expect(config.maxDepth).toBe(0);
    expect(config.maxQueryVariantsPerPath).toBe(3);
    expect(config.maxStates).toBe(20);
    expect(config.maxActionsPerState).toBe(6);
    expect(config.maxStateDepth).toBe(1);
  });

  it.each([
    ['AGENTIC_QA_NAVIGATION_TIMEOUT_MS', '0'],
    ['AGENTIC_QA_VIEWPORT_WIDTH', '-1'],
    ['AGENTIC_QA_VIEWPORT_HEIGHT', 'wide'],
    ['AGENTIC_QA_HEADLESS', 'sometimes'],
    ['AGENTIC_QA_MAX_PAGES', '0'],
    ['AGENTIC_QA_MAX_DEPTH', '-1'],
    ['AGENTIC_QA_MAX_QUERY_VARIANTS_PER_PATH', '101'],
    ['AGENTIC_QA_MAX_STATES', '101'],
    ['AGENTIC_QA_MAX_ACTIONS_PER_STATE', '26'],
    ['AGENTIC_QA_MAX_STATE_DEPTH', '6'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => loadConfig({ [key]: value }, '/workspace')).toThrow(ConfigurationError);
  });
});

describe('loadPlanningConfig', () => {
  it('uses CLI model and timeout ahead of environment values', () => {
    expect(
      loadPlanningConfig(
        {
          AGENTIC_QA_LLM_BASE_URL: 'http://127.0.0.1:1234/v1',
          AGENTIC_QA_LLM_API_KEY: 'test-secret',
          AGENTIC_QA_LLM_MODEL: 'environment-model',
          AGENTIC_QA_LLM_TIMEOUT_MS: '5000',
        },
        { model: 'cli-model', timeout: '7000' },
      ),
    ).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'test-secret',
      model: 'cli-model',
      timeoutMs: 7000,
    });
  });

  it('supports unauthenticated local OpenAI-compatible endpoints', () => {
    expect(
      loadPlanningConfig({
        AGENTIC_QA_LLM_BASE_URL: 'http://127.0.0.1:1234/v1',
        AGENTIC_QA_LLM_MODEL: 'local-model',
      }).apiKey,
    ).toBeNull();
  });

  it.each([
    [{ AGENTIC_QA_LLM_MODEL: 'model' }, {}, /BASE_URL is required/],
    [{ AGENTIC_QA_LLM_BASE_URL: 'not-a-url', AGENTIC_QA_LLM_MODEL: 'model' }, {}, /HTTP\(S\)/],
    [
      {
        AGENTIC_QA_LLM_BASE_URL: 'https://user:password@example.test/v1',
        AGENTIC_QA_LLM_MODEL: 'model',
      },
      {},
      /without embedded credentials/,
    ],
    [{ AGENTIC_QA_LLM_BASE_URL: 'http://localhost:1234/v1' }, {}, /model is required/i],
    [
      { AGENTIC_QA_LLM_BASE_URL: 'http://localhost:1234/v1', AGENTIC_QA_LLM_MODEL: 'model' },
      { provider: 'anthropic' },
      /Unsupported reasoning provider/,
    ],
    [
      {
        AGENTIC_QA_LLM_BASE_URL: 'http://localhost:1234/v1',
        AGENTIC_QA_LLM_MODEL: 'model',
        AGENTIC_QA_LLM_TIMEOUT_MS: '99',
      },
      {},
      /LLM timeout/,
    ],
  ] as const)('rejects invalid planning configuration', (environment, overrides, message) => {
    expect(() => loadPlanningConfig(environment, overrides)).toThrow(message);
  });
});
