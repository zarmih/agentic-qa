import { chromium, errors, type Browser, type BrowserContext } from 'playwright';
import {
  BrowserStartupError,
  NavigationFailedError,
  NavigationTimeoutError,
} from '../application/errors.js';
import type {
  BrowserCapture,
  BrowserInspectionRequest,
  BrowserInspector,
} from '../application/ports.js';

export class PlaywrightPageInspector implements BrowserInspector {
  public async inspect(request: BrowserInspectionRequest): Promise<BrowserCapture> {
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: request.headless });
    } catch (error) {
      throw new BrowserStartupError(error);
    }

    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ viewport: request.viewport });
      const page = await context.newPage();

      let response;
      try {
        response = await page.goto(request.url, {
          timeout: request.navigationTimeoutMs,
          waitUntil: 'domcontentloaded',
        });
      } catch (error) {
        if (error instanceof errors.TimeoutError) {
          throw new NavigationTimeoutError(request.url, request.navigationTimeoutMs, error);
        }
        throw new NavigationFailedError(request.url, error);
      }

      try {
        await page.waitForLoadState('networkidle', {
          timeout: Math.min(request.navigationTimeoutMs, 2_000),
        });
      } catch (error) {
        if (!(error instanceof errors.TimeoutError)) {
          throw error;
        }
      }

      const [title, links, buttons, inputs, forms, headings, screenshot] = await Promise.all([
        page.title(),
        page.locator('a').count(),
        page
          .locator('button, input[type="button"], input[type="submit"], input[type="reset"]')
          .count(),
        page.locator('input').count(),
        page.locator('form').count(),
        page.locator('h1, h2, h3, h4, h5, h6').count(),
        page.screenshot({ fullPage: true, type: 'png' }),
      ]);

      return {
        page: {
          url: page.url(),
          title,
          status: response?.status() ?? null,
          viewport: page.viewportSize() ?? request.viewport,
          elements: { links, buttons, inputs, forms, headings },
        },
        screenshot,
      };
    } finally {
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }
}
