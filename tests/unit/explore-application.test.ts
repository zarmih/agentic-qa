import { describe, expect, it } from 'vitest';
import { ExploreApplication } from '../../src/application/explore-application.js';
import type { ExplorationRunFailure } from '../../src/application/explore-application.js';
import type {
  Clock,
  ExplorationArtifactStore,
  ExplorationBrowser,
  ExplorationBrowserSession,
  ExplorationPageCapture,
  ExplorationVisitRequest,
  RunIdGenerator,
} from '../../src/application/ports.js';

const emptyEvidence = { console: [], pageErrors: [], failedRequests: [], httpErrors: [] } as const;

function capture(
  url: string,
  links: readonly string[] = [],
  overrides: Partial<ExplorationPageCapture> = {},
): ExplorationPageCapture {
  return {
    ok: true,
    requestedUrl: url,
    finalUrl: url,
    title: new URL(url).pathname,
    status: 200,
    viewport: { width: 1000, height: 700 },
    elements: { links: links.length, buttons: 0, inputs: 0, forms: 0, headings: 1 },
    links: links.map((href) => ({ href, hint: href })),
    timestamp: '2026-01-01T00:00:00.000Z',
    durationMs: 10,
    warnings: [],
    screenshot: Buffer.from('png'),
    evidence: emptyEvidence,
    ...overrides,
  };
}

function harness(pages: ReadonlyMap<string, ExplorationPageCapture>) {
  const visits: string[] = [];
  const session: ExplorationBrowserSession = {
    visit: (request: ExplorationVisitRequest) => {
      visits.push(request.url);
      const result = pages.get(request.url);
      return Promise.resolve(result ?? capture(request.url));
    },
    captureState: () => Promise.reject(new Error('Interactive capture was not expected.')),
    performInteraction: () => Promise.reject(new Error('Interactive action was not expected.')),
    close: () => Promise.resolve([]),
  };
  const browser: ExplorationBrowser = { start: () => Promise.resolve(session) };
  const savedScreenshots: string[] = [];
  const artifacts: ExplorationArtifactStore = {
    prepareExploration: () =>
      Promise.resolve({
        directory: '/runs/run-1',
        tracePath: '/runs/run-1/trace.zip',
      }),
    savePageScreenshot: (_runId: string, filename: string) => {
      savedScreenshots.push(filename);
      return Promise.resolve();
    },
    saveStateScreenshot: () => Promise.resolve(),
    saveExploration: () => Promise.resolve(),
  };
  const times = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:01.000Z')];
  const clock: Clock = { now: () => times.shift() ?? new Date('2026-01-01T00:00:01.000Z') };
  const runIds: RunIdGenerator = { next: () => 'run-1' };
  return {
    useCase: new ExploreApplication(browser, artifacts, runIds, clock),
    visits,
    session,
    savedScreenshots,
  };
}

const defaults = {
  headless: true,
  navigationTimeoutMs: 1000,
  viewport: { width: 1000, height: 700 },
  maxPages: 25,
  maxDepth: 3,
  maxQueryVariantsPerPath: 2,
  interactive: false,
  maxStates: 12,
  maxActionsPerState: 4,
  maxStateDepth: 2,
};

