import type { ExplorationResult, PageNode } from '../domain/exploration.js';
import { compareStrings } from '../domain/determinism.js';
import type { ActionEdge, SafetyAuditEntry, StateNode } from '../domain/interaction.js';
import type {
  PlanningBlockedCandidateObservation,
  PlanningContextLimits,
  PlanningEvidenceKind,
  PlanningEvidenceObservation,
  PlanningNavigationObservation,
  PlanningObservation,
  PlanningPageObservation,
  PlanningStateObservation,
  PlanningTransitionObservation,
  PlanningTruncation,
} from '../domain/planning.js';
import {
  candidateCatalogKey,
  type PlanningActionCatalogEntry,
  type PlanningCandidateCatalogEntry,
  type PlanningCatalog,
} from './planning-catalog.js';

export const DEFAULT_PLANNING_CONTEXT_LIMITS: PlanningContextLimits = {
  maxPagesForPlanning: 30,
  maxStatesForPlanning: 40,
  maxEvidenceEntries: 100,
  maxCandidatesSummary: 150,
  maxTransitionsForPlanning: 100,
  maxSerializedCharacters: 50_000,
};

interface RankedEvidence {
  readonly observation: PlanningEvidenceObservation;
  readonly priority: number;
  readonly order: number;
}

export interface CompiledPlanningObservation {
  readonly observation: PlanningObservation;
  readonly catalog: PlanningCatalog;
}

