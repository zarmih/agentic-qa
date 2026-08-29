import type { ExecutionEvidenceEntry } from '../domain/execution.js';
import type { ExplorationResult } from '../domain/exploration.js';
import type { ActionEdge, InteractionCandidate, StateNode } from '../domain/interaction.js';
import type { QaPlan, TestScenario } from '../domain/planning.js';
import type {
  RegressionCandidate,
  RegressionGenerationLimits,
  RegressionStep,
  RegressionTestSpec,
} from '../domain/regression.js';
import type { DefectFinding, VerificationRun } from '../domain/verification.js';
import type { ExecutionRun } from '../domain/execution.js';
import { sha256Digest } from './source-integrity.js';
import {
  ScenarioExecutionCompiler,
  type CompiledExecutionInstruction,
} from './execution-compiler.js';
import { RegressionLocatorCompiler } from './regression-locator-compiler.js';
import { RegressionUrlPolicy } from './regression-url-policy.js';
import { StateAssertionCompiler } from './state-assertion-compiler.js';

export type RegressionEligibility =
  | { readonly kind: 'COMPILE'; readonly mode: 'ACTIVE' | 'FIXME' }
  | { readonly kind: 'REVIEW_ONLY'; readonly reason: string }
  | { readonly kind: 'SKIPPED_VERDICT'; readonly reason: string };

export interface RegressionCompilation {
  readonly candidate: RegressionCandidate | null;
  readonly spec: RegressionTestSpec | null;
  readonly reason: string;
}

export class RegressionEligibilityPolicy {
  public classify(finding: DefectFinding, includeFlaky: boolean): RegressionEligibility {
    if (finding.verdict === 'PROBABLE_DEFECT') {
      return {
        kind: 'REVIEW_ONLY',
        reason: 'Probable findings require human review before an enforcing regression is created.',
      };
    }
    if (finding.verdict === 'FLAKY_DEFECT') {
      return includeFlaky
        ? { kind: 'COMPILE', mode: 'FIXME' }
        : {
            kind: 'SKIPPED_VERDICT',
            reason: 'Flaky findings are omitted unless --include-flaky is explicitly supplied.',
          };
    }
    if (finding.verdict !== 'CONFIRMED_DEFECT') {
      return {
        kind: 'SKIPPED_VERDICT',
        reason: `${finding.verdict} is not eligible for executable regression generation.`,
      };
    }
    if (['CONSOLE_ERROR', 'PAGE_ERROR', 'FAILED_REQUEST'].includes(finding.signature.kind)) {
      return {
        kind: 'REVIEW_ONLY',
        reason:
          'Diagnostic-only findings are review-only without a graph-backed positive assertion.',
      };
    }
    return { kind: 'COMPILE', mode: 'ACTIVE' };
  }
}

function safeTitle(finding: DefectFinding, scenario: TestScenario): string {
  let sanitized = '';
  for (const character of `${finding.id} — ${scenario.title}`) {
    const code = character.codePointAt(0) ?? 0;
    sanitized += code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }
  const value = sanitized.replaceAll(/\s+/g, ' ').trim();
  return value.slice(0, 240);
}

export class RegressionCompiler {
  private readonly execution = new ScenarioExecutionCompiler();
  private readonly locators = new RegressionLocatorCompiler();
  private readonly assertions = new StateAssertionCompiler();

