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

const pipelineSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    pipelineId: identifier,
    sourceRunId: identifier,
    target: bounded(4_000),
    profile: z.enum(PIPELINE_PROFILES),
    provider: z.literal('openai-compatible'),
    model: bounded(200),
    version: z.literal('0.8.0'),
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
    artifacts: z
      .object({
        pipeline: z.literal('pipeline.json'),
        report: z.literal('report.html'),
        exploration: safeArtifact,
        plan: safeArtifact.nullable(),
        execution: safeArtifact.nullable(),
        verification: safeArtifact.nullable(),
        findings: safeArtifact.nullable(),
        generation: safeArtifact.nullable(),
        manifest: safeArtifact.nullable(),
      })
      .strict(),
    warnings: z.array(bounded(2_000)).max(200),
  })
  .strict()
  .refine(
    (value) => value.stages.every((stage, index) => stage.name === PIPELINE_STAGE_NAMES[index]),
    { message: 'pipeline stages must use canonical order', path: ['stages'] },
  );

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
