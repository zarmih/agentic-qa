import type { ProposedQaPlan, TestStepTarget } from '../domain/planning.js';
import { PlanGroundingInvalidError } from './errors.js';
import { candidateCatalogKey, type PlanningCatalog } from './planning-catalog.js';

export class PlanningGroundingValidator {
  public validate(plan: ProposedQaPlan, catalog: PlanningCatalog): void {
    const errors: string[] = [];
    const checkPage = (id: string, path: string): void => {
      if (!catalog.pageIds.has(id)) errors.push(`${path}: unknown page ID "${id}"`);
    };
    const checkState = (id: string, path: string): void => {
      if (!catalog.stateIds.has(id)) errors.push(`${path}: unknown state ID "${id}"`);
    };
    const checkEvidence = (id: string, path: string): void => {
      if (!catalog.evidence.has(id)) errors.push(`${path}: unknown evidence ID "${id}"`);
    };
    const checkTarget = (target: TestStepTarget, path: string): void => {
      if (target.pageId !== undefined) checkPage(target.pageId, `${path}.pageId`);
      if (target.stateId !== undefined) checkState(target.stateId, `${path}.stateId`);
      if (target.actionId !== undefined) {
        const action = catalog.actions.get(target.actionId);
        if (action === undefined)
          errors.push(`${path}.actionId: unknown action ID "${target.actionId}"`);
        else if (
          target.stateId !== undefined &&
          target.stateId !== action.sourceStateId &&
          target.stateId !== action.targetStateId
        ) {
          errors.push(
            `${path}: action "${target.actionId}" is unrelated to state "${target.stateId}"`,
          );
        }
      }
      if (target.candidateId !== undefined && target.stateId !== undefined) {
        if (!catalog.candidates.has(candidateCatalogKey(target.stateId, target.candidateId))) {
          errors.push(
            `${path}: unknown candidate "${target.candidateId}" in state "${target.stateId}"`,
          );
        }
      }
      if (target.evidenceRef !== undefined) {
        checkEvidence(target.evidenceRef, `${path}.evidenceRef`);
      }
      if (target.pageId !== undefined && target.stateId !== undefined) {
        const actualPageId = catalog.statePageIds.get(target.stateId);
        if (actualPageId !== undefined && actualPageId !== target.pageId) {
          errors.push(
            `${path}: state "${target.stateId}" does not belong to page "${target.pageId}"`,
          );
        }
      }
    };

    plan.scenarios.forEach((scenario, scenarioIndex) => {
      const base = `scenarios.${String(scenarioIndex)}`;
      scenario.sourcePageIds.forEach((id, index) => {
        checkPage(id, `${base}.sourcePageIds.${String(index)}`);
      });
      scenario.sourceStateIds.forEach((id, index) => {
        checkState(id, `${base}.sourceStateIds.${String(index)}`);
      });
      scenario.evidenceRefs.forEach((id, index) => {
        checkEvidence(id, `${base}.evidenceRefs.${String(index)}`);
      });
      scenario.steps.forEach((step, stepIndex) => {
        checkTarget(step.target, `${base}.steps.${String(stepIndex)}.target`);
      });
    });
    plan.risks.forEach((risk, riskIndex) => {
      risk.evidenceRefs.forEach((id, index) => {
        checkEvidence(id, `risks.${String(riskIndex)}.evidenceRefs.${String(index)}`);
      });
    });
    if (errors.length > 0) throw new PlanGroundingInvalidError(errors.slice(0, 30));
  }
}
