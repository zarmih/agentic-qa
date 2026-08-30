import { posix } from 'node:path';
import type { PipelineReportData } from '../application/pipeline-ports.js';
import type { DefectFinding } from '../domain/verification.js';

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeRelativePath(...parts: readonly string[]): string | null {
  if (
    parts.some(
      (part) =>
        part.startsWith('/') || part.includes('\\') || part.includes('\0') || part.includes('://'),
    )
  ) {
    return null;
  }
  const candidate = posix.normalize(posix.join(...parts));
  if (
    candidate === '.' ||
    candidate.startsWith('/') ||
    candidate === '..' ||
    candidate.startsWith('../') ||
    candidate.includes('\0')
  ) {
    return null;
  }
  return candidate;
}

function link(path: string, label = path): string {
  const safe = safeRelativePath(path);
  return safe === null
    ? escapeHtml(label)
    : `<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>`;
}

function metric(label: string, value: string | number): string {
  return `<div class="metric"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function statusClass(value: string): string {
  if (value === 'PASS' || value === 'COMPLETE_NO_DEFECTS') return 'ok';
  if (value === 'FAIL' || value === 'FAILED' || value === 'ERROR' || value === 'CONFIRMED_DEFECT')
    return 'bad';
  return 'warn';
}

function findingScreenshots(data: PipelineReportData, finding: DefectFinding): string {
  const verificationFile = data.pipeline.artifacts.verification;
  if (verificationFile === null) return '';
  const verificationDirectory = posix.dirname(verificationFile);
  const references = [
    ...finding.sourceScreenshotRefs,
    ...finding.attempts.flatMap((attempt) => attempt.screenshotRefs),
  ];
  const paths = references.flatMap((reference) => {
    const safe = safeRelativePath(verificationDirectory, reference);
    return safe === null ? [] : [safe];
  });
  if (paths.length === 0) return '';
  return `<details><summary>Screenshots (${String(paths.length)})</summary><ul>${paths
    .map((path) => `<li>${link(path)}</li>`)
    .join('')}</ul></details>`;
}

function findings(data: PipelineReportData): string {
  const items = data.verification?.findings ?? [];
  if (items.length === 0) return '<p>No defect findings were produced.</p>';
  return items
    .map(
      (finding) => `<article class="finding">
        <h3><code>${escapeHtml(finding.id)}</code> ${escapeHtml(finding.title)}</h3>
        <p><span class="badge ${statusClass(finding.verdict)}">${escapeHtml(finding.verdict)}</span>
        <span class="badge">${escapeHtml(finding.severity)}</span>
        <span class="badge">${escapeHtml(finding.confidence)}</span></p>
        <dl class="metrics">
          ${metric('Reproduction', `${String(finding.profile.matchingAttempts)}/${String(finding.profile.validAttempts)}`)}
          ${metric('Category', finding.category)}
          ${metric('Scenario', finding.scenarioId)}
        </dl>
        <p><strong>Expected:</strong> ${escapeHtml(finding.expected ?? 'not recorded')}</p>
        <p><strong>Actual:</strong> ${escapeHtml(finding.actual.join('; ') || 'not recorded')}</p>
        <p><strong>Associated evidence (correlation, not proven cause):</strong> ${escapeHtml(
          finding.evidence.summaries.join('; ') || 'none',
        )}</p>
        ${findingScreenshots(data, finding)}
      </article>`,
    )
    .join('');
}

function regressions(data: PipelineReportData): string {
  const manifest = data.manifest;
  if (manifest === null) return '<p>Regression generation was not completed.</p>';
  const generationDirectory = data.pipeline.artifacts.generation;
  return `<dl class="metrics">
    ${metric('Generated', manifest.summary.generated)}
    ${metric('Disabled/fixme', manifest.summary.generatedFixme)}
    ${metric('Review only', manifest.summary.reviewOnly)}
    ${metric('Unsupported', manifest.summary.unsupported)}
  </dl>
  <table><thead><tr><th>Finding</th><th>Status</th><th>Spec</th><th>SHA-256</th></tr></thead><tbody>${manifest.tests
    .map((entry) => {
      const spec =
        entry.file === null || generationDirectory === null
          ? '—'
          : link(`${generationDirectory}/${entry.file}`, entry.file);
      return `<tr><td>${escapeHtml(entry.findingId)}</td><td>${escapeHtml(entry.status)}</td><td>${spec}</td><td><code>${escapeHtml(entry.fileDigest ?? '—')}</code></td></tr>`;
    })
    .join('')}</tbody></table>`;
}

export class PipelineHtmlRenderer {
  public render(data: PipelineReportData): string {
    const { pipeline, exploration, plan, execution, verification } = data;
    const priorityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const scenario of plan?.scenarios ?? []) priorityCounts[scenario.priority] += 1;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
  <title>Agentic QA Pipeline — ${escapeHtml(pipeline.pipelineId)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 1100px; margin: 0 auto; padding: 2rem; line-height: 1.5; }
    h1, h2, h3 { line-height: 1.2; } section { margin: 2.5rem 0; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: .75rem; }
    .metric { border: 1px solid #8886; border-radius: .5rem; padding: .75rem; }
    dt { color: #777; font-size: .82rem; } dd { margin: .15rem 0 0; font-weight: 700; overflow-wrap: anywhere; }
    table { border-collapse: collapse; width: 100%; } th, td { border-bottom: 1px solid #8885; padding: .55rem; text-align: left; vertical-align: top; }
    code { overflow-wrap: anywhere; } .badge { display: inline-block; border: 1px solid #8888; border-radius: 999px; padding: .1rem .5rem; margin-right: .25rem; }
    .ok { color: #17833b; } .warn { color: #a56600; } .bad { color: #c52929; }
    .finding { border-left: .25rem solid #8887; padding-left: 1rem; margin: 1.5rem 0; }
    a { color: #2475c7; } footer { color: #777; margin-top: 3rem; font-size: .85rem; }
  </style>
</head>
<body>
  <header><h1>Agentic QA Pipeline Report</h1><p>Static deterministic report. JSON artifacts remain the source of truth.</p></header>
  <section><h2>Overview</h2><dl class="metrics">
    ${metric('Status', pipeline.status)}${metric('Target', pipeline.target)}${metric('Profile', pipeline.profile)}
    ${metric('Source run', pipeline.sourceRunId)}${metric('Pipeline', pipeline.pipelineId)}${metric('Version', pipeline.version)}
    ${metric('Started', pipeline.startedAt)}${metric('Completed', pipeline.completedAt)}${metric('Duration', `${String(pipeline.durationMs)} ms`)}
  </dl></section>
  <section><h2>Stages</h2><table><thead><tr><th>Stage</th><th>Status</th><th>Duration</th><th>Artifact</th><th>Error</th></tr></thead><tbody>${pipeline.stages
    .map(
      (stage) =>
        `<tr><td>${escapeHtml(stage.name)}</td><td class="${statusClass(stage.status)}">${escapeHtml(stage.status)}</td><td>${escapeHtml(stage.durationMs)} ms</td><td>${stage.artifact === null ? '—' : link(stage.artifact)}</td><td>${escapeHtml(stage.error ?? '—')}</td></tr>`,
    )
    .join('')}</tbody></table></section>
  <section><h2>Exploration</h2>${
    exploration === null
      ? '<p>Exploration did not start; no exploration artifact was created.</p>'
      : `<dl class="metrics">
    ${metric('Pages visited', exploration.summary.pagesVisited)}${metric('Pages failed', exploration.summary.pagesFailed)}
    ${metric('UI states', exploration.interactive.statesDiscovered)}${metric('Actions executed', exploration.interactive.actionsExecuted)}
    ${metric('Blocked actions', exploration.interactive.actionsBlocked)}${metric('Browser evidence', exploration.summary.consoleErrors + exploration.summary.pageErrors + exploration.summary.failedRequests + exploration.summary.httpErrors)}
  </dl>`
  }</section>
  <section><h2>Plan</h2>${
    plan === null
      ? '<p>Planning was not completed.</p>'
      : `<dl class="metrics">${metric('Scenarios', plan.scenarios.length)}${metric('Critical', priorityCounts.CRITICAL)}${metric('High', priorityCounts.HIGH)}${metric('Medium', priorityCounts.MEDIUM)}${metric('Low', priorityCounts.LOW)}${metric('Page coverage', `${String(plan.coverage.pages.covered)}/${String(plan.coverage.pages.total)}`)}</dl>`
  }</section>
  <section><h2>Execution</h2>${
    execution === null
      ? '<p>Execution was not completed.</p>'
      : `<dl class="metrics">${metric('PASS', execution.summary.passed)}${metric('FAIL', execution.summary.failed)}${metric('BLOCKED', execution.summary.blocked)}${metric('ERROR', execution.summary.errors)}${metric('SKIPPED', execution.summary.skipped)}</dl>`
  }</section>
  <section><h2>Verification</h2>${
    verification === null
      ? '<p>Verification was not completed.</p>'
      : `<dl class="metrics">${metric('Confirmed', verification.summary.confirmed)}${metric('Probable', verification.summary.probable)}${metric('Flaky', verification.summary.flaky)}${metric('Not reproduced', verification.summary.notReproduced)}${metric('Inconclusive', verification.summary.inconclusive)}</dl>`
  }</section>
  <section><h2>Findings</h2>${findings(data)}</section>
  <section><h2>Regressions</h2>${regressions(data)}</section>
  <footer>Generated deterministically by Agentic QA ${escapeHtml(pipeline.version)}. Captured application content is untrusted and HTML-escaped.</footer>
</body>
</html>\n`;
  }
}

export { escapeHtml as escapePipelineHtml, safeRelativePath as safeReportPath };
