#!/usr/bin/env node
import { Command } from 'commander';
import { InspectPage } from '../application/inspect-page.js';
import { ExploreApplication } from '../application/explore-application.js';
import { PlanQa } from '../application/plan-qa.js';
import { RunQaPlan } from '../application/run-qa-plan.js';
import { ConstrainedScenarioReproducer } from '../application/constrained-scenario-reproducer.js';
import { VerifyExecution } from '../application/verify-execution.js';
import { GenerateRegressions } from '../application/generate-regressions.js';
import { ExportRegressions } from '../application/export-regressions.js';
import { RegressionExportSourceValidator } from '../application/regression-export-source-validator.js';
import { TargetProjectInspector } from '../application/target-project-inspector.js';
import { RunPipeline } from '../application/run-pipeline.js';
import { RenderPipelineReport } from '../application/render-pipeline-report.js';
import { PlaywrightExplorationBrowser } from '../browser/playwright-exploration-browser.js';
import { PlaywrightPageInspector } from '../browser/playwright-page-inspector.js';
import { PlaywrightScenarioExecutionBrowser } from '../browser/playwright-scenario-execution-browser.js';
import { FileArtifactStore } from '../infrastructure/file-artifact-store.js';
import { FileExecutionArtifacts } from '../infrastructure/file-execution-artifacts.js';
import { FilePlanningArtifacts } from '../infrastructure/file-planning-artifacts.js';
import { FileVerificationArtifacts } from '../infrastructure/file-verification-artifacts.js';
import { FileRegressionArtifacts } from '../infrastructure/file-regression-artifacts.js';
import { FileRegressionExportArtifacts } from '../infrastructure/file-regression-export-artifacts.js';
import { FileTargetProject } from '../infrastructure/file-target-project.js';
import { FilePipelineArtifacts } from '../infrastructure/file-pipeline-artifacts.js';
import {
  loadConfig,
  loadExecutionConfig,
  loadPlanningConfig,
  loadVerificationConfig,
  loadRegressionConfig,
  loadExportConfig,
} from '../infrastructure/config.js';
import { OpenAICompatibleReasoningProvider } from '../infrastructure/openai-compatible-reasoning-provider.js';
import { SystemClock, TimestampRunIdGenerator } from '../infrastructure/run-id.js';
import { ConsoleReporter } from '../reporting/console-reporter.js';
import { TypeScriptRegressionValidator } from '../infrastructure/typescript-regression-validator.js';
import { PrettierRegressionFormatter } from '../infrastructure/prettier-regression-formatter.js';
import { PipelineHtmlRenderer } from '../reporting/pipeline-html.js';
import { ConfigurationError } from '../application/errors.js';
import {
  PIPELINE_PROFILE_LIMITS,
  PIPELINE_PROFILES,
  type PipelineProfile,
} from '../domain/pipeline.js';
import pc from 'picocolors';

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

interface GenerateCommandOptions {
  readonly includeFlaky?: boolean;
  readonly maxTests?: string;
  readonly baseUrl?: string;
}

interface ExportCommandOptions {
  readonly target: string;
  readonly testsDir?: string;
  readonly apply?: boolean;
  readonly overwrite?: boolean;
  readonly validate?: boolean;
  readonly validationTimeout?: string;
  readonly json?: boolean;
}

interface PipelineCommandOptions {
  readonly profile: PipelineProfile;
  readonly provider: string;
  readonly model?: string;
  readonly headed?: boolean;
  readonly artifactsDir?: string;
  readonly maxPages?: string;
  readonly maxStates?: string;
  readonly attempts?: string;
  readonly maxTests?: string;
  readonly json?: boolean;
}

const colorsEnabled = !process.argv.includes('--no-color') && process.env.NO_COLOR === undefined;
const reporter = new ConsoleReporter(console, pc.createColors(colorsEnabled));
const program = new Command();

