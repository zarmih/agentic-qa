import type { ExecutionEvidenceKind, ExecutionFailureCode, ExecutionStatus } from './execution.js';
import type { Viewport } from './inspection.js';

export const VERIFICATION_TRIGGER_KINDS = [
  'STRUCTURAL_MISMATCH',
  'PAGE_ERROR',
  'HTTP_SERVER_ERROR',
  'FAILED_REQUEST',
  'CONSOLE_ERROR',
  'SOURCE_BLOCKED',
  'EXECUTION_ERROR',
] as const;
export type VerificationTriggerKind = (typeof VERIFICATION_TRIGGER_KINDS)[number];

export const REPRODUCIBILITY_CLASSIFICATIONS = [
  'CONSISTENT',
  'INTERMITTENT',
  'NOT_REPRODUCED',
  'INCONCLUSIVE',
] as const;
export type ReproducibilityClassification = (typeof REPRODUCIBILITY_CLASSIFICATIONS)[number];

export const DEFECT_VERDICTS = [
  'CONFIRMED_DEFECT',
  'PROBABLE_DEFECT',
  'FLAKY_DEFECT',
  'NOT_REPRODUCED',
  'INCONCLUSIVE',
  'NON_DEFECT_SIGNAL',
] as const;
export type DefectVerdict = (typeof DEFECT_VERDICTS)[number];

export const DEFECT_CATEGORIES = [
  'FUNCTIONAL',
  'NAVIGATION',
  'UI_STATE',
  'HTTP',
  'JAVASCRIPT',
  'NETWORK',
  'RELIABILITY',
] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

export type DefectSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type DefectConfidence = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface VerificationCandidate {
  readonly id: string;
  readonly scenarioId: string;
  readonly sourceScenarioExecutionId: string;
  readonly sourceExecutionId: string;
  readonly triggerKind: VerificationTriggerKind;
  readonly sourceStatus: ExecutionStatus;
  readonly sourceEvidenceRefs: readonly string[];
  readonly sourceExecutionEvidenceRefs: readonly string[];
  readonly sourceFailureCode: ExecutionFailureCode | null;
  readonly sourceStepId: string | null;
  readonly priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  readonly rerun: boolean;
  readonly signature: DefectSignature;
  readonly associatedSourceExecutionEvidenceRefs: readonly string[];
}

export interface DefectSignature {
  readonly kind: VerificationTriggerKind;
  readonly raw: string;
  readonly normalized: string;
  readonly hash: string;
  readonly scenarioId: string;
  readonly stepId: string | null;
  readonly failureCode: ExecutionFailureCode | null;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly evidenceKind: ExecutionEvidenceKind | null;
  readonly method: string | null;
  readonly url: string | null;
  readonly status: number | null;
}

export interface VerificationAttempt {
  readonly attemptNumber: number;
  readonly executionId: string | null;
  readonly scenarioId: string;
  readonly status: ExecutionStatus;
  readonly failureCode: ExecutionFailureCode | null;
  readonly actualUrl: string | null;
  readonly actualFingerprint: string | null;
  readonly expectedUrl: string | null;
  readonly expectedFingerprint: string | null;
  readonly durationMs: number;
  readonly signalReproduced: boolean | null;
  readonly signature: DefectSignature | null;
  readonly evidenceRefs: readonly string[];
  readonly screenshotRefs: readonly string[];
  readonly executionArtifact: string | null;
  readonly traceArtifact: string | null;
  readonly error: string | null;
}

export interface SignatureDistributionEntry {
  readonly signatureHash: string;
  readonly normalized: string;
  readonly count: number;
}

export interface FlakinessProfile {
  readonly attemptsRequested: number;
  readonly attemptsCompleted: number;
  readonly validAttempts: number;
  readonly matchingAttempts: number;
  readonly reproductionRate: number;
  readonly statusDistribution: Readonly<Record<ExecutionStatus, number>>;
  readonly signatureDistribution: readonly SignatureDistributionEntry[];
  readonly dominantSignature: string | null;
  readonly durationMinMs: number | null;
  readonly durationMaxMs: number | null;
  readonly durationMedianMs: number | null;
  readonly observedVariance: readonly string[];
}

