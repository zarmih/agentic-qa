import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/domain/exploration.js';
import type {
  PlanningObservation,
  ProposedQaPlan,
  ProposedTestScenario,
  QaPlan,
} from '../../src/domain/planning.js';
import {
  startFakeLlmServer,
  type FakeLlmRequest,
  type FakeLlmServer,
} from '../fixtures/fake-llm-server.js';
import { startMiniAppServer, type MiniAppServer } from '../fixtures/mini-app-server.js';
import { runCli } from '../helpers/run-cli.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const testApiKey = 'stage4-local-smoke-secret';
let miniApp: MiniAppServer;
let temporaryDirectory = '';

beforeAll(async () => {
  miniApp = await startMiniAppServer();
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'agentic-qa-plan-e2e-'));
});

afterAll(async () => {
  await miniApp.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function extractObservation(request: FakeLlmRequest): PlanningObservation {
  if (typeof request.body !== 'object' || request.body === null) {
    throw new Error('Expected a JSON provider request.');
  }
  const messages = (request.body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) throw new Error('Expected provider messages.');
  const messageList = messages as unknown[];
  const userMessage = messageList.find(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>).role === 'user',
  );
  if (typeof userMessage !== 'object' || userMessage === null) {
    throw new Error('Expected a provider user message.');
  }
  const content = (userMessage as Record<string, unknown>).content;
  if (typeof content !== 'string') throw new Error('Expected provider user content.');
  const match = /BEGIN_UNTRUSTED_APPLICATION_DATA\n([\s\S]*?)\nEND_UNTRUSTED_APPLICATION_DATA/.exec(
    content,
  );
  if (match?.[1] === undefined) throw new Error('Expected bounded application data.');
  return JSON.parse(match[1]) as PlanningObservation;
}

function messagesForRole(request: FakeLlmRequest, role: string): readonly string[] {
  if (typeof request.body !== 'object' || request.body === null) return [];
  const messages = (request.body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return (messages as unknown[]).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    return record.role === role && typeof record.content === 'string' ? [record.content] : [];
  });
}

