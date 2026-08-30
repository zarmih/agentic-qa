import { join, relative, sep } from 'node:path';
import type {
  PipelineRun,
  PipelineStageName,
  PipelineStageRecord,
  PipelineStatus,
} from '../domain/pipeline.js';
import type { Clock } from './ports.js';
import type {
  PipelineArtifactWriter,
  PipelineExplorer,
  PipelineGenerator,
  PipelineHtmlRenderer,
  PipelinePlanner,
  PipelineReportData,
  PipelineRunner,
  PipelineVerifier,
} from './pipeline-ports.js';
import {
  ExplorationRunFailure,
  type ExploreApplicationOptions,
  type ExplorationOutcome,
} from './explore-application.js';
import type { PlanQaOptions, PlanQaOutcome } from './plan-qa.js';
import type { RunQaPlanOptions, RunQaPlanOutcome } from './run-qa-plan.js';
import type { VerifyExecutionOptions, VerifyExecutionOutcome } from './verify-execution.js';
import type {
  GenerateRegressionsOptions,
  GenerateRegressionsOutcome,
} from './generate-regressions.js';
import type { PipelineProfile } from '../domain/pipeline.js';
import { ArtifactWriteError, PipelineError } from './errors.js';

export interface RunPipelineOptions {
  readonly profile: PipelineProfile;
  readonly provider: 'openai-compatible';
  readonly model: string;
  readonly exploration: ExploreApplicationOptions;
  readonly planning: PlanQaOptions;
  readonly execution: RunQaPlanOptions;
  readonly verification: VerifyExecutionOptions;
  readonly generation: GenerateRegressionsOptions;
}

export interface RunPipelineOutcome {
  readonly pipeline: PipelineRun;
  readonly artifactDirectory: string;
  readonly reportFile: string;
  readonly exitCode: 0 | 1 | 2;
}

function artifact(root: string, value: string): string {
  return relative(root, value).split(sep).join('/');
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unexpected pipeline failure.';
  return Array.from(message)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
    })
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

function notRun(name: PipelineStageName): PipelineStageRecord {
  return {
    name,
    status: 'NOT_RUN',
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    artifact: null,
    summary: {},
    error: null,
  };
}

export class RunPipeline {
  public constructor(
    private readonly explorer: PipelineExplorer,
    private readonly planner: PipelinePlanner,
    private readonly runner: PipelineRunner,
    private readonly verifier: PipelineVerifier,
    private readonly generator: PipelineGenerator,
    private readonly renderer: PipelineHtmlRenderer,
    private readonly artifacts: PipelineArtifactWriter,
    private readonly clock: Clock,
  ) {}

