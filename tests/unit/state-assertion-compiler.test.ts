import { describe, expect, it } from 'vitest';
import { StateAssertionCompiler } from '../../src/application/state-assertion-compiler.js';
import type {
  InteractionCandidate,
  SafetyAuditEntry,
  StateNode,
} from '../../src/domain/interaction.js';

function state(id: string, values: Partial<StateNode> = {}): StateNode {
  return {
    id,
    pageId: 'page-001',
    fingerprint: id === 'source' ? 'a'.repeat(64) : 'b'.repeat(64),
    url: 'https://app.test/',
    title: 'Fixture',
    depth: id === 'source' ? 0 : 1,
    discoveredFromActionId: id === 'source' ? null : 'action-001',
    actionPath: [],
    metadata: { title: 'fixture', headings: ['fixture'], dialogs: [], visibleControls: [] },
    screenshot: `states/${id}.png`,
    ...values,
  };
}

function candidate(
  stateId: string,
  name: string,
  values: Partial<InteractionCandidate>,
): SafetyAuditEntry {
  const item: InteractionCandidate = {
    id: `candidate-${stateId}`,
    domOrder: 0,
    tag: 'button',
    role: 'button',
    accessibleName: name,
    text: name,
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
    locator: { strategy: 'role', role: 'button', name, index: 0 },
    ...values,
  };
  return {
    id: `audit-${stateId}`,
    stateId,
    candidate: item,
    classification: 'SAFE',
    executed: false,
    reason: 'fixture',
    actionId: null,
  };
}

describe('StateAssertionCompiler', () => {
  const compiler = new StateAssertionCompiler();

  it('prefers one positive dialog or heading discriminator', () => {
    expect(
      compiler.compile(
        state('source'),
        state('target', {
          metadata: {
            title: 'fixture',
            headings: ['fixture', 'help content'],
            dialogs: ['help'],
            visibleControls: [],
          },
        }),
        [],
        5,
      ),
    ).toEqual([{ kind: 'VISIBLE_ROLE', role: 'dialog', name: 'help' }]);
  });

  it('compiles selected-tab and expanded-control assertions from observed semantics', () => {
    const sourceTab = candidate('source', 'Details', {
      role: 'tab',
      ariaSelected: false,
      locator: { strategy: 'role', role: 'tab', name: 'Details', index: 0 },
    });
    const targetTab = candidate('target', 'Details', {
      role: 'tab',
      ariaSelected: true,
      locator: { strategy: 'role', role: 'tab', name: 'Details', index: 0 },
    });
    expect(compiler.compile(state('source'), state('target'), [sourceTab, targetTab], 5)).toEqual([
      {
        kind: 'ATTRIBUTE',
        locator: { strategy: 'role', role: 'tab', name: 'Details' },
        attribute: 'aria-selected',
        value: 'true',
      },
    ]);
    const sourceDisclosure = candidate('source', 'Specifications', { ariaExpanded: false });
    const targetDisclosure = candidate('target', 'Specifications', { ariaExpanded: true });
    expect(
      compiler.compile(state('source'), state('target'), [sourceDisclosure, targetDisclosure], 5),
    ).toEqual([
      {
        kind: 'ATTRIBUTE',
        locator: { strategy: 'role', role: 'button', name: 'Specifications' },
        attribute: 'aria-expanded',
        value: 'true',
      },
    ]);
  });

  it('uses graph URL as a final meaningful fallback and otherwise refuses opaque hashes', () => {
    expect(
      compiler.compile(
        state('source'),
        state('target', { url: 'https://app.test/products?view=details' }),
        [],
        5,
      ),
    ).toEqual([{ kind: 'URL', url: 'https://app.test/products?view=details' }]);
    expect(compiler.compile(state('source'), state('target'), [], 5)).toEqual([]);
  });
});
