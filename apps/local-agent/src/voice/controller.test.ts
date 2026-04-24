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
  TextToSpeechResult,
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
    voiceModeEnabledByDefault: false,
    wakeWordEnabled: false,
    wakeWord: 'prolijo',
    wakeWordAliases: ['pro lijo', 'polijo', 'prolijos', 'pro li jo'],
    wakeWindowMs: 2_500,
    wakeIntervalMs: 500,
    activeSilenceMs: 2_000,
    activeMaxMs: 30_000,
    activeMinSpeechMs: 800,
    activePrerollMs: 700,
    activePostrollMs: 500,
    wakeDebug: false,
    whisperCppCliPath: undefined,
    whisperCppModelPath: undefined,
    whisperCppThreads: 4,
    whisperCppInitialPrompt: undefined,
    whisperCppBeamSize: undefined,
    webSearchProvider: '',
    webSearchApiKey: undefined,
    webSearchEndpoint: 'https://api.search.brave.com/res/v1/web/search',
    webSearchMaxResults: 5,
    webSearchTimeoutMs: 10_000,
    webPageFetchEnabled: true,
    webPageFetchTimeoutMs: 12_000,
    webPageMaxSources: 3,
    webPageMaxContentChars: 20_000,
    webPageMinTextChars: 220,
    webPageMinTextDensity: 0.18,
    webPageMaxLinkDensity: 0.55,
    browserAutomationEnabled: true,
    browserMaxPagesPerTask: 3,
    browserMaxLinksPerPage: 20,
    browserTextMaxChars: 12_000,
    browserTimeoutMs: 15_000,
    browserAllowScreenshots: false,
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

  it('uses env/config as the single source of truth for wake settings', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-voice-env-wake-'));
    const settingsFilePath = path.join(tempRoot, 'voice-settings.json');
    await fs.writeFile(
      settingsFilePath,
      JSON.stringify(
        {
          settings: {
            sttProviderId: 'fake-stt',
            ttsProviderId: 'fake-tts',
            preferredLanguage: 'es-ES',
            autoReadResponses: true,
            micMuted: true,
            voiceModeEnabled: true,
            wakeWordEnabled: true,
            wakeWord: 'antiguo',
            wakeWordAliases: ['alias viejo'],
            wakeWindowMs: 9_999,
            wakeIntervalMs: 9_999,
            activeSilenceMs: 9_999,
            activeMaxMs: 99_999,
            activeMinSpeechMs: 9_999,
            activePrerollMs: 9_999,
            activePostrollMs: 9_999,
            wakeDebug: true
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const harness = await createCoordinator({
      configOverrides: {
        wakeWord: 'viernes',
        wakeWordEnabled: true,
        wakeWordAliases: ['vier nes'],
        wakeWindowMs: 1_111,
        wakeIntervalMs: 222,
        activeSilenceMs: 777,
        activeMaxMs: 12_345,
        activeMinSpeechMs: 333,
        activePrerollMs: 444,
        activePostrollMs: 555,
        wakeDebug: false
      },
      settingsFilePath
    });
    cleanups.push(async () => {
      await harness.cleanup();
      await fs.rm(tempRoot, { recursive: true, force: true });
    });

    const state = await harness.coordinator.getState('session-env-wake');
    const persisted = JSON.parse(await fs.readFile(settingsFilePath, 'utf8')) as {
      settings: Record<string, unknown>;
    };

    expect(state.voice.settings.wakeWord).toBe('viernes');
    expect(state.voice.settings.wakeWordEnabled).toBe(true);
    expect(state.voice.settings.wakeWordAliases).toEqual(['vier nes']);
    expect(state.voice.settings.wakeWindowMs).toBe(1_111);
    expect(state.voice.settings.wakeIntervalMs).toBe(222);
    expect(state.voice.settings.activeSilenceMs).toBe(777);
    expect(state.voice.settings.activeMaxMs).toBe(12_345);
    expect(state.voice.settings.activeMinSpeechMs).toBe(333);
    expect(state.voice.settings.activePrerollMs).toBe(444);
    expect(state.voice.settings.activePostrollMs).toBe(555);
    expect(state.voice.settings.wakeDebug).toBe(false);
    expect(state.voice.settings.autoReadResponses).toBe(true);
    expect(state.voice.settings.micMuted).toBe(true);
    expect(persisted.settings.wakeWord).toBeUndefined();
    expect(persisted.settings.wakeWordEnabled).toBeUndefined();
    expect(persisted.settings.wakeWordAliases).toBeUndefined();
    expect(persisted.settings.wakeWindowMs).toBeUndefined();
    expect(persisted.settings.voiceModeEnabled).toBe(false);
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

  it('enables and disables conversation mode without starting hidden recording', async () => {
    const harness = await createCoordinator({});
    cleanups.push(harness.cleanup);

    const enabled = await harness.coordinator.updateVoiceMode({
      sessionId: 'session-wake-mode',
      enabled: true
    });

    expect(enabled.voice.settings.voiceModeEnabled).toBe(true);
    expect(enabled.voice.session?.voiceModeState).toBe('conversation_waiting');
    expect(enabled.voice.session?.recordingState).toBe('idle');
    expect(enabled.voice.session?.wakeModeEnabled).toBe(false);

    const disabled = await harness.coordinator.updateVoiceMode({
      sessionId: 'session-wake-mode',
      enabled: false
    });

    expect(disabled.voice.settings.voiceModeEnabled).toBe(false);
    expect(disabled.voice.session?.voiceModeState).toBe('off');
    expect(
      harness.telemetry.records.some((record) => record.eventType === 'voice_mode_enabled')
    ).toBe(false);
    expect(
      harness.telemetry.records.some((record) => record.eventType === 'conversation_mode_enabled')
    ).toBe(true);
    expect(
      harness.telemetry.records.some((record) => record.eventType === 'conversation_mode_disabled')
    ).toBe(true);
  });

  it('starts active listening directly in conversation mode without wake word', async () => {
    const harness = await createCoordinator({});
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-conversation-direct',
      enabled: true
    });
    const response = await harness.coordinator.startActiveListening({
      sessionId: 'session-conversation-direct'
    });

    expect(response.voice.session?.voiceModeState).toBe('active_listening');
    expect(response.voice.session?.wakeModeEnabled).toBe(false);
  });

  it('clears transient active-listening state when conversation mode is toggled off and on again', async () => {
    const harness = await createCoordinator({});
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-conversation-restart',
      enabled: true
    });
    await harness.coordinator.startActiveListening({
      sessionId: 'session-conversation-restart'
    });

    const disabled = await harness.coordinator.updateVoiceMode({
      sessionId: 'session-conversation-restart',
      enabled: false
    });

    expect(disabled.voice.session?.voiceModeState).toBe('off');
    expect(disabled.voice.session?.recordingState).toBe('idle');
    expect(disabled.voice.session?.activeListeningStartedAt).toBeUndefined();

    const enabledAgain = await harness.coordinator.updateVoiceMode({
      sessionId: 'session-conversation-restart',
      enabled: true
    });

    expect(enabledAgain.voice.session?.voiceModeState).toBe('conversation_waiting');
    expect(enabledAgain.voice.session?.recordingState).toBe('idle');

    const restarted = await harness.coordinator.startActiveListening({
      sessionId: 'session-conversation-restart'
    });

    expect(restarted.voice.session?.voiceModeState).toBe('active_listening');
    expect(restarted.voice.session?.recordingState).toBe('recording');
  });

  it('uses mic mute as a hard stop for conversation capture', async () => {
    const harness = await createCoordinator({});
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-muted',
      enabled: true
    });
    const muted = await harness.coordinator.updateSettings(
      {
        settings: {
          micMuted: true
        }
      },
      'session-muted'
    );

    expect(muted.voice.settings.micMuted).toBe(true);
    expect(muted.voice.session?.voiceModeState).toBe('muted');
    await expect(
      harness.coordinator.startActiveListening({
        sessionId: 'session-muted'
      })
    ).rejects.toThrow('microfono esta muteado');

    const unmuted = await harness.coordinator.updateSettings(
      {
        settings: {
          micMuted: false
        }
      },
      'session-muted'
    );

    expect(unmuted.voice.session?.voiceModeState).toBe('conversation_waiting');
  });

  it('does not persist active wake listening across coordinator restarts', async () => {
    const first = await createCoordinator({});
    cleanups.push(first.cleanup);

    await first.coordinator.updateVoiceMode({
      sessionId: 'session-private-wake',
      enabled: true
    });
    const persistedAfterEnable = JSON.parse(
      await fs.readFile(first.settingsFilePath, 'utf8')
    ) as { settings: VoiceSettings };

    expect(persistedAfterEnable.settings.voiceModeEnabled).toBe(false);

    const second = await createCoordinator({
      settingsFilePath: first.settingsFilePath
    });
    cleanups.push(second.cleanup);

    const state = await second.coordinator.getState('session-private-wake');

    expect(state.voice.settings.voiceModeEnabled).toBe(false);
    expect(state.voice.session?.wakeModeEnabled ?? false).toBe(false);
    expect(state.voice.session?.voiceModeState ?? 'off').toBe('off');
  });

  it('detects wake word variants from a transcribed wake window', async () => {
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
        transcript: 'polijo puedes escucharme',
        audioDurationMs: 2_100
      })
    );
    const harness = await createCoordinator({
      configOverrides: {
        wakeWordEnabled: true
      },
      sttProviders: [sttProvider]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-wake',
      enabled: true
    });
    const response = await harness.coordinator.submitWakeWindow({
      sessionId: 'session-wake',
      audio: {
        mimeType: 'audio/wav',
        base64Data: 'UklGRg==',
        durationMs: 2_100
      }
    });

    expect(response.wakeDetected).toBe(true);
    expect(response.transcript).toBe('polijo puedes escucharme');
    expect(response.voice.session?.voiceModeState).toBe('wake_detected');
    expect(sttProvider.lastStopRequest?.audio?.durationMs).toBe(2_100);
    expect(
      harness.telemetry.records.some((record) => record.eventType === 'wake_word_detected')
    ).toBe(true);
  });

  it('keeps wake diagnostics separate from final transcription diagnostics', async () => {
    let callCount = 0;
    const sttProvider = new FakeSpeechToTextProvider(
      'fake-stt',
      'Fake STT',
      {
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true
      },
      async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            transcript: '',
            audioDurationMs: 2_100,
            effectiveLanguage: 'es',
            audioDiagnostics: {
              byteLength: 4_800,
              approximateDurationMs: 2_100,
              wavValid: true,
              silenceDetected: true,
              suspicious: true
            },
            diagnostic: {
              code: 'audio_silent',
              summary: 'La ventana de wake no tenia voz suficiente.'
            }
          };
        }

        return {
          transcript: 'explica que es ASSEM',
          audioDurationMs: 1_400,
          effectiveLanguage: 'es',
          audioDiagnostics: {
            byteLength: 24_000,
            approximateDurationMs: 1_400,
            wavValid: true,
            silenceDetected: false,
            suspicious: false
          },
          diagnostic: {
            code: 'transcript_too_short',
            summary: 'Transcripcion final aceptada para la prueba.'
          }
        };
      }
    );
    const harness = await createCoordinator({
      configOverrides: {
        wakeWordEnabled: true
      },
      sttProviders: [sttProvider]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-diagnostic-split',
      enabled: true
    });
    await harness.coordinator.submitWakeWindow({
      sessionId: 'session-diagnostic-split',
      audio: {
        mimeType: 'audio/wav',
        base64Data: 'UklGRg==',
        durationMs: 2_100
      }
    });
    await harness.coordinator.startActiveListening({
      sessionId: 'session-diagnostic-split'
    });
    await harness.coordinator.stopActiveListening({
      sessionId: 'session-diagnostic-split',
      reason: 'silence',
      audio: {
        mimeType: 'audio/wav',
        base64Data: 'UklGRg==',
        durationMs: 1_400
      }
    });

    const state = await harness.coordinator.getState('session-diagnostic-split');

    expect(state.voice.session?.lastWakeDiagnostic?.code).toBe('audio_silent');
    expect(state.voice.session?.lastDiagnostic?.summary).toBe(
      'Transcripcion final aceptada para la prueba.'
    );
    expect(state.voice.session?.lastTranscript).toBe('explica que es ASSEM');
    expect(state.voice.session?.lastWakeTranscript).toBeUndefined();
  });

  it('returns to conversation waiting when no useful speech follows', async () => {
    const harness = await createCoordinator({});
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-no-speech',
      enabled: true
    });
    await harness.coordinator.startActiveListening({
      sessionId: 'session-no-speech'
    });
    const response = await harness.coordinator.stopActiveListening({
      sessionId: 'session-no-speech',
      reason: 'no_speech'
    });

    expect(response.transcript).toBe('');
    expect(response.snapshot).toBeUndefined();
    expect(response.voice.session?.voiceModeState).toBe('conversation_waiting');
    expect(response.voice.session?.lastError).toBeUndefined();
  });

  it('submits active listening transcripts into the normal chat flow', async () => {
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
        transcript: 'explica que es ASSEM',
        audioDurationMs: 1_400
      })
    );
    const harness = await createCoordinator({
      sttProviders: [sttProvider]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-active',
      enabled: true
    });
    await harness.coordinator.startActiveListening({
      sessionId: 'session-active'
    });
    await harness.coordinator.updateActiveListeningState({
      sessionId: 'session-active',
      state: 'speech_detected',
      audioDurationMs: 600
    });
    const response = await harness.coordinator.stopActiveListening({
      sessionId: 'session-active',
      reason: 'silence',
      audio: {
        mimeType: 'audio/wav',
        base64Data: 'UklGRg==',
        durationMs: 1_400
      }
    });

    expect(response.transcript).toBe('explica que es ASSEM');
    expect(response.snapshot?.messages[0]?.content).toBe('explica que es ASSEM');
    expect(response.voice.session?.voiceModeState).toBe('conversation_waiting');
    expect(
      harness.telemetry.records.some(
        (record) => record.eventType === 'active_transcription_completed'
      )
    ).toBe(true);
  });

  it('returns conversation mode to waiting after auto-read TTS completes', async () => {
    let resolvePlayback!: (result: TextToSpeechResult) => void;
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
        completed: new Promise<TextToSpeechResult>((resolve) => {
          resolvePlayback = resolve;
        })
      })
    );
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
        transcript: 'dime la hora',
        audioDurationMs: 1_200
      })
    );
    const harness = await createCoordinator({
      configOverrides: {
        voiceAutoReadResponses: true
      },
      sttProviders: [sttProvider],
      ttsProviders: [tts]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-auto-read-conversation',
      enabled: true
    });
    await harness.coordinator.startActiveListening({
      sessionId: 'session-auto-read-conversation'
    });
    const response = await harness.coordinator.stopActiveListening({
      sessionId: 'session-auto-read-conversation',
      reason: 'silence',
      audio: {
        mimeType: 'audio/wav',
        base64Data: 'UklGRg==',
        durationMs: 1_200
      }
    });

    expect(response.voice.session?.voiceModeState).toBe('speaking');

    resolvePlayback({ audioDurationMs: 600 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const state = await harness.coordinator.getState('session-auto-read-conversation');
    expect(state.voice.session?.speakingState).toBe('idle');
    expect(state.voice.session?.voiceModeState).toBe('conversation_waiting');
  });

  it('clears stale speech when voice mode is disabled so wake detection can restart', async () => {
    let stopCalled = false;
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
        stop: async () => {
          stopCalled = true;
        },
        completed: new Promise<TextToSpeechResult>(() => undefined)
      })
    );
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
        transcript: 'polijo escuchame',
        audioDurationMs: 1_600
      })
    );
    const harness = await createCoordinator({
      configOverrides: {
        wakeWordEnabled: true
      },
      sttProviders: [sttProvider],
      ttsProviders: [tts]
    });
    cleanups.push(harness.cleanup);

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-stale-speech',
      enabled: true
    });
    const speaking = await harness.coordinator.speak({
      sessionId: 'session-stale-speech',
      text: 'Respuesta que queda bloqueada'
    });

    expect(speaking.voice.session?.speakingState).toBe('speaking');
    expect(speaking.voice.session?.voiceModeState).toBe('speaking');

    const disabled = await harness.coordinator.updateVoiceMode({
      sessionId: 'session-stale-speech',
      enabled: false
    });

    expect(stopCalled).toBe(true);
    expect(disabled.voice.session?.speakingState).toBe('idle');
    expect(disabled.voice.session?.voiceModeState).toBe('off');

    await harness.coordinator.updateVoiceMode({
      sessionId: 'session-stale-speech',
      enabled: true
    });
    const wake = await harness.coordinator.submitWakeWindow({
      sessionId: 'session-stale-speech',
      audio: {
        mimeType: 'audio/wav',
        base64Data: 'UklGRg==',
        durationMs: 1_600
      }
    });

    expect(wake.wakeDetected).toBe(true);
    expect(wake.voice.session?.voiceModeState).toBe('wake_detected');
  });
});
