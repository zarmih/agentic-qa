import pc from 'picocolors';
import type { InspectionOutcome } from '../application/inspect-page.js';
import type { ExplorationOutcome } from '../application/explore-application.js';

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