describe('ExploreApplication', () => {
  it('preserves the prepared run location when browser startup fails', async () => {
    const browserFailure = new Error('controlled browser startup failure');
    const failing = new ExploreApplication(
      { start: () => Promise.reject(browserFailure) },
      {
        prepareExploration: () =>
          Promise.resolve({ directory: '/runs/run-1', tracePath: '/runs/run-1/trace.zip' }),
        savePageScreenshot: () => Promise.resolve(),
        saveStateScreenshot: () => Promise.resolve(),
        saveExploration: () => Promise.resolve(),
      },
      { next: () => 'run-1' },
      { now: () => new Date('2026-01-01T00:00:00.000Z') },
    );

    await expect(failing.execute('https://app.test/', defaults)).rejects.toMatchObject({
      name: 'ExplorationRunFailure',
      runId: 'run-1',
      startUrl: 'https://app.test/',
      artifactDirectory: '/runs/run-1',
      cause: browserFailure,
    } satisfies Partial<ExplorationRunFailure>);
  });

  it('uses stable BFS order and prevents duplicate and fragment visits', async () => {
    const root = 'https://app.test/';
    const pages = new Map([
      [root, capture(root, ['/a', '/b', '/a', '#top'])],
      ['https://app.test/a', capture('https://app.test/a', ['/a/child'])],
      ['https://app.test/b', capture('https://app.test/b', ['/b/child'])],
    ]);
    const { useCase, visits } = harness(pages);
    const outcome = await useCase.execute(root, defaults);

    expect(visits).toEqual([
      root,
      'https://app.test/a',
      'https://app.test/b',
      'https://app.test/a/child',
      'https://app.test/b/child',
    ]);
    expect(outcome.result.graph.nodes.map((node) => node.finalUrl)).toEqual(visits);
    expect(outcome.result.graph.edges.filter((edge) => edge.targetUrl === root)).toHaveLength(1);
  });

  it('enforces maxPages without building an unbounded queue', async () => {
    const root = 'https://app.test/';
    const { useCase, visits } = harness(new Map([[root, capture(root, ['/1', '/2', '/3', '/4'])]]));
    const outcome = await useCase.execute(root, { ...defaults, maxPages: 2 });
    expect(visits).toEqual([root, 'https://app.test/1']);
    expect(
      outcome.result.graph.edges.filter((edge) => edge.skipReason === 'max-pages'),
    ).toHaveLength(3);
  });

  it('enforces maxDepth at discovery time', async () => {
    const root = 'https://app.test/';
    const { useCase, visits } = harness(new Map([[root, capture(root, ['/a'])]]));
    const outcome = await useCase.execute(root, { ...defaults, maxDepth: 0 });
    expect(visits).toEqual([root]);
    expect(outcome.result.graph.edges[0]?.skipReason).toBe('max-depth');
  });

  it('records external links but never queues them', async () => {
    const root = 'https://app.test/';
    const { useCase, visits } = harness(
      new Map([[root, capture(root, ['https://outside.test/path'])]]),
    );
    const outcome = await useCase.execute(root, defaults);
    expect(visits).toEqual([root]);
    expect(outcome.result.graph.edges[0]).toMatchObject({
      targetUrl: 'https://outside.test/path',
      scope: 'external',
      attempted: false,
      visited: false,
    });
  });

  it('limits query variants while keeping distinct query states', async () => {
    const root = 'https://app.test/';
    const { useCase, visits } = harness(
      new Map([[root, capture(root, ['/search?q=1', '/search?q=2', '/search?q=3'])]]),
    );
    const outcome = await useCase.execute(root, defaults);
    expect(visits).toEqual([root, 'https://app.test/search?q=1', 'https://app.test/search?q=2']);
    expect(outcome.result.graph.edges[2]?.skipReason).toBe('query-limit');
  });

  it('maps a redirect alias to one graph node', async () => {
    const root = 'https://app.test/';
    const redirect = 'https://app.test/redirect';
    const final = 'https://app.test/final';
    const { useCase, visits } = harness(
      new Map([
        [root, capture(root, ['/redirect', '/final'])],
        [redirect, capture(redirect, [], { finalUrl: final })],
      ]),
    );
    const outcome = await useCase.execute(root, defaults);
    expect(visits).toEqual([root, redirect]);
    expect(outcome.result.graph.nodes.map((node) => node.finalUrl)).toEqual([root, final]);
    expect(outcome.result.graph.edges[0]?.targetPageId).toBe('page-002');
    expect(outcome.result.graph.edges[1]?.targetPageId).toBe('page-002');
  });

  it('continues after a page-level failure and summarizes evidence', async () => {
    const root = 'https://app.test/';
    const broken = 'https://app.test/broken';
    const about = 'https://app.test/about';
    const failureEvidence = {
      console: [
        {
          type: 'error' as const,
          message: 'bad',
          pageUrl: broken,
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      pageErrors: [{ message: 'boom', pageUrl: broken, timestamp: '2026-01-01T00:00:00Z' }],
      failedRequests: [],
      httpErrors: [],
    };
    const { useCase, visits } = harness(
      new Map([
        [root, capture(root, ['/broken', '/about'])],
        [
          broken,
          capture(broken, [], { ok: false, warnings: ['timeout'], evidence: failureEvidence }),
        ],
        [about, capture(about)],
      ]),
    );
    const outcome = await useCase.execute(root, defaults);
    expect(visits).toEqual([root, broken, about]);
    expect(outcome.result.summary).toMatchObject({
      pagesVisited: 2,
      pagesFailed: 1,
      consoleErrors: 1,
      pageErrors: 1,
    });
    expect(outcome.result.graph.nodes[1]).toMatchObject({ state: 'failed', warnings: ['timeout'] });
  });

  it('creates deterministic filesystem-safe screenshot names', async () => {
    const root = 'https://app.test/';
    const { useCase, savedScreenshots } = harness(
      new Map([[root, capture(root, ['/Prøducts/one?q=1'])]]),
    );
    await useCase.execute(root, defaults);
    expect(savedScreenshots).toEqual(['001-home.png', '002-pr-c3-b8ducts-one.png']);
    expect(savedScreenshots.every((name) => /^\d{3}-[a-z0-9-]+\.png$/.test(name))).toBe(true);
  });
});
