import { describe, expect, it } from 'vitest';
import { ExecutionInputValidator } from '../../src/application/execution-validator.js';
import {
  parseSavedQaPlan,
  SavedPlanValidationError,
} from '../../src/application/planning-schema.js';
import type { ProposedTestScenario, QaPlan } from '../../src/domain/planning.js';
import { executionPlanFixture } from '../fixtures/execution-fixtures.js';

function required<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) throw new Error(message);
  return value;
}

function dangerousScenario(): ProposedTestScenario {
  return {
    id: 'scenario-danger',
    title: 'Delete account safety review',
    objective: 'Review the observed destructive boundary manually.',
    priority: 'CRITICAL',
    type: 'NEGATIVE',
    preconditions: [],
    steps: [
      {
        id: 'step-danger',
        action: 'CLICK',
        target: { stateId: 'state-001', candidateId: 'candidate-002' },
        instruction: 'Review Delete account without executing it.',
        expected: 'The action remains blocked.',
      },
    ],
    expectedOutcome: 'No destructive action is executed.',
    sourcePageIds: ['page-001'],
    sourceStateIds: ['state-001'],
    evidenceRefs: [],
    rationale: 'The safety audit classified this control as destructive.',
    confidence: 1,
  };
}

describe('ExecutionInputValidator', () => {
  it('accepts an intact plan, observation, graph, and exploration binding', () => {
    const fixture = executionPlanFixture();
    const result = new ExecutionInputValidator().validate(fixture.loaded);
    expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an altered source run and source integrity metadata', () => {
    const fixture = executionPlanFixture();
    expect(() =>
      new ExecutionInputValidator().validate({
        ...fixture.loaded,
        plan: { ...fixture.plan, sourceRunId: 'different-run' },
      }),
    ).toThrow(/does not match exploration run/);

    const digest = fixture.plan.metadata.sourceIntegrity.explorationDigest;
    expect(() =>
      new ExecutionInputValidator().validate({
        ...fixture.loaded,
        plan: {
          ...fixture.plan,
          metadata: {
            ...fixture.plan.metadata,
            sourceIntegrity: {
              ...fixture.plan.metadata.sourceIntegrity,
              explorationDigest: `${digest.slice(0, -1)}0`,
            },
          },
        },
      }),
    ).toThrow(/integrity digest/);
  });

  it('rejects tampered observation and standalone graphs', () => {
    const fixture = executionPlanFixture();
    expect(() =>
      new ExecutionInputValidator().validate({
        ...fixture.loaded,
        observation: { ...fixture.loaded.observation, summaryInjection: 'tampered' } as never,
      }),
    ).toThrow(/observation\.json does not match/);
    expect(() =>
      new ExecutionInputValidator().validate({
        ...fixture.loaded,
        standaloneGraph: { ...fixture.loaded.standaloneGraph, startUrl: 'http://other.test/' },
      }),
    ).toThrow(/graph\.json does not match/);
  });

  it('recomputes executability so MANUAL_ONLY cannot be changed to AUTOMATABLE', () => {
    const fixture = executionPlanFixture([dangerousScenario()]);
    expect(fixture.plan.scenarios[0]?.executability).toBe('MANUAL_ONLY');
    const tamperedScenario = {
      ...required(fixture.plan.scenarios[0], 'Fixture scenario is missing.'),
      executability: 'AUTOMATABLE' as const,
    };
    expect(() =>
      new ExecutionInputValidator().validate({
        ...fixture.loaded,
        plan: { ...fixture.plan, scenarios: [tamperedScenario] },
      }),
    ).toThrow(/manual safety cannot be overridden/);
  });

  it('rejects unknown graph IDs during fresh grounding validation', () => {
    const fixture = executionPlanFixture();
    const scenario = required(fixture.plan.scenarios[0], 'Fixture scenario is missing.');
    const step = required(scenario.steps[0], 'Fixture step is missing.');
    const tampered: QaPlan = {
      ...fixture.plan,
      scenarios: [
        {
          ...scenario,
          sourcePageIds: ['page-999'],
          steps: [
            {
              ...step,
              target: { pageId: 'page-999' },
            },
          ],
        },
      ],
    };
    expect(() =>
      new ExecutionInputValidator().validate({ ...fixture.loaded, plan: tampered }),
    ).toThrow(/unknown page ID/);
  });

  it.each([
    ['state', { stateId: 'state-999', actionId: 'action-0001' }],
    ['action', { stateId: 'state-001', actionId: 'action-9999' }],
    ['evidence', { evidenceRef: 'evidence-999' }],
  ] as const)('rejects a tampered unknown %s reference', (_kind, target) => {
    const fixture = executionPlanFixture();
    const scenario = required(fixture.plan.scenarios[1], 'Fixture scenario is missing.');
    const step = required(scenario.steps[0], 'Fixture step is missing.');
    const tampered = {
      ...scenario,
      steps: [{ ...step, target }],
    };
    expect(() =>
      new ExecutionInputValidator().validate({
        ...fixture.loaded,
        plan: { ...fixture.plan, scenarios: [tampered] },
      }),
    ).toThrow(/unknown (state|action|evidence) ID/);
  });

  it('does not accept a destructive candidate substituted for a SAFE action edge', () => {
    const fixture = executionPlanFixture();
    const scenario = required(fixture.plan.scenarios[1], 'Fixture scenario is missing.');
    const step = required(scenario.steps[0], 'Fixture step is missing.');
    const tampered = {
      ...scenario,
      steps: [
        {
          ...step,
          target: { stateId: 'state-001', candidateId: 'candidate-002' },
        },
      ],
    };
    expect(() =>
      new ExecutionInputValidator().validate({
        ...fixture.loaded,
        plan: { ...fixture.plan, scenarios: [tampered] },
      }),
    ).toThrow(/manual safety cannot be overridden/);
  });
});

describe('saved plan schema', () => {
  it('requires re-planning for legacy plans without integrity metadata', () => {
    expect(() => parseSavedQaPlan({ schemaVersion: '1.0' })).toThrow(SavedPlanValidationError);
    expect(() => parseSavedQaPlan({ schemaVersion: '1.0' })).toThrow(/run plan again/);
  });

  it('rejects arbitrary URL and selector injection fields', () => {
    const { plan } = executionPlanFixture();
    const raw = structuredClone(plan) as unknown as Record<string, unknown>;
    const scenarios = raw.scenarios as Record<string, unknown>[];
    const steps = scenarios[0]?.steps as Record<string, unknown>[];
    const target = steps[0]?.target as Record<string, unknown>;
    target.url = 'https://evil.invalid/delete';
    target.selector = '#delete';
    expect(() => parseSavedQaPlan(raw)).toThrow(/unrecognized/i);
  });
});
