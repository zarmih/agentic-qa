import { describe, expect, it } from 'vitest';
import { parseSavedExecution } from '../../src/application/execution-schema.js';
import { parseSavedExploration } from '../../src/application/exploration-schema.js';
import { parseSavedPipeline } from '../../src/application/pipeline-schema.js';
import { parseSavedQaPlan } from '../../src/application/planning-schema.js';
import { parseSavedRegressionManifest } from '../../src/application/regression-schema.js';
import {
  parseSavedFindings,
  parseSavedVerification,
} from '../../src/application/verification-schema.js';

describe('saved artifact future-version policy', () => {
  it.each([
    ['exploration', parseSavedExploration],
    ['QA plan', parseSavedQaPlan],
    ['execution', parseSavedExecution],
    ['verification', parseSavedVerification],
    ['findings', parseSavedFindings],
    ['regression manifest', parseSavedRegressionManifest],
    ['pipeline', parseSavedPipeline],
  ] as const)(
    'rejects an unsupported future %s schema instead of parsing it as current',
    (_name, parse) => {
      expect(() => parse({ schemaVersion: '999.0' })).toThrow();
    },
  );
});
