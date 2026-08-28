import { ExecutionIntegrityService } from '../../src/application/execution-integrity.js';
import { SourceIntegrityService } from '../../src/application/source-integrity.js';
import type { LoadedVerificationSource } from '../../src/application/verification-ports.js';
import type {
  ExecutionEvidenceEntry,
  ExecutionRun,
  ExecutionStatus,
  ScenarioExecution,
} from '../../src/domain/execution.js';
import { clickScenario, executionPlanFixture } from './execution-fixtures.js';

export function verificationExecutionFixture(
  status: Extract<ExecutionStatus, 'PASS' | 'FAIL' | 'BLOCKED' | 'ERROR'> = 'FAIL',
  evidence: readonly ExecutionEvidenceEntry[] = [],
): LoadedVerificationSource {
  const fixture = executionPlanFixture([clickScenario()]);
  const graph = fixture.loaded.exploration.stateGraph;
  const planScenario = fixture.plan.scenarios[0];
  if (graph === null || planScenario === undefined)
    throw new Error('Invalid verification fixture.');
  const target = graph.nodes.find((state) => state.id === 'state-002');
  if (target === undefined) throw new Error('Target fixture state is missing.');
  const actualFingerprint = status === 'PASS' ? target.fingerprint : 'f'.repeat(64);
  const stepStatus = status;
  const failureCode =
    status === 'FAIL'
      ? ('STATE_DRIFT' as const)
      : status === 'BLOCKED'
        ? ('ACTION_SEMANTIC_DRIFT' as const)
        : status === 'ERROR'
          ? ('BROWSER_ERROR' as const)
          : null;
  const scenario: ScenarioExecution = {
    id: 'execution-scenario-001',
    planScenarioId: planScenario.id,
    title: planScenario.title,
    priority: planScenario.priority,
    plannedExecutability: planScenario.executability,
    status,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:01.000Z',
    durationMs: 1_000,
    failureCode,
    message: status === 'PASS' ? null : 'Controlled fixture outcome.',
    steps: [
      {
        id: 'execution-step-001-001',
        scenarioId: 'execution-scenario-001',
        planStepId: 'step-click',
        index: 0,
        action: 'CLICK',
        requestedTarget: { pageId: null, stateId: 'state-001', actionId: 'action-0001' },
        expectedFingerprint: target.fingerprint,
        actualUrl: 'http://fixture.test/',
        actualFingerprint,
        durationMs: 500,
        status: stepStatus,
        failureCode,
        message: status === 'PASS' ? null : 'Controlled fixture outcome.',
        evidenceRefs: evidence.map((entry) => entry.id),
        screenshotRefs: [
          `screenshots/scenario-001/001-${status === 'PASS' ? 'pass' : status.toLowerCase()}.png`,
        ],
        transition: {
          plannedSourcePageId: 'page-001',
          plannedSourceStateId: 'state-001',
          plannedTargetPageId: 'page-001',
          plannedTargetStateId: 'state-002',
          actualUrl: 'http://fixture.test/',
          actualFingerprint,
          match: status === 'PASS',
        },
      },
    ],
    evidenceReproduction: [
      {
        sourceEvidenceRef: 'action-0001-console-error-001',
        status: evidence.length > 0 ? 'REPRODUCED' : 'NOT_REPRODUCED',
        executionEvidenceRefs: evidence.map((entry) => entry.id),
      },
    ],
    screenshotRefs: ['screenshots/scenario-001/000-start.png'],
  };
  const sourceIntegrity = new SourceIntegrityService();
  const unsigned: Omit<ExecutionRun, 'executionIntegrity'> = {
    schemaVersion: '1.1',
    executionId: 'exec-verification-fixture',
    sourceRunId: fixture.plan.sourceRunId,
    planId: fixture.plan.planId,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:01.000Z',
    durationMs: 1_000,
    environment: {
      nodeVersion: 'v24.0.0',
      platform: 'test',
      browserName: 'chromium',
      browserVersion: 'fixture',
      viewport: { width: 1_000, height: 700 },
    },
    summary: {
      scenariosInPlan: 1,
      automatableScenarios: 1,
      selectedScenarios: 1,
      passed: status === 'PASS' ? 1 : 0,
      failed: status === 'FAIL' ? 1 : 0,
      blocked: status === 'BLOCKED' ? 1 : 0,
      errors: status === 'ERROR' ? 1 : 0,
      skipped: 0,
      stepsExecuted: 1,
      evidenceCaptured: evidence.length,
      evidenceReproduced: evidence.length > 0 ? 1 : 0,
      evidenceEvaluated: 1,
      limitReached: [],
    },
    scenarios: [scenario],
    evidence,
    sourceIntegrity: {
      ...fixture.plan.metadata.sourceIntegrity,
      planDigest: sourceIntegrity.planDigest(fixture.plan),
    },
    artifacts: {
      report: 'execution.json',
      markdown: 'execution.md',
      trace: 'trace.zip',
      screenshotsDirectory: 'screenshots',
    },
  };
  const execution: ExecutionRun = {
    ...unsigned,
    executionIntegrity: new ExecutionIntegrityService().create(unsigned),
  };
  return {
    execution,
    executionFile: '/fixture/executions/exec-verification-fixture/execution.json',
    executionDirectory: '/fixture/executions/exec-verification-fixture',
    sourceExecutionRelativePath: '../../executions/exec-verification-fixture',
    runDirectory: '/fixture',
    planFile: fixture.loaded.planFile,
    explorationFile: fixture.loaded.explorationFile,
    executionInput: fixture.loaded,
  };
}
