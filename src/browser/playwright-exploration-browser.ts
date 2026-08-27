import { errors, type BrowserContext, type Page } from 'playwright';
import { BrowserStartupError } from '../application/errors.js';
import type {
  ExplorationBrowser,
  ExplorationBrowserSession,
  ExplorationBrowserStartRequest,
  ExplorationPageCapture,
  ExplorationVisitRequest,
} from '../application/ports.js';
import type {
  ConsoleEvidence,
  ExplorationEvidence,
  FailedRequestEvidence,
  HttpErrorEvidence,
  PageErrorEvidence,
} from '../domain/exploration.js';
import type { ElementCounts, Viewport } from '../domain/inspection.js';
import {
  closeChromiumResources,
  launchChromiumContext,
  type ChromiumResources,
} from './chromium-context.js';
import { navigateAndSettle, readElementCounts, readPageLinks } from './page-capture.js';

const EMPTY_COUNTS: ElementCounts = { links: 0, buttons: 0, inputs: 0, forms: 0, headings: 0 };
const MAX_EVIDENCE_PER_PAGE_AND_TYPE = 200;

interface MutableEvidence {
  readonly console: ConsoleEvidence[];
  readonly pageErrors: PageErrorEvidence[];
  readonly failedRequests: FailedRequestEvidence[];
  readonly httpErrors: HttpErrorEvidence[];
  truncated: boolean;
}

function timestamp(): string {
  return new Date().toISOString();
}

function pushLimited<Value>(evidence: MutableEvidence, destination: Value[], value: Value): void {
  if (destination.length < MAX_EVIDENCE_PER_PAGE_AND_TYPE) {
    destination.push(value);
  } else {
    evidence.truncated = true;
  }
}

function withPageUrl(evidence: MutableEvidence, pageUrl: string): ExplorationEvidence {
  return {
    console: evidence.console.map((entry) => ({ ...entry, pageUrl })),
    pageErrors: evidence.pageErrors.map((entry) => ({ ...entry, pageUrl })),
    failedRequests: evidence.failedRequests.map((entry) => ({ ...entry, pageUrl })),
    httpErrors: evidence.httpErrors.map((entry) => ({ ...entry, pageUrl })),
  };
}

function collectEvidence(page: Page): MutableEvidence {
  const evidence: MutableEvidence = {
    console: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
    truncated: false,
  };

  page.on('console', (message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') return;
    pushLimited(evidence, evidence.console, {
      type,
      message: message.text(),
      pageUrl: '',
      timestamp: timestamp(),
    });
  });
  page.on('pageerror', (error) => {
    pushLimited(evidence, evidence.pageErrors, {
      message: error.message,
      pageUrl: '',
      timestamp: timestamp(),
    });
  });
  page.on('requestfailed', (request) => {
    pushLimited(evidence, evidence.failedRequests, {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      failureReason: request.failure()?.errorText ?? 'Unknown request failure',
      pageUrl: '',
      timestamp: timestamp(),
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    pushLimited(evidence, evidence.httpErrors, {
      status: response.status(),
      method: request.method(),
      url: response.url(),
      resourceType: request.resourceType(),
      pageUrl: '',
      timestamp: timestamp(),
    });
  });
  return evidence;
}

async function bestEffortScreenshot(page: Page): Promise<Buffer | null> {
  try {
    return await page.screenshot({ fullPage: true, type: 'png' });
  } catch {
    return null;
  }
}

class PlaywrightExplorationSession implements ExplorationBrowserSession {
  private closed = false;

  public constructor(
    private readonly resources: ChromiumResources,
    private readonly viewport: Viewport,
    private readonly tracePath: string,
  ) {}

  public async visit(request: ExplorationVisitRequest): Promise<ExplorationPageCapture> {
    if (this.closed) throw new Error('Exploration browser session is already closed.');
    const startedAt = new Date();
    const page = await this.resources.context.newPage();
    const evidence = collectEvidence(page);

    await page.route('**/*', async (route) => {
      const playwrightRequest = route.request();
      const isMainNavigation =
        playwrightRequest.isNavigationRequest() && playwrightRequest.frame() === page.mainFrame();
      if (isMainNavigation && !request.canNavigate(playwrightRequest.url())) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    try {
      let response;
      try {
        response = await navigateAndSettle(page, request.url, request.navigationTimeoutMs);
      } catch (error) {
        const completedAt = new Date();
        const warning =
          error instanceof errors.TimeoutError
            ? `Navigation timed out after ${String(request.navigationTimeoutMs)} ms.`
            : `Navigation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        const finalUrl = page.url() === 'about:blank' ? request.url : page.url();
        return {
          ok: false,
          requestedUrl: request.url,
          finalUrl,
          title: '',
          status: null,
          viewport: page.viewportSize() ?? this.viewport,
          elements: EMPTY_COUNTS,
          links: [],
          timestamp: startedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          warnings: evidence.truncated
            ? [warning, 'Page evidence was truncated to keep the result bounded.']
            : [warning],
          screenshot: await bestEffortScreenshot(page),
          evidence: withPageUrl(evidence, finalUrl),
        };
      }

      try {
        const [title, elements, links] = await Promise.all([
          page.title(),
          readElementCounts(page),
          readPageLinks(page),
        ]);
        const screenshot = await bestEffortScreenshot(page);
        const completedAt = new Date();
        const finalUrl = page.url();
        const warnings: string[] = [];
        if (screenshot === null) warnings.push('Could not capture the page screenshot.');
        if (evidence.truncated) {
          warnings.push('Page evidence was truncated to keep the result bounded.');
        }
        return {
          ok: true,
          requestedUrl: request.url,
          finalUrl,
          title,
          status: response?.status() ?? null,
          viewport: page.viewportSize() ?? this.viewport,
          elements,
          links,
          timestamp: startedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          warnings,
          screenshot,
          evidence: withPageUrl(evidence, finalUrl),
        };
      } catch (error) {
        const completedAt = new Date();
        const finalUrl = page.url() === 'about:blank' ? request.url : page.url();
        return {
          ok: false,
          requestedUrl: request.url,
          finalUrl,
          title: '',
          status: response?.status() ?? null,
          viewport: page.viewportSize() ?? this.viewport,
          elements: EMPTY_COUNTS,
          links: [],
          timestamp: startedAt.toISOString(),
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          warnings: [
            `Page capture failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          ],
          screenshot: await bestEffortScreenshot(page),
          evidence: withPageUrl(evidence, finalUrl),
        };
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  public async close(): Promise<readonly string[]> {
    if (this.closed) return [];
    this.closed = true;
    const warnings: string[] = [];
    try {
      await this.resources.context.tracing.stop({ path: this.tracePath });
    } catch (error) {
      warnings.push(
        `Could not save Playwright trace: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      await closeChromiumResources(this.resources);
    }
    return warnings;
  }
}

export class PlaywrightExplorationBrowser implements ExplorationBrowser {
  public async start(request: ExplorationBrowserStartRequest): Promise<ExplorationBrowserSession> {
    const resources = await launchChromiumContext(request);
    try {
      await this.startTracing(resources.context);
      return new PlaywrightExplorationSession(resources, request.viewport, request.tracePath);
    } catch (error) {
      await closeChromiumResources(resources);
      throw new BrowserStartupError(error);
    }
  }

  private async startTracing(context: BrowserContext): Promise<void> {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }
}
