import type { InspectionResult, Viewport } from '../domain/inspection.js';
import { parseTargetUrl } from '../domain/target-url.js';
import type { ArtifactStore, BrowserInspector, Clock, RunIdGenerator } from './ports.js';

export interface InspectPageOptions {
  readonly headless: boolean;
  readonly navigationTimeoutMs: number;
  readonly viewport: Viewport;
}

export interface InspectionOutcome {
  readonly result: InspectionResult;
  readonly artifactDirectory: string;
}

export class InspectPage {
  public constructor(
    private readonly browser: BrowserInspector,
    private readonly artifacts: ArtifactStore,
    private readonly runIds: RunIdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(urlInput: string, options: InspectPageOptions): Promise<InspectionOutcome> {
    const requestedUrl = parseTargetUrl(urlInput);
    const startedAt = this.clock.now();
    const runId = this.runIds.next(startedAt);
    const artifactDirectory = await this.artifacts.prepare(runId);

    const capture = await this.browser.inspect({
      url: requestedUrl,
      headless: options.headless,
      navigationTimeoutMs: options.navigationTimeoutMs,
      viewport: options.viewport,
    });

    const completedAt = this.clock.now();
    const warnings: string[] = [];
    if (capture.page.status !== null && capture.page.status >= 400) {
      warnings.push(`The main document returned HTTP ${String(capture.page.status)}.`);
    }

    const result: InspectionResult = {
      schemaVersion: '1.0',
      runId,
      requestedUrl,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      page: capture.page,
      artifacts: { screenshot: 'page.png' },
      warnings,
    };

    await this.artifacts.save(runId, result, capture.screenshot);
    return { result, artifactDirectory };
  }
}
