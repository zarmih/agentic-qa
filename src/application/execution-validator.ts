import type { ExplorationResult } from '../domain/exploration.js';
import type { ProposedQaPlan, QaPlan } from '../domain/planning.js';
import { ConservativeNavigationSafetyPolicy, SameOriginScopePolicy } from '../domain/url-policy.js';
import { ExecutionIntegrityError, ExecutionPlanError } from './errors.js';
import type { LoadedExecutionArtifacts } from './execution-ports.js';
import { PlanningGroundingValidator } from './planning-grounding-validator.js';
import {
  PlanningObservationCompiler,
  type CompiledPlanningObservation,
} from './planning-observation-compiler.js';
import { PlanningExecutabilityPolicy } from './planning-safety-policy.js';
import { canonicalJson, SourceIntegrityService } from './source-integrity.js';

export interface ValidatedExecutionInput {
  readonly loaded: LoadedExecutionArtifacts;
  readonly compiledObservation: CompiledPlanningObservation;
  readonly planDigest: string;
}

function proposalFrom(plan: QaPlan): ProposedQaPlan {
  return {
    schemaVersion: '1.0',
    summary: plan.summary,
    scenarios: plan.scenarios,
    risks: plan.risks,
    uncoveredAreas: plan.uncoveredAreas,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function duplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

export class ExecutionInputValidator {
  private readonly observationCompiler = new PlanningObservationCompiler();
  private readonly grounding = new PlanningGroundingValidator();
  private readonly executability = new PlanningExecutabilityPolicy();
  private readonly integrity = new SourceIntegrityService();

  public validate(loaded: LoadedExecutionArtifacts): ValidatedExecutionInput {
    const { plan, exploration } = loaded;
    if (plan.sourceRunId !== exploration.runId) {
      throw new ExecutionPlanError(
        `Plan sourceRunId "${plan.sourceRunId}" does not match exploration run "${exploration.runId}".`,
      );
    }
    if (loaded.observation.source.runId !== exploration.runId) {
      throw new ExecutionIntegrityError('The planning observation belongs to a different run.');
    }
    if (!exploration.stateGraph?.enabled) {
      throw new ExecutionPlanError(
        'Execution requires an interactive exploration with a state graph. Re-run explore --interactive and plan again.',
      );
    }
    if (canonicalJson(loaded.standaloneGraph) !== canonicalJson(exploration.graph)) {
      throw new ExecutionIntegrityError(
        'graph.json does not match the graph embedded in exploration.json.',
      );
    }
    if (canonicalJson(loaded.standaloneStateGraph) !== canonicalJson(exploration.stateGraph)) {
      throw new ExecutionIntegrityError(
        'state-graph.json does not match the state graph embedded in exploration.json.',
      );
    }

    this.validateGraph(exploration);
    const compiledObservation = this.observationCompiler.compile(exploration);
    if (canonicalJson(loaded.observation) !== canonicalJson(compiledObservation.observation)) {
      throw new ExecutionIntegrityError(
        'observation.json does not match the deterministic observation compiled from exploration.json. Re-run plan.',
      );
    }
    const actualIntegrity = this.integrity.create(exploration, compiledObservation.observation);
    if (canonicalJson(actualIntegrity) !== canonicalJson(plan.metadata.sourceIntegrity)) {
      throw new ExecutionIntegrityError(
        'The plan source integrity digest does not match its exploration and observation artifacts. Re-run plan.',
      );
    }

    const proposal = proposalFrom(plan);
    this.grounding.validate(proposal, compiledObservation.catalog);
    for (const scenario of plan.scenarios) {
      const expected = this.executability.apply(scenario, compiledObservation.catalog);
      if (
        scenario.executability !== expected.executability ||
        !sameStrings(scenario.safetyNotes, expected.safetyNotes)
      ) {
        throw new ExecutionPlanError(
          `Scenario "${scenario.id}" executability or safety metadata was modified. Re-run plan; manual safety cannot be overridden.`,
        );
      }
    }
    return { loaded, compiledObservation, planDigest: this.integrity.planDigest(plan) };
  }

  private validateGraph(source: ExplorationResult): void {
    const graph = source.stateGraph;
    if (graph === null) return;
    const pageIds = source.graph.nodes.map((node) => node.id);
    const stateIds = graph.nodes.map((node) => node.id);
    const actionIds = graph.edges.map((edge) => edge.id);
    const duplicatedPage = duplicate(pageIds);
    const duplicatedState = duplicate(stateIds);
    const duplicatedAction = duplicate(actionIds);
    if (duplicatedPage !== null || duplicatedState !== null || duplicatedAction !== null) {
      throw new ExecutionPlanError(
        `The source graph contains a duplicate identifier: ${duplicatedPage ?? duplicatedState ?? duplicatedAction ?? 'unknown'}.`,
      );
    }
    const pages = new Set(pageIds);
    const states = new Set(stateIds);
    const scope = new SameOriginScopePolicy(source.startUrl);
    const safety = new ConservativeNavigationSafetyPolicy();
    for (const page of source.graph.nodes) {
      const internal = (() => {
        try {
          return scope.classify(page.finalUrl) === 'internal' && safety.allows(page.finalUrl);
        } catch {
          return false;
        }
      })();
      if (!internal) {
        throw new ExecutionPlanError(`Page ${page.id} has a URL outside the source safety policy.`);
      }
    }
    for (const state of graph.nodes) {
      if (!pages.has(state.pageId)) {
        throw new ExecutionPlanError(`State ${state.id} references unknown page ${state.pageId}.`);
      }
      if (state.actionPath.length !== state.depth) {
        throw new ExecutionPlanError(`State ${state.id} has an inconsistent replay depth.`);
      }
    }
    for (const edge of graph.edges) {
      if (!states.has(edge.sourceStateId)) {
        throw new ExecutionPlanError(
          `Action ${edge.id} references unknown source state ${edge.sourceStateId}.`,
        );
      }
      if (edge.targetStateId !== null && !states.has(edge.targetStateId)) {
        throw new ExecutionPlanError(
          `Action ${edge.id} references unknown target state ${edge.targetStateId}.`,
        );
      }
    }
  }
}
