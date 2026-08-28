#!/usr/bin/env node
import { Command } from 'commander';
import { InspectPage } from '../application/inspect-page.js';
import { ExploreApplication } from '../application/explore-application.js';
import { PlanQa } from '../application/plan-qa.js';
import { RunQaPlan } from '../application/run-qa-plan.js';
import { ConstrainedScenarioReproducer } from '../application/constrained-scenario-reproducer.js';
import { VerifyExecution } from '../application/verify-execution.js';
import { PlaywrightExplorationBrowser } from '../browser/playwright-exploration-browser.js';
import { PlaywrightPageInspector } from '../browser/playwright-page-inspector.js';
import { PlaywrightScenarioExecutionBrowser } from '../browser/playwright-scenario-execution-browser.js';
import { FileArtifactStore } from '../infrastructure/file-artifact-store.js';
import { FileExecutionArtifacts } from '../infrastructure/file-execution-artifacts.js';
import { FilePlanningArtifacts } from '../infrastructure/file-planning-artifacts.js';
import { FileVerificationArtifacts } from '../infrastructure/file-verification-artifacts.js';
import {
  loadConfig,
  loadExecutionConfig,
  loadPlanningConfig,
  loadVerificationConfig,
} from '../infrastructure/config.js';
import { OpenAICompatibleReasoningProvider } from '../infrastructure/openai-compatible-reasoning-provider.js';
import { SystemClock, TimestampRunIdGenerator } from '../infrastructure/run-id.js';
import { ConsoleReporter } from '../reporting/console-reporter.js';

interface InspectCommandOptions {
  readonly headed?: boolean;
  readonly timeout?: string;
  readonly artifactsDir?: string;
}

interface ExploreCommandOptions extends InspectCommandOptions {
  readonly interactive?: boolean;
  readonly maxPages?: string;
  readonly maxDepth?: string;
  readonly maxQueryVariants?: string;
  readonly maxStates?: string;
  readonly maxActionsPerState?: string;
  readonly maxStateDepth?: string;
}

interface PlanCommandOptions {
  readonly provider: string;
  readonly model?: string;
  readonly llmTimeout?: string;
}

interface RunCommandOptions {
  readonly exploration?: string;
  readonly headed?: boolean;
  readonly maxScenarios?: string;
  readonly stepTimeout?: string;
  readonly executionTimeout?: string;
}

interface VerifyCommandOptions {
  readonly attempts?: string;
  readonly maxFindings?: string;
  readonly headed?: boolean;
}

const reporter = new ConsoleReporter();
const program = new Command();

program
  .name('agentic-qa')
  .description(
    'Inspect and explore web applications, then plan, run, and verify constrained QA scenarios.',
  )
  .version('0.6.0')
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

program
  .command('plan')
  .description('Generate a grounded QA plan from an existing exploration.json artifact.')
  .argument('<exploration-json>', 'path to a Stage 3 exploration.json artifact')
  .option('--provider <kind>', 'reasoning provider protocol', 'openai-compatible')
  .option('--model <model>', 'model name; overrides AGENTIC_QA_LLM_MODEL')
  .option('--llm-timeout <milliseconds>', 'reasoning provider timeout in milliseconds')
  .action(async (path: string, commandOptions: PlanCommandOptions) => {
    const config = loadPlanningConfig(process.env, {
      provider: commandOptions.provider,
      model: commandOptions.model,
      timeout: commandOptions.llmTimeout,
    });
    const artifacts = new FilePlanningArtifacts(config.apiKey === null ? [] : [config.apiKey]);
    const useCase = new PlanQa(
      new OpenAICompatibleReasoningProvider(config),
      artifacts,
      artifacts,
      new SystemClock(),
    );
    const outcome = await useCase.execute(path, {
      provider: config.provider,
      model: config.model,
    });
    reporter.plan(outcome);
  });

program
  .command('run')
  .description('Execute validated AUTOMATABLE scenarios using graph-backed browser replay.')
  .argument('<qa-plan-json>', 'path to a Stage 5 qa-plan.json artifact')
  .option('--exploration <path>', 'explicit source exploration.json path')
  .option('--headed', 'show the Chromium browser window')
  .option('--max-scenarios <count>', 'maximum AUTOMATABLE scenarios to execute')
  .option('--step-timeout <milliseconds>', 'maximum time for one browser action')
  .option('--execution-timeout <milliseconds>', 'maximum duration of the execution run')
  .action(async (path: string, commandOptions: RunCommandOptions) => {
    try {
      const config = loadExecutionConfig(process.env, {
        headed: commandOptions.headed,
        maxScenarios: commandOptions.maxScenarios,
        stepTimeout: commandOptions.stepTimeout,
        executionTimeout: commandOptions.executionTimeout,
      });
      const artifacts = new FileExecutionArtifacts();
      const useCase = new RunQaPlan(
        artifacts,
        artifacts,
        new PlaywrightScenarioExecutionBrowser(),
        new TimestampRunIdGenerator(),
        new SystemClock(),
      );
      const outcome = await useCase.execute(path, {
        explorationPath: commandOptions.exploration,
        headless: config.headless,
        viewport: config.viewport,
        navigationTimeoutMs: config.navigationTimeoutMs,
        maxScenarios: config.maxScenarios,
        maxStepsPerScenario: config.maxStepsPerScenario,
        executionTimeoutMs: config.executionTimeoutMs,
        stepTimeoutMs: config.stepTimeoutMs,
      });
      reporter.execution(outcome);
      process.exitCode = outcome.exitCode;
    } catch (error) {
      reporter.failure(error, process.env.AGENTIC_QA_DEBUG === 'true');
      process.exitCode = 2;
    }
  });

