import type { ExecutionEvidenceEntry, ExecutionRun, ExecutionStatus } from '../domain/execution.js';
import type { ExplorationResult } from '../domain/exploration.js';
import { compareStrings } from '../domain/determinism.js';
import type { QaPlan, TestScenario } from '../domain/planning.js';
import type {
  DefectCategory,
  DefectConfidence,
  DefectFinding,
  DefectSeverity,
  DefectVerdict,
  FlakinessProfile,
  ReproducibilityClassification,
  VerificationAttempt,
  VerificationCandidate,
} from '../domain/verification.js';

const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'PASS',
  'FAIL',
  'BLOCKED',
  'ERROR',
  'SKIPPED',
];

export interface ReproducibilityResult {
  readonly classification: ReproducibilityClassification;
  readonly verdict: DefectVerdict;
  readonly profile: FlakinessProfile;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return null;
  if (sorted.length % 2 === 1) return value;
  const prior = sorted[middle - 1];
  return prior === undefined ? value : Math.round((prior + value) / 2);
}

export class ReproducibilityClassifier {
  public classify(
    candidate: VerificationCandidate,
    attempts: readonly VerificationAttempt[],
    attemptsRequested: number,
  ): ReproducibilityResult {
    const valid = attempts.filter((attempt) => ['PASS', 'FAIL'].includes(attempt.status));
    const matching = valid.filter((attempt) => attempt.signalReproduced === true);
    const signatures = new Map<string, { normalized: string; count: number }>();
    for (const attempt of valid) {
      if (attempt.signature === null) continue;
      const current = signatures.get(attempt.signature.hash);
      signatures.set(attempt.signature.hash, {
        normalized: attempt.signature.normalized,
        count: (current?.count ?? 0) + 1,
      });
    }
    const signatureDistribution = [...signatures.entries()]
      .map(([signatureHash, value]) => ({ signatureHash, ...value }))
      .sort(
        (left, right) =>
          right.count - left.count || compareStrings(left.signatureHash, right.signatureHash),
      );
    const incompatible = signatureDistribution.some(
      (entry) => entry.signatureHash !== candidate.signature.hash,
    );
    const statusDistribution = Object.fromEntries(
      EXECUTION_STATUSES.map((status) => [
        status,
        attempts.filter((attempt) => attempt.status === status).length,
      ]),
    ) as Record<ExecutionStatus, number>;
    const durations = attempts.map((attempt) => attempt.durationMs);
    const observedVariance: string[] = [];
    if (EXECUTION_STATUSES.filter((status) => statusDistribution[status] > 0).length > 1) {
      observedVariance.push('status');
    }
    if (signatureDistribution.length > 1) observedVariance.push('failure_signature');
    if (new Set(attempts.map((attempt) => attempt.actualFingerprint).filter(Boolean)).size > 1) {
      observedVariance.push('actual_fingerprint');
    }
    if (new Set(attempts.map((attempt) => attempt.actualUrl).filter(Boolean)).size > 1) {
      observedVariance.push('actual_url');
    }
    if (valid.length < attempts.length) observedVariance.push('invalid_attempt');

    const profile: FlakinessProfile = {
      attemptsRequested,
      attemptsCompleted: attempts.length,
      validAttempts: valid.length,
      matchingAttempts: matching.length,
      reproductionRate: valid.length === 0 ? 0 : matching.length / valid.length,
      statusDistribution,
      signatureDistribution,
      dominantSignature: signatureDistribution[0]?.signatureHash ?? null,
      durationMinMs: durations.length === 0 ? null : Math.min(...durations),
      durationMaxMs: durations.length === 0 ? null : Math.max(...durations),
      durationMedianMs: median(durations),
      observedVariance,
    };

    if (!candidate.rerun || valid.length < 2 || incompatible) {
      return { classification: 'INCONCLUSIVE', verdict: 'INCONCLUSIVE', profile };
    }
    if (matching.length === 0) {
      return { classification: 'NOT_REPRODUCED', verdict: 'NOT_REPRODUCED', profile };
    }
    if (matching.length < valid.length) {
      return { classification: 'INTERMITTENT', verdict: 'FLAKY_DEFECT', profile };
    }
    if (valid.length === attemptsRequested && valid.length >= 3) {
      return { classification: 'CONSISTENT', verdict: 'CONFIRMED_DEFECT', profile };
    }
    return { classification: 'CONSISTENT', verdict: 'PROBABLE_DEFECT', profile };
  }
}

