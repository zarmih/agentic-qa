import type { RegressionManifest, RegressionTestSpec } from '../domain/regression.js';
import type { FindingsArtifact, VerificationRun } from '../domain/verification.js';
import type { LoadedVerificationSource } from './verification-ports.js';

export interface LoadedRegressionSource {
  readonly findings: FindingsArtifact;
  readonly verification: VerificationRun;
  readonly findingsFile: string;
  readonly verificationFile: string;
  readonly verificationDirectory: string;
  readonly runDirectory: string;
  readonly verificationSource: LoadedVerificationSource;
}

export interface RegressionArtifactReader {
  loadRegressionSource(findingsPath: string): Promise<LoadedRegressionSource>;
}

export interface RegressionArtifactLocations {
  readonly directory: string;
  readonly testsDirectory: string;
}

export interface RenderedRegressionTest {
  readonly spec: RegressionTestSpec;
  readonly fileName: string;
  readonly source: string;
  readonly digest: string;
  readonly lines: number;
}

export interface RegressionArtifactWriter {
  prepareGeneration(
    runDirectory: string,
    generationId: string,
  ): Promise<RegressionArtifactLocations>;
  saveGeneration(
    locations: RegressionArtifactLocations,
    manifest: RegressionManifest,
    readme: string,
    tests: readonly RenderedRegressionTest[],
  ): Promise<void>;
}

export interface RegressionSourceCodeValidator {
  validate(fileName: string, source: string): void;
}

export interface RegressionSourceFormatter {
  format(source: string): Promise<string>;
}
