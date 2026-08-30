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
    stages: [
      ['explore', 'exploration.json'],
      ['plan', 'planning/qa-plan.json'],
      ['run', 'executions/e/execution.json'],
      ['verify', 'verifications/v/verification.json'],
      ['generate', 'regressions/g/manifest.json'],
    ].map(([name, artifact]) => ({
      name,
      status: 'PASS',
      startedAt: '2026-08-29T00:00:00.000Z',
      completedAt: '2026-08-29T00:00:01.000Z',
      durationMs: 100,
      artifact,
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

  it('accepts a current failed-exploration record and rejects future versions', () => {
    const legacy = validPipeline();
    const failed = {
      ...legacy,
      schemaVersion: '1.1',
      version: '1.0.0',
      status: 'FAILED',
      stages: legacy.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              status: 'FAILED',
              artifact: null,
              error: 'Chromium could not start.',
            }
          : {
              ...stage,
              status: 'NOT_RUN',
              startedAt: null,
              completedAt: null,
              durationMs: 0,
              artifact: null,
              summary: {},
              error: null,
            },
      ),
      artifacts: {
        pipeline: 'pipeline.json',
        report: 'report.html',
        exploration: null,
        plan: null,
        execution: null,
        verification: null,
        findings: null,
        generation: null,
        manifest: null,
      },
    };
    expect(parseSavedPipeline(failed)).toMatchObject({
      schemaVersion: '1.1',
      version: '1.0.0',
      status: 'FAILED',
      artifacts: { exploration: null },
    });
    expect(() => parseSavedPipeline({ ...failed, schemaVersion: '999.0' })).toThrow(
      SavedPipelineValidationError,
    );
    expect(() =>
      parseSavedPipeline({
        ...failed,
        artifacts: { ...failed.artifacts, plan: 'planning/qa-plan.json' },
      }),
    ).toThrow(/may be null only/);
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

  it('rejects status, stage metadata, and derived artifact inconsistencies', () => {
    const pipeline = validPipeline();
    expect(() => parseSavedPipeline({ ...pipeline, status: 'FAILED' })).toThrow(
      /every stage completed/,
    );
    expect(() =>
      parseSavedPipeline({
        ...pipeline,
        stages: pipeline.stages.map((stage, index) =>
          index === 2 ? { ...stage, artifact: 'executions/other/execution.json' } : stage,
        ),
      }),
    ).toThrow(/canonical artifact reference/);
    expect(() =>
      parseSavedPipeline({
        ...pipeline,
        artifacts: { ...pipeline.artifacts, findings: 'verifications/other/findings.json' },
      }),
    ).toThrow(/verification artifact directory/);
  });
});
