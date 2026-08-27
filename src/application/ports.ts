import type { InspectionResult, PageSnapshot, Viewport } from '../domain/inspection.js';

export interface BrowserInspectionRequest {
  readonly url: string;
  readonly headless: boolean;
  readonly navigationTimeoutMs: number;
  readonly viewport: Viewport;
}

export interface BrowserCapture {
  readonly page: PageSnapshot;
  readonly screenshot: Buffer;
}

export interface BrowserInspector {
  inspect(request: BrowserInspectionRequest): Promise<BrowserCapture>;
}

export interface ArtifactStore {
  prepare(runId: string): Promise<string>;
  save(runId: string, result: InspectionResult, screenshot: Buffer): Promise<void>;
}

export interface RunIdGenerator {
  next(at: Date): string;
}

export interface Clock {
  now(): Date;
}
