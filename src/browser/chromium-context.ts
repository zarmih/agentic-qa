import { chromium, type Browser, type BrowserContext } from 'playwright';
import { BrowserStartupError } from '../application/errors.js';
import type { Viewport } from '../domain/inspection.js';

export interface ChromiumResources {
  readonly browser: Browser;
  readonly context: BrowserContext;
}

export async function launchChromiumContext(options: {
  readonly headless: boolean;
  readonly viewport: Viewport;
}): Promise<ChromiumResources> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: options.headless });
    const context = await browser.newContext({ viewport: options.viewport });
    return { browser, context };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    throw new BrowserStartupError(error);
  }
}

export async function closeChromiumResources(resources: ChromiumResources): Promise<void> {
  await resources.context.close().catch(() => undefined);
  await resources.browser.close().catch(() => undefined);
}
