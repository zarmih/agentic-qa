import type { DefectSignature } from '../domain/verification.js';
import { compareStrings } from '../domain/determinism.js';
import { RegressionIntegrityError } from './errors.js';
import type { LoadedRegressionSource } from './regression-ports.js';
import { canonicalJson, sha256Digest } from './source-integrity.js';
import { VerificationCandidateExtractor } from './verification-candidates.js';
import {
  FindingsIntegrityService,
  VerificationIntegrityService,
} from './verification-integrity.js';
import { VerificationSourceValidator } from './verification-source-validator.js';
import { DefectFindingFactory, ReproducibilityClassifier } from './verification-verdict.js';
import { verificationSummaryFor } from './verify-execution.js';

export interface ValidatedRegressionSource {
  readonly loaded: LoadedRegressionSource;
}

function uniqueSignatures(values: readonly DefectSignature[]): readonly DefectSignature[] {
  return [...new Map(values.map((value) => [value.hash, value])).values()].sort((left, right) =>
    compareStrings(left.hash, right.hash),
  );
}

function duplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

export class RegressionSourceValidator {
  private readonly source = new VerificationSourceValidator();
  private readonly verificationIntegrity = new VerificationIntegrityService();
  private readonly findingsIntegrity = new FindingsIntegrityService();
  private readonly extractor = new VerificationCandidateExtractor();
  private readonly classifier = new ReproducibilityClassifier();
  private readonly factory = new DefectFindingFactory();

  public validate(loaded: LoadedRegressionSource): ValidatedRegressionSource {
    const validatedSource = this.source.validate(loaded.verificationSource);
    const { findings, verification } = loaded;
    const execution = loaded.verificationSource.execution;
    const plan = validatedSource.executionInput.loaded.plan;
    const exploration = validatedSource.executionInput.loaded.exploration;

    if (!this.verificationIntegrity.validate(verification)) {
      throw new RegressionIntegrityError(
        'verification.json payload digest does not match its recorded integrity.',
      );
    }
    if (!this.findingsIntegrity.validate(findings)) {
      throw new RegressionIntegrityError(
        'findings.json payload digest does not match its recorded integrity.',
      );
    }
    if (
      findings.sourceIntegrity.verificationDigest !==
        this.verificationIntegrity.digest(verification) ||
      findings.sourceIntegrity.sourceExecutionDigest !== sha256Digest(execution) ||
      verification.sourceIntegrity.sourceExecutionDigest !== sha256Digest(execution)
    ) {
      throw new RegressionIntegrityError(
        'The findings are not bound to the validated verification and source execution.',
      );
    }
    const upstream = {
      algorithm: 'SHA-256' as const,
      sourceExecutionDigest: sha256Digest(execution),
      planDigest: execution.sourceIntegrity.planDigest,
      explorationDigest: execution.sourceIntegrity.explorationDigest,
      observationDigest: execution.sourceIntegrity.observationDigest,
      graphDigest: execution.sourceIntegrity.graphDigest,
      stateGraphDigest: execution.sourceIntegrity.stateGraphDigest,
    };
    if (
      canonicalJson(verification.sourceIntegrity) !== canonicalJson(upstream) ||
      canonicalJson({
        algorithm: findings.sourceIntegrity.algorithm,
        sourceExecutionDigest: findings.sourceIntegrity.sourceExecutionDigest,
        planDigest: findings.sourceIntegrity.planDigest,
        explorationDigest: findings.sourceIntegrity.explorationDigest,
        observationDigest: findings.sourceIntegrity.observationDigest,
        graphDigest: findings.sourceIntegrity.graphDigest,
        stateGraphDigest: findings.sourceIntegrity.stateGraphDigest,
      }) !== canonicalJson(upstream)
    ) {
      throw new RegressionIntegrityError('Upstream source integrity metadata is inconsistent.');
    }
    if (
      verification.sourceRunId !== exploration.runId ||
      verification.sourceExecutionId !== execution.executionId ||
      verification.planId !== plan.planId ||
      findings.sourceRunId !== verification.sourceRunId ||
      findings.sourceExecutionId !== verification.sourceExecutionId ||
      findings.verificationId !== verification.verificationId ||
      canonicalJson(findings.attemptPolicy) !== canonicalJson(verification.attemptPolicy)
    ) {
      throw new RegressionIntegrityError(
        'Verification, findings, plan, and exploration IDs differ.',
      );
    }

    const discovered = this.extractor.extract(execution, exploration.startUrl);
    const selected = discovered.slice(0, verification.attemptPolicy.maxFindings);
    if (canonicalJson(selected) !== canonicalJson(verification.candidates)) {
      throw new RegressionIntegrityError(
        'Verification candidates do not match deterministic extraction from execution.json.',
      );
    }
    const candidateIds = selected.map((candidate) => candidate.id);
    if (
      duplicate(candidateIds) !== null ||
      duplicate(verification.findings.map((finding) => finding.id)) !== null ||
      Object.keys(verification.attempts).sort().join('\n') !== [...candidateIds].sort().join('\n')
    ) {
      throw new RegressionIntegrityError(
        'Verification candidate, finding, or attempt IDs collide.',
      );
    }

    const rebuiltFindings = selected.map((candidate) => {
      const attempts = verification.attempts[candidate.id] ?? [];
      if (
        attempts.some(
          (attempt, index) =>
            attempt.attemptNumber !== index + 1 || attempt.scenarioId !== candidate.scenarioId,
        ) ||
        (candidate.rerun && attempts.length > verification.attemptPolicy.attemptsPerCandidate) ||
        (!candidate.rerun && attempts.length !== 0)
      ) {
        throw new RegressionIntegrityError(
          `Verification attempts for ${candidate.id} are internally inconsistent.`,
        );
      }
      const result = this.classifier.classify(
        candidate,
        attempts,
        verification.attemptPolicy.attemptsPerCandidate,
      );
      const stored = verification.findings.find(
        (finding) => finding.signature.hash === candidate.signature.hash,
      );
      if (stored === undefined) {
        throw new RegressionIntegrityError(`Verification finding for ${candidate.id} is missing.`);
      }
      return this.factory.create({
        candidate,
        attempts,
        result,
        plan,
        source: exploration,
        execution,
        verifiedAt: stored.verifiedAt,
        sourceScreenshotPrefix: loaded.verificationSource.sourceExecutionRelativePath,
      });
    });
    if (
      canonicalJson(rebuiltFindings) !== canonicalJson(verification.findings) ||
      canonicalJson(verification.findings) !== canonicalJson(findings.findings)
    ) {
      throw new RegressionIntegrityError(
        'Finding verdicts or signatures do not match deterministic verification policy.',
      );
    }
    const expectedSignatures = uniqueSignatures([
      ...selected.map((candidate) => candidate.signature),
      ...Object.values(verification.attempts)
        .flat()
        .flatMap((attempt) => (attempt.signature === null ? [] : [attempt.signature])),
    ]);
    if (canonicalJson(expectedSignatures) !== canonicalJson(verification.signatures)) {
      throw new RegressionIntegrityError('Verification signature catalog is inconsistent.');
    }
    const expectedSummary = verificationSummaryFor(
      discovered.length,
      selected,
      verification.attempts,
      verification.findings,
      verification.attemptPolicy.attemptsPerCandidate,
      verification.summary.limitReached,
    );
    if (
      canonicalJson(expectedSummary) !== canonicalJson(verification.summary) ||
      canonicalJson(findings.summary) !== canonicalJson(verification.summary)
    ) {
      throw new RegressionIntegrityError('Verification or findings summary is inconsistent.');
    }
    return { loaded };
  }
}
