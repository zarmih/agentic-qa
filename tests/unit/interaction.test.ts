import { describe, expect, it } from 'vitest';
import {
  actionIdentity,
  ActionRiskClassifier,
  rankLocator,
  StateFingerprintService,
  type InteractionCandidate,
  type StateObservation,
} from '../../src/domain/interaction.js';

function candidate(overrides: Partial<InteractionCandidate> = {}): InteractionCandidate {
  return {
    id: 'candidate-001',
    domOrder: 0,
    tag: 'button',
    role: 'button',
    accessibleName: 'Open menu',
    text: 'Open menu',
    href: null,
    elementType: 'button',
    ariaLabel: null,
    title: null,
    ariaExpanded: false,
    ariaSelected: null,
    disabled: false,
    visible: true,
    formAssociated: false,
    submitsForm: false,
    fileUpload: false,
    testId: null,
    label: null,
    stableId: null,
    locator: { strategy: 'role', role: 'button', name: 'Open menu', index: 0 },
    ...overrides,
  };
}

describe('ActionRiskClassifier', () => {
  const classifier = new ActionRiskClassifier();

  it.each(['Delete account', 'Buy now', 'Checkout', 'Publish', 'Reset database', 'Logout'])(
    'blocks destructive semantic action %s',
    (name) => {
      expect(classifier.classify(candidate({ accessibleName: name, text: '' })).risk).toBe(
        'DESTRUCTIVE',
      );
    },
  );

  it('uses accessible names for icon-only destructive controls', () => {
    expect(
      classifier.classify(
        candidate({ accessibleName: 'Delete item', text: '', ariaLabel: 'Delete item' }),
      ),
    ).toMatchObject({ risk: 'DESTRUCTIVE', reason: 'destructive_semantic:delete' });
  });

  it('uses href semantics and rejects javascript URLs', () => {
    expect(classifier.classify(candidate({ href: '/account/remove' })).risk).toBe('DESTRUCTIVE');
    expect(classifier.classify(candidate({ href: 'javascript:run()' })).risk).toBe('DESTRUCTIVE');
  });

  it('protects form submissions and mutable form controls', () => {
    expect(classifier.classify(candidate({ submitsForm: true })).risk).toBe('CAUTION');
    expect(classifier.classify(candidate({ tag: 'select', role: 'combobox' })).risk).toBe(
      'CAUTION',
    );
    expect(classifier.classify(candidate({ tag: 'input', fileUpload: true })).risk).toBe(
      'DESTRUCTIVE',
    );
    expect(classifier.classify(candidate({ elementType: 'reset' }))).toMatchObject({
      risk: 'DESTRUCTIVE',
      reason: 'form_reset',
    });
  });

  it('allows explicit disclosure and tab semantics only', () => {
    expect(classifier.classify(candidate()).risk).toBe('SAFE');
    expect(
      classifier.classify(
        candidate({ role: 'tab', accessibleName: 'Specifications', ariaExpanded: null }),
      ).risk,
    ).toBe('SAFE');
    expect(
      classifier.classify(
        candidate({ accessibleName: '', text: '', title: null, ariaExpanded: null }),
      ).risk,
    ).toBe('UNKNOWN');
  });
});

describe('locator ranking and action identity', () => {
  it('prefers unique test IDs over semantic and fallback locators', () => {
    const input = { ...candidate({ testId: 'menu-toggle' }) };
    expect(
      rankLocator(input, {
        testIdCount: 1,
        roleNameIndex: 0,
        labelCount: 0,
        labelIndex: -1,
        idCount: 0,
        textCount: 1,
        textIndex: 0,
      }),
    ).toEqual({ strategy: 'testId', value: 'menu-toggle', index: 0 });
  });

  it('uses deterministic semantic identity without DOM-order noise', () => {
    const first = candidate();
    expect(actionIdentity(first)).toBe(
      actionIdentity({ ...first, id: 'candidate-099', domOrder: 98 }),
    );
    expect(actionIdentity(first)).not.toBe(
      actionIdentity(
        candidate({
          accessibleName: 'Help',
          text: 'Help',
          locator: { strategy: 'role', role: 'button', name: 'Help', index: 0 },
        }),
      ),
    );
  });
});

describe('StateFingerprintService', () => {
  const service = new StateFingerprintService();
  const observation = (
    control: InteractionCandidate,
    url = 'https://app.test/page#fragment',
  ): StateObservation => ({
    url,
    title: 'Example',
    headings: ['Dashboard'],
    dialogs: [],
    candidates: [control],
  });

  it('ignores fragment, generated IDs, test IDs, and locator details', () => {
    const first = candidate({ stableId: 'generated-1234567', testId: 'run-a' });
    const second = candidate({
      stableId: 'generated-9876543',
      testId: 'run-b',
      locator: { strategy: 'id', value: 'different', index: 0 },
    });
    expect(service.create(observation(first)).hash).toBe(
      service.create(observation(second, 'https://app.test/page#other')).hash,
    );
  });

  it('detects meaningful expanded, dialog, heading, and query changes', () => {
    const baseline = service.create(observation(candidate())).hash;
    expect(service.create(observation(candidate({ ariaExpanded: true }))).hash).not.toBe(baseline);
    expect(service.create({ ...observation(candidate()), dialogs: ['Help dialog'] }).hash).not.toBe(
      baseline,
    );
    expect(service.create({ ...observation(candidate()), headings: ['Changed'] }).hash).not.toBe(
      baseline,
    );
    expect(service.create(observation(candidate(), 'https://app.test/page?q=1')).hash).not.toBe(
      baseline,
    );
  });

  it('bounds human-readable fingerprint metadata', () => {
    const controls = Array.from({ length: 150 }, (_, index) =>
      candidate({ id: `candidate-${String(index)}`, text: `Control ${String(index)}` }),
    );
    const result = service.create({ ...observation(candidate()), candidates: controls });
    expect(result.metadata.visibleControls).toHaveLength(100);
  });
});
