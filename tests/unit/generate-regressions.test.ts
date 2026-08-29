import { describe, expect, it } from 'vitest';
import {
  GenerateRegressions,
  regressionFileDigest,
} from '../../src/application/generate-regressions.js';
import type {
  RegressionArtifactLocations,
  RegressionArtifactWriter,
  RenderedRegressionTest,
} from '../../src/application/regression-ports.js';
import type { RegressionManifest } from '../../src/domain/regression.js';
import { TypeScriptRegressionValidator } from '../../src/infrastructure/typescript-regression-validator.js';
import { PrettierRegressionFormatter } from '../../src/infrastructure/prettier-regression-formatter.js';
import {
  RegressionManifestIntegrityService,
  regressionManifestPayload,
} from '../../src/application/regression-integrity.js';
import { parseSavedRegressionManifest } from '../../src/application/regression-schema.js';
import { regressionSourceFixture } from '../fixtures/regression-fixtures.js';

class MemoryWriter implements RegressionArtifactWriter {
  public manifest: RegressionManifest | null = null;
  public readme = '';
  public tests: readonly RenderedRegressionTest[] = [];

  public prepareGeneration(): Promise<RegressionArtifactLocations> {
    return Promise.resolve({
      directory: '/fixture/regressions/generated',
      testsDirectory: '/fixture/regressions/generated/tests',
    });
  }

  public saveGeneration(
    _locations: RegressionArtifactLocations,
    manifest: RegressionManifest,
    readme: string,
    tests: readonly RenderedRegressionTest[],
  ): Promise<void> {
    this.manifest = manifest;
    this.readme = readme;
    this.tests = tests;
    return Promise.resolve();
  }
}

const clock = { now: () => new Date('2026-08-29T01:02:03.000Z') };
const ids = { next: () => 'fixture-id' };

async function generate(
  outcome: 'confirmed' | 'probable' | 'flaky' | 'not-reproduced',
  includeFlaky = false,
) {
  const loaded = regressionSourceFixture(outcome);
  const writer = new MemoryWriter();
  const useCase = new GenerateRegressions(
    { loadRegressionSource: () => Promise.resolve(loaded) },
    writer,
    new PrettierRegressionFormatter(),
    new TypeScriptRegressionValidator(),
    ids,
    clock,
  );
  const result = await useCase.execute(loaded.findingsFile, {
    includeFlaky,
    maxGeneratedTests: 20,
    maxStepsPerTest: 12,
    maxAssertionsPerTest: 5,
  });
  return { result, writer };
}

describe('GenerateRegressions', () => {
  it('writes an active, compiled, digest-bound spec for a confirmed finding', async () => {
    const { result, writer } = await generate('confirmed');
    expect(result.exitCode).toBe(0);
    expect(result.manifest.summary.generated).toBe(1);
    expect(result.manifest.summary.totalGeneratedLines).toBeGreaterThan(10);
    expect(writer.tests).toHaveLength(1);
    expect(writer.tests[0]?.source).toContain("import { expect, test } from '@playwright/test';");
    expect(writer.tests[0]?.source).toContain("test('DEF-");
    expect(writer.tests[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.tests[0]?.fileDigest).toBe(writer.tests[0]?.digest);
    expect(regressionFileDigest(`${writer.tests[0]?.source ?? ''}// edited`)).not.toBe(
      result.manifest.tests[0]?.fileDigest,
    );
    expect(result.manifest.sourceIntegrity.findingsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.schemaVersion).toBe('1.1');
    expect(new RegressionManifestIntegrityService().validate(result.manifest)).toBe(true);
    expect(parseSavedRegressionManifest(result.manifest)).toEqual(result.manifest);
    expect(writer.readme).toContain('Review every file');
  });

  it('detects manifest payload tampering while retaining explicit legacy parsing', async () => {
    const { result } = await generate('confirmed');
    const tampered = {
      ...result.manifest,
      summary: { ...result.manifest.summary, generated: 0 },
    };
    expect(new RegressionManifestIntegrityService().validate(tampered)).toBe(false);
    expect(
      parseSavedRegressionManifest({
        ...regressionManifestPayload(result.manifest),
        schemaVersion: '1.0',
      }).schemaVersion,
    ).toBe('1.0');
  });

  it('does not create active specs for probable or not-reproduced findings', async () => {
    const probable = await generate('probable');
    expect(probable.result.exitCode).toBe(1);
    expect(probable.result.manifest.tests[0]?.status).toBe('REVIEW_ONLY');
    expect(probable.writer.tests).toHaveLength(0);
    const fixed = await generate('not-reproduced');
    expect(fixed.result.exitCode).toBe(0);
    expect(fixed.result.manifest.tests[0]?.status).toBe('SKIPPED_VERDICT');
  });

  it('requires opt-in and emits test.fixme for flaky findings', async () => {
    expect((await generate('flaky')).result.manifest.tests[0]?.status).toBe('SKIPPED_VERDICT');
    const included = await generate('flaky', true);
    expect(included.result.manifest.tests[0]?.status).toBe('GENERATED_FIXME');
    expect(included.writer.tests[0]?.source).toContain('test.fixme(');
  });
});
