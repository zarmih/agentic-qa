import { describe, expect, it } from 'vitest';
import { verificationExitCode } from '../../src/application/verify-execution.js';
import type { VerificationRun, VerificationSummary } from '../../src/domain/verification.js';
import { VerificationMarkdownRenderer } from '../../src/reporting/verification-markdown.js';

function summary(overrides: Partial<VerificationSummary> = {}): VerificationSummary {
  return {
    candidatesDiscovered: 0,
    candidatesSelected: 0,
    attemptsRequested: 0,
    attemptsCompleted: 0,
    validAttempts: 0,
    confirmed: 0,
    probable: 0,
    flaky: 0,
    notReproduced: 0,
    inconclusive: 0,
    nonDefectSignals: 0,
    infrastructureErrors: 0,
    limitReached: [],
    ...overrides,
  };
}

function verificationRun(): VerificationRun {
  return {
    schemaVersion: '1.0',
    verificationId: 'verify-fixture',
    sourceRunId: 'run-fixture',
    sourceExecutionId: 'exec-fixture',
    planId: 'plan-fixture',
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:01.000Z',
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
      browserVersions: ['151.0.0'],
      viewport: { width: 1440, height: 900 },
      headless: true,
    },
    sourceIntegrity: {
      algorithm: 'SHA-256',
      sourceExecutionDigest: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
      explorationDigest: 'c'.repeat(64),
      observationDigest: 'd'.repeat(64),
      graphDigest: 'e'.repeat(64),
      stateGraphDigest: 'f'.repeat(64),
    },
    summary: summary(),
    candidates: [],
    attempts: {},
    signatures: [],
    findings: [],
    warnings: [],
    artifacts: {
      report: 'verification.json',
      markdown: 'verification.md',
      findings: 'findings.json',
      attemptsDirectory: 'attempts',
    },
  };
}

describe('verification reporting', () => {
  it('uses deterministic CI exit codes', () => {
    expect(verificationExitCode(summary())).toBe(0);
    expect(verificationExitCode(summary({ confirmed: 1 }))).toBe(1);
    expect(verificationExitCode(summary({ probable: 1 }))).toBe(1);
    expect(verificationExitCode(summary({ flaky: 1 }))).toBe(1);
    expect(verificationExitCode(summary({ inconclusive: 1 }))).toBe(0);
    expect(verificationExitCode(summary({ infrastructureErrors: 1 }))).toBe(2);
    expect(verificationExitCode(summary({ limitReached: ['verification_timeout'] }))).toBe(2);
  });

  it('renders stable LLM-free Markdown with the correlation boundary', () => {
    const run = verificationRun();
    const renderer = new VerificationMarkdownRenderer();
    const markdown = renderer.render(run);
    expect(markdown).toContain('# Agentic QA Verification Report');
    expect(markdown).toContain('Confirmed defects');
    expect(markdown).toContain('correlation is not proof of causation');
    expect(markdown).toContain('No root-cause analysis or LLM reasoning');
    expect(renderer.render(JSON.parse(JSON.stringify(run)) as VerificationRun)).toBe(markdown);
  });
});
