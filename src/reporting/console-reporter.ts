import pc from 'picocolors';
import type { InspectionOutcome } from '../application/inspect-page.js';
import type { ExplorationOutcome } from '../application/explore-application.js';
import type { PlanQaOutcome } from '../application/plan-qa.js';
import type { RunQaPlanOutcome } from '../application/run-qa-plan.js';
import type { VerifyExecutionOutcome } from '../application/verify-execution.js';
import type { GenerateRegressionsOutcome } from '../application/generate-regressions.js';
import type { ExportRegressionsOutcome } from '../application/export-regressions.js';
import type { RunPipelineOutcome } from '../application/run-pipeline.js';
import type { RenderPipelineReportOutcome } from '../application/render-pipeline-report.js';
import { AgenticQaError } from '../application/errors.js';

export interface Output {
  log(message: string): void;
  error(message: string): void;
}

export class ConsoleReporter {
  public constructor(
    private readonly output: Output = console,
    private readonly colors: ReturnType<typeof pc.createColors> = pc,
  ) {}

  public success(outcome: InspectionOutcome): void {
    const pc = this.colors;
    const { result } = outcome;
    const status = result.page.status === null ? 'unavailable' : String(result.page.status);
    const lines = [
      pc.bold(pc.green('Inspection complete')),
      `${pc.dim('Run')}       ${result.runId}`,
      `${pc.dim('Page')}      ${result.page.title || '(untitled)'}`,
      `${pc.dim('URL')}       ${result.page.url}`,
      `${pc.dim('HTTP')}      ${status}`,
      `${pc.dim('Viewport')}  ${String(result.page.viewport.width)}x${String(result.page.viewport.height)}`,
      `${pc.dim('Elements')}  ${String(result.page.elements.links)} links · ${String(result.page.elements.buttons)} buttons · ${String(result.page.elements.inputs)} inputs · ${String(result.page.elements.forms)} forms · ${String(result.page.elements.headings)} headings`,
      `${pc.dim('Artifacts')} ${outcome.artifactDirectory}`,
    ];

    if (result.warnings.length > 0) {
      lines.push('', ...result.warnings.map((warning) => pc.yellow(`Warning: ${warning}`)));
    }
    this.output.log(lines.join('\n'));
  }

  public exploration(outcome: ExplorationOutcome): void {
    const pc = this.colors;
    const { result } = outcome;
    const lines = [
      pc.bold(pc.green('Agentic QA Exploration complete')),
      '',
      `${pc.dim('Start URL')}        ${result.startUrl}`,
      `${pc.dim('Pages visited')}    ${String(result.summary.pagesVisited)}`,
      `${pc.dim('Pages failed')}     ${String(result.summary.pagesFailed)}`,
      `${pc.dim('Links discovered')} ${String(result.summary.linksDiscovered)}`,
      `${pc.dim('Console errors')}   ${String(result.summary.consoleErrors)}`,
      `${pc.dim('Console warnings')} ${String(result.summary.consoleWarnings)}`,
      `${pc.dim('Page errors')}      ${String(result.summary.pageErrors)}`,
      `${pc.dim('Failed requests')}  ${String(result.summary.failedRequests)}`,
      `${pc.dim('HTTP errors')}      ${String(result.summary.httpErrors)}`,
      '',
      pc.bold('Graph:'),
      ...result.graph.nodes.map((node) => {
        const url = new URL(node.finalUrl);
        const marker = node.state === 'visited' ? '├──' : '└─!';
        return `${'  '.repeat(node.depth)}${marker} ${url.pathname}${url.search}`;
      }),
      '',
      `${pc.dim('Artifacts')} ${outcome.artifactDirectory}`,
    ];

    if (result.interactive.enabled) {
      lines.splice(
        11,
        0,
        `${pc.dim('UI states')}        ${String(result.interactive.statesDiscovered)}`,
        `${pc.dim('Actions executed')} ${String(result.interactive.actionsExecuted)}`,
        `${pc.dim('Actions blocked')}  ${String(result.interactive.actionsBlocked)}`,
        `${pc.dim('Action failures')}  ${String(result.interactive.actionFailures)}`,
      );
    }

    if (result.warnings.length > 0) {
      lines.push('', ...result.warnings.map((warning) => pc.yellow(`Warning: ${warning}`)));
    }
    this.output.log(lines.join('\n'));
  }

