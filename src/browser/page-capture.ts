import { errors, type Page, type Response } from 'playwright';
import type { ElementCounts, PageSnapshot, Viewport } from '../domain/inspection.js';
import type { RawPageLink } from '../application/ports.js';

export async function navigateAndSettle(
  page: Page,
  url: string,
  navigationTimeoutMs: number,
): Promise<Response | null> {
  const response = await page.goto(url, {
    timeout: navigationTimeoutMs,
    waitUntil: 'domcontentloaded',
  });

  try {
    await page.waitForLoadState('networkidle', {
      timeout: Math.min(navigationTimeoutMs, 2_000),
    });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
  return response;
}

export async function readElementCounts(page: Page): Promise<ElementCounts> {
  const [links, buttons, inputs, forms, headings] = await Promise.all([
    page.locator('a').count(),
    page.locator('button, input[type="button"], input[type="submit"], input[type="reset"]').count(),
    page.locator('input').count(),
    page.locator('form').count(),
    page.locator('h1, h2, h3, h4, h5, h6').count(),
  ]);
  return { links, buttons, inputs, forms, headings };
}

export async function readPageSnapshot(
  page: Page,
  status: number | null,
  fallbackViewport: Viewport,
): Promise<PageSnapshot> {
  const [title, elements] = await Promise.all([page.title(), readElementCounts(page)]);
  return {
    url: page.url(),
    title,
    status,
    viewport: page.viewportSize() ?? fallbackViewport,
    elements,
  };
}

export async function readPageLinks(page: Page): Promise<readonly RawPageLink[]> {
  return page.locator('a').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      hint: (anchor.getAttribute('aria-label') ?? anchor.textContent)
        .trim()
        .replaceAll(/\s+/g, ' ')
        .slice(0, 200),
    })),
  );
}
