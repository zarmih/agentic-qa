import { createHash } from 'node:crypto';
import type { ExplorationEvidence } from './exploration.js';

export type ActionRisk = 'SAFE' | 'CAUTION' | 'DESTRUCTIVE' | 'UNKNOWN';
export type ActionOutcome =
  'NEW_STATE' | 'SAME_STATE' | 'NAVIGATION' | 'BLOCKED' | 'FAILED' | 'TIMEOUT';

export type LocatorDescriptor =
  | { readonly strategy: 'testId'; readonly value: string; readonly index: number }
  | {
      readonly strategy: 'role';
      readonly role: string;
      readonly name: string;
      readonly index: number;
    }
  | { readonly strategy: 'label'; readonly value: string; readonly index: number }
  | { readonly strategy: 'id'; readonly value: string; readonly index: number }
  | { readonly strategy: 'text'; readonly value: string; readonly index: number };

export interface InteractionCandidate {
  readonly id: string;
  readonly domOrder: number;
  readonly tag: string;
  readonly role: string;
  readonly accessibleName: string;
  readonly text: string;
  readonly href: string | null;
  readonly elementType: string | null;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  readonly ariaExpanded: boolean | null;
  readonly ariaSelected: boolean | null;
  readonly disabled: boolean;
  readonly visible: boolean;
  readonly formAssociated: boolean;
  readonly submitsForm: boolean;
  readonly fileUpload: boolean;
  readonly testId: string | null;
  readonly label: string | null;
  readonly stableId: string | null;
  readonly locator: LocatorDescriptor | null;
}

export interface LocatorUniqueness {
  readonly testIdCount: number;
  readonly roleNameIndex: number;
  readonly labelCount: number;
  readonly labelIndex: number;
  readonly idCount: number;
  readonly textCount: number;
  readonly textIndex: number;
}

export interface RiskAssessment {
  readonly risk: ActionRisk;
  readonly reason: string;
}

export interface StateObservation {
  readonly url: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly dialogs: readonly string[];
  readonly candidates: readonly InteractionCandidate[];
}

export interface StateMetadata {
  readonly title: string;
  readonly headings: readonly string[];
  readonly dialogs: readonly string[];
  readonly visibleControls: readonly string[];
}

export interface StateFingerprint {
  readonly hash: string;
  readonly metadata: StateMetadata;
}

export interface ActionDescriptor {
  readonly actionType: 'click';
  readonly identity: string;
  readonly locator: LocatorDescriptor;
  readonly role: string;
  readonly accessibleName: string;
  readonly visibleText: string;
}

export interface StateNode {
  readonly id: string;
  readonly pageId: string;
  readonly fingerprint: string;
  readonly url: string;
  readonly title: string;
  readonly depth: number;
  readonly discoveredFromActionId: string | null;
  readonly actionPath: readonly ActionDescriptor[];
  readonly metadata: StateMetadata;
  readonly screenshot: string;
}

export interface DialogEvidence {
  readonly type: string;
  readonly message: string;
  readonly disposition: 'dismissed';
  readonly timestamp: string;
}

export interface PopupEvidence {
  readonly url: string;
  readonly scope: 'same-origin' | 'external' | 'unknown';
  readonly disposition: 'registered-and-closed' | 'closed';
  readonly timestamp: string;
}

export interface DownloadEvidence {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly disposition: 'cancelled';
  readonly timestamp: string;
}

export interface InteractionEvidence {
  readonly browser: ExplorationEvidence;
  readonly dialogs: readonly DialogEvidence[];
  readonly popups: readonly PopupEvidence[];
  readonly downloads: readonly DownloadEvidence[];
}

export interface ActionEdge {
  readonly id: string;
  readonly sourceStateId: string;
  readonly targetStateId: string | null;
  readonly action: ActionDescriptor;
  readonly risk: 'SAFE';
  readonly urlBefore: string;
  readonly urlAfter: string;
  readonly urlChanged: boolean;
  readonly durationMs: number;
  readonly outcome: ActionOutcome;
  readonly reason: string | null;
  readonly evidence: InteractionEvidence;
}

