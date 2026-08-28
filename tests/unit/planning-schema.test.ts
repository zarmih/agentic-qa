import { describe, expect, it } from 'vitest';
import {
  parsePlanningResponse,
  PlanningSchemaValidationError,
} from '../../src/application/planning-schema.js';
import { validPlanProposal } from '../fixtures/planning-fixtures.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture value is required.');
  return value;
}

describe('planning response schema', () => {
  it('accepts a bounded structured plan', () => {
    expect(parsePlanningResponse(JSON.stringify(validPlanProposal()))).toEqual(validPlanProposal());
  });

  it('rejects invalid JSON and free-form markdown', () => {
    expect(() => parsePlanningResponse('# QA Plan')).toThrow(PlanningSchemaValidationError);
  });

  it('rejects missing fields, invalid enums, and extra fields', () => {
    const plan = structuredClone(validPlanProposal()) as unknown as Record<string, unknown>;
    const scenarios = plan.scenarios as Record<string, unknown>[];
    scenarios[0] = { ...scenarios[0], priority: 'URGENT', selector: '#invented' };
    expect(() => parsePlanningResponse(JSON.stringify(plan))).toThrow(/invalid/i);
  });

  it('rejects excessive strings, scenarios, and steps', () => {
    const plan = validPlanProposal();
    const tooManyScenarios = {
      ...plan,
      scenarios: Array.from({ length: 51 }, (_, index) => ({
        ...required(plan.scenarios[0]),
        id: `scenario-${String(index)}`,
      })),
    };
    expect(() => parsePlanningResponse(JSON.stringify(tooManyScenarios))).toThrow(
      PlanningSchemaValidationError,
    );
    expect(() =>
      parsePlanningResponse(JSON.stringify({ ...plan, summary: 'x'.repeat(2_001) })),
    ).toThrow(PlanningSchemaValidationError);
  });

  it('requires structurally grounded click and navigation targets', () => {
    const plan = validPlanProposal();
    const scenario = required(plan.scenarios[0]);
    const invalid = {
      ...plan,
      scenarios: [
        {
          ...scenario,
          steps: [
            {
              ...required(scenario.steps[0]),
              action: 'CLICK',
              target: { pageId: 'page-001' },
            },
          ],
        },
      ],
    };
    expect(() => parsePlanningResponse(JSON.stringify(invalid))).toThrow(/CLICK requires/);
  });

  it('rejects control characters in model-authored text', () => {
    const plan = { ...validPlanProposal(), summary: 'unsafe\u001b[31m text' };
    expect(() => parsePlanningResponse(JSON.stringify(plan))).toThrow(/Control characters/);
  });
});
