import { z } from 'zod';
import type { ExplorationResult } from '../domain/exploration.js';

const MAX_PAGES = 5_000;
const MAX_EDGES = 20_000;
const MAX_AUDIT_ENTRIES = 50_000;
const MAX_EVIDENCE_ENTRIES = 10_000;

const bounded = (maximum: number) => z.string().max(maximum);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const timestamp = z.iso.datetime({ offset: true });
const nonnegative = z.number().int().nonnegative();
const positiveDimension = z.number().int().min(1).max(100_000);
const safeArtifactPath = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('~') &&
      !value.includes('://') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value !== '..' &&
      !value.startsWith('../') &&
      !value.includes('/../'),
    'must be a safe relative artifact path',
  );

const viewportSchema = z.object({ width: positiveDimension, height: positiveDimension }).strict();
const elementCountsSchema = z
  .object({
    links: nonnegative,
    buttons: nonnegative,
    inputs: nonnegative,
    forms: nonnegative,
    headings: nonnegative,
  })
  .strict();

const consoleEvidenceSchema = z
  .object({
    type: z.enum(['error', 'warning']),
    message: bounded(20_000),
    pageUrl: bounded(8_000),
    timestamp,
  })
  .strict();
const pageErrorSchema = z
  .object({ message: bounded(20_000), pageUrl: bounded(8_000), timestamp })
  .strict();
const failedRequestSchema = z
  .object({
    method: bounded(32),
    url: bounded(8_000),
    resourceType: bounded(100),
    failureReason: bounded(4_000),
    pageUrl: bounded(8_000),
    timestamp,
  })
  .strict();
const httpErrorSchema = z
  .object({
    status: z.number().int().min(400).max(599),
    method: bounded(32),
    url: bounded(8_000),
    resourceType: bounded(100),
    pageUrl: bounded(8_000),
    timestamp,
  })
  .strict();
const evidenceSchema = z
  .object({
    console: z.array(consoleEvidenceSchema).max(MAX_EVIDENCE_ENTRIES),
    pageErrors: z.array(pageErrorSchema).max(MAX_EVIDENCE_ENTRIES),
    failedRequests: z.array(failedRequestSchema).max(MAX_EVIDENCE_ENTRIES),
    httpErrors: z.array(httpErrorSchema).max(MAX_EVIDENCE_ENTRIES),
  })
  .strict();

const locatorSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('testId'), value: bounded(1_000), index: nonnegative }).strict(),
  z
    .object({
      strategy: z.literal('role'),
      role: bounded(100),
      name: bounded(2_000),
      index: nonnegative,
    })
    .strict(),
  z.object({ strategy: z.literal('label'), value: bounded(2_000), index: nonnegative }).strict(),
  z.object({ strategy: z.literal('id'), value: bounded(1_000), index: nonnegative }).strict(),
  z.object({ strategy: z.literal('text'), value: bounded(2_000), index: nonnegative }).strict(),
]);

const candidateSchema = z
  .object({
    id: identifier,
    domOrder: nonnegative,
    tag: bounded(100),
    role: bounded(100),
    accessibleName: bounded(2_000),
    text: bounded(4_000),
    href: bounded(8_000).nullable(),
    elementType: bounded(100).nullable(),
    ariaLabel: bounded(2_000).nullable(),
    title: bounded(2_000).nullable(),
    ariaExpanded: z.boolean().nullable(),
    ariaSelected: z.boolean().nullable(),
    disabled: z.boolean(),
    visible: z.boolean(),
    formAssociated: z.boolean(),
    submitsForm: z.boolean(),
    fileUpload: z.boolean(),
    testId: bounded(1_000).nullable(),
    label: bounded(2_000).nullable(),
    stableId: bounded(1_000).nullable(),
    locator: locatorSchema.nullable(),
  })
  .strict();

const actionDescriptorSchema = z
  .object({
    actionType: z.literal('click'),
    identity: bounded(2_000),
    locator: locatorSchema,
    role: bounded(100),
    accessibleName: bounded(2_000),
    visibleText: bounded(4_000),
  })
  .strict();

const pageSchema = z
  .object({
    id: identifier,
    requestedUrl: bounded(8_000),
    finalUrl: bounded(8_000),
    title: bounded(20_000),
    status: z.number().int().min(100).max(599).nullable(),
    state: z.enum(['visited', 'failed']),
    depth: nonnegative,
    discoveryOrder: z.number().int().positive(),
    discoveredFrom: bounded(8_000).nullable(),
    viewport: viewportSchema,
    elements: elementCountsSchema,
    timestamp,
    durationMs: nonnegative,
    screenshot: safeArtifactPath.nullable(),
    warnings: z.array(bounded(4_000)).max(10_000),
  })
  .strict();

