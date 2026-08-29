import type { RegressionManifest } from '../domain/regression.js';

export class RegressionReadmeRenderer {
  public render(manifest: RegressionManifest): string {
    const files = manifest.tests.flatMap((entry) =>
      entry.file === null ? [] : [`- \`${entry.file}\` — ${entry.status}`],
    );
    return [
      '# Generated Regression Tests',
      '',
      'These Playwright tests were deterministically generated from verified Agentic QA findings.',
      'Review every file before copying it into an application repository.',
      '',
      '## Safety boundary',
      '',
      '- Source actions are limited to graph-backed `NAVIGATE` and `CLICK` transitions.',
      '- The files contain no LLM-generated selectors or arbitrary JavaScript.',
      '- `FLAKY_DEFECT` files, when requested, are emitted with `test.fixme` and do not enforce CI.',
      '',
      '## Requirements',
      '',
      '```bash',
      'npm install -D @playwright/test',
      'npx playwright install chromium',
      '```',
      '',
      '## Run',
      '',
      '```bash',
      'npx playwright test tests',
      '```',
      '',
      'The target origin used for this generation was:',
      '',
      `\`${manifest.options.targetOrigin}\``,
      '',
      '## Files',
      '',
      ...(files.length === 0 ? ['No executable files were generated.'] : files),
      '',
      'JSON metadata and SHA-256 file digests are recorded in `manifest.json`.',
      '',
    ].join('\n');
  }
}
