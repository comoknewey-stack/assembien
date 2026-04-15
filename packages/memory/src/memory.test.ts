import os from 'node:os';
import path from 'node:path';

import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { FileProfileMemoryBackend, FileSessionStore } from './index';

describe('FileProfileMemoryBackend', () => {
  it('creates, activates, exports, imports and resets profiles', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-memory-'));
    const backend = new FileProfileMemoryBackend(path.join(dataRoot, 'profiles.json'));

    const created = await backend.createProfile({
      name: 'Work',
      notes: ['Focus mode']
    });
    const listed = await backend.listProfiles();
    const active = await backend.getActiveProfile();
    const exported = await backend.exportProfile(created.id);
    const imported = await backend.importProfile({
      profile: {
        ...exported,
        id: 'imported-profile',
        name: 'Imported'
      },
      activate: false
    });
    const activated = await backend.activateProfile(imported.id);
    const reset = await backend.resetProfile(activated.id);

    expect(listed).toHaveLength(1);
    expect(active?.name).toBe('Work');
    expect(exported.notes).toContain('Focus mode');
    expect(imported.name).toBe('Imported');
    expect(activated.isActive).toBe(true);
    expect(reset.notes).toHaveLength(0);
  });
});

describe('FileSessionStore', () => {
  it('persists sessions to disk', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-sessions-'));
    const filePath = path.join(dataRoot, 'sessions.json');

    const store = new FileSessionStore(filePath, 'demo-local');
    const created = await store.createSession();
    created.messages.push({
      id: 'message-1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString()
    });
    await store.saveSession(created);

    const reloaded = new FileSessionStore(filePath, 'demo-local');
    const session = await reloaded.getSession(created.sessionId);

    expect(session?.messages).toHaveLength(1);
    expect((await reloaded.listSessions())[0]?.sessionId).toBe(created.sessionId);
  });
});
