import type { ExecutionRun, ScenarioExecution } from '../domain/execution.js';

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

function scenarioDetails(scenario: ScenarioExecution): string {
  const lines = [
    `### ${cell(scenario.title)}`,
    '',
    `- Plan scenario: \`${scenario.planScenarioId}\``,
    `- Status: **${scenario.status}**`,
  ];
  if (scenario.failureCode !== null) lines.push(`- Code: \`${scenario.failureCode}\``);
  if (scenario.message !== null) lines.push(`- Detail: ${cell(scenario.message)}`);
  if (scenario.steps.length > 0) {
    lines.push(
      '',
      '| Step | Action | Status | Expected | Actual |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const step of scenario.steps) {
      const expected =
        step.action === 'NAVIGATE'
          ? (step.transition.plannedTargetPageId ?? '—')
          : (step.expectedFingerprint ?? '—');
      const actual =
        step.action === 'NAVIGATE' ? (step.actualUrl ?? '—') : (step.actualFingerprint ?? '—');
      lines.push(
        `| ${cell(step.planStepId)} | ${step.action} | ${step.status} | ${cell(expected)} | ${cell(actual)} |`,
      );
    }
  }
  if (scenario.screenshotRefs.length > 0) {
    lines.push(
      '',
      `Screenshots: ${scenario.screenshotRefs.map((value) => `\`${value}\``).join(', ')}`,
    );
  }
  return lines.join('\n');
}

export class ExecutionMarkdownRenderer {
  public render(run: ExecutionRun): string {
    const result = [
      '# Agentic QA Execution Report',
      '',
      `Execution: \`${run.executionId}\`  `,
      `Plan: \`${run.planId}\`  `,
      `Source run: \`${run.sourceRunId}\``,
      '',
      '## Summary',
      '',
      '| Status | Count |',
      '| --- | ---: |',
      `| PASS | ${String(run.summary.passed)} |`,
      `| FAIL | ${String(run.summary.failed)} |`,
      `| BLOCKED | ${String(run.summary.blocked)} |`,
      `| ERROR | ${String(run.summary.errors)} |`,
      `| SKIPPED | ${String(run.summary.skipped)} |`,
      '',
      `Runtime evidence: ${String(run.summary.evidenceCaptured)} entries. ` +
        `Reproduced: ${String(run.summary.evidenceReproduced)}/${String(run.summary.evidenceEvaluated)} evaluated source references.`,
    ];
    const failed = run.scenarios.filter((scenario) => scenario.status === 'FAIL');
    const blocked = run.scenarios.filter((scenario) => scenario.status === 'BLOCKED');
    const errors = run.scenarios.filter((scenario) => scenario.status === 'ERROR');
    const skipped = run.scenarios.filter((scenario) => scenario.status === 'SKIPPED');
    if (failed.length > 0)
      result.push('', '## Failed scenarios', '', ...failed.map(scenarioDetails));
    if (blocked.length > 0)
      result.push('', '## Blocked scenarios', '', ...blocked.map(scenarioDetails));
    if (errors.length > 0)
      result.push('', '## Execution errors', '', ...errors.map(scenarioDetails));
    if (skipped.length > 0)
      result.push('', '## Skipped scenarios', '', ...skipped.map(scenarioDetails));

    const reproduced = run.scenarios.flatMap((scenario) =>
      scenario.evidenceReproduction
        .filter((entry) => entry.status === 'REPRODUCED')
        .map((entry) => `${scenario.planScenarioId}: ${entry.sourceEvidenceRef}`),
    );
    if (reproduced.length > 0) {
      result.push(
        '',
        '## Reproduced evidence',
        '',
        ...reproduced.map((value) => `- ${cell(value)}`),
      );
    }
    if (run.evidence.length > 0) {
      result.push(
        '',
        '## Runtime evidence',
        '',
        '| Kind | Scenario | Step | Message |',
        '| --- | --- | --- | --- |',
        ...run.evidence.map(
          (entry) =>
            `| ${entry.kind} | ${cell(entry.scenarioId)} | ${cell(entry.stepId ?? '—')} | ${cell(entry.message)} |`,
        ),
      );
    }
    result.push(
      '',
      '## Execution policy',
      '',
      'Only graph-backed NAVIGATE and observed SAFE CLICK actions were eligible. Natural-language expected outcomes were retained as human context and were not interpreted as browser assertions.',
      '',
    );
    return result.join('\n');
  }
}