program
  .command('verify')
  .description('Reproduce execution signals and create deterministic defect findings.')
  .argument('<execution-json>', 'path to a Stage 5 execution.json artifact')
  .option('--attempts <count>', 'isolated reproduction attempts per rerunnable candidate')
  .option('--max-findings <count>', 'maximum verification candidates to process')
  .option('--headed', 'show Chromium during reproduction attempts')
  .action(async (path: string, commandOptions: VerifyCommandOptions) => {
    try {
      const config = loadVerificationConfig(process.env, {
        attempts: commandOptions.attempts,
        maxFindings: commandOptions.maxFindings,
        headed: commandOptions.headed,
      });
      const executionArtifacts = new FileExecutionArtifacts();
      const verificationArtifacts = new FileVerificationArtifacts();
      const runIds = new TimestampRunIdGenerator();
      const clock = new SystemClock();
      const runner = new ConstrainedScenarioReproducer(
        executionArtifacts,
        new PlaywrightScenarioExecutionBrowser(),
        runIds,
        clock,
      );
      const useCase = new VerifyExecution(
        verificationArtifacts,
        verificationArtifacts,
        runner,
        runIds,
        clock,
      );
      const outcome = await useCase.execute(path, {
        attempts: config.attempts,
        maxFindings: config.maxFindings,
        verifyTimeoutMs: config.verifyTimeoutMs,
        headless: config.headless,
        viewport: config.viewport,
        navigationTimeoutMs: config.navigationTimeoutMs,
        maxStepsPerScenario: config.maxStepsPerScenario,
        executionTimeoutMs: config.executionTimeoutMs,
        stepTimeoutMs: config.stepTimeoutMs,
      });
      reporter.verification(outcome);
      process.exitCode = outcome.exitCode;
    } catch (error) {
      reporter.failure(error, process.env.AGENTIC_QA_DEBUG === 'true');
      process.exitCode = 2;
    }
  });

program
  .command('explore')
  .description('Safely explore same-origin links and build an application graph.')
  .argument('<url>', 'absolute http:// or https:// URL')
  .option('--headed', 'show the Chromium browser window')
  .option('--timeout <milliseconds>', 'per-page navigation timeout in milliseconds')
  .option('--artifacts-dir <path>', 'directory in which run artifacts are stored')
  .option('--max-pages <count>', 'maximum number of navigation attempts')
  .option('--max-depth <depth>', 'maximum BFS depth; the start page is depth 0')
  .option('--max-query-variants <count>', 'maximum query variants per origin and path')
  .option('--interactive', 'opt in to conservative same-page UI state exploration')
  .option('--max-states <count>', 'maximum unique UI states across the run')
  .option('--max-actions-per-state <count>', 'maximum safe actions attempted from one state')
  .option('--max-state-depth <depth>', 'maximum interaction path depth; initial state is depth 0')
  .action(async (url: string, commandOptions: ExploreCommandOptions) => {
    const config = loadConfig(process.env, process.cwd(), {
      timeout: commandOptions.timeout,
      headed: commandOptions.headed,
      artifactsDirectory: commandOptions.artifactsDir,
      maxPages: commandOptions.maxPages,
      maxDepth: commandOptions.maxDepth,
      maxQueryVariantsPerPath: commandOptions.maxQueryVariants,
      maxStates: commandOptions.maxStates,
      maxActionsPerState: commandOptions.maxActionsPerState,
      maxStateDepth: commandOptions.maxStateDepth,
    });
    const useCase = new ExploreApplication(
      new PlaywrightExplorationBrowser(),
      new FileArtifactStore(config.artifactsDirectory),
      new TimestampRunIdGenerator(),
      new SystemClock(),
    );
    const outcome = await useCase.execute(url, {
      headless: config.headless,
      navigationTimeoutMs: config.navigationTimeoutMs,
      viewport: config.viewport,
      maxPages: config.maxPages,
      maxDepth: config.maxDepth,
      maxQueryVariantsPerPath: config.maxQueryVariantsPerPath,
      interactive: commandOptions.interactive === true,
      maxStates: config.maxStates,
      maxActionsPerState: config.maxActionsPerState,
      maxStateDepth: config.maxStateDepth,
    });
    reporter.exploration(outcome);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  reporter.failure(error, process.env.AGENTIC_QA_DEBUG === 'true');
  process.exitCode = 1;
}
