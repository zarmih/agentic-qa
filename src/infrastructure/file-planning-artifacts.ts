import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ArtifactWriteError, PlanningSourceError } from '../application/errors.js';
import type {
  LoadedExplorationArtifact,
  PlanningArtifactReader,
  PlanningArtifactWriter,
} from '../application/planning-ports.js';
import type { ExplorationResult } from '../domain/exploration.js';
import type { PlanningObservation, QaPlan } from '../domain/planning.js';
import { redactSensitiveText } from './sensitive-data.js';

const MAX_EXPLORATION_FILE_BYTES = 50 * 1024 * 1024;

const consoleEvidenceSchema = z.object({
  type: z.enum(['error', 'warning']),
  message: z.string(),
  pageUrl: z.string(),
  timestamp: z.string(),
});
const pageErrorSchema = z.object({
  message: z.string(),
  pageUrl: z.string(),
  timestamp: z.string(),
});
const failedRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  resourceType: z.string(),
  failureReason: z.string(),
  pageUrl: z.string(),
  timestamp: z.string(),
});
const httpErrorSchema = z.object({
  status: z.number().int(),
  method: z.string(),
  url: z.string(),
  resourceType: z.string(),
  pageUrl: z.string(),
  timestamp: z.string(),
});
const browserEvidenceSchema = z.object({
  console: z.array(consoleEvidenceSchema).max(10_000),
  pageErrors: z.array(pageErrorSchema).max(10_000),
  failedRequests: z.array(failedRequestSchema).max(10_000),
  httpErrors: z.array(httpErrorSchema).max(10_000),
});
const pageSchema = z.object({
  id: z.string(),
  requestedUrl: z.string(),
  finalUrl: z.string(),
  title: z.string(),
  status: z.number().int().nullable(),
  state: z.enum(['visited', 'failed']),
  depth: z.number().int().nonnegative(),
  discoveryOrder: z.number().int().positive(),
  elements: z.object({
    links: z.number().int().nonnegative(),
    buttons: z.number().int().nonnegative(),
    inputs: z.number().int().nonnegative(),
    forms: z.number().int().nonnegative(),
    headings: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()).max(10_000),
});
const navigationEdgeSchema = z.object({
  id: z.string(),
  sourcePageId: z.string(),
  targetPageId: z.string().nullable(),
  targetUrl: z.string().nullable(),
  hint: z.string(),
  scope: z.string(),
  visited: z.boolean(),
});
const stateSchema = z.object({
  id: z.string(),
  pageId: z.string(),
  url: z.string(),
  title: z.string(),
  depth: z.number().int().nonnegative(),
  metadata: z.object({
    headings: z.array(z.string()).max(1_000),
    dialogs: z.array(z.string()).max(1_000),
    visibleControls: z.array(z.string()).max(10_000),
  }),
});
const candidateSchema = z.object({
  id: z.string(),
  tag: z.string(),
  accessibleName: z.string(),
});
const interactionEvidenceSchema = z.object({
  browser: browserEvidenceSchema,
  dialogs: z.array(z.object({ type: z.string(), message: z.string() })).max(10_000),
  popups: z.array(z.object({ url: z.string(), scope: z.string() })).max(10_000),
  downloads: z.array(z.object({ url: z.string(), suggestedFilename: z.string() })).max(10_000),
});
const actionEdgeSchema = z.object({
  id: z.string(),
  sourceStateId: z.string(),
  targetStateId: z.string().nullable(),
  action: z.object({
    actionType: z.literal('click'),
    accessibleName: z.string(),
    role: z.string(),
  }),
  risk: z.literal('SAFE'),
  outcome: z.string(),
  urlChanged: z.boolean(),
  evidence: interactionEvidenceSchema,
});
const safetyAuditSchema = z.object({
  id: z.string(),
  stateId: z.string(),
  candidate: candidateSchema,
  classification: z.enum(['SAFE', 'CAUTION', 'DESTRUCTIVE', 'UNKNOWN']),
  executed: z.boolean(),
  reason: z.string(),
  actionId: z.string().nullable(),
});
const actionFailureSchema = z.object({
  actionId: z.string(),
  stateId: z.string(),
  candidateId: z.string(),
  reason: z.string(),
  timeout: z.boolean(),
});
const explorationArtifactSchema = z.object({
  schemaVersion: z.literal('3.0'),
  runId: z.string().min(1).max(128),
  startUrl: z.string(),
  graph: z.object({
    nodes: z.array(pageSchema).max(5_000),
    edges: z.array(navigationEdgeSchema).max(20_000),
  }),
  stateGraph: z
    .object({
      nodes: z.array(stateSchema).max(5_000),
      edges: z.array(actionEdgeSchema).max(20_000),
      safetyAudit: z.array(safetyAuditSchema).max(50_000),
      failures: z.array(actionFailureSchema).max(20_000),
    })
    .nullable(),
  evidence: browserEvidenceSchema,
});

export class FilePlanningArtifacts implements PlanningArtifactReader, PlanningArtifactWriter {
  public constructor(private readonly sensitiveValues: readonly string[] = []) {}

  public async loadExploration(pathValue: string): Promise<LoadedExplorationArtifact> {
    const sourceFile = resolve(pathValue);
    let contents: string;
    try {
      const fileStats = await stat(sourceFile);
      if (!fileStats.isFile()) throw new Error('Path is not a file');
      if (fileStats.size > MAX_EXPLORATION_FILE_BYTES) {
        throw new PlanningSourceError('The exploration artifact exceeds the 50 MiB safety limit.');
      }
      contents = await readFile(sourceFile, 'utf8');
    } catch (error) {
      if (error instanceof PlanningSourceError) throw error;
      throw new PlanningSourceError(`Could not read exploration artifact "${sourceFile}".`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new PlanningSourceError('The exploration artifact is not valid JSON.');
    }
    const validation = explorationArtifactSchema.safeParse(parsed);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      const location = issue?.path.join('.') ?? 'artifact';
      throw new PlanningSourceError(`The exploration artifact is incompatible at ${location}.`);
    }
    return {
      exploration: parsed as ExplorationResult,
      sourceFile,
      runDirectory: dirname(sourceFile),
    };
  }

  public async saveObservation(
    runDirectory: string,
    observation: PlanningObservation,
  ): Promise<string> {
    const planningDirectory = join(runDirectory, 'planning');
    try {
      await mkdir(planningDirectory, { recursive: true });
      await this.atomicWrite(
        join(planningDirectory, 'observation.json'),
        this.safeJson(observation),
      );
      return planningDirectory;
    } catch (error) {
      throw new ArtifactWriteError(planningDirectory, error);
    }
  }

  public async savePlan(runDirectory: string, plan: QaPlan, markdown: string): Promise<string> {
    const planningDirectory = join(runDirectory, 'planning');
    try {
      await mkdir(planningDirectory, { recursive: true });
      await Promise.all([
        this.atomicWrite(join(planningDirectory, 'qa-plan.json'), this.safeJson(plan)),
        this.atomicWrite(
          join(planningDirectory, 'qa-plan.md'),
          redactSensitiveText(markdown, this.sensitiveValues),
        ),
      ]);
      return planningDirectory;
    } catch (error) {
      throw new ArtifactWriteError(planningDirectory, error);
    }
  }

  private safeJson(value: unknown): string {
    return `${redactSensitiveText(JSON.stringify(value, null, 2), this.sensitiveValues)}\n`;
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporaryPath = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, contents, 'utf8');
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
