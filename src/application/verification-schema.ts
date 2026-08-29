import { z } from 'zod';
import {
  EXECUTION_EVIDENCE_KINDS,
  EXECUTION_FAILURE_CODES,
  EXECUTION_STATUSES,
} from '../domain/execution.js';
import {
  DEFECT_CATEGORIES,
  DEFECT_VERDICTS,
  REPRODUCIBILITY_CLASSIFICATIONS,
  VERIFICATION_TRIGGER_KINDS,
  type FindingsArtifact,
  type VerificationRun,
} from '../domain/verification.js';

const bounded = (maximum: number) => z.string().max(maximum);
const required = (maximum: number) => bounded(maximum).min(1);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nullableIdentifier = identifier.nullable();
const artifactReference = required(2_000);

const integritySchema = z
  .object({ algorithm: z.literal('SHA-256'), payloadDigest: digest })
  .strict();

const sourceIntegritySchema = z
  .object({
    algorithm: z.literal('SHA-256'),
    sourceExecutionDigest: digest,
    planDigest: digest,
    explorationDigest: digest,
    observationDigest: digest,
    graphDigest: digest,
    stateGraphDigest: digest,
  })
  .strict();

const signatureSchema = z
  .object({
    kind: z.enum(VERIFICATION_TRIGGER_KINDS),
    raw: required(20_000),
    normalized: required(20_000),
    hash: digest,
    scenarioId: identifier,
    stepId: nullableIdentifier,
    failureCode: z.enum(EXECUTION_FAILURE_CODES).nullable(),
    expected: bounded(4_000).nullable(),
    actual: bounded(4_000).nullable(),
    evidenceKind: z.enum(EXECUTION_EVIDENCE_KINDS).nullable(),
    method: bounded(30).nullable(),
    url: bounded(4_000).nullable(),
    status: z.number().int().min(100).max(599).nullable(),
  })
  .strict();

const candidateSchema = z
  .object({
    id: identifier,
    scenarioId: identifier,
    sourceScenarioExecutionId: identifier,
    sourceExecutionId: identifier,
    triggerKind: z.enum(VERIFICATION_TRIGGER_KINDS),
    sourceStatus: z.enum(EXECUTION_STATUSES),
    sourceEvidenceRefs: z.array(identifier).max(1_000),
    sourceExecutionEvidenceRefs: z.array(identifier).max(1_000),
    sourceFailureCode: z.enum(EXECUTION_FAILURE_CODES).nullable(),
    sourceStepId: nullableIdentifier,
    priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    rerun: z.boolean(),
    signature: signatureSchema,
    associatedSourceExecutionEvidenceRefs: z.array(identifier).max(1_000),
  })
  .strict();

const attemptSchema = z
  .object({
    attemptNumber: z.number().int().min(1).max(10),
    executionId: nullableIdentifier,
    scenarioId: identifier,
    status: z.enum(EXECUTION_STATUSES),
    failureCode: z.enum(EXECUTION_FAILURE_CODES).nullable(),
    actualUrl: bounded(4_000).nullable(),
    actualFingerprint: digest.nullable(),
    expectedUrl: bounded(4_000).nullable(),
    expectedFingerprint: digest.nullable(),
    durationMs: z.number().int().nonnegative(),
    signalReproduced: z.boolean().nullable(),
    signature: signatureSchema.nullable(),
    evidenceRefs: z.array(artifactReference).max(1_000),
    screenshotRefs: z.array(artifactReference).max(500),
    executionArtifact: artifactReference.nullable(),
    traceArtifact: artifactReference.nullable(),
    error: bounded(4_000).nullable(),
  })
  .strict();

const statusDistributionSchema = z
  .object({
    PASS: z.number().int().nonnegative(),
    FAIL: z.number().int().nonnegative(),
    BLOCKED: z.number().int().nonnegative(),
    ERROR: z.number().int().nonnegative(),
    SKIPPED: z.number().int().nonnegative(),
  })
  .strict();

const profileSchema = z
  .object({
    attemptsRequested: z.number().int().nonnegative().max(10),
    attemptsCompleted: z.number().int().nonnegative().max(10),
    validAttempts: z.number().int().nonnegative().max(10),
    matchingAttempts: z.number().int().nonnegative().max(10),
    reproductionRate: z.number().min(0).max(1),
    statusDistribution: statusDistributionSchema,
    signatureDistribution: z
      .array(
        z
          .object({
            signatureHash: digest,
            normalized: required(20_000),
            count: z.number().int().positive().max(10),
          })
          .strict(),
      )
      .max(10),
    dominantSignature: digest.nullable(),
    durationMinMs: z.number().int().nonnegative().nullable(),
    durationMaxMs: z.number().int().nonnegative().nullable(),
    durationMedianMs: z.number().int().nonnegative().nullable(),
    observedVariance: z.array(required(100)).max(20),
  })
  .strict();