export interface SafetyAuditEntry {
  readonly id: string;
  readonly stateId: string;
  readonly candidate: InteractionCandidate;
  readonly classification: ActionRisk;
  readonly executed: boolean;
  readonly reason: string;
  readonly actionId: string | null;
}

export interface ActionFailure {
  readonly actionId: string;
  readonly stateId: string;
  readonly candidateId: string;
  readonly reason: string;
  readonly timeout: boolean;
}

export interface StateGraph {
  readonly schemaVersion: '1.0';
  readonly enabled: boolean;
  readonly nodes: readonly StateNode[];
  readonly edges: readonly ActionEdge[];
  readonly safetyAudit: readonly SafetyAuditEntry[];
  readonly failures: readonly ActionFailure[];
}

export interface InteractiveSummary {
  readonly enabled: boolean;
  readonly statesDiscovered: number;
  readonly candidatesConsidered: number;
  readonly actionsExecuted: number;
  readonly actionsBlocked: number;
  readonly actionFailures: number;
  readonly duplicateStates: number;
  readonly limitReached: readonly string[];
}

export interface InteractiveLimits {
  readonly maxStates: number;
  readonly maxActionsPerState: number;
  readonly maxStateDepth: number;
}

function normalizedText(value: string, maximum = 160): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase().slice(0, maximum);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function semanticTokens(candidate: InteractionCandidate): readonly string[] {
  const values = [
    candidate.accessibleName,
    candidate.text,
    candidate.href ?? '',
    candidate.ariaLabel ?? '',
    candidate.title ?? '',
  ];
  return values.flatMap((value) => normalizedText(value, 300).split(/[^a-z0-9]+/)).filter(Boolean);
}

const DESTRUCTIVE = new Set([
  'buy',
  'checkout',
  'clear',
  'delete',
  'deploy',
  'destroy',
  'logout',
  'pay',
  'publish',
  'purchase',
  'remove',
  'reset',
  'send',
  'signout',
  'unsubscribe',
  'upload',
]);

const CAUTION = new Set(['create', 'edit', 'save', 'submit', 'update']);
const SAFE = new Set([
  'accordion',
  'back',
  'close',
  'collapse',
  'details',
  'dialog',
  'expand',
  'filters',
  'forward',
  'help',
  'hide',
  'menu',
  'next',
  'open',
  'overview',
  'previous',
  'reviews',
  'show',
  'tab',
  'toggle',
  'view',
]);

export class ActionRiskClassifier {
  public classify(candidate: InteractionCandidate): RiskAssessment {
    const tokens = semanticTokens(candidate);
    if (
      (tokens.includes('cancel') && tokens.includes('account')) ||
      (tokens.includes('sign') && tokens.includes('out')) ||
      (tokens.includes('submit') && tokens.includes('order'))
    ) {
      return { risk: 'DESTRUCTIVE', reason: 'destructive_semantic:compound' };
    }
    const destructive = tokens.find((token) => DESTRUCTIVE.has(token));
    if (destructive !== undefined) {
      return { risk: 'DESTRUCTIVE', reason: `destructive_semantic:${destructive}` };
    }
    if (candidate.href?.trim().toLowerCase().startsWith('javascript:') === true) {
      return { risk: 'DESTRUCTIVE', reason: 'javascript_url' };
    }
    if (candidate.fileUpload) return { risk: 'DESTRUCTIVE', reason: 'file_upload' };
    if (candidate.elementType === 'reset') {
      return { risk: 'DESTRUCTIVE', reason: 'form_reset' };
    }
    if (candidate.submitsForm) return { risk: 'CAUTION', reason: 'form_submission' };
    if (['input', 'select', 'textarea'].includes(candidate.tag)) {
      return { risk: 'CAUTION', reason: 'form_control_mutation' };
    }
    const caution = tokens.find((token) => CAUTION.has(token));
    if (caution !== undefined) return { risk: 'CAUTION', reason: `caution_semantic:${caution}` };
    if (candidate.locator === null) return { risk: 'UNKNOWN', reason: 'no_replayable_locator' };
    if (candidate.accessibleName === '' && candidate.text === '' && candidate.title === '') {
      return { risk: 'UNKNOWN', reason: 'insufficient_semantic_evidence' };
    }
    if (candidate.tag === 'a' && candidate.role !== 'tab' && candidate.role !== 'menuitem') {
      return { risk: 'CAUTION', reason: 'navigation_handled_by_page_explorer' };
    }
    if (candidate.role === 'tab' || candidate.role === 'menuitem') {
      return { risk: 'SAFE', reason: `safe_role:${candidate.role}` };
    }
    if (candidate.ariaExpanded !== null || candidate.tag === 'summary') {
      return { risk: 'SAFE', reason: 'disclosure_control' };
    }
    const safe = tokens.find((token) => SAFE.has(token));
    if (safe !== undefined && (candidate.tag === 'button' || candidate.role === 'button')) {
      return { risk: 'SAFE', reason: `safe_semantic:${safe}` };
    }
    return { risk: 'UNKNOWN', reason: 'insufficient_safe_evidence' };
  }
}

