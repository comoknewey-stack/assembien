import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssemClient } from './index';

describe('AssemClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('extracts the error field from a JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi
          .fn()
          .mockResolvedValue('{"error":"La ruta solicitada del sandbox ya existe."}')
      })
    );

    const client = new AssemClient('http://localhost:4318');

    await expect(client.resolvePendingAction({ sessionId: 'test', approved: true })).rejects
      .toThrow('La ruta solicitada del sandbox ya existe.');
  });

  it('falls back to the raw response body when the error is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue('Service unavailable')
      })
    );

    const client = new AssemClient('http://localhost:4318');

    await expect(client.createSession()).rejects.toThrow('Service unavailable');
  });

  it('sends voice settings updates to the dedicated endpoint with the session id in the query string', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        settings: {
          sttProviderId: 'whisper-cpp',
          ttsProviderId: 'windows-system-tts',
          preferredLanguage: 'es-ES',
          autoReadResponses: true
        },
        voice: {
          available: true,
          status: 'ready',
          settings: {
            sttProviderId: 'whisper-cpp',
            ttsProviderId: 'windows-system-tts',
            preferredLanguage: 'es-ES',
            autoReadResponses: true
          },
          sttProviders: [],
          ttsProviders: [],
          microphoneAccessible: true,
          session: null
        }
      })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AssemClient('http://localhost:4318');

    await client.updateVoiceSettings(
      {
        settings: {
          autoReadResponses: true
        }
      },
      'session-voice'
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4318/api/voice/settings?sessionId=session-voice',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('requests the active task for a session through the dedicated endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        sessionId: 'session-task',
        task: null
      })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AssemClient('http://localhost:4318');

    await client.getActiveTask('session-task');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4318/api/tasks/active?sessionId=session-task',
      expect.objectContaining({
        method: 'GET'
      })
    );
  });

  it('requests the persisted task plan through the dedicated endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        taskId: 'task-plan',
        plan: null
      })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AssemClient('http://localhost:4318');

    await client.getTaskPlan('task-plan');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4318/api/tasks/task-plan/plan',
      expect.objectContaining({
        method: 'GET'
      })
    );
  });

  it('sends task pause requests to the task endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        task: {
          id: 'task-1',
          sessionId: 'session-task',
          objective: 'Preparar informe',
          status: 'paused'
        }
      })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AssemClient('http://localhost:4318');

    await client.pauseTask('task-1', 'Pausa manual');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4318/api/tasks/task-1/pause',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('creates runtime tasks through the dedicated runtime endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        task: {
          id: 'task-runtime-1',
          sessionId: 'session-task',
          objective: 'Preparar informe semanal',
          status: 'active'
        }
      })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AssemClient('http://localhost:4318');

    await client.createRuntimeTask({
      sessionId: 'session-task',
      taskType: 'research_report_basic',
      objective: 'Preparar informe semanal'
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4318/api/tasks/runtime',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });

  it('starts persisted tasks through the runtime start endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        task: {
          id: 'task-runtime-1',
          sessionId: 'session-task',
          objective: 'Preparar informe semanal',
          status: 'active'
        }
      })
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new AssemClient('http://localhost:4318');

    await client.startTask('task-runtime-1');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4318/api/tasks/task-runtime-1/start',
      expect.objectContaining({
        method: 'POST'
      })
    );
  });
});