const findingSchema = z
  .object({
    id: z.string().regex(/^DEF-[A-F0-9]{8}$/),
    title: required(1_000),
    category: z.enum(DEFECT_CATEGORIES),
    verdict: z.enum(DEFECT_VERDICTS),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
    confidence: z.enum(['VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW']),
    scenarioId: identifier,
    stepId: nullableIdentifier,
    sourceExecutionId: identifier,
    signature: signatureSchema,
    reproducibility: z.enum(REPRODUCIBILITY_CLASSIFICATIONS),
    profile: profileSchema,
    attempts: z.array(attemptSchema).max(10),
    evidence: z
      .object({
        relation: z.literal('ASSOCIATED_NOT_CAUSAL'),
        sourceEvidenceRefs: z.array(identifier).max(1_000),
        sourceExecutionEvidenceRefs: z.array(identifier).max(1_000),
        attemptEvidenceRefs: z.array(artifactReference).max(10_000),
        kinds: z.array(z.enum(EXECUTION_EVIDENCE_KINDS)).max(20),
        summaries: z.array(bounded(4_000)).max(1_000),
      })
      .strict(),
    expected: bounded(4_000).nullable(),
    actual: z.array(bounded(4_000)).max(100),
    affectedPages: z.array(identifier).max(1_000),
    affectedStates: z.array(identifier).max(1_000),
    reproductionSteps: z.array(required(4_000)).max(100),
    sourceScreenshotRefs: z.array(artifactReference).max(500),
    firstObservedAt: required(100),
    verifiedAt: required(100),
    rootCause: z.null(),
  })
  .strict();

const policySchema = z
  .object({
    attemptsPerCandidate: z.number().int().min(2).max(10),
    minimumValidAttempts: z.literal(2),
    maxFindings: z.number().int().min(1).max(50),
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
  })
  .strict();

const summarySchema = z
  .object({
    candidatesDiscovered: z.number().int().nonnegative().max(10_000),
    candidatesSelected: z.number().int().nonnegative().max(50),
    attemptsRequested: z.number().int().nonnegative().max(500),
    attemptsCompleted: z.number().int().nonnegative().max(500),
    validAttempts: z.number().int().nonnegative().max(500),
    confirmed: z.number().int().nonnegative().max(50),
    probable: z.number().int().nonnegative().max(50),
    flaky: z.number().int().nonnegative().max(50),
    notReproduced: z.number().int().nonnegative().max(50),
    inconclusive: z.number().int().nonnegative().max(50),
    nonDefectSignals: z.number().int().nonnegative().max(50),
    infrastructureErrors: z.number().int().nonnegative().max(500),
    limitReached: z.array(required(100)).max(20),
  })
  .strict();

export const verificationRunSchema = z
  .object({
    schemaVersion: z.literal('1.1'),
    verificationId: identifier,
    sourceRunId: identifier,
    sourceExecutionId: identifier,
    planId: identifier,
    startedAt: required(100),
    completedAt: required(100),
    durationMs: z.number().int().nonnegative(),
    attemptPolicy: policySchema,
    environment: z
      .object({
        nodeVersion: required(100),
        platform: required(100),
        browserName: z.literal('chromium'),
        browserVersions: z.array(required(200)).max(20),
        viewport: z
          .object({
            width: z.number().int().positive().max(20_000),
            height: z.number().int().positive().max(20_000),
          })
          .strict(),
        headless: z.boolean(),
      })
      .strict(),
    sourceIntegrity: sourceIntegritySchema,
    summary: summarySchema,
    candidates: z.array(candidateSchema).max(50),
    attempts: z.record(identifier, z.array(attemptSchema).max(10)),
    signatures: z.array(signatureSchema).max(1_000),
    findings: z.array(findingSchema).max(50),
    warnings: z.array(required(1_000)).max(100),
    artifacts: z
      .object({
        report: z.literal('verification.json'),
        markdown: z.literal('verification.md'),
        findings: z.literal('findings.json'),
        attemptsDirectory: z.literal('attempts'),
      })
      .strict(),
    verificationIntegrity: integritySchema,
  })
  .strict();

export const findingsArtifactSchema = z
  .object({
    schemaVersion: z.literal('1.1'),
    verificationId: identifier,
    sourceRunId: identifier,
    sourceExecutionId: identifier,
    attemptPolicy: policySchema,
    summary: summarySchema,
    findings: z.array(findingSchema).max(50),
    sourceIntegrity: sourceIntegritySchema.extend({ verificationDigest: digest }).strict(),
    findingsIntegrity: integritySchema,
  })
  .strict();

export class SavedVerificationValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super(`The saved verification artifact is invalid: ${validationErrors.join('; ')}`);
    this.name = 'SavedVerificationValidationError';
  }
}

function legacy(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly schemaVersion?: unknown }).schemaVersion === '1.0'
  );
}

function errors(error: z.ZodError): readonly string[] {
  return error.issues.slice(0, 40).map((issue) => {
    const path = issue.path.length === 0 ? 'artifact' : issue.path.join('.');
    return `${path}: ${issue.message}`;
  });
}

export function parseSavedVerification(value: unknown): VerificationRun {
  if (legacy(value)) {
    throw new SavedVerificationValidationError([
      'schemaVersion: legacy Stage 6 verification has no result integrity digest; run verify again',
    ]);
  }
  const parsed = verificationRunSchema.safeParse(value);
  if (!parsed.success) throw new SavedVerificationValidationError(errors(parsed.error));
  return parsed.data;
}

export function parseSavedFindings(value: unknown): FindingsArtifact {
  if (legacy(value)) {
    throw new SavedVerificationValidationError([
      'schemaVersion: legacy Stage 6 findings have no result integrity digest; run verify again',
    ]);
  }
  const parsed = findingsArtifactSchema.safeParse(value);
  if (!parsed.success) throw new SavedVerificationValidationError(errors(parsed.error));
  return parsed.data;
}
