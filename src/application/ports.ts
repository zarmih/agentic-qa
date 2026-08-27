import type { ExplorationEvidence, ExplorationResult } from '../domain/exploration.js';
import type {
  ActionDescriptor,
  InteractionCandidate,
  InteractionEvidence,
  StateObservation,
} from '../domain/interaction.js';
import type {
  ElementCounts,
  InspectionResult,
  PageSnapshot,
  Viewport,
} from '../domain/inspection.js';

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

export interface ExplorationArtifactLocations {
  readonly directory: string;
  readonly tracePath: string;
}

export interface ExplorationArtifactStore {
  prepareExploration(runId: string, interactive: boolean): Promise<ExplorationArtifactLocations>;
  saveExploration(runId: string, result: ExplorationResult): Promise<void>;
  savePageScreenshot(runId: string, filename: string, screenshot: Buffer): Promise<void>;
  saveStateScreenshot(runId: string, filename: string, screenshot: Buffer): Promise<void>;
}

export interface BrowserStateCapture {
  readonly observation: StateObservation;
  readonly screenshot: Buffer;
  readonly timestamp: string;
  readonly truncated: boolean;
}

export interface BrowserStateCaptureRequest {
  readonly url: string;
  readonly navigationTimeoutMs: number;
  readonly canNavigate: (url: string) => boolean;
}

export interface BrowserInteractionRequest extends BrowserStateCaptureRequest {
  readonly actionTimeoutMs: number;
  readonly replayPath: readonly ActionDescriptor[];
  readonly expectedSourceFingerprint: string;
  readonly candidate: InteractionCandidate;
}

export interface BrowserInteractionCapture {
  readonly status: 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'TIMEOUT';
  readonly sourceUrl: string;
  readonly result: BrowserStateCapture | null;
  readonly durationMs: number;
  readonly reason: string | null;
  readonly evidence: InteractionEvidence;
  readonly discoveredUrls: readonly string[];
}

export interface RawPageLink {
  readonly href: string;
  readonly hint: string;
}

export interface ExplorationPageCapture {
  readonly ok: boolean;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly status: number | null;
  readonly viewport: Viewport;
  readonly elements: ElementCounts;
  readonly links: readonly RawPageLink[];
  readonly timestamp: string;
  readonly durationMs: number;
  readonly warnings: readonly string[];
  readonly screenshot: Buffer | null;
  readonly evidence: ExplorationEvidence;
}

export interface ExplorationVisitRequest {
  readonly url: string;
  readonly navigationTimeoutMs: number;
  readonly canNavigate: (url: string) => boolean;
}

export interface ExplorationBrowserSession {
  visit(request: ExplorationVisitRequest): Promise<ExplorationPageCapture>;
  captureState(request: BrowserStateCaptureRequest): Promise<BrowserStateCapture>;
  performInteraction(request: BrowserInteractionRequest): Promise<BrowserInteractionCapture>;
  close(): Promise<readonly string[]>;
}

export interface ExplorationBrowserStartRequest {
  readonly headless: boolean;
  readonly viewport: Viewport;
  readonly tracePath: string;
}

export interface ExplorationBrowser {
  start(request: ExplorationBrowserStartRequest): Promise<ExplorationBrowserSession>;
}

export interface RunIdGenerator {
  next(at: Date): string;
}

export interface Clock {
  now(): Date;
}
