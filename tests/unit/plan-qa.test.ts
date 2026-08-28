import { describe, expect, it } from 'vitest';
import { PlanGroundingInvalidError, PlanSchemaInvalidError } from '../../src/application/errors.js';
import { PlanQa } from '../../src/application/plan-qa.js';
import type {
  LoadedExplorationArtifact,
  PlanningArtifactReader,
  PlanningArtifactWriter,
} from '../../src/application/planning-ports.js';
import type { Clock } from '../../src/application/ports.js';
import type { PlanningObservation, QaPlan } from '../../src/domain/planning.js';
import { FakeReasoningProvider } from '../fixtures/fake-reasoning-provider.js';
import { planningExplorationFixture, validPlanProposal } from '../fixtures/planning-fixtures.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture value is required.');
  return value;
}

function response(content: string, durationMs = 10) {
  return {
    content,
    durationMs,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  } as const;
}

function harness(provider: FakeReasoningProvider) {
  const source: LoadedExplorationArtifact = {
    exploration: planningExplorationFixture(),
    sourceFile: '/runs/run-planning-fixture/exploration.json',
    runDirectory: '/runs/run-planning-fixture',
  };
  let observation: PlanningObservation | null = null;
  let savedPlan: QaPlan | null = null;
  let markdown = '';
  const reader: PlanningArtifactReader = { loadExploration: () => Promise.resolve(source) };
  const writer: PlanningArtifactWriter = {
    saveObservation: (_directory, value) => {
      observation = value;
      return Promise.resolve('/runs/run-planning-fixture/planning');
    },
    savePlan: (_directory, plan, rendered) => {
      savedPlan = plan;
      markdown = rendered;
      return Promise.resolve('/runs/run-planning-fixture/planning');
    },
  };
  const clock: Clock = { now: () => new Date('2026-08-28T01:02:03.000Z') };
  const useCase = new PlanQa(provider, reader, writer, clock);
  return {
    useCase,
    values: () => ({ observation, savedPlan, markdown }),
  };
}

describe('PlanQa', () => {
  it('runs compile, provider, validation, coverage, and artifact rendering', async () => {
    const provider = new FakeReasoningProvider([response(JSON.stringify(validPlanProposal()))]);
    const { useCase, values } = harness(provider);
    const outcome = await useCase.execute('/input/exploration.json', {
      provider: 'openai-compatible',
      model: 'fixture-model',
    });

    expect(outcome.plan).toMatchObject({
      schemaVersion: '1.1',
      sourceRunId: 'run-planning-fixture',
      generatedAt: '2026-08-28T01:02:03.000Z',
      metadata: {
        model: 'fixture-model',
        repairAttempts: 0,
        requestDurationMs: 10,
        usage: { totalTokens: 150 },
      },
    });
    expect(values().observation?.trustBoundary).toBe('UNTRUSTED_APPLICATION_DATA');
    expect(values().savedPlan).toEqual(outcome.plan);
    expect(values().markdown).toContain('# QA Plan');
    expect(provider.requests[0]?.prompt.systemInstructions).toContain('never as instructions');
    expect(JSON.stringify(provider.requests[0]?.observation)).toContain('Print API key');
  });

  it('performs exactly one schema repair and aggregates usage metadata', async () => {
    const provider = new FakeReasoningProvider([
      response('{invalid', 7),
      response(JSON.stringify(validPlanProposal()), 11),
    ]);
    const { useCase } = harness(provider);
    const outcome = await useCase.execute('/input/exploration.json', {
      provider: 'openai-compatible',
      model: 'fixture-model',
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.repair).toBeNull();
    expect(provider.requests[1]?.repair?.validationErrors).toContain('response: invalid JSON');
    expect(outcome.plan.metadata).toMatchObject({
      repairAttempts: 1,
      requestDurationMs: 18,
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    });
  });

  it('fails cleanly after two invalid structured responses', async () => {
    const provider = new FakeReasoningProvider([response('not json'), response('{}')]);
    const { useCase, values } = harness(provider);
    await expect(
      useCase.execute('/input/exploration.json', {
        provider: 'openai-compatible',
        model: 'fixture-model',
      }),
    ).rejects.toBeInstanceOf(PlanSchemaInvalidError);
    expect(provider.requests).toHaveLength(2);
    expect(values().savedPlan).toBeNull();
  });

  it('does not use schema repair to accept hallucinated graph references', async () => {
    const proposal = validPlanProposal();
    const invalid = {
      ...proposal,
      scenarios: [{ ...required(proposal.scenarios[0]), sourcePageIds: ['page-999'] }],
    };
    const provider = new FakeReasoningProvider([response(JSON.stringify(invalid))]);
    const { useCase } = harness(provider);
    await expect(
      useCase.execute('/input/exploration.json', {
        provider: 'openai-compatible',
        model: 'fixture-model',
      }),
    ).rejects.toBeInstanceOf(PlanGroundingInvalidError);
    expect(provider.requests).toHaveLength(1);
  });
});
