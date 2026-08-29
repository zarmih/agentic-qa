import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionRun } from '../../src/domain/execution.js';
import type { QaPlan } from '../../src/domain/planning.js';
import type { FindingsArtifact, VerificationRun } from '../../src/domain/verification.js';
import type { RegressionManifest } from '../../src/domain/regression.js';
import { startFakeLlmServer, type FakeLlmServer } from '../fixtures/fake-llm-server.js';
import { startMiniAppServer, type MiniAppServer } from '../fixtures/mini-app-server.js';
import { verificationPlanFromRequest } from '../fixtures/verification-plan-proposal.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
let miniApp: MiniAppServer;
let temporaryDirectory = '';

beforeAll(async () => {
  miniApp = await startMiniAppServer();
  await mkdir(join(projectRoot, 'artifacts'), { recursive: true });
  temporaryDirectory = await mkdtemp(join(projectRoot, 'artifacts', 'stage7-e2e-'));
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

function runGeneratedSpec(specFile: string) {
  return new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const cli = join(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js');
    const child = spawn(
      process.execPath,
      [
        cli,
        'test',
        basename(specFile),
        `--config=${join(projectRoot, 'tests', 'fixtures', 'generated-playwright.config.ts')}`,
        '--timeout=10000',
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NO_COLOR: '1',
          AGENTIC_QA_GENERATED_TEST_DIR: dirname(specFile),
          AGENTIC_QA_GENERATED_TEST_OUTPUT: join(temporaryDirectory, 'playwright-results'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolveResult({ code, output });
    });
  });
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
      '8',
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
    ).toHaveLength(8);
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
      failed: 7,
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
      candidatesDiscovered: 8,
      candidatesSelected: 8,
      attemptsRequested: 24,
      attemptsCompleted: 24,
      validAttempts: 21,
      confirmed: 4,
      probable: 0,
      flaky: 1,
      notReproduced: 1,
      inconclusive: 2,
      infrastructureErrors: 0,
    });
    expect(findings.findings).toHaveLength(8);
    const verdict = (scenarioId: string) =>
      findings.findings.find((finding) => finding.scenarioId === scenarioId)?.verdict;
    expect(verdict('scenario-verify-stable')).toBe('CONFIRMED_DEFECT');
    expect(verdict('scenario-verify-http')).toBe('CONFIRMED_DEFECT');
    expect(verdict('scenario-verify-navigation')).toBe('CONFIRMED_DEFECT');
    expect(verdict('scenario-verify-navigation-duplicate')).toBe('CONFIRMED_DEFECT');
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
    expect(attempts).toHaveLength(24);
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
      navigation: 12,
    });

    const generationCli = await runCli(projectRoot, [
      'generate',
      join(verificationDirectory, 'findings.json'),
    ]);
    expect(generationCli).toMatchObject({ code: 0, stderr: '' });
    expect(generationCli.stdout).toContain('Agentic QA Regression Generation complete');
    const generationId = await onlyChild(join(runDirectory, 'regressions'));
    const generationDirectory = join(runDirectory, 'regressions', generationId);
    const manifest = JSON.parse(
      await readFile(join(generationDirectory, 'manifest.json'), 'utf8'),
    ) as RegressionManifest;
    expect(manifest.summary).toMatchObject({
      findings: 8,
      eligible: 4,
      generated: 3,
      generatedFixme: 0,
      reviewOnly: 0,
      unsupported: 0,
      skippedVerdict: 4,
      duplicates: 1,
    });
    const generatedEntries = manifest.tests.filter((entry) => entry.status === 'GENERATED');
    expect(generatedEntries).toHaveLength(3);
    expect(generatedEntries.every((entry) => entry.fileDigest?.match(/^[a-f0-9]{64}$/))).toBe(true);
    const stableFile = manifest.tests.find(
      (entry) => entry.scenarioId === 'scenario-verify-stable',
    )?.file;
    const httpFile = manifest.tests.find(
      (entry) => entry.scenarioId === 'scenario-verify-http',
    )?.file;
    const navigationFile = manifest.tests.find(
      (entry) => entry.scenarioId === 'scenario-verify-navigation',
    )?.file;
    if (
      stableFile === null ||
      stableFile === undefined ||
      httpFile === null ||
      httpFile === undefined ||
      navigationFile === null ||
      navigationFile === undefined
    ) {
      throw new Error('Expected UI, HTTP, and navigation regression files were not generated.');
    }
    const stableSpec = join(generationDirectory, stableFile);
    const httpSpec = join(generationDirectory, httpFile);
    const navigationSpec = join(generationDirectory, navigationFile);
    const stableSource = await readFile(stableSpec, 'utf8');
    const httpSource = await readFile(httpSpec, 'utf8');
    expect(stableSource).toMatch(/getByRole\(["']heading["']/);
    expect(stableSource).not.toContain('agentic-qa/src');
    expect(httpSource).toContain('toBeLessThan(500)');
    expect(await readFile(navigationSpec, 'utf8')).toContain('toHaveURL(');

    miniApp.setVerificationMode('verify');
    const uiBug = await runGeneratedSpec(stableSpec);
    expect(uiBug.code).toBe(1);
    expect(uiBug.output).toContain('1 failed');
    const httpBug = await runGeneratedSpec(httpSpec);
    expect(httpBug.code).toBe(1);
    expect(httpBug.output).toContain('1 failed');
    const navigationBug = await runGeneratedSpec(navigationSpec);
    expect(navigationBug.code).toBe(1);
    expect(navigationBug.output).toContain('1 failed');

    miniApp.setVerificationMode('healthy');
    const uiHealthy = await runGeneratedSpec(stableSpec);
    expect(uiHealthy.code, uiHealthy.output).toBe(0);
    expect(uiHealthy.output).toContain('1 passed');
    const httpHealthy = await runGeneratedSpec(httpSpec);
    expect(httpHealthy.code, httpHealthy.output).toBe(0);
    expect(httpHealthy.output).toContain('1 passed');
    const navigationHealthy = await runGeneratedSpec(navigationSpec);
    expect(navigationHealthy.code, navigationHealthy.output).toBe(0);
    expect(navigationHealthy.output).toContain('1 passed');
    expect(await miniApp.verificationAttempts()).toMatchObject({
      stable: 1,
      flaky: 0,
      fixed: 0,
      inconclusive: 0,
      varied: 0,
      http: 1,
      navigation: 1,
    });

    const includeFlakyCli = await runCli(projectRoot, [
      'generate',
      join(verificationDirectory, 'findings.json'),
      '--include-flaky',
    ]);
    expect(includeFlakyCli).toMatchObject({ code: 0, stderr: '' });
    const generationIds = await readdir(join(runDirectory, 'regressions'));
    expect(generationIds).toHaveLength(2);
    const flakyGenerationId = generationIds.find((id) => id !== generationId);
    if (flakyGenerationId === undefined) throw new Error('Flaky generation is missing.');
    const flakyManifest = JSON.parse(
      await readFile(join(runDirectory, 'regressions', flakyGenerationId, 'manifest.json'), 'utf8'),
    ) as RegressionManifest;
    const flakyEntry = flakyManifest.tests.find(
      (entry) => entry.scenarioId === 'scenario-verify-flaky',
    );
    expect(flakyEntry?.status).toBe('GENERATED_FIXME');
    if (flakyEntry?.file === null || flakyEntry?.file === undefined) {
      throw new Error('Flaky fixme file is missing.');
    }
    const flakySpec = join(runDirectory, 'regressions', flakyGenerationId, flakyEntry.file);
    expect(await readFile(flakySpec, 'utf8')).toContain('test.fixme(');
    const flakyRun = await runGeneratedSpec(flakySpec);
    expect(flakyRun.code, flakyRun.output).toBe(0);
    expect(flakyRun.output).toContain('1 skipped');

    const limitedCli = await runCli(projectRoot, [
      'generate',
      join(verificationDirectory, 'findings.json'),
      '--max-tests',
      '1',
    ]);
    expect(limitedCli).toMatchObject({ code: 0, stderr: '' });
    const limitedGenerationId = (await readdir(join(runDirectory, 'regressions'))).find(
      (id) => ![generationId, flakyGenerationId].includes(id),
    );
    if (limitedGenerationId === undefined) throw new Error('Limited generation is missing.');
    const limitedManifest = JSON.parse(
      await readFile(
        join(runDirectory, 'regressions', limitedGenerationId, 'manifest.json'),
        'utf8',
      ),
    ) as RegressionManifest;
    expect(limitedManifest.summary).toMatchObject({ generated: 1, skippedLimit: 3 });

    const findingsFile = join(verificationDirectory, 'findings.json');
    const originalFindings = await readFile(findingsFile, 'utf8');
    const tamperedFindings = JSON.parse(originalFindings) as FindingsArtifact;
    const fixedFinding = tamperedFindings.findings.find(
      (finding) => finding.verdict === 'NOT_REPRODUCED',
    );
    if (fixedFinding === undefined) throw new Error('Fixed finding is missing.');
    await writeFile(
      findingsFile,
      JSON.stringify({
        ...tamperedFindings,
        findings: [
          ...tamperedFindings.findings.filter((finding) => finding.id !== fixedFinding.id),
          { ...fixedFinding, verdict: 'CONFIRMED_DEFECT', selector: '#delete-account' },
        ],
      }),
    );
    const rejectedGeneration = await runCli(projectRoot, ['generate', findingsFile]);
    expect(rejectedGeneration.code).toBe(2);
    expect(rejectedGeneration.stderr).toMatch(/invalid|unrecognized|integrity/i);
    expect(await readdir(join(runDirectory, 'regressions'))).toHaveLength(3);
    await writeFile(findingsFile, originalFindings);

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
  }, 480_000);
});
