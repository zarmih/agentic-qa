import type { QaPlan, TestScenario } from '../domain/planning.js';

function escapeMarkdown(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll(/\r?\n/g, ' ');
}

function scenarioMarkdown(scenario: TestScenario): readonly string[] {
  const lines = [
    `### ${escapeMarkdown(scenario.id)} — ${escapeMarkdown(scenario.title)}`,
    '',
    `- Type: ${scenario.type}`,
    `- Executability: ${scenario.executability}`,
    `- Confidence: ${scenario.confidence.toFixed(2)}`,
    `- Objective: ${escapeMarkdown(scenario.objective)}`,
    `- Rationale: ${escapeMarkdown(scenario.rationale)}`,
  ];
  if (scenario.sourcePageIds.length > 0) {
    lines.push(`- Pages: ${scenario.sourcePageIds.map(escapeMarkdown).join(', ')}`);
  }
  if (scenario.sourceStateIds.length > 0) {
    lines.push(`- States: ${scenario.sourceStateIds.map(escapeMarkdown).join(', ')}`);
  }
  if (scenario.evidenceRefs.length > 0) {
    lines.push(`- Evidence: ${scenario.evidenceRefs.map(escapeMarkdown).join(', ')}`);
  }
  if (scenario.safetyNotes.length > 0) {
    lines.push(`- Safety: ${scenario.safetyNotes.map(escapeMarkdown).join(' ')}`);
  }
  lines.push('', 'Steps:', '');
  scenario.steps.forEach((step, index) => {
    const targets = Object.entries(step.target)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${escapeMarkdown(value)}`)
      .join(', ');
    lines.push(
      `${String(index + 1)}. **${step.action}** (${targets}) — ${escapeMarkdown(step.instruction)} Expected: ${escapeMarkdown(step.expected)}`,
    );
  });
  lines.push('', `Expected outcome: ${escapeMarkdown(scenario.expectedOutcome)}`, '');
  return lines;
}

export class QaPlanMarkdownRenderer {
  public render(plan: QaPlan): string {
    const lines = [
      '# QA Plan',
      '',
      `Source run: ${escapeMarkdown(plan.sourceRunId)}`,
      `Plan ID: ${escapeMarkdown(plan.planId)}`,
      `Provider: ${plan.metadata.provider}`,
      `Model: ${escapeMarkdown(plan.metadata.model)}`,
      '',
      '## Summary',
      '',
      escapeMarkdown(plan.summary),
      '',
      '## Coverage',
      '',
      '| Target | Covered | Total | Coverage |',
      '| --- | ---: | ---: | ---: |',
      ...(
        [
          ['pages', plan.coverage.pages],
          ['states', plan.coverage.states],
          ['safeTransitions', plan.coverage.safeTransitions],
          ['evidenceLocations', plan.coverage.evidenceLocations],
          ['errorBearingStates', plan.coverage.errorBearingStates],
        ] as const
      ).map(
        ([name, value]) =>
          `| ${name} | ${String(value.covered)} | ${String(value.total)} | ${String(value.percentage)}% |`,
      ),
      '',
    ];
    const priorityLabels = {
      CRITICAL: 'Critical scenarios',
      HIGH: 'High priority',
      MEDIUM: 'Medium priority',
      LOW: 'Low priority',
    } as const;
    for (const [priority, label] of Object.entries(priorityLabels)) {
      const scenarios = plan.scenarios.filter((scenario) => scenario.priority === priority);
      if (scenarios.length === 0) continue;
      lines.push(`## ${label}`, '');
      scenarios.forEach((scenario) => lines.push(...scenarioMarkdown(scenario)));
    }
    const manual = plan.scenarios.filter((scenario) => scenario.executability === 'MANUAL_ONLY');
    lines.push('## Manual-only scenarios', '');
    if (manual.length === 0) lines.push('None.', '');
    else
      manual.forEach((scenario) =>
        lines.push(`- ${scenario.id}: ${escapeMarkdown(scenario.title)}`),
      );
    lines.push('', '## Observed risks', '');
    if (plan.risks.length === 0) lines.push('None reported.', '');
    else {
      plan.risks.forEach((risk) =>
        lines.push(
          `- **${risk.severity} — ${escapeMarkdown(risk.title)}:** ${escapeMarkdown(risk.description)}`,
        ),
      );
      lines.push('');
    }
    lines.push('## Uncovered areas', '');
    if (plan.uncoveredAreas.length === 0) lines.push('None identified.', '');
    else plan.uncoveredAreas.forEach((area) => lines.push(`- ${escapeMarkdown(area)}`));
    lines.push('', '## Quality warnings', '');
    if (plan.warnings.length === 0) lines.push('None.', '');
    else plan.warnings.forEach((warning) => lines.push(`- ${escapeMarkdown(warning)}`));
    return `${lines.join('\n').trim()}\n`;
  }
}
