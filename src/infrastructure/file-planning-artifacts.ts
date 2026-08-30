import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ArtifactWriteError, PlanningSourceError } from '../application/errors.js';
import {
  parseSavedExploration,
  SavedExplorationValidationError,
} from '../application/exploration-schema.js';
import type {
  LoadedExplorationArtifact,
  PlanningArtifactReader,
  PlanningArtifactWriter,
} from '../application/planning-ports.js';
import type { PlanningObservation, QaPlan } from '../domain/planning.js';
import { redactSensitiveText } from './sensitive-data.js';

const MAX_EXPLORATION_FILE_BYTES = 50 * 1024 * 1024;

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
    let exploration;
    try {
      exploration = parseSavedExploration(parsed);
    } catch (error) {
      if (error instanceof SavedExplorationValidationError) {
        throw new PlanningSourceError(error.message);
      }
      throw error;
    }
    return {
      exploration,
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
