import { describe, expect, it } from 'vitest';
import { ExportRegressions, boundedUnifiedDiff } from '../../src/application/export-regressions.js';
import { RegressionExportSourceValidator } from '../../src/application/regression-export-source-validator.js';
import { TargetProjectInspector } from '../../src/application/target-project-inspector.js';
import { ConfigurationError } from '../../src/application/errors.js';

function useCase(): ExportRegressions {
  return new ExportRegressions(
    { loadExportSource: () => Promise.reject(new Error('must not load')) },
    new RegressionExportSourceValidator({ format: (source) => Promise.resolve(source) }),
    new TargetProjectInspector({ inspect: () => Promise.reject(new Error('must not inspect')) }),
    {
      inspectDestination: () => Promise.reject(new Error('must not inspect destination')),
      apply: () => Promise.reject(new Error('must not apply')),
      validate: () => Promise.reject(new Error('must not validate')),
      gitReview: () => Promise.reject(new Error('must not read Git')),
    },
    {
      savePlan: () => Promise.reject(new Error('must not save')),
      saveReceipt: () => Promise.reject(new Error('must not save')),
    },
    { next: () => 'fixture' },
    { now: () => new Date('2026-08-29T00:00:00.000Z') },
  );
}

describe('ExportRegressions boundaries', () => {
  it('rejects overwrite before any source or target access unless apply is explicit', async () => {
    await expect(
      useCase().execute('/manifest.json', {
        targetPath: '/target',
        apply: false,
        overwrite: true,
        validate: false,
        validationTimeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('rejects validation before any source or target access unless apply is explicit', async () => {
    await expect(
      useCase().execute('/manifest.json', {
        targetPath: '/target',
        apply: false,
        overwrite: false,
        validate: true,
        validationTimeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('renders a bounded conflict diff without terminal control characters', () => {
    const diff = boundedUnifiedDiff(
      `same\nold\u0000line\n${'old\n'.repeat(100)}`,
      `same\nnew\u0007line\n${'new\n'.repeat(100)}`,
      'tests/agentic-qa/DEF-12345678.spec.ts',
    );
    expect(diff).toContain('--- target/tests/agentic-qa/DEF-12345678.spec.ts');
    expect(diff).toContain('-old�line');
    expect(diff).toContain('+new�line');
    expect(diff.split('\n').length).toBeLessThanOrEqual(81);
  });
});
