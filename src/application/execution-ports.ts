import type { ExecutionFailureCode, ExecutionRun } from '../domain/execution.js';
import type { ExplorationGraph, ExplorationResult } from '../domain/exploration.js';
import type {
  InteractionCandidate,
  InteractionEvidence,
  StateGraph,
  StateNode,
  ActionEdge,
} from '../domain/interaction.js';
import type { Viewport } from '../domain/inspection.js';
import type { PlanningObservation, QaPlan } from '../domain/planning.js';

export interface LoadedExecutionArtifacts {
  readonly plan: QaPlan;
  readonly exploration: ExplorationResult;
  readonly observation: PlanningObservation;
  readonly standaloneGraph: ExplorationGraph;
  readonly standaloneStateGraph: StateGraph;
  readonly planFile: string;
  readonly explorationFile: string;
  readonly runDirectory: string;
}

export interface ExecutionArtifactReader {
  loadExecutionInput(
    planPath: string,
    explorationOverride?: string,
  ): Promise<LoadedExecutionArtifacts>;
}

export interface ExecutionArtifactLocations {
  readonly directory: string;
  readonly tracePath: string;
}

export interface ExecutionArtifactWriter {
  prepareExecution(runDirectory: string, executionId: string): Promise<ExecutionArtifactLocations>;
  saveExecutionScreenshot(
    runDirectory: string,
    executionId: string,
    scenarioId: string,
    filename: string,
    screenshot: Buffer,
  ): Promise<string>;
  saveExecution(
    runDirectory: string,
    executionId: string,
    result: ExecutionRun,
    markdown: string,
  ): Promise<void>;
}

export interface GraphReplayTransition {
  readonly edge: ActionEdge;
  readonly sourceState: StateNode;
  readonly targetState: StateNode;
  readonly candidate: InteractionCandidate;
}

export interface ExecutionBrowserStepRequest {
  readonly url: string;
  readonly navigationTimeoutMs: number;
  readonly stepTimeoutMs: number;
  readonly canNavigate: (url: string) => boolean;
}

export interface ExecutionBrowserClickRequest extends ExecutionBrowserStepRequest {
  readonly sourceState: StateNode;
  readonly targetState: StateNode;
  readonly action: ActionEdge;
  readonly candidate: InteractionCandidate;
  readonly replay: readonly GraphReplayTransition[];
}

export interface ExecutionBrowserCapture {
  readonly status: 'COMPLETED' | 'BLOCKED' | 'ERROR' | 'TIMEOUT';
  readonly actualUrl: string | null;
  readonly actualFingerprint: string | null;
  readonly screenshot: Buffer | null;
  readonly durationMs: number;
  readonly failureCode: ExecutionFailureCode | null;
  readonly reason: string | null;
  readonly evidence: InteractionEvidence;
}

export interface ScenarioExecutionBrowserSession {
  readonly browserVersion: string;
  beginScenario(): Promise<void>;
  captureStart(request: ExecutionBrowserStepRequest): Promise<ExecutionBrowserCapture>;
  navigate(request: ExecutionBrowserStepRequest): Promise<ExecutionBrowserCapture>;
  click(request: ExecutionBrowserClickRequest): Promise<ExecutionBrowserCapture>;
  close(): Promise<readonly string[]>;
}

export interface ScenarioExecutionBrowser {
  start(request: {
    readonly headless: boolean;
    readonly viewport: Viewport;
    readonly tracePath: string;
  }): Promise<ScenarioExecutionBrowserSession>;
}
