import type { ElementCounts, Viewport } from './inspection.js';
import type { InteractiveLimits, InteractiveSummary, StateGraph } from './interaction.js';

export type PageVisitState = 'visited' | 'failed';
export type LinkScope = 'internal' | 'external' | 'unsupported';
export type LinkSkipReason =
  'duplicate' | 'max-depth' | 'max-pages' | 'query-limit' | 'unsafe' | 'unsupported';

export interface PageNode {
  readonly id: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly status: number | null;
  readonly state: PageVisitState;
  readonly depth: number;
  readonly discoveryOrder: number;
  readonly discoveredFrom: string | null;
  readonly viewport: Viewport;
  readonly elements: ElementCounts;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly screenshot: string | null;
  readonly warnings: readonly string[];
}

export interface NavigationEdge {
  readonly id: string;
  readonly sourcePageId: string;
  readonly sourceUrl: string;
  readonly href: string;
  readonly targetUrl: string | null;
  readonly hint: string;
  readonly scope: LinkScope;
  readonly targetPageId: string | null;
  readonly attempted: boolean;
  readonly visited: boolean;
  readonly skipReason: LinkSkipReason | null;
}

export interface ExplorationGraph {
  readonly schemaVersion: '1.0';
  readonly startUrl: string;
  readonly nodes: readonly PageNode[];
  readonly edges: readonly NavigationEdge[];
}

export interface ConsoleEvidence {
  readonly type: 'error' | 'warning';
  readonly message: string;
  readonly pageUrl: string;
  readonly timestamp: string;
}

export interface PageErrorEvidence {
  readonly message: string;
  readonly pageUrl: string;
  readonly timestamp: string;
}

export interface FailedRequestEvidence {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly failureReason: string;
  readonly pageUrl: string;
  readonly timestamp: string;
}

export interface HttpErrorEvidence {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly pageUrl: string;
  readonly timestamp: string;
}

export interface ExplorationEvidence {
  readonly console: readonly ConsoleEvidence[];
  readonly pageErrors: readonly PageErrorEvidence[];
  readonly failedRequests: readonly FailedRequestEvidence[];
  readonly httpErrors: readonly HttpErrorEvidence[];
}

export interface ExplorationLimits {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly maxQueryVariantsPerPath: number;
}

export interface ExplorationSummary {
  readonly pagesAttempted: number;
  readonly pagesVisited: number;
  readonly pagesFailed: number;
  readonly linksDiscovered: number;
  readonly externalLinks: number;
  readonly consoleErrors: number;
  readonly consoleWarnings: number;
  readonly pageErrors: number;
  readonly failedRequests: number;
  readonly httpErrors: number;
}

export interface ExplorationResult {
  readonly schemaVersion: '3.0';
  readonly runId: string;
  readonly startUrl: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly limits: ExplorationLimits;
  readonly interactiveLimits: InteractiveLimits;
  readonly summary: ExplorationSummary;
  readonly interactive: InteractiveSummary;
  readonly graph: ExplorationGraph;
  readonly stateGraph: StateGraph | null;
  readonly evidence: ExplorationEvidence;
  readonly warnings: readonly string[];
  readonly artifacts: {
    readonly graph: 'graph.json';
    readonly trace: 'trace.zip';
    readonly pagesDirectory: 'pages';
    readonly stateGraph: 'state-graph.json' | null;
    readonly statesDirectory: 'states' | null;
  };
}
