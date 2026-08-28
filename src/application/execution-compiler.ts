import type { ExecutionFailureCode, ExecutionLimits } from '../domain/execution.js';
import type { ExplorationResult, PageNode } from '../domain/exploration.js';
import {
  actionDescriptor,
  ActionRiskClassifier,
  type ActionEdge,
  type InteractionCandidate,
  type SafetyAuditEntry,
  type StateNode,
} from '../domain/interaction.js';
import type { ProposedTestStep, QaPlan, TestScenario } from '../domain/planning.js';
import { ConservativeNavigationSafetyPolicy, SameOriginScopePolicy } from '../domain/url-policy.js';
import { ExecutionPlanError } from './errors.js';
import type { GraphReplayTransition } from './execution-ports.js';

export interface CompiledNavigateInstruction {
  readonly kind: 'NAVIGATE';
  readonly step: ProposedTestStep;
  readonly page: PageNode;
}

export interface CompiledClickInstruction {
  readonly kind: 'CLICK';
  readonly step: ProposedTestStep;
  readonly page: PageNode;
  readonly sourceState: StateNode;
  readonly targetState: StateNode;
  readonly edge: ActionEdge;
  readonly candidate: InteractionCandidate;
  readonly replay: readonly GraphReplayTransition[];
}

export type CompiledExecutionInstruction = CompiledNavigateInstruction | CompiledClickInstruction;

export interface CompiledExecutionScenario {
  readonly scenario: TestScenario;
  readonly originalIndex: number;
  readonly instructions: readonly CompiledExecutionInstruction[];
  readonly skip: { readonly code: ExecutionFailureCode; readonly reason: string } | null;
}

export interface CompiledExecutionPlan {
  readonly scenarios: readonly CompiledExecutionScenario[];
  readonly limitReached: readonly string[];
}

const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