const navigationEdgeSchema = z
  .object({
    id: identifier,
    sourcePageId: identifier,
    sourceUrl: bounded(8_000),
    href: bounded(8_000),
    targetUrl: bounded(8_000).nullable(),
    hint: bounded(4_000),
    scope: z.enum(['internal', 'external', 'unsupported']),
    targetPageId: identifier.nullable(),
    attempted: z.boolean(),
    visited: z.boolean(),
    skipReason: z
      .enum(['duplicate', 'max-depth', 'max-pages', 'query-limit', 'unsafe', 'unsupported'])
      .nullable(),
  })
  .strict();

const graphSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    startUrl: bounded(8_000),
    nodes: z.array(pageSchema).max(MAX_PAGES),
    edges: z.array(navigationEdgeSchema).max(MAX_EDGES),
  })
  .strict();

const stateMetadataSchema = z
  .object({
    title: bounded(20_000),
    headings: z.array(bounded(4_000)).max(1_000),
    dialogs: z.array(bounded(4_000)).max(1_000),
    visibleControls: z.array(bounded(4_000)).max(10_000),
  })
  .strict();
const stateSchema = z
  .object({
    id: identifier,
    pageId: identifier,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    url: bounded(8_000),
    title: bounded(20_000),
    depth: nonnegative,
    discoveredFromActionId: identifier.nullable(),
    actionPath: z.array(actionDescriptorSchema).max(100),
    metadata: stateMetadataSchema,
    screenshot: safeArtifactPath,
  })
  .strict();
const dialogEvidenceSchema = z
  .object({
    type: bounded(100),
    message: bounded(20_000),
    disposition: z.literal('dismissed'),
    timestamp,
  })
  .strict();
const popupEvidenceSchema = z
  .object({
    url: bounded(8_000),
    scope: z.enum(['same-origin', 'external', 'unknown']),
    disposition: z.enum(['registered-and-closed', 'closed']),
    timestamp,
  })
  .strict();
const downloadEvidenceSchema = z
  .object({
    url: bounded(8_000),
    suggestedFilename: bounded(2_000),
    disposition: z.literal('cancelled'),
    timestamp,
  })
  .strict();
const interactionEvidenceSchema = z
  .object({
    browser: evidenceSchema,
    dialogs: z.array(dialogEvidenceSchema).max(MAX_EVIDENCE_ENTRIES),
    popups: z.array(popupEvidenceSchema).max(MAX_EVIDENCE_ENTRIES),
    downloads: z.array(downloadEvidenceSchema).max(MAX_EVIDENCE_ENTRIES),
  })
  .strict();
const actionEdgeSchema = z
  .object({
    id: identifier,
    sourceStateId: identifier,
    targetStateId: identifier.nullable(),
    action: actionDescriptorSchema,
    risk: z.literal('SAFE'),
    urlBefore: bounded(8_000),
    urlAfter: bounded(8_000),
    urlChanged: z.boolean(),
    durationMs: nonnegative,
    outcome: z.enum(['NEW_STATE', 'SAME_STATE', 'NAVIGATION', 'BLOCKED', 'FAILED', 'TIMEOUT']),
    reason: bounded(4_000).nullable(),
    evidence: interactionEvidenceSchema,
  })
  .strict();
const safetyAuditSchema = z
  .object({
    id: identifier,
    stateId: identifier,
    candidate: candidateSchema,
    classification: z.enum(['SAFE', 'CAUTION', 'DESTRUCTIVE', 'UNKNOWN']),
    executed: z.boolean(),
    reason: bounded(4_000),
    actionId: identifier.nullable(),
  })
  .strict();
const actionFailureSchema = z
  .object({
    actionId: identifier,
    stateId: identifier,
    candidateId: identifier,
    reason: bounded(4_000),
    timeout: z.boolean(),
  })
  .strict();
const stateGraphSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    enabled: z.boolean(),
    nodes: z.array(stateSchema).max(MAX_PAGES),
    edges: z.array(actionEdgeSchema).max(MAX_EDGES),
    safetyAudit: z.array(safetyAuditSchema).max(MAX_AUDIT_ENTRIES),
    failures: z.array(actionFailureSchema).max(MAX_EDGES),
  })
  .strict();

const summarySchema = z
  .object({
    pagesAttempted: nonnegative,
    pagesVisited: nonnegative,
    pagesFailed: nonnegative,
    linksDiscovered: nonnegative,
    externalLinks: nonnegative,
    consoleErrors: nonnegative,
    consoleWarnings: nonnegative,
    pageErrors: nonnegative,
    failedRequests: nonnegative,
    httpErrors: nonnegative,
  })
  .strict();
