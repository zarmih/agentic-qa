import type {
  ExecutionEvidenceEntry,
  ScenarioExecution,
  StepExecution,
} from '../domain/execution.js';
import type { DefectSignature, VerificationTriggerKind } from '../domain/verification.js';
import { canonicalJson, sha256Digest } from './source-integrity.js';
import { normalizeDiagnosticText, normalizeEvidenceUrl } from './evidence-normalization.js';

export { normalizeDiagnosticText, normalizeEvidenceUrl } from './evidence-normalization.js';

function failureMessage(entry: ExecutionEvidenceEntry): string {
  if (entry.kind === 'HTTP_ERROR') return '';
  if (entry.kind === 'FAILED_REQUEST' && entry.method !== null && entry.url !== null) {
    const prefix = `${entry.method} ${entry.url}:`;
    return entry.message.startsWith(prefix) ? entry.message.slice(prefix.length) : entry.message;
  }
  return entry.message;
}

function signature(values: Omit<DefectSignature, 'raw' | 'normalized' | 'hash'>): DefectSignature {
  const raw = canonicalJson(values);
  const normalizedValues = {
    ...values,
    expected:
      values.expected?.startsWith('http://') === true ||
      values.expected?.startsWith('https://') === true
        ? normalizeEvidenceUrl(values.expected)
        : values.expected,
    actual:
      values.actual?.startsWith('http://') === true ||
      values.actual?.startsWith('https://') === true
        ? normalizeEvidenceUrl(values.actual)
        : values.actual,
    url: normalizeEvidenceUrl(values.url),
  };
  const normalized = canonicalJson(normalizedValues);
  return { ...values, raw, normalized, hash: sha256Digest(normalized) };
}

export class DefectSignatureService {
  public structural(scenario: ScenarioExecution, step: StepExecution): DefectSignature {
    const expected =
      step.action === 'NAVIGATE'
        ? step.transition.plannedTargetPageId
        : (step.expectedFingerprint ?? step.transition.plannedTargetStateId);
    const actual = step.action === 'NAVIGATE' ? step.actualUrl : step.actualFingerprint;
    return signature({
      kind: 'STRUCTURAL_MISMATCH',
      scenarioId: scenario.planScenarioId,
      stepId: step.planStepId,
      failureCode: step.failureCode,
      expected,
      actual,
      evidenceKind: null,
      method: null,
      url: step.actualUrl,
      status: null,
    });
  }

  public evidence(
    scenarioId: string,
    stepId: string | null,
    entry: ExecutionEvidenceEntry,
    triggerKind: Exclude<
      VerificationTriggerKind,
      'STRUCTURAL_MISMATCH' | 'SOURCE_BLOCKED' | 'EXECUTION_ERROR'
    >,
  ): DefectSignature {
    const message = normalizeDiagnosticText(failureMessage(entry));
    return signature({
      kind: triggerKind,
      scenarioId,
      stepId,
      failureCode: null,
      expected: null,
      actual: message,
      evidenceKind: entry.kind,
      method: entry.method?.toUpperCase() ?? null,
      url: entry.url,
      status: entry.status,
    });
  }

  public sourceStatus(
    scenario: ScenarioExecution,
    triggerKind: 'SOURCE_BLOCKED' | 'EXECUTION_ERROR',
  ): DefectSignature {
    return signature({
      kind: triggerKind,
      scenarioId: scenario.planScenarioId,
      stepId: scenario.steps.find((step) => step.status === scenario.status)?.planStepId ?? null,
      failureCode: scenario.failureCode,
      expected: null,
      actual: normalizeDiagnosticText(scenario.message ?? scenario.status),
      evidenceKind: null,
      method: null,
      url: null,
      status: null,
    });
  }
}
