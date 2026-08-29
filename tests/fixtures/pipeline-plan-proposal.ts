import type {
  PlanningObservation,
  ProposedQaPlan,
  ProposedTestScenario,
} from '../../src/domain/planning.js';
import type { FakeLlmRequest } from './fake-llm-server.js';
import { extractPlanningObservation } from './execution-plan-proposal.js';

export function pipelinePlanProposal(observation: PlanningObservation): ProposedQaPlan {
  const page = observation.pages.find((item) => new URL(item.url).pathname === '/pipeline');
  if (page === undefined) throw new Error('Pipeline fixture page was not observed.');
  const scenario = (name: 'stable' | 'healthy'): ProposedTestScenario => {
    const accessibleName = `Open ${name} panel`;
    const transition = observation.transitions.find(
      (item) => item.accessibleName === accessibleName,
    );
    if (transition?.targetStateId === null || transition?.targetStateId === undefined) {
      throw new Error(`Pipeline transition ${accessibleName} was not observed.`);
    }
    return {
      id: `scenario-pipeline-${name}`,
      title:
        name === 'stable'
          ? 'Stable pipeline <script>alert("captured")</script>'
          : 'Healthy pipeline flow',
      objective: `Replay the observed ${accessibleName} transition.`,
      priority: name === 'stable' ? 'HIGH' : 'MEDIUM',
      type: 'UI_STATE',
      preconditions: [],
      steps: [
        {
          id: `step-pipeline-${name}`,
          action: 'CLICK',
          target: { stateId: transition.sourceStateId, actionId: transition.id },
          instruction: `Replay graph action ${transition.id}.`,
          expected: `Reach observed state ${transition.targetStateId}.`,
        },
      ],
      expectedOutcome: 'The graph-backed transition is reproduced.',
      sourcePageIds: [page.id],
      sourceStateIds: [transition.sourceStateId, transition.targetStateId],
      evidenceRefs: transition.evidenceRefs,
      rationale: 'Controlled Stage 8 pipeline fixture.',
      confidence: 0.99,
    };
  };
  return {
    schemaVersion: '1.0',
    summary: 'Controlled Stage 8 healthy and stable regression flow.',
    scenarios: [scenario('stable'), scenario('healthy')],
    risks: [],
    uncoveredAreas: ['Forms and destructive controls remain outside automated execution.'],
  };
}

export function pipelinePlanFromRequest(request: FakeLlmRequest): ProposedQaPlan {
  return pipelinePlanProposal(extractPlanningObservation(request));
}