  public async execute(url: string, options: RunPipelineOptions): Promise<RunPipelineOutcome> {
    const startedAt = this.clock.now();
    const stages: PipelineStageRecord[] = [
      notRun('explore'),
      notRun('plan'),
      notRun('run'),
      notRun('verify'),
      notRun('generate'),
    ];
    let exploration: ExplorationOutcome;
    const explorationStarted = this.clock.now();
    try {
      exploration = await this.explorer.execute(url, options.exploration);
      stages[0] = this.stage(
        'explore',
        'PASS',
        explorationStarted,
        this.clock.now(),
        'exploration.json',
        {
          pages: exploration.result.summary.pagesVisited,
          states: exploration.result.interactive.statesDiscovered,
          actions: exploration.result.interactive.actionsExecuted,
          blockedActions: exploration.result.interactive.actionsBlocked,
        },
      );
    } catch (error) {
      if (error instanceof ExplorationRunFailure) {
        stages[0] = this.failedStage('explore', explorationStarted, error);
        return this.finishExplorationFailure({ error, startedAt, options, stages });
      }
      if (error instanceof ArtifactWriteError) throw error;
      throw new PipelineError(
        `Explore failed before a pipeline artifact could be created: ${cleanError(error)}`,
        {
          cause: error,
        },
      );
    }
    const runDirectory = exploration.artifactDirectory;
    let plan: PlanQaOutcome | null = null;
    let execution: RunQaPlanOutcome | null = null;
    let verification: VerifyExecutionOutcome | null = null;
    let generation: GenerateRegressionsOutcome | null = null;
    const warnings = [...exploration.result.warnings];

    const planStarted = this.clock.now();
    try {
      plan = await this.planner.execute(join(runDirectory, 'exploration.json'), options.planning);
      stages[1] = this.stage(
        'plan',
        'PASS',
        planStarted,
        this.clock.now(),
        'planning/qa-plan.json',
        {
          scenarios: plan.plan.scenarios.length,
          automatable: plan.plan.scenarios.filter((item) => item.executability === 'AUTOMATABLE')
            .length,
          manual: plan.plan.scenarios.filter((item) => item.executability === 'MANUAL_ONLY').length,
        },
      );
      warnings.push(...plan.plan.warnings);
    } catch (error) {
      stages[1] = this.failedStage('plan', planStarted, error);
      return this.finish({
        status: 'FAILED',
        startedAt,
        options,
        stages,
        warnings,
        exploration,
        plan,
        execution,
        verification,
        generation,
      });
    }

    const executionStarted = this.clock.now();
    try {
      execution = await this.runner.execute(
        join(plan.artifactDirectory, 'qa-plan.json'),
        options.execution,
      );
      stages[2] = this.stage(
        'run',
        execution.exitCode === 0
          ? 'PASS'
          : execution.exitCode === 1
            ? 'COMPLETED_WITH_FINDINGS'
            : 'FAILED',
        executionStarted,
        this.clock.now(),
        artifact(runDirectory, join(execution.artifactDirectory, 'execution.json')),
        {
          passed: execution.result.summary.passed,
          failed: execution.result.summary.failed,
          blocked: execution.result.summary.blocked,
          errors: execution.result.summary.errors,
          skipped: execution.result.summary.skipped,
        },
      );
      if (execution.exitCode === 2) {
        return await this.finish({
          status: 'FAILED',
          startedAt,
          options,
          stages,
          warnings,
          exploration,
          plan,
          execution,
          verification,
          generation,
        });
      }
    } catch (error) {
      stages[2] = this.failedStage('run', executionStarted, error);
      return this.finish({
        status: 'FAILED',
        startedAt,
        options,
        stages,
        warnings,
        exploration,
        plan,
        execution,
        verification,
        generation,
      });
    }

    const verificationStarted = this.clock.now();
    try {
      verification = await this.verifier.execute(
        join(execution.artifactDirectory, 'execution.json'),
        options.verification,
      );
      const summary = verification.result.summary;
      stages[3] = this.stage(
        'verify',
        verification.exitCode === 0
          ? 'PASS'
          : verification.exitCode === 1
            ? 'COMPLETED_WITH_FINDINGS'
            : 'FAILED',
        verificationStarted,
        this.clock.now(),
        artifact(runDirectory, join(verification.artifactDirectory, 'verification.json')),
        {
          confirmed: summary.confirmed,
          probable: summary.probable,
          flaky: summary.flaky,
          notReproduced: summary.notReproduced,
          inconclusive: summary.inconclusive,
          attempts: summary.attemptsCompleted,
        },
      );
      warnings.push(...verification.result.warnings);
      if (verification.exitCode === 2) {
        return await this.finish({
          status: 'FAILED',
          startedAt,
          options,
          stages,
          warnings,
          exploration,
          plan,
          execution,
          verification,
          generation,
        });
      }
    } catch (error) {
      stages[3] = this.failedStage('verify', verificationStarted, error);
      return this.finish({
        status: 'FAILED',
        startedAt,
        options,
        stages,
        warnings,
        exploration,
        plan,
        execution,
        verification,
        generation,
      });
    }

    const generationStarted = this.clock.now();
    try {
      generation = await this.generator.execute(
        join(verification.artifactDirectory, 'findings.json'),
        options.generation,
      );
      stages[4] = this.stage(
        'generate',
        generation.exitCode === 0 ? 'PASS' : 'COMPLETED_WITH_FINDINGS',
        generationStarted,
        this.clock.now(),
        artifact(runDirectory, join(generation.artifactDirectory, 'manifest.json')),
        {
          generated: generation.manifest.summary.generated,
          fixme: generation.manifest.summary.generatedFixme,
          reviewOnly: generation.manifest.summary.reviewOnly,
          unsupported: generation.manifest.summary.unsupported,
        },
      );
    } catch (error) {
      stages[4] = this.failedStage('generate', generationStarted, error);
      return this.finish({
        status: 'FAILED',
        startedAt,
        options,
        stages,
        warnings,
        exploration,
        plan,
        execution,
        verification,
        generation,
      });
    }
    const actionableFindings =
      verification.result.summary.confirmed +
      verification.result.summary.probable +
      verification.result.summary.flaky +
      verification.result.summary.inconclusive;
    const status: PipelineStatus =
      generation.manifest.summary.generated + generation.manifest.summary.generatedFixme > 0
        ? 'COMPLETE_WITH_REGRESSIONS'
        : actionableFindings > 0
          ? 'COMPLETE_WITH_FINDINGS'
          : 'COMPLETE_NO_DEFECTS';
    return this.finish({
      status,
      startedAt,
      options,
      stages,
      warnings,
      exploration,
      plan,
      execution,
      verification,
      generation,
    });
  }

