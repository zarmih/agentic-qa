import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionRun } from '../../src/domain/execution.js';
import type { QaPlan } from '../../src/domain/planning.js';
import type { FindingsArtifact, VerificationRun } from '../../src/domain/verification.js';
import { startFakeLlmServer, type FakeLlmServer } from '../fixtures/fake-llm-server.js';
import { startMiniAppServer, type MiniAppServer } from '../fixtures/mini-app-server.js';
import { verificationPlanFromRequest } from '../fixtures/verification-plan-proposal.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
let miniApp: MiniAppServer;
let temporaryDirectory = '';

beforeAll(async () => {
  miniApp = await startMiniAppServer();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-verify-e2e-'));
});

afterAll(async () => {
  await miniApp.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function onlyChild(directory: string): Promise<string> {
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] === undefined) {
    throw new Error(`Expected one artifact in ${directory}; received ${entries.join(', ')}`);
  }
  return entries[0];
}

describe('agentic-qa verify', () => {
  it('runs the real local CLI pipeline and classifies stable, flaky, fixed, and inconclusive outcomes', async () => {
    const artifacts = join(temporaryDirectory, 'runs');
    miniApp.setVerificationMode('baseline');
    const explorationCli = await runCli(projectRoot, [
      'explore',
      `${miniApp.baseUrl}/verification`,
      '--interactive',
      '--artifacts-dir',
      artifacts,
      '--max-pages',
      '7',
      '--max-depth',
      '1',
      '--max-states',
      '40',
      '--max-actions-per-state',
      '10',
      '--max-state-depth',
      '1',
      '--timeout',
      '3000',
    ]);
    expect(explorationCli).toMatchObject({ code: 0, stderr: '' });
    const runName = await onlyChild(artifacts);
    const runDirectory = join(artifacts, runName);
    const explorationFile = join(runDirectory, 'exploration.json');

    let provider: FakeLlmServer | null = null;
    try {
      provider = await startFakeLlmServer((request) => ({
        content: JSON.stringify(verificationPlanFromRequest(request)),
        usage: { prompt_tokens: 240, completion_tokens: 160, total_tokens: 400 },
      }));
      const planningCli = await runCli(
        projectRoot,
        ['plan', explorationFile, '--provider', 'openai-compatible', '--model', 'verify-fixture'],
        {
          AGENTIC_QA_LLM_BASE_URL: provider.baseUrl,
          AGENTIC_QA_LLM_TIMEOUT_MS: '3000',
        },
      );
      expect(planningCli).toMatchObject({ code: 0, stderr: '' });
    } finally {
      await provider?.close();
    }
    const planFile = join(runDirectory, 'planning', 'qa-plan.json');
    const plan = JSON.parse(await readFile(planFile, 'utf8')) as QaPlan;
    expect(
      plan.scenarios.filter((scenario) => scenario.executability === 'AUTOMATABLE'),
    ).toHaveLength(6);
    expect(
      plan.scenarios.filter((scenario) => scenario.executability === 'MANUAL_ONLY'),
    ).toHaveLength(1);

    miniApp.setVerificationMode('source');
    const sourceRunCli = await runCli(projectRoot, [
      'run',
      planFile,
      '--step-timeout',
      '3000',
      '--execution-timeout',
      '120000',
    ]);
    expect(sourceRunCli.code).toBe(1);
    expect(sourceRunCli.stderr).toBe('');
    const sourceExecutionId = await onlyChild(join(runDirectory, 'executions'));
    const executionFile = join(runDirectory, 'executions', sourceExecutionId, 'execution.json');
    const sourceExecution = JSON.parse(await readFile(executionFile, 'utf8')) as ExecutionRun;
    expect(sourceExecution).toMatchObject({ schemaVersion: '1.1' });
    expect(sourceExecution.executionIntegrity.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceExecution.summary).toMatchObject({
      passed: 1,
      failed: 5,
      blocked: 0,
      errors: 0,
      skipped: 1,
    });
    expect(sourceExecution.summary.evidenceReproduced).toBeGreaterThanOrEqual(1);

    miniApp.setVerificationMode('verify');
    const verifyCli = await runCli(
      projectRoot,
      ['verify', executionFile, '--attempts', '3', '--max-findings', '10'],
      {
        AGENTIC_QA_STEP_TIMEOUT_MS: '3000',
        AGENTIC_QA_EXECUTION_TIMEOUT_MS: '120000',
        AGENTIC_QA_VERIFY_TIMEOUT_MS: '600000',
      },
    );
    expect(verifyCli.code).toBe(1);
    expect(verifyCli.stderr).toBe('');
    expect(verifyCli.stdout).toContain('Agentic QA Verify complete with findings');

    const verificationId = await onlyChild(join(runDirectory, 'verifications'));
    const verificationDirectory = join(runDirectory, 'verifications', verificationId);
    const verification = JSON.parse(
      await readFile(join(verificationDirectory, 'verification.json'), 'utf8'),
    ) as VerificationRun;
    const findings = JSON.parse(
      await readFile(join(verificationDirectory, 'findings.json'), 'utf8'),
    ) as FindingsArtifact;
    expect(verification.summary).toMatchObject({
      candidatesDiscovered: 6,
      candidatesSelected: 6,
      attemptsRequested: 18,
      attemptsCompleted: 18,
      validAttempts: 15,
      confirmed: 2,
      probable: 0,
      flaky: 1,
      notReproduced: 1,
      inconclusive: 2,
      infrastructureErrors: 0,
    });
    expect(findings.findings).toHaveLength(6);
    const verdict = (scenarioId: string) =>
      findings.findings.find((finding) => finding.scenarioId === scenarioId)?.verdict;
    expect(verdict('scenario-verify-stable')).toBe('CONFIRMED_DEFECT');
    expect(verdict('scenario-verify-http')).toBe('CONFIRMED_DEFECT');
    expect(verdict('scenario-verify-flaky')).toBe('FLAKY_DEFECT');
    expect(verdict('scenario-verify-fixed')).toBe('NOT_REPRODUCED');
    expect(verdict('scenario-verify-inconclusive')).toBe('INCONCLUSIVE');
    expect(verdict('scenario-verify-varied')).toBe('INCONCLUSIVE');
    const httpFinding = findings.findings.find(
      (finding) => finding.scenarioId === 'scenario-verify-http',
    );
    expect(httpFinding).toMatchObject({
      category: 'HTTP',
      severity: 'HIGH',
      confidence: 'VERY_HIGH',
      evidence: {
        relation: 'ASSOCIATED_NOT_CAUSAL',
      },
      rootCause: null,
    });
    expect(httpFinding?.evidence.kinds).toContain('HTTP_ERROR');

    const attempts = Object.values(verification.attempts).flat();
    expect(attempts).toHaveLength(18);
    expect(attempts.every((attempt) => attempt.executionArtifact !== null)).toBe(true);
    let traceBytes = 0;
    let screenshots = 0;
    for (const attempt of attempts) {
      if (attempt.traceArtifact === null || attempt.executionArtifact === null) continue;
      const trace = await readFile(join(verificationDirectory, attempt.traceArtifact));
      traceBytes += trace.length;
      expect(trace.subarray(0, 2).toString('ascii')).toBe('PK');
      expect(
        JSON.parse(await readFile(join(verificationDirectory, attempt.executionArtifact), 'utf8')),
      ).toMatchObject({
        schemaVersion: '1.1',
        sourceRunId: sourceExecution.sourceRunId,
      });
      for (const screenshot of attempt.screenshotRefs) {
        expect((await stat(join(verificationDirectory, screenshot))).size).toBeGreaterThan(100);
        screenshots += 1;
      }
    }
    expect(traceBytes).toBeGreaterThan(1_000);
    expect(screenshots).toBeGreaterThanOrEqual(30);
    const markdown = await readFile(join(verificationDirectory, 'verification.md'), 'utf8');
    expect(markdown).toContain('# Agentic QA Verification Report');
    expect(markdown).toContain('correlation is not proof of causation');
    expect(markdown).not.toMatch(/root cause:/i);

    expect(await miniApp.verificationAttempts()).toMatchObject({
      stable: 3,
      flaky: 3,
      fixed: 3,
      inconclusive: 0,
      varied: 3,
      http: 3,
    });
    expect(await miniApp.counters()).toMatchObject({
      delete: 0,
      logout: 0,
      buy: 0,
      checkout: 0,
      publish: 0,
      reset: 0,
      unsubscribe: 0,
      formSubmit: 0,
    });

    const originalExecution = await readFile(executionFile, 'utf8');
    const tampered = JSON.parse(originalExecution) as ExecutionRun;
    const firstScenario = tampered.scenarios[0];
    if (firstScenario === undefined) throw new Error('Source scenario is missing.');
    await writeFile(
      executionFile,
      JSON.stringify({ ...tampered, scenarios: [{ ...firstScenario, status: 'PASS' }] }),
    );
    const rejected = await runCli(projectRoot, ['verify', executionFile, '--attempts', '2']);
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain('payload digest');
    expect(await readdir(join(runDirectory, 'verifications'))).toHaveLength(1);
    await writeFile(executionFile, originalExecution);
  }, 360_000);
});