export function rankLocator(
  candidate: Omit<InteractionCandidate, 'locator'>,
  uniqueness: LocatorUniqueness,
): LocatorDescriptor | null {
  if (candidate.testId !== null && uniqueness.testIdCount === 1) {
    return { strategy: 'testId', value: candidate.testId, index: 0 };
  }
  if (candidate.role !== '' && candidate.accessibleName !== '') {
    return {
      strategy: 'role',
      role: candidate.role,
      name: candidate.accessibleName,
      index: uniqueness.roleNameIndex,
    };
  }
  if (candidate.label !== null && candidate.label !== '') {
    return { strategy: 'label', value: candidate.label, index: uniqueness.labelIndex };
  }
  if (
    candidate.stableId !== null &&
    uniqueness.idCount === 1 &&
    /^[a-zA-Z][a-zA-Z0-9:_-]{0,63}$/.test(candidate.stableId) &&
    !/\d{6,}/.test(candidate.stableId)
  ) {
    return { strategy: 'id', value: candidate.stableId, index: 0 };
  }
  if (candidate.text !== '' && uniqueness.textCount > 0) {
    return { strategy: 'text', value: candidate.text.slice(0, 120), index: uniqueness.textIndex };
  }
  return null;
}

export function actionIdentity(candidate: InteractionCandidate): string {
  return digest({
    actionType: 'click',
    locator: candidate.locator,
    role: candidate.role,
    accessibleName: normalizedText(candidate.accessibleName),
  }).slice(0, 24);
}

export function actionDescriptor(candidate: InteractionCandidate): ActionDescriptor | null {
  if (candidate.locator === null) return null;
  return {
    actionType: 'click',
    identity: actionIdentity(candidate),
    locator: candidate.locator,
    role: candidate.role,
    accessibleName: candidate.accessibleName,
    visibleText: candidate.text,
  };
}

export class StateFingerprintService {
  public create(observation: StateObservation): StateFingerprint {
    const url = new URL(observation.url);
    url.hash = '';
    const headings = observation.headings.slice(0, 30).map((value) => normalizedText(value));
    const dialogs = observation.dialogs.slice(0, 10).map((value) => normalizedText(value));
    const visibleControls = observation.candidates
      .filter((candidate) => candidate.visible)
      .slice(0, 100)
      .map((candidate) =>
        [
          candidate.tag,
          candidate.role,
          normalizedText(candidate.accessibleName),
          normalizedText(candidate.text),
          candidate.ariaExpanded,
          candidate.ariaSelected,
          candidate.disabled,
        ].join('|'),
      );
    const metadata: StateMetadata = {
      title: normalizedText(observation.title),
      headings,
      dialogs,
      visibleControls,
    };
    return {
      hash: digest({ url: url.href, ...metadata }),
      metadata,
    };
  }
}
