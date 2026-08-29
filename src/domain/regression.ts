import type { DefectCategory, DefectSeverity, DefectVerdict } from './verification.js';

export const REGRESSION_GENERATION_STATUSES = [
  'GENERATED',
  'GENERATED_FIXME',
  'REVIEW_ONLY',
  'UNSUPPORTED',
  'SKIPPED_VERDICT',
  'SKIPPED_LIMIT',
  'SKIPPED_DUPLICATE',
] as const;
export type RegressionGenerationStatus = (typeof REGRESSION_GENERATION_STATUSES)[number];

export type RegressionLocator =
  | { readonly strategy: 'testId'; readonly value: string }
  | { readonly strategy: 'role'; readonly role: string; readonly name: string }
  | { readonly strategy: 'label'; readonly value: string }
  | { readonly strategy: 'id'; readonly value: string }
  | { readonly strategy: 'text'; readonly value: string };

export interface RegressionCandidate {
  readonly findingId: string;
  readonly scenarioId: string;
  readonly stepId: string;
  readonly category: DefectCategory;
  readonly verdict: DefectVerdict;
  readonly severity: DefectSeverity;
  readonly sourcePageId: string;
  readonly sourceStateId: string | null;
  readonly expectedTarget: {
    readonly pageId: string | null;
    readonly stateId: string | null;
  };
  readonly actionPath: readonly string[];
  readonly signatureHash: string;
}

export type RegressionStep =
  | {
      readonly kind: 'NAVIGATE';
      readonly pageId: string;
      readonly url: string;
    }
  | {
      readonly kind: 'CLICK';
      readonly actionId: string;
      readonly sourceStateId: string;
      readonly targetStateId: string;
      readonly locator: RegressionLocator;
      readonly accessibleName: string;
    };

export type RegressionAssertion =
  | { readonly kind: 'URL'; readonly url: string }
  | {
      readonly kind: 'VISIBLE_ROLE';
      readonly role: 'dialog' | 'heading';
      readonly name: string;
    }
  | {
      readonly kind: 'ATTRIBUTE';
      readonly locator: RegressionLocator;
      readonly attribute: 'aria-expanded' | 'aria-selected';
      readonly value: 'true';
    }
  | {
      readonly kind: 'HTTP_NO_SERVER_ERROR';
      readonly method: string;
      readonly url: string;
    };

export interface RegressionTestSpec {
  readonly schemaVersion: '1.0';
  readonly id: string;
  readonly findingId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly scenarioId: string;
  readonly triggerStepIndex: number;
  readonly steps: readonly RegressionStep[];
  readonly assertions: readonly RegressionAssertion[];
  readonly mode: 'ACTIVE' | 'FIXME';
  readonly metadata: {
    readonly verificationId: string;
    readonly verdict: 'CONFIRMED_DEFECT' | 'FLAKY_DEFECT';
    readonly severity: DefectSeverity;
    readonly signatureHash: string;
  };
}

export interface RegressionManifestEntry {
  readonly findingId: string;
  readonly scenarioId: string;
  readonly verdict: DefectVerdict;
  readonly severity: DefectSeverity;
  readonly status: RegressionGenerationStatus;
  readonly file: string | null;
  readonly reason: string;
  readonly assertions: readonly string[];
  readonly sourceDigest: string;
  readonly fileDigest: string | null;
}

export interface RegressionGenerationSummary {
  readonly findings: number;
  readonly eligible: number;
  readonly generated: number;
  readonly generatedFixme: number;
  readonly reviewOnly: number;
  readonly unsupported: number;
  readonly skippedVerdict: number;
  readonly skippedLimit: number;
  readonly duplicates: number;
  readonly totalGeneratedLines: number;
}

export interface RegressionManifest {
  readonly schemaVersion: '1.0';
  readonly generationId: string;
  readonly sourceRunId: string;
  readonly verificationId: string;
  readonly generatedAt: string;
  readonly options: {
    readonly includeFlaky: boolean;
    readonly maxGeneratedTests: number;
    readonly maxStepsPerTest: number;
    readonly maxAssertionsPerTest: number;
    readonly targetOrigin: string;
  };
  readonly summary: RegressionGenerationSummary;
  readonly tests: readonly RegressionManifestEntry[];
  readonly sourceIntegrity: {
    readonly algorithm: 'SHA-256';
    readonly findingsDigest: string;
    readonly verificationDigest: string;
    readonly sourceExecutionDigest: string;
    readonly planDigest: string;
    readonly explorationDigest: string;
    readonly graphDigest: string;
    readonly stateGraphDigest: string;
  };
}

export interface RegressionGenerationLimits {
  readonly maxGeneratedTests: number;
  readonly maxStepsPerTest: number;
  readonly maxAssertionsPerTest: number;
}