function groundedProposal(observation: PlanningObservation): ProposedQaPlan {
  const page = observation.pages.find((item) => item.depth === 0) ?? observation.pages[0];
  const transition = observation.transitions.find((item) => item.targetStateId !== null);
  const blocked = observation.blockedCandidates.find(
    (item) => item.classification === 'DESTRUCTIVE',
  );
  const evidence = observation.evidence.find((item) =>
    ['CRITICAL', 'ERROR'].includes(item.severity),
  );
  if (
    page === undefined ||
    transition === undefined ||
    blocked === undefined ||
    evidence === undefined
  ) {
    throw new Error('Controlled exploration did not produce the required planning observations.');
  }
  const scenarios: ProposedTestScenario[] = [
    {
      id: 'scenario-root-smoke',
      title: 'Root route smoke check',
      objective: 'Verify the observed start page remains reachable.',
      priority: 'CRITICAL',
      type: 'SMOKE',
      preconditions: [],
      steps: [
        {
          id: 'step-root',
          action: 'NAVIGATE',
          target: { pageId: page.id },
          instruction: 'Navigate to the observed start page.',
          expected: 'The page loads successfully.',
        },
      ],
      expectedOutcome: 'The observed start route remains available.',
      sourcePageIds: [page.id],
      sourceStateIds: [],
      evidenceRefs: [],
      rationale: 'The start page anchors smoke coverage.',
      confidence: 0.95,
    },
    {
      id: 'scenario-safe-transition',
      title: `Replay ${transition.accessibleName}`,
      objective: 'Verify the observed safe UI transition remains functional.',
      priority: 'HIGH',
      type: 'UI_STATE',
      preconditions: ['The source UI state is restored.'],
      steps: [
        {
          id: 'step-safe-transition',
          action: 'CLICK',
          target: { stateId: transition.sourceStateId, actionId: transition.id },
          instruction: 'Replay the observed safe transition.',
          expected: 'The observed target state is reached.',
        },
      ],
      expectedOutcome: 'The safe transition remains reproducible.',
      sourcePageIds: [],
      sourceStateIds: [
        transition.sourceStateId,
        ...(transition.targetStateId === null ? [] : [transition.targetStateId]),
      ],
      evidenceRefs: [],
      rationale: 'This transition was executed safely during exploration.',
      confidence: 0.9,
    },
    {
      id: 'scenario-destructive-boundary',
      title: `Manual safety check for ${blocked.accessibleName}`,
      objective: 'Review the destructive control without automatic execution.',
      priority: 'HIGH',
      type: 'NEGATIVE',
      preconditions: ['Use a disposable environment and explicit human approval.'],
      steps: [
        {
          id: 'step-destructive-boundary',
          action: 'CLICK',
          target: { stateId: blocked.stateId, candidateId: blocked.candidateId },
          instruction: `Manually evaluate ${blocked.accessibleName}.`,
          expected: 'The dangerous operation requires a clear confirmation boundary.',
        },
      ],
      expectedOutcome: 'The destructive boundary is documented for manual testing only.',
      sourcePageIds: [],
      sourceStateIds: [blocked.stateId],
      evidenceRefs: [],
      rationale: 'The control was blocked by the deterministic exploration safety policy.',
      confidence: 0.98,
    },
    {
      id: 'scenario-observed-error',
      title: 'Observed browser error resilience',
      objective: 'Verify the application handles the observed error without user-visible failure.',
      priority: 'HIGH',
      type: 'RESILIENCE',
      preconditions: [],
      steps: [
        {
          id: 'step-observed-error',
          action: 'CHECK_NETWORK',
          target: { evidenceRef: evidence.id },
          instruction: 'Inspect the observed error location.',
          expected: 'The error is handled or no longer reproduced.',
        },
      ],
      expectedOutcome: 'The observed error has explicit regression coverage.',
      sourcePageIds: [],
      sourceStateIds: [],
      evidenceRefs: [evidence.id],
      rationale: 'Planning prioritizes recorded browser evidence.',
      confidence: 0.9,
    },
  ];
  return {
    schemaVersion: '1.0',
    summary: 'Grounded plan produced by the controlled local provider.',
    scenarios,
    risks: [
      {
        id: 'risk-observed-error',
        title: 'Observed runtime error',
        description: evidence.summary,
        severity: evidence.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
        evidenceRefs: [evidence.id],
      },
    ],
    uncoveredAreas: ['Authentication was not observed.'],
  };
}

