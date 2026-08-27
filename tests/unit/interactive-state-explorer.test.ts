import { describe, expect, it } from 'vitest';
import { InteractiveStateExplorer } from '../../src/application/interactive-state-explorer.js';
import type {
  BrowserInteractionCapture,
  BrowserStateCapture,
  ExplorationArtifactStore,
  ExplorationBrowserSession,
} from '../../src/application/ports.js';
import {
  StateFingerprintService,
  type InteractionCandidate,
  type StateObservation,
} from '../../src/domain/interaction.js';
import type { PageNode } from '../../src/domain/exploration.js';

const emptyBrowserEvidence = {
  console: [],
  pageErrors: [],
  failedRequests: [],
  httpErrors: [],
} as const;
const emptyInteractionEvidence = {
  browser: emptyBrowserEvidence,
  dialogs: [],
  popups: [],
  downloads: [],
} as const;

function candidate(
  name: string,
  order: number,
  ariaExpanded: boolean | null = null,
): InteractionCandidate {
  return {
    id: `candidate-${String(order + 1).padStart(3, '0')}`,
    domOrder: order,
    tag: 'button',
    role: 'button',
    accessibleName: name,
    text: name,
    href: null,
    elementType: 'button',
    ariaLabel: null,
    title: null,
    ariaExpanded,
    ariaSelected: null,
    disabled: false,
    visible: true,
    formAssociated: false,
    submitsForm: false,
    fileUpload: false,
    testId: null,
    label: null,
    stableId: null,
    locator: { strategy: 'role', role: 'button', name, index: 0 },
  };
}

function observation(
  heading: string,
  candidates: readonly InteractionCandidate[],
): StateObservation {
  return { url: 'https://app.test/', title: 'App', headings: [heading], dialogs: [], candidates };
}

function stateCapture(value: StateObservation): BrowserStateCapture {
  return {
    observation: value,
    screenshot: Buffer.from(value.headings[0] ?? ''),
    timestamp: '2026-01-01T00:00:00Z',
    truncated: false,
  };
}

const pageNode: PageNode = {
  id: 'page-001',
  requestedUrl: 'https://app.test/',
  finalUrl: 'https://app.test/',
  title: 'App',
  status: 200,
  state: 'visited',
  depth: 0,
  discoveryOrder: 1,
  discoveredFrom: null,
  viewport: { width: 1000, height: 700 },
  elements: { links: 0, buttons: 3, inputs: 0, forms: 0, headings: 1 },
  timestamp: '2026-01-01T00:00:00Z',
  durationMs: 1,
  screenshot: 'pages/001-home.png',
  warnings: [],
};

function harness(
  overrides: {
    readonly initial?: StateObservation;
    readonly interact?: ExplorationBrowserSession['performInteraction'];
    readonly maxStates?: number;
    readonly maxActionsPerState?: number;
    readonly maxStateDepth?: number;
    readonly canNavigate?: (url: string) => boolean;
  } = {},
) {
  const initial = overrides.initial ?? observation('Closed', [candidate('Open menu', 0, false)]);
  const fingerprints = new StateFingerprintService();
  const saved: string[] = [];
  const session: ExplorationBrowserSession = {
    visit: () => Promise.reject(new Error('not used')),
    captureState: () => Promise.resolve(stateCapture(initial)),
    performInteraction:
      overrides.interact ??
      ((request) => {
        const opened = observation('Open', [candidate('Close menu', 0, true)]);
        const closed = initial;
        const result = request.candidate.accessibleName === 'Close menu' ? closed : opened;
        const capture: BrowserInteractionCapture = {
          status: 'COMPLETED',
          sourceUrl: 'https://app.test/',
          result: stateCapture(result),
          durationMs: 5,
          reason: null,
          evidence: emptyInteractionEvidence,
          discoveredUrls: [],
        };
        return Promise.resolve(capture);
      }),
    close: () => Promise.resolve([]),
  };
  const artifacts: ExplorationArtifactStore = {
    prepareExploration: () =>
      Promise.resolve({ directory: '/tmp/run', tracePath: '/tmp/run/trace.zip' }),
    saveExploration: () => Promise.resolve(),
    savePageScreenshot: () => Promise.resolve(),
    saveStateScreenshot: (_run, filename) => {
      saved.push(filename);
      return Promise.resolve();
    },
  };
  const explorer = new InteractiveStateExplorer(session, artifacts, 'run-1', {
    navigationTimeoutMs: 1000,
    canNavigate: overrides.canNavigate ?? (() => true),
    onDiscoveredNavigation: () => undefined,
    maxStates: overrides.maxStates ?? 10,
    maxActionsPerState: overrides.maxActionsPerState ?? 4,
    maxStateDepth: overrides.maxStateDepth ?? 3,
  });
  return { explorer, saved, initialHash: fingerprints.create(initial).hash };
}

