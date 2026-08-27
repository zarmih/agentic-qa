import {
  errors,
  type Dialog,
  type Download,
  type Locator,
  type Page,
  type Request,
} from 'playwright';
import type {
  BrowserInteractionCapture,
  BrowserInteractionRequest,
  BrowserStateCapture,
  BrowserStateCaptureRequest,
} from '../application/ports.js';
import type { ExplorationEvidence } from '../domain/exploration.js';
import {
  rankLocator,
  StateFingerprintService,
  type ActionDescriptor,
  type DialogEvidence,
  type DownloadEvidence,
  type InteractionCandidate,
  type PopupEvidence,
  type StateObservation,
} from '../domain/interaction.js';
import { navigateAndSettle } from './page-capture.js';
import { PageEvidenceCollector } from './evidence-collector.js';

const CANDIDATE_SELECTOR =
  'button, a, [role="button"], [role="tab"], [role="menuitem"], [aria-expanded], summary, select, input, textarea';
const MAX_CANDIDATES_PER_STATE = 100;

function emptyEvidence(): ExplorationEvidence {
  return { console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
}

function emptyInteractionEvidence() {
  return { browser: emptyEvidence(), dialogs: [], popups: [], downloads: [] } as const;
}

function normalize(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').slice(0, 200);
}

function popupScope(url: string, baseUrl: string): PopupEvidence['scope'] {
  try {
    return new URL(url).origin === new URL(baseUrl).origin ? 'same-origin' : 'external';
  } catch {
    return 'unknown';
  }
}

class NetworkActivityMonitor {
  private readonly active = new Set<Request>();
  private lastActivity = Date.now();

  public constructor(page: Page) {
    page.on('request', (request) => {
      this.active.add(request);
      this.lastActivity = Date.now();
    });
    const completed = (request: Request): void => {
      this.active.delete(request);
      this.lastActivity = Date.now();
    };
    page.on('requestfinished', completed);
    page.on('requestfailed', completed);
  }

  public waitForQuiet(quietMs = 75, maximumMs = 700): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const poll = (): void => {
        const now = Date.now();
        if (
          (this.active.size === 0 && now - this.lastActivity >= quietMs) ||
          now - startedAt >= maximumMs
        ) {
          resolve();
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  }
}

async function discoverCandidates(page: Page): Promise<readonly InteractionCandidate[]> {
  const raw = await page.locator(CANDIDATE_SELECTOR).evaluateAll((elements, maximum) => {
    return elements.slice(0, maximum).map((element) => {
      const html = element as HTMLElement;
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute('type')?.trim().toLowerCase() ?? null;
      const text = element.textContent.trim().replaceAll(/\s+/g, ' ').slice(0, 200);
      const ariaLabel = element.getAttribute('aria-label');
      const labels = 'labels' in html ? (html as HTMLInputElement).labels : null;
      const label = (labels?.[0]?.textContent ?? '').trim().replaceAll(/\s+/g, ' ').slice(0, 200);
      const title = element.getAttribute('title');
      const labelledBy = (element.getAttribute('aria-labelledby')?.split(/\s+/) ?? [])
        .filter(Boolean)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ');
      const accessibleName =
        [ariaLabel, labelledBy, label, element.getAttribute('alt'), title, text]
          .find((value) => value !== null && value.trim() !== '')
          ?.trim()
          .replaceAll(/\s+/g, ' ')
          .slice(0, 200) ?? '';
      let role = element.getAttribute('role')?.trim().toLowerCase() ?? '';
      if (role === '' && (tag === 'button' || tag === 'summary')) role = 'button';
      else if (role === '' && tag === 'a' && element.hasAttribute('href')) role = 'link';
      else if (role === '' && tag === 'select') role = 'combobox';
      else if (role === '' && tag === 'textarea') role = 'textbox';
      else if (role === '' && tag === 'input' && type === 'checkbox') role = 'checkbox';
      else if (role === '' && tag === 'input' && type === 'radio') role = 'radio';
      else if (role === '' && tag === 'input' && ['button', 'submit', 'reset'].includes(type ?? ''))
        role = 'button';
      else if (role === '' && tag === 'input') role = 'textbox';
      const style = window.getComputedStyle(element);
      const rect = html.getBoundingClientRect();
      const visible =
        !html.hidden &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0;
      const form =
        'form' in html && (html as HTMLButtonElement).form instanceof HTMLFormElement
          ? (html as HTMLButtonElement).form
          : html.closest('form');
      const submitsForm =
        form !== null &&
        ((tag === 'button' && (type === null || type === 'submit')) ||
          (tag === 'input' && type === 'submit'));
      return {
        tag,
        role,
        accessibleName,
        text,
        href: element.getAttribute('href'),
        elementType: type,
        ariaLabel,
        title,
        ariaExpanded:
          element.getAttribute('aria-expanded') === null
            ? null
            : element.getAttribute('aria-expanded') === 'true',
        ariaSelected:
          element.getAttribute('aria-selected') === null
            ? null
            : element.getAttribute('aria-selected') === 'true',
        disabled:
          element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
        visible,
        formAssociated: form !== null,
        submitsForm,
        fileUpload: tag === 'input' && type === 'file',
        testId: element.getAttribute('data-testid'),
        label: label === '' ? null : label,
        stableId: element.getAttribute('id'),
      };
    });
  }, MAX_CANDIDATES_PER_STATE);

  return raw.map((candidate, domOrder) => {
    const roleNameMatches = raw.filter(
      (item) => item.role === candidate.role && item.accessibleName === candidate.accessibleName,
    );
    const labelMatches = raw.filter((item) => item.label === candidate.label);
    const textMatches = raw.filter((item) => item.text === candidate.text);
    const base = {
      ...candidate,
      id: `candidate-${String(domOrder + 1).padStart(3, '0')}`,
      domOrder,
    };
    return {
      ...base,
      locator: rankLocator(base, {
        testIdCount: raw.filter((item) => item.testId === candidate.testId).length,
        roleNameIndex: roleNameMatches.indexOf(candidate),
        labelCount: labelMatches.length,
        labelIndex: labelMatches.indexOf(candidate),
        idCount: raw.filter((item) => item.stableId === candidate.stableId).length,
        textCount: textMatches.length,
        textIndex: textMatches.indexOf(candidate),
      }),
    };
  });
}

async function observe(page: Page): Promise<StateObservation> {
  const [title, headings, dialogs, candidates] = await Promise.all([
    page.title(),
    page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(element);
          const rect = html.getBoundingClientRect();
          return (
            !html.hidden &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .map((element) => element.textContent.trim().replaceAll(/\s+/g, ' ').slice(0, 200))
        .filter(Boolean)
        .slice(0, 30),
    ),
    page.locator('[role="dialog"], dialog[open]').evaluateAll((elements) =>
      elements
        .filter((element) => {
          const html = element as HTMLElement;
          const style = window.getComputedStyle(element);
          const rect = html.getBoundingClientRect();
          return (
            !html.hidden &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .map((element) =>
          (element.getAttribute('aria-label') ?? element.textContent)
            .trim()
            .replaceAll(/\s+/g, ' ')
            .slice(0, 200),
        )
        .filter(Boolean)
        .slice(0, 10),
    ),
    discoverCandidates(page),
  ]);
  return { url: page.url(), title: normalize(title), headings, dialogs, candidates };
}

async function screenshot(page: Page): Promise<Buffer> {
  return page.screenshot({ fullPage: true, type: 'png' });
}

async function configureNavigationGuard(
  page: Page,
  canNavigate: (url: string) => boolean,
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    if (mainNavigation && !canNavigate(request.url())) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}

function locatorFor(page: Page, descriptor: ActionDescriptor['locator']): Locator {
  switch (descriptor.strategy) {
    case 'testId':
      return page.getByTestId(descriptor.value).nth(descriptor.index);
    case 'role':
      return page
        .getByRole(descriptor.role as Parameters<Page['getByRole']>[0], {
          name: descriptor.name,
          exact: true,
        })
        .nth(descriptor.index);
    case 'label':
      return page.getByLabel(descriptor.value, { exact: true }).nth(descriptor.index);
    case 'id':
      return page.locator(`[id=${JSON.stringify(descriptor.value)}]`).nth(descriptor.index);
    case 'text':
      return page.getByText(descriptor.value, { exact: true }).nth(descriptor.index);
  }
}

async function clickDescriptor(
  page: Page,
  descriptor: ActionDescriptor,
  timeoutMs: number,
): Promise<void> {
  const locator = locatorFor(page, descriptor.locator);
  if ((await locator.count()) === 0)
    throw new Error('The replay locator no longer matches an element.');
  if (!(await locator.isVisible())) throw new Error('The replay locator is not visible.');
  if (!(await locator.isEnabled())) throw new Error('The replay locator is disabled.');
  await locator.click({ timeout: timeoutMs });
}

async function settleAfterInteraction(page: Page, network: NetworkActivityMonitor): Promise<void> {
  await page
    .evaluate(
      ({ quietMs, maximumMs }) =>
        new Promise<void>((resolve) => {
          let quietTimer = window.setTimeout(done, quietMs);
          const maximumTimer = window.setTimeout(done, maximumMs);
          const observer = new MutationObserver(() => {
            window.clearTimeout(quietTimer);
            quietTimer = window.setTimeout(done, quietMs);
          });
          function done(): void {
            window.clearTimeout(quietTimer);
            window.clearTimeout(maximumTimer);
            observer.disconnect();
            resolve();
          }
          observer.observe(document.documentElement, {
            attributes: true,
            childList: true,
            subtree: true,
          });
        }),
      { quietMs: 75, maximumMs: 600 },
    )
    .catch(() => undefined);
  await network.waitForQuiet();
}

export class InteractivePageController {
  private readonly fingerprints = new StateFingerprintService();

  public async capture(
    page: Page,
    request: BrowserStateCaptureRequest,
  ): Promise<BrowserStateCapture> {
    const evidence = new PageEvidenceCollector(page);
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on('popup', (popup) => void popup.close().catch(() => undefined));
    await configureNavigationGuard(page, request.canNavigate);
    await navigateAndSettle(page, request.url, request.navigationTimeoutMs);
    const observation = await observe(page);
    return {
      observation,
      screenshot: await screenshot(page),
      timestamp: new Date().toISOString(),
      truncated: evidence.truncated || observation.candidates.length >= MAX_CANDIDATES_PER_STATE,
    };
  }

  public async interact(
    page: Page,
    request: BrowserInteractionRequest,
  ): Promise<BrowserInteractionCapture> {
    const startedAt = Date.now();
    const collector = new PageEvidenceCollector(page);
    const network = new NetworkActivityMonitor(page);
    const dialogs: DialogEvidence[] = [];
    const popups: PopupEvidence[] = [];
    const downloads: DownloadEvidence[] = [];
    const discoveredUrls: string[] = [];
    let recordEvents = false;
    let targetCheckpoint: ReturnType<PageEvidenceCollector['checkpoint']> | null = null;
    const pendingEvents: Promise<void>[] = [];

    const dismissDialog = (dialog: Dialog): void => {
      if (recordEvents) {
        dialogs.push({
          type: dialog.type(),
          message: dialog.message(),
          disposition: 'dismissed',
          timestamp: new Date().toISOString(),
        });
      }
      void dialog.dismiss().catch(() => undefined);
    };
    page.on('dialog', dismissDialog);
    page.on('popup', (popup) => {
      const task = (async () => {
        await popup.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => undefined);
        const url = popup.url();
        const scope = popupScope(url, request.url);
        if (recordEvents) {
          popups.push({
            url,
            scope,
            disposition: scope === 'same-origin' ? 'registered-and-closed' : 'closed',
            timestamp: new Date().toISOString(),
          });
          if (scope === 'same-origin') discoveredUrls.push(url);
        }
        await popup.close().catch(() => undefined);
      })();
      pendingEvents.push(task);
    });
    page.on('download', (download: Download) => {
      const task = (async () => {
        if (recordEvents) {
          downloads.push({
            url: download.url(),
            suggestedFilename: download.suggestedFilename(),
            disposition: 'cancelled',
            timestamp: new Date().toISOString(),
          });
        }
        await download.cancel().catch(() => undefined);
      })();
      pendingEvents.push(task);
    });

    try {
      await configureNavigationGuard(page, request.canNavigate);
      await navigateAndSettle(page, request.url, request.navigationTimeoutMs);
      for (const replayAction of request.replayPath) {
        await clickDescriptor(page, replayAction, request.actionTimeoutMs);
        await settleAfterInteraction(page, network);
      }
      const sourceObservation = await observe(page);
      if (this.fingerprints.create(sourceObservation).hash !== request.expectedSourceFingerprint) {
        return {
          status: 'BLOCKED',
          sourceUrl: sourceObservation.url,
          result: null,
          durationMs: Date.now() - startedAt,
          reason: 'State restoration fingerprint did not match the expected source state.',
          evidence: emptyInteractionEvidence(),
          discoveredUrls: [],
        };
      }

      const descriptor =
        request.candidate.locator === null
          ? null
          : {
              actionType: 'click' as const,
              identity: '',
              locator: request.candidate.locator,
              role: request.candidate.role,
              accessibleName: request.candidate.accessibleName,
              visibleText: request.candidate.text,
            };
      if (descriptor === null) {
        return {
          status: 'BLOCKED',
          sourceUrl: sourceObservation.url,
          result: null,
          durationMs: Date.now() - startedAt,
          reason: 'Candidate has no replayable locator.',
          evidence: emptyInteractionEvidence(),
          discoveredUrls: [],
        };
      }

      const checkpoint = collector.checkpoint();
      targetCheckpoint = checkpoint;
      recordEvents = true;
      await clickDescriptor(page, descriptor, request.actionTimeoutMs);
      await settleAfterInteraction(page, network);
      await Promise.allSettled(pendingEvents);
      const observation = await observe(page);
      return {
        status: 'COMPLETED',
        sourceUrl: sourceObservation.url,
        result: {
          observation,
          screenshot: await screenshot(page),
          timestamp: new Date().toISOString(),
          truncated:
            collector.truncated || observation.candidates.length >= MAX_CANDIDATES_PER_STATE,
        },
        durationMs: Date.now() - startedAt,
        reason: null,
        evidence: {
          browser: collector.since(checkpoint, observation.url),
          dialogs,
          popups,
          downloads,
        },
        discoveredUrls,
      };
    } catch (error) {
      await Promise.allSettled(pendingEvents);
      const timeout = error instanceof errors.TimeoutError;
      const currentUrl = page.url() === 'about:blank' ? request.url : page.url();
      return {
        status: timeout ? 'TIMEOUT' : 'FAILED',
        sourceUrl: currentUrl,
        result: null,
        durationMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : 'Unknown interaction failure',
        evidence: {
          browser:
            targetCheckpoint === null
              ? collector.all(currentUrl)
              : collector.since(targetCheckpoint, currentUrl),
          dialogs,
          popups,
          downloads,
        },
        discoveredUrls,
      };
    }
  }
}
