import { z } from 'zod';
import {
  REGRESSION_GENERATION_STATUSES,
  type SavedRegressionManifest,
} from '../domain/regression.js';
import { DEFECT_VERDICTS } from '../domain/verification.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = (maximum: number) => z.string().max(maximum);
const required = (maximum: number) => bounded(maximum).min(1);

const summarySchema = z
  .object({
    findings: z.number().int().nonnegative().max(10_000),
    eligible: z.number().int().nonnegative().max(10_000),
    generated: z.number().int().nonnegative().max(100),
    generatedFixme: z.number().int().nonnegative().max(100),
    reviewOnly: z.number().int().nonnegative().max(10_000),
    unsupported: z.number().int().nonnegative().max(10_000),
    skippedVerdict: z.number().int().nonnegative().max(10_000),
    skippedLimit: z.number().int().nonnegative().max(10_000),
    duplicates: z.number().int().nonnegative().max(10_000),
    totalGeneratedLines: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();

const entrySchema = z
  .object({
    findingId: z.string().regex(/^DEF-[A-F0-9]{8}$/),
    scenarioId: identifier,
    verdict: z.enum(DEFECT_VERDICTS),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
    status: z.enum(REGRESSION_GENERATION_STATUSES),
    file: bounded(500).nullable(),
    reason: required(4_000),
    assertions: z.array(bounded(4_000)).max(20),
    sourceDigest: digest,
    fileDigest: digest.nullable(),
  })
  .strict();

const sourceIntegritySchema = z
  .object({
    algorithm: z.literal('SHA-256'),
    findingsDigest: digest,
    verificationDigest: digest,
    sourceExecutionDigest: digest,
    planDigest: digest,
    explorationDigest: digest,
    graphDigest: digest,
    stateGraphDigest: digest,
  })
  .strict();

const manifestPayload = {
  generationId: identifier,
  sourceRunId: identifier,
  verificationId: identifier,
  generatedAt: required(100),
  options: z
    .object({
      includeFlaky: z.boolean(),
      maxGeneratedTests: z.number().int().min(1).max(100),
      maxStepsPerTest: z.number().int().min(1).max(25),
      maxAssertionsPerTest: z.number().int().min(1).max(10),
      targetOrigin: required(4_000),
    })
    .strict(),
  summary: summarySchema,
  tests: z.array(entrySchema).max(10_000),
  sourceIntegrity: sourceIntegritySchema,
} as const;

const manifestV10Schema = z
  .object({ schemaVersion: z.literal('1.0'), ...manifestPayload })
  .strict();
const manifestV11Schema = z
  .object({
    schemaVersion: z.literal('1.1'),
    ...manifestPayload,
    generationIntegrity: z
      .object({ algorithm: z.literal('SHA-256'), payloadDigest: digest })
      .strict(),
  })
  .strict();

const savedManifestSchema = z.union([manifestV11Schema, manifestV10Schema]);

export class SavedRegressionManifestValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super(`The saved regression manifest is invalid: ${validationErrors.join('; ')}`);
    this.name = 'SavedRegressionManifestValidationError';
  }
}

export function parseSavedRegressionManifest(value: unknown): SavedRegressionManifest {
  const parsed = savedManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new SavedRegressionManifestValidationError(
      parsed.error.issues.slice(0, 40).map((issue) => {
        const path = issue.path.length === 0 ? 'manifest' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}
