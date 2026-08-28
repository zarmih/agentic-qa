import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  sha256Digest,
  SourceIntegrityService,
} from '../../src/application/source-integrity.js';
import { PlanningObservationCompiler } from '../../src/application/planning-observation-compiler.js';
import { planningExplorationFixture } from '../fixtures/planning-fixtures.js';

describe('source integrity', () => {
  it('canonicalizes object keys while preserving array order', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(sha256Digest([1, 2])).not.toBe(sha256Digest([2, 1]));
  });

  it('creates deterministic SHA-256 bindings for all planning sources', () => {
    const source = planningExplorationFixture();
    const observation = new PlanningObservationCompiler().compile(source).observation;
    const first = new SourceIntegrityService().create(source, observation);
    const second = new SourceIntegrityService().create(
      structuredClone(source),
      structuredClone(observation),
    );

    expect(first).toEqual(second);
    expect(first.algorithm).toBe('SHA-256');
    const digests = [
      first.explorationDigest,
      first.observationDigest,
      first.graphDigest,
      first.stateGraphDigest,
    ];
    expect(digests.every((digest) => /^[a-f0-9]{64}$/.test(digest))).toBe(true);
  });

  it('detects changes to exploration and observation independently', () => {
    const source = planningExplorationFixture();
    const observation = new PlanningObservationCompiler().compile(source).observation;
    const baseline = new SourceIntegrityService().create(source, observation);
    const changedSource = {
      ...source,
      graph: {
        ...source.graph,
        nodes: source.graph.nodes.map((node, index) =>
          index === 0 ? { ...node, title: 'Changed' } : node,
        ),
      },
    };
    const changedObservation = {
      ...observation,
      pages: observation.pages.map((page, index) =>
        index === 0 ? { ...page, title: 'Changed observation' } : page,
      ),
    };

    expect(
      new SourceIntegrityService().create(changedSource, observation).explorationDigest,
    ).not.toBe(baseline.explorationDigest);
    expect(
      new SourceIntegrityService().create(source, changedObservation).observationDigest,
    ).not.toBe(baseline.observationDigest);
  });
});
