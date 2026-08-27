import type { Page } from 'playwright';
import type {
  ConsoleEvidence,
  ExplorationEvidence,
  FailedRequestEvidence,
  HttpErrorEvidence,
  PageErrorEvidence,
} from '../domain/exploration.js';

const MAX_EVIDENCE_PER_TYPE = 200;

interface EvidenceCheckpoint {
  readonly console: number;
  readonly pageErrors: number;
  readonly failedRequests: number;
  readonly httpErrors: number;
}

export class PageEvidenceCollector {
  private readonly console: ConsoleEvidence[] = [];
  private readonly pageErrors: PageErrorEvidence[] = [];
  private readonly failedRequests: FailedRequestEvidence[] = [];
  private readonly httpErrors: HttpErrorEvidence[] = [];
  private didTruncate = false;

  public constructor(page: Page) {
    page.on('console', (message) => {
      const type = message.type();
      if (type !== 'error' && type !== 'warning') return;
      this.push(this.console, {
        type,
        message: message.text(),
        pageUrl: '',
        timestamp: new Date().toISOString(),
      });
    });
    page.on('pageerror', (error) => {
      this.push(this.pageErrors, {
        message: error.message,
        pageUrl: '',
        timestamp: new Date().toISOString(),
      });
    });
    page.on('requestfailed', (request) => {
      this.push(this.failedRequests, {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failureReason: request.failure()?.errorText ?? 'Unknown request failure',
        pageUrl: '',
        timestamp: new Date().toISOString(),
      });
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      this.push(this.httpErrors, {
        status: response.status(),
        method: request.method(),
        url: response.url(),
        resourceType: request.resourceType(),
        pageUrl: '',
        timestamp: new Date().toISOString(),
      });
    });
  }

  public get truncated(): boolean {
    return this.didTruncate;
  }

  public checkpoint(): EvidenceCheckpoint {
    return {
      console: this.console.length,
      pageErrors: this.pageErrors.length,
      failedRequests: this.failedRequests.length,
      httpErrors: this.httpErrors.length,
    };
  }

  public all(pageUrl: string): ExplorationEvidence {
    return this.since({ console: 0, pageErrors: 0, failedRequests: 0, httpErrors: 0 }, pageUrl);
  }

  public since(checkpoint: EvidenceCheckpoint, pageUrl: string): ExplorationEvidence {
    return {
      console: this.console.slice(checkpoint.console).map((entry) => ({ ...entry, pageUrl })),
      pageErrors: this.pageErrors
        .slice(checkpoint.pageErrors)
        .map((entry) => ({ ...entry, pageUrl })),
      failedRequests: this.failedRequests
        .slice(checkpoint.failedRequests)
        .map((entry) => ({ ...entry, pageUrl })),
      httpErrors: this.httpErrors
        .slice(checkpoint.httpErrors)
        .map((entry) => ({ ...entry, pageUrl })),
    };
  }

  private push<Value>(destination: Value[], value: Value): void {
    if (destination.length < MAX_EVIDENCE_PER_TYPE) destination.push(value);
    else this.didTruncate = true;
  }
}