  private async finishExplorationFailure(input: {
    readonly error: ExplorationRunFailure;
    readonly startedAt: Date;
    readonly options: RunPipelineOptions;
    readonly stages: readonly PipelineStageRecord[];
  }): Promise<RunPipelineOutcome> {
    const completedAt = this.clock.now();
    const pipeline: PipelineRun = {
      schemaVersion: '1.1',
      pipelineId: `pipeline-${input.error.runId}`,
      sourceRunId: input.error.runId,
      target: input.error.startUrl,
      profile: input.options.profile,
      provider: input.options.provider,
      model: input.options.model.slice(0, 200),
      version: '0.9.0',
      startedAt: input.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
      status: 'FAILED',
      stages: input.stages,
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
      warnings: [],
    };
    const data: PipelineReportData = {
      pipeline,
      exploration: null,
      plan: null,
      execution: null,
      verification: null,
      manifest: null,
    };
    await this.artifacts.save(input.error.artifactDirectory, pipeline, this.renderer.render(data));
    return {
      pipeline,
      artifactDirectory: input.error.artifactDirectory,
      reportFile: join(input.error.artifactDirectory, 'report.html'),
      exitCode: 2,
    };
  }

  private async finish(input: {
    readonly status: PipelineStatus;
    readonly startedAt: Date;
    readonly options: RunPipelineOptions;
    readonly stages: readonly PipelineStageRecord[];
    readonly warnings: readonly string[];
    readonly exploration: ExplorationOutcome;
    readonly plan: PlanQaOutcome | null;
    readonly execution: RunQaPlanOutcome | null;
    readonly verification: VerifyExecutionOutcome | null;
    readonly generation: GenerateRegressionsOutcome | null;
  }): Promise<RunPipelineOutcome> {
    const completedAt = this.clock.now();
    const runDirectory = input.exploration.artifactDirectory;
    const pipeline: PipelineRun = {
      schemaVersion: '1.1',
      pipelineId: `pipeline-${input.exploration.result.runId}`,
      sourceRunId: input.exploration.result.runId,
      target: input.exploration.result.startUrl,
      profile: input.options.profile,
      provider: input.options.provider,
      model: input.options.model.slice(0, 200),
      version: '0.9.0',
      startedAt: input.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
      status: input.status,
      stages: input.stages,
      artifacts: {
        pipeline: 'pipeline.json',
        report: 'report.html',
        exploration: 'exploration.json',
        plan: input.plan === null ? null : 'planning/qa-plan.json',
        execution:
          input.execution === null
            ? null
            : artifact(runDirectory, join(input.execution.artifactDirectory, 'execution.json')),
        verification:
          input.verification === null
            ? null
            : artifact(
                runDirectory,
                join(input.verification.artifactDirectory, 'verification.json'),
              ),
        findings:
          input.verification === null
            ? null
            : artifact(runDirectory, join(input.verification.artifactDirectory, 'findings.json')),
        generation:
          input.generation === null
            ? null
            : artifact(runDirectory, input.generation.artifactDirectory),
        manifest:
          input.generation === null
            ? null
            : artifact(runDirectory, join(input.generation.artifactDirectory, 'manifest.json')),
      },
      warnings: [...new Set(input.warnings)].slice(0, 200),
    };
    const data: PipelineReportData = {
      pipeline,
      exploration: input.exploration.result,
      plan: input.plan?.plan ?? null,
      execution: input.execution?.result ?? null,
      verification: input.verification?.result ?? null,
      manifest: input.generation?.manifest ?? null,
    };
    await this.artifacts.save(runDirectory, pipeline, this.renderer.render(data));
    return {
      pipeline,
      artifactDirectory: runDirectory,
      reportFile: join(runDirectory, 'report.html'),
      exitCode: input.status === 'FAILED' ? 2 : input.status === 'COMPLETE_NO_DEFECTS' ? 0 : 1,
    };
  }

  private stage(
    name: PipelineStageName,
    status: PipelineStageRecord['status'],
    startedAt: Date,
    completedAt: Date,
    artifactPath: string | null,
    summary: PipelineStageRecord['summary'],
  ): PipelineStageRecord {
    return {
      name,
      status,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      artifact: artifactPath,
      summary,
      error: null,
    };
  }

  private failedStage(
    name: PipelineStageName,
    startedAt: Date,
    error: unknown,
  ): PipelineStageRecord {
    return {
      ...this.stage(name, 'FAILED', startedAt, this.clock.now(), null, {}),
      error: cleanError(error),
    };
  }
}
