import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ArtifactWriteError, ExecutionSourceError } from '../application/errors.js';
import type {
  ExecutionArtifactLocations,
  ExecutionArtifactReader,
  ExecutionArtifactWriter,
  LoadedExecutionArtifacts,
} from '../application/execution-ports.js';
import { parseSavedQaPlan, SavedPlanValidationError } from '../application/planning-schema.js';
import type { ExecutionRun } from '../domain/execution.js';
import type { ExplorationGraph } from '../domain/exploration.js';
import type { StateGraph } from '../domain/interaction.js';
import type { PlanningObservation } from '../domain/planning.js';
import { FilePlanningArtifacts } from './file-planning-artifacts.js';

const MAX_PLAN_BYTES = 5 * 1024 * 1024;
const MAX_SUPPORTING_ARTIFACT_BYTES = 50 * 1024 * 1024;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;

async function readJson(path: string, maximumBytes: number, label: string): Promise<unknown> {
  let contents: string;
  try {
    const fileStats = await stat(path);
    if (!fileStats.isFile()) throw new Error('Path is not a file');
    if (fileStats.size > maximumBytes) {
      throw new ExecutionSourceError(`${label} exceeds its safety size limit.`);
    }
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof ExecutionSourceError) throw error;
    throw new ExecutionSourceError(`Could not read ${label} at "${path}".`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new ExecutionSourceError(`${label} is not valid JSON.`);
  }
}

function standardExplorationPath(planFile: string): string {
  const planningDirectory = dirname(planFile);
  if (basename(planFile) !== 'qa-plan.json' || basename(planningDirectory) !== 'planning') {
    throw new ExecutionSourceError(
      'Could not infer exploration.json from this plan path. Use --exploration <path> explicitly.',
    );
  }
  return join(dirname(planningDirectory), 'exploration.json');
}

function safeExecutionDirectory(runDirectory: string, executionId: string): string {
  if (!SAFE_IDENTIFIER.test(executionId)) {
    throw new ArtifactWriteError(runDirectory, new Error('Unsafe execution ID'));
  }
  return join(runDirectory, 'executions', executionId);
}

export class FileExecutionArtifacts implements ExecutionArtifactReader, ExecutionArtifactWriter {
  private readonly explorations = new FilePlanningArtifacts();

  public async loadExecutionInput(
    planPath: string,
    explorationOverride?: string,
  ): Promise<LoadedExecutionArtifacts> {
    const planFile = resolve(planPath);
    const rawPlan = await readJson(planFile, MAX_PLAN_BYTES, 'QA plan');
    let plan;
    try {
      plan = parseSavedQaPlan(rawPlan);
    } catch (error) {
      if (error instanceof SavedPlanValidationError) {
        throw new ExecutionSourceError(error.message);
      }
      throw error;
    }
    const explorationFile =
      explorationOverride === undefined
        ? standardExplorationPath(planFile)
        : resolve(explorationOverride);
    const loadedExploration = await this.explorations.loadExploration(explorationFile);
    const planningDirectory = dirname(planFile);
    const [observation, standaloneGraph, standaloneStateGraph] = await Promise.all([
      readJson(
        join(planningDirectory, 'observation.json'),
        MAX_SUPPORTING_ARTIFACT_BYTES,
        'planning observation',
      ),
      readJson(
        join(loadedExploration.runDirectory, 'graph.json'),
        MAX_SUPPORTING_ARTIFACT_BYTES,
        'application graph',
      ),
      readJson(
        join(loadedExploration.runDirectory, 'state-graph.json'),
        MAX_SUPPORTING_ARTIFACT_BYTES,
        'UI state graph',
      ),
    ]);
    return {
      plan,
      exploration: loadedExploration.exploration,
      observation: observation as PlanningObservation,
      standaloneGraph: standaloneGraph as ExplorationGraph,
      standaloneStateGraph: standaloneStateGraph as StateGraph,
      planFile,
      explorationFile: loadedExploration.sourceFile,
      runDirectory: loadedExploration.runDirectory,
    };
  }

  public async prepareExecution(
    runDirectory: string,
    executionId: string,
  ): Promise<ExecutionArtifactLocations> {
    const directory = safeExecutionDirectory(runDirectory, executionId);
    try {
      await mkdir(join(runDirectory, 'executions'), { recursive: true });
      await mkdir(directory);
      await mkdir(join(directory, 'screenshots'));
      return { directory, tracePath: join(directory, 'trace.zip') };
    } catch (error) {
      throw new ArtifactWriteError(directory, error);
    }
  }

  public async saveExecutionScreenshot(
    runDirectory: string,
    executionId: string,
    scenarioId: string,
    filename: string,
    screenshot: Buffer,
  ): Promise<string> {
    if (!SAFE_IDENTIFIER.test(scenarioId) || !/^\d{3}(?:-[a-z]+)?\.png$/.test(filename)) {
      throw new ArtifactWriteError(runDirectory, new Error('Unsafe execution screenshot path'));
    }
    const relative = join('screenshots', scenarioId, filename);
    const directory = join(
      safeExecutionDirectory(runDirectory, executionId),
      'screenshots',
      scenarioId,
    );
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, filename), screenshot);
      return relative;
    } catch (error) {
      throw new ArtifactWriteError(directory, error);
    }
  }

  public async saveExecution(
    runDirectory: string,
    executionId: string,
    result: ExecutionRun,
    markdown: string,
  ): Promise<void> {
    const directory = safeExecutionDirectory(runDirectory, executionId);
    try {
      await Promise.all([
        this.atomicWrite(join(directory, 'execution.json'), `${JSON.stringify(result, null, 2)}\n`),
        this.atomicWrite(join(directory, 'execution.md'), markdown),
      ]);
    } catch (error) {
      throw new ArtifactWriteError(directory, error);
    }
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
