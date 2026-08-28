import { errors, type Dialog, type Download, type Page } from 'playwright';
import { BrowserStartupError } from '../application/errors.js';
import type {
  ExecutionBrowserCapture,
  ExecutionBrowserClickRequest,
  ExecutionBrowserStepRequest,
  ScenarioExecutionBrowser,
  ScenarioExecutionBrowserSession,
} from '../application/execution-ports.js';
import type { ExecutionFailureCode } from '../domain/execution.js';
import type { ExplorationEvidence } from '../domain/exploration.js';
import {
  actionDescriptor,
  ActionRiskClassifier,
  StateFingerprintService,
  type DialogEvidence,
  type DownloadEvidence,
  type InteractionCandidate,
  type InteractionEvidence,
  type PopupEvidence,
} from '../domain/interaction.js';
import {
  baseLocatorFor,
  clickDescriptor,
  configureNavigationGuard,
  discoverCandidates,
  NetworkActivityMonitor,
  observePageState,
  screenshotPage,
  settleAfterInteraction,
} from './interactive-page.js';
import {
  closeChromiumResources,
  launchChromiumContext,
  type ChromiumResources,
} from './chromium-context.js';
import { PageEvidenceCollector } from './evidence-collector.js';
import { navigateAndSettle } from './page-capture.js';

function emptyBrowserEvidence(): ExplorationEvidence {
  return { console: [], pageErrors: [], failedRequests: [], httpErrors: [] };
}

function emptyEvidence(): InteractionEvidence {
  return { browser: emptyBrowserEvidence(), dialogs: [], popups: [], downloads: [] };
}

