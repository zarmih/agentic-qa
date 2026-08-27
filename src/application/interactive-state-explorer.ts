import type { PageNode } from '../domain/exploration.js';
import {
  actionDescriptor,
  ActionRiskClassifier,
  StateFingerprintService,
  type ActionEdge,
  type ActionFailure,
  type InteractiveLimits,
  type InteractionEvidence,
  type InteractiveSummary,
  type SafetyAuditEntry,
  type StateGraph,
  type StateNode,
} from '../domain/interaction.js';
import type { ExplorationArtifactStore, ExplorationBrowserSession } from './ports.js';

interface QueueState {
  readonly node: StateNode;
  readonly baseUrl: string;
  readonly candidates: Awaited<
    ReturnType<ExplorationBrowserSession['captureState']>
  >['observation']['candidates'];
}

export interface InteractiveStateExplorerOptions extends InteractiveLimits {
  readonly navigationTimeoutMs: number;
  readonly canNavigate: (url: string) => boolean;
  readonly onDiscoveredNavigation: (url: string, sourcePage: PageNode) => void;
}

const EMPTY_GRAPH: StateGraph = {
  schemaVersion: '1.0',
  enabled: true,
  nodes: [],
  edges: [],
  safetyAudit: [],
  failures: [],
};
const MAX_INTERACTION_EVIDENCE_ENTRIES = 1_000;

export class InteractiveStateExplorer {
  private readonly fingerprints = new StateFingerprintService();
  private readonly classifier = new ActionRiskClassifier();
  private readonly nodes: StateNode[] = [];
  private readonly edges: ActionEdge[] = [];
  private readonly audit: SafetyAuditEntry[] = [];
  private readonly failures: ActionFailure[] = [];
  private readonly statesByFingerprint = new Map<string, StateNode>();
  private readonly visitedActions = new Set<string>();
  private readonly limitsReached = new Set<string>();
  private duplicateStates = 0;
  private candidatesConsidered = 0;
  private actionsExecuted = 0;
  private actionsBlocked = 0;
  private evidenceEntries = 0;

  public constructor(
    private readonly session: ExplorationBrowserSession,
    private readonly artifacts: ExplorationArtifactStore,
    private readonly runId: string,
    private readonly options: InteractiveStateExplorerOptions,
  ) {}

