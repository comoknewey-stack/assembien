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
          sttProviderId: 'windows-system-stt',
          ttsProviderId: 'windows-system-tts',
          preferredLanguage: 'es-ES',
          autoReadResponses: true
        },
        voice: {
          available: true,
          status: 'ready',
          settings: {
            sttProviderId: 'windows-system-stt',
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
});
