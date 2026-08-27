import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InspectionResult } from '../../src/domain/inspection.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
let baseUrl = '';
let temporaryDirectory = '';

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
    <html>
      <head><title>Agentic QA fixture</title></head>
      <body>
        <h1>Fixture</h1><h2>Details</h2>
        <a href="/one">One</a><a href="/two">Two</a>
        <form><input name="query"><button type="button">Search</button></form>
      </body>
    </html>`);
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-e2e-'));
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('agentic-qa inspect', () => {
  it('inspects a controlled page through the real CLI and writes artifacts', async () => {
    const artifacts = join(temporaryDirectory, 'runs');
    const execution = await runCli(projectRoot, [
      'inspect',
      baseUrl,
      '--artifacts-dir',
      artifacts,
      '--timeout',
      '10000',
    ]);

    expect(execution).toMatchObject({ code: 0, stderr: '' });
    expect(execution.stdout).toContain('Inspection complete');
    expect(execution.stdout).toContain('Agentic QA fixture');

    const runDirectories = await readdir(artifacts);
    expect(runDirectories).toHaveLength(1);
    const runName = runDirectories[0];
    if (runName === undefined) throw new Error('CLI did not create a run directory');
    const runDirectory = join(artifacts, runName);
    const result = JSON.parse(
      await readFile(join(runDirectory, 'result.json'), 'utf8'),
    ) as InspectionResult;

    expect(result).toMatchObject({
      schemaVersion: '1.0',
      requestedUrl: `${baseUrl}/`,
      page: {
        url: `${baseUrl}/`,
        title: 'Agentic QA fixture',
        status: 200,
        viewport: { width: 1440, height: 900 },
        elements: { links: 2, buttons: 1, inputs: 1, forms: 1, headings: 2 },
      },
      artifacts: { screenshot: 'page.png' },
      warnings: [],
    });
    expect((await stat(join(runDirectory, 'page.png'))).size).toBeGreaterThan(100);
  });
});
