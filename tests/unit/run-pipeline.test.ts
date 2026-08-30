import { describe, expect, it } from 'vitest';
import {
  ExplorationRunFailure,
  type ExploreApplicationOptions,
} from '../../src/application/explore-application.js';
import type { RunPipelineOptions } from '../../src/application/run-pipeline.js';
import { RunPipeline } from '../../src/application/run-pipeline.js';
import { parseSavedPipeline } from '../../src/application/pipeline-schema.js';
import type { PipelineArtifactWriter } from '../../src/application/pipeline-ports.js';
import { PipelineHtmlRenderer } from '../../src/reporting/pipeline-html.js';

const exploration: ExploreApplicationOptions = {
  headless: true,
  interactive: true,
  navigationTimeoutMs: 1_000,
  viewport: { width: 1_000, height: 700 },
  maxPages: 5,
  maxDepth: 1,
  maxQueryVariantsPerPath: 2,
  maxStates: 8,
  maxActionsPerState: 3,
  maxStateDepth: 1,
};

const options: RunPipelineOptions = {
  profile: 'quick',
  provider: 'openai-compatible',
  model: 'fixture-model',
  exploration,
  planning: { provider: 'openai-compatible', model: 'fixture-model' },
  execution: {
    headless: true,
    viewport: exploration.viewport,
    navigationTimeoutMs: 1_000,
    maxScenarios: 5,
    maxStepsPerScenario: 5,
    executionTimeoutMs: 10_000,
    stepTimeoutMs: 1_000,
  },
  verification: {
    attempts: 2,
    maxFindings: 5,
    verifyTimeoutMs: 20_000,
    headless: true,
    viewport: exploration.viewport,
    navigationTimeoutMs: 1_000,
    maxStepsPerScenario: 5,
    executionTimeoutMs: 10_000,
    stepTimeoutMs: 1_000,
  },
  generation: {
    includeFlaky: false,
    maxGeneratedTests: 5,
    maxStepsPerTest: 5,
    maxAssertionsPerTest: 3,
  },
};

describe('RunPipeline', () => {
  it('persists a machine-readable pipeline and report after browser startup failure', async () => {
    let savedHtml = '';
    const artifacts: PipelineArtifactWriter = {
      save: (directory, pipeline, html) => {
        expect(directory).toBe('/artifacts/run-startup-failure');
        expect(pipeline.status).toBe('FAILED');
        savedHtml = html;
        return Promise.resolve();
      },
    };
    const unreachable = { execute: () => Promise.reject(new Error('must not run')) };
    const times = [
      '2026-08-29T00:00:00.000Z',
      '2026-08-29T00:00:00.010Z',
      '2026-08-29T00:00:00.020Z',
      '2026-08-29T00:00:00.030Z',
    ].map((value) => new Date(value));
    const pipeline = new RunPipeline(
      {
        execute: () =>
          Promise.reject(
            new ExplorationRunFailure(
              'run-startup-failure',
              'https://fixture.test/',
              '/artifacts/run-startup-failure',
              new Error('Chromium could not start.'),
            ),
          ),
      },
      unreachable,
      unreachable,
      unreachable,
      unreachable,
      new PipelineHtmlRenderer(),
      artifacts,
      { now: () => times.shift() ?? new Date('2026-08-29T00:00:00.030Z') },
    );

    const outcome = await pipeline.execute('https://fixture.test/', options);
    expect(outcome).toMatchObject({
      exitCode: 2,
      artifactDirectory: '/artifacts/run-startup-failure',
    });
    expect(outcome.pipeline).toMatchObject({
      schemaVersion: '1.1',
      version: '0.9.0',
      status: 'FAILED',
      artifacts: { exploration: null },
    });
    expect(outcome.pipeline.stages.map((stage) => stage.status)).toEqual([
      'FAILED',
      'NOT_RUN',
      'NOT_RUN',
      'NOT_RUN',
      'NOT_RUN',
    ]);
    expect(parseSavedPipeline(outcome.pipeline)).toEqual(outcome.pipeline);
    expect(savedHtml).toContain('Exploration did not start');
  });
});
