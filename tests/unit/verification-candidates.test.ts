import { describe, expect, it } from 'vitest';
import { VerificationCandidateExtractor } from '../../src/application/verification-candidates.js';
import type { ExecutionEvidenceEntry } from '../../src/domain/execution.js';
import { verificationExecutionFixture } from '../fixtures/verification-fixtures.js';

function evidence(overrides: Partial<ExecutionEvidenceEntry> = {}): ExecutionEvidenceEntry {
  return {
    id: 'runtime-evidence-00001',
    executionId: 'exec-verification-fixture',
    kind: 'HTTP_ERROR',
    timestamp: '2026-08-28T00:00:00.500Z',
    scenarioId: 'execution-scenario-001',
    stepId: 'execution-step-001-001',
    pageId: 'page-001',
    sourceStateId: 'state-001',
    actualStateId: 'state-002',
    url: 'http://fixture.test/api/help',
    message: '500 GET http://fixture.test/api/help',
    method: 'GET',
    status: 500,
    resourceType: 'fetch',
    ...overrides,
  };
}

describe('VerificationCandidateExtractor', () => {
  it('selects structural FAIL before evidence and never treats BLOCKED or ERROR as rerunnable defects', () => {
    const extractor = new VerificationCandidateExtractor();
    expect(
      extractor.extract(verificationExecutionFixture('FAIL').execution, 'http://fixture.test/')[0],
    ).toMatchObject({
      triggerKind: 'STRUCTURAL_MISMATCH',
      rerun: true,
    });
    expect(
      extractor.extract(
        verificationExecutionFixture('BLOCKED').execution,
        'http://fixture.test/',
      )[0],
    ).toMatchObject({
      triggerKind: 'SOURCE_BLOCKED',
      rerun: false,
    });
    expect(
      extractor.extract(verificationExecutionFixture('ERROR').execution, 'http://fixture.test/')[0],
    ).toMatchObject({
      triggerKind: 'EXECUTION_ERROR',
      rerun: false,
    });
  });

  it('selects a reproduced same-origin HTTP 5xx attached to a PASS step', () => {
    const loaded = verificationExecutionFixture('PASS', [evidence()]);
    expect(
      new VerificationCandidateExtractor().extract(loaded.execution, 'http://fixture.test/'),
    ).toMatchObject([
      {
        triggerKind: 'HTTP_SERVER_ERROR',
        sourceStatus: 'PASS',
        rerun: true,
        sourceExecutionEvidenceRefs: ['runtime-evidence-00001'],
      },
    ]);
  });

  it('filters favicon/asset 404s, external failures, warnings, and unattributed noise', () => {
    const noisy = [
      evidence({ kind: 'HTTP_ERROR', status: 404, resourceType: 'image' }),
      evidence({
        kind: 'FAILED_REQUEST',
        url: 'https://analytics.invalid/pixel',
        resourceType: 'fetch',
      }),
      evidence({ kind: 'CONSOLE_WARNING', status: null, method: null, resourceType: null }),
      evidence({
        kind: 'CONSOLE_ERROR',
        stepId: null,
        status: null,
        method: null,
        resourceType: null,
      }),
    ].map((entry, index) => ({
      ...entry,
      id: `runtime-evidence-${String(index + 1).padStart(5, '0')}`,
    }));
    const loaded = verificationExecutionFixture('PASS', noisy);
    expect(
      new VerificationCandidateExtractor().extract(loaded.execution, 'http://fixture.test/'),
    ).toEqual([]);
  });
});
