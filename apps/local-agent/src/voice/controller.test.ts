import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AssemConfig,
  ChatRequest,
  SessionSnapshot,
  SpeechToTextStopRequest,
  SpeechToTextProvider,
  SpeechToTextResult,
  SpeechToTextSession,
  TextToSpeechPlayback,
  TextToSpeechProvider,
  TelemetryRecord,
  TelemetrySink,
  VoiceProviderHealth,
  VoiceSettings
} from '@assem/shared-types';

import { VoiceCoordinator } from './controller';

function createConfig(overrides: Partial<AssemConfig> = {}): AssemConfig {
  return {
    appName: 'ASSEM',
    agentPort: 4318,
    sandboxRoot: 'C:/sandbox',
    dataRoot: 'C:/data',
    defaultProviderId: 'demo-local',
    providerTimeoutMs: 15_000,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2:latest',
    voiceSttProviderId: 'fake-stt',
    voiceTtsProviderId: 'fake-tts',
    voiceLanguage: 'es-ES',
    voiceAutoReadResponses: false,
    voiceDebugArtifacts: false,
    whisperCppCliPath: undefined,
    whisperCppModelPath: undefined,
    whisperCppThreads: 4,
    allowedOrigins: [],
    ...overrides
  };
}

function createSnapshot(
  sessionId: string,
  userText?: string,
  assistantText?: string
): SessionSnapshot {
  const now = new Date().toISOString();
  const messages = [];

  if (userText) {
    messages.push({
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: userText,
      createdAt: now
    });
  }

  if (assistantText) {
    messages.push({
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      content: assistantText,
      createdAt: now
    });
  }

  return {
    sessionId,
    createdAt: now,
    updatedAt: now,
    messages,
    actionLog: [],
    pendingAction: null,
    temporaryOverrides: [],
    calendarEvents: [],
    activeMode: {
      privacy: 'local_only',
      runtime: 'sandbox'
    },
    settings: {
      preferredProviderId: 'demo-local',
      autoApproveLowRisk: false
    },
    availableProviders: [],
    availableTools: []
  };
}

class InMemoryTelemetrySink implements TelemetrySink {
  readonly records: TelemetryRecord[] = [];

  async record(record: TelemetryRecord): Promise<void> {
    this.records.push(record);
  }

  async list(limit = 50): Promise<TelemetryRecord[]> {
    return this.records.slice(-limit);
  }

  async summarize(limit = 20) {
    const recent = this.records.slice(-limit);
    return {
      totalInteractions: this.records.length,
      successes: this.records.filter((entry) => entry.result === 'success').length,
      rejections: this.records.filter((entry) => entry.result === 'rejected').length,
      errors: this.records.filter((entry) => entry.result === 'error').length,
      recent,
      lastInteractionAt: recent.at(-1)?.timestamp,
      lastError: [...recent].reverse().find((entry) => entry.result === 'error')?.errorMessage
    };
  }
}

class FakeSpeechToTextProvider implements SpeechToTextProvider {
  readonly kind = 'stt' as const;
  readonly spokenRequests: string[] = [];
  lastStopRequest: SpeechToTextStopRequest | undefined;

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly health: Omit<VoiceProviderHealth, 'active' | 'providerId' | 'label' | 'kind'>,
    private readonly stopImplementation: () => Promise<SpeechToTextResult>
  ) {}

  isConfigured(): boolean {
    return this.health.configured;
  }

  async healthCheck(settings: VoiceSettings): Promise<VoiceProviderHealth> {
    return {
      providerId: this.id,
      label: this.label,
      kind: 'stt',
      active: settings.sttProviderId === this.id,
      ...this.health
    };
  }

  async startListening(): Promise<SpeechToTextSession> {
    return {
      stop: async (request) => {
        this.lastStopRequest = request;
        return await this.stopImplementation();
      },
      cancel: async () => undefined
    };
  }
}

class FakeTextToSpeechProvider implements TextToSpeechProvider {
  readonly kind = 'tts' as const;
  readonly spokenTexts: string[] = [];

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly health: Omit<VoiceProviderHealth, 'active' | 'providerId' | 'label' | 'kind'>,
    private readonly speakImplementation: (text: string) => Promise<TextToSpeechPlayback>
  ) {}

  isConfigured(): boolean {
    return this.health.configured;
  }

  async healthCheck(settings: VoiceSettings): Promise<VoiceProviderHealth> {
    return {
      providerId: this.id,
      label: this.label,
      kind: 'tts',
      active: settings.ttsProviderId === this.id,
      ...this.health
    };
  }

  async speak(request: { text: string }): Promise<TextToSpeechPlayback> {
    this.spokenTexts.push(request.text);
    return await this.speakImplementation(request.text);
  }
}

