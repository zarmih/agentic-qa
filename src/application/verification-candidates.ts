import type {
  ExecutionEvidenceEntry,
  ExecutionRun,
  ScenarioExecution,
} from '../domain/execution.js';
import type { VerificationCandidate, VerificationTriggerKind } from '../domain/verification.js';
import { sha256Digest } from './source-integrity.js';
import { DefectSignatureService } from './verification-signature.js';

const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
const TRIGGER_RANK: Readonly<Record<VerificationTriggerKind, number>> = {
  STRUCTURAL_MISMATCH: 0,
  HTTP_SERVER_ERROR: 1,
  PAGE_ERROR: 2,
  FAILED_REQUEST: 3,
  CONSOLE_ERROR: 4,
  SOURCE_BLOCKED: 5,
  EXECUTION_ERROR: 6,
};
const IMPORTANT_NETWORK_TYPES = new Set(['document', 'xhr', 'fetch', 'script']);

interface RankedCandidate {
  readonly candidate: VerificationCandidate;
  readonly sourceOrder: number;
}

function sameOrigin(value: string | null, origin: string): boolean {
  if (value === null) return false;
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

export function verificationTriggerForEvidence(
  entry: ExecutionEvidenceEntry,
  sourceOrigin: string,
): VerificationTriggerKind | null {
  if (entry.stepId === null || !sameOrigin(entry.url, sourceOrigin)) return null;
  if (
    entry.kind === 'HTTP_ERROR' &&
    entry.status !== null &&
    entry.status >= 500 &&
    IMPORTANT_NETWORK_TYPES.has(entry.resourceType ?? '')
  ) {
    return 'HTTP_SERVER_ERROR';
  }
  if (entry.kind === 'PAGE_ERROR') return 'PAGE_ERROR';
  if (entry.kind === 'FAILED_REQUEST' && IMPORTANT_NETWORK_TYPES.has(entry.resourceType ?? '')) {
    return 'FAILED_REQUEST';
  }
  if (entry.kind === 'CONSOLE_ERROR') return 'CONSOLE_ERROR';
  return null;
}

function candidateId(
  sourceExecutionId: string,
  scenarioId: string,
  trigger: VerificationTriggerKind,
  signatureHash: string,
): string {
  return `candidate-${sha256Digest({ sourceExecutionId, scenarioId, trigger, signatureHash }).slice(0, 12)}`;
}

function reproducedReferences(scenario: ScenarioExecution): {
  readonly source: readonly string[];
  readonly execution: ReadonlySet<string>;
} {
  const reproduced = scenario.evidenceReproduction.filter((item) => item.status === 'REPRODUCED');
  return {
    source: reproduced.map((item) => item.sourceEvidenceRef),
    execution: new Set(reproduced.flatMap((item) => item.executionEvidenceRefs)),
  };
}

export class VerificationCandidateExtractor {
  private readonly signatures = new DefectSignatureService();

  public extract(execution: ExecutionRun, startUrl: string): readonly VerificationCandidate[] {
    const sourceOrigin = new URL(startUrl).origin;
    const evidenceByScenario = new Map<string, ExecutionEvidenceEntry[]>();
    for (const entry of execution.evidence) {
      const values = evidenceByScenario.get(entry.scenarioId) ?? [];
      values.push(entry);
      evidenceByScenario.set(entry.scenarioId, values);
    }

    const ranked: RankedCandidate[] = [];
    for (let sourceOrder = 0; sourceOrder < execution.scenarios.length; sourceOrder += 1) {
      const scenario = execution.scenarios[sourceOrder];
      if (scenario === undefined || scenario.status === 'SKIPPED') continue;
      const scenarioEvidence = evidenceByScenario.get(scenario.id) ?? [];
      const reproduced = reproducedReferences(scenario);
      const reproducedEvidence = scenarioEvidence.filter((entry) =>
        reproduced.execution.has(entry.id),
      );
      const associatedExecutionEvidenceRefs = scenarioEvidence.map((entry) => entry.id);

      if (scenario.status === 'FAIL') {
        const failedStep = scenario.steps.find((step) => step.status === 'FAIL');
        if (failedStep === undefined) continue;
        const signature = this.signatures.structural(scenario, failedStep);
        ranked.push({
          sourceOrder,
          candidate: {
            id: candidateId(
              execution.executionId,
              scenario.planScenarioId,
              'STRUCTURAL_MISMATCH',
              signature.hash,
            ),
            scenarioId: scenario.planScenarioId,
            sourceScenarioExecutionId: scenario.id,
            sourceExecutionId: execution.executionId,
            triggerKind: 'STRUCTURAL_MISMATCH',
            sourceStatus: scenario.status,
            sourceEvidenceRefs: reproduced.source,
            sourceExecutionEvidenceRefs: reproducedEvidence.map((entry) => entry.id),
            sourceFailureCode: failedStep.failureCode,
            sourceStepId: failedStep.planStepId,
            priority: scenario.priority,
            rerun: true,
            signature,
            associatedSourceExecutionEvidenceRefs: associatedExecutionEvidenceRefs,
          },
        });
        continue;
      }

      if (scenario.status === 'BLOCKED' || scenario.status === 'ERROR') {
        const trigger = scenario.status === 'BLOCKED' ? 'SOURCE_BLOCKED' : 'EXECUTION_ERROR';
        const signature = this.signatures.sourceStatus(scenario, trigger);
        ranked.push({
          sourceOrder,
          candidate: {
            id: candidateId(
              execution.executionId,
              scenario.planScenarioId,
              trigger,
              signature.hash,
            ),
            scenarioId: scenario.planScenarioId,
            sourceScenarioExecutionId: scenario.id,
            sourceExecutionId: execution.executionId,
            triggerKind: trigger,
            sourceStatus: scenario.status,
            sourceEvidenceRefs: reproduced.source,
            sourceExecutionEvidenceRefs: reproducedEvidence.map((entry) => entry.id),
            sourceFailureCode: scenario.failureCode,
            sourceStepId:
              scenario.steps.find((step) => step.status === scenario.status)?.planStepId ?? null,
            priority: scenario.priority,
            rerun: false,
            signature,
            associatedSourceExecutionEvidenceRefs: associatedExecutionEvidenceRefs,
          },
        });
        continue;
      }

      const signals = reproducedEvidence
        .map((entry) => ({ entry, trigger: verificationTriggerForEvidence(entry, sourceOrigin) }))
        .filter(
          (
            item,
          ): item is {
            readonly entry: ExecutionEvidenceEntry;
            readonly trigger: VerificationTriggerKind;
          } => item.trigger !== null,
        )
        .sort(
          (left, right) =>
            TRIGGER_RANK[left.trigger] - TRIGGER_RANK[right.trigger] ||
            left.entry.id.localeCompare(right.entry.id),
        );
      const primary = signals[0];
      if (
        primary === undefined ||
        primary.trigger === 'STRUCTURAL_MISMATCH' ||
        primary.trigger === 'SOURCE_BLOCKED' ||
        primary.trigger === 'EXECUTION_ERROR'
      ) {
        continue;
      }
      const sourceStep = scenario.steps.find((step) => step.id === primary.entry.stepId);
      const signature = this.signatures.evidence(
        scenario.planScenarioId,
        sourceStep?.planStepId ?? null,
        primary.entry,
        primary.trigger,
      );
      ranked.push({
        sourceOrder,
        candidate: {
          id: candidateId(
            execution.executionId,
            scenario.planScenarioId,
            primary.trigger,
            signature.hash,
          ),
          scenarioId: scenario.planScenarioId,
          sourceScenarioExecutionId: scenario.id,
          sourceExecutionId: execution.executionId,
          triggerKind: primary.trigger,
          sourceStatus: scenario.status,
          sourceEvidenceRefs: reproduced.source,
          sourceExecutionEvidenceRefs: reproducedEvidence.map((entry) => entry.id),
          sourceFailureCode: null,
          sourceStepId: sourceStep?.planStepId ?? null,
          priority: scenario.priority,
          rerun: true,
          signature,
          associatedSourceExecutionEvidenceRefs: associatedExecutionEvidenceRefs,
        },
      });
    }

    return ranked
      .sort(
        (left, right) =>
          TRIGGER_RANK[left.candidate.triggerKind] - TRIGGER_RANK[right.candidate.triggerKind] ||
          PRIORITY_RANK[left.candidate.priority] - PRIORITY_RANK[right.candidate.priority] ||
          left.sourceOrder - right.sourceOrder ||
          left.candidate.id.localeCompare(right.candidate.id),
      )
      .map((item) => item.candidate);
  }
}
