import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRun } from '../../src/domain/pipeline.js';
import type { RegressionManifest } from '../../src/domain/regression.js';
import type { VerificationRun } from '../../src/domain/verification.js';
import { startFakeLlmServer, type FakeLlmServer } from '../fixtures/fake-llm-server.js';
import { startMiniAppServer, type MiniAppServer } from '../fixtures/mini-app-server.js';
import { pipelinePlanFromRequest } from '../fixtures/pipeline-plan-proposal.js';
import { runCli } from '../helpers/run-cli.js';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '../..');
let miniApp: MiniAppServer;
let temporaryDirectory = '';
const retainedAuditDirectory = process.env.AGENTIC_QA_AUDIT_OUTPUT_DIR;

async function onlyChild(directory: string): Promise<string> {
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] === undefined) {
    throw new Error(`Expected one artifact in ${directory}; received ${entries.join(', ')}`);
  }
  return entries[0];
}

async function textFiles(directory: string): Promise<readonly string[]> {
  const values: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) values.push(...(await textFiles(path)));
    else if (/\.(?:json|md|html|ts)$/i.test(entry.name)) values.push(await readFile(path, 'utf8'));
  }
  return values;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

beforeAll(async () => {
  miniApp = await startMiniAppServer();
  await mkdir(join(projectRoot, 'artifacts'), { recursive: true });
  if (retainedAuditDirectory === undefined) {
    temporaryDirectory = await mkdtemp(join(projectRoot, 'artifacts', 'product-e2e-'));
  } else {
    temporaryDirectory = resolve(retainedAuditDirectory);
    await mkdir(temporaryDirectory, { recursive: true });
  }
});

