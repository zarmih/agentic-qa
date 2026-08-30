import { describe, expect, it } from 'vitest';
import {
  TargetProjectInspector,
  safeRelativeDirectory,
} from '../../src/application/target-project-inspector.js';
import type { TargetProjectFacts } from '../../src/application/export-ports.js';

function facts(overrides: Partial<TargetProjectFacts> = {}): TargetProjectFacts {
  return {
    rootPath: '/target',
    identifier: 'target',
    packageJson: true,
    packageManager: 'npm',
    playwrightDependency: true,
    playwrightConfig: 'playwright.config.ts',
    configuredTestDirectory: './e2e',
    configuredBaseUrl: 'https://target.example',
    tsconfig: true,
    moduleType: 'module',
    language: 'typescript',
    existingTestDirectories: ['tests', 'e2e'],
    git: { repository: true, branch: 'main', dirty: false },
    warnings: [],
    ...overrides,
  };
}

describe('TargetProjectInspector', () => {
  it.each([
    '../outside',
    '../../outside',
    '/absolute',
    '~/tests',
    'C:\\outside',
    'tests\\e2e',
    'a\0b',
    'tests\noutside',
    'tests/agentic‐qa',
    'C:/outside',
  ])('rejects unsafe test directory %s', (value) => {
    expect(() => safeRelativeDirectory(value)).toThrow(/safe|inside/i);
  });

  it('uses explicit, static config, existing, and fallback destinations deterministically', async () => {
    const explicit = await new TargetProjectInspector({
      inspect: () => Promise.resolve(facts()),
    }).inspect('/target', 'custom/specs', 'https://target.example');
    expect(explicit.profile).toMatchObject({
      selectedTestDirectory: 'custom/specs',
      destinationDirectory: 'custom/specs/agentic-qa',
      destinationSource: 'explicit',
      support: 'SUPPORTED',
      baseUrlCompatibility: 'COMPATIBLE',
    });

    const configured = await new TargetProjectInspector({
      inspect: () => Promise.resolve(facts()),
    }).inspect('/target', undefined, 'https://other.example');
    expect(configured.profile).toMatchObject({
      destinationDirectory: 'e2e/agentic-qa',
      destinationSource: 'config',
      baseUrlCompatibility: 'BASE_URL_REVIEW_REQUIRED',
    });

    const existing = await new TargetProjectInspector({
      inspect: () =>
        Promise.resolve(
          facts({ configuredTestDirectory: null, existingTestDirectories: ['tests/e2e'] }),
        ),
    }).inspect('/target', undefined, 'https://target.example');
    expect(existing.profile).toMatchObject({
      destinationDirectory: 'tests/e2e/agentic-qa',
      destinationSource: 'existing',
    });

    const fallback = await new TargetProjectInspector({
      inspect: () =>
        Promise.resolve(facts({ configuredTestDirectory: null, existingTestDirectories: [] })),
    }).inspect('/target', undefined, 'https://target.example');
    expect(fallback.profile).toMatchObject({
      destinationDirectory: 'tests/agentic-qa',
      destinationSource: 'fallback',
    });
    expect(fallback.profile.warnings).toContain(
      'No test directory was detected; using tests/agentic-qa as a fallback.',
    );
  });

  it('marks missing Playwright for review and JavaScript-only targets unsupported', async () => {
    const missing = await new TargetProjectInspector({
      inspect: () => Promise.resolve(facts({ playwrightDependency: false })),
    }).inspect('/target', undefined, 'https://target.example');
    expect(missing.profile.support).toBe('REVIEW_REQUIRED');
    expect(missing.profile.warnings.join(' ')).toContain('@playwright/test');

    const javascript = await new TargetProjectInspector({
      inspect: () => Promise.resolve(facts({ language: 'javascript', tsconfig: false })),
    }).inspect('/target', undefined, 'https://target.example');
    expect(javascript.profile.support).toBe('UNSUPPORTED');
    expect(javascript.profile.warnings.join(' ')).toMatch(/JavaScript-only/);
  });

  it('reports dirty Git state without mutating or blocking inspection', async () => {
    const result = await new TargetProjectInspector({
      inspect: () =>
        Promise.resolve(facts({ git: { repository: true, branch: 'feature', dirty: true } })),
    }).inspect('/target', undefined, 'https://target.example');
    expect(result.profile.git).toEqual({ repository: true, branch: 'feature', dirty: true });
    expect(result.profile.warnings.join(' ')).toContain('will not stash or reset');
  });
});