  public plan(outcome: PlanQaOutcome): void {
    const pc = this.colors;
    const { plan } = outcome;
    const priorities = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const executability = { AUTOMATABLE: 0, MANUAL_ONLY: 0, UNSUPPORTED: 0 };
    plan.scenarios.forEach((scenario) => {
      priorities[scenario.priority] += 1;
      executability[scenario.executability] += 1;
    });
    this.output.log(
      [
        pc.bold(pc.green('Agentic QA Plan complete')),
        '',
        `${pc.dim('Source run')}   ${plan.sourceRunId}`,
        `${pc.dim('Provider')}     ${plan.metadata.provider}`,
        `${pc.dim('Model')}        ${plan.metadata.model}`,
        `${pc.dim('Scenarios')}    ${String(plan.scenarios.length)}`,
        '',
        `${pc.dim('Priorities')}   ${String(priorities.CRITICAL)} critical · ${String(priorities.HIGH)} high · ${String(priorities.MEDIUM)} medium · ${String(priorities.LOW)} low`,
        `${pc.dim('Execution')}    ${String(executability.AUTOMATABLE)} automatable · ${String(executability.MANUAL_ONLY)} manual · ${String(executability.UNSUPPORTED)} unsupported`,
        '',
        pc.bold('Coverage:'),
        `Pages             ${String(plan.coverage.pages.covered)}/${String(plan.coverage.pages.total)}`,
        `States            ${String(plan.coverage.states.covered)}/${String(plan.coverage.states.total)}`,
        `Safe transitions  ${String(plan.coverage.safeTransitions.covered)}/${String(plan.coverage.safeTransitions.total)}`,
        `Evidence          ${String(plan.coverage.evidenceLocations.covered)}/${String(plan.coverage.evidenceLocations.total)}`,
        `Error states      ${String(plan.coverage.errorBearingStates.covered)}/${String(plan.coverage.errorBearingStates.total)}`,
        '',
        `${pc.dim('Artifacts')} ${outcome.artifactDirectory}`,
      ].join('\n'),
    );
  }

  public execution(outcome: RunQaPlanOutcome): void {
    const pc = this.colors;
    const { result } = outcome;
    this.output.log(
      [
        pc.bold(
          outcome.exitCode === 0
            ? pc.green('Agentic QA Run complete')
            : pc.yellow('Agentic QA Run complete with findings'),
        ),
        '',
        `${pc.dim('Plan')}        ${result.planId}`,
        `${pc.dim('Execution')}   ${result.executionId}`,
        `${pc.dim('Automatable')} ${String(result.summary.automatableScenarios)}`,
        `${pc.dim('Skipped')}     ${String(result.summary.skipped)}`,
        '',
        `${pc.dim('PASS')}        ${String(result.summary.passed)}`,
        `${pc.dim('FAIL')}        ${String(result.summary.failed)}`,
        `${pc.dim('BLOCKED')}     ${String(result.summary.blocked)}`,
        `${pc.dim('ERROR')}       ${String(result.summary.errors)}`,
        '',
        `${pc.dim('Evidence')}    ${String(result.summary.evidenceReproduced)}/${String(result.summary.evidenceEvaluated)} reproduced`,
        `${pc.dim('Artifacts')}   ${outcome.artifactDirectory}`,
      ].join('\n'),
    );
  }