function boundedText(value: string, maximum = 240): string {
  return value
    .replaceAll(/\p{Cc}/gu, ' ')
    .trim()
    .replaceAll(/\s+/g, ' ')
    .slice(0, maximum);
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

function percentagePriority(kind: PlanningEvidenceKind): number {
  switch (kind) {
    case 'HTTP_5XX':
      return 0;
    case 'PAGE_ERROR':
      return 1;
    case 'ACTION_FAILURE':
      return 2;
    case 'CONSOLE_ERROR':
      return 3;
    case 'FAILED_REQUEST':
      return 4;
    case 'HTTP_4XX':
      return 5;
    case 'CONSOLE_WARNING':
      return 6;
    case 'DIALOG':
      return 7;
    case 'POPUP':
      return 8;
    case 'DOWNLOAD':
      return 9;
  }
}

function addTruncatedField(fields: Set<string>, field: string): void {
  fields.add(field);
}

export class PlanningObservationCompiler {
  public constructor(
    private readonly limits: PlanningContextLimits = DEFAULT_PLANNING_CONTEXT_LIMITS,
  ) {}

  public compile(source: ExplorationResult): CompiledPlanningObservation {
    const pageByUrl = new Map<string, string>();
    for (const page of source.graph.nodes) {
      pageByUrl.set(canonicalUrl(page.requestedUrl), page.id);
      pageByUrl.set(canonicalUrl(page.finalUrl), page.id);
    }
    const stateById = new Map(source.stateGraph?.nodes.map((state) => [state.id, state]) ?? []);
    const evidence = this.compileEvidence(source, pageByUrl, stateById);
    const evidenceById = new Map(
      evidence.map((entry) => [entry.observation.id, entry.observation]),
    );
    const evidenceRefsByState = new Map<string, string[]>();
    const evidenceRefsByAction = new Map<string, string[]>();
    const evidenceRefsByPage = new Map<string, string[]>();
    for (const entry of evidence) {
      const { observation } = entry;
      if (observation.stateId !== null) {
        const refs = evidenceRefsByState.get(observation.stateId) ?? [];
        refs.push(observation.id);
        evidenceRefsByState.set(observation.stateId, refs);
      }
      if (observation.actionId !== null) {
        const refs = evidenceRefsByAction.get(observation.actionId) ?? [];
        refs.push(observation.id);
        evidenceRefsByAction.set(observation.actionId, refs);
      }
      if (observation.pageId !== null) {
        const refs = evidenceRefsByPage.get(observation.pageId) ?? [];
        refs.push(observation.id);
        evidenceRefsByPage.set(observation.pageId, refs);
      }
    }
    const selectedEvidence = [...evidence]
      .sort((left, right) => left.priority - right.priority || left.order - right.order)
      .slice(0, this.limits.maxEvidenceEntries)
      .map((entry) => entry.observation);
    const includedEvidenceIds = new Set(selectedEvidence.map((entry) => entry.id));
    const selectedRefs = (references: readonly string[] | undefined): readonly string[] =>
      (references ?? []).filter((reference) => includedEvidenceIds.has(reference));

    const rankedPages = [...source.graph.nodes].sort((left, right) => {
      const priority = (page: PageNode): number => {
        if (page.status !== null && page.status >= 500) return 0;
        if (page.state === 'failed') return 1;
        if ((evidenceRefsByPage.get(page.id)?.length ?? 0) > 0) return 2;
        if (page.discoveryOrder === 1) return 3;
        if (page.status !== null && page.status >= 400) return 4;
        if (page.elements.forms > 0 || page.elements.inputs > 0) return 5;
        return 6;
      };
      return priority(left) - priority(right) || left.discoveryOrder - right.discoveryOrder;
    });
    const pages = rankedPages
      .slice(0, this.limits.maxPagesForPlanning)
      .map((page): PlanningPageObservation => ({
        id: page.id,
        url: boundedText(page.finalUrl, 500),
        title: boundedText(page.title),
        status: page.status,
        visitState: page.state,
        depth: page.depth,
        elements: page.elements,
        warnings: page.warnings.slice(0, 5).map((warning) => boundedText(warning)),
      }));
    const includedPageIds = new Set(pages.map((page) => page.id));

    const rankedStates = [...(source.stateGraph?.nodes ?? [])]
      .filter((state) => includedPageIds.has(state.pageId))
      .sort((left, right) => {
        const priority = (state: StateNode): number => {
          if ((evidenceRefsByState.get(state.id)?.length ?? 0) > 0) return 0;
          if (state.metadata.dialogs.length > 0) return 1;
          if (state.depth === 0) return 2;
          return 3;
        };
        return (
          priority(left) - priority(right) ||
          left.depth - right.depth ||
          compareStrings(left.id, right.id)
        );
      });
    const states = rankedStates
      .slice(0, this.limits.maxStatesForPlanning)
      .map((state): PlanningStateObservation => ({
        id: state.id,
        pageId: state.pageId,
        url: boundedText(state.url, 500),
        title: boundedText(state.title),
        depth: state.depth,
        headings: state.metadata.headings.slice(0, 12).map((heading) => boundedText(heading)),
        dialogs: state.metadata.dialogs.slice(0, 8).map((dialog) => boundedText(dialog)),
        visibleControls: state.metadata.visibleControls
          .slice(0, 12)
          .map((control) => boundedText(control)),
        evidenceRefs: selectedRefs(evidenceRefsByState.get(state.id)),
      }));
    const includedStateIds = new Set(states.map((state) => state.id));

    const transitions = [...(source.stateGraph?.edges ?? [])]
      .filter(
        (edge) =>
          includedStateIds.has(edge.sourceStateId) &&
          (edge.targetStateId === null || includedStateIds.has(edge.targetStateId)),
      )
      .sort((left, right) => {
        const priority = (edge: ActionEdge): number => {
          if ((evidenceRefsByAction.get(edge.id)?.length ?? 0) > 0) return 0;
          if (edge.urlChanged) return 1;
          return 2;
        };
        return priority(left) - priority(right) || compareStrings(left.id, right.id);
      })
      .slice(0, this.limits.maxTransitionsForPlanning)
      .map((edge): PlanningTransitionObservation => ({
        id: edge.id,
        sourceStateId: edge.sourceStateId,
        targetStateId: edge.targetStateId,
        actionType: edge.action.actionType,
        accessibleName: boundedText(edge.action.accessibleName),
        role: boundedText(edge.action.role, 80),
        outcome: edge.outcome,
        urlChanged: edge.urlChanged,
        evidenceRefs: selectedRefs(evidenceRefsByAction.get(edge.id)),
      }));

    const allBlockedCandidates = [...(source.stateGraph?.safetyAudit ?? [])]
      .filter(
        (
          entry,
        ): entry is SafetyAuditEntry & {
          readonly classification: 'CAUTION' | 'DESTRUCTIVE' | 'UNKNOWN';
        } => !entry.executed && entry.classification !== 'SAFE',
      )
      .sort((left, right) => {
        const rank = { DESTRUCTIVE: 0, CAUTION: 1, UNKNOWN: 2 } as const;
        return (
          rank[left.classification] - rank[right.classification] ||
          compareStrings(left.id, right.id)
        );
      });
    const eligibleBlockedCandidates = allBlockedCandidates.filter((entry) =>
      includedStateIds.has(entry.stateId),
    );
    const representativeKeys = new Set<string>();
    const representativeCandidates: typeof eligibleBlockedCandidates = [];
    const repeatedCandidates: typeof eligibleBlockedCandidates = [];
    for (const entry of eligibleBlockedCandidates) {
      const key = JSON.stringify({
        classification: entry.classification,
        accessibleName: boundedText(entry.candidate.accessibleName).toLowerCase(),
        tag: entry.candidate.tag,
        reason: entry.reason,
      });
      if (representativeKeys.has(key)) repeatedCandidates.push(entry);
      else {
        representativeKeys.add(key);
        representativeCandidates.push(entry);
      }
    }
    const blockedCandidates = [...representativeCandidates, ...repeatedCandidates]
      .slice(0, this.limits.maxCandidatesSummary)
      .map((entry): PlanningBlockedCandidateObservation => ({
        stateId: entry.stateId,
        candidateId: entry.candidate.id,
        accessibleName: boundedText(entry.candidate.accessibleName),
        tag: boundedText(entry.candidate.tag, 40),
        classification: entry.classification,
        reason: boundedText(entry.reason, 120),
      }));

    const navigation = source.graph.edges
      .filter((edge) => includedPageIds.has(edge.sourcePageId))
      .slice(0, this.limits.maxTransitionsForPlanning)
      .map((edge): PlanningNavigationObservation => ({
        id: edge.id,
        sourcePageId: edge.sourcePageId,
        targetPageId: edge.targetPageId,
        targetUrl: edge.targetUrl === null ? null : boundedText(edge.targetUrl, 500),
        hint: boundedText(edge.hint),
        scope: edge.scope,
        visited: edge.visited,
      }));

    const original = {
      pages: source.graph.nodes.length,
      navigation: source.graph.edges.length,
      states: source.stateGraph?.nodes.length ?? 0,
      transitions: source.stateGraph?.edges.length ?? 0,
      evidence: evidence.length,
      candidates: allBlockedCandidates.length,
    };
    const truncatedFields = new Set<string>();
    if (pages.length < original.pages) addTruncatedField(truncatedFields, 'pages');
    if (navigation.length < original.navigation) addTruncatedField(truncatedFields, 'navigation');
    if (states.length < original.states) addTruncatedField(truncatedFields, 'states');
    if (transitions.length < original.transitions)
      addTruncatedField(truncatedFields, 'transitions');
    if (selectedEvidence.length < original.evidence) addTruncatedField(truncatedFields, 'evidence');
    if (blockedCandidates.length < original.candidates) {
      addTruncatedField(truncatedFields, 'blockedCandidates');
    }

    const mutable = {
      pages,
      navigation,
      states,
      transitions,
      blockedCandidates,
      evidence: selectedEvidence,
    };
    let observation = this.createObservation(source, original, mutable, truncatedFields, 0);
    while (JSON.stringify(observation).length > this.limits.maxSerializedCharacters) {
      if (mutable.blockedCandidates.length > 0) {
        mutable.blockedCandidates.pop();
        addTruncatedField(truncatedFields, 'blockedCandidates');
      } else if (mutable.navigation.length > 0) {
        mutable.navigation.pop();
        addTruncatedField(truncatedFields, 'navigation');
      } else if (mutable.transitions.length > 0) {
        mutable.transitions.pop();
        addTruncatedField(truncatedFields, 'transitions');
      } else if (mutable.states.length > 0) {
        mutable.states.pop();
        addTruncatedField(truncatedFields, 'states');
      } else if (mutable.pages.length > 0) {
        mutable.pages.pop();
        addTruncatedField(truncatedFields, 'pages');
      } else if (mutable.evidence.length > 0) {
        mutable.evidence.pop();
        addTruncatedField(truncatedFields, 'evidence');
      } else {
        throw new Error('Planning context limit is too small for required observation metadata.');
      }
      observation = this.createObservation(source, original, mutable, truncatedFields, 0);
    }
    for (let index = 0; index < 3; index += 1) {
      const length = JSON.stringify(observation).length;
      observation = this.createObservation(source, original, mutable, truncatedFields, length);
    }
    if (JSON.stringify(observation).length > this.limits.maxSerializedCharacters) {
      throw new Error('Planning observation exceeded the configured character limit.');
    }

    const allActions = new Map<string, PlanningActionCatalogEntry>();
    for (const edge of source.stateGraph?.edges ?? []) {
      allActions.set(edge.id, {
        actionId: edge.id,
        sourceStateId: edge.sourceStateId,
        targetStateId: edge.targetStateId,
        risk: edge.risk,
      });
    }
    const allCandidates = new Map<string, PlanningCandidateCatalogEntry>();
    for (const entry of source.stateGraph?.safetyAudit ?? []) {
      allCandidates.set(candidateCatalogKey(entry.stateId, entry.candidate.id), {
        stateId: entry.stateId,
        candidateId: entry.candidate.id,
        risk: entry.classification,
        accessibleName: entry.candidate.accessibleName,
      });
    }
    const actions = new Map(
      mutable.transitions.flatMap((transition) => {
        const action = allActions.get(transition.id);
        return action === undefined ? [] : [[transition.id, action] as const];
      }),
    );
    const candidates = new Map(
      mutable.blockedCandidates.flatMap((candidate) => {
        const key = candidateCatalogKey(candidate.stateId, candidate.candidateId);
        const entry = allCandidates.get(key);
        return entry === undefined ? [] : [[key, entry] as const];
      }),
    );
    const includedEvidence = new Map(mutable.evidence.map((entry) => [entry.id, entry] as const));
    const criticalPageIds = new Set(
      source.graph.nodes
        .filter((page) => page.state === 'failed' || (page.status !== null && page.status >= 500))
        .map((page) => page.id),
    );
    const errorBearingStateIds = new Set(
      evidence
        .map((entry) => entry.observation)
        .filter((entry) =>
          [
            'HTTP_5XX',
            'HTTP_4XX',
            'PAGE_ERROR',
            'CONSOLE_ERROR',
            'FAILED_REQUEST',
            'ACTION_FAILURE',
          ].includes(entry.kind),
        )
        .flatMap((entry) => (entry.stateId === null ? [] : [entry.stateId])),
    );
    const catalog: PlanningCatalog = {
      source,
      pageIds: new Set(mutable.pages.map((page) => page.id)),
      stateIds: new Set(mutable.states.map((state) => state.id)),
      statePageIds: new Map(
        source.stateGraph?.nodes.map((state) => [state.id, state.pageId]) ?? [],
      ),
      actions,
      candidates,
      evidence: includedEvidence,
      allPageIds: new Set(source.graph.nodes.map((page) => page.id)),
      allStateIds: new Set(source.stateGraph?.nodes.map((state) => state.id) ?? []),
      allActions,
      allEvidence: evidenceById,
      rootPageId: source.graph.nodes.find((page) => page.discoveryOrder === 1)?.id ?? null,
      criticalPageIds,
      errorBearingStateIds,
    };
    return { observation, catalog };
  }

  private compileEvidence(
    source: ExplorationResult,
    pageByUrl: ReadonlyMap<string, string>,
    stateById: ReadonlyMap<string, StateNode>,
  ): RankedEvidence[] {
    const result: RankedEvidence[] = [];
    let order = 0;
    const add = (
      id: string,
      kind: PlanningEvidenceKind,
      severity: PlanningEvidenceObservation['severity'],
      summary: string,
      pageId: string | null,
      stateId: string | null,
      actionId: string | null,
    ): void => {
      result.push({
        observation: {
          id,
          kind,
          severity,
          summary: boundedText(summary, 500),
          pageId,
          stateId,
          actionId,
        },
        priority: percentagePriority(kind),
        order,
      });
      order += 1;
    };
    const pageIdFor = (url: string): string | null => pageByUrl.get(canonicalUrl(url)) ?? null;

    let consoleError = 0;
    let consoleWarning = 0;
    for (const entry of source.evidence.console) {
      if (entry.type === 'error') {
        consoleError += 1;
        add(
          `console-error-${String(consoleError).padStart(3, '0')}`,
          'CONSOLE_ERROR',
          'ERROR',
          entry.message,
          pageIdFor(entry.pageUrl),
          null,
          null,
        );
      } else {
        consoleWarning += 1;
        add(
          `console-warning-${String(consoleWarning).padStart(3, '0')}`,
          'CONSOLE_WARNING',
          'WARNING',
          entry.message,
          pageIdFor(entry.pageUrl),
          null,
          null,
        );
      }
    }
    source.evidence.pageErrors.forEach((entry, index) => {
      add(
        `page-error-${String(index + 1).padStart(3, '0')}`,
        'PAGE_ERROR',
        'ERROR',
        entry.message,
        pageIdFor(entry.pageUrl),
        null,
        null,
      );
    });
    source.evidence.failedRequests.forEach((entry, index) => {
      add(
        `failed-request-${String(index + 1).padStart(3, '0')}`,
        'FAILED_REQUEST',
        'ERROR',
        `${entry.method} ${entry.url}: ${entry.failureReason}`,
        pageIdFor(entry.pageUrl),
        null,
        null,
      );
    });
    source.evidence.httpErrors.forEach((entry, index) => {
      add(
        `http-error-${String(index + 1).padStart(3, '0')}`,
        entry.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX',
        entry.status >= 500 ? 'CRITICAL' : 'ERROR',
        `${String(entry.status)} ${entry.method} ${entry.url}`,
        pageIdFor(entry.pageUrl),
        null,
        null,
      );
    });

    for (const edge of source.stateGraph?.edges ?? []) {
      const stateId = edge.targetStateId ?? edge.sourceStateId;
      const pageId = stateById.get(stateId)?.pageId ?? null;
      let errorIndex = 0;
      let warningIndex = 0;
      for (const entry of edge.evidence.browser.console) {
        if (entry.type === 'error') {
          errorIndex += 1;
          add(
            `${edge.id}-console-error-${String(errorIndex).padStart(3, '0')}`,
            'CONSOLE_ERROR',
            'ERROR',
            entry.message,
            pageId,
            stateId,
            edge.id,
          );
        } else {
          warningIndex += 1;
          add(
            `${edge.id}-console-warning-${String(warningIndex).padStart(3, '0')}`,
            'CONSOLE_WARNING',
            'WARNING',
            entry.message,
            pageId,
            stateId,
            edge.id,
          );
        }
      }
      edge.evidence.browser.pageErrors.forEach((entry, index) => {
        add(
          `${edge.id}-page-error-${String(index + 1).padStart(3, '0')}`,
          'PAGE_ERROR',
          'ERROR',
          entry.message,
          pageId,
          stateId,
          edge.id,
        );
      });
      edge.evidence.browser.failedRequests.forEach((entry, index) => {
        add(
          `${edge.id}-failed-request-${String(index + 1).padStart(3, '0')}`,
          'FAILED_REQUEST',
          'ERROR',
          `${entry.method} ${entry.url}: ${entry.failureReason}`,
          pageId,
          stateId,
          edge.id,
        );
      });
      edge.evidence.browser.httpErrors.forEach((entry, index) => {
        add(
          `${edge.id}-http-error-${String(index + 1).padStart(3, '0')}`,
          entry.status >= 500 ? 'HTTP_5XX' : 'HTTP_4XX',
          entry.status >= 500 ? 'CRITICAL' : 'ERROR',
          `${String(entry.status)} ${entry.method} ${entry.url}`,
          pageId,
          stateId,
          edge.id,
        );
      });
      edge.evidence.dialogs.forEach((entry, index) => {
        add(
          `${edge.id}-dialog-${String(index + 1).padStart(3, '0')}`,
          'DIALOG',
          'INFO',
          `${entry.type}: ${entry.message}`,
          pageId,
          stateId,
          edge.id,
        );
      });
      edge.evidence.popups.forEach((entry, index) => {
        add(
          `${edge.id}-popup-${String(index + 1).padStart(3, '0')}`,
          'POPUP',
          'INFO',
          `${entry.scope} popup: ${entry.url}`,
          pageId,
          stateId,
          edge.id,
        );
      });
      edge.evidence.downloads.forEach((entry, index) => {
        add(
          `${edge.id}-download-${String(index + 1).padStart(3, '0')}`,
          'DOWNLOAD',
          'INFO',
          `${entry.suggestedFilename}: ${entry.url}`,
          pageId,
          stateId,
          edge.id,
        );
      });
    }
    source.stateGraph?.failures.forEach((entry, index) => {
      const pageId = stateById.get(entry.stateId)?.pageId ?? null;
      add(
        `action-failure-${String(index + 1).padStart(3, '0')}`,
        'ACTION_FAILURE',
        'ERROR',
        entry.reason,
        pageId,
        entry.stateId,
        entry.actionId,
      );
    });
    return result;
  }

  private createObservation(
    source: ExplorationResult,
    original: PlanningTruncation['original'],
    values: {
      readonly pages: readonly PlanningPageObservation[];
      readonly navigation: readonly PlanningNavigationObservation[];
      readonly states: readonly PlanningStateObservation[];
      readonly transitions: readonly PlanningTransitionObservation[];
      readonly blockedCandidates: readonly PlanningBlockedCandidateObservation[];
      readonly evidence: readonly PlanningEvidenceObservation[];
    },
    truncatedFields: ReadonlySet<string>,
    serializedCharacters: number,
  ): PlanningObservation {
    const evidenceIds = new Set(values.evidence.map((entry) => entry.id));
    const states = values.states.map((state) => ({
      ...state,
      evidenceRefs: state.evidenceRefs.filter((reference) => evidenceIds.has(reference)),
    }));
    const transitions = values.transitions.map((transition) => ({
      ...transition,
      evidenceRefs: transition.evidenceRefs.filter((reference) => evidenceIds.has(reference)),
    }));
    const included = {
      pages: values.pages.length,
      navigation: values.navigation.length,
      states: states.length,
      transitions: transitions.length,
      evidence: values.evidence.length,
      candidates: values.blockedCandidates.length,
    };
    const truncation: PlanningTruncation = {
      truncated: truncatedFields.size > 0,
      truncatedFields: [...truncatedFields].sort(),
      original,
      included,
      serializedCharacters,
      maxSerializedCharacters: this.limits.maxSerializedCharacters,
    };
    return {
      schemaVersion: '1.0',
      trustBoundary: 'UNTRUSTED_APPLICATION_DATA',
      source: {
        runId: source.runId,
        explorationSchemaVersion: source.schemaVersion,
        startUrl: boundedText(source.startUrl, 500),
      },
      totals: {
        pages: original.pages,
        navigation: original.navigation,
        states: original.states,
        safeTransitions: original.transitions,
        evidence: original.evidence,
        blockedCandidates: original.candidates,
      },
      pages: values.pages,
      navigation: values.navigation,
      states,
      transitions,
      blockedCandidates: values.blockedCandidates,
      evidence: values.evidence,
      truncation,
    };
  }
}
