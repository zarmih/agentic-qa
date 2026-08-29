import { describe, expect, it } from 'vitest';
import {
  parseSavedPipeline,
  SavedPipelineValidationError,
} from '../../src/application/pipeline-schema.js';
import { PIPELINE_PROFILE_LIMITS } from '../../src/domain/pipeline.js';

function validPipeline() {
  return {
    schemaVersion: '1.0',
    pipelineId: 'pipeline-run-1',
    sourceRunId: 'run-1',
    target: 'https://example.test',
    profile: 'standard',
    provider: 'openai-compatible',
    model: 'fixture',
    version: '0.8.0',
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    durationMs: 1_000,
    status: 'COMPLETE_WITH_REGRESSIONS',
    stages: ['explore', 'plan', 'run', 'verify', 'generate'].map((name) => ({
      name,
      status: 'PASS',
      startedAt: '2026-08-29T00:00:00.000Z',
      completedAt: '2026-08-29T00:00:01.000Z',
      durationMs: 100,
      artifact: `${name}.json`,
      summary: {},
      error: null,
    })),
    artifacts: {
      pipeline: 'pipeline.json',
      report: 'report.html',
      exploration: 'exploration.json',
      plan: 'planning/qa-plan.json',
      execution: 'executions/e/execution.json',
      verification: 'verifications/v/verification.json',
      findings: 'verifications/v/findings.json',
      generation: 'regressions/g',
      manifest: 'regressions/g/manifest.json',
    },
    warnings: [],
  };
}

describe('pipeline product model', () => {
  it('defines increasing, bounded quick, standard, and thorough profiles', () => {
    expect(PIPELINE_PROFILE_LIMITS.quick).toEqual({
      maxPages: 5,
      maxDepth: 1,
      maxStates: 8,
      maxActionsPerState: 3,
      maxStateDepth: 1,
      verificationAttempts: 2,
      maxVerifyFindings: 5,
      maxGeneratedTests: 5,
    });
    expect(PIPELINE_PROFILE_LIMITS.standard.verificationAttempts).toBe(3);
    expect(PIPELINE_PROFILE_LIMITS.thorough).toMatchObject({
      maxPages: 50,
      maxStates: 25,
      verificationAttempts: 5,
      maxGeneratedTests: 40,
    });
  });

  it('strictly parses a canonical pipeline and rejects unknown fields', () => {
    expect(parseSavedPipeline(validPipeline())).toMatchObject({
      pipelineId: 'pipeline-run-1',
      status: 'COMPLETE_WITH_REGRESSIONS',
    });
    expect(() => parseSavedPipeline({ ...validPipeline(), injected: true })).toThrow(
      SavedPipelineValidationError,
    );
  });

  it.each(['/absolute.json', '../outside.json', 'safe/../../outside.json', 'https://evil.test/x'])(
    'rejects an unsafe pipeline artifact reference %s',
    (value) => {
      const pipeline = validPipeline();
      expect(() =>
        parseSavedPipeline({
          ...pipeline,
          artifacts: { ...pipeline.artifacts, exploration: value },
        }),
      ).toThrow(SavedPipelineValidationError);
    },
  );

  it('rejects reordered or duplicated pipeline stages', () => {
    const pipeline = validPipeline();
    expect(() =>
      parseSavedPipeline({ ...pipeline, stages: [...pipeline.stages].reverse() }),
    ).toThrow(/canonical order/);
  });
});
