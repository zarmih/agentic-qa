import { describe, expect, it } from 'vitest';
import { executionExitCode } from '../../src/application/run-qa-plan.js';
import { ExecutionIntegrityService } from '../../src/application/execution-integrity.js';
import type { ExecutionRun } from '../../src/domain/execution.js';
import { ExecutionMarkdownRenderer } from '../../src/reporting/execution-markdown.js';
import { executionPlanFixture } from '../fixtures/execution-fixtures.js';

function executionResult(): ExecutionRun {
  const { plan } = executionPlanFixture();
  const result: Omit<ExecutionRun, 'executionIntegrity'> = {
    schemaVersion: '1.1',
    executionId: 'exec-fixture',
    sourceRunId: plan.sourceRunId,
    planId: plan.planId,
    startedAt: '2026-08-28T00:00:00.000Z',
    completedAt: '2026-08-28T00:00:01.000Z',
    durationMs: 1_000,
    environment: {
      nodeVersion: 'v24.0.0',
      platform: 'test',
      browserName: 'chromium',
      browserVersion: 'fixture',
      viewport: { width: 1000, height: 700 },
    },
    summary: {
      scenariosInPlan: 2,
      automatableScenarios: 1,
      selectedScenarios: 1,
      passed: 0,
      failed: 1,
      blocked: 0,
      errors: 0,
      skipped: 1,
      stepsExecuted: 1,
      evidenceCaptured: 1,
      evidenceReproduced: 1,
      evidenceEvaluated: 1,
      limitReached: [],
    },
    scenarios: [
      {
        id: 'execution-scenario-001',
        planScenarioId: 'scenario-click',
        title: 'Help transition',
        priority: 'HIGH',
        plannedExecutability: 'AUTOMATABLE',
        status: 'FAIL',
        startedAt: '2026-08-28T00:00:00.000Z',
        completedAt: '2026-08-28T00:00:01.000Z',
        durationMs: 1_000,
        failureCode: 'STATE_DRIFT',
        message: 'Expected state did not match.',
        steps: [],
        evidenceReproduction: [
          {
            sourceEvidenceRef: 'console-error-001',
            status: 'REPRODUCED',
            executionEvidenceRefs: ['runtime-evidence-00001'],
          },
        ],
        screenshotRefs: ['screenshots/scenario-001/001-fail.png'],
      },
    ],
    evidence: [
      {
        id: 'runtime-evidence-00001',
        executionId: 'exec-fixture',
        kind: 'CONSOLE_ERROR',
        timestamp: '2026-08-28T00:00:00.500Z',
        scenarioId: 'execution-scenario-001',
        stepId: 'execution-step-001-001',
        pageId: 'page-001',
        sourceStateId: 'state-001',
        actualStateId: null,
        url: 'http://fixture.test/',
        message: 'Observed runtime error',
        method: null,
        status: null,
        resourceType: null,
      },
    ],
    sourceIntegrity: { ...plan.metadata.sourceIntegrity, planDigest: 'a'.repeat(64) },
    artifacts: {
      report: 'execution.json',
      markdown: 'execution.md',
      trace: 'trace.zip',
      screenshotsDirectory: 'screenshots',
    },
  };
  return { ...result, executionIntegrity: new ExecutionIntegrityService().create(result) };
}

describe('execution reporting', () => {
  it('uses deterministic CI exit codes', () => {
    expect(executionExitCode({ errors: 0, failed: 0, blocked: 0 })).toBe(0);
    expect(executionExitCode({ errors: 0, failed: 1, blocked: 0 })).toBe(1);
    expect(executionExitCode({ errors: 0, failed: 0, blocked: 1 })).toBe(1);
    expect(executionExitCode({ errors: 1, failed: 1, blocked: 1 })).toBe(2);
  });

  it('renders deterministic Markdown without interpreting free-text assertions', () => {
    const run = executionResult();
    const markdown = new ExecutionMarkdownRenderer().render(run);
    expect(markdown).toContain('# Agentic QA Execution Report');
    expect(markdown).toContain('## Failed scenarios');
    expect(markdown).toContain('console-error-001');
    expect(markdown).toContain('## Runtime evidence');
    expect(markdown).toContain('Observed runtime error');
    expect(markdown).toContain('Natural-language expected outcomes');
    expect(
      new ExecutionMarkdownRenderer().render(JSON.parse(JSON.stringify(run)) as ExecutionRun),
    ).toBe(markdown);
  });
});