function category(candidate: VerificationCandidate): DefectCategory {
  switch (candidate.triggerKind) {
    case 'STRUCTURAL_MISMATCH':
      return candidate.sourceFailureCode === 'PAGE_URL_DRIFT' ? 'NAVIGATION' : 'UI_STATE';
    case 'HTTP_SERVER_ERROR':
      return 'HTTP';
    case 'PAGE_ERROR':
    case 'CONSOLE_ERROR':
      return 'JAVASCRIPT';
    case 'FAILED_REQUEST':
      return 'NETWORK';
    case 'SOURCE_BLOCKED':
    case 'EXECUTION_ERROR':
      return 'RELIABILITY';
  }
}

function severity(candidate: VerificationCandidate, verdict: DefectVerdict): DefectSeverity {
  if (['NOT_REPRODUCED', 'INCONCLUSIVE', 'NON_DEFECT_SIGNAL'].includes(verdict)) return 'INFO';
  if (candidate.triggerKind === 'CONSOLE_ERROR') return 'LOW';
  if (candidate.triggerKind === 'HTTP_SERVER_ERROR') {
    return ['CONFIRMED_DEFECT', 'PROBABLE_DEFECT'].includes(verdict) &&
      ['CRITICAL', 'HIGH'].includes(candidate.priority)
      ? 'HIGH'
      : 'MEDIUM';
  }
  if (candidate.triggerKind === 'PAGE_ERROR' || candidate.triggerKind === 'FAILED_REQUEST') {
    return 'MEDIUM';
  }
  if (candidate.triggerKind === 'STRUCTURAL_MISMATCH') {
    if (
      candidate.priority === 'CRITICAL' &&
      ['CONFIRMED_DEFECT', 'PROBABLE_DEFECT'].includes(verdict)
    ) {
      return 'HIGH';
    }
    return candidate.priority === 'LOW' && verdict === 'FLAKY_DEFECT' ? 'LOW' : 'MEDIUM';
  }
  return 'INFO';
}

function confidence(verdict: DefectVerdict, profile: FlakinessProfile): DefectConfidence {
  switch (verdict) {
    case 'CONFIRMED_DEFECT':
      return 'VERY_HIGH';
    case 'PROBABLE_DEFECT':
      return 'HIGH';
    case 'FLAKY_DEFECT':
      return 'MEDIUM';
    case 'NOT_REPRODUCED':
      return profile.validAttempts >= 3 ? 'HIGH' : 'MEDIUM';
    case 'INCONCLUSIVE':
      return 'LOW';
    case 'NON_DEFECT_SIGNAL':
      return 'MEDIUM';
  }
}

function title(candidate: VerificationCandidate, scenario: TestScenario): string {
  switch (candidate.triggerKind) {
    case 'STRUCTURAL_MISMATCH':
      return candidate.sourceFailureCode === 'PAGE_URL_DRIFT'
        ? `${scenario.title}: navigation does not reach the observed page`
        : `${scenario.title}: transition does not reach the observed UI state`;
    case 'HTTP_SERVER_ERROR':
      return `${scenario.title}: HTTP server error repeats during the scenario`;
    case 'PAGE_ERROR':
      return `${scenario.title}: uncaught page error repeats during the scenario`;
    case 'FAILED_REQUEST':
      return `${scenario.title}: network request repeatedly fails`;
    case 'CONSOLE_ERROR':
      return `${scenario.title}: console error repeats during the scenario`;
    case 'SOURCE_BLOCKED':
      return `${scenario.title}: verification is blocked by runtime safety or drift`;
    case 'EXECUTION_ERROR':
      return `${scenario.title}: verification is inconclusive after an execution error`;
  }
}

