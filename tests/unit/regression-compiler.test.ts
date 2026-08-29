import { describe, expect, it } from 'vitest';
import {
  RegressionCompiler,
  RegressionDuplicateDetector,
  RegressionEligibilityPolicy,
  regressionSpecIdentity,
} from '../../src/application/regression-compiler.js';
import { RegressionSourceValidator } from '../../src/application/regression-source-validator.js';
import { RegressionUrlPolicy } from '../../src/application/regression-url-policy.js';
import { regressionSourceFixture } from '../fixtures/regression-fixtures.js';

function compile(outcome: 'confirmed' | 'flaky' = 'confirmed', baseUrl?: string) {
  const loaded = regressionSourceFixture(outcome);
  new RegressionSourceValidator().validate(loaded);
  const finding = loaded.findings.findings[0];
  if (finding === undefined) throw new Error('Fixture finding is missing.');
  return new RegressionCompiler().compile({
    finding,
    mode: outcome === 'flaky' ? 'FIXME' : 'ACTIVE',
    verification: loaded.verification,
    plan: loaded.verificationSource.executionInput.plan,
    source: loaded.verificationSource.executionInput.exploration,
    sourceExecution: loaded.verificationSource.execution,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    limits: { maxGeneratedTests: 20, maxStepsPerTest: 12, maxAssertionsPerTest: 5 },
  });
}

describe('regression eligibility and compiler', () => {
  it('compiles a confirmed UI mismatch through graph navigation and a unique semantic click', () => {
    const result = compile();
    expect(result.spec).toMatchObject({
      mode: 'ACTIVE',
      triggerStepIndex: 1,
      steps: [
        { kind: 'NAVIGATE', pageId: 'page-001', url: 'http://fixture.test/' },
        {
          kind: 'CLICK',
          actionId: 'action-0001',
          locator: { strategy: 'role', role: 'button', name: 'Help' },
        },
      ],
      assertions: [{ kind: 'VISIBLE_ROLE', role: 'dialog', name: 'help dialog' }],
    });
    expect(result.candidate?.actionPath).toEqual(['action-0001']);
  });

  it('replaces only the source origin and preserves graph-owned paths', () => {
    expect(compile('confirmed', 'https://preview.example.test').spec?.steps[0]).toEqual({
      kind: 'NAVIGATE',
      pageId: 'page-001',
      url: 'https://preview.example.test/',
    });
    expect(() => new RegressionUrlPolicy('https://app.test', 'javascript:alert(1)')).toThrow(
      /HTTP\(S\) origin/,
    );
    expect(() => new RegressionUrlPolicy('https://app.test', 'file:///tmp/app')).toThrow();
    expect(
      () => new RegressionUrlPolicy('https://app.test', 'https://user:secret@app.test'),
    ).toThrow();
  });

  it('keeps probable findings review-only and flaky specs disabled by explicit opt-in', () => {
    const policy = new RegressionEligibilityPolicy();
    const probable = regressionSourceFixture('probable').findings.findings[0];
    const flaky = regressionSourceFixture('flaky').findings.findings[0];
    if (probable === undefined || flaky === undefined)
      throw new Error('Fixture finding is missing.');
    expect(policy.classify(probable, false).kind).toBe('REVIEW_ONLY');
    expect(policy.classify(flaky, false).kind).toBe('SKIPPED_VERDICT');
    expect(policy.classify(flaky, true)).toEqual({ kind: 'COMPILE', mode: 'FIXME' });
    expect(compile('flaky').spec?.mode).toBe('FIXME');
  });

  it('detects duplicate regressions by graph path and assertion rather than prose', () => {
    const spec = compile().spec;
    if (spec === null) throw new Error('Fixture spec is missing.');
    expect(regressionSpecIdentity(spec)).toBe(
      regressionSpecIdentity({ ...spec, title: 'Completely different untrusted prose' }),
    );
    expect(regressionSpecIdentity(spec)).not.toBe(
      regressionSpecIdentity({ ...spec, assertions: [{ kind: 'URL', url: spec.sourceUrl }] }),
    );
    const duplicates = new RegressionDuplicateDetector();
    expect(duplicates.register(spec, 'DEF-FIRST')).toBeNull();
    expect(
      duplicates.register(
        { ...spec, title: 'Changed prose', findingId: 'DEF-SECOND' },
        'DEF-SECOND',
      ),
    ).toBe('DEF-FIRST');
  });

  it('does not guess executable behavior for a confirmed finding with an unsupported plan step', () => {
    const loaded = regressionSourceFixture();
    const finding = loaded.findings.findings[0];
    const original = loaded.verificationSource.executionInput.plan.scenarios[0];
    if (finding === undefined || original === undefined) throw new Error('Fixture is incomplete.');
    const originalStep = original.steps[0];
    if (originalStep === undefined) throw new Error('Fixture step is missing.');
    const changedPlan = {
      ...loaded.verificationSource.executionInput.plan,
      scenarios: [
        {
          ...original,
          steps: [
            {
              ...originalStep,
              action: 'OBSERVE' as const,
            },
          ],
        },
      ],
    };
    const result = new RegressionCompiler().compile({
      finding,
      mode: 'ACTIVE',
      verification: loaded.verification,
      plan: changedPlan,
      source: loaded.verificationSource.executionInput.exploration,
      sourceExecution: loaded.verificationSource.execution,
      limits: { maxGeneratedTests: 20, maxStepsPerTest: 12, maxAssertionsPerTest: 5 },
    });
    expect(result.spec).toBeNull();
    expect(result.reason).toMatch(/only graph-backed NAVIGATE and CLICK|Stage 5/i);
  });
});
