import { describe, expect, it } from 'vitest';
import { ExecutionIntegrityService } from '../../src/application/execution-integrity.js';
import { parseSavedExecution } from '../../src/application/execution-schema.js';
import { VerificationSourceValidator } from '../../src/application/verification-source-validator.js';
import type { ExecutionRun } from '../../src/domain/execution.js';
import { verificationExecutionFixture } from '../fixtures/verification-fixtures.js';

function resign(execution: ExecutionRun): ExecutionRun {
  const { executionIntegrity, ...unsigned } = execution;
  void executionIntegrity;
  return { ...unsigned, executionIntegrity: new ExecutionIntegrityService().create(unsigned) };
}

describe('VerificationSourceValidator', () => {
  it('accepts a schema 1.1 execution bound to intact source artifacts', () => {
    expect(
      new VerificationSourceValidator().validate(verificationExecutionFixture()),
    ).toBeDefined();
  });

  it('rejects a modified result payload before trusting an injected FAIL', () => {
    const loaded = verificationExecutionFixture('PASS');
    const scenario = loaded.execution.scenarios[0];
    if (scenario === undefined) throw new Error('Fixture scenario is missing.');
    const tampered = {
      ...loaded,
      execution: {
        ...loaded.execution,
        scenarios: [{ ...scenario, status: 'FAIL' as const }],
      },
    };
    expect(() => new VerificationSourceValidator().validate(tampered)).toThrow(/payload digest/);
  });

  it.each(['source-run', 'scenario-status', 'evidence-reference', 'graph-reference'] as const)(
    'rejects a re-signed but semantically tampered %s',
    (kind) => {
      const loaded = verificationExecutionFixture();
      const scenario = loaded.execution.scenarios[0];
      const step = scenario?.steps[0];
      if (scenario === undefined || step === undefined)
        throw new Error('Fixture result is missing.');
      let changed: ExecutionRun;
      if (kind === 'source-run') {
        changed = { ...loaded.execution, sourceRunId: 'forged-run' };
      } else if (kind === 'scenario-status') {
        changed = {
          ...loaded.execution,
          scenarios: [{ ...scenario, status: 'PASS', failureCode: null }],
        };
      } else if (kind === 'evidence-reference') {
        changed = {
          ...loaded.execution,
          scenarios: [
            {
              ...scenario,
              evidenceReproduction: [
                {
                  sourceEvidenceRef: 'forged-evidence',
                  status: 'REPRODUCED',
                  executionEvidenceRefs: [],
                },
              ],
            },
          ],
        };
      } else {
        changed = {
          ...loaded.execution,
          scenarios: [
            {
              ...scenario,
              steps: [
                {
                  ...step,
                  requestedTarget: { ...step.requestedTarget, actionId: 'action-forged' },
                },
              ],
            },
          ],
        };
      }
      expect(() =>
        new VerificationSourceValidator().validate({ ...loaded, execution: resign(changed) }),
      ).toThrow();
    },
  );

  it('rejects legacy executions and arbitrary unrecognized fields', () => {
    expect(() => parseSavedExecution({ schemaVersion: '1.0' })).toThrow(/run the plan again/);
    const raw = structuredClone(verificationExecutionFixture().execution) as unknown as Record<
      string,
      unknown
    >;
    raw.fakeFailure = { selector: '#delete', status: 'FAIL' };
    expect(() => parseSavedExecution(raw)).toThrow(/unrecognized/i);
  });
});
