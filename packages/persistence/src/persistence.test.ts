import os from 'node:os';
import path from 'node:path';

import fs from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { JsonFileStore, appendJsonLine, readJsonLines } from './index';

describe('JsonFileStore', () => {
  it('reads and updates structured state on disk', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-persist-'));
    const store = new JsonFileStore(path.join(dataRoot, 'state.json'), {
      counter: 0
    });

    const initial = await store.read();
    const updated = await store.update((current) => ({
      counter: current.counter + 1
    }));

    expect(initial.counter).toBe(0);
    expect(updated.counter).toBe(1);
    expect((await store.read()).counter).toBe(1);
  });

  it('serializes concurrent updates without losing writes', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-persist-queue-'));
    const store = new JsonFileStore(path.join(dataRoot, 'state.json'), {
      counter: 0
    });

    await store.read();

    await Promise.all(
      Array.from({ length: 8 }, async () =>
        store.update(async (current) => ({
          counter: current.counter + 1
        }))
      )
    );

    expect((await store.read()).counter).toBe(8);
  });

  it('retries replacing the target file after a transient EPERM rename error', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-persist-retry-'));
    const filePath = path.join(dataRoot, 'state.json');
    const store = new JsonFileStore(filePath, {
      counter: 0
    });
    const originalRename = fs.rename.bind(fs);
    let renameAttempts = 0;

    await store.read();

    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const error = new Error('locked') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }

      return originalRename(from, to);
    });

    try {
      await store.write({ counter: 2 });
    } finally {
      renameSpy.mockRestore();
    }

    expect(renameAttempts).toBeGreaterThan(1);
    expect((await store.read()).counter).toBe(2);
  });

  it('appends and reads JSON lines', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-lines-'));
    const filePath = path.join(dataRoot, 'events.jsonl');

    await appendJsonLine(filePath, { id: 1 });
    await appendJsonLine(filePath, { id: 2 });

    const lines = await readJsonLines<{ id: number }>(filePath);

    expect(lines.map((line) => line.id)).toEqual([1, 2]);
  });
});
