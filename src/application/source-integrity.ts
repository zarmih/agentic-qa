import { createHash } from 'node:crypto';
import type { ExplorationResult } from '../domain/exploration.js';
import type { PlanningObservation, QaPlan, SourceIntegrity } from '../domain/planning.js';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class SourceIntegrityService {
  public create(exploration: ExplorationResult, observation: PlanningObservation): SourceIntegrity {
    return {
      algorithm: 'SHA-256',
      explorationDigest: sha256Digest(exploration),
      observationDigest: sha256Digest(observation),
      graphDigest: sha256Digest(exploration.graph),
      stateGraphDigest: sha256Digest(exploration.stateGraph),
    };
  }

  public planDigest(plan: QaPlan): string {
    return sha256Digest(plan);
  }
}
