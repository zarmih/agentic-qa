import { z } from 'zod';
import {
  EXECUTION_EVIDENCE_KINDS,
  EXECUTION_FAILURE_CODES,
  EXECUTION_STATUSES,
  type ExecutionRun,
} from '../domain/execution.js';
import { sourceIntegritySchema } from './planning-schema.js';

const boundedString = (maximum: number) => z.string().max(maximum);
const requiredString = (maximum: number) => boundedString(maximum).min(1);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nullableIdentifier = identifier.nullable();

const evidenceReproductionSchema = z
  .object({
    sourceEvidenceRef: identifier,
    status: z.enum(['REPRODUCED', 'NOT_REPRODUCED', 'NOT_EVALUATED']),
    executionEvidenceRefs: z.array(identifier).max(1_000),
  })
  .strict();

const transitionSchema = z
  .object({
    plannedSourcePageId: nullableIdentifier,
    plannedSourceStateId: nullableIdentifier,
    plannedTargetPageId: nullableIdentifier,
    plannedTargetStateId: nullableIdentifier,
    actualUrl: boundedString(4_000).nullable(),
    actualFingerprint: digest.nullable(),
    match: z.boolean(),
  })
  .strict();

const stepExecutionSchema = z
  .object({
    id: identifier,
    scenarioId: identifier,
    planStepId: identifier,
    index: z.number().int().nonnegative().max(100),
    action: z.enum(['NAVIGATE', 'CLICK']),
    requestedTarget: z
      .object({
        pageId: nullableIdentifier,
        stateId: nullableIdentifier,
        actionId: nullableIdentifier,
      })
      .strict(),
    expectedFingerprint: digest.nullable(),
    actualUrl: boundedString(4_000).nullable(),
    actualFingerprint: digest.nullable(),
    durationMs: z.number().int().nonnegative(),
    status: z.enum(EXECUTION_STATUSES),
    failureCode: z.enum(EXECUTION_FAILURE_CODES).nullable(),
    message: boundedString(4_000).nullable(),
    evidenceRefs: z.array(identifier).max(1_000),
    screenshotRefs: z.array(requiredString(1_000)).max(100),
    transition: transitionSchema,
  })
  .strict();

const scenarioExecutionSchema = z
  .object({
    id: identifier,
    planScenarioId: identifier,
    title: requiredString(500),
    priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    plannedExecutability: z.enum(['AUTOMATABLE', 'MANUAL_ONLY', 'UNSUPPORTED']),
    status: z.enum(EXECUTION_STATUSES),
    startedAt: boundedString(100).nullable(),
    completedAt: boundedString(100).nullable(),
    durationMs: z.number().int().nonnegative(),
    failureCode: z.enum(EXECUTION_FAILURE_CODES).nullable(),
    message: boundedString(4_000).nullable(),
    steps: z.array(stepExecutionSchema).max(20),
    evidenceReproduction: z.array(evidenceReproductionSchema).max(1_000),
    screenshotRefs: z.array(requiredString(1_000)).max(500),
  })
  .strict();

const executionEvidenceSchema = z
  .object({
    id: identifier,
    executionId: identifier,
    kind: z.enum(EXECUTION_EVIDENCE_KINDS),
    timestamp: requiredString(100),
    scenarioId: identifier,
    stepId: nullableIdentifier,
    pageId: nullableIdentifier,
    sourceStateId: nullableIdentifier,
    actualStateId: nullableIdentifier,
    url: boundedString(4_000).nullable(),
    message: requiredString(4_000),
    method: boundedString(30).nullable(),
    status: z.number().int().min(100).max(599).nullable(),
    resourceType: boundedString(100).nullable(),
  })
  .strict();

const summarySchema = z
  .object({
    scenariosInPlan: z.number().int().nonnegative().max(100),
    automatableScenarios: z.number().int().nonnegative().max(100),
    selectedScenarios: z.number().int().nonnegative().max(100),
    passed: z.number().int().nonnegative().max(100),
    failed: z.number().int().nonnegative().max(100),
    blocked: z.number().int().nonnegative().max(100),
    errors: z.number().int().nonnegative().max(100),
    skipped: z.number().int().nonnegative().max(100),
    stepsExecuted: z.number().int().nonnegative().max(2_000),
    evidenceCaptured: z.number().int().nonnegative().max(1_000),
    evidenceReproduced: z.number().int().nonnegative().max(10_000),
    evidenceEvaluated: z.number().int().nonnegative().max(10_000),
    limitReached: z.array(requiredString(100)).max(20),
  })
  .strict();

export const executionRunSchema = z
  .object({
    schemaVersion: z.literal('1.1'),
    executionId: identifier,
    sourceRunId: identifier,
    planId: identifier,
    startedAt: requiredString(100),
    completedAt: requiredString(100),
    durationMs: z.number().int().nonnegative(),
    environment: z
      .object({
        nodeVersion: requiredString(100),
        platform: requiredString(100),
        browserName: z.literal('chromium'),
        browserVersion: requiredString(200),
        viewport: z
          .object({
            width: z.number().int().positive().max(20_000),
            height: z.number().int().positive().max(20_000),
          })
          .strict(),
      })
      .strict(),
    summary: summarySchema,
    scenarios: z.array(scenarioExecutionSchema).max(100),
    evidence: z.array(executionEvidenceSchema).max(1_000),
    sourceIntegrity: sourceIntegritySchema.extend({ planDigest: digest }).strict(),
    executionIntegrity: z
      .object({ algorithm: z.literal('SHA-256'), payloadDigest: digest })
      .strict(),
    artifacts: z
      .object({
        report: z.literal('execution.json'),
        markdown: z.literal('execution.md'),
        trace: z.literal('trace.zip'),
        screenshotsDirectory: z.literal('screenshots'),
      })
      .strict(),
  })
  .strict()
  .refine(
    (run) => new Set(run.scenarios.map((scenario) => scenario.id)).size === run.scenarios.length,
    { message: 'Execution scenario IDs must be unique.', path: ['scenarios'] },
  )
  .refine((run) => new Set(run.evidence.map((entry) => entry.id)).size === run.evidence.length, {
    message: 'Execution evidence IDs must be unique.',
    path: ['evidence'],
  });

export class SavedExecutionValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super(`The saved execution is invalid: ${validationErrors.join('; ')}`);
    this.name = 'SavedExecutionValidationError';
  }
}

export function parseSavedExecution(value: unknown): ExecutionRun {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly schemaVersion?: unknown }).schemaVersion === '1.0'
  ) {
    throw new SavedExecutionValidationError([
      'schemaVersion: legacy Stage 5 executions have no result integrity digest; run the plan again',
    ]);
  }
  const result = executionRunSchema.safeParse(value);
  if (!result.success) {
    throw new SavedExecutionValidationError(
      result.error.issues.slice(0, 40).map((issue) => {
        const path = issue.path.length === 0 ? 'execution' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}