program
  .name('agentic-qa')
  .description(
    'Explore web applications, verify defects, generate regressions, and export them with human approval.',
  )
  .version('0.9.0')
  .option('--no-color', 'disable ANSI color output (NO_COLOR is also respected)')
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
  .argument('<exploration-json>', 'path to an exploration.json artifact')
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
  .argument('<qa-plan-json>', 'path to a qa-plan.json artifact')
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
  .argument('<execution-json>', 'path to an execution.json artifact')
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
  .command('generate')
  .description('Generate reviewable Playwright regressions from verified defect findings.')
  .argument('<findings-json>', 'path to a findings.json artifact')
  .option('--include-flaky', 'emit flaky findings as disabled test.fixme specs')
  .option('--max-tests <count>', 'maximum generated Playwright spec files')
  .option('--base-url <origin>', 'replace the source origin while preserving graph paths')
  .action(async (path: string, commandOptions: GenerateCommandOptions) => {
    try {
      const config = loadRegressionConfig(process.env, { maxTests: commandOptions.maxTests });
      const artifacts = new FileRegressionArtifacts();
      const useCase = new GenerateRegressions(
        artifacts,
        artifacts,
        new PrettierRegressionFormatter(),
        new TypeScriptRegressionValidator(),
        new TimestampRunIdGenerator(),
        new SystemClock(),
      );
      const outcome = await useCase.execute(path, {
        includeFlaky: commandOptions.includeFlaky === true,
        ...(commandOptions.baseUrl === undefined ? {} : { baseUrl: commandOptions.baseUrl }),
        maxGeneratedTests: config.maxGeneratedTests,
        maxStepsPerTest: config.maxStepsPerTest,
        maxAssertionsPerTest: config.maxAssertionsPerTest,
      });
      reporter.regressionGeneration(outcome);
      process.exitCode = outcome.exitCode;
    } catch (error) {
      reporter.failure(error, process.env.AGENTIC_QA_DEBUG === 'true');
      process.exitCode = 2;
    }
  });

program
  .command('export')
  .description('Preview or apply a human-approved export into an existing Playwright project.')
  .argument('<manifest-json>', 'path to a regression manifest.json artifact')
  .requiredOption('--target <directory>', 'target project directory')
  .option('--tests-dir <path>', 'target test directory relative to the project root')
  .option('--apply', 'write planned files into the target project')
  .option('--overwrite', 'replace conflicting files; requires --apply')
  .option('--validate', 'list exported specs with the target Playwright CLI; requires --apply')
  .option('--validation-timeout <milliseconds>', 'bounded target validation timeout')
  .option('--json', 'write only machine-readable JSON to stdout')
  .action(async (path: string, commandOptions: ExportCommandOptions) => {
    try {
      const config = loadExportConfig(process.env, {
        validationTimeout: commandOptions.validationTimeout,
      });
      const fileArtifacts = new FileRegressionExportArtifacts();
      const target = new FileTargetProject();
      const formatter = new PrettierRegressionFormatter();
      const useCase = new ExportRegressions(
        fileArtifacts,
        new RegressionExportSourceValidator(formatter),
        new TargetProjectInspector(target),
        target,
        fileArtifacts,
        new TimestampRunIdGenerator(),
        new SystemClock(),
      );
      const outcome = await useCase.execute(path, {
        targetPath: commandOptions.target,
        ...(commandOptions.testsDir === undefined
          ? {}
          : { testsDirectory: commandOptions.testsDir }),
        apply: commandOptions.apply === true,
        overwrite: commandOptions.overwrite === true,
        validate: commandOptions.validate === true,
        validationTimeoutMs: config.validationTimeoutMs,
      });
      reporter.regressionExport(outcome, commandOptions.json === true);
      process.exitCode = outcome.exitCode;
    } catch (error) {
      if (commandOptions.json === true) reporter.failureJson(error, 'EXPORT_FAILED');
      else reporter.failure(error, process.env.AGENTIC_QA_DEBUG === 'true');
      process.exitCode = 2;
    }
  });

