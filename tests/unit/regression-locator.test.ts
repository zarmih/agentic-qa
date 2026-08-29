import { describe, expect, it } from 'vitest';
import { RegressionLocatorCompiler } from '../../src/application/regression-locator-compiler.js';
import type {
  InteractionCandidate,
  LocatorDescriptor,
  SafetyAuditEntry,
} from '../../src/domain/interaction.js';
import { renderLocator } from '../../src/reporting/regression-typescript.js';

function candidate(
  locator: LocatorDescriptor,
  values: Partial<InteractionCandidate> = {},
): InteractionCandidate {
  return {
    id: 'candidate-001',
    domOrder: 0,
    tag: 'button',
    role: 'button',
    accessibleName: 'Open details',
    text: 'Open details',
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
    locator,
    ...values,
  };
}

function audit(value: InteractionCandidate, id = 'audit-001'): SafetyAuditEntry {
  return {
    id,
    stateId: 'state-001',
    candidate: value,
    classification: 'SAFE',
    executed: true,
    reason: 'fixture',
    actionId: 'action-001',
  };
}

describe('RegressionLocatorCompiler', () => {
  it.each([
    [
      candidate({ strategy: 'testId', value: 'details', index: 0 }, { testId: 'details' }),
      'page.getByTestId("details")',
    ],
    [
      candidate({ strategy: 'role', role: 'button', name: 'Open details', index: 0 }),
      'page.getByRole("button", { name: "Open details", exact: true })',
    ],
    [
      candidate({ strategy: 'label', value: 'Open details', index: 0 }, { label: 'Open details' }),
      'page.getByLabel("Open details", { exact: true })',
    ],
    [
      candidate({ strategy: 'id', value: 'details:open', index: 0 }, { stableId: 'details:open' }),
      'page.locator("[id=\\"details:open\\"]")',
    ],
    [
      candidate({ strategy: 'text', value: 'Open details', index: 0 }),
      'page.getByText("Open details", { exact: true })',
    ],
  ] as const)('renders a unique graph-owned semantic locator', (input, expected) => {
    const compiled = new RegressionLocatorCompiler().compile(input, 'state-001', [audit(input)]);
    if (compiled === null) throw new Error('Expected locator compilation to succeed.');
    expect(renderLocator(compiled)).toBe(expected);
  });

  it('rejects indexed or ambiguous locators instead of emitting nth selectors', () => {
    const indexed = candidate({ strategy: 'role', role: 'button', name: 'Open details', index: 1 });
    expect(
      new RegressionLocatorCompiler().compile(indexed, 'state-001', [audit(indexed)]),
    ).toBeNull();
    const unique = candidate({ strategy: 'role', role: 'button', name: 'Open details', index: 0 });
    const duplicate = { ...unique, id: 'candidate-002', domOrder: 1 };
    expect(
      new RegressionLocatorCompiler().compile(unique, 'state-001', [
        audit(unique),
        audit(duplicate, 'audit-002'),
      ]),
    ).toBeNull();
  });

  it('reapplies form and destructive safety before compiling a locator', () => {
    const form = candidate(
      { strategy: 'role', role: 'button', name: 'Submit', index: 0 },
      { accessibleName: 'Submit', text: 'Submit', submitsForm: true },
    );
    expect(new RegressionLocatorCompiler().compile(form, 'state-001', [audit(form)])).toBeNull();
    const danger = candidate(
      { strategy: 'role', role: 'button', name: 'Delete account', index: 0 },
      { accessibleName: 'Delete account', text: 'Delete account' },
    );
    expect(
      new RegressionLocatorCompiler().compile(danger, 'state-001', [audit(danger)]),
    ).toBeNull();
  });
});
