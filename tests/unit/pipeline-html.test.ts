import { describe, expect, it } from 'vitest';
import type { PipelineReportData } from '../../src/application/pipeline-ports.js';
import type { PipelineRun } from '../../src/domain/pipeline.js';
import {
  PipelineHtmlRenderer,
  escapePipelineHtml,
  safeReportPath,
} from '../../src/reporting/pipeline-html.js';
import { regressionSourceFixture } from '../fixtures/regression-fixtures.js';

function pipeline(sourceRunId: string): PipelineRun {
  return {
    schemaVersion: '1.0',
    pipelineId: `pipeline-${sourceRunId}`,
    sourceRunId,
    target: 'http://fixture.test/<img src=x onerror=alert(1)>',
    profile: 'standard',
    provider: 'openai-compatible',
    model: 'fixture-model',
    version: '0.8.0',
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    durationMs: 1_000,
    status: 'COMPLETE_WITH_FINDINGS',
    stages: ['explore', 'plan', 'run', 'verify', 'generate'].map((name) => ({
      name: name as PipelineRun['stages'][number]['name'],
      status: 'PASS' as const,
      startedAt: '2026-08-29T00:00:00.000Z',
      completedAt: '2026-08-29T00:00:01.000Z',
      durationMs: 100,
      artifact: `${name}.json`,
      summary: {},
      error: null,
    })),
    artifacts: {
      pipeline: 'pipeline.json',
      report: 'report.html',
      exploration: 'exploration.json',
      plan: 'planning/qa-plan.json',
      execution: 'executions/exec-fixture/execution.json',
      verification: 'verifications/verify-regression-fixture/verification.json',
      findings: 'verifications/verify-regression-fixture/findings.json',
      generation: null,
      manifest: null,
    },
    warnings: [],
  };
}

describe('PipelineHtmlRenderer', () => {
  it('escapes all captured text, uses a strict CSP, and emits no script or external resource', () => {
    const source = regressionSourceFixture('confirmed');
    const originalFinding = source.verification.findings[0];
    if (originalFinding === undefined) throw new Error('Expected a fixture finding.');
    const finding = {
      ...originalFinding,
      title: '</style><script>alert("x")</script><img onerror=alert(2)>',
      evidence: {
        ...originalFinding.evidence,
        summaries: ['${dangerousExpression}', '<svg onload=alert(3)>'],
      },
    };
    const data: PipelineReportData = {
      pipeline: pipeline(source.findings.sourceRunId),
      exploration: source.verificationSource.executionInput.exploration,
      plan: source.verificationSource.executionInput.plan,
      execution: source.verificationSource.execution,
      verification: { ...source.verification, findings: [finding] },
      manifest: null,
    };
    const html = new PipelineHtmlRenderer().render(data);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img onerror=alert(2)&gt;');
    expect(html).toContain('&lt;svg onload=alert(3)&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).not.toMatch(/<link|https:\/\/cdn|src="https?:/i);
    expect(html).not.toMatch(
      /<(?:script|img|link|iframe|source)[^>]+(?:src|href)\s*=\s*["']https?:/i,
    );
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']file:/i);
    expect(html).not.toContain('/Users/');
  });

  it('escapes all five HTML-significant characters', () => {
    expect(escapePipelineHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('renders an early exploration failure without requiring a missing artifact', () => {
    const failedPipeline: PipelineRun = {
      ...pipeline('run-failed'),
      schemaVersion: '1.1',
      version: '0.9.0',
      status: 'FAILED',
      artifacts: {
        ...pipeline('run-failed').artifacts,
        exploration: null,
        plan: null,
        execution: null,
        verification: null,
        findings: null,
        generation: null,
        manifest: null,
      },
    };
    const html = new PipelineHtmlRenderer().render({
      pipeline: failedPipeline,
      exploration: null,
      plan: null,
      execution: null,
      verification: null,
      manifest: null,
    });
    expect(html).toContain('Exploration did not start');
    expect(html).not.toContain('exploration.json');
  });

  it.each([
    ['/absolute'],
    ['../outside'],
    ['safe', '../../outside'],
    ['safe\\outside'],
    ['https://outside.example/x'],
    ['safe\0outside'],
  ])('rejects unsafe report link parts %j', (...parts) => {
    expect(safeReportPath(...parts)).toBeNull();
  });

  it('normalizes safe relative artifact paths', () => {
    expect(safeReportPath('verifications/v1', 'attempts/a/../b/screenshot.png')).toBe(
      'verifications/v1/attempts/b/screenshot.png',
    );
  });
});
