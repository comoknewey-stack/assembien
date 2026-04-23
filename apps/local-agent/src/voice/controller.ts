import { JsonFileStore } from '@assem/persistence';
import type {
  ActiveMode,
  AssemConfig,
  ChatRequest,
  SessionSnapshot,
  TelemetryChannel,
  TelemetryRecord,
  TelemetrySink,
  TextToSpeechPlayback,
  TextToSpeechProvider,
  VoiceProviderHealth,
  VoiceRecordingRequest,
  VoiceRecordingResponse,
  VoiceRecordingStopRequest,
  VoiceSessionState,
  VoiceSettings,
  VoiceSettingsResponse,
  VoiceSettingsUpdateRequest,
  VoiceSpeakRequest,
  VoiceSpeakResponse,
  VoiceStateResponse,
  VoiceSystemState,
  SpeechToTextProvider,
  SpeechToTextResult,
  SpeechToTextSession,
  VoiceActiveListeningResponse,
  VoiceActiveListeningStartRequest,
  VoiceActiveListeningStateRequest,
  VoiceActiveListeningStopRequest,
  VoiceModeState,
  VoiceModeUpdateRequest,
  VoiceWakeWindowRequest,
  VoiceWakeWindowResponse
} from '@assem/shared-types';

import { transcriptContainsWakeWord } from './wake-mode';

interface VoiceSettingsFileShape {
  settings: Partial<VoiceSettings>;
}

interface VoiceChatRuntime {
  handleChat(request: ChatRequest): Promise<SessionSnapshot>;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null>;
}

interface VoiceCoordinatorOptions {
  config: AssemConfig;
  telemetry: TelemetrySink;
  settingsFilePath: string;
  chatRuntime: VoiceChatRuntime;
  sttProviders: SpeechToTextProvider[];
  ttsProviders: TextToSpeechProvider[];
  onStateChanged?: () => Promise<void> | void;
}

interface ActiveRecordingState {
  sessionId: string;
  providerId: string;
  startedAt: string;
  handle: SpeechToTextSession;
}

interface ActiveSpeechState {
  sessionId: string;
  providerId: string;
  playback: TextToSpeechPlayback;
  startedAt: string;
  text: string;
  playbackId: string;
}

interface ProviderHealthCache {
  checkedAt: number;
  sttProviders: VoiceProviderHealth[];
  ttsProviders: VoiceProviderHealth[];
}

const PROVIDER_HEALTH_TTL_MS = 20_000;

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultVoiceSettings(config: AssemConfig): VoiceSettings {
  return {
    sttProviderId: config.voiceSttProviderId,
    ttsProviderId: config.voiceTtsProviderId,
    preferredLanguage: config.voiceLanguage,
    autoReadResponses: config.voiceAutoReadResponses,
    voiceModeEnabled: false,
    micMuted: false,
    wakeWordEnabled: config.wakeWordEnabled,
    wakeWord: config.wakeWord,
    wakeWordAliases: config.wakeWordAliases,
    wakeWindowMs: config.wakeWindowMs,
    wakeIntervalMs: config.wakeIntervalMs,
    activeSilenceMs: config.activeSilenceMs,
    activeMaxMs: config.activeMaxMs,
    activeMinSpeechMs: config.activeMinSpeechMs,
    activePrerollMs: config.activePrerollMs,
    activePostrollMs: config.activePostrollMs,
    wakeDebug: config.wakeDebug
  };
}

function createPersistedVoiceSettings(settings: VoiceSettings): VoiceSettingsFileShape['settings'] {
  return {
    sttProviderId: settings.sttProviderId,
    ttsProviderId: settings.ttsProviderId,
    preferredLanguage: settings.preferredLanguage,
    autoReadResponses: settings.autoReadResponses,
    micMuted: settings.micMuted,
    voiceModeEnabled: false
  };
}

function resolveIdleVoiceModeState(settings: VoiceSettings): VoiceModeState {
  if (!settings.voiceModeEnabled) {
    return 'off';
  }

  return settings.micMuted ? 'muted' : 'conversation_waiting';
}

