import { describe, expect, it } from 'vitest';
import { PlanGroundingInvalidError } from '../../src/application/errors.js';
import { PlanningGroundingValidator } from '../../src/application/planning-grounding-validator.js';
import { PlanningObservationCompiler } from '../../src/application/planning-observation-compiler.js';
import type { ProposedQaPlan } from '../../src/domain/planning.js';
import { planningExplorationFixture, validPlanProposal } from '../fixtures/planning-fixtures.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture value is required.');
  return value;
}

function validate(plan: ProposedQaPlan): void {
  const catalog = new PlanningObservationCompiler().compile(planningExplorationFixture()).catalog;
  new PlanningGroundingValidator().validate(plan, catalog);
}

function changedPlan(change: (plan: ProposedQaPlan) => ProposedQaPlan): ProposedQaPlan {
  return change(structuredClone(validPlanProposal()));
}

describe('PlanningGroundingValidator', () => {
  it('accepts valid page, state, action, and evidence references', () => {
    expect(() => {
      validate(validPlanProposal());
    }).not.toThrow();
  });

  it('rejects an unknown page reference', () => {
    const plan = changedPlan((value) => ({
      ...value,
      scenarios: [
        { ...required(value.scenarios[0]), sourcePageIds: ['page-999'] },
        ...value.scenarios.slice(1),
      ],
    }));
    expect(() => {
      validate(plan);
    }).toThrow(PlanGroundingInvalidError);
  });

  it('rejects an unknown state reference', () => {
    const plan = changedPlan((value) => ({
      ...value,
      scenarios: [
        required(value.scenarios[0]),
        { ...required(value.scenarios[1]), sourceStateIds: ['state-777'] },
      ],
    }));
    expect(() => {
      validate(plan);
    }).toThrow(/unknown state ID "state-777"/);
  });

  it('rejects an unknown action reference', () => {
    const plan = changedPlan((value) => {
      const scenario = required(value.scenarios[1]);
      return {
        ...value,
        scenarios: [
          required(value.scenarios[0]),
          {
            ...scenario,
            steps: [
              {
                ...required(scenario.steps[0]),
                target: { stateId: 'state-001', actionId: 'action-999' },
              },
              ...scenario.steps.slice(1),
            ],
          },
        ],
      };
    });
    expect(() => {
      validate(plan);
    }).toThrow(/unknown action ID "action-999"/);
  });

  it('rejects an unknown evidence reference', () => {
    const plan = changedPlan((value) => ({
      ...value,
      risks: [{ ...required(value.risks[0]), evidenceRefs: ['http-error-999'] }],
    }));
    expect(() => {
      validate(plan);
    }).toThrow(/unknown evidence ID "http-error-999"/);
  });
});
