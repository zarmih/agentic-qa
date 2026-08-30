import { posix, win32 } from 'node:path';
import { ConfigurationError } from './errors.js';
import type { TargetProjectFacts, TargetProjectProbe } from './export-ports.js';
import type { TargetProjectProfile } from '../domain/export.js';

const COMMON_TEST_DIRECTORIES = ['tests', 'e2e', 'tests/e2e', 'playwright'] as const;

export function safeRelativeDirectory(value: string, label = 'Test directory'): string {
  const trimmed = value.trim().replace(/^\.\//, '').replace(/\/$/, '');
  if (
    trimmed === '' ||
    trimmed.startsWith('~') ||
    trimmed.includes('\0') ||
    trimmed.includes('\\') ||
    posix.isAbsolute(trimmed) ||
    win32.isAbsolute(trimmed)
  ) {
    throw new ConfigurationError(`${label} must be a safe path relative to the target project.`);
  }
  const normalized = posix.normalize(trimmed);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    !/^[-a-zA-Z0-9_./]+$/.test(normalized)
  ) {
    throw new ConfigurationError(`${label} must stay inside the target project.`);
  }
  return normalized;
}

function baseUrlCompatibility(
  sourceOrigin: string,
  configuredBaseUrl: string | null,
): TargetProjectProfile['baseUrlCompatibility'] {
  if (configuredBaseUrl === null) return 'UNKNOWN';
  try {
    return new URL(configuredBaseUrl).origin === new URL(sourceOrigin).origin
      ? 'COMPATIBLE'
      : 'BASE_URL_REVIEW_REQUIRED';
  } catch {
    return 'BASE_URL_REVIEW_REQUIRED';
  }
}

export class TargetProjectInspector {
  public constructor(private readonly probe: TargetProjectProbe) {}

  public async inspect(
    targetPath: string,
    explicitTestsDirectory: string | undefined,
    sourceOrigin: string,
  ): Promise<{ readonly rootPath: string; readonly profile: TargetProjectProfile }> {
    const facts = await this.probe.inspect(targetPath);
    const warnings = [...facts.warnings];
    let selected: string;
    let source: TargetProjectProfile['destinationSource'];
    if (explicitTestsDirectory !== undefined) {
      selected = safeRelativeDirectory(explicitTestsDirectory, '--tests-dir');
      source = 'explicit';
    } else if (facts.configuredTestDirectory !== null) {
      try {
        selected = safeRelativeDirectory(facts.configuredTestDirectory, 'Playwright testDir');
        source = 'config';
      } catch {
        selected = this.existingOrFallback(facts);
        source = facts.existingTestDirectories.includes(selected) ? 'existing' : 'fallback';
        warnings.push('The statically detected Playwright testDir was unsafe and was ignored.');
      }
    } else {
      selected = this.existingOrFallback(facts);
      source = facts.existingTestDirectories.includes(selected) ? 'existing' : 'fallback';
    }
    const destinationDirectory = posix.join(selected, 'agentic-qa');
    if (source === 'fallback') {
      warnings.push('No test directory was detected; using tests/agentic-qa as a fallback.');
    }
    if (!facts.playwrightDependency) {
      warnings.push('@playwright/test is not declared in the target package.json.');
    }
    if (facts.language === 'javascript') {
      warnings.push('JavaScript-only targets require manual review; export uses TypeScript specs.');
    }
    if (facts.git.dirty === true) {
      warnings.push('The target Git working tree is dirty; export will not stash or reset it.');
    }
    const support =
      facts.language === 'javascript'
        ? 'UNSUPPORTED'
        : facts.packageJson && facts.playwrightDependency && facts.language === 'typescript'
          ? 'SUPPORTED'
          : 'REVIEW_REQUIRED';
    return {
      rootPath: facts.rootPath,
      profile: {
        identifier: facts.identifier,
        packageManager: facts.packageManager,
        packageJson: facts.packageJson,
        playwrightDependency: facts.playwrightDependency,
        playwrightConfig: facts.playwrightConfig,
        configuredTestDirectory: facts.configuredTestDirectory,
        configuredBaseUrl: facts.configuredBaseUrl,
        tsconfig: facts.tsconfig,
        moduleType: facts.moduleType,
        language: facts.language,
        selectedTestDirectory: selected,
        destinationDirectory,
        destinationSource: source,
        support,
        git: facts.git,
        baseUrlCompatibility: baseUrlCompatibility(sourceOrigin, facts.configuredBaseUrl),
        warnings,
      },
    };
  }

  private existingOrFallback(facts: TargetProjectFacts): string {
    return (
      COMMON_TEST_DIRECTORIES.find((directory) =>
        facts.existingTestDirectories.includes(directory),
      ) ?? 'tests'
    );
  }
}
