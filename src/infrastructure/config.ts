import { resolve } from 'node:path';
import { ConfigurationError } from '../application/errors.js';
import type { Viewport } from '../domain/inspection.js';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };

export interface AppConfig {
  readonly navigationTimeoutMs: number;
  readonly headless: boolean;
  readonly viewport: Viewport;
  readonly artifactsDirectory: string;
}

export interface ConfigOverrides {
  readonly timeout?: string | undefined;
  readonly headed?: boolean | undefined;
  readonly artifactsDirectory?: string | undefined;
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer; received "${raw}".`);
  }
  return value;
}

function booleanValue(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  throw new ConfigurationError(`${name} must be true/false, 1/0, or yes/no; received "${raw}".`);
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  overrides: ConfigOverrides = {},
): AppConfig {
  const artifactsValue =
    overrides.artifactsDirectory ?? environment.AGENTIC_QA_ARTIFACTS_DIR ?? 'artifacts';

  if (artifactsValue.trim() === '') {
    throw new ConfigurationError('Artifacts directory must not be empty.');
  }

  return {
    navigationTimeoutMs: positiveInteger(
      'Navigation timeout',
      overrides.timeout ?? environment.AGENTIC_QA_NAVIGATION_TIMEOUT_MS,
      DEFAULT_NAVIGATION_TIMEOUT_MS,
    ),
    headless: overrides.headed
      ? false
      : booleanValue('AGENTIC_QA_HEADLESS', environment.AGENTIC_QA_HEADLESS, true),
    viewport: {
      width: positiveInteger(
        'AGENTIC_QA_VIEWPORT_WIDTH',
        environment.AGENTIC_QA_VIEWPORT_WIDTH,
        DEFAULT_VIEWPORT.width,
      ),
      height: positiveInteger(
        'AGENTIC_QA_VIEWPORT_HEIGHT',
        environment.AGENTIC_QA_VIEWPORT_HEIGHT,
        DEFAULT_VIEWPORT.height,
      ),
    },
    artifactsDirectory: resolve(cwd, artifactsValue),
  };
}
