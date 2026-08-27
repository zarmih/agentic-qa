import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ArtifactWriteError } from '../application/errors.js';
import type {
  ArtifactStore,
  ExplorationArtifactLocations,
  ExplorationArtifactStore,
} from '../application/ports.js';
import type { ExplorationResult } from '../domain/exploration.js';
import type { InspectionResult } from '../domain/inspection.js';

function safeRunDirectory(rootDirectory: string, runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new ArtifactWriteError(rootDirectory, new Error('Unsafe run ID'));
  }
  return join(rootDirectory, runId);
}

export class FileArtifactStore implements ArtifactStore, ExplorationArtifactStore {
  public constructor(private readonly rootDirectory: string) {}

  public async prepare(runId: string): Promise<string> {
    const runDirectory = safeRunDirectory(this.rootDirectory, runId);
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await mkdir(runDirectory);
      return runDirectory;
    } catch (error) {
      throw new ArtifactWriteError(runDirectory, error);
    }
  }

  public async save(runId: string, result: InspectionResult, screenshot: Buffer): Promise<void> {
    const runDirectory = safeRunDirectory(this.rootDirectory, runId);
    try {
      await Promise.all([
        writeFile(
          join(runDirectory, 'result.json'),
          `${JSON.stringify(result, null, 2)}\n`,
          'utf8',
        ),
        writeFile(join(runDirectory, 'page.png'), screenshot),
      ]);
    } catch (error) {
      throw new ArtifactWriteError(runDirectory, error);
    }
  }

  public async prepareExploration(
    runId: string,
    interactive = false,
  ): Promise<ExplorationArtifactLocations> {
    const runDirectory = safeRunDirectory(this.rootDirectory, runId);
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await mkdir(runDirectory);
      await mkdir(join(runDirectory, 'pages'));
      if (interactive) await mkdir(join(runDirectory, 'states'));
      return { directory: runDirectory, tracePath: join(runDirectory, 'trace.zip') };
    } catch (error) {
      throw new ArtifactWriteError(runDirectory, error);
    }
  }

  public async saveStateScreenshot(
    runId: string,
    filename: string,
    screenshot: Buffer,
  ): Promise<void> {
    const statesDirectory = join(safeRunDirectory(this.rootDirectory, runId), 'states');
    if (basename(filename) !== filename || !/^state-\d{3,}\.png$/.test(filename)) {
      throw new ArtifactWriteError(join(statesDirectory, filename), new Error('Unsafe filename'));
    }
    try {
      await writeFile(join(statesDirectory, filename), screenshot);
    } catch (error) {
      throw new ArtifactWriteError(statesDirectory, error);
    }
  }

  public async savePageScreenshot(
    runId: string,
    filename: string,
    screenshot: Buffer,
  ): Promise<void> {
    const pagesDirectory = join(safeRunDirectory(this.rootDirectory, runId), 'pages');
    if (basename(filename) !== filename || !/^\d{3,}-[a-z0-9-]+\.png$/.test(filename)) {
      throw new ArtifactWriteError(join(pagesDirectory, filename), new Error('Unsafe filename'));
    }
    try {
      await writeFile(join(pagesDirectory, filename), screenshot);
    } catch (error) {
      throw new ArtifactWriteError(pagesDirectory, error);
    }
  }

  public async saveExploration(runId: string, result: ExplorationResult): Promise<void> {
    const runDirectory = safeRunDirectory(this.rootDirectory, runId);
    try {
      const writes = [
        writeFile(
          join(runDirectory, 'exploration.json'),
          `${JSON.stringify(result, null, 2)}\n`,
          'utf8',
        ),
        writeFile(
          join(runDirectory, 'graph.json'),
          `${JSON.stringify(result.graph, null, 2)}\n`,
          'utf8',
        ),
      ];
      if (result.stateGraph !== null) {
        writes.push(
          writeFile(
            join(runDirectory, 'state-graph.json'),
            `${JSON.stringify(result.stateGraph, null, 2)}\n`,
            'utf8',
          ),
        );
      }
      await Promise.all(writes);
    } catch (error) {
      throw new ArtifactWriteError(runDirectory, error);
    }
  }
}
