import { describe, expect, it } from 'vitest';
import { ScenarioExecutionCompiler } from '../../src/application/execution-compiler.js';
import type { ExecutionLimits } from '../../src/domain/execution.js';
import type { ProposedTestScenario } from '../../src/domain/planning.js';
import {
  clickScenario,
  executionPlanFixture,
  navigationScenario,
} from '../fixtures/execution-fixtures.js';

const limits: ExecutionLimits = {
  maxScenarios: 20,
  maxStepsPerScenario: 10,
  executionTimeoutMs: 60_000,
  stepTimeoutMs: 3_000,
};

describe('ScenarioExecutionCompiler', () => {
  it('compiles only graph-derived URLs, actions, candidates, and replay paths', () => {
    const fixture = executionPlanFixture();
    const result = new ScenarioExecutionCompiler().compile(
      fixture.plan,
      fixture.loaded.exploration,
      limits,
    );

    expect(result.scenarios[0]?.instructions[0]).toMatchObject({
      kind: 'NAVIGATE',
      page: { id: 'page-001', finalUrl: 'http://fixture.test/' },
    });
    expect(result.scenarios[1]?.instructions[0]).toMatchObject({
      kind: 'CLICK',
      edge: { id: 'action-0001', risk: 'SAFE' },
      candidate: { accessibleName: 'Help' },
      sourceState: { id: 'state-001' },
      targetState: { id: 'state-002' },
      replay: [],
    });
  });

  it('rejects an unsupported action without partially compiling the scenario', () => {
    const unsupported: ProposedTestScenario = {
      ...navigationScenario('scenario-unsupported'),
      steps: [
        {
          id: 'step-observe',
          action: 'OBSERVE',
          target: { pageId: 'page-001' },
          instruction: 'Observe the page.',
          expected: 'The page remains visible.',
        },
      ],
    };
    const fixture = executionPlanFixture([unsupported]);
    const result = new ScenarioExecutionCompiler().compile(
      fixture.plan,
      fixture.loaded.exploration,
      limits,
    );
    expect(result.scenarios[0]).toMatchObject({
      instructions: [],
      skip: { code: 'UNSUPPORTED_ACTION' },
    });
  });

  it('rejects a disconnected multi-step action sequence', () => {
    const first = clickScenario('scenario-disconnected');
    const firstStep = first.steps[0];
    if (firstStep === undefined) throw new Error('Fixture click step is missing.');
    const disconnected: ProposedTestScenario = {
      ...first,
      steps: [firstStep, { ...firstStep, id: 'step-click-again' }],
    };
    const fixture = executionPlanFixture([disconnected]);
    const result = new ScenarioExecutionCompiler().compile(
      fixture.plan,
      fixture.loaded.exploration,
      limits,
    );
    expect(result.scenarios[0]?.skip).toMatchObject({ code: 'INVALID_SEQUENCE' });
  });

  it('selects a deterministic priority-ordered subset at maxScenarios', () => {
    const low = { ...navigationScenario('scenario-low'), priority: 'LOW' as const };
    const high = { ...navigationScenario('scenario-high'), priority: 'HIGH' as const };
    const critical = navigationScenario('scenario-critical');
    const fixture = executionPlanFixture([low, high, critical]);
    const result = new ScenarioExecutionCompiler().compile(
      fixture.plan,
      fixture.loaded.exploration,
      { ...limits, maxScenarios: 2 },
    );
    expect(result.limitReached).toEqual(['maxScenarios']);
    expect(
      result.scenarios.find((item) => item.scenario.id === 'scenario-low')?.skip,
    ).toMatchObject({
      code: 'SCENARIO_LIMIT',
    });
    expect(result.scenarios.find((item) => item.scenario.id === 'scenario-high')?.skip).toBeNull();
    expect(
      result.scenarios.find((item) => item.scenario.id === 'scenario-critical')?.skip,
    ).toBeNull();
    expect(
      result.scenarios.filter((item) => item.skip === null).map((item) => item.scenario.id),
    ).toEqual(['scenario-critical', 'scenario-high']);
  });

  it('applies the hard step cap before browser instructions are emitted', () => {
    const fixture = executionPlanFixture();
    const result = new ScenarioExecutionCompiler().compile(
      fixture.plan,
      fixture.loaded.exploration,
      { ...limits, maxStepsPerScenario: 0 },
    );
    expect(result.scenarios.every((item) => item.skip?.code === 'STEP_LIMIT')).toBe(true);
  });

  it('compiles only explicitly selected grounded scenarios for verification reruns', () => {
    const fixture = executionPlanFixture([
      navigationScenario('scenario-one'),
      clickScenario('scenario-two'),
    ]);
    const result = new ScenarioExecutionCompiler().compile(
      fixture.plan,
      fixture.loaded.exploration,
      limits,
      ['scenario-two'],
    );
    expect(result.scenarios.map((item) => item.scenario.id)).toEqual(['scenario-two']);
    expect(() =>
      new ScenarioExecutionCompiler().compile(fixture.plan, fixture.loaded.exploration, limits, [
        'scenario-forged',
      ]),
    ).toThrow(/does not exist in the plan/);
  });

  it('refuses a source edge whose audited candidate semantics became destructive', () => {
    const fixture = executionPlanFixture([clickScenario()]);
    const source = fixture.loaded.exploration;
    const stateGraph = source.stateGraph;
    if (stateGraph === null) throw new Error('Fixture state graph is missing.');
    const changedAudit = stateGraph.safetyAudit.map((entry) =>
      entry.actionId === 'action-0001'
        ? {
            ...entry,
            candidate: {
              ...entry.candidate,
              accessibleName: 'Delete account',
              text: 'Delete account',
            },
          }
        : entry,
    );
    const changedSource = {
      ...source,
      stateGraph: { ...stateGraph, safetyAudit: changedAudit },
    };
    const result = new ScenarioExecutionCompiler().compile(fixture.plan, changedSource, limits);
    expect(result.scenarios[0]?.skip).toMatchObject({ code: 'ACTION_NOT_SAFE' });
  });
});