  public async explorePage(pageNode: PageNode): Promise<readonly string[]> {
    if (this.nodes.length >= this.options.maxStates) {
      this.limitsReached.add('maxStates');
      return [];
    }
    const warnings: string[] = [];
    let initialCapture;
    try {
      initialCapture = await this.session.captureState({
        url: pageNode.finalUrl,
        navigationTimeoutMs: this.options.navigationTimeoutMs,
        canNavigate: this.options.canNavigate,
      });
    } catch (error) {
      warnings.push(
        `Interactive state capture failed for ${pageNode.finalUrl}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
      return warnings;
    }
    if (initialCapture.truncated) {
      warnings.push(`Interactive candidates were truncated for ${pageNode.finalUrl}.`);
    }

    const initialFingerprint = this.fingerprints.create(initialCapture.observation);
    if (this.statesByFingerprint.has(initialFingerprint.hash)) return warnings;
    const initialNode = await this.addState({
      pageId: pageNode.id,
      url: initialCapture.observation.url,
      title: initialCapture.observation.title,
      depth: 0,
      discoveredFromActionId: null,
      actionPath: [],
      fingerprint: initialFingerprint.hash,
      metadata: initialFingerprint.metadata,
      screenshot: initialCapture.screenshot,
    });
    const queue: QueueState[] = [
      {
        node: initialNode,
        baseUrl: pageNode.finalUrl,
        candidates: initialCapture.observation.candidates,
      },
    ];

    while (queue.length > 0) {
      const state = queue.shift();
      if (state === undefined) break;
      let actionsFromState = 0;

      for (const candidate of state.candidates) {
        this.candidatesConsidered += 1;
        const assessment = this.classifier.classify(candidate);
        const descriptor = actionDescriptor(candidate);
        const actionKey =
          descriptor === null ? null : `${state.node.fingerprint}:${descriptor.identity}`;
        let blockReason: string | null = null;

        if (!candidate.visible) blockReason = 'not_visible';
        else if (candidate.disabled) blockReason = 'disabled';
        else if (candidate.submitsForm) blockReason = 'form_submission';
        else if (candidate.fileUpload) blockReason = 'file_upload';
        else if (assessment.risk !== 'SAFE') blockReason = assessment.reason;
        else if (candidate.href !== null && !this.hrefAllowed(candidate.href, state.node.url)) {
          blockReason = 'out_of_scope_target';
        } else if (descriptor === null) blockReason = 'no_replayable_locator';
        else if (state.node.depth >= this.options.maxStateDepth) {
          blockReason = 'max_state_depth';
          this.limitsReached.add('maxStateDepth');
        } else if (actionsFromState >= this.options.maxActionsPerState) {
          blockReason = 'max_actions_per_state';
          this.limitsReached.add('maxActionsPerState');
        } else if (this.nodes.length >= this.options.maxStates) {
          blockReason = 'max_states';
          this.limitsReached.add('maxStates');
        } else if (actionKey !== null && this.visitedActions.has(actionKey)) {
          blockReason = 'already_attempted_from_state';
        }

        if (blockReason !== null || descriptor === null || actionKey === null) {
          this.actionsBlocked += 1;
          this.audit.push({
            id: this.nextAuditId(),
            stateId: state.node.id,
            candidate,
            classification: assessment.risk,
            executed: false,
            reason: blockReason ?? assessment.reason,
            actionId: null,
          });
          continue;
        }

        const actionId = this.nextActionId();
        this.visitedActions.add(actionKey);
        actionsFromState += 1;
        this.actionsExecuted += 1;
        this.audit.push({
          id: this.nextAuditId(),
          stateId: state.node.id,
          candidate,
          classification: 'SAFE',
          executed: true,
          reason: assessment.reason,
          actionId,
        });

        const capture = await this.session.performInteraction({
          url: state.baseUrl,
          navigationTimeoutMs: this.options.navigationTimeoutMs,
          actionTimeoutMs: Math.max(500, Math.min(3_000, this.options.navigationTimeoutMs)),
          canNavigate: this.options.canNavigate,
          replayPath: state.node.actionPath,
          expectedSourceFingerprint: state.node.fingerprint,
          candidate,
        });
        const edgeEvidence = this.boundEvidence(capture.evidence);
        for (const discoveredUrl of capture.discoveredUrls) {
          this.options.onDiscoveredNavigation(discoveredUrl, pageNode);
        }

        if (capture.status !== 'COMPLETED' || capture.result === null) {
          const reason = capture.reason ?? 'Interaction did not complete.';
          this.failures.push({
            actionId,
            stateId: state.node.id,
            candidateId: candidate.id,
            reason,
            timeout: capture.status === 'TIMEOUT',
          });
          this.edges.push({
            id: actionId,
            sourceStateId: state.node.id,
            targetStateId: null,
            action: descriptor,
            risk: 'SAFE',
            urlBefore: capture.sourceUrl,
            urlAfter: capture.sourceUrl,
            urlChanged: false,
            durationMs: capture.durationMs,
            outcome: capture.status === 'COMPLETED' ? 'FAILED' : capture.status,
            reason,
            evidence: edgeEvidence,
          });
          continue;
        }

        const resultFingerprint = this.fingerprints.create(capture.result.observation);
        let targetNode = this.statesByFingerprint.get(resultFingerprint.hash) ?? null;
        const isDuplicate = targetNode !== null;
        if (isDuplicate) this.duplicateStates += 1;
        if (targetNode === null) {
          targetNode = await this.addState({
            pageId: pageNode.id,
            url: capture.result.observation.url,
            title: capture.result.observation.title,
            depth: state.node.depth + 1,
            discoveredFromActionId: actionId,
            actionPath: [...state.node.actionPath, descriptor],
            fingerprint: resultFingerprint.hash,
            metadata: resultFingerprint.metadata,
            screenshot: capture.result.screenshot,
          });
          queue.push({
            node: targetNode,
            baseUrl: state.baseUrl,
            candidates: capture.result.observation.candidates,
          });
        }

        const urlChanged = capture.sourceUrl !== capture.result.observation.url;
        if (urlChanged) {
          this.options.onDiscoveredNavigation(capture.result.observation.url, pageNode);
        }
        this.edges.push({
          id: actionId,
          sourceStateId: state.node.id,
          targetStateId: targetNode.id,
          action: descriptor,
          risk: 'SAFE',
          urlBefore: capture.sourceUrl,
          urlAfter: capture.result.observation.url,
          urlChanged,
          durationMs: capture.durationMs,
          outcome: urlChanged ? 'NAVIGATION' : isDuplicate ? 'SAME_STATE' : 'NEW_STATE',
          reason: null,
          evidence: edgeEvidence,
        });
      }
    }
    return warnings;
  }

  public graph(): StateGraph {
    return {
      ...EMPTY_GRAPH,
      nodes: this.nodes,
      edges: this.edges,
      safetyAudit: this.audit,
      failures: this.failures,
    };
  }

  public summary(): InteractiveSummary {
    return {
      enabled: true,
      statesDiscovered: this.nodes.length,
      candidatesConsidered: this.candidatesConsidered,
      actionsExecuted: this.actionsExecuted,
      actionsBlocked: this.actionsBlocked,
      actionFailures: this.failures.length,
      duplicateStates: this.duplicateStates,
      limitReached: [...this.limitsReached].sort(),
    };
  }

  private async addState(
    input: Omit<StateNode, 'id' | 'screenshot'> & { readonly screenshot: Buffer },
  ): Promise<StateNode> {
    const id = `state-${String(this.nodes.length + 1).padStart(3, '0')}`;
    const filename = `${id}.png`;
    await this.artifacts.saveStateScreenshot(this.runId, filename, input.screenshot);
    const node: StateNode = { ...input, id, screenshot: `states/${filename}` };
    this.nodes.push(node);
    this.statesByFingerprint.set(node.fingerprint, node);
    return node;
  }

  private nextActionId(): string {
    return `action-${String(this.edges.length + 1).padStart(4, '0')}`;
  }

  private nextAuditId(): string {
    return `audit-${String(this.audit.length + 1).padStart(5, '0')}`;
  }

  private boundEvidence(evidence: InteractionEvidence): InteractionEvidence {
    const take = <Entry>(entries: readonly Entry[]): readonly Entry[] => {
      const remaining = MAX_INTERACTION_EVIDENCE_ENTRIES - this.evidenceEntries;
      if (remaining <= 0) {
        if (entries.length > 0) this.limitsReached.add('evidence');
        return [];
      }
      const selected = entries.slice(0, remaining);
      this.evidenceEntries += selected.length;
      if (selected.length < entries.length) this.limitsReached.add('evidence');
      return selected;
    };
    return {
      browser: {
        console: take(evidence.browser.console),
        pageErrors: take(evidence.browser.pageErrors),
        failedRequests: take(evidence.browser.failedRequests),
        httpErrors: take(evidence.browser.httpErrors),
      },
      dialogs: take(evidence.dialogs),
      popups: take(evidence.popups),
      downloads: take(evidence.downloads),
    };
  }

  private hrefAllowed(href: string, baseUrl: string): boolean {
    try {
      return this.options.canNavigate(new URL(href, baseUrl).href);
    } catch {
      return false;
    }
  }
}
