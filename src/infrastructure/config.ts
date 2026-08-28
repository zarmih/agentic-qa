import { resolve } from 'node:path';
import { ConfigurationError } from '../application/errors.js';
import type { Viewport } from '../domain/inspection.js';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };
const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_QUERY_VARIANTS_PER_PATH = 5;
const DEFAULT_MAX_STATES = 12;
const DEFAULT_MAX_ACTIONS_PER_STATE = 4;
const DEFAULT_MAX_STATE_DEPTH = 2;
const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export interface AppConfig {
  readonly navigationTimeoutMs: number;
  readonly headless: boolean;
  readonly viewport: Viewport;
  readonly artifactsDirectory: string;
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly maxQueryVariantsPerPath: number;
  readonly maxStates: number;
  readonly maxActionsPerState: number;
  readonly maxStateDepth: number;
}

export interface ConfigOverrides {
  readonly timeout?: string | undefined;
  readonly headed?: boolean | undefined;
  readonly artifactsDirectory?: string | undefined;
  readonly maxPages?: string | undefined;
  readonly maxDepth?: string | undefined;
  readonly maxQueryVariantsPerPath?: string | undefined;
  readonly maxStates?: string | undefined;
  readonly maxActionsPerState?: string | undefined;
  readonly maxStateDepth?: string | undefined;
}

export interface PlanningConfig {
  readonly provider: 'openai-compatible';
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly model: string;
  readonly timeoutMs: number;
}

export interface PlanningConfigOverrides {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly timeout?: string | undefined;
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

function integerInRange(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${name} must be an integer from ${String(minimum)} through ${String(maximum)}; received "${raw}".`,
    );
  }
  return value;
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
    maxPages: integerInRange(
      'Maximum pages',
      overrides.maxPages ?? environment.AGENTIC_QA_MAX_PAGES,
      DEFAULT_MAX_PAGES,
      1,
      1000,
    ),
    maxDepth: integerInRange(
      'Maximum depth',
      overrides.maxDepth ?? environment.AGENTIC_QA_MAX_DEPTH,
      DEFAULT_MAX_DEPTH,
      0,
      20,
    ),
    maxQueryVariantsPerPath: integerInRange(
      'Maximum query variants per path',
      overrides.maxQueryVariantsPerPath ?? environment.AGENTIC_QA_MAX_QUERY_VARIANTS_PER_PATH,
      DEFAULT_MAX_QUERY_VARIANTS_PER_PATH,
      1,
      100,
    ),
    maxStates: integerInRange(
      'Maximum states',
      overrides.maxStates ?? environment.AGENTIC_QA_MAX_STATES,
      DEFAULT_MAX_STATES,
      1,
      100,
    ),
    maxActionsPerState: integerInRange(
      'Maximum actions per state',
      overrides.maxActionsPerState ?? environment.AGENTIC_QA_MAX_ACTIONS_PER_STATE,
      DEFAULT_MAX_ACTIONS_PER_STATE,
      1,
      25,
    ),
    maxStateDepth: integerInRange(
      'Maximum state depth',
      overrides.maxStateDepth ?? environment.AGENTIC_QA_MAX_STATE_DEPTH,
      DEFAULT_MAX_STATE_DEPTH,
      0,
      5,
    ),
  };
}

export function loadPlanningConfig(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: PlanningConfigOverrides = {},
): PlanningConfig {
  const provider = overrides.provider ?? 'openai-compatible';
  if (provider !== 'openai-compatible') {
    throw new ConfigurationError(
      `Unsupported reasoning provider "${provider}". Stage 4 supports openai-compatible.`,
    );
  }
  const baseUrlValue = environment.AGENTIC_QA_LLM_BASE_URL?.trim();
  if (baseUrlValue === undefined || baseUrlValue === '') {
    throw new ConfigurationError('AGENTIC_QA_LLM_BASE_URL is required for QA planning.');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new ConfigurationError('AGENTIC_QA_LLM_BASE_URL must be an absolute HTTP(S) URL.');
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username !== '' ||
    baseUrl.password !== ''
  ) {
    throw new ConfigurationError(
      'AGENTIC_QA_LLM_BASE_URL must be an HTTP(S) URL without embedded credentials.',
    );
  }
  baseUrl.hash = '';
  const model = (overrides.model ?? environment.AGENTIC_QA_LLM_MODEL)?.trim();
  if (model === undefined || model === '') {
    throw new ConfigurationError('A model is required. Use --model or AGENTIC_QA_LLM_MODEL.');
  }
  if (model.length > 200) throw new ConfigurationError('The configured model name is too long.');
  const apiKeyValue = environment.AGENTIC_QA_LLM_API_KEY?.trim();
  const apiKey = apiKeyValue === undefined || apiKeyValue === '' ? null : apiKeyValue;
  return {
    provider,
    baseUrl: baseUrl.href,
    apiKey,
    model,
    timeoutMs: integerInRange(
      'LLM timeout',
      overrides.timeout ?? environment.AGENTIC_QA_LLM_TIMEOUT_MS,
      DEFAULT_LLM_TIMEOUT_MS,
      100,
      300_000,
    ),
  };
}
