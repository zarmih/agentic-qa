export const PIPELINE_PROFILES = ['quick', 'standard', 'thorough'] as const;
export type PipelineProfile = (typeof PIPELINE_PROFILES)[number];

export const PIPELINE_STAGE_NAMES = ['explore', 'plan', 'run', 'verify', 'generate'] as const;
export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number];
export type PipelineStageStatus = 'PASS' | 'COMPLETED_WITH_FINDINGS' | 'FAILED' | 'NOT_RUN';
export type PipelineStatus =
  'COMPLETE_NO_DEFECTS' | 'COMPLETE_WITH_FINDINGS' | 'COMPLETE_WITH_REGRESSIONS' | 'FAILED';

export interface PipelineStageRecord {
  readonly name: PipelineStageName;
  readonly status: PipelineStageStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number;
  readonly artifact: string | null;
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
  readonly error: string | null;
}

export interface PipelineRun {
  readonly schemaVersion: '1.0';
  readonly pipelineId: string;
  readonly sourceRunId: string;
  readonly target: string;
  readonly profile: PipelineProfile;
  readonly provider: 'openai-compatible';
  readonly model: string;
  readonly version: '0.8.0';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly status: PipelineStatus;
  readonly stages: readonly PipelineStageRecord[];
  readonly artifacts: {
    readonly pipeline: 'pipeline.json';
    readonly report: 'report.html';
    readonly exploration: string;
    readonly plan: string | null;
    readonly execution: string | null;
    readonly verification: string | null;
    readonly findings: string | null;
    readonly generation: string | null;
    readonly manifest: string | null;
  };
  readonly warnings: readonly string[];
}

export interface PipelineProfileLimits {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly maxStates: number;
  readonly maxActionsPerState: number;
  readonly maxStateDepth: number;
  readonly verificationAttempts: number;
  readonly maxVerifyFindings: number;
  readonly maxGeneratedTests: number;
}

export const PIPELINE_PROFILE_LIMITS: Readonly<Record<PipelineProfile, PipelineProfileLimits>> = {
  quick: {
    maxPages: 5,
    maxDepth: 1,
    maxStates: 8,
    maxActionsPerState: 3,
    maxStateDepth: 1,
    verificationAttempts: 2,
    maxVerifyFindings: 5,
    maxGeneratedTests: 5,
  },
  standard: {
    maxPages: 25,
    maxDepth: 3,
    maxStates: 12,
    maxActionsPerState: 4,
    maxStateDepth: 2,
    verificationAttempts: 3,
    maxVerifyFindings: 10,
    maxGeneratedTests: 20,
  },
  thorough: {
    maxPages: 50,
    maxDepth: 4,
    maxStates: 25,
    maxActionsPerState: 6,
    maxStateDepth: 3,
    verificationAttempts: 5,
    maxVerifyFindings: 20,
    maxGeneratedTests: 40,
  },
};
