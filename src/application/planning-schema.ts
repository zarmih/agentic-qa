import { z } from 'zod';
import {
  QA_PRIORITIES,
  QA_SCENARIO_TYPES,
  QA_STEP_ACTIONS,
  type ProposedQaPlan,
  type QaPlan,
} from '../domain/planning.js';

function containsDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      return true;
    }
  }
  return false;
}

const boundedString = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !containsDisallowedControl(value), {
      message: 'Control characters are not allowed.',
    });
const identifier = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/)
  .max(80);
const graphIdentifier = z
  .string()
  .regex(/^[a-z]+-[a-zA-Z0-9_-]+$/)
  .max(100);

const targetSchema = z
  .object({
    pageId: graphIdentifier.optional(),
    stateId: graphIdentifier.optional(),
    actionId: graphIdentifier.optional(),
    candidateId: graphIdentifier.optional(),
    evidenceRef: graphIdentifier.optional(),
  })
  .strict()
  .refine((target) => Object.values(target).some((value) => value !== undefined), {
    message: 'A test step target must contain at least one grounded reference.',
  });

const stepSchema = z
  .object({
    id: identifier,
    action: z.enum(QA_STEP_ACTIONS),
    target: targetSchema,
    instruction: boundedString(500),
    expected: boundedString(500),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.action === 'NAVIGATE' && step.target.pageId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['target', 'pageId'],
        message: 'NAVIGATE requires a pageId.',
      });
    }
    if (
      step.action === 'CLICK' &&
      step.target.actionId === undefined &&
      step.target.candidateId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'CLICK requires an actionId or candidateId.',
      });
    }
    if (step.target.candidateId !== undefined && step.target.stateId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['target', 'stateId'],
        message: 'candidateId references require a stateId.',
      });
    }
  });

const scenarioSchema = z
  .object({
    id: identifier,
    title: boundedString(200),
    objective: boundedString(800),
    priority: z.enum(QA_PRIORITIES),
    type: z.enum(QA_SCENARIO_TYPES),
    preconditions: z.array(boundedString(300)).max(20),
    steps: z.array(stepSchema).min(1).max(20),
    expectedOutcome: boundedString(800),
    sourcePageIds: z.array(graphIdentifier).max(50),
    sourceStateIds: z.array(graphIdentifier).max(50),
    evidenceRefs: z.array(graphIdentifier).max(50),
    rationale: boundedString(1_000),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (scenario) =>
      scenario.sourcePageIds.length > 0 ||
      scenario.sourceStateIds.length > 0 ||
      scenario.evidenceRefs.length > 0,
    { message: 'A scenario must cite at least one source page, state, or evidence reference.' },
  )
  .refine(
    (scenario) => new Set(scenario.steps.map((step) => step.id)).size === scenario.steps.length,
    {
      message: 'Step IDs must be unique within a scenario.',
      path: ['steps'],
    },
  );

const finalScenarioSchema = scenarioSchema.safeExtend({
  executability: z.enum(['AUTOMATABLE', 'MANUAL_ONLY', 'UNSUPPORTED']),
  safetyNotes: z.array(boundedString(500)).max(50),
});

const riskSchema = z
  .object({
    id: identifier,
    title: boundedString(200),
    description: boundedString(800),
    severity: z.enum(QA_PRIORITIES),
    evidenceRefs: z.array(graphIdentifier).max(50),
  })
  .strict();

export const proposedQaPlanSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    summary: boundedString(2_000),
    scenarios: z.array(scenarioSchema).min(1).max(50),
    risks: z.array(riskSchema).max(50),
    uncoveredAreas: z.array(boundedString(500)).max(100),
  })
  .strict()
  .refine(
    (plan) => new Set(plan.scenarios.map((scenario) => scenario.id)).size === plan.scenarios.length,
    {
      message: 'Scenario IDs must be unique.',
      path: ['scenarios'],
    },
  )
  .refine((plan) => new Set(plan.risks.map((risk) => risk.id)).size === plan.risks.length, {
    message: 'Risk IDs must be unique.',
    path: ['risks'],
  });

