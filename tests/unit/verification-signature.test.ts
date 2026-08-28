import { describe, expect, it } from 'vitest';
import {
  DefectSignatureService,
  normalizeDiagnosticText,
  normalizeEvidenceUrl,
} from '../../src/application/verification-signature.js';
import type { ExecutionEvidenceEntry } from '../../src/domain/execution.js';

function failedRequest(url: string, message: string): ExecutionEvidenceEntry {
  return {
    id: 'runtime-evidence-00001',
    executionId: 'exec-fixture',
    kind: 'FAILED_REQUEST',
    timestamp: '2026-08-28T00:00:00.000Z',
    scenarioId: 'execution-scenario-001',
    stepId: 'execution-step-001-001',
    pageId: 'page-001',
    sourceStateId: 'state-001',
    actualStateId: null,
    url,
    message,
    method: 'GET',
    status: null,
    resourceType: 'fetch',
  };
}

describe('verification defect signatures', () => {
  it('normalizes bounded dynamic identifiers while retaining the raw signature', () => {
    const first =
      'Request 832749 failed at 2026-08-28T12:30:01.123Z id 09f7c8ae-8d0c-4b70-9f15-7817efaba123';
    const second =
      'Request 912003 failed at 2026-08-29T01:02:03Z id 8dd409c6-013d-48b2-b8ed-e38a533a90ea';
    expect(normalizeDiagnosticText(first)).toBe(normalizeDiagnosticText(second));
    expect(normalizeDiagnosticText(first)).toContain('<number>');
    expect(normalizeDiagnosticText(first)).toContain('<timestamp>');
    expect(normalizeDiagnosticText(first)).toContain('<uuid>');
  });

  it('normalizes localhost ports and query ordering without dropping query state', () => {
    expect(normalizeEvidenceUrl('http://127.0.0.1:3210/api?b=2&a=1#fragment')).toBe(
      'http://127.0.0.1:<port>/api?a=1&b=2',
    );
    expect(normalizeEvidenceUrl('http://127.0.0.1:9999/api?a=2&b=2')).not.toBe(
      normalizeEvidenceUrl('http://127.0.0.1:9999/api?a=1&b=2'),
    );
  });

  it('produces a stable hash across local ports and request IDs but not failure reasons', () => {
    const signatures = new DefectSignatureService();
    const one = failedRequest(
      'http://localhost:3100/api/items?b=2&a=1',
      'GET http://localhost:3100/api/items?b=2&a=1: Request 832749 failed',
    );
    const two = failedRequest(
      'http://localhost:4500/api/items?a=1&b=2',
      'GET http://localhost:4500/api/items?a=1&b=2: Request 912003 failed',
    );
    const different = failedRequest(
      'http://localhost:4500/api/items?a=1&b=2',
      'GET http://localhost:4500/api/items?a=1&b=2: DNS lookup failed',
    );
    const first = signatures.evidence('scenario-click', 'step-click', one, 'FAILED_REQUEST');
    const second = signatures.evidence('scenario-click', 'step-click', two, 'FAILED_REQUEST');
    const third = signatures.evidence('scenario-click', 'step-click', different, 'FAILED_REQUEST');
    expect(first.raw).not.toBe(second.raw);
    expect(first.hash).toBe(second.hash);
    expect(third.hash).not.toBe(first.hash);
  });
});