function reproductionSteps(scenario: TestScenario, source: ExplorationResult): readonly string[] {
  const pages = new Map(source.graph.nodes.map((page) => [page.id, page]));
  const actions = new Map(source.stateGraph?.edges.map((action) => [action.id, action]) ?? []);
  return scenario.steps.map((step, index) => {
    if (step.action === 'NAVIGATE') {
      const page = step.target.pageId === undefined ? undefined : pages.get(step.target.pageId);
      return `${String(index + 1)}. Navigate to ${page?.finalUrl ?? step.target.pageId ?? 'unknown page'}`;
    }
    if (step.action === 'CLICK') {
      const action =
        step.target.actionId === undefined ? undefined : actions.get(step.target.actionId);
      if (action !== undefined) {
        return `${String(index + 1)}. Click role=${action.action.role} name="${action.action.accessibleName}" (${action.id})`;
      }
    }
    return `${String(index + 1)}. ${step.action} remains unsupported for automatic reproduction`;
  });
}

function unique<Value extends string>(
  values: readonly (Value | null | undefined)[],
): readonly Value[] {
  return [
    ...new Set(values.filter((value): value is Value => value !== null && value !== undefined)),
  ].sort();
}

export class DefectFindingFactory {
  public create(input: {
    readonly candidate: VerificationCandidate;
    readonly attempts: readonly VerificationAttempt[];
    readonly result: ReproducibilityResult;
    readonly plan: QaPlan;
    readonly source: ExplorationResult;
    readonly execution: ExecutionRun;
    readonly verifiedAt: string;
    readonly sourceScreenshotPrefix: string;
  }): DefectFinding {
    const scenario = input.plan.scenarios.find((item) => item.id === input.candidate.scenarioId);
    const sourceScenario = input.execution.scenarios.find(
      (item) => item.id === input.candidate.sourceScenarioExecutionId,
    );
    if (scenario === undefined || sourceScenario === undefined) {
      throw new Error(`Verification candidate ${input.candidate.id} lost its grounded scenario.`);
    }
    const sourceEvidenceById = new Map(input.execution.evidence.map((entry) => [entry.id, entry]));
    const associated = input.candidate.associatedSourceExecutionEvidenceRefs
      .map((id) => sourceEvidenceById.get(id))
      .filter((entry): entry is ExecutionEvidenceEntry => entry !== undefined);
    const affectedPages = unique([
      ...scenario.sourcePageIds,
      ...associated.map((entry) => entry.pageId),
      ...sourceScenario.steps.flatMap((step) => [
        step.transition.plannedSourcePageId,
        step.transition.plannedTargetPageId,
      ]),
    ]);
    const affectedStates = unique([
      ...scenario.sourceStateIds,
      ...associated.flatMap((entry) => [entry.sourceStateId, entry.actualStateId]),
      ...sourceScenario.steps.flatMap((step) => [
        step.transition.plannedSourceStateId,
        step.transition.plannedTargetStateId,
      ]),
    ]);
    const actual = unique(
      input.attempts.flatMap((attempt) => [
        attempt.actualFingerprint,
        attempt.actualUrl,
        attempt.signature?.actual,
      ]),
    );
    return {
      id: `DEF-${input.candidate.signature.hash.slice(0, 8).toUpperCase()}`,
      title: title(input.candidate, scenario),
      category: category(input.candidate),
      verdict: input.result.verdict,
      severity: severity(input.candidate, input.result.verdict),
      confidence: confidence(input.result.verdict, input.result.profile),
      scenarioId: input.candidate.scenarioId,
      stepId: input.candidate.sourceStepId,
      sourceExecutionId: input.execution.executionId,
      signature: input.candidate.signature,
      reproducibility: input.result.classification,
      profile: input.result.profile,
      attempts: input.attempts,
      evidence: {
        relation: 'ASSOCIATED_NOT_CAUSAL',
        sourceEvidenceRefs: input.candidate.sourceEvidenceRefs,
        sourceExecutionEvidenceRefs: input.candidate.sourceExecutionEvidenceRefs,
        attemptEvidenceRefs: unique(input.attempts.flatMap((attempt) => attempt.evidenceRefs)),
        kinds: unique(associated.map((entry) => entry.kind)),
        summaries: unique(associated.map((entry) => entry.message)),
      },
      expected: input.candidate.signature.expected,
      actual,
      affectedPages,
      affectedStates,
      reproductionSteps: reproductionSteps(scenario, input.source),
      sourceScreenshotRefs: sourceScenario.screenshotRefs.map(
        (reference) => `${input.sourceScreenshotPrefix}/${reference}`,
      ),
      firstObservedAt: sourceScenario.startedAt ?? input.execution.startedAt,
      verifiedAt: input.verifiedAt,
      rootCause: null,
    };
  }
}
