export const EXPORT_ENTRY_STATUSES = [
  'NEW',
  'IDENTICAL',
  'MODIFIED_GENERATED',
  'CONFLICT',
] as const;
export type ExportEntryStatus = (typeof EXPORT_ENTRY_STATUSES)[number];

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'unknown';
export type TargetLanguage = 'typescript' | 'javascript' | 'unknown';
export type TargetSupport = 'SUPPORTED' | 'REVIEW_REQUIRED' | 'UNSUPPORTED';

export interface TargetProjectProfile {
  readonly identifier: string;
  readonly packageManager: PackageManager;
  readonly packageJson: boolean;
  readonly playwrightDependency: boolean;
  readonly playwrightConfig: string | null;
  readonly configuredTestDirectory: string | null;
  readonly configuredBaseUrl: string | null;
  readonly tsconfig: boolean;
  readonly moduleType: 'module' | 'commonjs' | 'unspecified';
  readonly language: TargetLanguage;
  readonly selectedTestDirectory: string;
  readonly destinationDirectory: string;
  readonly destinationSource: 'explicit' | 'config' | 'existing' | 'fallback';
  readonly support: TargetSupport;
  readonly git: {
    readonly repository: boolean;
    readonly branch: string | null;
    readonly dirty: boolean | null;
  };
  readonly baseUrlCompatibility: 'COMPATIBLE' | 'BASE_URL_REVIEW_REQUIRED' | 'UNKNOWN';
  readonly warnings: readonly string[];
}

export interface ExportEntry {
  readonly findingId: string;
  readonly source: string;
  readonly destination: string;
  readonly status: ExportEntryStatus;
  readonly sourceDigest: string;
  readonly existingDigest: string | null;
  readonly diff: string | null;
  readonly willWrite: boolean;
  readonly reason: string;
}

export interface ExportPlanSummary {
  readonly specs: number;
  readonly newFiles: number;
  readonly identical: number;
  readonly modifiedGenerated: number;
  readonly conflicts: number;
  readonly changesToApply: number;
  readonly blocked: number;
}

export interface ExportPlan {
  readonly schemaVersion: '1.0';
  readonly exportId: string;
  readonly generationId: string;
  readonly createdAt: string;
  readonly mode: 'DRY_RUN' | 'APPLY';
  readonly options: {
    readonly overwrite: boolean;
    readonly validate: boolean;
  };
  readonly target: TargetProjectProfile;
  readonly entries: readonly ExportEntry[];
  readonly summary: ExportPlanSummary;
  readonly warnings: readonly string[];
  readonly sourceIntegrity: {
    readonly algorithm: 'SHA-256';
    readonly manifestDigest: string;
    readonly generationPayloadDigest: string | null;
  };
}

export interface ExportReceiptEntry {
  readonly findingId: string;
  readonly destination: string;
  readonly action: 'WRITTEN' | 'OVERWRITTEN' | 'UNCHANGED' | 'SKIPPED';
  readonly previousDigest: string | null;
  readonly newDigest: string | null;
}

export interface ExportValidationResult {
  readonly requested: boolean;
  readonly status: 'NOT_REQUESTED' | 'PASS' | 'FAIL' | 'NOT_AVAILABLE';
  readonly command: readonly string[];
  readonly durationMs: number;
  readonly output: string;
}

export interface ExportReceipt {
  readonly schemaVersion: '1.0';
  readonly exportId: string;
  readonly generationId: string;
  readonly appliedAt: string;
  readonly targetIdentifier: string;
  readonly files: readonly ExportReceiptEntry[];
  readonly validation: ExportValidationResult;
  readonly gitReview: readonly string[];
  readonly warnings: readonly string[];
}
