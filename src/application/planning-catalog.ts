import type { ExplorationResult } from '../domain/exploration.js';
import type { ActionRisk } from '../domain/interaction.js';
import type { PlanningEvidenceObservation } from '../domain/planning.js';

export interface PlanningCandidateCatalogEntry {
  readonly stateId: string;
  readonly candidateId: string;
  readonly risk: ActionRisk;
  readonly accessibleName: string;
}

export interface PlanningActionCatalogEntry {
  readonly actionId: string;
  readonly sourceStateId: string;
  readonly targetStateId: string | null;
  readonly risk: 'SAFE';
}

export interface PlanningCatalog {
  readonly source: ExplorationResult;
  /** IDs the model actually received and may reference. */
  readonly pageIds: ReadonlySet<string>;
  readonly stateIds: ReadonlySet<string>;
  readonly actions: ReadonlyMap<string, PlanningActionCatalogEntry>;
  readonly candidates: ReadonlyMap<string, PlanningCandidateCatalogEntry>;
  readonly evidence: ReadonlyMap<string, PlanningEvidenceObservation>;
  /** Complete source indexes used only for deterministic coverage analysis. */
  readonly allPageIds: ReadonlySet<string>;
  readonly allStateIds: ReadonlySet<string>;
  readonly allActions: ReadonlyMap<string, PlanningActionCatalogEntry>;
  readonly allEvidence: ReadonlyMap<string, PlanningEvidenceObservation>;
  readonly statePageIds: ReadonlyMap<string, string>;
  readonly rootPageId: string | null;
  readonly criticalPageIds: ReadonlySet<string>;
  readonly errorBearingStateIds: ReadonlySet<string>;
}

export function candidateCatalogKey(stateId: string, candidateId: string): string {
  return `${stateId}:${candidateId}`;
}
