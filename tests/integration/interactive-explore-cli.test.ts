import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/domain/exploration.js';
import type { StateGraph } from '../../src/domain/interaction.js';
import { startMiniAppServer, type MiniAppServer } from '../fixtures/mini-app-server.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
let miniApp: MiniAppServer;
let temporaryDirectory = '';

beforeAll(async () => {
  miniApp = await startMiniAppServer();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-interactive-e2e-'));
});

afterAll(async () => {
  await miniApp.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('agentic-qa explore --interactive', () => {
  it('discovers safe UI states while blocking destructive, caution, form, and unknown actions', async () => {
    const artifacts = join(temporaryDirectory, 'runs');
    const execution = await runCli(projectRoot, [
      'explore',
      `${miniApp.baseUrl}/interactive`,
      '--interactive',
      '--artifacts-dir',
      artifacts,
      '--max-pages',
      '3',
      '--max-depth',
      '1',
      '--max-states',
      '16',
      '--max-actions-per-state',
      '20',
      '--max-state-depth',
      '2',
      '--timeout',
      '3000',
    ]);

    expect(execution).toMatchObject({ code: 0, stderr: '' });
    expect(execution.stdout).toContain('UI states');
    const runNames = await readdir(artifacts);
    expect(runNames).toHaveLength(1);
    const runName = runNames[0];
    if (runName === undefined) throw new Error('Interactive CLI did not create a run directory');
    const runDirectory = join(artifacts, runName);
    const result = JSON.parse(
      await readFile(join(runDirectory, 'exploration.json'), 'utf8'),
    ) as ExplorationResult;
    const stateGraph = JSON.parse(
      await readFile(join(runDirectory, 'state-graph.json'), 'utf8'),
    ) as StateGraph;

    expect(result.schemaVersion).toBe('3.0');
    expect(result.interactive.enabled).toBe(true);
    expect(stateGraph).toEqual(result.stateGraph);
    expect(stateGraph.nodes.length).toBeGreaterThanOrEqual(8);
    expect(result.interactive.duplicateStates).toBeGreaterThan(0);
    expect(result.interactive.actionFailures).toBeGreaterThanOrEqual(1);
    expect(result.interactive.limitReached).toContain('maxStates');

    const headings = stateGraph.nodes.flatMap((node) => node.metadata.headings);
    expect(headings).toContain('help content');
    expect(headings).toContain('details panel');
    expect(headings).toContain('reviews panel');
    expect(headings).toContain('technical specifications');
    expect(headings).toContain('shared state');
    expect(headings).toContain('product detail state');
    expect(headings).toContain('broken panel');

    const blocked = new Map(
      stateGraph.safetyAudit
        .filter((entry) => !entry.executed)
        .map((entry) => [entry.candidate.accessibleName, entry]),
    );
    for (const name of [
      'Delete account',
      'Logout',
      'Buy now',
      'Checkout',
      'Publish',
      'Reset database',
      'Unsubscribe',
      'Delete item',
    ]) {
      expect(blocked.get(name)).toMatchObject({ classification: 'DESTRUCTIVE', executed: false });
    }
    for (const name of ['Save', 'Create', 'Submit']) {
      expect(blocked.get(name)).toMatchObject({ classification: 'CAUTION', executed: false });
    }
    expect(
      stateGraph.safetyAudit.some(
        (entry) =>
          entry.candidate.accessibleName === '' &&
          entry.classification === 'UNKNOWN' &&
          !entry.executed,
      ),
    ).toBe(true);
    expect(
      stateGraph.safetyAudit.find((entry) => entry.candidate.label === 'Attachment'),
    ).toMatchObject({ executed: false });

    const interactionEvidence = stateGraph.edges.flatMap((edge) => [edge.evidence]);
    expect(
      interactionEvidence.some((evidence) =>
        evidence.browser.console.some((entry) =>
          entry.message.includes('interaction fixture error'),
        ),
      ),
    ).toBe(true);
    expect(interactionEvidence.some((evidence) => evidence.browser.failedRequests.length > 0)).toBe(
      true,
    );
    expect(interactionEvidence.some((evidence) => evidence.dialogs.length > 0)).toBe(true);
    expect(
      interactionEvidence.some((evidence) =>
        evidence.popups.some((entry) => entry.scope === 'same-origin'),
      ),
    ).toBe(true);
    expect(
      interactionEvidence.some((evidence) =>
        evidence.popups.some((entry) => entry.scope === 'external'),
      ),
    ).toBe(true);
    expect(interactionEvidence.some((evidence) => evidence.downloads.length > 0)).toBe(true);

    const counters = await miniApp.counters();
    expect(counters.safe).toBeGreaterThan(0);
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

    const stateScreenshots = await readdir(join(runDirectory, 'states'));
    expect(stateScreenshots).toHaveLength(stateGraph.nodes.length);
    expect(stateScreenshots.every((name) => /^state-\d{3,}\.png$/.test(name))).toBe(true);
    const trace = await readFile(join(runDirectory, 'trace.zip'));
    expect(trace.length).toBeGreaterThan(100);
    expect(trace.subarray(0, 2).toString('ascii')).toBe('PK');
    expect((await stat(join(runDirectory, 'state-graph.json'))).size).toBeGreaterThan(100);
    expect(
      result.graph.nodes.some(
        (node) => new URL(node.finalUrl).pathname === '/interactive/product/1',
      ),
    ).toBe(true);
  }, 125_000);
});
