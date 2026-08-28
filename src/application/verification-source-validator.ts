import type { ExecutionSummary, ScenarioExecution } from '../domain/execution.js';
import { VerificationIntegrityError } from './errors.js';
import { ScenarioExecutionCompiler } from './execution-compiler.js';
import { ExecutionIntegrityService } from './execution-integrity.js';
import { ExecutionInputValidator, type ValidatedExecutionInput } from './execution-validator.js';
import type { LoadedVerificationSource } from './verification-ports.js';
import { canonicalJson } from './source-integrity.js';

export interface ValidatedVerificationSource {
  readonly loaded: LoadedVerificationSource;
  readonly executionInput: ValidatedExecutionInput;
}

function safeReference(value: string): boolean {
  return (
    value !== '' &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

function expectedSummary(
  scenarios: readonly ScenarioExecution[],
  evidenceCount: number,
  limitReached: readonly string[],
): ExecutionSummary {
  const reproductions = scenarios.flatMap((scenario) => scenario.evidenceReproduction);
  return {
    scenariosInPlan: scenarios.length,
    automatableScenarios: scenarios.filter(
      (scenario) => scenario.plannedExecutability === 'AUTOMATABLE',
    ).length,
    selectedScenarios: scenarios.filter((scenario) => scenario.status !== 'SKIPPED').length,
    passed: scenarios.filter((scenario) => scenario.status === 'PASS').length,
    failed: scenarios.filter((scenario) => scenario.status === 'FAIL').length,
    blocked: scenarios.filter((scenario) => scenario.status === 'BLOCKED').length,
    errors: scenarios.filter((scenario) => scenario.status === 'ERROR').length,
    skipped: scenarios.filter((scenario) => scenario.status === 'SKIPPED').length,
    stepsExecuted: scenarios
      .flatMap((scenario) => scenario.steps)
      .filter((step) => step.status !== 'SKIPPED').length,
    evidenceCaptured: evidenceCount,
    evidenceReproduced: reproductions.filter((item) => item.status === 'REPRODUCED').length,
    evidenceEvaluated: reproductions.filter((item) => item.status !== 'NOT_EVALUATED').length,
    limitReached,
  };
}

export class VerificationSourceValidator {
  private readonly executionInput = new ExecutionInputValidator();
  private readonly executionIntegrity = new ExecutionIntegrityService();
  private readonly compiler = new ScenarioExecutionCompiler();

  public validate(loaded: LoadedVerificationSource): ValidatedVerificationSource {
    const validatedInput = this.executionInput.validate(loaded.executionInput);
    const { execution } = loaded;
    const { plan, exploration } = loaded.executionInput;
    if (!this.executionIntegrity.validate(execution)) {
      throw new VerificationIntegrityError(
        'execution.json payload digest does not match its recorded result integrity.',
      );
    }
    if (
      execution.sourceRunId !== exploration.runId ||
      execution.planId !== plan.planId ||
      execution.sourceIntegrity.planDigest !== validatedInput.planDigest ||
      canonicalJson({
        algorithm: execution.sourceIntegrity.algorithm,
        explorationDigest: execution.sourceIntegrity.explorationDigest,
        observationDigest: execution.sourceIntegrity.observationDigest,
        graphDigest: execution.sourceIntegrity.graphDigest,
        stateGraphDigest: execution.sourceIntegrity.stateGraphDigest,
      }) !== canonicalJson(plan.metadata.sourceIntegrity)
    ) {
      throw new VerificationIntegrityError(
        'The source execution is not bound to the validated plan and exploration artifacts.',
      );
    }

    const compiled = this.compiler.compile(plan, exploration, {
      maxScenarios: 50,
      maxStepsPerScenario: 20,
      executionTimeoutMs: 3_600_000,
      stepTimeoutMs: 120_000,
    });
    const planScenarios = new Map(plan.scenarios.map((scenario) => [scenario.id, scenario]));
    const compiledScenarios = new Map(
      compiled.scenarios.map((scenario) => [scenario.scenario.id, scenario]),
    );
    const executionScenarioIds = new Set(execution.scenarios.map((scenario) => scenario.id));
    const planScenarioIds = execution.scenarios.map((scenario) => scenario.planScenarioId);
    if (new Set(planScenarioIds).size !== planScenarioIds.length) {
      throw new VerificationIntegrityError(
        'The source execution contains duplicate results for one plan scenario.',
      );
    }
    const executionStepIds = new Set(
      execution.scenarios.flatMap((scenario) => scenario.steps.map((step) => step.id)),
    );
    const evidenceIds = new Set(execution.evidence.map((entry) => entry.id));
    const knownSourceEvidence = validatedInput.compiledObservation.catalog.evidence;

    for (const scenario of execution.scenarios) {
      const planned = planScenarios.get(scenario.planScenarioId);
      const compiledScenario = compiledScenarios.get(scenario.planScenarioId);
      if (planned === undefined || compiledScenario === undefined) {
        throw new VerificationIntegrityError(
          `Execution scenario ${scenario.id} references an unknown plan scenario.`,
        );
      }
      if (
        scenario.title !== planned.title ||
        scenario.priority !== planned.priority ||
        scenario.plannedExecutability !== planned.executability
      ) {
        throw new VerificationIntegrityError(
          `Execution scenario ${scenario.id} metadata does not match qa-plan.json.`,
        );
      }
      if (scenario.status !== 'SKIPPED' && compiledScenario.skip !== null) {
        throw new VerificationIntegrityError(
          `Execution scenario ${scenario.id} ran despite deterministic compiler rejection.`,
        );
      }
      const statusIsConsistent =
        (scenario.status === 'PASS' &&
          scenario.steps.length > 0 &&
          scenario.steps.every((step) => step.status === 'PASS')) ||
        (scenario.status === 'FAIL' && scenario.steps.some((step) => step.status === 'FAIL')) ||
        (scenario.status === 'BLOCKED' &&
          scenario.steps.some((step) => step.status === 'BLOCKED')) ||
        (scenario.status === 'ERROR' &&
          (scenario.steps.length === 0 ||
            scenario.steps.some((step) => step.status === 'ERROR'))) ||
        (scenario.status === 'SKIPPED' && scenario.steps.length === 0);
      if (
        !statusIsConsistent ||
        (scenario.status !== 'ERROR' &&
          scenario.status !== 'SKIPPED' &&
          scenario.steps.length !== compiledScenario.instructions.length)
      ) {
        throw new VerificationIntegrityError(
          `Execution scenario ${scenario.id} status does not match its step results.`,
        );
      }
      const firstNonPassingStep = scenario.steps.find(
        (step) => !['PASS', 'SKIPPED'].includes(step.status),
      );
      if (
        (scenario.status === 'PASS' && scenario.failureCode !== null) ||
        (scenario.status !== 'PASS' &&
          scenario.status !== 'SKIPPED' &&
          firstNonPassingStep !== undefined &&
          scenario.failureCode !== firstNonPassingStep.failureCode) ||
        scenario.steps.some(
          (step) =>
            (step.status === 'PASS' && step.failureCode !== null) ||
            (!['PASS', 'SKIPPED'].includes(step.status) && step.failureCode === null),
        )
      ) {
        throw new VerificationIntegrityError(
          `Execution scenario ${scenario.id} failure code does not match its first failed step.`,
        );
      }
      const seenStepIds = new Set<string>();
      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index];
        const plannedStep = planned.steps[index];
        const instruction = compiledScenario.instructions[index];
        if (
          step === undefined ||
          plannedStep === undefined ||
          step.index !== index ||
          step.scenarioId !== scenario.id ||
          step.planStepId !== plannedStep.id ||
          step.action !== plannedStep.action ||
          seenStepIds.has(step.id)
        ) {
          throw new VerificationIntegrityError(
            `Execution scenario ${scenario.id} has an inconsistent step sequence.`,
          );
        }
        seenStepIds.add(step.id);
        const requested = {
          pageId: plannedStep.target.pageId ?? null,
          stateId: plannedStep.target.stateId ?? null,
          actionId: plannedStep.target.actionId ?? null,
        };
        if (canonicalJson(step.requestedTarget) !== canonicalJson(requested)) {
          throw new VerificationIntegrityError(
            `Execution step ${step.id} target differs from the validated plan.`,
          );
        }
        if (
          step.transition.actualUrl !== step.actualUrl ||
          step.transition.actualFingerprint !== step.actualFingerprint ||
          (step.status === 'PASS' && !step.transition.match) ||
          (step.status === 'FAIL' && step.transition.match)
        ) {
          throw new VerificationIntegrityError(
            `Execution step ${step.id} assertion result is internally inconsistent.`,
          );
        }
        if (instruction !== undefined) {
          const expectedTransition = {
            plannedSourcePageId: instruction.page.id,
            plannedSourceStateId: instruction.kind === 'CLICK' ? instruction.sourceState.id : null,
            plannedTargetPageId:
              instruction.kind === 'NAVIGATE'
                ? instruction.page.id
                : instruction.targetState.pageId,
            plannedTargetStateId: instruction.kind === 'CLICK' ? instruction.targetState.id : null,
          };
          const actualTransition = {
            plannedSourcePageId: step.transition.plannedSourcePageId,
            plannedSourceStateId: step.transition.plannedSourceStateId,
            plannedTargetPageId: step.transition.plannedTargetPageId,
            plannedTargetStateId: step.transition.plannedTargetStateId,
          };
          if (
            canonicalJson(expectedTransition) !== canonicalJson(actualTransition) ||
            step.expectedFingerprint !==
              (instruction.kind === 'CLICK' ? instruction.targetState.fingerprint : null)
          ) {
            throw new VerificationIntegrityError(
              `Execution step ${step.id} graph transition differs from the source graph.`,
            );
          }
        }
        if (
          !step.evidenceRefs.every((reference) => evidenceIds.has(reference)) ||
          !step.screenshotRefs.every(safeReference)
        ) {
          throw new VerificationIntegrityError(
            `Execution step ${step.id} contains an invalid artifact or evidence reference.`,
          );
        }
      }
      if (!scenario.screenshotRefs.every(safeReference)) {
        throw new VerificationIntegrityError(
          `Execution scenario ${scenario.id} contains an unsafe screenshot reference.`,
        );
      }
      for (const reproduction of scenario.evidenceReproduction) {
        if (
          !knownSourceEvidence.has(reproduction.sourceEvidenceRef) ||
          !reproduction.executionEvidenceRefs.every((reference) => evidenceIds.has(reference))
        ) {
          throw new VerificationIntegrityError(
            `Execution scenario ${scenario.id} contains an invalid evidence reproduction reference.`,
          );
        }
      }
    }

    for (const entry of execution.evidence) {
      if (
        entry.executionId !== execution.executionId ||
        !executionScenarioIds.has(entry.scenarioId) ||
        (entry.stepId !== null && !executionStepIds.has(entry.stepId))
      ) {
        throw new VerificationIntegrityError(
          `Execution evidence ${entry.id} has inconsistent execution attribution.`,
        );
      }
    }
    const summary = expectedSummary(
      execution.scenarios,
      execution.evidence.length,
      execution.summary.limitReached,
    );
    if (canonicalJson(summary) !== canonicalJson(execution.summary)) {
      throw new VerificationIntegrityError(
        'Execution summary does not match its scenario results.',
      );
    }
    return { loaded, executionInput: validatedInput };
  }
}
