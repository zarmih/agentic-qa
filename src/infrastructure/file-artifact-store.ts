import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactWriteError } from '../application/errors.js';
import type { ArtifactStore } from '../application/ports.js';
import type { InspectionResult } from '../domain/inspection.js';

export class FileArtifactStore implements ArtifactStore {
  public constructor(private readonly rootDirectory: string) {}

  public async prepare(runId: string): Promise<string> {
    const runDirectory = join(this.rootDirectory, runId);
    try {
      await mkdir(this.rootDirectory, { recursive: true });
      await mkdir(runDirectory);
      return runDirectory;
    } catch (error) {
      throw new ArtifactWriteError(runDirectory, error);
    }
  }

  public async save(runId: string, result: InspectionResult, screenshot: Buffer): Promise<void> {
    const runDirectory = join(this.rootDirectory, runId);
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
}