const coverageMetricSchema = z
  .object({
    covered: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percentage: z.number().min(0).max(100),
  })
  .strict()
  .refine((metric) => metric.covered <= metric.total, {
    message: 'Covered observations cannot exceed total observations.',
  });

const truncationCountsSchema = z
  .object({
    pages: z.number().int().nonnegative(),
    navigation: z.number().int().nonnegative(),
    states: z.number().int().nonnegative(),
    transitions: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
  })
  .strict();

const planningTruncationSchema = z
  .object({
    truncated: z.boolean(),
    truncatedFields: z.array(boundedString(100)).max(20),
    original: truncationCountsSchema,
    included: truncationCountsSchema,
    serializedCharacters: z.number().int().nonnegative(),
    maxSerializedCharacters: z.number().int().positive(),
  })
  .strict();

export const sourceIntegritySchema = z
  .object({
    algorithm: z.literal('SHA-256'),
    explorationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    observationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    graphDigest: z.string().regex(/^[a-f0-9]{64}$/),
    stateGraphDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const qaPlanSchema = z
  .object({
    schemaVersion: z.literal('1.1'),
    planId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,159}$/),
    sourceRunId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    generatedAt: z.string().min(1).max(100),
    summary: boundedString(2_000),
    scenarios: z.array(finalScenarioSchema).min(1).max(50),
    coverage: z
      .object({
        pages: coverageMetricSchema,
        states: coverageMetricSchema,
        safeTransitions: coverageMetricSchema,
        evidenceLocations: coverageMetricSchema,
        errorBearingStates: coverageMetricSchema,
      })
      .strict(),
    risks: z.array(riskSchema).max(50),
    uncoveredAreas: z.array(boundedString(500)).max(100),
    warnings: z.array(boundedString(1_000)).max(200),
    metadata: z
      .object({
        provider: z.literal('openai-compatible'),
        model: boundedString(200),
        requestDurationMs: z.number().int().nonnegative(),
        repairAttempts: z.union([z.literal(0), z.literal(1)]),
        inputTruncation: planningTruncationSchema,
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative(),
            outputTokens: z.number().int().nonnegative(),
            totalTokens: z.number().int().nonnegative(),
          })
          .strict()
          .nullable(),
        duplicateScenariosRemoved: z.number().int().nonnegative(),
        sourceIntegrity: sourceIntegritySchema,
      })
      .strict(),
  })
  .strict()
  .refine(
    (plan) => new Set(plan.scenarios.map((scenario) => scenario.id)).size === plan.scenarios.length,
    { message: 'Scenario IDs must be unique.', path: ['scenarios'] },
  )
  .refine((plan) => new Set(plan.risks.map((risk) => risk.id)).size === plan.risks.length, {
    message: 'Risk IDs must be unique.',
    path: ['risks'],
  });

export class PlanningSchemaValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super(
      `The reasoning provider returned an invalid QA plan schema: ${validationErrors.join('; ')}`,
    );
    this.name = 'PlanningSchemaValidationError';
  }
}

export class SavedPlanValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super(`The saved QA plan is invalid: ${validationErrors.join('; ')}`);
    this.name = 'SavedPlanValidationError';
  }
}

export function parsePlanningResponse(rawResponse: string): ProposedQaPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    throw new PlanningSchemaValidationError(['response: invalid JSON']);
  }
  const result = proposedQaPlanSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.slice(0, 20).map((issue) => {
      const path = issue.path.length === 0 ? 'response' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
    throw new PlanningSchemaValidationError(errors);
  }
  return result.data;
}

export function parseSavedQaPlan(value: unknown): QaPlan {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly schemaVersion?: unknown }).schemaVersion === '1.0'
  ) {
    throw new SavedPlanValidationError([
      'schemaVersion: legacy QA plans have no source integrity metadata; run plan again',
    ]);
  }
  const result = qaPlanSchema.safeParse(value);
  if (!result.success) {
    throw new SavedPlanValidationError(
      result.error.issues.slice(0, 30).map((issue) => {
        const path = issue.path.length === 0 ? 'plan' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}
