import type {
  EvidenceReproduction,
  ExecutionEvidenceEntry,
  ExecutionEvidenceKind,
} from '../domain/execution.js';
import type { InteractionEvidence } from '../domain/interaction.js';
import type { PlanningEvidenceObservation } from '../domain/planning.js';
import { normalizeDiagnosticText } from './evidence-normalization.js';

export interface ExecutionEvidenceContext {
  readonly executionId: string;
  readonly scenarioId: string;
  readonly stepId: string | null;
  readonly pageId: string | null;
  readonly sourceStateId: string | null;
  readonly actualStateId: string | null;
  readonly actualUrl: string | null;
}

const MAX_EXECUTION_EVIDENCE_ENTRIES = 1_000;

export class ExecutionEvidenceCollector {
  private readonly entries: ExecutionEvidenceEntry[] = [];
  private didTruncate = false;

  public append(
    evidence: InteractionEvidence,
    context: ExecutionEvidenceContext,
  ): readonly string[] {
    const ids: string[] = [];
    const add = (
      kind: ExecutionEvidenceKind,
      timestamp: string,
      message: string,
      values: {
        readonly url?: string | null;
        readonly method?: string | null;
        readonly status?: number | null;
        readonly resourceType?: string | null;
      } = {},
    ): void => {
      if (this.entries.length >= MAX_EXECUTION_EVIDENCE_ENTRIES) {
        this.didTruncate = true;
        return;
      }
      const id = `runtime-evidence-${String(this.entries.length + 1).padStart(5, '0')}`;
      this.entries.push({
        id,
        executionId: context.executionId,
        kind,
        timestamp,
        scenarioId: context.scenarioId,
        stepId: context.stepId,
        pageId: context.pageId,
        sourceStateId: context.sourceStateId,
        actualStateId: context.actualStateId,
        url: values.url ?? context.actualUrl,
        message,
        method: values.method ?? null,
        status: values.status ?? null,
        resourceType: values.resourceType ?? null,
      });
      ids.push(id);
    };
    for (const entry of evidence.browser.console) {
      add(
        entry.type === 'error' ? 'CONSOLE_ERROR' : 'CONSOLE_WARNING',
        entry.timestamp,
        entry.message,
        { url: entry.pageUrl },
      );
    }
    for (const entry of evidence.browser.pageErrors) {
      add('PAGE_ERROR', entry.timestamp, entry.message, { url: entry.pageUrl });
    }
    for (const entry of evidence.browser.failedRequests) {
      add(
        'FAILED_REQUEST',
        entry.timestamp,
        `${entry.method} ${entry.url}: ${entry.failureReason}`,
        { url: entry.url, method: entry.method, resourceType: entry.resourceType },
      );
    }
    for (const entry of evidence.browser.httpErrors) {
      add('HTTP_ERROR', entry.timestamp, `${String(entry.status)} ${entry.method} ${entry.url}`, {
        url: entry.url,
        method: entry.method,
        status: entry.status,
        resourceType: entry.resourceType,
      });
    }
    for (const entry of evidence.dialogs) {
      add('DIALOG', entry.timestamp, `${entry.type}: ${entry.message}`);
    }
    for (const entry of evidence.popups) {
      add('POPUP', entry.timestamp, `${entry.scope} popup: ${entry.url}`, { url: entry.url });
    }
    for (const entry of evidence.downloads) {
      add('DOWNLOAD', entry.timestamp, `${entry.suggestedFilename}: ${entry.url}`, {
        url: entry.url,
      });
    }
    return ids;
  }

  public appendActionFailure(
    context: ExecutionEvidenceContext,
    message: string,
    timestamp: string,
  ): string | null {
    if (this.entries.length >= MAX_EXECUTION_EVIDENCE_ENTRIES) {
      this.didTruncate = true;
      return null;
    }
    const id = `runtime-evidence-${String(this.entries.length + 1).padStart(5, '0')}`;
    this.entries.push({
      id,
      executionId: context.executionId,
      kind: 'ACTION_FAILURE',
      timestamp,
      scenarioId: context.scenarioId,
      stepId: context.stepId,
      pageId: context.pageId,
      sourceStateId: context.sourceStateId,
      actualStateId: context.actualStateId,
      url: context.actualUrl,
      message,
      method: null,
      status: null,
      resourceType: null,
    });
    return id;
  }

  public all(): readonly ExecutionEvidenceEntry[] {
    return this.entries;
  }

  public get truncated(): boolean {
    return this.didTruncate;
  }
}

export class EvidenceReproductionMatcher {
  public match(
    references: readonly string[],
    sourceEvidence: ReadonlyMap<string, PlanningEvidenceObservation>,
    runtime: readonly ExecutionEvidenceEntry[],
  ): readonly EvidenceReproduction[] {
    return [...new Set(references)].map((reference): EvidenceReproduction => {
      const source = sourceEvidence.get(reference);
      if (source === undefined || source.kind === 'ACTION_FAILURE') {
        return { sourceEvidenceRef: reference, status: 'NOT_EVALUATED', executionEvidenceRefs: [] };
      }
      const expectedKind = this.runtimeKind(source.kind);
      if (expectedKind === null) {
        return { sourceEvidenceRef: reference, status: 'NOT_EVALUATED', executionEvidenceRefs: [] };
      }
      const matching = runtime
        .filter(
          (entry) =>
            entry.kind === expectedKind &&
            normalizeDiagnosticText(entry.message) === normalizeDiagnosticText(source.summary),
        )
        .map((entry) => entry.id);
      return {
        sourceEvidenceRef: reference,
        status: matching.length > 0 ? 'REPRODUCED' : 'NOT_REPRODUCED',
        executionEvidenceRefs: matching,
      };
    });
  }

  private runtimeKind(kind: PlanningEvidenceObservation['kind']): ExecutionEvidenceKind | null {
    switch (kind) {
      case 'HTTP_5XX':
      case 'HTTP_4XX':
        return 'HTTP_ERROR';
      case 'PAGE_ERROR':
        return 'PAGE_ERROR';
      case 'CONSOLE_ERROR':
        return 'CONSOLE_ERROR';
      case 'CONSOLE_WARNING':
        return 'CONSOLE_WARNING';
      case 'FAILED_REQUEST':
        return 'FAILED_REQUEST';
      case 'DIALOG':
        return 'DIALOG';
      case 'POPUP':
        return 'POPUP';
      case 'DOWNLOAD':
        return 'DOWNLOAD';
      case 'ACTION_FAILURE':
        return null;
    }
  }
}
