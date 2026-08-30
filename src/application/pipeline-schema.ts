import { z } from 'zod';
import { PIPELINE_PROFILES, PIPELINE_STAGE_NAMES, type PipelineRun } from '../domain/pipeline.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const bounded = (maximum: number) => z.string().max(maximum);
const safeArtifact = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('~') &&
      !value.includes('://') &&
      value !== '..' &&
      !value.startsWith('../') &&
      !value.includes('/../') &&
      !value.includes('\\') &&
      !value.includes('\0'),
    'must be a safe relative artifact path',
  );

const stageSchema = z
  .object({
    name: z.enum(PIPELINE_STAGE_NAMES),
    status: z.enum(['PASS', 'COMPLETED_WITH_FINDINGS', 'FAILED', 'NOT_RUN']),
    startedAt: bounded(100).nullable(),
    completedAt: bounded(100).nullable(),
    durationMs: z.number().int().nonnegative(),
    artifact: safeArtifact.nullable(),
    summary: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    error: bounded(1_000).nullable(),
  })
  .strict();

const commonPipelineFields = {
  pipelineId: identifier,
  sourceRunId: identifier,
  target: bounded(4_000),
  profile: z.enum(PIPELINE_PROFILES),
  provider: z.literal('openai-compatible'),
  model: bounded(200),
  startedAt: bounded(100),
  completedAt: bounded(100),
  durationMs: z.number().int().nonnegative(),
  status: z.enum([
    'COMPLETE_NO_DEFECTS',
    'COMPLETE_WITH_FINDINGS',
    'COMPLETE_WITH_REGRESSIONS',
    'FAILED',
  ]),
  stages: z.array(stageSchema).length(5),
  warnings: z.array(bounded(2_000)).max(200),
} as const;

const artifactFields = {
  pipeline: z.literal('pipeline.json'),
  report: z.literal('report.html'),
  plan: safeArtifact.nullable(),
  execution: safeArtifact.nullable(),
  verification: safeArtifact.nullable(),
  findings: safeArtifact.nullable(),
  generation: safeArtifact.nullable(),
  manifest: safeArtifact.nullable(),
} as const;

const legacyPipelineSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    ...commonPipelineFields,
    version: z.literal('0.8.0'),
    artifacts: z.object({ ...artifactFields, exploration: safeArtifact }).strict(),
  })
  .strict();

const currentPipelineSchema = z
  .object({
    schemaVersion: z.literal('1.1'),
    ...commonPipelineFields,
    version: z.enum(['0.9.0', '1.0.0']),
    artifacts: z.object({ ...artifactFields, exploration: safeArtifact.nullable() }).strict(),
  })
  .strict();

const pipelineSchema = z
  .discriminatedUnion('schemaVersion', [legacyPipelineSchema, currentPipelineSchema])
  .refine(
    (value) => value.stages.every((stage, index) => stage.name === PIPELINE_STAGE_NAMES[index]),
    { message: 'pipeline stages must use canonical order', path: ['stages'] },
  )
  .superRefine((value, context) => {
    const issue = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: 'custom', path, message });
    };
    const directArtifacts = [
      value.artifacts.exploration,
      value.artifacts.plan,
      value.artifacts.execution,
      value.artifacts.verification,
      value.artifacts.manifest,
    ];
    value.stages.forEach((stage, index) => {
      if (stage.artifact !== directArtifacts[index]) {
        issue(['stages', index, 'artifact'], 'does not match the canonical artifact reference');
      }
      if (stage.status === 'NOT_RUN') {
        if (
          stage.startedAt !== null ||
          stage.completedAt !== null ||
          stage.durationMs !== 0 ||
          stage.artifact !== null ||
          stage.error !== null ||
          Object.keys(stage.summary).length !== 0
        ) {
          issue(['stages', index], 'NOT_RUN stages must not contain execution metadata');
        }
      } else if (stage.startedAt === null || stage.completedAt === null) {
        issue(['stages', index], 'completed or failed stages require timestamps');
      }
      if (stage.status !== 'FAILED' && stage.error !== null) {
        issue(['stages', index, 'error'], 'is allowed only for a failed stage');
      }
    });

    const failedIndex = value.stages.findIndex((stage) => stage.status === 'FAILED');
    if (failedIndex >= 0) {
      if (
        value.status !== 'FAILED' ||
        value.stages.slice(0, failedIndex).some((stage) => stage.status === 'NOT_RUN') ||
        !value.stages.slice(failedIndex + 1).every((stage) => stage.status === 'NOT_RUN')
      ) {
        issue(['status'], 'a failed stage requires FAILED status and all later stages NOT_RUN');
      }
    } else if (
      value.status === 'FAILED' ||
      value.stages.some((stage) => stage.status === 'NOT_RUN')
    ) {
      issue(['status'], 'a non-failed pipeline must have every stage completed');
    }

    const findings = value.artifacts.verification?.replace(/verification\.json$/, 'findings.json');
    if (value.artifacts.findings !== (findings ?? null)) {
      issue(['artifacts', 'findings'], 'does not match the verification artifact directory');
    }
    const manifest =
      value.artifacts.generation === null
        ? null
        : `${value.artifacts.generation.replace(/\/$/, '')}/manifest.json`;
    if (value.artifacts.manifest !== manifest) {
      issue(['artifacts', 'manifest'], 'does not match the generation artifact directory');
    }

    if (value.artifacts.exploration === null) {
      const laterArtifacts = [
        value.artifacts.plan,
        value.artifacts.execution,
        value.artifacts.verification,
        value.artifacts.findings,
        value.artifacts.generation,
        value.artifacts.manifest,
      ];
      const stagesValid =
        value.status === 'FAILED' &&
        value.stages[0]?.status === 'FAILED' &&
        value.stages.slice(1).every((stage) => stage.status === 'NOT_RUN');
      if (!stagesValid || laterArtifacts.some((artifact) => artifact !== null)) {
        issue(
          ['artifacts', 'exploration'],
          'may be null only for a failed exploration with no downstream artifacts',
        );
      }
    }
  });

export class SavedPipelineValidationError extends Error {
  public constructor(public readonly validationErrors: readonly string[]) {
    super(`The saved pipeline is invalid: ${validationErrors.join('; ')}`);
    this.name = 'SavedPipelineValidationError';
  }
}

export function parseSavedPipeline(value: unknown): PipelineRun {
  const parsed = pipelineSchema.safeParse(value);
  if (!parsed.success) {
    throw new SavedPipelineValidationError(
      parsed.error.issues.slice(0, 40).map((issue) => {
        const path = issue.path.length === 0 ? 'pipeline' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}