describe('InteractiveStateExplorer', () => {
  it('traverses states deterministically and terminates a cycle by fingerprint deduplication', async () => {
    const { explorer, saved } = harness();
    await explorer.explorePage(pageNode);
    expect(explorer.graph().nodes.map((node) => node.metadata.headings[0])).toEqual([
      'closed',
      'open',
    ]);
    expect(explorer.graph().edges.map((edge) => edge.outcome)).toEqual(['NEW_STATE', 'SAME_STATE']);
    expect(explorer.summary()).toMatchObject({
      statesDiscovered: 2,
      actionsExecuted: 2,
      duplicateStates: 1,
    });
    expect(saved).toEqual(['state-001.png', 'state-002.png']);
  });

  it('deduplicates two controls that produce the same state and audits destructive controls', async () => {
    const initial = observation('Closed', [
      candidate('Open menu', 0),
      candidate('Show menu', 1),
      candidate('Delete account', 2),
    ]);
    const { explorer } = harness({ initial });
    await explorer.explorePage(pageNode);
    expect(explorer.graph().nodes).toHaveLength(2);
    expect(
      explorer
        .graph()
        .safetyAudit.find((entry) => entry.candidate.accessibleName === 'Delete account'),
    ).toMatchObject({
      classification: 'DESTRUCTIVE',
      executed: false,
    });
    expect(explorer.summary().duplicateStates).toBeGreaterThanOrEqual(1);
  });

  it('enforces state/action/depth limits and keeps interaction failures non-fatal', async () => {
    const initial = observation('Closed', [candidate('Open menu', 0), candidate('Show menu', 1)]);
    const { explorer } = harness({
      initial,
      maxActionsPerState: 1,
      maxStateDepth: 1,
      interact: (request) =>
        Promise.resolve({
          status: 'FAILED',
          sourceUrl: request.url,
          result: null,
          durationMs: 3,
          reason: 'detached',
          evidence: emptyInteractionEvidence,
          discoveredUrls: [],
        }),
    });
    await explorer.explorePage(pageNode);
    expect(explorer.graph().failures).toHaveLength(1);
    expect(explorer.graph().safetyAudit[1]).toMatchObject({
      executed: false,
      reason: 'max_actions_per_state',
    });
    expect(explorer.summary()).toMatchObject({
      actionFailures: 1,
      actionsBlocked: 1,
      limitReached: ['maxActionsPerState'],
    });
  });

  it('blocks a safe-role link when its target is outside navigation scope', async () => {
    const externalMenuItem: InteractionCandidate = {
      ...candidate('Open documentation', 0),
      tag: 'a',
      role: 'menuitem',
      href: 'https://outside.test/docs',
      elementType: null,
      locator: { strategy: 'role', role: 'menuitem', name: 'Open documentation', index: 0 },
    };
    const { explorer } = harness({
      initial: observation('Menu', [externalMenuItem]),
      canNavigate: (url) => new URL(url).origin === 'https://app.test',
    });
    await explorer.explorePage(pageNode);
    expect(explorer.graph().safetyAudit[0]).toMatchObject({
      classification: 'SAFE',
      executed: false,
      reason: 'out_of_scope_target',
    });
    expect(explorer.summary().actionsExecuted).toBe(0);
  });
});
