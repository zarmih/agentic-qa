import { defineConfig } from '@playwright/test';

const testDirectory = process.env.AGENTIC_QA_GENERATED_TEST_DIR;
if (testDirectory === undefined || testDirectory === '') {
  throw new Error('AGENTIC_QA_GENERATED_TEST_DIR is required for generated-spec fixture runs.');
}

export default defineConfig({
  testDir: testDirectory,
  testMatch: '*.spec.ts',
  respectGitIgnore: false,
  workers: 1,
  reporter: 'line',
  use: { browserName: 'chromium', headless: true },
  outputDir: process.env.AGENTIC_QA_GENERATED_TEST_OUTPUT ?? 'test-results/generated',
});
