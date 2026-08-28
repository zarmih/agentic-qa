import type { ExplorationResult } from '../domain/exploration.js';
import type { PlanningObservation, PlanningTokenUsage, QaPlan } from '../domain/planning.js';

export interface PlanningPrompt {
  readonly systemInstructions: string;
  readonly taskInstructions: string;
}

export interface PlanningRepairRequest {
  readonly validationErrors: readonly string[];
  readonly invalidResponse: string;
}

export interface ReasoningProviderRequest {
  readonly prompt: PlanningPrompt;
  readonly observation: PlanningObservation;
  readonly repair: PlanningRepairRequest | null;
}

export interface ReasoningProviderResponse {
  readonly content: string;
  readonly durationMs: number;
  readonly usage: PlanningTokenUsage | null;
}

export interface QaReasoningProvider {
  generatePlan(request: ReasoningProviderRequest): Promise<ReasoningProviderResponse>;
}

export interface LoadedExplorationArtifact {
  readonly exploration: ExplorationResult;
  readonly sourceFile: string;
  readonly runDirectory: string;
}

export interface PlanningArtifactReader {
  loadExploration(path: string): Promise<LoadedExplorationArtifact>;
}

export interface PlanningArtifactWriter {
  saveObservation(runDirectory: string, observation: PlanningObservation): Promise<string>;
  savePlan(runDirectory: string, plan: QaPlan, markdown: string): Promise<string>;
}
