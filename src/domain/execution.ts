import type { Viewport } from './inspection.js';
import type { SourceIntegrity } from './planning.js';

export const EXECUTION_STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'ERROR', 'SKIPPED'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const EXECUTION_FAILURE_CODES = [
  'UNSUPPORTED_ACTION',
  'SCENARIO_LIMIT',
  'STEP_LIMIT',
  'INVALID_SEQUENCE',
  'SOURCE_STATE_DRIFT',
  'ACTION_SEMANTIC_DRIFT',
  'ACTION_MISSING',
  'ACTION_AMBIGUOUS',
  'ACTION_NOT_SAFE',
  'OUT_OF_SCOPE',
  'FORM_ACTION_BLOCKED',
  'PAGE_URL_DRIFT',
  'STATE_DRIFT',
  'NAVIGATION_FAILED',
  'STEP_TIMEOUT',
  'EXECUTION_TIMEOUT',
  'BROWSER_ERROR',
  'MANUAL_ONLY',
  'UNSUPPORTED_SCENARIO',
] as const;
export type ExecutionFailureCode = (typeof EXECUTION_FAILURE_CODES)[number];

export const EXECUTION_EVIDENCE_KINDS = [
  'CONSOLE_ERROR',
  'CONSOLE_WARNING',
  'PAGE_ERROR',
  'FAILED_REQUEST',
  'HTTP_ERROR',
  'DIALOG',
  'POPUP',
  'DOWNLOAD',
  'ACTION_FAILURE',
] as const;
export type ExecutionEvidenceKind = (typeof EXECUTION_EVIDENCE_KINDS)[number];

export interface ExecutionEvidenceEntry {
  readonly id: string;
  readonly executionId: string;
  readonly kind: ExecutionEvidenceKind;
  readonly timestamp: string;
  readonly scenarioId: string;
  readonly stepId: string | null;
  readonly pageId: string | null;
  readonly sourceStateId: string | null;
  readonly actualStateId: string | null;
  readonly url: string | null;
  readonly message: string;
  readonly method: string | null;
  readonly status: number | null;
  readonly resourceType: string | null;
}

export type EvidenceReproductionStatus = 'REPRODUCED' | 'NOT_REPRODUCED' | 'NOT_EVALUATED';

export interface EvidenceReproduction {
  readonly sourceEvidenceRef: string;
  readonly status: EvidenceReproductionStatus;
  readonly executionEvidenceRefs: readonly string[];
}

export interface ExecutionTransition {
  readonly plannedSourcePageId: string | null;
  readonly plannedSourceStateId: string | null;
  readonly plannedTargetPageId: string | null;
  readonly plannedTargetStateId: string | null;
  readonly actualUrl: string | null;
  readonly actualFingerprint: string | null;
  readonly match: boolean;
}

export interface StepExecution {
  readonly id: string;
  readonly scenarioId: string;
  readonly planStepId: string;
  readonly index: number;
  readonly action: 'NAVIGATE' | 'CLICK';
  readonly requestedTarget: {
    readonly pageId: string | null;
    readonly stateId: string | null;
    readonly actionId: string | null;
  };
  readonly expectedFingerprint: string | null;
  readonly actualUrl: string | null;
  readonly actualFingerprint: string | null;
  readonly durationMs: number;
  readonly status: ExecutionStatus;
  readonly failureCode: ExecutionFailureCode | null;
  readonly message: string | null;
  readonly evidenceRefs: readonly string[];
  readonly screenshotRefs: readonly string[];
  readonly transition: ExecutionTransition;
}

export interface ScenarioExecution {
  readonly id: string;
  readonly planScenarioId: string;
  readonly title: string;
  readonly priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  readonly plannedExecutability: 'AUTOMATABLE' | 'MANUAL_ONLY' | 'UNSUPPORTED';
  readonly status: ExecutionStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number;
  readonly failureCode: ExecutionFailureCode | null;
  readonly message: string | null;
  readonly steps: readonly StepExecution[];
  readonly evidenceReproduction: readonly EvidenceReproduction[];
  readonly screenshotRefs: readonly string[];
}

export interface ExecutionSummary {
  readonly scenariosInPlan: number;
  readonly automatableScenarios: number;
  readonly selectedScenarios: number;
  readonly passed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly errors: number;
  readonly skipped: number;
  readonly stepsExecuted: number;
  readonly evidenceCaptured: number;
  readonly evidenceReproduced: number;
  readonly evidenceEvaluated: number;
  readonly limitReached: readonly string[];
}

export interface ExecutionEnvironment {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly browserName: 'chromium';
  readonly browserVersion: string;
  readonly viewport: Viewport;
}

export interface ExecutionIntegrity {
  readonly algorithm: 'SHA-256';
  readonly payloadDigest: string;
}

export interface ExecutionRun {
  readonly schemaVersion: '1.1';
  readonly executionId: string;
  readonly sourceRunId: string;
  readonly planId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly environment: ExecutionEnvironment;
  readonly summary: ExecutionSummary;
  readonly scenarios: readonly ScenarioExecution[];
  readonly evidence: readonly ExecutionEvidenceEntry[];
  readonly sourceIntegrity: SourceIntegrity & { readonly planDigest: string };
  readonly executionIntegrity: ExecutionIntegrity;
  readonly artifacts: {
    readonly report: 'execution.json';
    readonly markdown: 'execution.md';
    readonly trace: 'trace.zip';
    readonly screenshotsDirectory: 'screenshots';
  };
}

export interface ExecutionLimits {
  readonly maxScenarios: number;
  readonly maxStepsPerScenario: number;
  readonly executionTimeoutMs: number;
  readonly stepTimeoutMs: number;
}
