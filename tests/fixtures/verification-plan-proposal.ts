import type {
  PlanningObservation,
  ProposedQaPlan,
  ProposedTestScenario,
  QaPriority,
} from '../../src/domain/planning.js';
import type { FakeLlmRequest } from './fake-llm-server.js';
import { extractPlanningObservation } from './execution-plan-proposal.js';

export { extractPlanningObservation };

interface VerificationScenarioDefinition {
  readonly id: string;
  readonly accessibleName: string;
  readonly priority: QaPriority;
}

const DEFINITIONS: readonly VerificationScenarioDefinition[] = [
  { id: 'scenario-verify-stable', accessibleName: 'Open stable panel', priority: 'CRITICAL' },
  { id: 'scenario-verify-flaky', accessibleName: 'Open flaky panel', priority: 'HIGH' },
  { id: 'scenario-verify-fixed', accessibleName: 'Open fixed panel', priority: 'MEDIUM' },
  {
    id: 'scenario-verify-inconclusive',
    accessibleName: 'Open inconclusive panel',
    priority: 'LOW',
  },
  { id: 'scenario-verify-varied', accessibleName: 'Open varied panel', priority: 'LOW' },
  { id: 'scenario-verify-http', accessibleName: 'Open cart', priority: 'HIGH' },
];

export function verificationPlanProposal(observation: PlanningObservation): ProposedQaPlan {
  const states = new Map(observation.states.map((state) => [state.id, state]));
  const pages = new Map(observation.pages.map((page) => [page.id, page]));
  const scenario = (definition: VerificationScenarioDefinition): ProposedTestScenario => {
    const transition = observation.transitions.find(
      (entry) => entry.accessibleName === definition.accessibleName,
    );
    if (transition?.targetStateId === null || transition?.targetStateId === undefined) {
      throw new Error(`Verification transition ${definition.accessibleName} was not observed.`);
    }
    const sourceState = states.get(transition.sourceStateId);
    const targetState = states.get(transition.targetStateId);
    if (sourceState === undefined || targetState === undefined) {
      throw new Error(`Verification states for ${definition.accessibleName} were not observed.`);
    }
    const sourcePage = pages.get(sourceState.pageId);
    if (sourcePage === undefined) throw new Error('Verification page was not observed.');
    return {
      id: definition.id,
      title: `Verify ${definition.accessibleName}`,
      objective: `Replay the observed ${definition.accessibleName} transition.`,
      priority: definition.priority,
      type: transition.evidenceRefs.length > 0 ? 'REGRESSION_CANDIDATE' : 'UI_STATE',
      preconditions: [],
      steps: [
        {
          id: `step-${definition.id}`,
          action: 'CLICK',
          target: { stateId: transition.sourceStateId, actionId: transition.id },
          instruction: `Replay graph action ${transition.id}.`,
          expected: `Reach observed state ${transition.targetStateId}.`,
        },
      ],
      expectedOutcome: 'The graph-backed transition is reproduced.',
      sourcePageIds: [sourcePage.id],
      sourceStateIds: [transition.sourceStateId, transition.targetStateId],
      evidenceRefs: transition.evidenceRefs,
      rationale: 'This controlled scenario is grounded in an observed SAFE action edge.',
      confidence: 0.99,
    };
  };
  const danger = observation.blockedCandidates.find(
    (candidate) =>
      candidate.accessibleName === 'Delete account' && candidate.classification === 'DESTRUCTIVE',
  );
  if (danger === undefined) throw new Error('Verification destructive control was not observed.');
  const homePage = observation.pages.find((item) => new URL(item.url).pathname === '/verification');
  if (homePage === undefined) throw new Error('Verification home page was not observed.');
  return {
    schemaVersion: '1.0',
    summary: 'Controlled defect reproducibility plan.',
    scenarios: [
      ...DEFINITIONS.map(scenario),
      {
        id: 'scenario-verify-destructive-manual',
        title: 'Manual destructive safety boundary',
        objective: 'Keep the observed destructive control outside automatic execution.',
        priority: 'CRITICAL',
        type: 'NEGATIVE',
        preconditions: ['Requires explicit human review in a disposable environment.'],
        steps: [
          {
            id: 'step-verify-destructive-manual',
            action: 'CLICK',
            target: { stateId: danger.stateId, candidateId: danger.candidateId },
            instruction: 'Do not execute the destructive action.',
            expected: 'No destructive request is sent.',
          },
        ],
        expectedOutcome: 'The action remains manual-only.',
        sourcePageIds: [homePage.id],
        sourceStateIds: [danger.stateId],
        evidenceRefs: [],
        rationale: 'Stage 3 classified this control as destructive.',
        confidence: 1,
      },
    ],
    risks: [],
    uncoveredAreas: ['Root cause analysis and authenticated workflows are out of scope.'],
  };
}

export function verificationPlanFromRequest(request: FakeLlmRequest): ProposedQaPlan {
  return verificationPlanProposal(extractPlanningObservation(request));
}
