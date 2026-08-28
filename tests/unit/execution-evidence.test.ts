import { describe, expect, it } from 'vitest';
import {
  EvidenceReproductionMatcher,
  ExecutionEvidenceCollector,
} from '../../src/application/execution-evidence.js';
import type { PlanningEvidenceObservation } from '../../src/domain/planning.js';

const timestamp = '2026-08-28T00:00:00.000Z';

describe('execution evidence', () => {
  it('normalizes and attributes runtime browser evidence', () => {
    const collector = new ExecutionEvidenceCollector();
    const refs = collector.append(
      {
        browser: {
          console: [{ type: 'error', message: 'Boom', pageUrl: 'http://fixture/', timestamp }],
          pageErrors: [],
          failedRequests: [
            {
              method: 'GET',
              url: 'http://fixture/api',
              resourceType: 'fetch',
              failureReason: 'net::ERR_FAILED',
              pageUrl: 'http://fixture/',
              timestamp,
            },
          ],
          httpErrors: [
            {
              status: 500,
              method: 'GET',
              url: 'http://fixture/api',
              resourceType: 'fetch',
              pageUrl: 'http://fixture/',
              timestamp,
            },
          ],
        },
        dialogs: [],
        popups: [],
        downloads: [],
      },
      {
        executionId: 'exec-1',
        scenarioId: 'scenario-1',
        stepId: 'step-1',
        pageId: 'page-001',
        sourceStateId: 'state-001',
        actualStateId: 'state-002',
        actualUrl: 'http://fixture/',
      },
    );

    expect(refs).toHaveLength(3);
    expect(collector.all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'HTTP_ERROR',
          scenarioId: 'scenario-1',
          stepId: 'step-1',
          status: 500,
        }),
      ]),
    );
  });

  it('matches source evidence exactly and marks unsupported comparisons not evaluated', () => {
    const runtime = [
      {
        id: 'runtime-1',
        executionId: 'exec-1',
        kind: 'CONSOLE_ERROR' as const,
        timestamp,
        scenarioId: 'scenario-1',
        stepId: 'step-1',
        pageId: 'page-001',
        sourceStateId: null,
        actualStateId: null,
        url: 'http://fixture/',
        message: '  Help   failed ',
        method: null,
        status: null,
        resourceType: null,
      },
    ];
    const source = new Map<string, PlanningEvidenceObservation>([
      [
        'console-error-001',
        {
          id: 'console-error-001',
          kind: 'CONSOLE_ERROR',
          severity: 'ERROR',
          summary: 'help failed',
          pageId: 'page-001',
          stateId: null,
          actionId: null,
        },
      ],
      [
        'action-failure-001',
        {
          id: 'action-failure-001',
          kind: 'ACTION_FAILURE',
          severity: 'ERROR',
          summary: 'unstable action',
          pageId: 'page-001',
          stateId: 'state-001',
          actionId: 'action-0001',
        },
      ],
    ]);
    expect(
      new EvidenceReproductionMatcher().match(
        ['console-error-001', 'action-failure-001'],
        source,
        runtime,
      ),
    ).toEqual([
      {
        sourceEvidenceRef: 'console-error-001',
        status: 'REPRODUCED',
        executionEvidenceRefs: ['runtime-1'],
      },
      {
        sourceEvidenceRef: 'action-failure-001',
        status: 'NOT_EVALUATED',
        executionEvidenceRefs: [],
      },
    ]);
  });
});