  public verification(outcome: VerifyExecutionOutcome): void {
    const pc = this.colors;
    const { result } = outcome;
    const lines = [
      pc.bold(
        outcome.exitCode === 0
          ? pc.green('Agentic QA Verify complete')
          : pc.yellow('Agentic QA Verify complete with findings'),
      ),
      '',
      `${pc.dim('Source execution')} ${result.sourceExecutionId}`,
      `${pc.dim('Verification')}     ${result.verificationId}`,
      `${pc.dim('Candidates')}       ${String(result.summary.candidatesSelected)}`,
      `${pc.dim('Attempts')}         ${String(result.summary.attemptsCompleted)}/${String(result.summary.attemptsRequested)} completed`,
      '',
      `${pc.dim('Confirmed')}        ${String(result.summary.confirmed)}`,
      `${pc.dim('Probable')}         ${String(result.summary.probable)}`,
      `${pc.dim('Flaky')}            ${String(result.summary.flaky)}`,
      `${pc.dim('Not reproduced')}   ${String(result.summary.notReproduced)}`,
      `${pc.dim('Inconclusive')}     ${String(result.summary.inconclusive)}`,
    ];
    for (const finding of result.findings.filter((item) =>
      ['CONFIRMED_DEFECT', 'PROBABLE_DEFECT', 'FLAKY_DEFECT'].includes(item.verdict),
    )) {
      lines.push(
        '',
        `${finding.id}  ${finding.severity}  ${finding.verdict}  ${String(finding.profile.matchingAttempts)}/${String(finding.profile.validAttempts)}`,
        finding.title,
      );
    }
    lines.push('', `${pc.dim('Artifacts')}        ${outcome.artifactDirectory}`);
    this.output.log(lines.join('\n'));
  }

  public regressionGeneration(outcome: GenerateRegressionsOutcome): void {
    const pc = this.colors;
    const { manifest } = outcome;
    const files = manifest.tests.flatMap((entry) => (entry.file === null ? [] : [entry.file]));
    this.output.log(
      [
        pc.bold(
          outcome.exitCode === 0
            ? pc.green('Agentic QA Regression Generation complete')
            : pc.yellow('Agentic QA Regression Generation complete with review items'),
        ),
        '',
        `${pc.dim('Verification')} ${manifest.verificationId}`,
        `${pc.dim('Eligible')}     ${String(manifest.summary.eligible)}`,
        `${pc.dim('Generated')}    ${String(manifest.summary.generated)}`,
        `${pc.dim('Fixme')}        ${String(manifest.summary.generatedFixme)}`,
        `${pc.dim('Review only')}  ${String(manifest.summary.reviewOnly)}`,
        `${pc.dim('Unsupported')}  ${String(manifest.summary.unsupported)}`,
        `${pc.dim('Duplicates')}   ${String(manifest.summary.duplicates)}`,
        ...(files.length === 0 ? [] : ['', pc.bold('Tests:'), ...files]),
        '',
        `${pc.dim('Artifacts')}    ${outcome.artifactDirectory}`,
      ].join('\n'),
    );
  }

  public regressionExport(outcome: ExportRegressionsOutcome, json: boolean): void {
    if (json) {
      this.output.log(
        JSON.stringify(
          {
            plan: outcome.plan,
            receipt: outcome.receipt,
            artifactDirectory: outcome.artifactDirectory,
            exitCode: outcome.exitCode,
          },
          null,
          2,
        ),
      );
      return;
    }
    const pc = this.colors;
    const { plan } = outcome;
    const lines = [
      pc.bold(pc.green('Agentic QA Regression Export')),
      '',
      `${pc.dim('Mode')}        ${plan.mode}${plan.mode === 'DRY_RUN' ? ' (target unchanged)' : ''}`,
      `${pc.dim('Target')}      ${plan.target.identifier}`,
      `${pc.dim('Playwright')}  ${plan.target.playwrightDependency ? 'detected' : 'not detected'}`,
      `${pc.dim('Destination')} ${plan.target.destinationDirectory}`,
      `${pc.dim('Support')}     ${plan.target.support}`,
      '',
      pc.bold('Specs:'),
      ...plan.entries.map((entry) => `${entry.status.padEnd(18)} ${entry.destination}`),
      '',
      `${pc.dim('Changes')}     ${String(plan.summary.changesToApply)}`,
      `${pc.dim('Conflicts')}   ${String(plan.summary.conflicts + plan.summary.modifiedGenerated)}`,
      `${pc.dim('Blocked')}     ${String(plan.summary.blocked)}`,
    ];
    for (const entry of plan.entries) {
      if (entry.diff !== null) lines.push('', pc.bold(`Diff: ${entry.destination}`), entry.diff);
    }
    if (outcome.receipt !== null) {
      lines.push(
        '',
        `${pc.dim('Validation')}  ${outcome.receipt.validation.status}`,
        `${pc.dim('Files')}       ${
          outcome.receipt.files.map((entry) => `${entry.action}:${entry.destination}`).join(', ') ||
          'none'
        }`,
      );
      if (outcome.receipt.gitReview.length > 0) {
        lines.push('', pc.bold('Git review:'), ...outcome.receipt.gitReview);
      }
    }
    if (plan.warnings.length > 0) {
      lines.push('', ...plan.warnings.map((warning) => pc.yellow(`Warning: ${warning}`)));
    }
    lines.push('', `${pc.dim('Artifacts')}   ${outcome.artifactDirectory}`);
    this.output.log(lines.join('\n'));
  }

