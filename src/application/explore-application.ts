import type {
  ConsoleEvidence,
  ExplorationEvidence,
  ExplorationGraph,
  ExplorationLimits,
  ExplorationResult,
  FailedRequestEvidence,
  HttpErrorEvidence,
  LinkScope,
  LinkSkipReason,
  NavigationEdge,
  PageErrorEvidence,
  PageNode,
} from '../domain/exploration.js';
import type { Viewport } from '../domain/inspection.js';
import { parseTargetUrl } from '../domain/target-url.js';
import {
  canonicalizePageUrl,
  ConservativeNavigationSafetyPolicy,
  normalizeDiscoveredLink,
  QueryVariantLimiter,
  SameOriginScopePolicy,
} from '../domain/url-policy.js';
import type {
  Clock,
  ExplorationArtifactStore,
  ExplorationBrowser,
  RawPageLink,
  RunIdGenerator,
} from './ports.js';

const MAX_EVIDENCE_ENTRIES_PER_TYPE = 500;

export interface ExploreApplicationOptions extends ExplorationLimits {
  readonly headless: boolean;
  readonly navigationTimeoutMs: number;
  readonly viewport: Viewport;
}

export interface ExplorationOutcome {
  readonly result: ExplorationResult;
  readonly artifactDirectory: string;
}

interface QueueEntry {
  readonly url: string;
  readonly depth: number;
  readonly discoveredFrom: string | null;
}

interface MutableEdge {
  readonly id: string;
  readonly sourcePageId: string;
  readonly sourceUrl: string;
  readonly href: string;
  readonly targetUrl: string | null;
  readonly hint: string;
  readonly scope: LinkScope;
  readonly skipReason: LinkSkipReason | null;
}

interface MutableEvidence {
  readonly console: ConsoleEvidence[];
  readonly pageErrors: PageErrorEvidence[];
  readonly failedRequests: FailedRequestEvidence[];
  readonly httpErrors: HttpErrorEvidence[];
}

function screenshotFilename(order: number, urlValue: string): string {
  const pathname = new URL(urlValue).pathname;
  const slug =
    pathname === '/'
      ? 'home'
      : pathname
          .normalize('NFKD')
          .replaceAll(/[^a-zA-Z0-9]+/g, '-')
          .replaceAll(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 60) || 'page';
  return `${String(order).padStart(3, '0')}-${slug}.png`;
}

