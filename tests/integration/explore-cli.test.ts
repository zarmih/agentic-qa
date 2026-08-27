import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplorationGraph, ExplorationResult } from '../../src/domain/exploration.js';
import { startMiniAppServer, type MiniAppServer } from '../fixtures/mini-app-server.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
let miniApp: MiniAppServer;
let temporaryDirectory = '';

beforeAll(async () => {
  miniApp = await startMiniAppServer();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-explore-e2e-'));
});

afterAll(async () => {
  await miniApp.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('agentic-qa explore', () => {
  it('builds a deterministic graph and captures browser evidence and artifacts', async () => {
    const artifacts = join(temporaryDirectory, 'runs');
    const execution = await runCli(projectRoot, [
      'explore',
      miniApp.baseUrl,
      '--artifacts-dir',
      artifacts,
      '--max-pages',
      '12',
      '--max-depth',
      '2',
      '--max-query-variants',
      '2',
      '--timeout',
      '150',
    ]);

    expect(execution).toMatchObject({ code: 0, stderr: '' });
    expect(execution.stdout).toContain('Agentic QA Exploration complete');
    const runNames = await readdir(artifacts);
    expect(runNames).toHaveLength(1);
    const runName = runNames[0];
    if (runName === undefined) throw new Error('Explore CLI did not create a run directory');
    const runDirectory = join(artifacts, runName);
    const result = JSON.parse(
      await readFile(join(runDirectory, 'exploration.json'), 'utf8'),
    ) as ExplorationResult;
    const graph = JSON.parse(
      await readFile(join(runDirectory, 'graph.json'), 'utf8'),
    ) as ExplorationGraph;

    expect(graph).toEqual(result.graph);
    expect(result.schemaVersion).toBe('3.0');
    expect(result.interactive.enabled).toBe(false);
    expect(result.stateGraph).toBeNull();
    expect(result.artifacts.stateGraph).toBeNull();
    expect(result.graph.nodes.map((node) => new URL(node.finalUrl).pathname)).toEqual([
      '/',
      '/products',
      '/about',
      '/error',
      '/slow',
      '/search',
      '/search',
      '/products/1',
      '/products/2',
    ]);
    expect(result.summary).toMatchObject({
      pagesAttempted: 10,
      pagesVisited: 8,
      pagesFailed: 1,
      externalLinks: 1,
    });
    expect(result.summary.consoleErrors).toBeGreaterThanOrEqual(1);
    expect(result.summary.consoleWarnings).toBeGreaterThanOrEqual(1);
    expect(result.summary.pageErrors).toBeGreaterThanOrEqual(1);
    expect(result.summary.failedRequests).toBeGreaterThanOrEqual(1);
    expect(result.summary.httpErrors).toBeGreaterThanOrEqual(1);

    const external = result.graph.edges.find((edge) => edge.scope === 'external');
    expect(external).toMatchObject({ attempted: false, visited: false, targetPageId: null });
    expect(result.graph.edges.find((edge) => edge.href === '#top')).toMatchObject({
      targetUrl: `${miniApp.baseUrl}/`,
      skipReason: 'duplicate',
    });
    expect(result.graph.edges.find((edge) => edge.href === '/search?q=three')).toMatchObject({
      visited: false,
      skipReason: 'query-limit',
    });
    expect(result.graph.edges.find((edge) => edge.href === '/logout')).toMatchObject({
      attempted: false,
      visited: false,
      skipReason: 'unsafe',
    });
    const redirectEdge = result.graph.edges.find((edge) => edge.href === '/redirect');
    const aboutNode = result.graph.nodes.find(
      (node) => new URL(node.finalUrl).pathname === '/about',
    );
    expect(redirectEdge?.targetPageId).toBe(aboutNode?.id);
    expect(
      result.graph.nodes.find((node) => new URL(node.finalUrl).pathname === '/slow'),
    ).toMatchObject({
      state: 'failed',
    });
    expect(
      result.graph.nodes.some((node) => node.finalUrl.startsWith('https://external.invalid')),
    ).toBe(false);

    const screenshots = await readdir(join(runDirectory, 'pages'));
    expect(screenshots).toHaveLength(result.graph.nodes.length);
    expect(screenshots.every((name) => /^\d{3}-[a-z0-9-]+\.png$/.test(name))).toBe(true);
    const trace = await readFile(join(runDirectory, 'trace.zip'));
    expect(trace.length).toBeGreaterThan(100);
    expect(trace.subarray(0, 2).toString('ascii')).toBe('PK');
    expect((await stat(join(runDirectory, 'graph.json'))).size).toBeGreaterThan(100);
  });
});
