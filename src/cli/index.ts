#!/usr/bin/env node
import { Command } from 'commander';
import { InspectPage } from '../application/inspect-page.js';
import { PlaywrightPageInspector } from '../browser/playwright-page-inspector.js';
import { FileArtifactStore } from '../infrastructure/file-artifact-store.js';
import { loadConfig } from '../infrastructure/config.js';
import { SystemClock, TimestampRunIdGenerator } from '../infrastructure/run-id.js';
import { ConsoleReporter } from '../reporting/console-reporter.js';

interface InspectCommandOptions {
  readonly headed?: boolean;
  readonly timeout?: string;
  readonly artifactsDir?: string;
}

const reporter = new ConsoleReporter();
const program = new Command();

program
  .name('agentic-qa')
  .description('Inspect web applications and collect structured QA evidence.')
  .version('0.1.0')
  .showHelpAfterError();

program
  .command('inspect')
  .description('Inspect one web page and save a screenshot and JSON result.')
  .argument('<url>', 'absolute http:// or https:// URL')
  .option('--headed', 'show the Chromium browser window')
  .option('--timeout <milliseconds>', 'navigation timeout in milliseconds')
  .option('--artifacts-dir <path>', 'directory in which run artifacts are stored')
  .action(async (url: string, commandOptions: InspectCommandOptions) => {
    const config = loadConfig(process.env, process.cwd(), {
      timeout: commandOptions.timeout,
      headed: commandOptions.headed,
      artifactsDirectory: commandOptions.artifactsDir,
    });
    const useCase = new InspectPage(
      new PlaywrightPageInspector(),
      new FileArtifactStore(config.artifactsDirectory),
      new TimestampRunIdGenerator(),
      new SystemClock(),
    );

    const outcome = await useCase.execute(url, {
      headless: config.headless,
      navigationTimeoutMs: config.navigationTimeoutMs,
      viewport: config.viewport,
    });
    reporter.success(outcome);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  reporter.failure(error, process.env.AGENTIC_QA_DEBUG === 'true');
  process.exitCode = 1;
}
