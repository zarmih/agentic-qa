import type { ExecutionRun } from '../domain/execution.js';
import type { FindingsArtifact, VerificationRun } from '../domain/verification.js';
import type { LoadedExecutionArtifacts, ExecutionArtifactWriter } from './execution-ports.js';
import type { RunQaPlanOptions, RunQaPlanOutcome } from './run-qa-plan.js';

export interface LoadedVerificationSource {
  readonly execution: ExecutionRun;
  readonly executionFile: string;
  readonly executionDirectory: string;
  readonly sourceExecutionRelativePath: string;
  readonly runDirectory: string;
  readonly planFile: string;
  readonly explorationFile: string;
  readonly executionInput: LoadedExecutionArtifacts;
}

export interface VerificationArtifactReader {
  loadVerificationSource(executionPath: string): Promise<LoadedVerificationSource>;
}

export interface VerificationArtifactLocations {
  readonly directory: string;
}

export interface VerificationAttemptArtifactTarget {
  readonly writer: ExecutionArtifactWriter;
  readonly relativeDirectory: string;
}

export interface VerificationArtifactWriter {
  prepareVerification(
    runDirectory: string,
    verificationId: string,
  ): Promise<VerificationArtifactLocations>;
  attemptTarget(
    verificationDirectory: string,
    candidateId: string,
    attemptNumber: number,
  ): VerificationAttemptArtifactTarget;
  saveVerification(
    directory: string,
    result: VerificationRun,
    findings: FindingsArtifact,
    markdown: string,
  ): Promise<void>;
}

export interface VerificationScenarioRunner {
  runScenario(request: {
    readonly planPath: string;
    readonly scenarioId: string;
    readonly explorationPath: string;
    readonly options: RunQaPlanOptions;
    readonly artifacts: ExecutionArtifactWriter;
  }): Promise<RunQaPlanOutcome>;
}
