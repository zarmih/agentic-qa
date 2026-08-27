export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface ElementCounts {
  readonly links: number;
  readonly buttons: number;
  readonly inputs: number;
  readonly forms: number;
  readonly headings: number;
}

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly status: number | null;
  readonly viewport: Viewport;
  readonly elements: ElementCounts;
}

export interface InspectionResult {
  readonly schemaVersion: '1.0';
  readonly runId: string;
  readonly requestedUrl: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly page: PageSnapshot;
  readonly artifacts: {
    readonly screenshot: 'page.png';
  };
  readonly warnings: readonly string[];
}