  public pipeline(outcome: RunPipelineOutcome, json: boolean): void {
    if (json) {
      this.output.log(
        JSON.stringify(
          {
            pipeline: outcome.pipeline,
            artifactDirectory: outcome.artifactDirectory,
            reportFile: outcome.reportFile,
            exitCode: outcome.exitCode,
          },
          null,
          2,
        ),
      );
      return;
    }
    const pc = this.colors;
    const lines = [
      pc.bold(
        outcome.pipeline.status === 'FAILED'
          ? pc.red('Agentic QA Pipeline failed')
          : outcome.pipeline.status === 'COMPLETE_NO_DEFECTS'
            ? pc.green('Agentic QA Pipeline complete')
            : pc.yellow('Agentic QA Pipeline complete with findings'),
      ),
      '',
      `${pc.dim('Target')}  ${outcome.pipeline.target}`,
      `${pc.dim('Profile')} ${outcome.pipeline.profile}`,
      '',
      ...outcome.pipeline.stages.flatMap((stage) => [
        `${stage.name.padEnd(10)} ${stage.status.padEnd(26)} ${String(stage.durationMs)} ms`,
        ...Object.entries(stage.summary).map(([key, value]) => `  ${key}: ${String(value)}`),
        ...(stage.error === null ? [] : [`  error: ${stage.error}`]),
      ]),
      '',
      `${pc.dim('Result')}  ${outcome.pipeline.status}`,
      `${pc.dim('Report')}  ${outcome.reportFile}`,
    ];
    this.output.log(lines.join('\n'));
  }

  public report(outcome: RenderPipelineReportOutcome): void {
    const pc = this.colors;
    this.output.log(
      [
        pc.bold(pc.green('Agentic QA Report rendered')),
        '',
        `${pc.dim('Pipeline')} ${outcome.pipelineId}`,
        `${pc.dim('Status')}   ${outcome.status}`,
        `${pc.dim('Report')}   ${outcome.reportFile}`,
      ].join('\n'),
    );
  }

  public failure(error: unknown, debug: boolean): void {
    const pc = this.colors;
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    this.output.error(`${pc.red(pc.bold('Agentic QA failed:'))} ${message}`);

    if (debug && error instanceof Error) {
      this.output.error(error.stack ?? String(error));
      if (error.cause instanceof Error) {
        this.output.error(`Caused by: ${error.cause.stack ?? error.cause.message}`);
      }
    }
  }

  public failureJson(error: unknown, fallbackCode: string): void {
    const recognized = error instanceof AgenticQaError;
    this.output.error(
      JSON.stringify({
        error: {
          code: recognized ? error.code : fallbackCode,
          message: recognized ? error.message : 'An unexpected error occurred.',
        },
        exitCode: 2,
      }),
    );
  }
}
