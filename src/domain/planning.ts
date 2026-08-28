export const QA_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type QaPriority = (typeof QA_PRIORITIES)[number];

export const QA_SCENARIO_TYPES = [
  'SMOKE',
  'FUNCTIONAL',
  'NAVIGATION',
  'UI_STATE',
  'NEGATIVE',
  'RESILIENCE',
  'ACCESSIBILITY',
  'NETWORK',
  'REGRESSION_CANDIDATE',
] as const;
export type QaScenarioType = (typeof QA_SCENARIO_TYPES)[number];

export const QA_STEP_ACTIONS = [
  'NAVIGATE',
  'CLICK',
  'OBSERVE',
  'VERIFY',
  'CHECK_NETWORK',
  'CHECK_ACCESSIBILITY',
] as const;
export type QaStepAction = (typeof QA_STEP_ACTIONS)[number];

export type ScenarioExecutability = 'AUTOMATABLE' | 'MANUAL_ONLY' | 'UNSUPPORTED';

export interface TestStepTarget {
  readonly pageId?: string | undefined;
  readonly stateId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly candidateId?: string | undefined;
  readonly evidenceRef?: string | undefined;
}

export interface ProposedTestStep {
  readonly id: string;
  readonly action: QaStepAction;
  readonly target: TestStepTarget;
  readonly instruction: string;
  readonly expected: string;
}

export interface ProposedTestScenario {
  readonly id: string;
  readonly title: string;
  readonly objective: string;
  readonly priority: QaPriority;
  readonly type: QaScenarioType;
  readonly preconditions: readonly string[];
  readonly steps: readonly ProposedTestStep[];
  readonly expectedOutcome: string;
  readonly sourcePageIds: readonly string[];
  readonly sourceStateIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly rationale: string;
  readonly confidence: number;
}

export interface ProposedPlanningRisk {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: QaPriority;
  readonly evidenceRefs: readonly string[];
}

export interface ProposedQaPlan {
  readonly schemaVersion: '1.0';
  readonly summary: string;
  readonly scenarios: readonly ProposedTestScenario[];
  readonly risks: readonly ProposedPlanningRisk[];
  readonly uncoveredAreas: readonly string[];
}

export interface TestScenario extends ProposedTestScenario {
  readonly executability: ScenarioExecutability;
  readonly safetyNotes: readonly string[];
}

export type PlanningRisk = ProposedPlanningRisk;

export interface CoverageMetric {
  readonly covered: number;
  readonly total: number;
  readonly percentage: number;
}

export interface CoverageAnalysis {
  readonly pages: CoverageMetric;
  readonly states: CoverageMetric;
  readonly safeTransitions: CoverageMetric;
  readonly evidenceLocations: CoverageMetric;
  readonly errorBearingStates: CoverageMetric;
}

export interface PlanningTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface PlanningTruncation {
  readonly truncated: boolean;
  readonly truncatedFields: readonly string[];
  readonly original: {
    readonly pages: number;
    readonly navigation: number;
    readonly states: number;
    readonly transitions: number;
    readonly evidence: number;
    readonly candidates: number;
  };
  readonly included: {
    readonly pages: number;
    readonly navigation: number;
    readonly states: number;
    readonly transitions: number;
    readonly evidence: number;
    readonly candidates: number;
  };
  readonly serializedCharacters: number;
  readonly maxSerializedCharacters: number;
}

export interface QaPlanMetadata {
  readonly provider: 'openai-compatible';
  readonly model: string;
  readonly requestDurationMs: number;
  readonly repairAttempts: 0 | 1;
  readonly inputTruncation: PlanningTruncation;
  readonly usage: PlanningTokenUsage | null;
  readonly duplicateScenariosRemoved: number;
}

export interface QaPlan {
  readonly schemaVersion: '1.0';
  readonly planId: string;
  readonly sourceRunId: string;
  readonly generatedAt: string;
  readonly summary: string;
  readonly scenarios: readonly TestScenario[];
  readonly coverage: CoverageAnalysis;
  readonly risks: readonly PlanningRisk[];
  readonly uncoveredAreas: readonly string[];
  readonly warnings: readonly string[];
  readonly metadata: QaPlanMetadata;
}

export type PlanningEvidenceKind =
  | 'HTTP_5XX'
  | 'HTTP_4XX'
  | 'PAGE_ERROR'
  | 'CONSOLE_ERROR'
  | 'CONSOLE_WARNING'
  | 'FAILED_REQUEST'
  | 'DIALOG'
  | 'POPUP'
  | 'DOWNLOAD'
  | 'ACTION_FAILURE';

export interface PlanningEvidenceObservation {
  readonly id: string;
  readonly kind: PlanningEvidenceKind;
  readonly severity: 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO';
  readonly summary: string;
  readonly pageId: string | null;
  readonly stateId: string | null;
  readonly actionId: string | null;
}

export interface PlanningPageObservation {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly status: number | null;
  readonly visitState: 'visited' | 'failed';
  readonly depth: number;
  readonly elements: {
    readonly links: number;
    readonly buttons: number;
    readonly inputs: number;
    readonly forms: number;
    readonly headings: number;
  };
  readonly warnings: readonly string[];
}

export interface PlanningStateObservation {
  readonly id: string;
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly depth: number;
  readonly headings: readonly string[];
  readonly dialogs: readonly string[];
  readonly visibleControls: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface PlanningTransitionObservation {
  readonly id: string;
  readonly sourceStateId: string;
  readonly targetStateId: string | null;
  readonly actionType: 'click';
  readonly accessibleName: string;
  readonly role: string;
  readonly outcome: string;
  readonly urlChanged: boolean;
  readonly evidenceRefs: readonly string[];
}

export interface PlanningBlockedCandidateObservation {
  readonly stateId: string;
  readonly candidateId: string;
  readonly accessibleName: string;
  readonly tag: string;
  readonly classification: 'CAUTION' | 'DESTRUCTIVE' | 'UNKNOWN';
  readonly reason: string;
}

export interface PlanningNavigationObservation {
  readonly id: string;
  readonly sourcePageId: string;
  readonly targetPageId: string | null;
  readonly targetUrl: string | null;
  readonly hint: string;
  readonly scope: string;
  readonly visited: boolean;
}

export interface PlanningObservation {
  readonly schemaVersion: '1.0';
  readonly trustBoundary: 'UNTRUSTED_APPLICATION_DATA';
  readonly source: {
    readonly runId: string;
    readonly explorationSchemaVersion: string;
    readonly startUrl: string;
  };
  readonly totals: {
    readonly pages: number;
    readonly navigation: number;
    readonly states: number;
    readonly safeTransitions: number;
    readonly evidence: number;
    readonly blockedCandidates: number;
  };
  readonly pages: readonly PlanningPageObservation[];
  readonly navigation: readonly PlanningNavigationObservation[];
  readonly states: readonly PlanningStateObservation[];
  readonly transitions: readonly PlanningTransitionObservation[];
  readonly blockedCandidates: readonly PlanningBlockedCandidateObservation[];
  readonly evidence: readonly PlanningEvidenceObservation[];
  readonly truncation: PlanningTruncation;
}

export interface PlanningContextLimits {
  readonly maxPagesForPlanning: number;
  readonly maxStatesForPlanning: number;
  readonly maxEvidenceEntries: number;
  readonly maxCandidatesSummary: number;
  readonly maxTransitionsForPlanning: number;
  readonly maxSerializedCharacters: number;
}
