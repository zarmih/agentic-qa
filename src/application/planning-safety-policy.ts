import { ActionRiskClassifier, type InteractionCandidate } from '../domain/interaction.js';
import { compareStrings } from '../domain/determinism.js';
import type {
  ProposedTestScenario,
  ScenarioExecutability,
  TestScenario,
} from '../domain/planning.js';
import { candidateCatalogKey, type PlanningCatalog } from './planning-catalog.js';

function normalize(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function scenarioCandidate(value: string): InteractionCandidate {
  return {
    id: 'planning-text',
    domOrder: 0,
    tag: 'button',
    role: 'button',
    accessibleName: value,
    text: value,
    href: null,
    elementType: 'button',
    ariaLabel: null,
    title: null,
    ariaExpanded: null,
    ariaSelected: null,
    disabled: false,
    visible: true,
    formAssociated: false,
    submitsForm: false,
    fileUpload: false,
    testId: null,
    label: null,
    stableId: null,
    locator: { strategy: 'role', role: 'button', name: value.slice(0, 100), index: 0 },
  };
}

export interface DeduplicatedScenarios {
  readonly scenarios: readonly ProposedTestScenario[];
  readonly duplicatesRemoved: number;
}

export class PlanningScenarioDeduplicator {
  public deduplicate(scenarios: readonly ProposedTestScenario[]): DeduplicatedScenarios {
    const seen = new Set<string>();
    const retained: ProposedTestScenario[] = [];
    for (const scenario of scenarios) {
      const signature = JSON.stringify({
        title: normalize(scenario.title),
        objective: normalize(scenario.objective),
        type: scenario.type,
        preconditions: scenario.preconditions.map(normalize),
        expectedOutcome: normalize(scenario.expectedOutcome),
        pages: [...scenario.sourcePageIds].sort(),
        states: [...scenario.sourceStateIds].sort(),
        evidence: [...scenario.evidenceRefs].sort(),
        steps: scenario.steps.map((step) => ({
          action: step.action,
          target: Object.fromEntries(
            Object.entries(step.target).sort(([left], [right]) => compareStrings(left, right)),
          ),
          instruction: normalize(step.instruction),
          expected: normalize(step.expected),
        })),
      });
      if (seen.has(signature)) continue;
      seen.add(signature);
      retained.push(scenario);
    }
    return { scenarios: retained, duplicatesRemoved: scenarios.length - retained.length };
  }
}

export class PlanningExecutabilityPolicy {
  private readonly classifier = new ActionRiskClassifier();

  public apply(scenario: ProposedTestScenario, catalog: PlanningCatalog): TestScenario {
    const safetyNotes = new Set<string>();
    let executability: ScenarioExecutability = 'AUTOMATABLE';
    const scenarioText = [
      scenario.title,
      scenario.objective,
      ...scenario.steps.flatMap((step) => [step.instruction, step.expected]),
    ].join(' ');
    const semanticRisk = this.classifier.classify(scenarioCandidate(scenarioText));
    if (semanticRisk.risk === 'DESTRUCTIVE' || semanticRisk.risk === 'CAUTION') {
      executability = 'MANUAL_ONLY';
      safetyNotes.add(`Scenario semantics require manual review (${semanticRisk.reason}).`);
    }

    for (const step of scenario.steps) {
      if (step.action !== 'CLICK') continue;
      if (step.target.candidateId !== undefined && step.target.stateId !== undefined) {
        const candidate = catalog.candidates.get(
          candidateCatalogKey(step.target.stateId, step.target.candidateId),
        );
        if (candidate !== undefined && candidate.risk !== 'SAFE') {
          executability = 'MANUAL_ONLY';
          safetyNotes.add(
            `Candidate ${candidate.candidateId} is ${candidate.risk}; its test idea is manual-only.`,
          );
        } else {
          executability = 'MANUAL_ONLY';
          safetyNotes.add(
            'Candidate-only clicks are not executable without an observed SAFE action edge.',
          );
        }
      }
      if (step.target.actionId === undefined && step.target.candidateId === undefined) {
        executability = 'UNSUPPORTED';
        safetyNotes.add('Click step has no observed action or candidate reference.');
      }
      if (step.target.actionId !== undefined) {
        const action = catalog.actions.get(step.target.actionId);
        if (action === undefined) {
          executability = 'MANUAL_ONLY';
          safetyNotes.add('Click step does not reference an observed SAFE action edge.');
        }
      }
    }
    return {
      ...scenario,
      executability,
      safetyNotes: [...safetyNotes],
    };
  }
}