program
  .command('pipeline')
  .description('Run explore, plan, execute, verify, generate, and render a static report.')
  .argument('<url>', 'absolute http:// or https:// URL')
  .option(
    '--profile <profile>',
    'bounded pipeline profile: quick, standard, or thorough',
    'standard',
  )
  .option('--provider <kind>', 'reasoning provider protocol', 'openai-compatible')
  .option('--model <model>', 'model name; overrides AGENTIC_QA_LLM_MODEL')
  .option('--headed', 'show Chromium during browser stages')
  .option('--artifacts-dir <path>', 'directory in which pipeline artifacts are stored')
  .option('--max-pages <count>', 'override the profile page limit')
  .option('--max-states <count>', 'override the profile UI-state limit')
  .option('--attempts <count>', 'override verification attempts')
  .option('--max-tests <count>', 'override generated regression limit')
  .option('--json', 'write only machine-readable JSON to stdout')
  .action(async (url: string, commandOptions: PipelineCommandOptions) => {
    try {
      if (!PIPELINE_PROFILES.includes(commandOptions.profile)) {
        throw new ConfigurationError(
          `Pipeline profile must be one of: ${PIPELINE_PROFILES.join(', ')}.`,
        );
      }
      const limits = PIPELINE_PROFILE_LIMITS[commandOptions.profile];
      const profileEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        AGENTIC_QA_MAX_PAGES: process.env.AGENTIC_QA_MAX_PAGES ?? String(limits.maxPages),
        AGENTIC_QA_MAX_DEPTH: process.env.AGENTIC_QA_MAX_DEPTH ?? String(limits.maxDepth),
        AGENTIC_QA_MAX_STATES: process.env.AGENTIC_QA_MAX_STATES ?? String(limits.maxStates),
        AGENTIC_QA_MAX_ACTIONS_PER_STATE:
          process.env.AGENTIC_QA_MAX_ACTIONS_PER_STATE ?? String(limits.maxActionsPerState),
        AGENTIC_QA_MAX_STATE_DEPTH:
          process.env.AGENTIC_QA_MAX_STATE_DEPTH ?? String(limits.maxStateDepth),
        AGENTIC_QA_VERIFY_ATTEMPTS:
          process.env.AGENTIC_QA_VERIFY_ATTEMPTS ?? String(limits.verificationAttempts),
        AGENTIC_QA_MAX_VERIFY_FINDINGS:
          process.env.AGENTIC_QA_MAX_VERIFY_FINDINGS ?? String(limits.maxVerifyFindings),
        AGENTIC_QA_MAX_GENERATED_TESTS:
          process.env.AGENTIC_QA_MAX_GENERATED_TESTS ?? String(limits.maxGeneratedTests),
      };
      const explorationConfig = loadConfig(profileEnvironment, process.cwd(), {
        headed: commandOptions.headed,
        artifactsDirectory: commandOptions.artifactsDir,
        maxPages: commandOptions.maxPages,
        maxStates: commandOptions.maxStates,
      });
      const planningConfig = loadPlanningConfig(profileEnvironment, {
        provider: commandOptions.provider,
        model: commandOptions.model,
      });
      const executionConfig = loadExecutionConfig(profileEnvironment, {
        headed: commandOptions.headed,
      });
      const verificationConfig = loadVerificationConfig(profileEnvironment, {
        headed: commandOptions.headed,
        attempts: commandOptions.attempts,
      });
      const regressionConfig = loadRegressionConfig(profileEnvironment, {
        maxTests: commandOptions.maxTests,
      });
      const clock = new SystemClock();
      const runIds = new TimestampRunIdGenerator();
      const exploration = new ExploreApplication(
        new PlaywrightExplorationBrowser(),
        new FileArtifactStore(explorationConfig.artifactsDirectory),
        runIds,
        clock,
      );
      const planningArtifacts = new FilePlanningArtifacts(
        planningConfig.apiKey === null ? [] : [planningConfig.apiKey],
      );
      const planner = new PlanQa(
        new OpenAICompatibleReasoningProvider(planningConfig),
        planningArtifacts,
        planningArtifacts,
        clock,
      );
      const executionArtifacts = new FileExecutionArtifacts();
      const runner = new RunQaPlan(
        executionArtifacts,
        executionArtifacts,
        new PlaywrightScenarioExecutionBrowser(),
        runIds,
        clock,
      );
      const verificationArtifacts = new FileVerificationArtifacts();
      const reproducer = new ConstrainedScenarioReproducer(
        executionArtifacts,
        new PlaywrightScenarioExecutionBrowser(),
        runIds,
        clock,
      );
      const verifier = new VerifyExecution(
        verificationArtifacts,
        verificationArtifacts,
        reproducer,
        runIds,
        clock,
      );
      const regressionArtifacts = new FileRegressionArtifacts();
      const generator = new GenerateRegressions(
        regressionArtifacts,
        regressionArtifacts,
        new PrettierRegressionFormatter(),
        new TypeScriptRegressionValidator(),
        runIds,
        clock,
      );
      const pipelineArtifacts = new FilePipelineArtifacts();
      const useCase = new RunPipeline(
        exploration,
        planner,
        runner,
        verifier,
        generator,
        new PipelineHtmlRenderer(),
        pipelineArtifacts,
        clock,
      );
      const outcome = await useCase.execute(url, {
        profile: commandOptions.profile,
        provider: planningConfig.provider,
        model: planningConfig.model,
        exploration: {
          headless: explorationConfig.headless,
          interactive: true,
          navigationTimeoutMs: explorationConfig.navigationTimeoutMs,
          viewport: explorationConfig.viewport,
          maxPages: explorationConfig.maxPages,
          maxDepth: explorationConfig.maxDepth,
          maxQueryVariantsPerPath: explorationConfig.maxQueryVariantsPerPath,
          maxStates: explorationConfig.maxStates,
          maxActionsPerState: explorationConfig.maxActionsPerState,
          maxStateDepth: explorationConfig.maxStateDepth,
        },
        planning: { provider: planningConfig.provider, model: planningConfig.model },
        execution: {
          headless: executionConfig.headless,
          viewport: executionConfig.viewport,
          navigationTimeoutMs: executionConfig.navigationTimeoutMs,
          maxScenarios: executionConfig.maxScenarios,
          maxStepsPerScenario: executionConfig.maxStepsPerScenario,
          executionTimeoutMs: executionConfig.executionTimeoutMs,
          stepTimeoutMs: executionConfig.stepTimeoutMs,
        },
        verification: {
          attempts: verificationConfig.attempts,
          maxFindings: verificationConfig.maxFindings,
          verifyTimeoutMs: verificationConfig.verifyTimeoutMs,
          headless: verificationConfig.headless,
          viewport: verificationConfig.viewport,
          navigationTimeoutMs: verificationConfig.navigationTimeoutMs,
          maxStepsPerScenario: verificationConfig.maxStepsPerScenario,
          executionTimeoutMs: verificationConfig.executionTimeoutMs,
          stepTimeoutMs: verificationConfig.stepTimeoutMs,
        },
        generation: {
          includeFlaky: false,
          maxGeneratedTests: regressionConfig.maxGeneratedTests,
          maxStepsPerTest: regressionConfig.maxStepsPerTest,
          maxAssertionsPerTest: regressionConfig.maxAssertionsPerTest,
        },
      });
      reporter.pipeline(outcome, commandOptions.json === true);
      process.exitCode = outcome.exitCode;
    } catch (error) {
      if (commandOptions.json === true) reporter.failureJson(error, 'PIPELINE_FAILED');
      else reporter.failure(error, process.env.AGENTIC_QA_DEBUG === 'true');
      process.exitCode = 2;
    }
  });

program
  .command('report')
  .description('Deterministically rerender report.html from pipeline JSON artifacts.')
  .argument('<pipeline-json-or-source-run>', 'pipeline.json or its source run directory')
  .action(async (path: string) => {
    try {
      const artifacts = new FilePipelineArtifacts();
      const useCase = new RenderPipelineReport(artifacts, new PipelineHtmlRenderer(), artifacts);
      reporter.report(await useCase.execute(path));
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
