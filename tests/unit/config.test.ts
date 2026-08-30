import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/application/errors.js';
import {
  loadConfig,
  loadExecutionConfig,
  loadExportConfig,
  loadPlanningConfig,
  loadRegressionConfig,
  loadVerificationConfig,
} from '../../src/infrastructure/config.js';

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
    expect(config.artifactsDirectory).toBe(resolve('/tmp/runs'));
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

describe('loadExportConfig', () => {
  it('uses a bounded validation timeout with CLI precedence', () => {
    expect(loadExportConfig({})).toEqual({ validationTimeoutMs: 30_000 });
    expect(
      loadExportConfig(
        { AGENTIC_QA_EXPORT_VALIDATION_TIMEOUT_MS: '20000' },
        { validationTimeout: '15000' },
      ),
    ).toEqual({ validationTimeoutMs: 15_000 });
  });

  it.each(['999', '300001', 'not-a-number'])('rejects invalid export timeout %s', (value) => {
    expect(() => loadExportConfig({ AGENTIC_QA_EXPORT_VALIDATION_TIMEOUT_MS: value })).toThrow(
      ConfigurationError,
    );
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

describe('loadExecutionConfig', () => {
  it('provides conservative bounded defaults without LLM configuration', () => {
    expect(loadExecutionConfig({})).toEqual({
      navigationTimeoutMs: 30_000,
      headless: true,
      viewport: { width: 1440, height: 900 },
      maxScenarios: 20,
      maxStepsPerScenario: 10,
      executionTimeoutMs: 300_000,
      stepTimeoutMs: 5_000,
    });
  });

  it('applies CLI precedence and environment hard limits', () => {
    expect(
      loadExecutionConfig(
        {
          AGENTIC_QA_MAX_EXECUTION_SCENARIOS: '10',
          AGENTIC_QA_MAX_STEPS_PER_SCENARIO: '8',
          AGENTIC_QA_EXECUTION_TIMEOUT_MS: '90000',
          AGENTIC_QA_STEP_TIMEOUT_MS: '4000',
        },
        { maxScenarios: '6', stepTimeout: '2500', executionTimeout: '60000' },
      ),
    ).toMatchObject({
      maxScenarios: 6,
      maxStepsPerScenario: 8,
      executionTimeoutMs: 60_000,
      stepTimeoutMs: 2_500,
    });
  });

  it.each([
    ['AGENTIC_QA_MAX_EXECUTION_SCENARIOS', '0'],
    ['AGENTIC_QA_MAX_STEPS_PER_SCENARIO', '21'],
    ['AGENTIC_QA_EXECUTION_TIMEOUT_MS', '999'],
    ['AGENTIC_QA_STEP_TIMEOUT_MS', '249'],
  ])('rejects invalid execution setting %s', (key, value) => {
    expect(() => loadExecutionConfig({ [key]: value })).toThrow(ConfigurationError);
  });
});

describe('loadVerificationConfig', () => {
  it('uses bounded defaults and CLI precedence without any LLM configuration', () => {
    expect(loadVerificationConfig({})).toMatchObject({
      attempts: 3,
      maxFindings: 10,
      verifyTimeoutMs: 900_000,
      headless: true,
    });
    expect(
      loadVerificationConfig(
        {
          AGENTIC_QA_VERIFY_ATTEMPTS: '4',
          AGENTIC_QA_MAX_VERIFY_FINDINGS: '8',
          AGENTIC_QA_VERIFY_TIMEOUT_MS: '600000',
        },
        { attempts: '5', maxFindings: '6' },
      ),
    ).toMatchObject({ attempts: 5, maxFindings: 6, verifyTimeoutMs: 600_000 });
  });

  it.each([
    ['AGENTIC_QA_VERIFY_ATTEMPTS', '1'],
    ['AGENTIC_QA_VERIFY_ATTEMPTS', '11'],
    ['AGENTIC_QA_MAX_VERIFY_FINDINGS', '0'],
    ['AGENTIC_QA_MAX_VERIFY_FINDINGS', '51'],
    ['AGENTIC_QA_VERIFY_TIMEOUT_MS', '999'],
  ])('rejects invalid verification setting %s', (key, value) => {
    expect(() => loadVerificationConfig({ [key]: value })).toThrow(ConfigurationError);
  });
});

describe('loadRegressionConfig', () => {
  it('uses conservative hard defaults and CLI precedence', () => {
    expect(loadRegressionConfig({})).toEqual({
      maxGeneratedTests: 20,
      maxStepsPerTest: 12,
      maxAssertionsPerTest: 5,
    });
    expect(
      loadRegressionConfig({ AGENTIC_QA_MAX_GENERATED_TESTS: '7' }, { maxTests: '4' }),
    ).toMatchObject({ maxGeneratedTests: 4 });
  });

  it.each([
    ['AGENTIC_QA_MAX_GENERATED_TESTS', '0'],
    ['AGENTIC_QA_MAX_GENERATED_TESTS', '101'],
    ['AGENTIC_QA_MAX_GENERATED_STEPS_PER_TEST', '26'],
    ['AGENTIC_QA_MAX_GENERATED_ASSERTIONS_PER_TEST', '11'],
  ])('rejects invalid generation setting %s', (key, value) => {
    expect(() => loadRegressionConfig({ [key]: value })).toThrow(ConfigurationError);
  });
});
