import { verificationSummaryFor } from '../../src/application/verify-execution.js';
import { VerificationCandidateExtractor } from '../../src/application/verification-candidates.js';
import {
  FindingsIntegrityService,
  VerificationIntegrityService,
  type UnsignedFindingsArtifact,
  type UnsignedVerificationRun,
} from '../../src/application/verification-integrity.js';
import {
  DefectFindingFactory,
  ReproducibilityClassifier,
} from '../../src/application/verification-verdict.js';
import type { LoadedRegressionSource } from '../../src/application/regression-ports.js';
import { sha256Digest } from '../../src/application/source-integrity.js';
import type { VerificationAttempt } from '../../src/domain/verification.js';
import { verificationExecutionFixture } from './verification-fixtures.js';

export function regressionSourceFixture(
  outcome: 'confirmed' | 'probable' | 'flaky' | 'not-reproduced' = 'confirmed',
): LoadedRegressionSource {
  const source = verificationExecutionFixture('FAIL');
  const candidate = new VerificationCandidateExtractor().extract(
    source.execution,
    source.executionInput.exploration.startUrl,
  )[0];
  if (candidate === undefined) throw new Error('Regression fixture candidate is missing.');
  const attempt = (
    attemptNumber: number,
    matching: boolean,
    status: 'PASS' | 'FAIL' | 'ERROR' = matching ? 'FAIL' : 'PASS',
  ): VerificationAttempt => ({
    attemptNumber,
    executionId: status === 'ERROR' ? null : `exec-attempt-${String(attemptNumber)}`,
    scenarioId: candidate.scenarioId,
    status,
    failureCode: status === 'FAIL' ? 'STATE_DRIFT' : status === 'ERROR' ? 'BROWSER_ERROR' : null,
    actualUrl: 'http://fixture.test/',
    actualFingerprint: matching ? 'f'.repeat(64) : 'b'.repeat(64),
    expectedUrl: null,
    expectedFingerprint: 'b'.repeat(64),
    durationMs: 100,
    signalReproduced: status === 'ERROR' ? null : matching,
    signature: matching ? candidate.signature : null,
    evidenceRefs: [],
    screenshotRefs: [],
    executionArtifact:
      status === 'ERROR' ? null : `attempts/a-${String(attemptNumber)}/execution.json`,
    traceArtifact: status === 'ERROR' ? null : `attempts/a-${String(attemptNumber)}/trace.zip`,
    error: status === 'ERROR' ? 'Controlled infrastructure error.' : null,
  });
  const attempts =
    outcome === 'confirmed'
      ? [attempt(1, true), attempt(2, true), attempt(3, true)]
      : outcome === 'probable'
        ? [attempt(1, true), attempt(2, true), attempt(3, false, 'ERROR')]
        : outcome === 'flaky'
          ? [attempt(1, true), attempt(2, false), attempt(3, true)]
          : [attempt(1, false), attempt(2, false), attempt(3, false)];
  const classifier = new ReproducibilityClassifier().classify(candidate, attempts, 3);
  const verifiedAt = '2026-08-29T00:00:00.000Z';
  const finding = new DefectFindingFactory().create({
    candidate,
    attempts,
    result: classifier,
    plan: source.executionInput.plan,
    source: source.executionInput.exploration,
    execution: source.execution,
    verifiedAt,
    sourceScreenshotPrefix: source.sourceExecutionRelativePath,
  });
  const attemptsByCandidate = { [candidate.id]: attempts };
  const summary = verificationSummaryFor(1, [candidate], attemptsByCandidate, [finding], 3, []);
  const unsignedVerification: UnsignedVerificationRun = {
    schemaVersion: '1.1',
    verificationId: 'verify-regression-fixture',
    sourceRunId: source.execution.sourceRunId,
    sourceExecutionId: source.execution.executionId,
    planId: source.execution.planId,
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    durationMs: 1_000,
    attemptPolicy: {
      attemptsPerCandidate: 3,
      minimumValidAttempts: 2,
      maxFindings: 10,
      timeoutMs: 900_000,
    },
    environment: {
      nodeVersion: 'v24.0.0',
      platform: 'test',
      browserName: 'chromium',
      browserVersions: ['fixture'],
      viewport: { width: 1_000, height: 700 },
      headless: true,
    },
    sourceIntegrity: {
      algorithm: 'SHA-256',
      sourceExecutionDigest: sha256Digest(source.execution),
      planDigest: source.execution.sourceIntegrity.planDigest,
      explorationDigest: source.execution.sourceIntegrity.explorationDigest,
      observationDigest: source.execution.sourceIntegrity.observationDigest,
      graphDigest: source.execution.sourceIntegrity.graphDigest,
      stateGraphDigest: source.execution.sourceIntegrity.stateGraphDigest,
    },
    summary,
    candidates: [candidate],
    attempts: attemptsByCandidate,
    signatures: [candidate.signature],
    findings: [finding],
    warnings: [],
    artifacts: {
      report: 'verification.json',
      markdown: 'verification.md',
      findings: 'findings.json',
      attemptsDirectory: 'attempts',
    },
  };
  const verification = {
    ...unsignedVerification,
    verificationIntegrity: new VerificationIntegrityService().create(unsignedVerification),
  };
  const unsignedFindings: UnsignedFindingsArtifact = {
    schemaVersion: '1.1',
    verificationId: verification.verificationId,
    sourceRunId: verification.sourceRunId,
    sourceExecutionId: verification.sourceExecutionId,
    attemptPolicy: verification.attemptPolicy,
    summary,
    findings: [finding],
    sourceIntegrity: {
      ...verification.sourceIntegrity,
      verificationDigest: new VerificationIntegrityService().digest(verification),
    },
  };
  const findings = {
    ...unsignedFindings,
    findingsIntegrity: new FindingsIntegrityService().create(unsignedFindings),
  };
  return {
    findings,
    verification,
    findingsFile: '/fixture/verifications/verify-regression-fixture/findings.json',
    verificationFile: '/fixture/verifications/verify-regression-fixture/verification.json',
    verificationDirectory: '/fixture/verifications/verify-regression-fixture',
    runDirectory: '/fixture',
    verificationSource: source,
  };
}