  public compile(input: {
    readonly finding: DefectFinding;
    readonly mode: 'ACTIVE' | 'FIXME';
    readonly verification: VerificationRun;
    readonly plan: QaPlan;
    readonly source: ExplorationResult;
    readonly sourceExecution: ExecutionRun;
    readonly baseUrl?: string;
    readonly limits: RegressionGenerationLimits;
  }): RegressionCompilation {
    const { finding, plan, source, sourceExecution } = input;
    if (!['CONFIRMED_DEFECT', 'FLAKY_DEFECT'].includes(finding.verdict)) {
      return this.unsupported('The finding verdict is not eligible for executable compilation.');
    }
    const scenario = plan.scenarios.find((item) => item.id === finding.scenarioId);
    if (scenario?.executability !== 'AUTOMATABLE') {
      return this.unsupported('The finding does not resolve to an AUTOMATABLE plan scenario.');
    }
    if (finding.stepId === null) {
      return this.unsupported('The finding has no graph-backed plan step.');
    }
    const compiledPlan = this.execution.compile(
      plan,
      source,
      {
        maxScenarios: 50,
        maxStepsPerScenario: 20,
        executionTimeoutMs: 3_600_000,
        stepTimeoutMs: 120_000,
      },
      [scenario.id],
    );
    const compiledScenario = compiledPlan.scenarios.find(
      (item) => item.scenario.id === scenario.id,
    );
    if (compiledScenario?.skip !== null) {
      return this.unsupported(
        compiledScenario?.skip?.reason ??
          'The scenario cannot be compiled by Stage 5 safety rules.',
      );
    }
    const instruction = compiledScenario.instructions.find(
      (item) => item.step.id === finding.stepId,
    );
    if (instruction === undefined) {
      return this.unsupported('The finding step does not resolve to a compiled instruction.');
    }
    const urlPolicy = new RegressionUrlPolicy(source.startUrl, input.baseUrl);
    const built = this.steps(instruction, source, urlPolicy);
    if (built === null) {
      return this.unsupported(
        'The graph transition does not have unique, portable semantic locators.',
      );
    }
    if (built.steps.length > input.limits.maxStepsPerTest) {
      return this.unsupported('The graph replay path exceeds the generated test step limit.');
    }
    const assertions = this.assertionsFor(
      finding,
      instruction,
      source,
      sourceExecution,
      urlPolicy,
      input.limits.maxAssertionsPerTest,
    );
    if (assertions.length === 0) {
      return this.unsupported(
        'The expected graph target has no reliable minimal positive assertion.',
      );
    }
    const expectedTarget =
      instruction.kind === 'NAVIGATE'
        ? { pageId: instruction.page.id, stateId: null }
        : { pageId: instruction.targetState.pageId, stateId: instruction.targetState.id };
    const candidate: RegressionCandidate = {
      findingId: finding.id,
      scenarioId: scenario.id,
      stepId: finding.stepId,
      category: finding.category,
      verdict: finding.verdict,
      severity: finding.severity,
      sourcePageId: instruction.page.id,
      sourceStateId: instruction.kind === 'CLICK' ? instruction.sourceState.id : null,
      expectedTarget,
      actionPath:
        instruction.kind === 'CLICK'
          ? [...instruction.replay.map((item) => item.edge.id), instruction.edge.id]
          : [],
      signatureHash: finding.signature.hash,
    };
    const spec: RegressionTestSpec = {
      schemaVersion: '1.0',
      id: `regression-${finding.id}`,
      findingId: finding.id,
      title: safeTitle(finding, scenario),
      sourceUrl: urlPolicy.apply(source.startUrl),
      scenarioId: scenario.id,
      triggerStepIndex: built.triggerStepIndex,
      steps: built.steps,
      assertions,
      mode: input.mode,
      metadata: {
        verificationId: input.verification.verificationId,
        verdict: finding.verdict as 'CONFIRMED_DEFECT' | 'FLAKY_DEFECT',
        severity: finding.severity,
        signatureHash: finding.signature.hash,
      },
    };
    return { candidate, spec, reason: 'Graph-backed regression compiled.' };
  }

  private steps(
    instruction: CompiledExecutionInstruction,
    source: ExplorationResult,
    urls: RegressionUrlPolicy,
  ): { readonly steps: readonly RegressionStep[]; readonly triggerStepIndex: number } | null {
    if (instruction.kind === 'NAVIGATE') {
      return {
        steps: [
          {
            kind: 'NAVIGATE',
            pageId: instruction.page.id,
            url: urls.apply(instruction.page.finalUrl),
          },
        ],
        triggerStepIndex: 0,
      };
    }
    const steps: RegressionStep[] = [
      { kind: 'NAVIGATE', pageId: instruction.page.id, url: urls.apply(instruction.page.finalUrl) },
    ];
    for (const replay of instruction.replay) {
      const step = this.clickStep(
        replay.edge,
        replay.candidate,
        replay.sourceState,
        replay.targetState,
        source,
      );
      if (step === null) return null;
      steps.push(step);
    }
    const trigger = this.clickStep(
      instruction.edge,
      instruction.candidate,
      instruction.sourceState,
      instruction.targetState,
      source,
    );
    if (trigger === null) return null;
    steps.push(trigger);
    return { steps, triggerStepIndex: steps.length - 1 };
  }

