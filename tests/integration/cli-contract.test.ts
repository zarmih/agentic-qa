import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
let temporaryDirectory = '';

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-cli-contract-'));
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('public CLI contract', () => {
  it('reports the release version and help for every public command without ANSI', async () => {
    const version = await runCli(projectRoot, ['--version']);
    expect(version).toEqual({ code: 0, stdout: '1.0.0\n', stderr: '' });
    for (const command of [
      'inspect',
      'explore',
      'plan',
      'run',
      'verify',
      'generate',
      'export',
      'pipeline',
      'report',
    ]) {
      const help = await runCli(projectRoot, [command, '--help']);
      expect(help.code, command).toBe(0);
      expect(help.stderr, command).toBe('');
      expect(help.stdout, command).toContain(`Usage: agentic-qa ${command}`);
      expect(help.stdout, command).not.toContain('\u001b[');
    }
  });

  it('keeps --json stdout clean and emits one structured error document on stderr', async () => {
    const invalidProfile = await runCli(projectRoot, [
      'pipeline',
      'https://fixture.test',
      '--profile',
      'unbounded',
      '--json',
    ]);
    expect(invalidProfile).toMatchObject({ code: 2, stdout: '' });
    expect(JSON.parse(invalidProfile.stderr)).toEqual({
      error: {
        code: 'INVALID_CONFIG',
        message: 'Pipeline profile must be one of: quick, standard, thorough.',
      },
      exitCode: 2,
    });

    const invalidExport = await runCli(projectRoot, [
      'export',
      join(temporaryDirectory, 'missing-manifest.json'),
      '--target',
      temporaryDirectory,
      '--json',
    ]);
    expect(invalidExport).toMatchObject({ code: 2, stdout: '' });
    const error = JSON.parse(invalidExport.stderr) as {
      readonly error: { readonly code: string; readonly message: string };
      readonly exitCode: number;
    };
    expect(error).toMatchObject({ error: { code: 'EXPORT_SOURCE_INVALID' }, exitCode: 2 });
    expect(error.error.message).not.toContain(temporaryDirectory);
  });

  it('uses stderr, a nonzero code, and no stack trace for ordinary invalid input', async () => {
    const result = await runCli(projectRoot, ['inspect', 'javascript:alert(1)']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Agentic QA failed:');
    expect(result.stderr).not.toMatch(/\n\s+at\s/);
    expect(result.stderr).not.toContain('\u001b[');
  });

  it('rejects zero, negative, unsafe-huge, and contradictory CLI options before work starts', async () => {
    for (const args of [
      ['explore', 'https://fixture.test', '--max-pages', '0'],
      ['explore', 'https://fixture.test', '--max-depth', '-1'],
      ['verify', join(temporaryDirectory, 'missing-execution.json'), '--attempts', '11'],
    ]) {
      const result = await runCli(projectRoot, args);
      expect(result.code, args.join(' ')).not.toBe(0);
      expect(result.stdout, args.join(' ')).toBe('');
      expect(result.stderr, args.join(' ')).toMatch(/must be|Agentic QA failed/);
      expect(result.stderr, args.join(' ')).not.toMatch(/\n\s+at\s/);
    }

    const huge = await runCli(projectRoot, [
      'pipeline',
      'https://fixture.test',
      '--max-pages',
      '9007199254740992',
      '--json',
    ]);
    expect(huge).toMatchObject({ code: 2, stdout: '' });
    expect(JSON.parse(huge.stderr)).toMatchObject({
      error: { code: 'INVALID_CONFIG' },
      exitCode: 2,
    });

    const contradictory = await runCli(projectRoot, [
      'export',
      join(temporaryDirectory, 'missing-manifest.json'),
      '--target',
      temporaryDirectory,
      '--validate',
      '--json',
    ]);
    expect(contradictory).toMatchObject({ code: 2, stdout: '' });
    expect(JSON.parse(contradictory.stderr)).toMatchObject({
      error: { code: 'INVALID_CONFIG' },
      exitCode: 2,
    });
  });

  it('persists pipeline failure artifacts after browser startup fails', async () => {
    const artifacts = join(temporaryDirectory, 'startup-failure-runs');
    const result = await runCli(
      projectRoot,
      [
        'pipeline',
        'https://fixture.test',
        '--profile',
        'quick',
        '--model',
        'fixture-model',
        '--artifacts-dir',
        artifacts,
        '--json',
      ],
      {
        PLAYWRIGHT_BROWSERS_PATH: join(temporaryDirectory, 'no-browser-installed-here'),
        AGENTIC_QA_LLM_BASE_URL: 'http://127.0.0.1:1/v1',
      },
    );
    expect(result).toMatchObject({ code: 2, stderr: '' });
    const output = JSON.parse(result.stdout) as {
      readonly pipeline: { readonly status: string; readonly artifacts: { exploration: null } };
    };
    expect(output.pipeline).toMatchObject({ status: 'FAILED', artifacts: { exploration: null } });
    const runs = await readdir(artifacts);
    expect(runs).toHaveLength(1);
    const pipeline = JSON.parse(
      await readFile(join(artifacts, runs[0] ?? '', 'pipeline.json'), 'utf8'),
    ) as {
      readonly schemaVersion: string;
      readonly stages: readonly { readonly status: string }[];
    };
    expect(pipeline.schemaVersion).toBe('1.1');
    expect(pipeline.stages.map((stage) => stage.status)).toEqual([
      'FAILED',
      'NOT_RUN',
      'NOT_RUN',
      'NOT_RUN',
      'NOT_RUN',
    ]);
    expect(await readFile(join(artifacts, runs[0] ?? '', 'report.html'), 'utf8')).toContain(
      'Exploration did not start',
    );
    const rerender = await runCli(projectRoot, ['report', join(artifacts, runs[0] ?? '')]);
    expect(rerender).toMatchObject({ code: 0, stderr: '' });
  });

  it('emits a structured error when no artifact directory can be created', async () => {
    const blockedPath = join(temporaryDirectory, 'not-a-directory');
    await writeFile(blockedPath, 'fixture', 'utf8');
    const result = await runCli(
      projectRoot,
      [
        'pipeline',
        'https://fixture.test',
        '--profile',
        'quick',
        '--model',
        'fixture-model',
        '--artifacts-dir',
        blockedPath,
        '--json',
      ],
      { AGENTIC_QA_LLM_BASE_URL: 'http://127.0.0.1:1/v1' },
    );
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'ARTIFACT_WRITE_FAILED' },
      exitCode: 2,
    });
  });
});