function normalized(value: string | null): string | null {
  return value === null ? null : value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function sameLocator(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function popupScope(url: string, baseUrl: string): PopupEvidence['scope'] {
  try {
    return new URL(url).origin === new URL(baseUrl).origin ? 'same-origin' : 'external';
  } catch {
    return 'unknown';
  }
}

async function bestEffortScreenshot(page: Page): Promise<Buffer | null> {
  try {
    return await screenshotPage(page);
  } catch {
    return null;
  }
}

interface CandidateValidation {
  readonly candidate: InteractionCandidate | null;
  readonly code: ExecutionFailureCode | null;
  readonly reason: string | null;
}

class RuntimeActionValidator {
  private readonly classifier = new ActionRiskClassifier();

  public async validate(page: Page, stored: InteractionCandidate): Promise<CandidateValidation> {
    if (stored.locator === null) {
      return { candidate: null, code: 'ACTION_MISSING', reason: 'Stored action has no locator.' };
    }
    const count = await baseLocatorFor(page, stored.locator).count();
    if (count === 0) {
      return {
        candidate: null,
        code: 'ACTION_MISSING',
        reason: 'The stored semantic locator no longer resolves to an element.',
      };
    }
    if (count !== 1) {
      return {
        candidate: null,
        code: 'ACTION_AMBIGUOUS',
        reason: `The stored semantic locator resolves to ${String(count)} elements.`,
      };
    }
    const candidates = await discoverCandidates(page);
    const matches = candidates.filter((candidate) =>
      sameLocator(candidate.locator, stored.locator),
    );
    if (matches.length !== 1) {
      return {
        candidate: null,
        code: matches.length === 0 ? 'ACTION_MISSING' : 'ACTION_AMBIGUOUS',
        reason: 'The current candidate metadata cannot be resolved uniquely.',
      };
    }
    const current = matches[0];
    if (current === undefined) {
      return { candidate: null, code: 'ACTION_MISSING', reason: 'Current action is missing.' };
    }
    if (!current.visible || current.disabled) {
      return {
        candidate: current,
        code: 'ACTION_NOT_SAFE',
        reason: current.disabled ? 'The action is disabled.' : 'The action is not visible.',
      };
    }
    if (
      current.submitsForm ||
      current.fileUpload ||
      current.elementType === 'submit' ||
      current.elementType === 'reset'
    ) {
      return {
        candidate: current,
        code: 'FORM_ACTION_BLOCKED',
        reason: 'The runtime element is associated with a blocked form operation.',
      };
    }
    const semanticFields = [
      ['tag', stored.tag, current.tag],
      ['role', stored.role, current.role],
      ['accessible name', normalized(stored.accessibleName), normalized(current.accessibleName)],
      ['type', normalized(stored.elementType), normalized(current.elementType)],
      ['href', normalized(stored.href), normalized(current.href)],
      ['aria-label', normalized(stored.ariaLabel), normalized(current.ariaLabel)],
      ['aria-expanded', stored.ariaExpanded, current.ariaExpanded],
      ['aria-selected', stored.ariaSelected, current.ariaSelected],
      ['form association', stored.formAssociated, current.formAssociated],
      ['form submission', stored.submitsForm, current.submitsForm],
    ] as const;
    const drift = semanticFields.find(([, expected, actual]) => expected !== actual);
    if (drift !== undefined) {
      return {
        candidate: current,
        code: 'ACTION_SEMANTIC_DRIFT',
        reason: `Runtime ${drift[0]} differs from the observed SAFE candidate.`,
      };
    }
    const assessment = this.classifier.classify(current);
    if (assessment.risk !== 'SAFE') {
      return {
        candidate: current,
        code: 'ACTION_NOT_SAFE',
        reason: `Runtime action is ${assessment.risk} (${assessment.reason}).`,
      };
    }
    return { candidate: current, code: null, reason: null };
  }
}

class InteractionEventRecorder {
  public readonly dialogs: DialogEvidence[] = [];
  public readonly popups: PopupEvidence[] = [];
  public readonly downloads: DownloadEvidence[] = [];
  private readonly pending: Promise<void>[] = [];
  private recording = false;

  public constructor(page: Page, baseUrl: string) {
    page.on('dialog', (dialog: Dialog) => {
      if (this.recording) {
        this.dialogs.push({
          type: dialog.type(),
          message: dialog.message(),
          disposition: 'dismissed',
          timestamp: new Date().toISOString(),
        });
      }
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('popup', (popup) => {
      const shouldRecord = this.recording;
      const task = (async (): Promise<void> => {
        await popup.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => undefined);
        const url = popup.url();
        if (shouldRecord) {
          const scope = popupScope(url, baseUrl);
          this.popups.push({
            url,
            scope,
            disposition: scope === 'same-origin' ? 'registered-and-closed' : 'closed',
            timestamp: new Date().toISOString(),
          });
        }
        await popup.close().catch(() => undefined);
      })();
      this.pending.push(task);
    });
    page.on('download', (download: Download) => {
      const shouldRecord = this.recording;
      const task = (async (): Promise<void> => {
        if (shouldRecord) {
          this.downloads.push({
            url: download.url(),
            suggestedFilename: download.suggestedFilename(),
            disposition: 'cancelled',
            timestamp: new Date().toISOString(),
          });
        }
        await download.cancel().catch(() => undefined);
      })();
      this.pending.push(task);
    });
  }

  public start(): void {
    this.recording = true;
  }

  public async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}

class PlaywrightScenarioExecutionSession implements ScenarioExecutionBrowserSession {
  public readonly browserVersion: string;
  private readonly fingerprints = new StateFingerprintService();
  private readonly actions = new RuntimeActionValidator();
  private closed = false;

  public constructor(
    private readonly resources: ChromiumResources,
    private readonly tracePath: string,
  ) {
    this.browserVersion = resources.browser.version();
  }

  public async beginScenario(): Promise<void> {
    this.assertOpen();
    await Promise.all(
      this.resources.context.pages().map((page) => page.close().catch(() => undefined)),
    );
    await this.resources.context.clearCookies();
    await this.resources.context.clearPermissions();
    const cacheResetPage = await this.resources.context.newPage();
    try {
      const session = await this.resources.context.newCDPSession(cacheResetPage);
      try {
        await session.send('Network.clearBrowserCache');
      } finally {
        await session.detach();
      }
    } finally {
      await cacheResetPage.close().catch(() => undefined);
    }
  }

  public captureStart(request: ExecutionBrowserStepRequest): Promise<ExecutionBrowserCapture> {
    return this.navigate(request);
  }

  public async navigate(request: ExecutionBrowserStepRequest): Promise<ExecutionBrowserCapture> {
    this.assertOpen();
    const startedAt = Date.now();
    const page = await this.resources.context.newPage();
    const collector = new PageEvidenceCollector(page);
    const events = new InteractionEventRecorder(page, request.url);
    events.start();
    try {
      await configureNavigationGuard(page, request.canNavigate);
      await navigateAndSettle(page, request.url, request.navigationTimeoutMs);
      await events.settle();
      const observation = await observePageState(page);
      return {
        status: 'COMPLETED',
        actualUrl: observation.url,
        actualFingerprint: this.fingerprints.create(observation).hash,
        screenshot: await bestEffortScreenshot(page),
        durationMs: Date.now() - startedAt,
        failureCode: null,
        reason: null,
        evidence: {
          browser: collector.all(observation.url),
          dialogs: events.dialogs,
          popups: events.popups,
          downloads: events.downloads,
        },
      };
    } catch (error) {
      await events.settle();
      const timeout = error instanceof errors.TimeoutError;
      const url = page.url() === 'about:blank' ? request.url : page.url();
      return {
        status: timeout ? 'TIMEOUT' : 'ERROR',
        actualUrl: url,
        actualFingerprint: null,
        screenshot: await bestEffortScreenshot(page),
        durationMs: Date.now() - startedAt,
        failureCode: timeout ? 'STEP_TIMEOUT' : 'NAVIGATION_FAILED',
        reason: error instanceof Error ? error.message : 'Unknown navigation failure.',
        evidence: {
          browser: collector.all(url),
          dialogs: events.dialogs,
          popups: events.popups,
          downloads: events.downloads,
        },
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  public async click(request: ExecutionBrowserClickRequest): Promise<ExecutionBrowserCapture> {
    this.assertOpen();
    const startedAt = Date.now();
    const page = await this.resources.context.newPage();
    const collector = new PageEvidenceCollector(page);
    const network = new NetworkActivityMonitor(page);
    const events = new InteractionEventRecorder(page, request.url);
    let checkpoint = collector.checkpoint();
    try {
      await configureNavigationGuard(page, request.canNavigate);
      await navigateAndSettle(page, request.url, request.navigationTimeoutMs);
      let observation = await observePageState(page);
      for (const replay of request.replay) {
        const validation = await this.actions.validate(page, replay.candidate);
        if (validation.code !== null) {
          return await this.blocked(
            page,
            startedAt,
            validation.code,
            `Replay action ${replay.edge.id}: ${validation.reason ?? 'runtime safety block'}`,
          );
        }
        if (validation.candidate?.href !== null && validation.candidate?.href !== undefined) {
          let targetAllowed = false;
          try {
            targetAllowed = request.canNavigate(
              new URL(validation.candidate.href, page.url()).href,
            );
          } catch {
            targetAllowed = false;
          }
          if (!targetAllowed) {
            return await this.blocked(
              page,
              startedAt,
              'OUT_OF_SCOPE',
              `Replay action ${replay.edge.id} has an out-of-scope runtime target.`,
            );
          }
        }
        const sourceFingerprint = this.fingerprints.create(observation).hash;
        if (sourceFingerprint !== replay.sourceState.fingerprint) {
          return await this.blocked(
            page,
            startedAt,
            'SOURCE_STATE_DRIFT',
            `Replay source ${replay.sourceState.id} fingerprint no longer matches.`,
          );
        }
        await clickDescriptor(page, replay.edge.action, request.stepTimeoutMs);
        await settleAfterInteraction(page, network);
        observation = await observePageState(page);
        if (this.fingerprints.create(observation).hash !== replay.targetState.fingerprint) {
          return await this.blocked(
            page,
            startedAt,
            'SOURCE_STATE_DRIFT',
            `Replay action ${replay.edge.id} no longer reaches ${replay.targetState.id}.`,
          );
        }
      }
      const validation = await this.actions.validate(page, request.candidate);
      if (validation.code !== null) {
        return await this.blocked(
          page,
          startedAt,
          validation.code,
          validation.reason ?? 'Runtime safety validation blocked the action.',
        );
      }
      if (validation.candidate?.href !== null && validation.candidate?.href !== undefined) {
        let targetAllowed = false;
        try {
          targetAllowed = request.canNavigate(new URL(validation.candidate.href, page.url()).href);
        } catch {
          targetAllowed = false;
        }
        if (!targetAllowed) {
          return await this.blocked(
            page,
            startedAt,
            'OUT_OF_SCOPE',
            'The runtime action target is outside the source navigation policy.',
          );
        }
      }
      const sourceFingerprint = this.fingerprints.create(observation).hash;
      if (sourceFingerprint !== request.sourceState.fingerprint) {
        return await this.blocked(
          page,
          startedAt,
          'SOURCE_STATE_DRIFT',
          `Restored state does not match ${request.sourceState.id}.`,
        );
      }
      const currentDescriptor =
        validation.candidate === null ? null : actionDescriptor(validation.candidate);
      if (currentDescriptor === null || !sameLocator(currentDescriptor, request.action.action)) {
        return await this.blocked(
          page,
          startedAt,
          'ACTION_SEMANTIC_DRIFT',
          'The runtime action descriptor differs from the observed graph action.',
        );
      }

      checkpoint = collector.checkpoint();
      events.start();
      await clickDescriptor(page, request.action.action, request.stepTimeoutMs);
      await settleAfterInteraction(page, network);
      await events.settle();
      observation = await observePageState(page);
      return {
        status: 'COMPLETED',
        actualUrl: observation.url,
        actualFingerprint: this.fingerprints.create(observation).hash,
        screenshot: await bestEffortScreenshot(page),
        durationMs: Date.now() - startedAt,
        failureCode: null,
        reason: null,
        evidence: {
          browser: collector.since(checkpoint, observation.url),
          dialogs: events.dialogs,
          popups: events.popups,
          downloads: events.downloads,
        },
      };
    } catch (error) {
      await events.settle();
      const timeout = error instanceof errors.TimeoutError;
      const url = page.url() === 'about:blank' ? request.url : page.url();
      const evidence: InteractionEvidence = {
        browser: collector.since(checkpoint, url),
        dialogs: events.dialogs,
        popups: events.popups,
        downloads: events.downloads,
      };
      return {
        status: timeout ? 'TIMEOUT' : 'BLOCKED',
        actualUrl: url,
        actualFingerprint: null,
        screenshot: await bestEffortScreenshot(page),
        durationMs: Date.now() - startedAt,
        failureCode: timeout ? 'STEP_TIMEOUT' : 'ACTION_MISSING',
        reason: error instanceof Error ? error.message : 'Unknown action failure.',
        evidence,
      };
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
        `Could not save execution trace: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      await closeChromiumResources(this.resources);
    }
    return warnings;
  }

  private async blocked(
    page: Page,
    startedAt: number,
    code: ExecutionFailureCode,
    reason: string,
  ): Promise<ExecutionBrowserCapture> {
    let actualFingerprint: string | null = null;
    try {
      actualFingerprint = this.fingerprints.create(await observePageState(page)).hash;
    } catch {
      // The page may have detached while the runtime safety check was completing.
    }
    return {
      status: 'BLOCKED',
      actualUrl: page.url() === 'about:blank' ? null : page.url(),
      actualFingerprint,
      screenshot: await bestEffortScreenshot(page),
      durationMs: Date.now() - startedAt,
      failureCode: code,
      reason,
      evidence: emptyEvidence(),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Execution browser session is already closed.');
  }
}

export class PlaywrightScenarioExecutionBrowser implements ScenarioExecutionBrowser {
  public async start(request: {
    readonly headless: boolean;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly tracePath: string;
  }): Promise<ScenarioExecutionBrowserSession> {
    const resources = await launchChromiumContext({
      headless: request.headless,
      viewport: request.viewport,
      serviceWorkers: 'block',
    });
    try {
      await resources.context.addInitScript(() => {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
        } catch {
          // Storage may be unavailable for an opaque origin; execution remains isolated by page.
        }
      });
      await resources.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      return new PlaywrightScenarioExecutionSession(resources, request.tracePath);
    } catch (error) {
      await closeChromiumResources(resources);
      throw new BrowserStartupError(error);
    }
  }
}