  private clickStep(
    edge: ActionEdge,
    candidate: InteractionCandidate,
    sourceState: StateNode,
    targetState: StateNode,
    source: ExplorationResult,
  ): Extract<RegressionStep, { readonly kind: 'CLICK' }> | null {
    const graph = source.stateGraph;
    if (graph === null || edge.targetStateId !== targetState.id) return null;
    const locator = this.locators.compile(candidate, sourceState.id, graph.safetyAudit);
    if (locator === null) return null;
    return {
      kind: 'CLICK',
      actionId: edge.id,
      sourceStateId: sourceState.id,
      targetStateId: targetState.id,
      locator,
      accessibleName: candidate.accessibleName,
    };
  }

  private assertionsFor(
    finding: DefectFinding,
    instruction: CompiledExecutionInstruction,
    source: ExplorationResult,
    sourceExecution: ExecutionRun,
    urls: RegressionUrlPolicy,
    maximum: number,
  ): RegressionTestSpec['assertions'] {
    if (finding.signature.kind === 'STRUCTURAL_MISMATCH') {
      if (instruction.kind === 'NAVIGATE') {
        return [{ kind: 'URL', url: urls.apply(instruction.page.finalUrl) }];
      }
      const graph = source.stateGraph;
      if (graph === null) return [];
      if (
        finding.category === 'NAVIGATION' &&
        instruction.sourceState.url !== instruction.targetState.url
      ) {
        return [{ kind: 'URL', url: urls.apply(instruction.targetState.url) }];
      }
      return this.assertions
        .compile(instruction.sourceState, instruction.targetState, graph.safetyAudit, maximum)
        .map((assertion) =>
          assertion.kind === 'URL' ? { ...assertion, url: urls.apply(assertion.url) } : assertion,
        );
    }
    if (finding.signature.kind === 'HTTP_SERVER_ERROR') {
      const evidence = this.httpEvidence(finding, sourceExecution);
      if (
        evidence === null ||
        finding.signature.url === null ||
        finding.signature.method === null
      ) {
        return [];
      }
      try {
        const sourceUrl = new URL(finding.signature.url);
        const start = new URL(source.startUrl);
        if (
          sourceUrl.origin !== start.origin ||
          !['fetch', 'xhr', 'document'].includes(evidence.resourceType ?? '') ||
          (finding.signature.status ?? 0) < 500
        ) {
          return [];
        }
        return [
          {
            kind: 'HTTP_NO_SERVER_ERROR',
            method: finding.signature.method,
            url: urls.apply(finding.signature.url),
          },
        ];
      } catch {
        return [];
      }
    }
    return [];
  }

  private httpEvidence(
    finding: DefectFinding,
    execution: ExecutionRun,
  ): ExecutionEvidenceEntry | null {
    const scenario = execution.scenarios.find((item) => item.planScenarioId === finding.scenarioId);
    const step = scenario?.steps.find((item) => item.planStepId === finding.stepId);
    if (step === undefined) return null;
    return (
      execution.evidence.find(
        (entry) =>
          finding.evidence.sourceExecutionEvidenceRefs.includes(entry.id) &&
          entry.stepId === step.id &&
          entry.kind === 'HTTP_ERROR' &&
          entry.method?.toUpperCase() === finding.signature.method &&
          entry.status === finding.signature.status &&
          entry.url === finding.signature.url,
      ) ?? null
    );
  }

  private unsupported(reason: string): RegressionCompilation {
    return { candidate: null, spec: null, reason };
  }
}

export function regressionSpecIdentity(spec: RegressionTestSpec): string {
  return sha256Digest({ steps: spec.steps, assertions: spec.assertions });
}

export class RegressionDuplicateDetector {
  private readonly identities = new Map<string, string>();

  public register(spec: RegressionTestSpec, findingId: string): string | null {
    const identity = regressionSpecIdentity(spec);
    const existing = this.identities.get(identity);
    if (existing !== undefined) return existing;
    this.identities.set(identity, findingId);
    return null;
  }
}