function emptyEvidence(): MutableEvidence {
  return { console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
}

function countConsole(evidence: ExplorationEvidence, type: 'error' | 'warning'): number {
  return evidence.console.filter((entry) => entry.type === type).length;
}

export class ExploreApplication {
  public constructor(
    private readonly browser: ExplorationBrowser,
    private readonly artifacts: ExplorationArtifactStore,
    private readonly runIds: RunIdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    urlInput: string,
    options: ExploreApplicationOptions,
  ): Promise<ExplorationOutcome> {
    const startUrl = canonicalizePageUrl(parseTargetUrl(urlInput));
    const startedAt = this.clock.now();
    const runId = this.runIds.next(startedAt);
    const locations = await this.artifacts.prepareExploration(runId);
    const scope = new SameOriginScopePolicy(startUrl);
    const safety = new ConservativeNavigationSafetyPolicy();
    const queryVariants = new QueryVariantLimiter(options.maxQueryVariantsPerPath);
    queryVariants.accept(startUrl);

    const queue: QueueEntry[] = [{ url: startUrl, depth: 0, discoveredFrom: null }];
    const scheduled = new Set([startUrl]);
    const attemptedUrls = new Set<string>();
    const successfulUrls = new Set<string>();
    const resolvedUrls = new Map<string, string>();
    const nodes: PageNode[] = [];
    const edges: MutableEdge[] = [];
    const evidence = emptyEvidence();
    const warnings: string[] = [];
    const truncatedEvidence = new Set<keyof MutableEvidence>();
    let pagesAttempted = 0;

    const session = await this.browser.start({
      headless: options.headless,
      viewport: options.viewport,
      tracePath: locations.tracePath,
    });

    const appendEvidence = <Entry>(
      key: keyof MutableEvidence,
      destination: Entry[],
      entries: readonly Entry[],
    ): void => {
      const remaining = MAX_EVIDENCE_ENTRIES_PER_TYPE - destination.length;
      if (entries.length > remaining && !truncatedEvidence.has(key)) {
        warnings.push(
          `Evidence category "${key}" was truncated at ${String(MAX_EVIDENCE_ENTRIES_PER_TYPE)} entries.`,
        );
        truncatedEvidence.add(key);
      }
      if (remaining > 0) destination.push(...entries.slice(0, remaining));
    };

    try {
      while (queue.length > 0 && pagesAttempted < options.maxPages) {
        const entry = queue.shift();
        if (entry === undefined) break;
        if (resolvedUrls.has(entry.url)) continue;

        pagesAttempted += 1;
        const capture = await session.visit({
          url: entry.url,
          navigationTimeoutMs: options.navigationTimeoutMs,
          canNavigate: (candidate) => {
            try {
              return scope.classify(candidate) === 'internal' && safety.allows(candidate);
            } catch {
              return false;
            }
          },
        });

        appendEvidence('console', evidence.console, capture.evidence.console);
        appendEvidence('pageErrors', evidence.pageErrors, capture.evidence.pageErrors);
        appendEvidence('failedRequests', evidence.failedRequests, capture.evidence.failedRequests);
        appendEvidence('httpErrors', evidence.httpErrors, capture.evidence.httpErrors);

        attemptedUrls.add(entry.url);
        let finalUrl = entry.url;
        try {
          finalUrl = canonicalizePageUrl(capture.finalUrl);
        } catch {
          // A failed navigation can leave Playwright at about:blank. The requested URL remains canonical.
        }
        attemptedUrls.add(finalUrl);

        const existingNodeId = capture.ok ? resolvedUrls.get(finalUrl) : undefined;
        if (existingNodeId !== undefined) {
          resolvedUrls.set(entry.url, existingNodeId);
          successfulUrls.add(entry.url);
          successfulUrls.add(finalUrl);
          continue;
        }

        const discoveryOrder = nodes.length + 1;
        const pageWarnings = [...capture.warnings];
        if (capture.status !== null && capture.status >= 400) {
          pageWarnings.push(`The main document returned HTTP ${String(capture.status)}.`);
        }

        let screenshot: string | null = null;
        if (capture.screenshot !== null) {
          const filename = screenshotFilename(discoveryOrder, finalUrl);
          await this.artifacts.savePageScreenshot(runId, filename, capture.screenshot);
          screenshot = `pages/${filename}`;
        }

        const node: PageNode = {
          id: `page-${String(discoveryOrder).padStart(3, '0')}`,
          requestedUrl: entry.url,
          finalUrl,
          title: capture.title,
          status: capture.status,
          state: capture.ok ? 'visited' : 'failed',
          depth: entry.depth,
          discoveryOrder,
          discoveredFrom: entry.discoveredFrom,
          viewport: capture.viewport,
          elements: capture.elements,
          timestamp: capture.timestamp,
          durationMs: capture.durationMs,
          screenshot,
          warnings: pageWarnings,
        };
        nodes.push(node);
        resolvedUrls.set(entry.url, node.id);
        resolvedUrls.set(finalUrl, node.id);

        if (!capture.ok) continue;
        successfulUrls.add(entry.url);
        successfulUrls.add(finalUrl);

        this.discoverLinks({
          links: capture.links,
          source: node,
          options,
          scope,
          safety,
          queryVariants,
          scheduled,
          resolvedUrls,
          queue,
          edges,
        });
      }
    } finally {
      warnings.push(...(await session.close()));
    }

    const finalizedEdges: NavigationEdge[] = edges.map((edge) => ({
      ...edge,
      targetPageId: edge.targetUrl === null ? null : (resolvedUrls.get(edge.targetUrl) ?? null),
      attempted: edge.targetUrl !== null && attemptedUrls.has(edge.targetUrl),
      visited: edge.targetUrl !== null && successfulUrls.has(edge.targetUrl),
    }));
    const graph: ExplorationGraph = {
      schemaVersion: '1.0',
      startUrl,
      nodes,
      edges: finalizedEdges,
    };
    const completedAt = this.clock.now();
    const immutableEvidence: ExplorationEvidence = evidence;
    const result: ExplorationResult = {
      schemaVersion: '2.0',
      runId,
      startUrl,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      limits: {
        maxPages: options.maxPages,
        maxDepth: options.maxDepth,
        maxQueryVariantsPerPath: options.maxQueryVariantsPerPath,
      },
      summary: {
        pagesAttempted,
        pagesVisited: nodes.filter((node) => node.state === 'visited').length,
        pagesFailed: nodes.filter((node) => node.state === 'failed').length,
        linksDiscovered: finalizedEdges.length,
        externalLinks: finalizedEdges.filter((edge) => edge.scope === 'external').length,
        consoleErrors: countConsole(immutableEvidence, 'error'),
        consoleWarnings: countConsole(immutableEvidence, 'warning'),
        pageErrors: immutableEvidence.pageErrors.length,
        failedRequests: immutableEvidence.failedRequests.length,
        httpErrors: immutableEvidence.httpErrors.length,
      },
      graph,
      evidence: immutableEvidence,
      warnings,
      artifacts: { graph: 'graph.json', trace: 'trace.zip', pagesDirectory: 'pages' },
    };

    await this.artifacts.saveExploration(runId, result);
    return { result, artifactDirectory: locations.directory };
  }

  private discoverLinks(input: {
    readonly links: readonly RawPageLink[];
    readonly source: PageNode;
    readonly options: ExploreApplicationOptions;
    readonly scope: SameOriginScopePolicy;
    readonly safety: ConservativeNavigationSafetyPolicy;
    readonly queryVariants: QueryVariantLimiter;
    readonly scheduled: Set<string>;
    readonly resolvedUrls: ReadonlyMap<string, string>;
    readonly queue: QueueEntry[];
    readonly edges: MutableEdge[];
  }): void {
    for (const link of input.links) {
      const normalized = normalizeDiscoveredLink(link.href, input.source.finalUrl);
      let targetUrl: string | null = null;
      let scope: LinkScope = 'unsupported';
      let skipReason: LinkSkipReason | null = 'unsupported';

      if (normalized.kind === 'page') {
        targetUrl = normalized.url;
        scope = input.scope.classify(targetUrl);
        skipReason = null;

        if (scope === 'external') {
          skipReason = null;
        } else if (!input.safety.allows(targetUrl)) {
          skipReason = 'unsafe';
        } else if (input.resolvedUrls.has(targetUrl) || input.scheduled.has(targetUrl)) {
          skipReason = 'duplicate';
        } else if (input.source.depth + 1 > input.options.maxDepth) {
          skipReason = 'max-depth';
        } else if (!input.queryVariants.accept(targetUrl)) {
          skipReason = 'query-limit';
        } else if (input.scheduled.size >= input.options.maxPages) {
          skipReason = 'max-pages';
        } else {
          input.scheduled.add(targetUrl);
          input.queue.push({
            url: targetUrl,
            depth: input.source.depth + 1,
            discoveredFrom: input.source.finalUrl,
          });
        }
      }

      input.edges.push({
        id: `edge-${String(input.edges.length + 1).padStart(4, '0')}`,
        sourcePageId: input.source.id,
        sourceUrl: input.source.finalUrl,
        href: link.href,
        targetUrl,
        hint: link.hint,
        scope,
        skipReason,
      });
    }
  }
}
