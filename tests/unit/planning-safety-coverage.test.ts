import { describe, expect, it } from 'vitest';
import { PlanningCoverageAnalyzer } from '../../src/application/planning-coverage-analyzer.js';
import { PlanningObservationCompiler } from '../../src/application/planning-observation-compiler.js';
import {
  PlanningExecutabilityPolicy,
  PlanningScenarioDeduplicator,
} from '../../src/application/planning-safety-policy.js';
import type { ProposedTestScenario } from '../../src/domain/planning.js';
import { planningExplorationFixture, validPlanProposal } from '../fixtures/planning-fixtures.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture value is required.');
  return value;
}

function catalog() {
  return new PlanningObservationCompiler().compile(planningExplorationFixture()).catalog;
}

describe('planning safety and coverage', () => {
  const policy = new PlanningExecutabilityPolicy();

  it.each(['Delete account', 'Buy now', 'Checkout', 'Publish release', 'Logout user'])(
    'never marks destructive idea "%s" automatable',
    (title) => {
      const scenario: ProposedTestScenario = {
        ...required(validPlanProposal().scenarios[0]),
        title,
      };
      expect(policy.apply(scenario, catalog())).toMatchObject({
        executability: 'MANUAL_ONLY',
      });
    },
  );

  it('turns a destructive observed candidate click into a manual-only recommendation', () => {
    const base = required(validPlanProposal().scenarios[0]);
    const scenario: ProposedTestScenario = {
      ...base,
      id: 'scenario-delete',
      title: 'Delete account boundary',
      steps: [
        {
          id: 'step-delete',
          action: 'CLICK',
          target: { stateId: 'state-001', candidateId: 'candidate-002' },
          instruction: 'Exercise the observed candidate in an isolated manual environment.',
          expected: 'Deletion requires explicit confirmation.',
        },
      ],
      sourceStateIds: ['state-001'],
    };
    const result = policy.apply(scenario, catalog());
    expect(result.executability).toBe('MANUAL_ONLY');
    expect(result.safetyNotes.join(' ')).toContain('DESTRUCTIVE');
  });

  it('keeps a grounded observed SAFE action automatable', () => {
    const scenario = required(validPlanProposal().scenarios[1]);
    expect(policy.apply(scenario, catalog()).executability).toBe('AUTOMATABLE');
  });

  it('removes only structurally duplicate scenarios', () => {
    const first = required(validPlanProposal().scenarios[0]);
    const duplicate = { ...first, id: 'scenario-copy' };
    const distinct = {
      ...first,
      id: 'scenario-distinct',
      steps: [{ ...required(first.steps[0]), target: { pageId: 'page-002' } }],
      sourcePageIds: ['page-002'],
    };
    const result = new PlanningScenarioDeduplicator().deduplicate([first, duplicate, distinct]);
    expect(result.scenarios.map((scenario) => scenario.id)).toEqual([
      'scenario-001',
      'scenario-distinct',
    ]);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it('computes coverage and warns about uncovered critical observations', () => {
    const sourceCatalog = catalog();
    const scenarios = validPlanProposal().scenarios.map((scenario) =>
      policy.apply(scenario, sourceCatalog),
    );
    const result = new PlanningCoverageAnalyzer().analyze(scenarios, sourceCatalog, 0);
    expect(result.coverage).toMatchObject({
      pages: { covered: 1, total: 2 },
      states: { covered: 2, total: 2 },
      safeTransitions: { covered: 1, total: 1 },
      evidenceLocations: { covered: 1, total: 4 },
      errorBearingStates: { covered: 1, total: 1 },
    });
    expect(result.warnings).toContain('Critical or failed page page-002 is not covered.');
    expect(result.uncoveredAreas).toContain('Evidence http-error-001 (HTTP_5XX)');
  });
});
