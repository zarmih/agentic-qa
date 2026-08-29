import { describe, expect, it } from 'vitest';
import { RegressionSourceValidator } from '../../src/application/regression-source-validator.js';
import {
  FindingsIntegrityService,
  VerificationIntegrityService,
  findingsPayload,
  verificationPayload,
} from '../../src/application/verification-integrity.js';
import {
  parseSavedFindings,
  parseSavedVerification,
} from '../../src/application/verification-schema.js';
import type { LoadedRegressionSource } from '../../src/application/regression-ports.js';
import { regressionSourceFixture } from '../fixtures/regression-fixtures.js';

describe('RegressionSourceValidator', () => {
  const validator = new RegressionSourceValidator();

  it('accepts integrity-bound findings whose verdict is deterministically reproducible', () => {
    expect(validator.validate(regressionSourceFixture())).toBeDefined();
  });

  it('rejects a manually promoted verdict before generation', () => {
    const loaded = regressionSourceFixture('not-reproduced');
    const finding = loaded.findings.findings[0];
    if (finding === undefined) throw new Error('Fixture finding is missing.');
    const tampered: LoadedRegressionSource = {
      ...loaded,
      findings: {
        ...loaded.findings,
        findings: [{ ...finding, verdict: 'CONFIRMED_DEFECT' }],
      },
    };
    expect(() => validator.validate(tampered)).toThrow(/findings\.json payload digest/);
  });

  it('rejects re-signed findings when deterministic verification policy disagrees', () => {
    const loaded = regressionSourceFixture('not-reproduced');
    const finding = loaded.findings.findings[0];
    if (finding === undefined) throw new Error('Fixture finding is missing.');
    const changedFinding = { ...finding, verdict: 'CONFIRMED_DEFECT' as const };
    const unsignedVerification = {
      ...verificationPayload(loaded.verification),
      findings: [changedFinding],
    };
    const verification = {
      ...unsignedVerification,
      verificationIntegrity: new VerificationIntegrityService().create(unsignedVerification),
    };
    const unsignedFindings = {
      ...findingsPayload(loaded.findings),
      findings: [changedFinding],
      sourceIntegrity: {
        ...loaded.findings.sourceIntegrity,
        verificationDigest: new VerificationIntegrityService().digest(verification),
      },
    };
    const findings = {
      ...unsignedFindings,
      findingsIntegrity: new FindingsIntegrityService().create(unsignedFindings),
    };
    expect(() => validator.validate({ ...loaded, verification, findings })).toThrow(
      /deterministic verification policy/,
    );
  });

  it('rejects legacy and schema-extension injection artifacts', () => {
    expect(() => parseSavedFindings({ schemaVersion: '1.0' })).toThrow(/run verify again/);
    expect(() => parseSavedVerification({ schemaVersion: '1.0' })).toThrow(/run verify again/);
    const raw = structuredClone(regressionSourceFixture().findings) as unknown as Record<
      string,
      unknown
    >;
    raw.selector = '#delete-account';
    expect(() => parseSavedFindings(raw)).toThrow(/unrecognized/i);
  });
});