async function createCoordinator(options: {
  configOverrides?: Partial<AssemConfig>;
  sttProviders?: SpeechToTextProvider[];
  ttsProviders?: TextToSpeechProvider[];
  settingsFilePath?: string;
}) {
  const telemetry = new InMemoryTelemetrySink();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-voice-'));
  const settingsFilePath =
    options.settingsFilePath ?? path.join(tempRoot, 'voice-settings.json');
  const sessionSnapshots = new Map<string, SessionSnapshot>();

  const coordinator = new VoiceCoordinator({
    config: createConfig(options.configOverrides),
    telemetry,
    settingsFilePath,
    chatRuntime: {
      async handleChat(request: ChatRequest) {
        const snapshot = createSnapshot(
          request.sessionId ?? 'voice-session',
          request.text,
          `Respuesta para: ${request.text}`
        );
        sessionSnapshots.set(snapshot.sessionId, snapshot);
        return snapshot;
      },
      async getSessionSnapshot(sessionId: string) {
        return sessionSnapshots.get(sessionId) ?? createSnapshot(sessionId);
      }
    },
    sttProviders:
      options.sttProviders ??
      [
        new FakeSpeechToTextProvider(
          'fake-stt',
          'Fake STT',
          {
            status: 'ok',
            checkedAt: new Date().toISOString(),
            configured: true,
            available: true
          },
          async () => ({
            transcript: 'hola assem',
            audioDurationMs: 1_250
          })
        )
      ],
    ttsProviders:
      options.ttsProviders ??
      [
        new FakeTextToSpeechProvider(
          'fake-tts',
          'Fake TTS',
          {
            status: 'ok',
            checkedAt: new Date().toISOString(),
            configured: true,
            available: true
          },
          async () => ({
            stop: async () => undefined,
            completed: Promise.resolve({ audioDurationMs: 480 })
          })
        )
      ]
  });

  await coordinator.initialize();

  return {
    coordinator,
    telemetry,
    sessionSnapshots,
    settingsFilePath,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  };
}

