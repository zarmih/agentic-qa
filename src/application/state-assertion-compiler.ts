import type { SafetyAuditEntry, StateNode } from '../domain/interaction.js';
import type { RegressionAssertion } from '../domain/regression.js';
import { RegressionLocatorCompiler } from './regression-locator-compiler.js';

function added(target: readonly string[], source: readonly string[]): readonly string[] {
  const existing = new Set(source);
  return target.filter((value) => value !== '' && !existing.has(value));
}

export class StateAssertionCompiler {
  private readonly locators = new RegressionLocatorCompiler();

  public compile(
    source: StateNode,
    target: StateNode,
    audit: readonly SafetyAuditEntry[],
    maximum: number,
  ): readonly RegressionAssertion[] {
    const assertions: RegressionAssertion[] = [];
    const dialog = added(target.metadata.dialogs, source.metadata.dialogs)[0];
    if (dialog !== undefined) {
      assertions.push({ kind: 'VISIBLE_ROLE', role: 'dialog', name: dialog });
    }
    const heading = added(target.metadata.headings, source.metadata.headings)[0];
    if (heading !== undefined && assertions.length === 0 && assertions.length < maximum) {
      assertions.push({ kind: 'VISIBLE_ROLE', role: 'heading', name: heading });
    }

    if (assertions.length === 0) {
      const sourceCandidates = audit
        .filter((entry) => entry.stateId === source.id)
        .map((entry) => entry.candidate);
      const targetCandidates = audit
        .filter((entry) => entry.stateId === target.id)
        .map((entry) => entry.candidate);
      const changed = targetCandidates.find((candidate) => {
        if (candidate.ariaSelected !== true && candidate.ariaExpanded !== true) return false;
        return sourceCandidates.some(
          (prior) =>
            prior.role === candidate.role &&
            prior.accessibleName === candidate.accessibleName &&
            (prior.ariaSelected !== candidate.ariaSelected ||
              prior.ariaExpanded !== candidate.ariaExpanded),
        );
      });
      if (changed !== undefined) {
        const locator = this.locators.compile(changed, target.id, audit);
        if (locator !== null && changed.ariaSelected === true) {
          assertions.push({
            kind: 'ATTRIBUTE',
            locator,
            attribute: 'aria-selected',
            value: 'true',
          });
        } else if (locator !== null && changed.ariaExpanded === true) {
          assertions.push({
            kind: 'ATTRIBUTE',
            locator,
            attribute: 'aria-expanded',
            value: 'true',
          });
        }
      }
    }
    if (assertions.length === 0 && source.url !== target.url) {
      assertions.push({ kind: 'URL', url: target.url });
    }
    return assertions.slice(0, maximum);
  }
}
