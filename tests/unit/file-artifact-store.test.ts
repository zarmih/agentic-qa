import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactWriteError } from '../../src/application/errors.js';
import { FileArtifactStore } from '../../src/infrastructure/file-artifact-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function store(): Promise<FileArtifactStore> {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-qa-artifacts-unit-'));
  temporaryDirectories.push(directory);
  return new FileArtifactStore(directory);
}

describe('FileArtifactStore path safety', () => {
  it('rejects a run ID that could escape the artifact root', async () => {
    await expect((await store()).prepareExploration('../outside')).rejects.toBeInstanceOf(
      ArtifactWriteError,
    );
  });

  it('rejects a screenshot filename containing path traversal', async () => {
    const artifacts = await store();
    await artifacts.prepareExploration('run-1');
    await expect(
      artifacts.savePageScreenshot('run-1', '../escape.png', Buffer.from('png')),
    ).rejects.toBeInstanceOf(ArtifactWriteError);
  });

  it('creates the state directory only for interactive runs and protects state filenames', async () => {
    const artifacts = await store();
    await artifacts.prepareExploration('run-interactive', true);
    await expect(
      artifacts.saveStateScreenshot('run-interactive', '../state-001.png', Buffer.from('png')),
    ).rejects.toBeInstanceOf(ArtifactWriteError);
    await expect(
      artifacts.saveStateScreenshot('run-interactive', 'state-001.png', Buffer.from('png')),
    ).resolves.toBeUndefined();
  });
});
