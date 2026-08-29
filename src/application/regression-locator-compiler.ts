import {
  ActionRiskClassifier,
  type InteractionCandidate,
  type LocatorDescriptor,
  type SafetyAuditEntry,
} from '../domain/interaction.js';
import type { RegressionLocator } from '../domain/regression.js';

const PLAYWRIGHT_ROLES = new Set([
  'alert',
  'alertdialog',
  'button',
  'checkbox',
  'combobox',
  'dialog',
  'heading',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'region',
  'searchbox',
  'switch',
  'tab',
  'textbox',
]);

function sameLocator(left: LocatorDescriptor, right: LocatorDescriptor): boolean {
  if (left.strategy !== right.strategy) return false;
  switch (left.strategy) {
    case 'testId':
    case 'label':
    case 'id':
    case 'text':
      return left.value === (right as typeof left).value;
    case 'role':
      return left.role === (right as typeof left).role && left.name === (right as typeof left).name;
  }
}

export class RegressionLocatorCompiler {
  private readonly classifier = new ActionRiskClassifier();

  public compile(
    candidate: InteractionCandidate,
    stateId: string,
    audit: readonly SafetyAuditEntry[],
  ): RegressionLocator | null {
    const locator = candidate.locator;
    if (
      locator?.index !== 0 ||
      !candidate.visible ||
      candidate.disabled ||
      candidate.submitsForm ||
      candidate.fileUpload ||
      candidate.elementType === 'reset' ||
      this.classifier.classify(candidate).risk !== 'SAFE'
    ) {
      return null;
    }
    const matches = audit.filter(
      (entry) =>
        entry.stateId === stateId &&
        entry.candidate.visible &&
        entry.candidate.locator !== null &&
        sameLocator(entry.candidate.locator, locator),
    );
    if (matches.length !== 1) return null;
    switch (locator.strategy) {
      case 'testId':
        return candidate.testId === locator.value
          ? { strategy: 'testId', value: locator.value }
          : null;
      case 'role':
        return PLAYWRIGHT_ROLES.has(locator.role) &&
          candidate.role === locator.role &&
          candidate.accessibleName === locator.name
          ? { strategy: 'role', role: locator.role, name: locator.name }
          : null;
      case 'label':
        return candidate.label === locator.value
          ? { strategy: 'label', value: locator.value }
          : null;
      case 'id':
        return candidate.stableId === locator.value
          ? { strategy: 'id', value: locator.value }
          : null;
      case 'text':
        return candidate.text.slice(0, 120) === locator.value
          ? { strategy: 'text', value: locator.value }
          : null;
    }
  }
}
