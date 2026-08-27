import { errors } from 'playwright';
import { NavigationFailedError, NavigationTimeoutError } from '../application/errors.js';
import type {
  BrowserCapture,
  BrowserInspectionRequest,
  BrowserInspector,
} from '../application/ports.js';
import { closeChromiumResources, launchChromiumContext } from './chromium-context.js';
import { navigateAndSettle, readPageSnapshot } from './page-capture.js';

export class PlaywrightPageInspector implements BrowserInspector {
  public async inspect(request: BrowserInspectionRequest): Promise<BrowserCapture> {
    const resources = await launchChromiumContext({
      headless: request.headless,
      viewport: request.viewport,
    });
    try {
      const page = await resources.context.newPage();

      let response;
      try {
        response = await navigateAndSettle(page, request.url, request.navigationTimeoutMs);
      } catch (error) {
        if (error instanceof errors.TimeoutError) {
          throw new NavigationTimeoutError(request.url, request.navigationTimeoutMs, error);
        }
        throw new NavigationFailedError(request.url, error);
      }

      const [snapshot, screenshot] = await Promise.all([
        readPageSnapshot(page, response?.status() ?? null, request.viewport),
        page.screenshot({ fullPage: true, type: 'png' }),
      ]);

      return { page: snapshot, screenshot };
    } finally {
      await closeChromiumResources(resources);
    }
  }
}
