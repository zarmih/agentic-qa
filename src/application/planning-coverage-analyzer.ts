import type { CoverageAnalysis, CoverageMetric, TestScenario } from '../domain/planning.js';
import type { PlanningCatalog } from './planning-catalog.js';

export interface PlanningCoverageResult {
  readonly coverage: CoverageAnalysis;
  readonly warnings: readonly string[];
  readonly uncoveredAreas: readonly string[];
}

function metric(covered: number, total: number): CoverageMetric {
  return {
    covered,
    total,
    percentage: total === 0 ? 100 : Math.round((covered / total) * 1_000) / 10,
  };
}

export class PlanningCoverageAnalyzer {
  public analyze(
    scenarios: readonly TestScenario[],
    catalog: PlanningCatalog,
    duplicatesRemoved: number,
  ): PlanningCoverageResult {
    const pages = new Set<string>();
    const states = new Set<string>();
    const actions = new Set<string>();
    const evidence = new Set<string>();
    const scenarioPages = new Map<string, number>();

    const coverState = (stateId: string): void => {
      states.add(stateId);
      const pageId = catalog.statePageIds.get(stateId);
      if (pageId !== undefined) pages.add(pageId);
    };
    const coverEvidence = (evidenceId: string): void => {
      evidence.add(evidenceId);
      const item = catalog.allEvidence.get(evidenceId);
      if (item?.pageId !== null && item?.pageId !== undefined) pages.add(item.pageId);
      if (item?.stateId !== null && item?.stateId !== undefined) coverState(item.stateId);
      if (item?.actionId !== null && item?.actionId !== undefined) actions.add(item.actionId);
    };

    for (const scenario of scenarios) {
      const pagesForScenario = new Set<string>();
      for (const pageId of scenario.sourcePageIds) {
        pages.add(pageId);
        pagesForScenario.add(pageId);
      }
      for (const stateId of scenario.sourceStateIds) {
        coverState(stateId);
        const pageId = catalog.statePageIds.get(stateId);
        if (pageId !== undefined) pagesForScenario.add(pageId);
      }
      scenario.evidenceRefs.forEach(coverEvidence);
      for (const step of scenario.steps) {
        if (step.target.pageId !== undefined) {
          pages.add(step.target.pageId);
          pagesForScenario.add(step.target.pageId);
        }
        if (step.target.stateId !== undefined) {
          coverState(step.target.stateId);
          const pageId = catalog.statePageIds.get(step.target.stateId);
          if (pageId !== undefined) pagesForScenario.add(pageId);
        }
        if (step.target.actionId !== undefined) {
          actions.add(step.target.actionId);
          const action = catalog.allActions.get(step.target.actionId);
          if (action !== undefined) {
            coverState(action.sourceStateId);
            if (action.targetStateId !== null) coverState(action.targetStateId);
          }
        }
        if (step.target.evidenceRef !== undefined) coverEvidence(step.target.evidenceRef);
      }
      for (const pageId of pagesForScenario) {
        scenarioPages.set(pageId, (scenarioPages.get(pageId) ?? 0) + 1);
      }
    }

    const errorStatesCovered = [...catalog.errorBearingStateIds].filter((id) =>
      states.has(id),
    ).length;
    const coverage: CoverageAnalysis = {
      pages: metric(pages.size, catalog.allPageIds.size),
      states: metric(states.size, catalog.allStateIds.size),
      safeTransitions: metric(actions.size, catalog.allActions.size),
      evidenceLocations: metric(evidence.size, catalog.allEvidence.size),
      errorBearingStates: metric(errorStatesCovered, catalog.errorBearingStateIds.size),
    };
    const warnings: string[] = [];
    const uncoveredAreas: string[] = [];

    if (catalog.rootPageId !== null && !pages.has(catalog.rootPageId)) {
      warnings.push(`Root page ${catalog.rootPageId} is not covered by any scenario.`);
      uncoveredAreas.push(`Root page ${catalog.rootPageId}`);
    }
    for (const pageId of catalog.criticalPageIds) {
      if (!pages.has(pageId)) {
        warnings.push(`Critical or failed page ${pageId} is not covered.`);
        uncoveredAreas.push(`Critical page ${pageId}`);
      }
    }
    for (const item of catalog.allEvidence.values()) {
      if (!evidence.has(item.id) && ['CRITICAL', 'ERROR'].includes(item.severity)) {
        uncoveredAreas.push(`Evidence ${item.id} (${item.kind})`);
      }
    }
    const uncoveredSevereEvidence = [...catalog.allEvidence.values()].filter(
      (item) => !evidence.has(item.id) && ['CRITICAL', 'ERROR'].includes(item.severity),
    ).length;
    if (uncoveredSevereEvidence > 0) {
      warnings.push(
        `${String(uncoveredSevereEvidence)} critical/error evidence observation(s) are not covered.`,
      );
    }
    if (coverage.errorBearingStates.covered < coverage.errorBearingStates.total) {
      warnings.push(
        `Only ${String(coverage.errorBearingStates.covered)}/${String(coverage.errorBearingStates.total)} error-bearing states are covered.`,
      );
    }
    if (coverage.pages.total > 0 && coverage.pages.percentage < 50) {
      warnings.push(`Page coverage is low at ${String(coverage.pages.percentage)}%.`);
    }
    if (duplicatesRemoved > 0) {
      warnings.push(
        `${String(duplicatesRemoved)} duplicate scenario(s) were removed deterministically.`,
      );
    }
    if (scenarios.length >= 4) {
      const maximumForOnePage = Math.max(0, ...scenarioPages.values());
      if (maximumForOnePage / scenarios.length >= 0.8) {
        warnings.push('At least 80% of scenarios concentrate on one page.');
      }
    }

    return {
      coverage,
      warnings,
      uncoveredAreas: [...new Set(uncoveredAreas)].slice(0, 100),
    };
  }
}