describe('VoiceCoordinator', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('persists updated voice settings and reloads them', async () => {
    const first = await createCoordinator({});
    cleanups.push(first.cleanup);

    await first.coordinator.updateSettings({
      settings: {
        autoReadResponses: true,
        preferredLanguage: 'en-US'
      }
    });

    const second = await createCoordinator({
      settingsFilePath: first.settingsFilePath
    });
    cleanups.push(second.cleanup);

    const state = await second.coordinator.getState();

    expect(state.voice.settings.autoReadResponses).toBe(true);
    expect(state.voice.settings.preferredLanguage).toBe('en-US');
  });

  it('isolates legacy Windows STT settings and migrates them to the active configured provider', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-voice-migrate-'));
    const settingsFilePath = path.join(tempRoot, 'voice-settings.json');
    await fs.writeFile(
      settingsFilePath,
      JSON.stringify(
        {
          settings: {
            sttProviderId: 'windows-system-stt',
            ttsProviderId: 'fake-tts',
            preferredLanguage: 'es-ES',
            autoReadResponses: false
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const harness = await createCoordinator({
      settingsFilePath
    });
    cleanups.push(async () => {
      await harness.cleanup();
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    const state = await harness.coordinator.getState('session-migrate');
    const persisted = JSON.parse(await fs.readFile(settingsFilePath, 'utf8')) as {
      settings: { sttProviderId: string };
    };

    expect(state.voice.settings.sttProviderId).toBe('fake-stt');
    expect(state.voice.sttProviders.some((provider) => provider.providerId === 'windows-system-stt')).toBe(false);
    expect(persisted.settings.sttProviderId).toBe('fake-stt');
  });

  it('routes a successful transcript into the current session', async () => {
    const harness = await createCoordinator({});
    cleanups.push(harness.cleanup);

    await harness.coordinator.startRecording({ sessionId: 'session-1' });
    const response = await harness.coordinator.stopRecording({
      sessionId: 'session-1'
    });

    expect(response.transcript).toBe('hola assem');
    expect(response.snapshot?.messages[0]?.content).toBe('hola assem');
    expect(response.snapshot?.messages[1]?.content).toContain('Respuesta para: hola assem');
    expect(
      harness.telemetry.records.some(
        (record) => record.channel === 'voice_stt' && record.result === 'success'
      )
    ).toBe(true);
  });

  it('forwards uploaded browser audio into the active STT session', async () => {
    const sttProvider = new FakeSpeechToTextProvider(
      'fake-stt',
      'Fake STT',
      {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true
      },
      async () => ({
        transcript: 'audio recibido',
        audioDurationMs: 900
      })
    );
    const harness = await createCoordinator({
      sttProviders: [sttProvider]
    });
    cleanups.push(harness.cleanup);

    const audio = {
      mimeType: 'audio/wav',
      base64Data: 'UklGRg==',
      fileName: 'assem.wav',
      durationMs: 900
    };

    await harness.coordinator.startRecording({ sessionId: 'session-audio' });
    await harness.coordinator.stopRecording({
      sessionId: 'session-audio',
      audio
    });

    expect(sttProvider.lastStopRequest).toEqual({
      audio
    });
  });

  it('keeps a clear error state when STT fails', async () => {
    const failingStt = new FakeSpeechToTextProvider(
      'fake-stt',
      'Fake STT',
      {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true
      },
      async () => {
        throw new Error('Mic failed');
      }
    );
    const harness = await createCoordinator({
      sttProviders: [failingStt]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.startRecording({ sessionId: 'session-2' });
    await expect(
      harness.coordinator.stopRecording({ sessionId: 'session-2' })
    ).rejects.toThrow('Mic failed');

    const state = await harness.coordinator.getState('session-2');
    expect(state.voice.session?.recordingState).toBe('error');
    expect(state.voice.session?.lastError).toContain('Mic failed');
  });

  it('preserves the provider diagnostic when transcription returns no useful text', async () => {
    const diagnosticStt = new FakeSpeechToTextProvider(
      'fake-stt',
      'Fake STT',
      {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true
      },
      async () => ({
        transcript: '',
        audioDurationMs: 220,
        effectiveLanguage: 'es',
        audioDiagnostics: {
          byteLength: 5_120,
          sampleRateHz: 16_000,
          channelCount: 1,
          bitDepth: 16,
          approximateDurationMs: 220,
          peakLevel: 0.34,
          rmsLevel: 0.12,
          wavValid: true,
          silenceDetected: false,
          suspicious: true
        },
        diagnostic: {
          code: 'audio_too_short',
          summary: 'La grabacion es demasiado corta para Whisper (220 ms).',
          effectiveLanguage: 'es',
          audio: {
            byteLength: 5_120,
            sampleRateHz: 16_000,
            channelCount: 1,
            bitDepth: 16,
            approximateDurationMs: 220,
            peakLevel: 0.34,
            rmsLevel: 0.12,
            wavValid: true,
            silenceDetected: false,
            suspicious: true
          }
        }
      })
    );
    const harness = await createCoordinator({
      sttProviders: [diagnosticStt]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.startRecording({ sessionId: 'session-diagnostic' });
    const response = await harness.coordinator.stopRecording({
      sessionId: 'session-diagnostic'
    });
    const state = await harness.coordinator.getState('session-diagnostic');

    expect(response.transcript).toBe('');
    expect(state.voice.session?.recordingState).toBe('error');
    expect(state.voice.session?.lastError).toContain('demasiado corta');
    expect(state.voice.session?.lastDiagnostic?.code).toBe('audio_too_short');
    expect(state.voice.session?.lastTranscriptionLanguage).toBe('es');
    expect(state.voice.session?.lastAudioDiagnostics?.approximateDurationMs).toBe(220);
  });

  it('degrades cleanly when the selected STT provider is unavailable', async () => {
    const unavailableStt = new FakeSpeechToTextProvider(
      'fake-stt',
      'Fake STT',
      {
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: false,
        error: 'No microphone'
      },
      async () => ({
        transcript: '',
        audioDurationMs: 0
      })
    );
    const harness = await createCoordinator({
      sttProviders: [unavailableStt]
    });
    cleanups.push(harness.cleanup);

    const state = await harness.coordinator.getState('session-3');

    expect(state.voice.status).toBe('degraded');
    expect(state.voice.microphoneAccessible).toBe(false);
    expect(state.voice.sttProviders[0]?.error).toContain('No microphone');
  });

  it('auto-reads assistant replies when the setting is enabled', async () => {
    const tts = new FakeTextToSpeechProvider(
      'fake-tts',
      'Fake TTS',
      {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true
      },
      async () => ({
        stop: async () => undefined,
        completed: Promise.resolve({ audioDurationMs: 240 })
      })
    );
    const harness = await createCoordinator({
      configOverrides: {
        voiceAutoReadResponses: true
      },
      ttsProviders: [tts]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.maybeAutoReadSnapshot(
      'session-4',
      createSnapshot('session-4', 'hola', 'Respuesta hablada')
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(tts.spokenTexts).toContain('Respuesta hablada');
  });

  it('keeps text flow alive when TTS fails', async () => {
    const failingTts = new FakeTextToSpeechProvider(
      'fake-tts',
      'Fake TTS',
      {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true
      },
      async () => {
        throw new Error('Speaker offline');
      }
    );
    const harness = await createCoordinator({
      configOverrides: {
        voiceAutoReadResponses: true
      },
      ttsProviders: [failingTts]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.maybeAutoReadSnapshot(
      'session-5',
      createSnapshot('session-5', 'hola', 'Respuesta hablada')
    );

    const state = await harness.coordinator.getState('session-5');
    expect(state.voice.session?.speakingState).toBe('error');
    expect(state.voice.session?.lastError).toContain('Speaker offline');
  });
});
