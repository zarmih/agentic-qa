import type {
  PlanningObservation,
  ProposedQaPlan,
  ProposedTestScenario,
} from '../../src/domain/planning.js';
import type { FakeLlmRequest } from './fake-llm-server.js';

export function extractPlanningObservation(request: FakeLlmRequest): PlanningObservation {
  if (typeof request.body !== 'object' || request.body === null) {
    throw new Error('Expected a JSON provider request.');
  }
  const messages = (request.body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) throw new Error('Expected provider messages.');
  for (const item of messages as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.role !== 'user' || typeof record.content !== 'string') continue;
    const match =
      /BEGIN_UNTRUSTED_APPLICATION_DATA\n([\s\S]*?)\nEND_UNTRUSTED_APPLICATION_DATA/.exec(
        record.content,
      );
    if (match?.[1] !== undefined) return JSON.parse(match[1]) as PlanningObservation;
  }
  throw new Error('Expected bounded application data.');
}

export function executionPlanProposal(observation: PlanningObservation): ProposedQaPlan {
  const executionPage = observation.pages.find(
    (page) => new URL(page.url).pathname === '/execution',
  );
  const productsPage = observation.pages.find((page) => new URL(page.url).pathname === '/products');
  if (executionPage === undefined || productsPage === undefined) {
    throw new Error('Execution planning fixture pages were not observed.');
  }
  const transition = (accessibleName: string) => {
    const value = observation.transitions.find((item) => item.accessibleName === accessibleName);
    if (value?.targetStateId === null || value?.targetStateId === undefined) {
      throw new Error(`Transition ${accessibleName} was not observed.`);
    }
    return value;
  };
  const click = (
    id: string,
    accessibleName: string,
    priority: ProposedTestScenario['priority'] = 'HIGH',
    evidenceRefs: readonly string[] = [],
  ): ProposedTestScenario => {
    const action = transition(accessibleName);
    return {
      id,
      title: `Replay observed ${accessibleName} transition`,
      objective: `Verify the observed ${accessibleName} UI state transition.`,
      priority,
      type: evidenceRefs.length > 0 ? 'REGRESSION_CANDIDATE' : 'UI_STATE',
      preconditions: [],
      steps: [
        {
          id: `step-${id}`,
          action: 'CLICK',
          target: { stateId: action.sourceStateId, actionId: action.id },
          instruction: `Replay the observed ${accessibleName} action.`,
          expected: 'The observed graph target state is reached.',
        },
      ],
      expectedOutcome: 'The stored graph transition is reproduced.',
      sourcePageIds: [executionPage.id],
      sourceStateIds: [action.sourceStateId, action.targetStateId ?? action.sourceStateId],
      evidenceRefs,
      rationale: 'The action was observed and classified SAFE during controlled exploration.',
      confidence: 0.98,
    };
  };
  const evidenceAction = transition('Open evidence panel');
  const danger = observation.blockedCandidates.find(
    (candidate) =>
      candidate.accessibleName === 'Delete account' && candidate.classification === 'DESTRUCTIVE',
  );
  if (danger === undefined) throw new Error('Destructive fixture candidate was not observed.');

  const scenarios: ProposedTestScenario[] = [
    click('scenario-storage', 'Open storage marker', 'CRITICAL'),
    {
      id: 'scenario-navigation',
      title: 'Navigate to observed products page',
      objective: 'Verify graph-backed navigation to Products.',
      priority: 'CRITICAL',
      type: 'NAVIGATION',
      preconditions: [],
      steps: [
        {
          id: 'step-navigation',
          action: 'NAVIGATE',
          target: { pageId: productsPage.id },
          instruction: 'Navigate using the observed Products page ID.',
          expected: 'The observed Products URL is reached.',
        },
      ],
      expectedOutcome: 'Products remains reachable.',
      sourcePageIds: [productsPage.id],
      sourceStateIds: [],
      evidenceRefs: [],
      rationale: 'Page navigation is grounded in the application graph.',
      confidence: 0.99,
    },
    click('scenario-help', 'Help'),
    click('scenario-details', 'Details'),
    click('scenario-regression', 'Open regression panel'),
    click('scenario-missing', 'Open missing panel'),
    click('scenario-ambiguous', 'Open ambiguous panel'),
    click('scenario-menu', 'Menu'),
    click('scenario-evidence', 'Open evidence panel', 'HIGH', evidenceAction.evidenceRefs),
    {
      id: 'scenario-destructive-manual',
      title: 'Manual Delete account safety boundary',
      objective: 'Review the destructive control without automatic execution.',
      priority: 'CRITICAL',
      type: 'NEGATIVE',
      preconditions: ['Requires explicit human review in a disposable environment.'],
      steps: [
        {
          id: 'step-destructive-manual',
          action: 'CLICK',
          target: { stateId: danger.stateId, candidateId: danger.candidateId },
          instruction: 'Do not execute Delete account automatically.',
          expected: 'The destructive action remains manual-only.',
        },
      ],
      expectedOutcome: 'No destructive request is sent.',
      sourcePageIds: [executionPage.id],
      sourceStateIds: [danger.stateId],
      evidenceRefs: [],
      rationale: 'Stage 3 blocked the destructive candidate.',
      confidence: 1,
    },
  ];
  return {
    schemaVersion: '1.0',
    summary: 'Controlled execution plan grounded in observed pages and SAFE action edges.',
    scenarios,
    risks: [],
    uncoveredAreas: ['Authentication and form mutation are intentionally unsupported.'],
  };
}