function cloneVoiceSessionState(
  state: VoiceSessionState | null | undefined
): VoiceSessionState | null {
  if (!state) {
    return null;
  }

  return {
    ...state,
    lastDiagnostic: state.lastDiagnostic
      ? {
          ...state.lastDiagnostic,
          audio: state.lastDiagnostic.audio
            ? {
                ...state.lastDiagnostic.audio
              }
            : undefined
        }
      : undefined,
    lastAudioDiagnostics: state.lastAudioDiagnostics
      ? {
          ...state.lastAudioDiagnostics
        }
      : undefined,
    lastWakeDiagnostic: state.lastWakeDiagnostic
      ? {
          ...state.lastWakeDiagnostic,
          audio: state.lastWakeDiagnostic.audio
            ? {
                ...state.lastWakeDiagnostic.audio
              }
            : undefined
        }
      : undefined,
    lastWakeAudioDiagnostics: state.lastWakeAudioDiagnostics
      ? {
          ...state.lastWakeAudioDiagnostics
        }
      : undefined
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTranscriptionFailureMessage(
  transcript: string,
  diagnosticSummary?: string
): string {
  if (diagnosticSummary?.trim()) {
    return diagnosticSummary.trim();
  }

  if (!transcript.trim()) {
    return 'No se ha detectado un transcript util. Prueba a repetir la grabacion.';
  }

  return 'La transcripcion de voz ha fallado.';
}

function createVoiceSessionState(
  sessionId: string,
  settings: VoiceSettings,
  microphoneAccessible: boolean
): VoiceSessionState {
  return {
    sessionId,
    recordingState: 'idle',
    speakingState: 'idle',
    voiceModeState: resolveIdleVoiceModeState(settings),
    wakeModeEnabled: settings.voiceModeEnabled && settings.wakeWordEnabled,
    micMuted: settings.micMuted,
    microphoneAccessible,
    sttProviderId: settings.sttProviderId,
    ttsProviderId: settings.ttsProviderId,
    autoReadResponses: settings.autoReadResponses,
    preferredLanguage: settings.preferredLanguage,
    updatedAt: nowIso()
  };
}

function resolveModes(snapshot: SessionSnapshot | null): ActiveMode {
  return (
    snapshot?.activeMode ?? {
      privacy: 'local_only',
      runtime: 'sandbox'
    }
  );
}

function getLastAssistantMessage(snapshot: SessionSnapshot | null): string | null {
  if (!snapshot) {
    return null;
  }

  const lastMessage = [...snapshot.messages]
    .reverse()
    .find((message) => message.role === 'assistant');

  return lastMessage?.content ?? null;
}

function resolveAvailableProviderId<TProvider extends { id: string }>(
  providers: Map<string, TProvider>,
  requestedProviderId: string,
  defaultProviderId: string
): string {
  if (providers.has(requestedProviderId)) {
    return requestedProviderId;
  }

  if (providers.has(defaultProviderId)) {
    return defaultProviderId;
  }

  const firstAvailableProviderId = providers.keys().next().value;
  return firstAvailableProviderId ?? defaultProviderId;
}

export class VoiceCoordinator {
  private readonly settingsStore: JsonFileStore<VoiceSettingsFileShape>;
  private readonly sttProviders = new Map<string, SpeechToTextProvider>();
  private readonly ttsProviders = new Map<string, TextToSpeechProvider>();
  private readonly sessionStates = new Map<string, VoiceSessionState>();
  private readonly config: AssemConfig;
  private readonly telemetry: TelemetrySink;
  private readonly chatRuntime: VoiceChatRuntime;
  private readonly onStateChanged?: () => Promise<void> | void;
  private providerHealthCache: ProviderHealthCache | null = null;
  private settings: VoiceSettings;
  private activeRecording: ActiveRecordingState | null = null;
  private activeSpeech: ActiveSpeechState | null = null;
  private mostRecentSessionId: string | null = null;

  constructor(options: VoiceCoordinatorOptions) {
    this.config = options.config;
    this.telemetry = options.telemetry;
    this.chatRuntime = options.chatRuntime;
    this.onStateChanged = options.onStateChanged;
    this.settings = createDefaultVoiceSettings(options.config);
    this.settingsStore = new JsonFileStore(options.settingsFilePath, {
      settings: this.settings
    });

    for (const provider of options.sttProviders) {
      this.sttProviders.set(provider.id, provider);
    }

    for (const provider of options.ttsProviders) {
      this.ttsProviders.set(provider.id, provider);
    }
  }

  async initialize(): Promise<void> {
    const persisted = await this.settingsStore.read();
    const nextSettings = this.normalizeSettings({
      ...createDefaultVoiceSettings(this.config),
      ...persisted.settings,
      voiceModeEnabled: false
    });
    const nextPersistedSettings = createPersistedVoiceSettings(nextSettings);
    const settingsChanged =
      JSON.stringify(nextPersistedSettings) !== JSON.stringify(persisted.settings);

    this.settings = nextSettings;
    if (settingsChanged) {
      await this.settingsStore.write({
        settings: nextPersistedSettings
      });
    }

    for (const provider of this.sttProviders.values()) {
      await provider.initialize?.();
    }

    for (const provider of this.ttsProviders.values()) {
      await provider.initialize?.();
    }

    await this.refreshProviderHealth(true);
  }

  async getState(sessionId?: string | null): Promise<VoiceStateResponse> {
    return {
      voice: await this.buildVoiceSystemState(sessionId ?? this.mostRecentSessionId)
    };
  }

  async updateSettings(
    request: VoiceSettingsUpdateRequest,
    sessionId?: string | null
  ): Promise<VoiceSettingsResponse> {
    const currentVoiceModeEnabled = this.settings.voiceModeEnabled;
    const currentWakeWordEnabled = this.settings.wakeWordEnabled;
    this.settings = this.normalizeSettings({
      ...this.settings,
      ...request.settings,
      voiceModeEnabled: currentVoiceModeEnabled,
      wakeWordEnabled: currentWakeWordEnabled
    });

    await this.settingsStore.write({
      settings: createPersistedVoiceSettings(this.settings)
    });
    await this.refreshProviderHealth(true);

    const targetSessionId = sessionId ?? this.mostRecentSessionId;
    if (targetSessionId) {
      const sessionState = this.resolveSessionState(targetSessionId);
      if (this.settings.micMuted && this.activeRecording?.sessionId === targetSessionId) {
        await this.activeRecording.handle.cancel().catch(() => undefined);
        this.activeRecording = null;
        sessionState.recordingState = 'idle';
      }

      sessionState.autoReadResponses = this.settings.autoReadResponses;
      sessionState.preferredLanguage = this.settings.preferredLanguage;
      sessionState.sttProviderId = this.settings.sttProviderId;
      sessionState.ttsProviderId = this.settings.ttsProviderId;
      sessionState.micMuted = this.settings.micMuted;
      sessionState.wakeModeEnabled =
        this.settings.voiceModeEnabled && this.settings.wakeWordEnabled;
      if (this.settings.micMuted) {
        sessionState.voiceModeState = 'muted';
      } else if (
        this.settings.voiceModeEnabled &&
        ['off', 'muted', 'idle', 'wake_listening', 'wake_detected'].includes(
          sessionState.voiceModeState
        )
      ) {
        sessionState.voiceModeState = 'conversation_waiting';
      } else if (!this.settings.voiceModeEnabled) {
        sessionState.voiceModeState = 'off';
      }
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);

      if (typeof request.settings.micMuted === 'boolean') {
        await this.recordVoiceTelemetry({
          sessionId: targetSessionId,
          channel: 'voice_capture',
          providerId: 'voice-mode',
          model: this.settings.preferredLanguage,
          result: 'success',
          totalDurationMs: 0,
          messagePreview: request.settings.micMuted ? 'mic:muted' : 'mic:unmuted',
          eventType: request.settings.micMuted
            ? 'voice_mute_enabled'
            : 'voice_mute_disabled'
        });
      }
    }

    await this.notifyStateChanged();
    const voice = await this.buildVoiceSystemState(targetSessionId);

    return {
      settings: {
        ...this.settings
      },
      voice
    };
  }

  async updateVoiceMode(request: VoiceModeUpdateRequest): Promise<VoiceStateResponse> {
    this.mostRecentSessionId = request.sessionId;
    const sessionState = this.resolveSessionState(request.sessionId);
    const enabled = Boolean(request.enabled);

    if (this.activeRecording?.sessionId === request.sessionId) {
      await this.activeRecording.handle.cancel().catch(() => undefined);
      this.activeRecording = null;
      sessionState.recordingState = 'idle';
    }

    if (!enabled && this.activeSpeech?.sessionId === request.sessionId) {
      await this.activeSpeech.playback.stop().catch(() => undefined);
      this.activeSpeech = null;
      sessionState.speakingState = 'idle';
    }

    this.settings = this.normalizeSettings({
      ...this.settings,
      voiceModeEnabled: enabled
    });
    await this.settingsStore.write({
      settings: createPersistedVoiceSettings(this.settings)
    });

    sessionState.recordingState = 'idle';
    sessionState.activeListeningStartedAt = undefined;
    sessionState.audioDurationMs = undefined;
    sessionState.micMuted = this.settings.micMuted;
    sessionState.wakeModeEnabled = enabled && this.settings.wakeWordEnabled;
    sessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
    sessionState.lastError = undefined;
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);

    await this.recordVoiceTelemetry({
      sessionId: request.sessionId,
      channel: 'voice_capture',
      providerId: 'voice-mode',
      model: this.settings.preferredLanguage,
      result: 'success',
      totalDurationMs: 0,
      messagePreview: enabled ? 'conversation-mode:enabled' : 'conversation-mode:disabled',
      eventType: enabled ? 'conversation_mode_enabled' : 'conversation_mode_disabled'
    });
    if (enabled) {
      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_capture',
        providerId: 'voice-mode',
        model: this.settings.preferredLanguage,
        result: 'success',
        totalDurationMs: 0,
        messagePreview: this.settings.micMuted
          ? 'conversation-mode:muted'
          : 'conversation-waiting:started',
        eventType: 'conversation_waiting_started'
      });
    }

    await this.notifyStateChanged();
    return this.getState(request.sessionId);
  }

  async submitWakeWindow(
    request: VoiceWakeWindowRequest
  ): Promise<VoiceWakeWindowResponse> {
    this.mostRecentSessionId = request.sessionId;
    const sessionState = this.resolveSessionState(request.sessionId);

    if (
      !this.settings.voiceModeEnabled ||
      this.settings.micMuted ||
      !this.settings.wakeWordEnabled ||
      !sessionState.wakeModeEnabled
    ) {
      sessionState.micMuted = this.settings.micMuted;
      sessionState.wakeModeEnabled =
        this.settings.voiceModeEnabled && this.settings.wakeWordEnabled;
      sessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      return {
        voice: await this.buildVoiceSystemState(request.sessionId),
        wakeDetected: false
      };
    }

    if (this.activeSpeech?.sessionId === request.sessionId) {
      sessionState.voiceModeState = 'speaking';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      return {
        voice: await this.buildVoiceSystemState(request.sessionId),
        wakeDetected: false
      };
    }

    const startedAt = Date.now();
    sessionState.voiceModeState = 'wake_listening';
    sessionState.lastWakeWindowAt = nowIso();
    sessionState.lastError = undefined;
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);

    try {
      const { provider, result } = await this.transcribeAudio(
        request.sessionId,
        request.audio
      );
      const transcript = result.transcript.trim();
      const wakeDetected = transcriptContainsWakeWord(transcript, this.settings);

      sessionState.lastWakeTranscript = transcript || undefined;
      sessionState.audioDurationMs = result.audioDurationMs;
      sessionState.lastWakeTranscriptionLanguage = result.effectiveLanguage;
      sessionState.lastWakeAudioDiagnostics = result.audioDiagnostics;
      sessionState.lastWakeDiagnostic = result.diagnostic;
      sessionState.lastError = undefined;
      sessionState.voiceModeState = wakeDetected ? 'wake_detected' : 'wake_listening';
      sessionState.lastWakeDetectedAt = wakeDetected ? nowIso() : sessionState.lastWakeDetectedAt;
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);

      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_stt',
        providerId: provider.id,
        model: this.settings.preferredLanguage,
        result: 'success',
        totalDurationMs: Date.now() - startedAt,
        audioDurationMs: result.audioDurationMs,
        textLength: transcript.length,
        messagePreview: transcript.slice(0, 140) || 'wake-window:empty',
        eventType: wakeDetected ? 'wake_word_detected' : 'wake_window_transcribed'
      });

      await this.notifyStateChanged();
      return {
        voice: await this.buildVoiceSystemState(request.sessionId),
        wakeDetected,
        transcript
      };
    } catch (error) {
      sessionState.voiceModeState = 'error';
      sessionState.lastError =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Wake mode error';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_stt',
        providerId: this.settings.sttProviderId,
        model: this.settings.preferredLanguage,
        result: 'error',
        totalDurationMs: Date.now() - startedAt,
        messagePreview: 'wake-window:failed',
        errorMessage: sessionState.lastError,
        eventType: 'voice_mode_error'
      });
      await this.notifyStateChanged();
      throw error;
    }
  }

  async startActiveListening(
    request: VoiceActiveListeningStartRequest
  ): Promise<VoiceStateResponse> {
    this.mostRecentSessionId = request.sessionId;
    const sessionState = this.resolveSessionState(request.sessionId);
    if (!this.settings.voiceModeEnabled) {
      throw new Error('El modo conversacion no esta activo.');
    }

    if (this.settings.micMuted) {
      sessionState.micMuted = true;
      sessionState.voiceModeState = 'muted';
      sessionState.recordingState = 'idle';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      throw new Error('El microfono esta muteado. Desactiva Mute para escuchar.');
    }

    if (this.activeSpeech?.sessionId === request.sessionId) {
      await this.stopSpeaking({ sessionId: request.sessionId });
    }

    sessionState.voiceModeState = 'active_listening';
    sessionState.recordingState = 'recording';
    sessionState.micMuted = false;
    sessionState.activeListeningStartedAt = nowIso();
    sessionState.lastError = undefined;
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);
    await this.recordVoiceTelemetry({
      sessionId: request.sessionId,
      channel: 'voice_capture',
      providerId: 'voice-mode',
      model: this.settings.preferredLanguage,
      result: 'success',
      totalDurationMs: 0,
      messagePreview: 'active-listening:started',
      eventType: 'active_listening_started'
    });
    await this.notifyStateChanged();
    return this.getState(request.sessionId);
  }

  async updateActiveListeningState(
    request: VoiceActiveListeningStateRequest
  ): Promise<VoiceStateResponse> {
    this.mostRecentSessionId = request.sessionId;
    const sessionState = this.resolveSessionState(request.sessionId);
    if (!this.settings.voiceModeEnabled || this.settings.micMuted) {
      return this.getState(request.sessionId);
    }

    const allowedStates = new Set<VoiceModeState>([
      'conversation_waiting',
      'active_listening',
      'speech_detected',
      'silence_wait',
      'closing_turn',
      'transcribing',
      'processing'
    ]);
    if (!allowedStates.has(request.state)) {
      return this.getState(request.sessionId);
    }

    sessionState.voiceModeState = request.state;
    sessionState.audioDurationMs = request.audioDurationMs ?? sessionState.audioDurationMs;
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);

    if (
      request.state === 'conversation_waiting' ||
      request.state === 'speech_detected' ||
      request.state === 'silence_wait' ||
      request.state === 'closing_turn'
    ) {
      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_capture',
        providerId: 'voice-mode',
        model: this.settings.preferredLanguage,
        result: 'success',
        totalDurationMs: request.audioDurationMs ?? 0,
        audioDurationMs: request.audioDurationMs,
        messagePreview: `active-listening:${request.state}`,
        eventType:
          request.state === 'speech_detected'
            ? 'active_speech_detected'
            : request.state === 'conversation_waiting'
              ? 'conversation_waiting_started'
              : request.state === 'closing_turn'
                ? 'conversation_turn_closed'
                : 'active_silence_detected'
      });
    }

    await this.notifyStateChanged();
    return this.getState(request.sessionId);
  }

  async stopActiveListening(
    request: VoiceActiveListeningStopRequest
  ): Promise<VoiceActiveListeningResponse> {
    this.mostRecentSessionId = request.sessionId;
    const sessionState = this.resolveSessionState(request.sessionId);

    if (!this.settings.voiceModeEnabled || this.settings.micMuted) {
      sessionState.recordingState = 'idle';
      sessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
      sessionState.micMuted = this.settings.micMuted;
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      return {
        voice: await this.buildVoiceSystemState(request.sessionId),
        transcript: ''
      };
    }

    if (!request.audio || request.reason === 'no_speech') {
      sessionState.recordingState = 'idle';
      sessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
      sessionState.lastError = undefined;
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      await this.notifyStateChanged();
      return {
        voice: await this.buildVoiceSystemState(request.sessionId),
        transcript: ''
      };
    }

    const startedAt = Date.now();
    sessionState.recordingState = 'transcribing';
    sessionState.voiceModeState = 'transcribing';
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);
    await this.recordVoiceTelemetry({
      sessionId: request.sessionId,
      channel: 'voice_stt',
      providerId: this.settings.sttProviderId,
      model: this.settings.preferredLanguage,
      result: 'success',
      totalDurationMs: 0,
      audioDurationMs: request.audio.durationMs,
      messagePreview: 'active-transcription:started',
      eventType: 'active_transcription_started'
    });
    await this.notifyStateChanged();

    try {
      const { provider, result } = await this.transcribeAudio(
        request.sessionId,
        request.audio
      );
      const transcript = result.transcript.trim();

      sessionState.audioDurationMs = result.audioDurationMs;
      sessionState.lastTranscriptionLanguage = result.effectiveLanguage;
      sessionState.lastAudioDiagnostics = result.audioDiagnostics;
      sessionState.lastDiagnostic = result.diagnostic;

      if (!transcript) {
        sessionState.recordingState = 'idle';
        sessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
        sessionState.lastError = resolveTranscriptionFailureMessage(
          transcript,
          result.diagnostic?.summary
        );
        sessionState.updatedAt = nowIso();
        await this.persistSessionState(sessionState);
        await this.recordVoiceTelemetry({
          sessionId: request.sessionId,
          channel: 'voice_stt',
          providerId: provider.id,
          model: this.settings.preferredLanguage,
          result: 'error',
          totalDurationMs: Date.now() - startedAt,
          audioDurationMs: result.audioDurationMs,
          messagePreview: 'active-transcription:empty',
          errorMessage: sessionState.lastError,
          eventType: 'active_transcription_failed'
        });
        await this.notifyStateChanged();
        return {
          voice: await this.buildVoiceSystemState(request.sessionId),
          transcript: ''
        };
      }

      sessionState.recordingState = 'idle';
      sessionState.voiceModeState = 'processing';
      sessionState.lastTranscript = transcript;
      sessionState.lastError = undefined;
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      await this.notifyStateChanged();

      const snapshot = await this.chatRuntime.handleChat({
        sessionId: request.sessionId,
        text: transcript
      });
      sessionState.lastAssistantMessage = getLastAssistantMessage(snapshot) ?? undefined;
      sessionState.voiceModeState = this.settings.autoReadResponses
        ? 'processing'
        : resolveIdleVoiceModeState(this.settings);
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);

      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_stt',
        providerId: provider.id,
        model: this.settings.preferredLanguage,
        result: 'success',
        totalDurationMs: Date.now() - startedAt,
        audioDurationMs: result.audioDurationMs,
        textLength: transcript.length,
        messagePreview: transcript.slice(0, 140),
        eventType: 'active_transcription_completed'
      });

      if (this.settings.autoReadResponses) {
        await this.maybeAutoReadSnapshot(request.sessionId, snapshot);
      } else {
        await this.notifyStateChanged();
      }

      return {
        voice: await this.buildVoiceSystemState(request.sessionId),
        transcript,
        snapshot
      };
    } catch (error) {
      sessionState.recordingState = 'idle';
      sessionState.voiceModeState = 'error';
      sessionState.lastError =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown STT error';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_stt',
        providerId: this.settings.sttProviderId,
        model: this.settings.preferredLanguage,
        result: 'error',
        totalDurationMs: Date.now() - startedAt,
        messagePreview: 'active-transcription:failed',
        errorMessage: sessionState.lastError,
        eventType: 'active_transcription_failed'
      });
      await this.notifyStateChanged();
      throw error;
    }
  }

  async cancelActiveListening(request: VoiceRecordingRequest): Promise<VoiceStateResponse> {
    this.mostRecentSessionId = request.sessionId;
    const sessionState = this.resolveSessionState(request.sessionId);
    sessionState.recordingState = 'idle';
    sessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);
    await this.notifyStateChanged();
    return this.getState(request.sessionId);
  }

  async startRecording(request: VoiceRecordingRequest): Promise<VoiceStateResponse> {
    this.mostRecentSessionId = request.sessionId;
    await this.refreshProviderHealth();
    const sessionState = this.resolveSessionState(request.sessionId);

    if (this.settings.micMuted) {
      sessionState.micMuted = true;
      sessionState.voiceModeState = 'muted';
      sessionState.recordingState = 'idle';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      throw new Error('El microfono esta muteado. Desactiva Mute para usar push-to-talk.');
    }

    if (this.activeRecording) {
      if (this.activeRecording.sessionId === request.sessionId) {
        return this.getState(request.sessionId);
      }

      throw new Error('Ya hay una grabacion de voz activa en otra sesion.');
    }

    if (this.activeSpeech) {
      await this.stopSpeaking({ sessionId: this.activeSpeech.sessionId });
    }

    const provider = this.sttProviders.get(this.settings.sttProviderId);
    if (!provider) {
      throw new Error('No hay un provider STT configurado para esta fase.');
    }

    const providerHealth = (await this.refreshProviderHealth()).sttProviders.find(
      (entry) => entry.providerId === provider.id
    );
    if (!providerHealth?.available) {
      throw new Error(
        providerHealth?.error ??
          'El provider STT seleccionado no esta disponible ahora mismo.'
      );
    }

    try {
      const handle = await provider.startListening({
        sessionId: request.sessionId,
        language: this.settings.preferredLanguage
      });

      this.activeRecording = {
        sessionId: request.sessionId,
        providerId: provider.id,
        startedAt: nowIso(),
        handle
      };

      sessionState.recordingState = 'recording';
      sessionState.lastError = undefined;
      sessionState.lastDiagnostic = undefined;
      sessionState.recordingStartedAt = this.activeRecording.startedAt;
      sessionState.microphoneAccessible = true;
      sessionState.sttProviderId = provider.id;
      sessionState.preferredLanguage = this.settings.preferredLanguage;
      sessionState.autoReadResponses = this.settings.autoReadResponses;
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);

      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_capture',
        providerId: provider.id,
        model: this.settings.preferredLanguage,
        result: 'success',
        totalDurationMs: 0,
        messagePreview: 'voice-recording:start'
      });
      await this.notifyStateChanged();
      return this.getState(request.sessionId);
    } catch (error) {
      sessionState.recordingState = 'error';
      sessionState.lastError =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown STT error';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);

      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_stt',
        providerId: provider.id,
        model: this.settings.preferredLanguage,
        result: 'error',
        totalDurationMs: 0,
        messagePreview: 'voice-recording:start-failed',
        errorMessage: sessionState.lastError
      });
      await this.notifyStateChanged();
      throw error;
    }
  }

  async stopRecording(
    request: VoiceRecordingStopRequest
  ): Promise<VoiceRecordingResponse> {
    this.mostRecentSessionId = request.sessionId;
    const activeRecording = this.activeRecording;
    if (!activeRecording || activeRecording.sessionId !== request.sessionId) {
      throw new Error('No hay ninguna grabacion activa para detener en esta sesion.');
    }

    const sessionState = this.resolveSessionState(request.sessionId);
    sessionState.recordingState = 'transcribing';
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);
    await this.notifyStateChanged();

    try {
      const result = await activeRecording.handle.stop({
        audio: request.audio
      });
      this.activeRecording = null;

      const transcript = result.transcript.trim();
      if (!transcript) {
        sessionState.recordingState = 'error';
        sessionState.audioDurationMs = result.audioDurationMs;
        sessionState.lastTranscriptionLanguage = result.effectiveLanguage;
        sessionState.lastAudioDiagnostics = result.audioDiagnostics;
        sessionState.lastDiagnostic = result.diagnostic;
        sessionState.lastError = resolveTranscriptionFailureMessage(
          transcript,
          result.diagnostic?.summary
        );
        sessionState.updatedAt = nowIso();
        await this.persistSessionState(sessionState);

        await this.recordVoiceTelemetry({
          sessionId: request.sessionId,
          channel: 'voice_stt',
          providerId: activeRecording.providerId,
          model: this.settings.preferredLanguage,
          result: 'error',
          totalDurationMs: result.audioDurationMs,
          audioDurationMs: result.audioDurationMs,
          messagePreview: 'voice-transcription:empty',
          errorMessage: sessionState.lastError
        });
        await this.notifyStateChanged();

        return {
          voice: await this.buildVoiceSystemState(request.sessionId),
          transcript: ''
        };
      }

      let snapshot: SessionSnapshot | undefined;
      if (request.submitToChat !== false) {
        snapshot = await this.chatRuntime.handleChat({
          sessionId: request.sessionId,
          text: transcript
        });
      }

      sessionState.recordingState = 'idle';
      sessionState.lastTranscript = transcript;
      sessionState.audioDurationMs = result.audioDurationMs;
      sessionState.lastAudioDiagnostics = result.audioDiagnostics;
      sessionState.lastTranscriptionLanguage = result.effectiveLanguage;
      sessionState.lastDiagnostic = result.diagnostic;
      sessionState.lastError = undefined;
      sessionState.lastAssistantMessage = getLastAssistantMessage(snapshot ?? null) ?? undefined;
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);

      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_stt',
        providerId: activeRecording.providerId,
        model: this.settings.preferredLanguage,
        result: 'success',
        totalDurationMs: result.audioDurationMs,
        audioDurationMs: result.audioDurationMs,
        textLength: transcript.length,
        messagePreview: transcript.slice(0, 140)
      });

      if (snapshot) {
        await this.maybeAutoReadSnapshot(request.sessionId, snapshot);
      } else {
        await this.notifyStateChanged();
      }

      return {
        voice: await this.buildVoiceSystemState(request.sessionId),
        transcript,
        snapshot
      };
    } catch (error) {
      this.activeRecording = null;
      sessionState.recordingState = 'error';
      sessionState.lastError =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown STT error';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);

      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_stt',
        providerId: activeRecording.providerId,
        model: this.settings.preferredLanguage,
        result: 'error',
        totalDurationMs: 0,
        messagePreview: 'voice-transcription:failed',
        errorMessage: sessionState.lastError
      });
      await this.notifyStateChanged();
      throw error;
    }
  }

  async cancelRecording(request: VoiceRecordingRequest): Promise<VoiceStateResponse> {
    this.mostRecentSessionId = request.sessionId;
    const activeRecording = this.activeRecording;
    if (!activeRecording || activeRecording.sessionId !== request.sessionId) {
      return this.getState(request.sessionId);
    }

    await activeRecording.handle.cancel();
    this.activeRecording = null;

    const sessionState = this.resolveSessionState(request.sessionId);
    sessionState.recordingState = 'idle';
    sessionState.lastError = undefined;
    sessionState.lastDiagnostic = undefined;
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);
    await this.notifyStateChanged();
    return this.getState(request.sessionId);
  }

  async speak(request: VoiceSpeakRequest): Promise<VoiceSpeakResponse> {
    this.mostRecentSessionId = request.sessionId;
    await this.refreshProviderHealth();
    const sessionState = this.resolveSessionState(request.sessionId);

    if (this.activeRecording) {
      throw new Error('ASSEM no puede escuchar y hablar a la vez en esta fase.');
    }

    const provider = this.ttsProviders.get(this.settings.ttsProviderId);
    if (!provider) {
      throw new Error('No hay un provider TTS configurado para esta fase.');
    }

    const providerHealth = (await this.refreshProviderHealth()).ttsProviders.find(
      (entry) => entry.providerId === provider.id
    );
    if (!providerHealth?.available) {
      throw new Error(
        providerHealth?.error ??
          'El provider TTS seleccionado no esta disponible ahora mismo.'
      );
    }

    const text =
      request.text?.trim() ??
      getLastAssistantMessage(await this.chatRuntime.getSessionSnapshot(request.sessionId));
    if (!text) {
      throw new Error('No hay ninguna respuesta reciente para leer en voz alta.');
    }

    try {
      if (this.activeSpeech) {
        await this.activeSpeech.playback.stop();
        this.activeSpeech = null;
      }

      const playback = await provider.speak({
        sessionId: request.sessionId,
        text,
        language: this.settings.preferredLanguage
      });
      const playbackId = crypto.randomUUID();
      this.activeSpeech = {
        sessionId: request.sessionId,
        providerId: provider.id,
        playback,
        startedAt: nowIso(),
        text,
        playbackId
      };

      sessionState.speakingState = 'speaking';
      sessionState.voiceModeState = this.settings.voiceModeEnabled
        ? 'speaking'
        : sessionState.voiceModeState;
      sessionState.lastAssistantMessage = text;
      sessionState.lastError = undefined;
      sessionState.ttsProviderId = provider.id;
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      await this.notifyStateChanged();

      void playback.completed
        .then(async (result) => {
        if (!this.activeSpeech || this.activeSpeech.playbackId !== playbackId) {
          return;
        }

        this.activeSpeech = null;
        const nextSessionState = this.resolveSessionState(request.sessionId);
        nextSessionState.speakingState = 'idle';
        nextSessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
        nextSessionState.updatedAt = nowIso();
        await this.persistSessionState(nextSessionState);

        await this.recordVoiceTelemetry({
          sessionId: request.sessionId,
          channel: 'voice_tts',
          providerId: provider.id,
          model: this.settings.preferredLanguage,
          result: 'success',
          totalDurationMs: result.audioDurationMs,
          audioDurationMs: result.audioDurationMs,
          textLength: text.length,
          messagePreview: text.slice(0, 140)
        });
        await this.notifyStateChanged();
      })
      .catch(async (error) => {
        if (!this.activeSpeech || this.activeSpeech.playbackId !== playbackId) {
          return;
        }

        this.activeSpeech = null;
        const nextSessionState = this.resolveSessionState(request.sessionId);
        nextSessionState.speakingState = 'error';
        nextSessionState.voiceModeState = 'error';
        nextSessionState.lastError =
          error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown TTS error';
        nextSessionState.updatedAt = nowIso();
        await this.persistSessionState(nextSessionState);

        await this.recordVoiceTelemetry({
          sessionId: request.sessionId,
          channel: 'voice_tts',
          providerId: provider.id,
          model: this.settings.preferredLanguage,
          result: 'error',
          totalDurationMs: 0,
          textLength: text.length,
          messagePreview: text.slice(0, 140),
          errorMessage: nextSessionState.lastError
        });
        await this.notifyStateChanged();
      });

      return {
        voice: await this.buildVoiceSystemState(request.sessionId)
      };
    } catch (error) {
      sessionState.speakingState = 'error';
      sessionState.voiceModeState = 'error';
      sessionState.lastError =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown TTS error';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      await this.recordVoiceTelemetry({
        sessionId: request.sessionId,
        channel: 'voice_tts',
        providerId: provider.id,
        model: this.settings.preferredLanguage,
        result: 'error',
        totalDurationMs: 0,
        textLength: text.length,
        messagePreview: text.slice(0, 140),
        errorMessage: sessionState.lastError
      });
      await this.notifyStateChanged();
      throw error;
    }
  }

  async stopSpeaking(request: { sessionId?: string | null }): Promise<VoiceSpeakResponse> {
    const activeSpeech = this.activeSpeech;
    if (
      !activeSpeech ||
      (request.sessionId && activeSpeech.sessionId !== request.sessionId)
    ) {
      return {
        voice: await this.buildVoiceSystemState(request.sessionId ?? this.mostRecentSessionId)
      };
    }

    await activeSpeech.playback.stop();
    this.activeSpeech = null;

    const sessionState = this.resolveSessionState(activeSpeech.sessionId);
    sessionState.speakingState = 'idle';
    sessionState.voiceModeState = resolveIdleVoiceModeState(this.settings);
    sessionState.updatedAt = nowIso();
    await this.persistSessionState(sessionState);
    await this.notifyStateChanged();

    return {
      voice: await this.buildVoiceSystemState(activeSpeech.sessionId)
    };
  }

  async maybeAutoReadSnapshot(
    sessionId: string,
    snapshot: SessionSnapshot
  ): Promise<void> {
    if (!this.settings.autoReadResponses) {
      return;
    }

    const text = getLastAssistantMessage(snapshot);
    if (!text) {
      return;
    }

    try {
      await this.speak({
        sessionId,
        text
      });
    } catch (error) {
      const sessionState = this.resolveSessionState(sessionId);
      sessionState.speakingState = 'error';
      sessionState.lastError =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown TTS error';
      sessionState.updatedAt = nowIso();
      await this.persistSessionState(sessionState);
      await this.notifyStateChanged();
    }
  }

  private resolveSessionState(sessionId: string): VoiceSessionState {
    const existing = this.sessionStates.get(sessionId);
    if (existing) {
      return existing;
    }

    const nextState = createVoiceSessionState(
      sessionId,
      this.settings,
      this.resolveSelectedSttHealth()?.available ?? false
    );
    this.sessionStates.set(sessionId, nextState);
    return nextState;
  }

  private async persistSessionState(state: VoiceSessionState): Promise<void> {
    this.sessionStates.set(state.sessionId ?? crypto.randomUUID(), {
      ...state
    });
  }

  private async transcribeAudio(
    sessionId: string,
    audio: VoiceRecordingStopRequest['audio']
  ): Promise<{ provider: SpeechToTextProvider; result: SpeechToTextResult }> {
    await this.refreshProviderHealth();
    const provider = this.sttProviders.get(this.settings.sttProviderId);
    if (!provider) {
      throw new Error('No hay un provider STT configurado para esta fase.');
    }

    const providerHealth = (await this.refreshProviderHealth()).sttProviders.find(
      (entry) => entry.providerId === provider.id
    );
    if (!providerHealth?.available) {
      throw new Error(
        providerHealth?.error ??
          'El provider STT seleccionado no esta disponible ahora mismo.'
      );
    }

    const handle = await provider.startListening({
      sessionId,
      language: this.settings.preferredLanguage
    });

    try {
      return {
        provider,
        result: await handle.stop({
          audio
        })
      };
    } catch (error) {
      await handle.cancel().catch(() => undefined);
      throw error;
    }
  }

  private normalizeSettings(settings: VoiceSettings): VoiceSettings {
    const wakeWord = this.config.wakeWord.trim();
    const wakeWordAliases = this.config.wakeWordAliases
      .map((alias) => alias.trim())
      .filter(Boolean);

    return {
      ...settings,
      sttProviderId: resolveAvailableProviderId(
        this.sttProviders,
        settings.sttProviderId,
        this.config.voiceSttProviderId
      ),
      ttsProviderId: resolveAvailableProviderId(
        this.ttsProviders,
        settings.ttsProviderId,
        this.config.voiceTtsProviderId
      ),
      voiceModeEnabled: Boolean(settings.voiceModeEnabled),
      micMuted: Boolean(settings.micMuted),
      wakeWordEnabled: Boolean(this.config.wakeWordEnabled),
      wakeWord,
      wakeWordAliases,
      wakeWindowMs: Math.max(750, this.config.wakeWindowMs),
      wakeIntervalMs: Math.max(100, this.config.wakeIntervalMs),
      activeSilenceMs: Math.max(400, this.config.activeSilenceMs),
      activeMaxMs: Math.max(3_000, this.config.activeMaxMs),
      activeMinSpeechMs: Math.max(150, this.config.activeMinSpeechMs),
      activePrerollMs: Math.max(0, this.config.activePrerollMs),
      activePostrollMs: Math.max(0, this.config.activePostrollMs),
      wakeDebug: Boolean(this.config.wakeDebug)
    };
  }

  private resolveSelectedSttHealth(): VoiceProviderHealth | undefined {
    return this.providerHealthCache?.sttProviders.find(
      (entry) => entry.providerId === this.settings.sttProviderId
    );
  }

  private async buildVoiceSystemState(
    sessionId?: string | null
  ): Promise<VoiceSystemState> {
    const providerHealth = await this.refreshProviderHealth();
    const sessionState = sessionId ? this.sessionStates.get(sessionId) ?? null : null;
    const selectedStt = providerHealth.sttProviders.find(
      (entry) => entry.providerId === this.settings.sttProviderId
    );
    const selectedTts = providerHealth.ttsProviders.find(
      (entry) => entry.providerId === this.settings.ttsProviderId
    );
    const ready = Boolean(selectedStt?.available && selectedTts?.available);
    const degraded = Boolean(selectedStt?.available || selectedTts?.available);
    const status: VoiceSystemState['status'] = ready
      ? 'ready'
      : degraded
        ? 'degraded'
        : 'unavailable';

    return {
      available: degraded,
      status,
      settings: {
        ...this.settings
      },
      sttProviders: providerHealth.sttProviders.map((entry) => ({ ...entry })),
      ttsProviders: providerHealth.ttsProviders.map((entry) => ({ ...entry })),
      microphoneAccessible: selectedStt?.available ?? false,
      session: cloneVoiceSessionState(sessionState),
      lastError:
        sessionState?.lastError ?? selectedStt?.error ?? selectedTts?.error ?? undefined
    };
  }

  private async refreshProviderHealth(force = false): Promise<ProviderHealthCache> {
    if (
      !force &&
      this.providerHealthCache &&
      Date.now() - this.providerHealthCache.checkedAt < PROVIDER_HEALTH_TTL_MS
    ) {
      return this.providerHealthCache;
    }

    const sttProviders = await Promise.all(
      [...this.sttProviders.values()].map(async (provider) => ({
        ...(await provider.healthCheck(this.settings)),
        active: provider.id === this.settings.sttProviderId
      }))
    );
    const ttsProviders = await Promise.all(
      [...this.ttsProviders.values()].map(async (provider) => ({
        ...(await provider.healthCheck(this.settings)),
        active: provider.id === this.settings.ttsProviderId
      }))
    );

    this.providerHealthCache = {
      checkedAt: Date.now(),
      sttProviders,
      ttsProviders
    };

    return this.providerHealthCache;
  }

  private async recordVoiceTelemetry(
    input: Omit<
      TelemetryRecord,
      | 'id'
      | 'timestamp'
      | 'privacyMode'
      | 'runtimeMode'
      | 'toolsUsed'
      | 'confirmationRequired'
      | 'toolCount'
    > & {
      sessionId?: string;
      channel: TelemetryChannel;
    }
  ): Promise<void> {
    const session = input.sessionId
      ? await this.chatRuntime.getSessionSnapshot(input.sessionId)
      : null;
    const mode = resolveModes(session);

    await this.telemetry.record({
      id: crypto.randomUUID(),
      timestamp: nowIso(),
      sessionId: input.sessionId,
      providerId: input.providerId,
      model: input.model,
      channel: input.channel,
      privacyMode: mode.privacy,
      runtimeMode: mode.runtime,
      totalDurationMs: input.totalDurationMs,
      providerLatencyMs: input.providerLatencyMs,
      estimatedCostUsd: input.estimatedCostUsd,
      toolsUsed: [`voice.${input.channel}`],
      confirmationRequired: false,
      result: input.result,
      errorMessage: input.errorMessage,
      toolCount: 0,
      messagePreview: input.messagePreview,
      fallbackUsed: input.fallbackUsed,
      fallbackReason: input.fallbackReason,
      audioDurationMs: input.audioDurationMs,
      textLength: input.textLength,
      eventType: input.eventType
    });
  }

  private async notifyStateChanged(): Promise<void> {
    await this.onStateChanged?.();
  }
}
