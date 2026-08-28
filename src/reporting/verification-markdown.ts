import type { DefectFinding, DefectVerdict, VerificationRun } from '../domain/verification.js';

function text(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

function findingSection(finding: DefectFinding): string {
  const lines = [
    `### ${finding.id} — ${text(finding.title)}`,
    '',
    `- Verdict: **${finding.verdict}**`,
    `- Severity: **${finding.severity}**`,
    `- Confidence: **${finding.confidence}**`,
    `- Scenario: \`${finding.scenarioId}\``,
    `- Reproduction: ${String(finding.profile.matchingAttempts)}/${String(finding.profile.validAttempts)} valid attempts (${finding.reproducibility})`,
  ];
  if (finding.expected !== null) lines.push(`- Expected: \`${text(finding.expected)}\``);
  if (finding.actual.length > 0) {
    lines.push(`- Observed: ${finding.actual.map((value) => `\`${text(value)}\``).join(', ')}`);
  }
  lines.push('', '#### Reproduction path', '');
  lines.push(...finding.reproductionSteps);
  if (finding.evidence.summaries.length > 0) {
    lines.push(
      '',
      '#### Associated evidence',
      '',
      '_Observed during the same scenario or transition; correlation is not proof of causation._',
      '',
      ...finding.evidence.summaries.map((entry) => `- ${text(entry)}`),
    );
  }
  lines.push(
    '',
    '#### Verification attempts',
    '',
    '| Attempt | Status | Signature | Duration |',
    '| ---: | --- | --- | ---: |',
  );
  for (const attempt of finding.attempts) {
    lines.push(
      `| ${String(attempt.attemptNumber)} | ${attempt.status} | ${attempt.signature?.hash.slice(0, 12) ?? '—'} | ${String(attempt.durationMs)} ms |`,
    );
  }
  const screenshots = [
    ...finding.sourceScreenshotRefs,
    ...finding.attempts.flatMap((attempt) => attempt.screenshotRefs),
  ];
  if (screenshots.length > 0) {
    lines.push('', 'Screenshots:', '', ...screenshots.map((entry) => `- \`${entry}\``));
  }
  return lines.join('\n');
}

export class VerificationMarkdownRenderer {
  public render(run: VerificationRun): string {
    const lines = [
      '# Agentic QA Verification Report',
      '',
      `Verification: \`${run.verificationId}\`  `,
      `Source execution: \`${run.sourceExecutionId}\`  `,
      `Source run: \`${run.sourceRunId}\``,
      '',
      '## Summary',
      '',
      '| Verdict | Count |',
      '| --- | ---: |',
      `| Confirmed defects | ${String(run.summary.confirmed)} |`,
      `| Probable defects | ${String(run.summary.probable)} |`,
      `| Flaky defects | ${String(run.summary.flaky)} |`,
      `| Not reproduced | ${String(run.summary.notReproduced)} |`,
      `| Inconclusive | ${String(run.summary.inconclusive)} |`,
      `| Non-defect signals | ${String(run.summary.nonDefectSignals)} |`,
      '',
      `Attempts: ${String(run.summary.attemptsCompleted)}/${String(run.summary.attemptsRequested)} completed; ${String(run.summary.validAttempts)} valid.`,
    ];
    const groups: readonly {
      readonly heading: string;
      readonly verdicts: readonly DefectVerdict[];
    }[] = [
      { heading: 'Confirmed defects', verdicts: ['CONFIRMED_DEFECT'] },
      { heading: 'Probable defects', verdicts: ['PROBABLE_DEFECT'] },
      { heading: 'Flaky defects', verdicts: ['FLAKY_DEFECT'] },
      { heading: 'Not reproduced', verdicts: ['NOT_REPRODUCED'] },
      { heading: 'Inconclusive', verdicts: ['INCONCLUSIVE'] },
      { heading: 'Informational signals', verdicts: ['NON_DEFECT_SIGNAL'] },
    ];
    for (const { heading, verdicts } of groups) {
      const findings = run.findings.filter((finding) => verdicts.includes(finding.verdict));
      if (findings.length > 0) {
        lines.push('', `## ${heading}`, '', ...findings.map(findingSection));
      }
    }
    if (run.warnings.length > 0) {
      lines.push('', '## Warnings', '', ...run.warnings.map((warning) => `- ${text(warning)}`));
    }
    lines.push(
      '',
      '## Interpretation boundary',
      '',
      'Findings are produced by deterministic graph assertions and evidence matching; correlation is not proof of causation. No root-cause analysis or LLM reasoning is performed.',
      '',
    );
    return lines.join('\n');
  }
}