export interface FindingEvidence {
  readonly relation: 'ASSOCIATED_NOT_CAUSAL';
  readonly sourceEvidenceRefs: readonly string[];
  readonly sourceExecutionEvidenceRefs: readonly string[];
  readonly attemptEvidenceRefs: readonly string[];
  readonly kinds: readonly ExecutionEvidenceKind[];
  readonly summaries: readonly string[];
}

export interface DefectFinding {
  readonly id: string;
  readonly title: string;
  readonly category: DefectCategory;
  readonly verdict: DefectVerdict;
  readonly severity: DefectSeverity;
  readonly confidence: DefectConfidence;
  readonly scenarioId: string;
  readonly stepId: string | null;
  readonly sourceExecutionId: string;
  readonly signature: DefectSignature;
  readonly reproducibility: ReproducibilityClassification;
  readonly profile: FlakinessProfile;
  readonly attempts: readonly VerificationAttempt[];
  readonly evidence: FindingEvidence;
  readonly expected: string | null;
  readonly actual: readonly string[];
  readonly affectedPages: readonly string[];
  readonly affectedStates: readonly string[];
  readonly reproductionSteps: readonly string[];
  readonly sourceScreenshotRefs: readonly string[];
  readonly firstObservedAt: string;
  readonly verifiedAt: string;
  readonly rootCause: null;
}

export interface VerificationAttemptPolicy {
  readonly attemptsPerCandidate: number;
  readonly minimumValidAttempts: 2;
  readonly maxFindings: number;
  readonly timeoutMs: number;
}

export interface VerificationSummary {
  readonly candidatesDiscovered: number;
  readonly candidatesSelected: number;
  readonly attemptsRequested: number;
  readonly attemptsCompleted: number;
  readonly validAttempts: number;
  readonly confirmed: number;
  readonly probable: number;
  readonly flaky: number;
  readonly notReproduced: number;
  readonly inconclusive: number;
  readonly nonDefectSignals: number;
  readonly infrastructureErrors: number;
  readonly limitReached: readonly string[];
}

export interface VerificationEnvironment {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly browserName: 'chromium';
  readonly browserVersions: readonly string[];
  readonly viewport: Viewport;
  readonly headless: boolean;
}

export interface VerificationRun {
  readonly schemaVersion: '1.0';
  readonly verificationId: string;
  readonly sourceRunId: string;
  readonly sourceExecutionId: string;
  readonly planId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly attemptPolicy: VerificationAttemptPolicy;
  readonly environment: VerificationEnvironment;
  readonly sourceIntegrity: {
    readonly algorithm: 'SHA-256';
    readonly sourceExecutionDigest: string;
    readonly planDigest: string;
    readonly explorationDigest: string;
    readonly observationDigest: string;
    readonly graphDigest: string;
    readonly stateGraphDigest: string;
  };
  readonly summary: VerificationSummary;
  readonly candidates: readonly VerificationCandidate[];
  readonly attempts: Readonly<Record<string, readonly VerificationAttempt[]>>;
  readonly signatures: readonly DefectSignature[];
  readonly findings: readonly DefectFinding[];
  readonly warnings: readonly string[];
  readonly artifacts: {
    readonly report: 'verification.json';
    readonly markdown: 'verification.md';
    readonly findings: 'findings.json';
    readonly attemptsDirectory: 'attempts';
  };
}

export interface FindingsArtifact {
  readonly schemaVersion: '1.0';
  readonly verificationId: string;
  readonly sourceRunId: string;
  readonly sourceExecutionId: string;
  readonly attemptPolicy: VerificationAttemptPolicy;
  readonly summary: VerificationSummary;
  readonly findings: readonly DefectFinding[];
}

export interface VerificationLimits {
  readonly attempts: number;
  readonly maxFindings: number;
  readonly verifyTimeoutMs: number;
}
