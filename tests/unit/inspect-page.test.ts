import { describe, expect, it, vi } from 'vitest';
import { InspectPage } from '../../src/application/inspect-page.js';
import type {
  ArtifactStore,
  BrowserInspector,
  Clock,
  RunIdGenerator,
} from '../../src/application/ports.js';

function harness(status: number | null = 200) {
  const inspect = vi.fn<BrowserInspector['inspect']>().mockResolvedValue({
    page: {
      url: 'https://example.test/final',
      title: 'Controlled page',
      status,
      viewport: { width: 1000, height: 700 },
      elements: { links: 2, buttons: 1, inputs: 1, forms: 1, headings: 2 },
    },
    screenshot: Buffer.from('png'),
  });
  const prepare = vi.fn<ArtifactStore['prepare']>().mockResolvedValue('/runs/run-1');
  const save = vi.fn<ArtifactStore['save']>().mockResolvedValue(undefined);
  const times = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:01.250Z')];
  const clock: Clock = { now: () => times.shift() ?? new Date('2026-01-01T00:00:01.250Z') };
  const runIds: RunIdGenerator = { next: () => 'run-1' };
  const browser: BrowserInspector = { inspect };
  const artifacts: ArtifactStore = { prepare, save };

  return { useCase: new InspectPage(browser, artifacts, runIds, clock), inspect, prepare, save };
}

const options = {
  headless: true,
  navigationTimeoutMs: 10_000,
  viewport: { width: 1000, height: 700 },
};

describe('InspectPage', () => {
  it('coordinates inspection and persists a structured result', async () => {
    const { useCase, inspect, prepare, save } = harness();
    const outcome = await useCase.execute('https://example.test', options);

    expect(prepare).toHaveBeenCalledWith('run-1');
    expect(inspect).toHaveBeenCalledWith({ url: 'https://example.test/', ...options });
    expect(outcome.result).toMatchObject({
      schemaVersion: '1.0',
      runId: 'run-1',
      requestedUrl: 'https://example.test/',
      durationMs: 1250,
      artifacts: { screenshot: 'page.png' },
      warnings: [],
    });
    expect(save).toHaveBeenCalledWith('run-1', outcome.result, Buffer.from('png'));
  });

  it('records an HTTP error as an inspectable warning', async () => {
    const { useCase } = harness(503);
    const outcome = await useCase.execute('https://example.test', options);
    expect(outcome.result.warnings).toEqual(['The main document returned HTTP 503.']);
  });

  it('does not open the browser when artifact preparation fails', async () => {
    const { useCase, prepare, inspect } = harness();
    prepare.mockRejectedValueOnce(new Error('read-only'));
    await expect(useCase.execute('https://example.test', options)).rejects.toThrow('read-only');
    expect(inspect).not.toHaveBeenCalled();
  });
});
