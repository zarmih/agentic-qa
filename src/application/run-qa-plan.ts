import type {
  EvidenceReproduction,
  ExecutionFailureCode,
  ExecutionLimits,
  ExecutionRun,
  ExecutionStatus,
  ScenarioExecution,
  StepExecution,
} from '../domain/execution.js';
import type { Viewport } from '../domain/inspection.js';
import type { StateNode } from '../domain/interaction.js';
import type { PlanningEvidenceObservation, TestScenario } from '../domain/planning.js';
import {
  canonicalizePageUrl,
  ConservativeNavigationSafetyPolicy,
  SameOriginScopePolicy,
} from '../domain/url-policy.js';
import { ExecutionPlanError } from './errors.js';
import {
  type CompiledExecutionInstruction,
  type CompiledExecutionScenario,
  ScenarioExecutionCompiler,
} from './execution-compiler.js';
import { EvidenceReproductionMatcher, ExecutionEvidenceCollector } from './execution-evidence.js';
import type {
  ExecutionArtifactReader,
  ExecutionArtifactWriter,
  ExecutionBrowserCapture,
  ScenarioExecutionBrowser,
} from './execution-ports.js';
import { ExecutionInputValidator } from './execution-validator.js';
import { ExecutionIntegrityService, type UnsignedExecutionRun } from './execution-integrity.js';
import type { Clock, RunIdGenerator } from './ports.js';
import { ExecutionMarkdownRenderer } from '../reporting/execution-markdown.js';

export interface RunQaPlanOptions extends ExecutionLimits {
  readonly explorationPath?: string | undefined;
  readonly scenarioIds?: readonly string[] | undefined;
  readonly headless: boolean;
  readonly viewport: Viewport;
  readonly navigationTimeoutMs: number;
}

export interface RunQaPlanOutcome {
  readonly result: ExecutionRun;
  readonly artifactDirectory: string;
  readonly planFile: string;
  readonly explorationFile: string;
  readonly exitCode: 0 | 1 | 2;
}

function canonical(value: string | null): string | null {
  if (value === null) return null;
  try {
    return canonicalizePageUrl(value);
  } catch {
    return value;
  }
}

function statusForSteps(steps: readonly StepExecution[]): ExecutionStatus {
  if (steps.some((step) => step.status === 'ERROR')) return 'ERROR';
  if (steps.some((step) => step.status === 'BLOCKED')) return 'BLOCKED';
  if (steps.some((step) => step.status === 'FAIL')) return 'FAIL';
  if (steps.length > 0 && steps.every((step) => step.status === 'PASS')) return 'PASS';
  return 'ERROR';
}

export function executionExitCode(summary: {
  readonly errors: number;
  readonly failed: number;
  readonly blocked: number;
}): 0 | 1 | 2 {
  if (summary.errors > 0) return 2;
  if (summary.failed > 0 || summary.blocked > 0) return 1;
  return 0;
}

function skippedScenario(compiled: CompiledExecutionScenario, index: number): ScenarioExecution {
  const skip = compiled.skip;
  if (skip === null) throw new Error('Expected a skipped compiled scenario.');
  return {
    id: `execution-scenario-${String(index + 1).padStart(3, '0')}`,
    planScenarioId: compiled.scenario.id,
    title: compiled.scenario.title,
    priority: compiled.scenario.priority,
    plannedExecutability: compiled.scenario.executability,
    status: 'SKIPPED',
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    failureCode: skip.code,
    message: skip.reason,
    steps: [],
    evidenceReproduction: [],
    screenshotRefs: [],
  };
}

export class RunQaPlan {
  private readonly validator = new ExecutionInputValidator();
  private readonly compiler = new ScenarioExecutionCompiler();
  private readonly evidenceMatcher = new EvidenceReproductionMatcher();
  private readonly executionIntegrity = new ExecutionIntegrityService();
  private readonly markdown = new ExecutionMarkdownRenderer();

