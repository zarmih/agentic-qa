import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/application/errors.js';
import { loadConfig } from '../../src/infrastructure/config.js';

describe('loadConfig', () => {
  it('provides ready-to-run defaults', () => {
    expect(loadConfig({}, '/workspace')).toEqual({
      navigationTimeoutMs: 30_000,
      headless: true,
      viewport: { width: 1440, height: 900 },
      artifactsDirectory: resolve('/workspace', 'artifacts'),
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
        },
        '/workspace',
      ),
    ).toEqual({
      navigationTimeoutMs: 5000,
      headless: false,
      viewport: { width: 1280, height: 720 },
      artifactsDirectory: resolve('/workspace', 'output'),
    });
  });

  it('gives command options precedence', () => {
    const config = loadConfig(
      { AGENTIC_QA_NAVIGATION_TIMEOUT_MS: '5000', AGENTIC_QA_HEADLESS: 'true' },
      '/workspace',
      { timeout: '9000', headed: true, artifactsDirectory: '/tmp/runs' },
    );
    expect(config.navigationTimeoutMs).toBe(9000);
    expect(config.headless).toBe(false);
    expect(config.artifactsDirectory).toBe('/tmp/runs');
  });

  it.each([
    ['AGENTIC_QA_NAVIGATION_TIMEOUT_MS', '0'],
    ['AGENTIC_QA_VIEWPORT_WIDTH', '-1'],
    ['AGENTIC_QA_VIEWPORT_HEIGHT', 'wide'],
    ['AGENTIC_QA_HEADLESS', 'sometimes'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => loadConfig({ [key]: value }, '/workspace')).toThrow(ConfigurationError);
  });
});
