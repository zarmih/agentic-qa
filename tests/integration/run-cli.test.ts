import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionRun } from '../../src/domain/execution.js';
import type { QaPlan } from '../../src/domain/planning.js';
import {
  executionPlanProposal,
  extractPlanningObservation,
} from '../fixtures/execution-plan-proposal.js';
import { startFakeLlmServer, type FakeLlmServer } from '../fixtures/fake-llm-server.js';
import { startMiniAppServer, type MiniAppServer } from '../fixtures/mini-app-server.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
let miniApp: MiniAppServer;
let temporaryDirectory = '';

beforeAll(async () => {
  miniApp = await startMiniAppServer();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-run-e2e-'));
});

afterAll(async () => {
  await miniApp.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function executeAndRead(
  runDirectory: string,
  planFile: string,
  explorationFile?: string,
): Promise<{ readonly cli: Awaited<ReturnType<typeof runCli>>; readonly result: ExecutionRun }> {
  const executionsDirectory = join(runDirectory, 'executions');
  const before = new Set(await readdir(executionsDirectory).catch(() => []));
  const arguments_ = [
    'run',
    planFile,
    '--step-timeout',
    '3000',
    '--execution-timeout',
    '120000',
    ...(explorationFile === undefined ? [] : ['--exploration', explorationFile]),
  ];
  const cli = await runCli(projectRoot, arguments_);
  const after = await readdir(executionsDirectory);
  const created = after.find((entry) => !before.has(entry));
  if (created === undefined) {
    throw new Error(`Execution did not create an artifact directory: ${cli.stderr}`);
  }
  const result = JSON.parse(
    await readFile(join(executionsDirectory, created, 'execution.json'), 'utf8'),
  ) as ExecutionRun;
  return { cli, result };
}

function subsetPlan(plan: QaPlan, ...scenarioIds: readonly string[]): QaPlan {
  return {
    ...plan,
    planId: `plan-subset-${scenarioIds.join('-')}`.slice(0, 150),
    scenarios: plan.scenarios.filter((scenario) => scenarioIds.includes(scenario.id)),
  };
}

describe('agentic-qa run', () => {
  it('executes a full local CLI pipeline and blocks runtime/tampered safety bypasses', async () => {
    const artifacts = join(temporaryDirectory, 'runs');
    const exploration = await runCli(projectRoot, [
      'explore',
      `${miniApp.baseUrl}/execution`,
      '--interactive',
      '--artifacts-dir',
      artifacts,
      '--max-pages',
      '2',
      '--max-depth',
      '1',
      '--max-states',
      '20',
      '--max-actions-per-state',
      '20',
      '--max-state-depth',
      '1',
      '--timeout',
      '3000',
    ]);
    expect(exploration).toMatchObject({ code: 0, stderr: '' });
    const runNames = await readdir(artifacts);
    expect(runNames).toHaveLength(1);
    const runName = runNames[0];
    if (runName === undefined) throw new Error('Exploration did not create a run.');
    const runDirectory = join(artifacts, runName);
    const explorationFile = join(runDirectory, 'exploration.json');

    let provider: FakeLlmServer | null = null;
    try {
      provider = await startFakeLlmServer((request) => ({
        content: JSON.stringify(executionPlanProposal(extractPlanningObservation(request))),
        usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
      }));
      const planning = await runCli(
        projectRoot,
        [
          'plan',
          explorationFile,
          '--provider',
          'openai-compatible',
          '--model',
          'execution-fixture',
        ],
        {
          AGENTIC_QA_LLM_BASE_URL: provider.baseUrl,
          AGENTIC_QA_LLM_TIMEOUT_MS: '3000',
        },
      );
      expect(planning).toMatchObject({ code: 0, stderr: '' });
    } finally {
      await provider?.close();
    }

    const planningDirectory = join(runDirectory, 'planning');
    const planFile = join(planningDirectory, 'qa-plan.json');
    const plan = JSON.parse(await readFile(planFile, 'utf8')) as QaPlan;
    expect(plan.schemaVersion).toBe('1.1');
    expect(plan.metadata.sourceIntegrity.explorationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      plan.scenarios.filter((scenario) => scenario.executability === 'AUTOMATABLE'),
    ).toHaveLength(9);
    expect(
      plan.scenarios.find((scenario) => scenario.id === 'scenario-destructive-manual'),
    ).toMatchObject({ executability: 'MANUAL_ONLY' });

    const stable = await executeAndRead(runDirectory, planFile);
    expect(stable.cli).toMatchObject({ code: 0, stderr: '' });
    expect(stable.cli.stdout).toContain('Agentic QA Run complete');
    expect(stable.result.summary).toMatchObject({
      automatableScenarios: 9,
      selectedScenarios: 9,
      passed: 9,
      failed: 0,
      blocked: 0,
      errors: 0,
      skipped: 1,
    });
    expect(stable.result.summary.evidenceCaptured).toBeGreaterThanOrEqual(3);
    expect(stable.result.summary.evidenceReproduced).toBeGreaterThanOrEqual(3);
    expect(
      stable.result.scenarios.find((scenario) => scenario.planScenarioId === 'scenario-help'),
    ).toMatchObject({ status: 'PASS' });
    expect(stable.result.evidence.every((entry) => entry.scenarioId !== '')).toBe(true);
    expect(
      stable.result.evidence.every((entry) => entry.executionId === stable.result.executionId),
    ).toBe(true);

    const stableExecutionDirectory = join(runDirectory, 'executions', stable.result.executionId);
    const stableTrace = await readFile(join(stableExecutionDirectory, 'trace.zip'));
    expect(stableTrace.length).toBeGreaterThan(100);
    expect(stableTrace.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(await readFile(join(stableExecutionDirectory, 'execution.md'), 'utf8')).toContain(
      '# Agentic QA Execution Report',
    );
    expect((await stat(join(stableExecutionDirectory, 'execution.json'))).size).toBeGreaterThan(
      500,
    );
    const screenshotFiles = (
      await Promise.all(
        (await readdir(join(stableExecutionDirectory, 'screenshots'))).map(async (directory) =>
          readdir(join(stableExecutionDirectory, 'screenshots', directory)),
        ),
      )
    ).flat();
    expect(screenshotFiles.filter((name) => name.endsWith('.png')).length).toBeGreaterThanOrEqual(
      18,
    );

    const regressionPlan = subsetPlan(plan, 'scenario-regression');
    const regressionPlanFile = join(planningDirectory, 'qa-plan-regression.json');
    await writeFile(regressionPlanFile, `${JSON.stringify(regressionPlan, null, 2)}\n`);
    miniApp.setExecutionBehavior({ regression: 'wrong-state' });
    const regression = await executeAndRead(runDirectory, regressionPlanFile, explorationFile);
    expect(regression.cli.code).toBe(1);
    expect(regression.result.summary).toMatchObject({ failed: 1, blocked: 0, errors: 0 });
    expect(regression.result.scenarios[0]).toMatchObject({
      status: 'FAIL',
      failureCode: 'STATE_DRIFT',
    });

    const driftPlan = subsetPlan(plan, 'scenario-menu');
    const driftPlanFile = join(planningDirectory, 'qa-plan-drift.json');
    await writeFile(driftPlanFile, `${JSON.stringify(driftPlan, null, 2)}\n`);
    miniApp.setExecutionBehavior({ regression: 'stable', menu: 'destructive-drift' });
    const drift = await executeAndRead(runDirectory, driftPlanFile, explorationFile);
    expect(drift.cli.code).toBe(1);
    expect(drift.result.scenarios[0]).toMatchObject({
      status: 'BLOCKED',
      failureCode: 'ACTION_SEMANTIC_DRIFT',
    });

    const resolutionPlan = subsetPlan(plan, 'scenario-missing', 'scenario-ambiguous');
    const resolutionPlanFile = join(planningDirectory, 'qa-plan-resolution.json');
    await writeFile(resolutionPlanFile, `${JSON.stringify(resolutionPlan, null, 2)}\n`);
    miniApp.setExecutionBehavior({
      menu: 'stable',
      missingAction: true,
      ambiguousAction: true,
    });
    const resolution = await executeAndRead(runDirectory, resolutionPlanFile, explorationFile);
    expect(resolution.cli.code).toBe(1);
    expect(resolution.result.summary.blocked).toBe(2);
    expect(resolution.result.scenarios.map((scenario) => scenario.failureCode).sort()).toEqual([
      'ACTION_AMBIGUOUS',
      'ACTION_MISSING',
    ]);

    const beforeTampering = await readdir(join(runDirectory, 'executions'));
    const manual = plan.scenarios.find((scenario) => scenario.id === 'scenario-destructive-manual');
    if (manual === undefined) throw new Error('Manual safety scenario is missing.');
    const tamperedPlan: QaPlan = {
      ...plan,
      planId: 'plan-tampered-manual',
      scenarios: [{ ...manual, executability: 'AUTOMATABLE' }],
    };
    const tamperedPlanFile = join(planningDirectory, 'qa-plan-tampered.json');
    await writeFile(tamperedPlanFile, `${JSON.stringify(tamperedPlan, null, 2)}\n`);
    const tampered = await runCli(projectRoot, [
      'run',
      tamperedPlanFile,
      '--exploration',
      explorationFile,
    ]);
    expect(tampered.code).toBe(2);
    expect(tampered.stderr).toContain('manual safety cannot be overridden');

    const injected = structuredClone(subsetPlan(plan, 'scenario-navigation')) as unknown as Record<
      string,
      unknown
    >;
    const injectedScenarios = injected.scenarios as Record<string, unknown>[];
    const injectedSteps = injectedScenarios[0]?.steps as Record<string, unknown>[];
    const injectedTarget = injectedSteps[0]?.target as Record<string, unknown>;
    injectedTarget.url = 'https://external.invalid/delete';
    injectedTarget.selector = 'xpath=/html/body/button[99]';
    const injectedPlanFile = join(planningDirectory, 'qa-plan-injected.json');
    await writeFile(injectedPlanFile, `${JSON.stringify(injected, null, 2)}\n`);
    const injectedRun = await runCli(projectRoot, [
      'run',
      injectedPlanFile,
      '--exploration',
      explorationFile,
    ]);
    expect(injectedRun.code).toBe(2);
    expect(injectedRun.stderr).toMatch(/unrecognized/i);
    expect(await readdir(join(runDirectory, 'executions'))).toHaveLength(beforeTampering.length);

    const counters = await miniApp.counters();
    expect(counters).toMatchObject({
      delete: 0,
      logout: 0,
      buy: 0,
      checkout: 0,
      publish: 0,
      reset: 0,
      unsubscribe: 0,
      formSubmit: 0,
    });
    expect(await readdir(join(runDirectory, 'executions'))).toHaveLength(4);
  }, 240_000);
});