afterAll(async () => {
  await miniApp.close();
  if (retainedAuditDirectory === undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe('Stage 8 product CLI', () => {
  it('runs the unified pipeline, renders an injection-safe report, and exports only after approval', async () => {
    const syntheticSecret = 'aq-release-audit-secret-never-persist';
    const artifacts = join(temporaryDirectory, 'runs');
    let provider: FakeLlmServer | null = null;
    let pipelineCli;
    try {
      provider = await startFakeLlmServer((request) => ({
        content: JSON.stringify(pipelinePlanFromRequest(request)),
        usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
      }));
      pipelineCli = await runCli(
        projectRoot,
        [
          'pipeline',
          `${miniApp.baseUrl}/pipeline`,
          '--profile',
          'quick',
          '--attempts',
          '3',
          '--model',
          'pipeline-fixture',
          '--artifacts-dir',
          artifacts,
          '--json',
        ],
        {
          AGENTIC_QA_LLM_BASE_URL: provider.baseUrl,
          AGENTIC_QA_LLM_API_KEY: syntheticSecret,
          AGENTIC_QA_LLM_TIMEOUT_MS: '3000',
          AGENTIC_QA_NAVIGATION_TIMEOUT_MS: '3000',
          AGENTIC_QA_STEP_TIMEOUT_MS: '3000',
          AGENTIC_QA_EXECUTION_TIMEOUT_MS: '120000',
          AGENTIC_QA_VERIFY_TIMEOUT_MS: '300000',
        },
      );
    } finally {
      await provider?.close();
    }
    expect(provider.requests[0]?.authorization).toBe(`Bearer ${syntheticSecret}`);
    expect(provider.requests[0]?.rawBody).not.toContain(syntheticSecret);
    expect(pipelineCli).toMatchObject({ code: 1, stderr: '' });
    const machineOutput = JSON.parse(pipelineCli.stdout) as {
      readonly pipeline: PipelineRun;
      readonly exitCode: number;
    };
    expect(machineOutput.pipeline.status).toBe('COMPLETE_WITH_REGRESSIONS');
    expect(machineOutput.exitCode).toBe(1);

    const runId = await onlyChild(artifacts);
    const runDirectory = join(artifacts, runId);
    const pipeline = JSON.parse(
      await readFile(join(runDirectory, 'pipeline.json'), 'utf8'),
    ) as PipelineRun;
    expect(pipeline.stages.map((stage) => stage.status)).toEqual([
      'PASS',
      'PASS',
      'COMPLETED_WITH_FINDINGS',
      'COMPLETED_WITH_FINDINGS',
      'PASS',
    ]);
    expect(pipeline.stages[0]?.summary).toMatchObject({ pages: 1, actions: 2 });
    expect(pipeline.stages[1]?.summary).toMatchObject({ scenarios: 2, automatable: 2 });
    expect(pipeline.stages[2]?.summary).toMatchObject({ passed: 1, failed: 1 });
    expect(pipeline.stages[3]?.summary).toMatchObject({ confirmed: 1, attempts: 3 });
    expect(pipeline.stages[4]?.summary).toMatchObject({ generated: 1 });

    const verificationPath = pipeline.artifacts.verification;
    const manifestPath = pipeline.artifacts.manifest;
    if (verificationPath === null || manifestPath === null) {
      throw new Error('Pipeline verification or regression manifest is missing.');
    }
    const verification = JSON.parse(
      await readFile(join(runDirectory, verificationPath), 'utf8'),
    ) as VerificationRun;
    expect(verification.summary).toMatchObject({ confirmed: 1, attemptsCompleted: 3 });
    const manifest = JSON.parse(
      await readFile(join(runDirectory, manifestPath), 'utf8'),
    ) as RegressionManifest;
    expect(manifest).toMatchObject({ schemaVersion: '1.1', summary: { generated: 1 } });
    expect(manifest.generationIntegrity.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    const generated = manifest.tests.find((entry) => entry.status === 'GENERATED');
    if (
      generated?.file === null ||
      generated?.file === undefined ||
      generated.fileDigest === null
    ) {
      throw new Error('Pipeline did not generate the confirmed regression.');
    }

    const reportFile = join(runDirectory, 'report.html');
    const report = await readFile(reportFile, 'utf8');
    expect(report).toContain("default-src 'none'");
    expect(report).toContain('&lt;script&gt;alert(&quot;captured&quot;)&lt;/script&gt;');
    expect(report).not.toContain('<script>alert("captured")</script>');
    expect(report).not.toContain('https://cdn');
    expect(report).not.toContain('/Users/mikhail');
    expect(report).toContain(generated.file);
    const rerender = await runCli(projectRoot, ['report', runDirectory]);
    expect(rerender).toMatchObject({ code: 0, stderr: '' });
    expect(rerender.stdout).toContain('Agentic QA Report rendered');

    const target = join(temporaryDirectory, 'target project;$(safe)');
    await mkdir(join(target, 'tests'), { recursive: true });
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({
        name: 'stage8-target',
        private: true,
        type: 'module',
        devDependencies: { '@playwright/test': '1.62.1', typescript: '6.0.3' },
      }),
    );
    await writeFile(join(target, 'package-lock.json'), '{}\n');
    await writeFile(join(target, 'tsconfig.json'), '{}\n');
    await writeFile(
      join(target, 'playwright.config.ts'),
      `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', use: { baseURL: '${miniApp.baseUrl}' } });\n`,
    );
    await execFileAsync(
      'ln',
      ['-s', join(projectRoot, 'node_modules'), join(target, 'node_modules')],
      { shell: false },
    );
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: target, shell: false });
    await execFileAsync('git', ['add', '.'], { cwd: target, shell: false });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Agentic QA',
        '-c',
        'user.email=agentic-qa@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: target, shell: false },
    );
    const headBefore = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: target, shell: false })
    ).stdout.trim();
    const targetSpec = join(target, 'tests', 'agentic-qa', generated.file.split('/').at(-1) ?? '');

    const dryRun = await runCli(projectRoot, [
      'export',
      join(runDirectory, manifestPath),
      '--target',
      target,
      '--json',
    ]);
    expect(dryRun).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      plan: { mode: 'DRY_RUN', summary: { newFiles: 1, changesToApply: 1 } },
      receipt: null,
    });
    await expect(access(targetSpec)).rejects.toThrow();

    const apply = await runCli(projectRoot, [
      'export',
      join(runDirectory, manifestPath),
      '--target',
      target,
      '--apply',
      '--validate',
      '--json',
    ]);
    expect(apply).toMatchObject({ code: 0, stderr: '' });
    const applied = JSON.parse(apply.stdout) as {
      readonly receipt: {
        readonly validation: { readonly status: string };
        readonly files: readonly { readonly action: string }[];
      };
    };
    expect(applied.receipt.validation.status).toBe('PASS');
    expect(applied.receipt.files).toEqual([expect.objectContaining({ action: 'WRITTEN' })]);
    expect(JSON.stringify(applied.receipt)).not.toContain(target);
    const exportedSource = await readFile(targetSpec, 'utf8');
    expect(sha256(exportedSource)).toBe(generated.fileDigest);
    expect((await stat(targetSpec)).size).toBeGreaterThan(100);
    const headAfter = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: target, shell: false })
    ).stdout.trim();
    expect(headAfter).toBe(headBefore);

    const identical = await runCli(projectRoot, [
      'export',
      join(runDirectory, manifestPath),
      '--target',
      target,
      '--apply',
      '--json',
    ]);
    expect(identical).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(identical.stdout)).toMatchObject({
      plan: { summary: { identical: 1, changesToApply: 0 } },
      receipt: { files: [expect.objectContaining({ action: 'UNCHANGED' })] },
    });

    await writeFile(targetSpec, '// human-owned conflicting content\n');
    const conflict = await runCli(projectRoot, [
      'export',
      join(runDirectory, manifestPath),
      '--target',
      target,
      '--apply',
      '--json',
    ]);
    expect(conflict.code).toBe(1);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      plan: { summary: { conflicts: 1, blocked: 1 } },
      receipt: { files: [expect.objectContaining({ action: 'SKIPPED' })] },
    });
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      plan: { target: { git: { repository: true, dirty: true } } },
    });
    expect(conflict.stdout).toContain('will not stash or reset');
    expect(await readFile(targetSpec, 'utf8')).toBe('// human-owned conflicting content\n');
    expect(
      (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: target, shell: false })
      ).stdout.trim(),
    ).toBe(headBefore);

    const overwrite = await runCli(projectRoot, [
      'export',
      join(runDirectory, manifestPath),
      '--target',
      target,
      '--apply',
      '--overwrite',
      '--json',
    ]);
    expect(overwrite).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(overwrite.stdout)).toMatchObject({
      receipt: { files: [expect.objectContaining({ action: 'OVERWRITTEN' })] },
    });
    expect(sha256(await readFile(targetSpec, 'utf8'))).toBe(generated.fileDigest);
    expect(
      (
        await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: target, shell: false })
      ).stdout.trim(),
    ).toBe(headBefore);

    const generatedSpec = join(runDirectory, pipeline.artifacts.generation ?? '', generated.file);
    const originalGeneratedSource = await readFile(generatedSpec, 'utf8');
    await writeFile(generatedSpec, `${originalGeneratedSource}// modified after generation\n`);
    const modifiedSource = await runCli(projectRoot, [
      'export',
      join(runDirectory, manifestPath),
      '--target',
      target,
    ]);
    expect(modifiedSource.code).toBe(2);
    expect(modifiedSource.stderr).toMatch(/DIGEST_MISMATCH|renderer mismatch/i);
    await writeFile(generatedSpec, originalGeneratedSource);

    const manifestFile = join(runDirectory, manifestPath);
    const originalManifest = await readFile(manifestFile, 'utf8');
    const corrupted = JSON.parse(originalManifest) as RegressionManifest;
    await writeFile(
      manifestFile,
      JSON.stringify({
        ...corrupted,
        generationIntegrity: { ...corrupted.generationIntegrity, payloadDigest: '0'.repeat(64) },
      }),
    );
    const corruptedManifest = await runCli(projectRoot, [
      'export',
      manifestFile,
      '--target',
      target,
    ]);
    expect(corruptedManifest.code).toBe(2);
    expect(corruptedManifest.stderr).toMatch(/payload digest/i);
    await writeFile(manifestFile, originalManifest);

    expect(
      (await textFiles(runDirectory)).every((contents) => !contents.includes(syntheticSecret)),
    ).toBe(true);
    expect((await textFiles(target)).every((contents) => !contents.includes(syntheticSecret))).toBe(
      true,
    );

    expect(await miniApp.pipelineAttempts()).toEqual({ stable: 5, healthy: 2 });
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
  }, 300_000);
});