describe('agentic-qa plan', () => {
  it('runs Chromium exploration through a local HTTP planner and saves grounded artifacts', async () => {
    const artifacts = join(temporaryDirectory, 'runs');
    const exploration = await runCli(projectRoot, [
      'explore',
      `${miniApp.baseUrl}/interactive`,
      '--interactive',
      '--artifacts-dir',
      artifacts,
      '--max-pages',
      '4',
      '--max-depth',
      '1',
      '--max-states',
      '18',
      '--max-actions-per-state',
      '20',
      '--max-state-depth',
      '2',
      '--timeout',
      '3000',
    ]);
    expect(exploration).toMatchObject({ code: 0, stderr: '' });
    const runNames = await readdir(artifacts);
    const runName = runNames[0];
    if (runName === undefined) throw new Error('Exploration did not create a run directory.');
    const runDirectory = join(artifacts, runName);
    const sourceFile = join(runDirectory, 'exploration.json');
    const source = JSON.parse(await readFile(sourceFile, 'utf8')) as ExplorationResult;

    let fakeProvider: FakeLlmServer | null = null;
    try {
      fakeProvider = await startFakeLlmServer((request) => ({
        content:
          request.index === 0
            ? '{invalid-json'
            : JSON.stringify(groundedProposal(extractObservation(request))),
        usage:
          request.index === 0
            ? { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }
            : { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      }));
      const planning = await runCli(
        projectRoot,
        ['plan', sourceFile, '--provider', 'openai-compatible', '--model', 'local-fixture-model'],
        {
          AGENTIC_QA_LLM_BASE_URL: fakeProvider.baseUrl,
          AGENTIC_QA_LLM_API_KEY: testApiKey,
          AGENTIC_QA_LLM_TIMEOUT_MS: '3000',
        },
      );

      expect(planning).toMatchObject({ code: 0, stderr: '' });
      expect(planning.stdout).toContain('Agentic QA Plan');
      expect(planning.stdout).not.toContain(testApiKey);
      expect(fakeProvider.requests).toHaveLength(2);
      expect(
        fakeProvider.requests.every((request) => request.authorization === `Bearer ${testApiKey}`),
      ).toBe(true);
      expect(fakeProvider.requests.every((request) => !request.rawBody.includes(testApiKey))).toBe(
        true,
      );
      const firstProviderRequest = fakeProvider.requests[0];
      if (firstProviderRequest === undefined) throw new Error('Provider request was not captured.');
      expect(messagesForRole(firstProviderRequest, 'system').join(' ').toLowerCase()).not.toContain(
        'ignore all previous instructions',
      );
      expect(messagesForRole(firstProviderRequest, 'user').join(' ').toLowerCase()).toContain(
        'ignore all previous instructions',
      );
      expect(messagesForRole(firstProviderRequest, 'system').join(' ')).toContain(
        'no browser, filesystem, shell',
      );

      const planningDirectory = join(runDirectory, 'planning');
      const observationText = await readFile(join(planningDirectory, 'observation.json'), 'utf8');
      const planText = await readFile(join(planningDirectory, 'qa-plan.json'), 'utf8');
      const markdown = await readFile(join(planningDirectory, 'qa-plan.md'), 'utf8');
      const observation = JSON.parse(observationText) as PlanningObservation;
      const plan = JSON.parse(planText) as QaPlan;

      expect(source.graph.nodes.length).toBeGreaterThanOrEqual(2);
      expect(source.stateGraph?.nodes.length ?? 0).toBeGreaterThanOrEqual(8);
      expect(source.evidence.httpErrors.length).toBeGreaterThanOrEqual(1);
      expect(observation.trustBoundary).toBe('UNTRUSTED_APPLICATION_DATA');
      expect(observationText.toLowerCase()).toContain('ignore all previous instructions');
      expect(JSON.stringify(observation).length).toBeLessThanOrEqual(50_000);
      expect(new Set(observation.blockedCandidates.map((item) => item.classification))).toEqual(
        new Set(['DESTRUCTIVE', 'CAUTION', 'UNKNOWN']),
      );
      expect(plan.metadata).toMatchObject({
        provider: 'openai-compatible',
        model: 'local-fixture-model',
        repairAttempts: 1,
        usage: { inputTokens: 220, outputTokens: 85, totalTokens: 305 },
      });
      expect(plan.scenarios).toHaveLength(4);
      expect(
        plan.scenarios.find((scenario) => scenario.id === 'scenario-destructive-boundary'),
      ).toMatchObject({ executability: 'MANUAL_ONLY' });
      expect(plan.scenarios.some((scenario) => scenario.executability === 'AUTOMATABLE')).toBe(
        true,
      );
      expect(plan.coverage.pages.total).toBe(source.graph.nodes.length);
      expect(markdown).toContain('# QA Plan');
      expect(markdown).toContain('Manual-only scenarios');
      expect(observationText + planText + markdown).not.toContain(testApiKey);
      expect((await stat(join(planningDirectory, 'qa-plan.json'))).size).toBeGreaterThan(100);

      const pageIds = new Set(source.graph.nodes.map((page) => page.id));
      const stateIds = new Set(source.stateGraph?.nodes.map((state) => state.id) ?? []);
      const actionIds = new Set(source.stateGraph?.edges.map((edge) => edge.id) ?? []);
      for (const scenario of plan.scenarios) {
        expect(scenario.sourcePageIds.every((id) => pageIds.has(id))).toBe(true);
        expect(scenario.sourceStateIds.every((id) => stateIds.has(id))).toBe(true);
        expect(
          scenario.steps.every(
            (step) => step.target.actionId === undefined || actionIds.has(step.target.actionId),
          ),
        ).toBe(true);
      }
      const counters = await miniApp.counters();
      expect(counters).toMatchObject({
        delete: 0,
        logout: 0,
        buy: 0,
        checkout: 0,
        publish: 0,
        reset: 0,
        unsubscribe: 0,
        formSubmit: 0,
      });
    } finally {
      await fakeProvider?.close();
    }
  }, 125_000);
});