const interactiveSummarySchema = z
  .object({
    enabled: z.boolean(),
    statesDiscovered: nonnegative,
    candidatesConsidered: nonnegative,
    actionsExecuted: nonnegative,
    actionsBlocked: nonnegative,
    actionFailures: nonnegative,
    duplicateStates: nonnegative,
    limitReached: z.array(z.enum(['maxStates', 'maxActionsPerState', 'maxStateDepth'])).max(3),
  })
  .strict();

const explorationSchema = z
  .object({
    schemaVersion: z.literal('3.0'),
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    startUrl: bounded(8_000),
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: nonnegative,
    limits: z
      .object({
        maxPages: z.number().int().positive(),
        maxDepth: nonnegative,
        maxQueryVariantsPerPath: z.number().int().positive(),
      })
      .strict(),
    interactiveLimits: z
      .object({
        maxStates: z.number().int().positive(),
        maxActionsPerState: z.number().int().positive(),
        maxStateDepth: nonnegative,
      })
      .strict(),
    summary: summarySchema,
    interactive: interactiveSummarySchema,
    graph: graphSchema,
    stateGraph: stateGraphSchema.nullable(),
    evidence: evidenceSchema,
    warnings: z.array(bounded(4_000)).max(10_000),
    artifacts: z
      .object({
        graph: z.literal('graph.json'),
        trace: z.literal('trace.zip'),
        pagesDirectory: z.literal('pages'),
        stateGraph: z.literal('state-graph.json').nullable(),
        statesDirectory: z.literal('states').nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: readonly (string | number)[], message: string): void => {
      context.addIssue({ code: 'custom', path: [...path], message });
    };
    if (value.startUrl !== value.graph.startUrl) {
      issue(['graph', 'startUrl'], 'must match the exploration startUrl');
    }
    const pageIds = new Set<string>();
    const navigationEdgeIds = new Set<string>();
    for (const page of value.graph.nodes) {
      if (pageIds.has(page.id)) issue(['graph', 'nodes'], `duplicate page identifier ${page.id}`);
      pageIds.add(page.id);
    }
    for (const edge of value.graph.edges) {
      if (navigationEdgeIds.has(edge.id))
        issue(['graph', 'edges'], `duplicate navigation edge identifier ${edge.id}`);
      navigationEdgeIds.add(edge.id);
      if (!pageIds.has(edge.sourcePageId)) {
        issue(['graph', 'edges'], `edge ${edge.id} references an unknown source page`);
      }
      if (edge.targetPageId !== null && !pageIds.has(edge.targetPageId)) {
        issue(['graph', 'edges'], `edge ${edge.id} references an unknown target page`);
      }
    }
    const visited = value.graph.nodes.filter((page) => page.state === 'visited').length;
    const failed = value.graph.nodes.filter((page) => page.state === 'failed').length;
    if (value.summary.pagesVisited !== visited)
      issue(['summary', 'pagesVisited'], 'does not match graph nodes');
    if (value.summary.pagesFailed !== failed)
      issue(['summary', 'pagesFailed'], 'does not match graph nodes');
    if (value.summary.pagesAttempted < visited + failed)
      issue(['summary', 'pagesAttempted'], 'cannot be less than graph node count');
    if (value.summary.linksDiscovered !== value.graph.edges.length)
      issue(['summary', 'linksDiscovered'], 'does not match graph edges');
    if (
      value.summary.externalLinks !==
      value.graph.edges.filter((edge) => edge.scope === 'external').length
    )
      issue(['summary', 'externalLinks'], 'does not match external graph edges');
    if (
      value.summary.consoleErrors !==
      value.evidence.console.filter((entry) => entry.type === 'error').length
    )
      issue(['summary', 'consoleErrors'], 'does not match console evidence');
    if (
      value.summary.consoleWarnings !==
      value.evidence.console.filter((entry) => entry.type === 'warning').length
    )
      issue(['summary', 'consoleWarnings'], 'does not match console evidence');
    if (value.summary.pageErrors !== value.evidence.pageErrors.length)
      issue(['summary', 'pageErrors'], 'does not match page-error evidence');
    if (value.summary.failedRequests !== value.evidence.failedRequests.length)
      issue(['summary', 'failedRequests'], 'does not match failed-request evidence');
    if (value.summary.httpErrors !== value.evidence.httpErrors.length)
      issue(['summary', 'httpErrors'], 'does not match HTTP-error evidence');

    if (value.interactive.enabled !== (value.stateGraph?.enabled === true)) {
      issue(['interactive', 'enabled'], 'does not match state graph availability');
    }
    if ((value.artifacts.stateGraph === null) !== (value.stateGraph === null)) {
      issue(['artifacts', 'stateGraph'], 'does not match embedded state graph availability');
    }
    if ((value.artifacts.statesDirectory === null) !== (value.stateGraph === null)) {
      issue(['artifacts', 'statesDirectory'], 'does not match embedded state graph availability');
    }
    if (value.stateGraph !== null) {
      const stateIds = new Set<string>();
      const actionIds = new Set<string>();
      const auditIds = new Set<string>();
      for (const state of value.stateGraph.nodes) {
        if (stateIds.has(state.id))
          issue(['stateGraph', 'nodes'], `duplicate state identifier ${state.id}`);
        stateIds.add(state.id);
        if (!pageIds.has(state.pageId))
          issue(['stateGraph', 'nodes'], `state ${state.id} references an unknown page`);
        if (state.actionPath.length !== state.depth)
          issue(['stateGraph', 'nodes'], `state ${state.id} has an inconsistent replay depth`);
      }
      for (const edge of value.stateGraph.edges) {
        if (actionIds.has(edge.id))
          issue(['stateGraph', 'edges'], `duplicate action identifier ${edge.id}`);
        actionIds.add(edge.id);
        if (!stateIds.has(edge.sourceStateId))
          issue(['stateGraph', 'edges'], `action ${edge.id} references an unknown source state`);
        if (edge.targetStateId !== null && !stateIds.has(edge.targetStateId))
          issue(['stateGraph', 'edges'], `action ${edge.id} references an unknown target state`);
      }
      for (const state of value.stateGraph.nodes) {
        if (state.discoveredFromActionId !== null && !actionIds.has(state.discoveredFromActionId))
          issue(
            ['stateGraph', 'nodes'],
            `state ${state.id} references an unknown discovery action`,
          );
      }
      for (const audit of value.stateGraph.safetyAudit) {
        if (auditIds.has(audit.id))
          issue(['stateGraph', 'safetyAudit'], `duplicate audit identifier ${audit.id}`);
        auditIds.add(audit.id);
        if (!stateIds.has(audit.stateId))
          issue(['stateGraph', 'safetyAudit'], `audit ${audit.id} references an unknown state`);
        if (audit.actionId !== null && !actionIds.has(audit.actionId))
          issue(['stateGraph', 'safetyAudit'], `audit ${audit.id} references an unknown action`);
        if (audit.executed !== (audit.actionId !== null))
          issue(
            ['stateGraph', 'safetyAudit'],
            `audit ${audit.id} has inconsistent execution metadata`,
          );
      }
      for (const failure of value.stateGraph.failures) {
        if (!actionIds.has(failure.actionId))
          issue(
            ['stateGraph', 'failures'],
            `failure ${failure.actionId} references an unknown action`,
          );
        if (!stateIds.has(failure.stateId))
          issue(
            ['stateGraph', 'failures'],
            `failure ${failure.actionId} references an unknown state`,
          );
      }
      if (value.interactive.statesDiscovered !== value.stateGraph.nodes.length)
        issue(['interactive', 'statesDiscovered'], 'does not match state graph nodes');
      if (value.interactive.candidatesConsidered !== value.stateGraph.safetyAudit.length)
        issue(['interactive', 'candidatesConsidered'], 'does not match safety audit');
      if (
        value.interactive.actionsExecuted !==
        value.stateGraph.safetyAudit.filter((entry) => entry.executed).length
      )
        issue(['interactive', 'actionsExecuted'], 'does not match executed safety audit entries');
      if (
        value.interactive.actionsBlocked !==
        value.stateGraph.safetyAudit.filter((entry) => !entry.executed).length
      )
        issue(['interactive', 'actionsBlocked'], 'does not match blocked safety audit entries');
      if (value.interactive.actionFailures !== value.stateGraph.failures.length)
        issue(['interactive', 'actionFailures'], 'does not match state graph failures');
    } else if (
      value.interactive.statesDiscovered !== 0 ||
      value.interactive.candidatesConsidered !== 0 ||
      value.interactive.actionsExecuted !== 0 ||
      value.interactive.actionsBlocked !== 0 ||
      value.interactive.actionFailures !== 0 ||
      value.interactive.duplicateStates !== 0
    ) {
      issue(['interactive'], 'non-interactive exploration must have zero interactive counters');
    }
  });

export class SavedExplorationValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super(`The saved exploration is invalid: ${validationErrors.join('; ')}`);
    this.name = 'SavedExplorationValidationError';
  }
}

export function parseSavedExploration(value: unknown): ExplorationResult {
  const parsed = explorationSchema.safeParse(value);
  if (!parsed.success) {
    throw new SavedExplorationValidationError(
      parsed.error.issues.slice(0, 40).map((entry) => {
        const path = entry.path.length === 0 ? 'exploration' : entry.path.join('.');
        return `${path}: ${entry.message}`;
      }),
    );
  }
  return parsed.data;
}
