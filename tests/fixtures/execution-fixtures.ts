import { PlanningCoverageAnalyzer } from '../../src/application/planning-coverage-analyzer.js';
import { PlanningObservationCompiler } from '../../src/application/planning-observation-compiler.js';
import { PlanningExecutabilityPolicy } from '../../src/application/planning-safety-policy.js';
import { SourceIntegrityService } from '../../src/application/source-integrity.js';
import type { LoadedExecutionArtifacts } from '../../src/application/execution-ports.js';
import type { ExplorationResult } from '../../src/domain/exploration.js';
import type { ProposedTestScenario, QaPlan, TestScenario } from '../../src/domain/planning.js';
import { planningExplorationFixture } from './planning-fixtures.js';

export function navigationScenario(
  id = 'scenario-navigation',
  pageId = 'page-001',
): ProposedTestScenario {
  return {
    id,
    title: 'Navigate to an observed page',
    objective: 'Verify the graph-backed page remains reachable.',
    priority: 'CRITICAL',
    type: 'NAVIGATION',
    preconditions: [],
    steps: [
      {
        id: 'step-navigation',
        action: 'NAVIGATE',
        target: { pageId },
        instruction: 'Navigate using the observed page reference.',
        expected: 'The observed canonical URL is reached.',
      },
    ],
    expectedOutcome: 'Navigation matches the page graph.',
    sourcePageIds: [pageId],
    sourceStateIds: [],
    evidenceRefs: [],
    rationale: 'Navigation smoke coverage is deterministic.',
    confidence: 0.95,
  };
}

export function clickScenario(id = 'scenario-click'): ProposedTestScenario {
  return {
    id,
    title: 'Open observed Help state',
    objective: 'Verify the observed safe Help transition.',
    priority: 'HIGH',
    type: 'UI_STATE',
    preconditions: [],
    steps: [
      {
        id: 'step-click',
        action: 'CLICK',
        target: { stateId: 'state-001', actionId: 'action-0001' },
        instruction: 'Replay the observed Help action.',
        expected: 'The observed Help state is reached.',
      },
    ],
    expectedOutcome: 'The graph target is reproduced.',
    sourcePageIds: ['page-001'],
    sourceStateIds: ['state-001', 'state-002'],
    evidenceRefs: ['action-0001-console-error-001'],
    rationale: 'The transition is grounded in Stage 3 evidence.',
    confidence: 0.95,
  };
}

export function executionPlanFixture(
  scenarios: readonly ProposedTestScenario[] = [navigationScenario(), clickScenario()],
  source: ExplorationResult = planningExplorationFixture(),
): { readonly plan: QaPlan; readonly loaded: LoadedExecutionArtifacts } {
  const compiled = new PlanningObservationCompiler().compile(source);
  const stateGraph = source.stateGraph;
  if (stateGraph === null) throw new Error('Execution fixture requires a state graph.');
  const policy = new PlanningExecutabilityPolicy();
  const finalScenarios: readonly TestScenario[] = scenarios.map((scenario) =>
    policy.apply(scenario, compiled.catalog),
  );
  const coverage = new PlanningCoverageAnalyzer().analyze(finalScenarios, compiled.catalog, 0);
  const integrity = new SourceIntegrityService().create(source, compiled.observation);
  const plan: QaPlan = {
    schemaVersion: '1.1',
    planId: 'plan-execution-fixture',
    sourceRunId: source.runId,
    generatedAt: '2026-08-28T00:00:00.000Z',
    summary: 'Execution fixture plan.',
    scenarios: finalScenarios,
    coverage: coverage.coverage,
    risks: [],
    uncoveredAreas: coverage.uncoveredAreas,
    warnings: coverage.warnings,
    metadata: {
      provider: 'openai-compatible',
      model: 'fixture-model',
      requestDurationMs: 10,
      repairAttempts: 0,
      inputTruncation: compiled.observation.truncation,
      usage: null,
      duplicateScenariosRemoved: 0,
      sourceIntegrity: integrity,
    },
  };
  return {
    plan,
    loaded: {
      plan,
      exploration: source,
      observation: compiled.observation,
      standaloneGraph: source.graph,
      standaloneStateGraph: stateGraph,
      planFile: '/fixture/planning/qa-plan.json',
      explorationFile: '/fixture/exploration.json',
      runDirectory: '/fixture',
    },
  };
}
