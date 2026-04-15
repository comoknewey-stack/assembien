import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionState } from '@assem/shared-types';

import { createLocalFilesTools, ensureInsideSandbox } from './index';

function createSessionState(): SessionState {
  const now = new Date().toISOString();

  return {
    sessionId: 'test-session',
    createdAt: now,
    updatedAt: now,
    messages: [],
    actionLog: [],
    pendingAction: null,
    temporaryOverrides: [],
    calendarEvents: [],
    activeMode: {
      privacy: 'local_only',
      runtime: 'live'
    },
    settings: {
      preferredProviderId: 'demo-local',
      autoApproveLowRisk: false
    }
  };
}

describe('local-files tools', () => {
  it('creates files inside the sandbox root in sandbox mode', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-'));
    const [, , createTool] = createLocalFilesTools();

    const result = await createTool.execute(
      {
        kind: 'file',
        relativePath: 'notes/today.txt',
        fileContents: 'hello world'
      },
      {
        now: new Date('2026-04-14T09:00:00.000Z'),
        sandboxRoot,
        activeMode: {
          privacy: 'local_only',
          runtime: 'sandbox'
        },
        session: createSessionState()
      }
    );

    const fileContents = await fs.readFile(
      path.join(sandboxRoot, 'notes', 'today.txt'),
      'utf8'
    );

    expect(result.output.simulated).toBe(false);
    expect(fileContents).toBe('hello world');
  });

  it('lists and reads files from the sandbox', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-'));
    const [listTool, readTool] = createLocalFilesTools();
    const filePath = path.join(sandboxRoot, 'docs', 'readme.txt');

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'sandboxed file', 'utf8');

    const listResult = await listTool.execute(
      {
        relativePath: 'docs'
      },
      {
        now: new Date(),
        sandboxRoot,
        activeMode: {
          privacy: 'local_only',
          runtime: 'live'
        },
        session: createSessionState()
      }
    );

    const readResult = await readTool.execute(
      {
        relativePath: 'docs/readme.txt'
      },
      {
        now: new Date(),
        sandboxRoot,
        activeMode: {
          privacy: 'local_only',
          runtime: 'live'
        },
        session: createSessionState()
      }
    );

    expect(listResult.output.entries).toHaveLength(1);
    expect(listResult.output.entries[0]?.relativePath).toBe('docs/readme.txt');
    expect(readResult.output.contents).toBe('sandboxed file');
  });

  it('rejects path traversal outside the sandbox root', () => {
    expect(() => ensureInsideSandbox('C:\\sandbox', '..\\secret.txt')).toThrow(
      /No se permite path traversal|fuera de la raiz permitida del sandbox/
    );
  });
});
