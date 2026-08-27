import { errors, type BrowserContext, type Page } from 'playwright';
import { BrowserStartupError } from '../application/errors.js';
import type {
  BrowserInteractionCapture,
  BrowserInteractionRequest,
  BrowserStateCapture,
  BrowserStateCaptureRequest,
  ExplorationBrowser,
  ExplorationBrowserSession,
  ExplorationBrowserStartRequest,
  ExplorationPageCapture,
  ExplorationVisitRequest,
} from '../application/ports.js';
import type { ElementCounts, Viewport } from '../domain/inspection.js';
import {
  closeChromiumResources,
  launchChromiumContext,
  type ChromiumResources,
} from './chromium-context.js';
import { navigateAndSettle, readElementCounts, readPageLinks } from './page-capture.js';
import { PageEvidenceCollector } from './evidence-collector.js';
import { InteractivePageController } from './interactive-page.js';

const EMPTY_COUNTS: ElementCounts = { links: 0, buttons: 0, inputs: 0, forms: 0, headings: 0 };
async function bestEffortScreenshot(page: Page): Promise<Buffer | null> {
  try {
    return await page.screenshot({ fullPage: true, type: 'png' });
  } catch {
    return null;
  }
}

class PlaywrightExplorationSession implements ExplorationBrowserSession {
  private closed = false;
  private readonly interactive = new InteractivePageController();

  public constructor(
    private readonly resources: ChromiumResources,
    private readonly viewport: Viewport,
    private readonly tracePath: string,
  ) {}

  public async visit(request: ExplorationVisitRequest): Promise<ExplorationPageCapture> {
    if (this.closed) throw new Error('Exploration browser session is already closed.');
    const startedAt = new Date();
    const page = await this.resources.context.newPage();
    const evidence = new PageEvidenceCollector(page);

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
          evidence: evidence.all(finalUrl),
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
          evidence: evidence.all(finalUrl),
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
          evidence: evidence.all(finalUrl),
        };
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  public async captureState(request: BrowserStateCaptureRequest): Promise<BrowserStateCapture> {
    if (this.closed) throw new Error('Exploration browser session is already closed.');
    const page = await this.resources.context.newPage();
    try {
      return await this.interactive.capture(page, request);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  public async performInteraction(
    request: BrowserInteractionRequest,
  ): Promise<BrowserInteractionCapture> {
    if (this.closed) throw new Error('Exploration browser session is already closed.');
    const page = await this.resources.context.newPage();
    try {
      return await this.interactive.interact(page, request);
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