function sameDescriptor(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ScenarioExecutionCompiler {
  private readonly classifier = new ActionRiskClassifier();

  public compile(
    plan: QaPlan,
    source: ExplorationResult,
    limits: ExecutionLimits,
  ): CompiledExecutionPlan {
    const pages = new Map(source.graph.nodes.map((page) => [page.id, page]));
    const graph = source.stateGraph;
    if (!graph?.enabled) {
      throw new ExecutionPlanError(
        'The source exploration has no interactive state graph. Re-run explore with --interactive.',
      );
    }
    const states = new Map(graph.nodes.map((state) => [state.id, state]));
    const actions = new Map(graph.edges.map((edge) => [edge.id, edge]));
    const auditsByAction = new Map<string, SafetyAuditEntry[]>();
    for (const audit of graph.safetyAudit) {
      if (audit.actionId === null) continue;
      const values = auditsByAction.get(audit.actionId) ?? [];
      values.push(audit);
      auditsByAction.set(audit.actionId, values);
    }
    const scope = new SameOriginScopePolicy(source.startUrl);
    const navigationSafety = new ConservativeNavigationSafetyPolicy();

    const automatable = plan.scenarios
      .map((scenario, originalIndex) => ({ scenario, originalIndex }))
      .filter(({ scenario }) => scenario.executability === 'AUTOMATABLE')
      .sort(
        (left, right) =>
          PRIORITY_RANK[left.scenario.priority] - PRIORITY_RANK[right.scenario.priority] ||
          left.originalIndex - right.originalIndex,
      );
    const selectedIds = new Set(
      automatable.slice(0, limits.maxScenarios).map(({ scenario }) => scenario.id),
    );
    const limitReached = automatable.length > limits.maxScenarios ? ['maxScenarios'] : [];

    const compiled = plan.scenarios.map((scenario, originalIndex): CompiledExecutionScenario => {
      if (scenario.executability === 'MANUAL_ONLY') {
        return this.skipped(
          scenario,
          originalIndex,
          'MANUAL_ONLY',
          'Manual-only scenarios are never executed.',
        );
      }
      if (scenario.executability === 'UNSUPPORTED') {
        return this.skipped(
          scenario,
          originalIndex,
          'UNSUPPORTED_SCENARIO',
          'The scenario was classified as unsupported during planning.',
        );
      }
      if (!selectedIds.has(scenario.id)) {
        return this.skipped(
          scenario,
          originalIndex,
          'SCENARIO_LIMIT',
          'The scenario was skipped by the deterministic execution scenario limit.',
        );
      }
      if (scenario.steps.length > limits.maxStepsPerScenario) {
        return this.skipped(
          scenario,
          originalIndex,
          'STEP_LIMIT',
          'The scenario exceeds the configured maximum steps per scenario.',
        );
      }
      if (scenario.steps.some((step) => step.action !== 'NAVIGATE' && step.action !== 'CLICK')) {
        return this.skipped(
          scenario,
          originalIndex,
          'UNSUPPORTED_ACTION',
          'Stage 5 executes only graph-backed NAVIGATE and CLICK steps.',
        );
      }

      const instructions: CompiledExecutionInstruction[] = [];
      let currentPageId: string | null = null;
      let currentStateId: string | null = null;
      let sequenceStarted = false;
      for (const step of scenario.steps) {
        if (step.action === 'NAVIGATE') {
          const pageId = step.target.pageId;
          const page = pageId === undefined ? undefined : pages.get(pageId);
          if (page?.state !== 'visited') {
            return this.skipped(
              scenario,
              originalIndex,
              'INVALID_SEQUENCE',
              `NAVIGATE step ${step.id} does not resolve to a visited source page.`,
            );
          }
          if (
            scope.classify(page.finalUrl) !== 'internal' ||
            !navigationSafety.allows(page.finalUrl)
          ) {
            return this.skipped(
              scenario,
              originalIndex,
              'OUT_OF_SCOPE',
              `NAVIGATE step ${step.id} is outside the source navigation policy.`,
            );
          }
          instructions.push({ kind: 'NAVIGATE', step, page });
          currentPageId = page.id;
          const defaults = graph.nodes.filter(
            (state) => state.pageId === page.id && state.depth === 0,
          );
          currentStateId = defaults.length === 1 ? (defaults[0]?.id ?? null) : null;
          sequenceStarted = true;
          continue;
        }

        const actionId = step.target.actionId;
        if (actionId === undefined || step.target.candidateId !== undefined) {
          return this.skipped(
            scenario,
            originalIndex,
            'UNSUPPORTED_ACTION',
            `CLICK step ${step.id} must reference one observed actionId and no candidate-only target.`,
          );
        }
        const edge = actions.get(actionId);
        const sourceState = edge === undefined ? undefined : states.get(edge.sourceStateId);
        const targetState =
          edge?.targetStateId === null || edge?.targetStateId === undefined
            ? undefined
            : states.get(edge.targetStateId);
        if (edge === undefined || sourceState === undefined || targetState === undefined) {
          return this.skipped(
            scenario,
            originalIndex,
            'INVALID_SEQUENCE',
            `CLICK step ${step.id} does not resolve to a completed graph transition.`,
          );
        }
        if (
          (sequenceStarted && currentStateId === null) ||
          (currentStateId !== null && currentStateId !== sourceState.id) ||
          (currentPageId !== null && currentPageId !== sourceState.pageId)
        ) {
          return this.skipped(
            scenario,
            originalIndex,
            'INVALID_SEQUENCE',
            `CLICK step ${step.id} starts at ${sourceState.id}, which does not follow the preceding graph target.`,
          );
        }
        const page = pages.get(sourceState.pageId);
        const audits = auditsByAction.get(edge.id) ?? [];
        const audit = audits.length === 1 ? audits[0] : undefined;
        if (page === undefined || audit === undefined) {
          return this.skipped(
            scenario,
            originalIndex,
            'INVALID_SEQUENCE',
            `CLICK step ${step.id} has no unique executed safety-audit source candidate.`,
          );
        }
        let sourceTargetAllowed = true;
        if (audit.candidate.href !== null) {
          try {
            const target = new URL(audit.candidate.href, sourceState.url).href;
            sourceTargetAllowed =
              scope.classify(target) === 'internal' && navigationSafety.allows(target);
          } catch {
            sourceTargetAllowed = false;
          }
        }
        if (!this.graphActionIsSafe(edge, audit) || !sourceTargetAllowed) {
          return this.skipped(
            scenario,
            originalIndex,
            'ACTION_NOT_SAFE',
            `CLICK step ${step.id} failed deterministic source safety validation.`,
          );
        }
        let replay: readonly GraphReplayTransition[];
        try {
          replay = this.replayFor(sourceState, states, actions, auditsByAction);
        } catch (error) {
          return this.skipped(
            scenario,
            originalIndex,
            'INVALID_SEQUENCE',
            error instanceof Error ? error.message : 'The stored replay path is invalid.',
          );
        }
        instructions.push({
          kind: 'CLICK',
          step,
          page,
          sourceState,
          targetState,
          edge,
          candidate: audit.candidate,
          replay,
        });
        currentPageId = targetState.pageId;
        currentStateId = targetState.id;
        sequenceStarted = true;
      }
      return { scenario, originalIndex, instructions, skip: null };
    });
    const executionOrder = [...compiled].sort((left, right) => {
      const leftSelected = left.skip === null;
      const rightSelected = right.skip === null;
      if (leftSelected && rightSelected) {
        return (
          PRIORITY_RANK[left.scenario.priority] - PRIORITY_RANK[right.scenario.priority] ||
          left.originalIndex - right.originalIndex
        );
      }
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      return left.originalIndex - right.originalIndex;
    });
    return { scenarios: executionOrder, limitReached };
  }

  private skipped(
    scenario: TestScenario,
    originalIndex: number,
    code: ExecutionFailureCode,
    reason: string,
  ): CompiledExecutionScenario {
    return { scenario, originalIndex, instructions: [], skip: { code, reason } };
  }

  private graphActionIsSafe(edge: ActionEdge, audit: SafetyAuditEntry): boolean {
    const descriptor = actionDescriptor(audit.candidate);
    return (
      audit.executed &&
      audit.classification === 'SAFE' &&
      audit.stateId === edge.sourceStateId &&
      !audit.candidate.submitsForm &&
      !audit.candidate.fileUpload &&
      audit.candidate.elementType !== 'reset' &&
      this.classifier.classify(audit.candidate).risk === 'SAFE' &&
      descriptor !== null &&
      sameDescriptor(descriptor, edge.action)
    );
  }

  private replayFor(
    sourceState: StateNode,
    states: ReadonlyMap<string, StateNode>,
    actions: ReadonlyMap<string, ActionEdge>,
    auditsByAction: ReadonlyMap<string, readonly SafetyAuditEntry[]>,
  ): readonly GraphReplayTransition[] {
    const reversed: GraphReplayTransition[] = [];
    const seen = new Set<string>();
    let current = sourceState;
    while (current.discoveredFromActionId !== null) {
      if (seen.has(current.id)) throw new Error('The stored state replay path contains a cycle.');
      seen.add(current.id);
      const edge = actions.get(current.discoveredFromActionId);
      const prior = edge === undefined ? undefined : states.get(edge.sourceStateId);
      const audits = edge === undefined ? [] : (auditsByAction.get(edge.id) ?? []);
      const audit = audits.length === 1 ? audits[0] : undefined;
      if (
        edge === undefined ||
        prior === undefined ||
        audit === undefined ||
        edge.targetStateId !== current.id ||
        !this.graphActionIsSafe(edge, audit)
      ) {
        throw new Error(`State ${sourceState.id} has an inconsistent replay chain.`);
      }
      reversed.push({ edge, sourceState: prior, targetState: current, candidate: audit.candidate });
      current = prior;
    }
    const replay = reversed.reverse();
    if (
      current.depth !== 0 ||
      replay.length !== sourceState.actionPath.length ||
      replay.some((item, index) => !sameDescriptor(item.edge.action, sourceState.actionPath[index]))
    ) {
      throw new Error(`State ${sourceState.id} has an inconsistent semantic action path.`);
    }
    return replay;
  }
}
