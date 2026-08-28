import pc from 'picocolors';
import type { InspectionOutcome } from '../application/inspect-page.js';
import type { ExplorationOutcome } from '../application/explore-application.js';
import type { PlanQaOutcome } from '../application/plan-qa.js';
import type { RunQaPlanOutcome } from '../application/run-qa-plan.js';

export interface Output {
  log(message: string): void;
  error(message: string): void;
}

export class ConsoleReporter {
  public constructor(private readonly output: Output = console) {}

  public success(outcome: InspectionOutcome): void {
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

  public failure(error: unknown, debug: boolean): void {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    this.output.error(`${pc.red(pc.bold('Agentic QA failed:'))} ${message}`);

    if (debug && error instanceof Error) {
      this.output.error(error.stack ?? String(error));
      if (error.cause instanceof Error) {
        this.output.error(`Caused by: ${error.cause.stack ?? error.cause.message}`);
      }
    }
  }
}
