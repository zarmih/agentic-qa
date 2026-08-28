import { describe, expect, it } from 'vitest';
import { VerificationCandidateExtractor } from '../../src/application/verification-candidates.js';
import {
  DefectFindingFactory,
  ReproducibilityClassifier,
} from '../../src/application/verification-verdict.js';
import type { DefectSignature, VerificationAttempt } from '../../src/domain/verification.js';
import { verificationExecutionFixture } from '../fixtures/verification-fixtures.js';

function fixtureCandidate() {
  const loaded = verificationExecutionFixture('FAIL');
  const candidate = new VerificationCandidateExtractor().extract(
    loaded.execution,
    loaded.executionInput.exploration.startUrl,
  )[0];
  if (candidate === undefined) throw new Error('Candidate fixture is missing.');
  return { loaded, candidate };
}

function attempt(
  attemptNumber: number,
  status: VerificationAttempt['status'],
  reproduced: boolean | null,
  signature: DefectSignature | null,
): VerificationAttempt {
  return {
    attemptNumber,
    executionId: `exec-attempt-${String(attemptNumber)}`,
    scenarioId: 'scenario-click',
    status,
    failureCode: status === 'FAIL' ? 'STATE_DRIFT' : status === 'ERROR' ? 'BROWSER_ERROR' : null,
    actualUrl: 'http://fixture.test/',
    actualFingerprint: status === 'FAIL' ? 'f'.repeat(64) : 'b'.repeat(64),
    expectedUrl: 'http://fixture.test/',
    expectedFingerprint: 'b'.repeat(64),
    durationMs: 100 * attemptNumber,
    signalReproduced: reproduced,
    signature,
    evidenceRefs: [],
    screenshotRefs: [`attempt-${String(attemptNumber)}.png`],
    executionArtifact: `attempt-${String(attemptNumber)}/execution.json`,
    traceArtifact: `attempt-${String(attemptNumber)}/trace.zip`,
    error: status === 'ERROR' ? 'browser unavailable' : null,
  };
}

describe('deterministic verification verdicts', () => {
  const classifier = new ReproducibilityClassifier();

  it('classifies 3/3 as confirmed, 2/2 plus one ERROR as probable, and partial failures as flaky', () => {
    const { candidate } = fixtureCandidate();
    const failure = (number: number) => attempt(number, 'FAIL', true, candidate.signature);
    expect(classifier.classify(candidate, [failure(1), failure(2), failure(3)], 3).verdict).toBe(
      'CONFIRMED_DEFECT',
    );
    expect(
      classifier.classify(candidate, [failure(1), failure(2), attempt(3, 'ERROR', null, null)], 3)
        .verdict,
    ).toBe('PROBABLE_DEFECT');
    expect(
      classifier.classify(candidate, [failure(1), attempt(2, 'PASS', false, null), failure(3)], 3)
        .verdict,
    ).toBe('FLAKY_DEFECT');
  });

  it('distinguishes not reproduced, insufficient attempts, and incompatible signatures', () => {
    const { candidate } = fixtureCandidate();
    const passes = [1, 2, 3].map((number) => attempt(number, 'PASS', false, null));
    const secondPass = passes[1];
    if (secondPass === undefined) throw new Error('Pass fixture is missing.');
    expect(classifier.classify(candidate, passes, 3).verdict).toBe('NOT_REPRODUCED');
    expect(
      classifier.classify(candidate, [attempt(1, 'ERROR', null, null), secondPass], 3).verdict,
    ).toBe('INCONCLUSIVE');
    const other = { ...candidate.signature, hash: 'a'.repeat(64), normalized: 'different' };
    expect(
      classifier.classify(
        candidate,
        [
          attempt(1, 'FAIL', true, candidate.signature),
          attempt(2, 'FAIL', false, other),
          attempt(3, 'FAIL', true, candidate.signature),
        ],
        3,
      ).verdict,
    ).toBe('INCONCLUSIVE');
  });

  it('creates stable finding IDs and conservative severity/confidence without root-cause claims', () => {
    const { loaded, candidate } = fixtureCandidate();
    const attempts = [1, 2, 3].map((number) => attempt(number, 'FAIL', true, candidate.signature));
    const result = classifier.classify(candidate, attempts, 3);
    const factory = new DefectFindingFactory();
    const input = {
      candidate,
      attempts,
      result,
      plan: loaded.executionInput.plan,
      source: loaded.executionInput.exploration,
      execution: loaded.execution,
      verifiedAt: '2026-08-28T01:00:00.000Z',
      sourceScreenshotPrefix: '../../executions/exec-verification-fixture',
    } as const;
    const first = factory.create(input);
    const second = factory.create({ ...input, verifiedAt: '2026-08-29T01:00:00.000Z' });
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({
      verdict: 'CONFIRMED_DEFECT',
      severity: 'MEDIUM',
      confidence: 'VERY_HIGH',
      rootCause: null,
      evidence: { relation: 'ASSOCIATED_NOT_CAUSAL' },
    });
  });
});