  public constructor(
    private readonly reader: ExecutionArtifactReader,
    private readonly writer: ExecutionArtifactWriter,
    private readonly browser: ScenarioExecutionBrowser,
    private readonly runIds: RunIdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(planPath: string, options: RunQaPlanOptions): Promise<RunQaPlanOutcome> {
    const loaded = await this.reader.loadExecutionInput(planPath, options.explorationPath);
    const validated = this.validator.validate(loaded);
    const compiled = this.compiler.compile(
      loaded.plan,
      loaded.exploration,
      options,
      options.scenarioIds,
    );
    const startedAt = this.clock.now();
    const executionId = `exec-${this.runIds.next(startedAt)}`;
    const locations = await this.writer.prepareExecution(loaded.runDirectory, executionId);
    const evidence = new ExecutionEvidenceCollector();
    const sourceGraph = loaded.exploration.stateGraph;
    if (sourceGraph === null) throw new ExecutionPlanError('Source state graph is missing.');
    const statesByFingerprint = new Map(
      sourceGraph.nodes.map((state) => [state.fingerprint, state]),
    );
    const scope = new SameOriginScopePolicy(loaded.exploration.startUrl);
    const navigationSafety = new ConservativeNavigationSafetyPolicy();
    const canNavigate = (value: string): boolean => {
      try {
        return scope.classify(value) === 'internal' && navigationSafety.allows(value);
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + options.executionTimeoutMs;
    const session = await this.browser.start({
      headless: options.headless,
      viewport: options.viewport,
      tracePath: locations.tracePath,
    });
    const scenarios: ScenarioExecution[] = [];
    let closeWarnings: readonly string[];
    try {
      for (let index = 0; index < compiled.scenarios.length; index += 1) {
        const item = compiled.scenarios[index];
        if (item === undefined) continue;
        if (item.skip !== null) {
          scenarios.push(skippedScenario(item, index));
          continue;
        }
        if (Date.now() >= deadline) {
          scenarios.push(
            this.executionTimeoutScenario(
              item.scenario,
              index,
              'Execution timeout reached before scenario start.',
            ),
          );
          continue;
        }
        scenarios.push(
          await this.executeScenario({
            compiled: item,
            index,
            executionId,
            runDirectory: loaded.runDirectory,
            session,
            evidence,
            evidenceCatalog: validated.compiledObservation.catalog.evidence,
            statesByFingerprint,
            canNavigate,
            options,
            deadline,
          }),
        );
      }
    } finally {
      closeWarnings = await session.close();
    }
    if (closeWarnings.length > 0) {
      throw new ExecutionPlanError(closeWarnings.join(' '));
    }

    const completedAt = this.clock.now();
    const allEvidence = evidence.all();
    const reproductions = scenarios.flatMap((scenario) => scenario.evidenceReproduction);
    const summary = {
      scenariosInPlan: compiled.scenarios.length,
      automatableScenarios: compiled.scenarios.filter(
        ({ scenario }) => scenario.executability === 'AUTOMATABLE',
      ).length,
      selectedScenarios: compiled.scenarios.filter((scenario) => scenario.skip === null).length,
      passed: scenarios.filter((scenario) => scenario.status === 'PASS').length,
      failed: scenarios.filter((scenario) => scenario.status === 'FAIL').length,
      blocked: scenarios.filter((scenario) => scenario.status === 'BLOCKED').length,
      errors: scenarios.filter((scenario) => scenario.status === 'ERROR').length,
      skipped: scenarios.filter((scenario) => scenario.status === 'SKIPPED').length,
      stepsExecuted: scenarios
        .flatMap((scenario) => scenario.steps)
        .filter((step) => step.status !== 'SKIPPED').length,
      evidenceCaptured: allEvidence.length,
      evidenceReproduced: reproductions.filter((item) => item.status === 'REPRODUCED').length,
      evidenceEvaluated: reproductions.filter((item) => item.status !== 'NOT_EVALUATED').length,
      limitReached: [...compiled.limitReached, ...(evidence.truncated ? ['evidence'] : [])].sort(),
    } as const;
    const unsignedResult: UnsignedExecutionRun = {
      schemaVersion: '1.1',
      executionId,
      sourceRunId: loaded.exploration.runId,
      planId: loaded.plan.planId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        browserName: 'chromium',
        browserVersion: session.browserVersion,
        viewport: options.viewport,
      },
      summary,
      scenarios,
      evidence: allEvidence,
      sourceIntegrity: {
        ...loaded.plan.metadata.sourceIntegrity,
        planDigest: validated.planDigest,
      },
      artifacts: {
        report: 'execution.json',
        markdown: 'execution.md',
        trace: 'trace.zip',
        screenshotsDirectory: 'screenshots',
      },
    };
    const result: ExecutionRun = {
      ...unsignedResult,
      executionIntegrity: this.executionIntegrity.create(unsignedResult),
    };
    await this.writer.saveExecution(
      loaded.runDirectory,
      executionId,
      result,
      this.markdown.render(result),
    );
    const exitCode = executionExitCode(summary);
    return {
      result,
      artifactDirectory: locations.directory,
      planFile: loaded.planFile,
      explorationFile: loaded.explorationFile,
      exitCode,
    };
  }

  private async executeScenario(input: {
    readonly compiled: CompiledExecutionScenario;
    readonly index: number;
    readonly executionId: string;
    readonly runDirectory: string;
    readonly session: Awaited<ReturnType<ScenarioExecutionBrowser['start']>>;
    readonly evidence: ExecutionEvidenceCollector;
    readonly evidenceCatalog: ReadonlyMap<string, PlanningEvidenceObservation>;
    readonly statesByFingerprint: ReadonlyMap<string, StateNode>;
    readonly canNavigate: (url: string) => boolean;
    readonly options: RunQaPlanOptions;
    readonly deadline: number;
  }): Promise<ScenarioExecution> {
    const scenarioStarted = this.clock.now();
    const scenarioExecutionId = `execution-scenario-${String(input.index + 1).padStart(3, '0')}`;
    const screenshotDirectory = `scenario-${String(input.index + 1).padStart(3, '0')}`;
    const steps: StepExecution[] = [];
    const screenshotRefs: string[] = [];
    const scenarioEvidenceStart = input.evidence.all().length;
    try {
      await input.session.beginScenario();
      const first = input.compiled.instructions[0];
      if (first !== undefined) {
        const startUrl = first.page.finalUrl;
        const startCapture = await input.session.captureStart({
          url: startUrl,
          navigationTimeoutMs: input.options.navigationTimeoutMs,
          stepTimeoutMs: input.options.stepTimeoutMs,
          canNavigate: input.canNavigate,
        });
        const actualState =
          startCapture.actualFingerprint === null
            ? null
            : (input.statesByFingerprint.get(startCapture.actualFingerprint) ?? null);
        input.evidence.append(startCapture.evidence, {
          executionId: input.executionId,
          scenarioId: scenarioExecutionId,
          stepId: null,
          pageId: first.page.id,
          sourceStateId: first.kind === 'CLICK' ? first.sourceState.id : null,
          actualStateId: actualState?.id ?? null,
          actualUrl: startCapture.actualUrl,
        });
        if (startCapture.screenshot !== null) {
          screenshotRefs.push(
            await this.writer.saveExecutionScreenshot(
              input.runDirectory,
              input.executionId,
              screenshotDirectory,
              startCapture.status === 'COMPLETED' ? '000-start.png' : '000-error.png',
              startCapture.screenshot,
            ),
          );
        }
      }
    } catch (error) {
      const completed = this.clock.now();
      return {
        id: scenarioExecutionId,
        planScenarioId: input.compiled.scenario.id,
        title: input.compiled.scenario.title,
        priority: input.compiled.scenario.priority,
        plannedExecutability: input.compiled.scenario.executability,
        status: 'ERROR',
        startedAt: scenarioStarted.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - scenarioStarted.getTime()),
        failureCode: 'BROWSER_ERROR',
        message: error instanceof Error ? error.message : 'Unexpected scenario setup error.',
        steps,
        evidenceReproduction: [],
        screenshotRefs,
      };
    }

    for (let index = 0; index < input.compiled.instructions.length; index += 1) {
      const instruction = input.compiled.instructions[index];
      if (instruction === undefined) continue;
      if (steps.some((step) => !['PASS'].includes(step.status))) {
        steps.push(this.dependentSkippedStep(instruction, scenarioExecutionId, index));
        continue;
      }
      if (Date.now() >= input.deadline) {
        steps.push(this.timeoutStep(instruction, scenarioExecutionId, index));
        continue;
      }
      const stepExecutionId = `execution-step-${String(input.index + 1).padStart(3, '0')}-${String(index + 1).padStart(3, '0')}`;
      let capture: ExecutionBrowserCapture;
      try {
        capture =
          instruction.kind === 'NAVIGATE'
            ? await input.session.navigate({
                url: instruction.page.finalUrl,
                navigationTimeoutMs: input.options.navigationTimeoutMs,
                stepTimeoutMs: input.options.stepTimeoutMs,
                canNavigate: input.canNavigate,
              })
            : await input.session.click({
                url: instruction.page.finalUrl,
                navigationTimeoutMs: input.options.navigationTimeoutMs,
                stepTimeoutMs: input.options.stepTimeoutMs,
                canNavigate: input.canNavigate,
                sourceState: instruction.sourceState,
                targetState: instruction.targetState,
                action: instruction.edge,
                candidate: instruction.candidate,
                replay: instruction.replay,
              });
      } catch (error) {
        capture = {
          status: 'ERROR',
          actualUrl: null,
          actualFingerprint: null,
          screenshot: null,
          durationMs: 0,
          failureCode: 'BROWSER_ERROR',
          reason: error instanceof Error ? error.message : 'Unexpected browser adapter error.',
          evidence: {
            browser: { console: [], pageErrors: [], failedRequests: [], httpErrors: [] },
            dialogs: [],
            popups: [],
            downloads: [],
          },
        };
      }
      const actualState =
        capture.actualFingerprint === null
          ? null
          : (input.statesByFingerprint.get(capture.actualFingerprint) ?? null);
      const context = {
        executionId: input.executionId,
        scenarioId: scenarioExecutionId,
        stepId: stepExecutionId,
        pageId: instruction.page.id,
        sourceStateId: instruction.kind === 'CLICK' ? instruction.sourceState.id : null,
        actualStateId: actualState?.id ?? null,
        actualUrl: capture.actualUrl,
      };
      const evidenceRefs = [...input.evidence.append(capture.evidence, context)];
      if (capture.status !== 'COMPLETED' && capture.reason !== null) {
        const failureEvidence = input.evidence.appendActionFailure(
          context,
          capture.reason,
          this.clock.now().toISOString(),
        );
        if (failureEvidence !== null) evidenceRefs.push(failureEvidence);
      }
      let status: ExecutionStatus;
      let failureCode = capture.failureCode;
      let message = capture.reason;
      let match = false;
      if (capture.status === 'BLOCKED') status = 'BLOCKED';
      else if (capture.status === 'ERROR' || capture.status === 'TIMEOUT') status = 'ERROR';
      else if (instruction.kind === 'NAVIGATE') {
        match = canonical(capture.actualUrl) === canonical(instruction.page.finalUrl);
        status = match ? 'PASS' : 'FAIL';
        if (!match) {
          failureCode = 'PAGE_URL_DRIFT';
          message = `Expected ${instruction.page.finalUrl}, received ${capture.actualUrl ?? 'no URL'}.`;
        }
      } else {
        match = capture.actualFingerprint === instruction.targetState.fingerprint;
        status = match ? 'PASS' : 'FAIL';
        if (!match) {
          failureCode = 'STATE_DRIFT';
          message = `Expected state ${instruction.targetState.id}; runtime fingerprint did not match.`;
        }
      }
      const suffix = status === 'PASS' ? '' : `-${status.toLowerCase()}`;
      const stepScreenshotRefs: string[] = [];
      if (capture.screenshot !== null) {
        const reference = await this.writer.saveExecutionScreenshot(
          input.runDirectory,
          input.executionId,
          screenshotDirectory,
          `${String(index + 1).padStart(3, '0')}${suffix}.png`,
          capture.screenshot,
        );
        screenshotRefs.push(reference);
        stepScreenshotRefs.push(reference);
      }
      steps.push({
        id: stepExecutionId,
        scenarioId: scenarioExecutionId,
        planStepId: instruction.step.id,
        index,
        action: instruction.kind,
        requestedTarget: {
          pageId: instruction.step.target.pageId ?? null,
          stateId: instruction.step.target.stateId ?? null,
          actionId: instruction.step.target.actionId ?? null,
        },
        expectedFingerprint:
          instruction.kind === 'CLICK' ? instruction.targetState.fingerprint : null,
        actualUrl: capture.actualUrl,
        actualFingerprint: capture.actualFingerprint,
        durationMs: capture.durationMs,
        status,
        failureCode,
        message,
        evidenceRefs,
        screenshotRefs: stepScreenshotRefs,
        transition: {
          plannedSourcePageId: instruction.page.id,
          plannedSourceStateId: instruction.kind === 'CLICK' ? instruction.sourceState.id : null,
          plannedTargetPageId:
            instruction.kind === 'NAVIGATE' ? instruction.page.id : instruction.targetState.pageId,
          plannedTargetStateId: instruction.kind === 'CLICK' ? instruction.targetState.id : null,
          actualUrl: capture.actualUrl,
          actualFingerprint: capture.actualFingerprint,
          match,
        },
      });
    }
    const scenarioCompleted = this.clock.now();
    const scenarioRuntimeEvidence = input.evidence.all().slice(scenarioEvidenceStart);
    const sourceRefs = [
      ...input.compiled.scenario.evidenceRefs,
      ...input.compiled.scenario.steps.flatMap((step) =>
        step.target.evidenceRef === undefined ? [] : [step.target.evidenceRef],
      ),
    ];
    const evidenceReproduction: readonly EvidenceReproduction[] = this.evidenceMatcher.match(
      sourceRefs,
      input.evidenceCatalog,
      scenarioRuntimeEvidence,
    );
    const status = statusForSteps(steps);
    const failedStep = steps.find((step) => !['PASS', 'SKIPPED'].includes(step.status));
    return {
      id: scenarioExecutionId,
      planScenarioId: input.compiled.scenario.id,
      title: input.compiled.scenario.title,
      priority: input.compiled.scenario.priority,
      plannedExecutability: input.compiled.scenario.executability,
      status,
      startedAt: scenarioStarted.toISOString(),
      completedAt: scenarioCompleted.toISOString(),
      durationMs: Math.max(0, scenarioCompleted.getTime() - scenarioStarted.getTime()),
      failureCode: failedStep?.failureCode ?? null,
      message: failedStep?.message ?? null,
      steps,
      evidenceReproduction,
      screenshotRefs,
    };
  }

  private dependentSkippedStep(
    instruction: CompiledExecutionInstruction,
    scenarioId: string,
    index: number,
  ): StepExecution {
    return this.unexecutedStep(
      instruction,
      scenarioId,
      index,
      'SKIPPED',
      'INVALID_SEQUENCE',
      'Skipped because a preceding dependent step did not pass.',
    );
  }

  private timeoutStep(
    instruction: CompiledExecutionInstruction,
    scenarioId: string,
    index: number,
  ): StepExecution {
    return this.unexecutedStep(
      instruction,
      scenarioId,
      index,
      'ERROR',
      'EXECUTION_TIMEOUT',
      'Execution timeout reached before this step.',
    );
  }

  private unexecutedStep(
    instruction: CompiledExecutionInstruction,
    scenarioId: string,
    index: number,
    status: ExecutionStatus,
    failureCode: ExecutionFailureCode,
    message: string,
  ): StepExecution {
    return {
      id: `${scenarioId}-step-${String(index + 1).padStart(3, '0')}`,
      scenarioId,
      planStepId: instruction.step.id,
      index,
      action: instruction.kind,
      requestedTarget: {
        pageId: instruction.step.target.pageId ?? null,
        stateId: instruction.step.target.stateId ?? null,
        actionId: instruction.step.target.actionId ?? null,
      },
      expectedFingerprint:
        instruction.kind === 'CLICK' ? instruction.targetState.fingerprint : null,
      actualUrl: null,
      actualFingerprint: null,
      durationMs: 0,
      status,
      failureCode,
      message,
      evidenceRefs: [],
      screenshotRefs: [],
      transition: {
        plannedSourcePageId: instruction.page.id,
        plannedSourceStateId: instruction.kind === 'CLICK' ? instruction.sourceState.id : null,
        plannedTargetPageId:
          instruction.kind === 'NAVIGATE' ? instruction.page.id : instruction.targetState.pageId,
        plannedTargetStateId: instruction.kind === 'CLICK' ? instruction.targetState.id : null,
        actualUrl: null,
        actualFingerprint: null,
        match: false,
      },
    };
  }

  private executionTimeoutScenario(
    scenario: TestScenario,
    index: number,
    message: string,
  ): ScenarioExecution {
    return {
      id: `execution-scenario-${String(index + 1).padStart(3, '0')}`,
      planScenarioId: scenario.id,
      title: scenario.title,
      priority: scenario.priority,
      plannedExecutability: scenario.executability,
      status: 'ERROR',
      startedAt: null,
      completedAt: null,
      durationMs: 0,
      failureCode: 'EXECUTION_TIMEOUT',
      message,
      steps: [],
      evidenceReproduction: [],
      screenshotRefs: [],
    };
  }
}
