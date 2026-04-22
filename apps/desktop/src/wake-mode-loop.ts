import type {
  SpeechToTextAudioInput,
  VoiceModeState
} from '@assem/shared-types';

import {
  analyzeMonoPcmCapture,
  arrayBufferToBase64,
  BrowserVoiceRecorder,
  downsampleMonoPcm,
  encodePcm16Wav,
  normalizeMonoPcmLevel
} from './audio-recorder';

type ActiveListeningFinishReason = 'silence' | 'max_duration' | 'no_speech';

export interface WakeModeLoopSettings {
  wakeWindowMs: number;
  wakeIntervalMs: number;
  activeSilenceMs: number;
  activeMaxMs: number;
  activeMinSpeechMs: number;
  activePrerollMs?: number;
  activePostrollMs?: number;
}

export interface WakeModeLoopHandlers {
  shouldCaptureWakeWindow?: () => boolean;
  onWakeWindow: (audio: SpeechToTextAudioInput) => Promise<{ wakeDetected: boolean }>;
  onWakeDetected: () => Promise<void>;
  onActiveListeningStart: () => Promise<void>;
  onActiveState: (state: VoiceModeState, audioDurationMs: number) => Promise<void>;
  onActiveAudio: (
    audio: SpeechToTextAudioInput,
    reason: Exclude<ActiveListeningFinishReason, 'no_speech'>
  ) => Promise<void>;
  onActiveNoSpeech: (reason: 'no_speech') => Promise<void>;
  onError: (error: Error) => void;
}

export interface AudioFrameLevels {
  peakLevel: number;
  rmsLevel: number;
}

export interface ActiveSpeechDetectorConfig {
  activeSilenceMs: number;
  activeMaxMs: number;
  activeMinSpeechMs: number;
  speechPeakThreshold?: number;
  speechRmsThreshold?: number;
}

export interface ActiveSpeechDetectorState {
  startedAtMs: number;
  speechDetected: boolean;
  speechStartedAtMs?: number;
  silenceStartedAtMs?: number;
  lastState: VoiceModeState;
}

export interface ActiveSpeechDetectorUpdate {
  nextState: ActiveSpeechDetectorState;
  stateEvent?: VoiceModeState;
  finishReason?: ActiveListeningFinishReason;
}

const TARGET_SAMPLE_RATE_HZ = 16_000;
const SPEECH_PEAK_THRESHOLD = 0.025;
const SPEECH_RMS_THRESHOLD = 0.0045;

export function sleepUntilTimeoutOrAbort(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };

    signal?.addEventListener('abort', abort, { once: true });
  });
}

function concatenateFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function totalChunkSamples(chunks: Float32Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function trimChunksToSampleBudget(chunks: Float32Array[], maxSamples: number): void {
  while (chunks.length > 0 && totalChunkSamples(chunks) > maxSamples) {
    chunks.shift();
  }
}

export function measureAudioFrame(samples: Float32Array): AudioFrameLevels {
  let peakLevel = 0;
  let squareSum = 0;

  for (const sample of samples) {
    const amplitude = Math.abs(sample);
    peakLevel = Math.max(peakLevel, amplitude);
    squareSum += sample * sample;
  }

  return {
    peakLevel,
    rmsLevel: samples.length > 0 ? Math.sqrt(squareSum / samples.length) : 0
  };
}

function isSpeechFrame(
  levels: AudioFrameLevels,
  config: ActiveSpeechDetectorConfig
): boolean {
  return (
    levels.peakLevel >= (config.speechPeakThreshold ?? SPEECH_PEAK_THRESHOLD) ||
    levels.rmsLevel >= (config.speechRmsThreshold ?? SPEECH_RMS_THRESHOLD)
  );
}

export function updateActiveSpeechDetector(
  state: ActiveSpeechDetectorState,
  frame: AudioFrameLevels & { nowMs: number },
  config: ActiveSpeechDetectorConfig
): ActiveSpeechDetectorUpdate {
  const elapsedMs = frame.nowMs - state.startedAtMs;
  if (elapsedMs >= config.activeMaxMs) {
    return {
      nextState: {
        ...state,
        lastState: state.speechDetected ? state.lastState : 'active_listening'
      },
      finishReason: state.speechDetected ? 'max_duration' : 'no_speech'
    };
  }

  const isSpeech =
    frame.peakLevel >= (config.speechPeakThreshold ?? SPEECH_PEAK_THRESHOLD) ||
    frame.rmsLevel >= (config.speechRmsThreshold ?? SPEECH_RMS_THRESHOLD);

  if (isSpeech) {
    if (!state.speechDetected) {
      const nextState: ActiveSpeechDetectorState = {
        ...state,
        speechDetected: true,
        speechStartedAtMs: frame.nowMs,
        silenceStartedAtMs: undefined,
        lastState: 'speech_detected'
      };
      return {
        nextState,
        stateEvent: 'speech_detected'
      };
    }

    return {
      nextState: {
        ...state,
        silenceStartedAtMs: undefined,
        lastState: 'speech_detected'
      }
    };
  }

  if (!state.speechDetected) {
    return {
      nextState: state
    };
  }

  const silenceStartedAtMs = state.silenceStartedAtMs ?? frame.nowMs;
  const speechDurationMs = frame.nowMs - (state.speechStartedAtMs ?? frame.nowMs);
  const silenceDurationMs = frame.nowMs - silenceStartedAtMs;
  const nextState: ActiveSpeechDetectorState = {
    ...state,
    silenceStartedAtMs,
    lastState: 'silence_wait'
  };

  if (
    silenceDurationMs >= config.activeSilenceMs &&
    speechDurationMs >= config.activeMinSpeechMs
  ) {
    return {
      nextState,
      finishReason: 'silence'
    };
  }

  return {
    nextState,
    stateEvent: state.lastState === 'silence_wait' ? undefined : 'silence_wait'
  };
}

interface ActiveBrowserListening {
  stream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
}

type WakeAudioRecorder = Pick<BrowserVoiceRecorder, 'start' | 'stop' | 'cancel'>;

export interface WakeModeLoopDependencies {
  createWakeRecorder?: () => WakeAudioRecorder;
  getUserMedia?: () => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ConversationModeLoopSettings {
  activeSilenceMs: number;
  activeMaxMs: number;
  activeMinSpeechMs: number;
  activePrerollMs: number;
  activePostrollMs: number;
  idleIntervalMs?: number;
}

export interface ConversationModeLoopHandlers {
  shouldCaptureTurn?: () => boolean;
  onConversationWaiting: () => Promise<void>;
  onActiveListeningStart: () => Promise<void>;
  onActiveState: (state: VoiceModeState, audioDurationMs: number) => Promise<void>;
  onActiveAudio: (
    audio: SpeechToTextAudioInput,
    reason: Exclude<ActiveListeningFinishReason, 'no_speech'>
  ) => Promise<void>;
  onActiveNoSpeech: (reason: 'no_speech') => Promise<void>;
  onError: (error: Error) => void;
}

export class BrowserWakeModeLoop {
  private stopped = true;
  private wakeRecorder: WakeAudioRecorder | null = null;
  private activeListening: ActiveBrowserListening | null = null;
  private activeResolve: (() => void) | null = null;
  private runningPromise: Promise<void> | null = null;
  private stopController: AbortController | null = null;

  constructor(
    private readonly settings: WakeModeLoopSettings,
    private readonly handlers: WakeModeLoopHandlers,
    private readonly dependencies: WakeModeLoopDependencies = {}
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.stopController = new AbortController();
    this.runningPromise = this.run().catch((error) => {
      this.handlers.onError(error instanceof Error ? error : new Error('Wake mode failed.'));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopController?.abort();
    await this.wakeRecorder?.cancel().catch(() => undefined);
    this.wakeRecorder = null;
    await this.disposeActiveListening();
    this.activeResolve?.();
    this.activeResolve = null;
    await this.runningPromise?.catch(() => undefined);
    this.runningPromise = null;
    this.stopController = null;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (this.handlers.shouldCaptureWakeWindow?.() === false) {
        await this.delay(this.settings.wakeIntervalMs);
        continue;
      }

      try {
        const wakeDetected = await this.captureWakeWindow();
        if (wakeDetected && !this.stopped) {
          await this.captureActiveUtterance();
        }
      } catch (error) {
        if (!this.stopped) {
          this.handlers.onError(
            error instanceof Error ? error : new Error('Wake mode capture failed.')
          );
        }
      }

      if (!this.stopped) {
        await this.delay(this.settings.wakeIntervalMs);
      }
    }
  }

  private async captureWakeWindow(): Promise<boolean> {
    const wakeRecorder = this.dependencies.createWakeRecorder?.() ?? new BrowserVoiceRecorder();
    this.wakeRecorder = wakeRecorder;

    try {
      await wakeRecorder.start();
      await this.delay(this.settings.wakeWindowMs);

      if (this.stopped) {
        await wakeRecorder.cancel().catch(() => undefined);
        return false;
      }

      const audio = await wakeRecorder.stop();

      if (this.stopped) {
        return false;
      }

      const response = await this.handlers.onWakeWindow({
        ...audio,
        fileName: 'assem-wake-window.wav'
      });
      if (response.wakeDetected) {
        await this.handlers.onWakeDetected();
      }

      return response.wakeDetected;
    } finally {
      if (this.wakeRecorder === wakeRecorder) {
        this.wakeRecorder = null;
      }
    }
  }

  private async captureActiveUtterance(): Promise<void> {
    const stream = await this.getUserMedia();
    await this.handlers.onActiveListeningStart();
    const audioContext = this.createAudioContext();
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    const startedAt = this.now();
    let detectorState: ActiveSpeechDetectorState = {
      startedAtMs: startedAt,
      speechDetected: false,
      lastState: 'active_listening'
    };
    let finishing = false;

    this.activeListening = {
      stream,
      audioContext,
      source,
      processor,
      chunks
    };

    await new Promise<void>((resolve) => {
      this.activeResolve = resolve;
      const finish = (reason: ActiveListeningFinishReason) => {
        if (finishing) {
          return;
        }

        finishing = true;
        void this.finishActiveUtterance(reason, startedAt)
          .catch((error) => {
            this.handlers.onError(
              error instanceof Error ? error : new Error('Active listening failed.')
            );
          })
          .finally(() => {
            this.activeResolve = null;
            resolve();
          });
      };

      processor.onaudioprocess = (event) => {
        if (this.stopped || finishing) {
          finish('no_speech');
          return;
        }

        const inputChannel = event.inputBuffer.getChannelData(0);
        const frame = new Float32Array(inputChannel);
        chunks.push(frame);

        const update = updateActiveSpeechDetector(
          detectorState,
          {
            ...measureAudioFrame(frame),
            nowMs: this.now()
          },
          this.settings
        );
        detectorState = update.nextState;

        if (update.stateEvent) {
          void this.handlers.onActiveState(
            update.stateEvent,
            Math.round(this.now() - startedAt)
          );
        }

        if (update.finishReason) {
          finish(update.finishReason);
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    });
  }

  private async finishActiveUtterance(
    reason: ActiveListeningFinishReason,
    startedAt: number
  ): Promise<void> {
    const activeListening = this.activeListening;
    if (!activeListening) {
      await this.handlers.onActiveNoSpeech('no_speech');
      return;
    }

    const chunks = [...activeListening.chunks];
    const inputSampleRate = activeListening.audioContext.sampleRate;
    await this.disposeActiveListening();

    if (reason === 'no_speech' || chunks.length === 0) {
      await this.handlers.onActiveNoSpeech('no_speech');
      return;
    }

    const pcm = concatenateFloat32Chunks(chunks);
    if (pcm.length === 0) {
      await this.handlers.onActiveNoSpeech('no_speech');
      return;
    }

    const downsampled = downsampleMonoPcm(pcm, inputSampleRate, TARGET_SAMPLE_RATE_HZ);
    const normalized = normalizeMonoPcmLevel(downsampled);
    const wavBuffer = encodePcm16Wav(normalized.samples, TARGET_SAMPLE_RATE_HZ);
    const diagnostics = analyzeMonoPcmCapture(
      normalized.samples,
      TARGET_SAMPLE_RATE_HZ,
      inputSampleRate,
      normalized.gainApplied
    );

    await this.handlers.onActiveAudio(
      {
        mimeType: 'audio/wav',
        fileName: 'assem-wake-active.wav',
        base64Data: arrayBufferToBase64(wavBuffer),
        durationMs: Math.round(this.now() - startedAt),
        diagnostics: {
          ...diagnostics,
          byteLength: wavBuffer.byteLength
        }
      },
      reason
    );
  }

  private async disposeActiveListening(): Promise<void> {
    const activeListening = this.activeListening;
    if (!activeListening) {
      return;
    }

    this.activeListening = null;
    activeListening.processor.onaudioprocess = null;
    activeListening.source.disconnect();
    activeListening.processor.disconnect();
    activeListening.stream.getTracks().forEach((track) => track.stop());
    await activeListening.audioContext.close().catch(() => undefined);
  }

  private delay(ms: number): Promise<void> {
    return (this.dependencies.delay ?? sleepUntilTimeoutOrAbort)(
      ms,
      this.stopController?.signal
    );
  }

  private async getUserMedia(): Promise<MediaStream> {
    if (this.dependencies.getUserMedia) {
      return await this.dependencies.getUserMedia();
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error('El microfono no esta disponible para modo voz.');
    }

    return await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  }

  private createAudioContext(): AudioContext {
    return this.dependencies.createAudioContext?.() ?? new AudioContext();
  }

  private now(): number {
    return this.dependencies.now?.() ?? performance.now();
  }
}

export class BrowserConversationModeLoop {
  private stopped = true;
  private activeListening: ActiveBrowserListening | null = null;
  private activeResolve: (() => void) | null = null;
  private runningPromise: Promise<void> | null = null;
  private stopController: AbortController | null = null;

  constructor(
    private readonly settings: ConversationModeLoopSettings,
    private readonly handlers: ConversationModeLoopHandlers,
    private readonly dependencies: WakeModeLoopDependencies = {}
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.stopController = new AbortController();
    this.runningPromise = this.run().catch((error) => {
      this.handlers.onError(
        error instanceof Error ? error : new Error('Conversation mode failed.')
      );
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopController?.abort();
    await this.disposeActiveListening();
    this.activeResolve?.();
    this.activeResolve = null;
    await this.runningPromise?.catch(() => undefined);
    this.runningPromise = null;
    this.stopController = null;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (this.handlers.shouldCaptureTurn?.() === false) {
        await this.delay(this.settings.idleIntervalMs ?? 150);
        continue;
      }

      try {
        await this.captureConversationTurn();
      } catch (error) {
        if (!this.stopped) {
          this.handlers.onError(
            error instanceof Error ? error : new Error('Conversation turn failed.')
          );
        }
      }

      if (!this.stopped) {
        await this.delay(this.settings.idleIntervalMs ?? 150);
      }
    }
  }

  private async captureConversationTurn(): Promise<void> {
    const stream = await this.getUserMedia();
    const audioContext = this.createAudioContext();
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    const preRollChunks: Float32Array[] = [];
    const maxPreRollSamples = Math.max(
      0,
      Math.round((audioContext.sampleRate * this.settings.activePrerollMs) / 1_000)
    );

    let detectorState: ActiveSpeechDetectorState | null = null;
    let turnStartedAt = 0;
    let activeStartPromise: Promise<void> = Promise.resolve();
    let pendingSilenceFinishAt: number | null = null;
    let finishing = false;

    this.activeListening = {
      stream,
      audioContext,
      source,
      processor,
      chunks
    };

    await this.handlers.onConversationWaiting();

    await new Promise<void>((resolve) => {
      this.activeResolve = resolve;

      const fail = (error: unknown) => {
        if (finishing) {
          return;
        }

        finishing = true;
        void this.disposeActiveListening()
          .catch(() => undefined)
          .finally(() => {
            this.handlers.onError(
              error instanceof Error ? error : new Error('Conversation mode failed.')
            );
            this.activeResolve = null;
            resolve();
          });
      };

      const finish = (reason: ActiveListeningFinishReason) => {
        if (finishing) {
          return;
        }

        finishing = true;
        void activeStartPromise
          .then(() => this.finishConversationTurn(reason, turnStartedAt || this.now()))
          .catch((error) => {
            this.handlers.onError(
              error instanceof Error ? error : new Error('Conversation turn failed.')
            );
          })
          .finally(() => {
            this.activeResolve = null;
            resolve();
          });
      };

      processor.onaudioprocess = (event) => {
        if (this.stopped || finishing) {
          finish('no_speech');
          return;
        }

        const inputChannel = event.inputBuffer.getChannelData(0);
        const frame = new Float32Array(inputChannel);
        const levels = measureAudioFrame(frame);
        const now = this.now();

        if (!detectorState) {
          preRollChunks.push(frame);
          if (maxPreRollSamples > 0) {
            trimChunksToSampleBudget(preRollChunks, maxPreRollSamples);
          } else {
            preRollChunks.length = 0;
          }

          if (!isSpeechFrame(levels, this.settings)) {
            return;
          }

          turnStartedAt = now;
          chunks.push(...preRollChunks, frame);
          detectorState = {
            startedAtMs: turnStartedAt,
            speechDetected: false,
            lastState: 'active_listening'
          };
          activeStartPromise = this.handlers.onActiveListeningStart();
        } else {
          chunks.push(frame);
        }

        const update = updateActiveSpeechDetector(
          detectorState,
          {
            ...levels,
            nowMs: now
          },
          this.settings
        );
        detectorState = update.nextState;

        if (pendingSilenceFinishAt !== null && isSpeechFrame(levels, this.settings)) {
          pendingSilenceFinishAt = null;
        }

        if (update.stateEvent) {
          void activeStartPromise
            .then(() =>
              this.handlers.onActiveState(
                update.stateEvent!,
                Math.round(now - turnStartedAt)
              )
            )
            .catch(fail);
        }

        if (update.finishReason === 'silence') {
          if (pendingSilenceFinishAt === null) {
            pendingSilenceFinishAt = now + this.settings.activePostrollMs;
            void activeStartPromise
              .then(() =>
                this.handlers.onActiveState(
                  'closing_turn',
                  Math.round(now - turnStartedAt)
                )
              )
              .catch(fail);
          }

          if (now >= pendingSilenceFinishAt) {
            finish('silence');
          }
          return;
        }

        if (update.finishReason) {
          finish(update.finishReason);
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    });
  }

  private async finishConversationTurn(
    reason: ActiveListeningFinishReason,
    startedAt: number
  ): Promise<void> {
    const activeListening = this.activeListening;
    if (!activeListening) {
      await this.handlers.onActiveNoSpeech('no_speech');
      return;
    }

    const chunks = [...activeListening.chunks];
    const inputSampleRate = activeListening.audioContext.sampleRate;
    await this.disposeActiveListening();

    if (reason === 'no_speech' || chunks.length === 0) {
      await this.handlers.onActiveNoSpeech('no_speech');
      return;
    }

    const pcm = concatenateFloat32Chunks(chunks);
    if (pcm.length === 0) {
      await this.handlers.onActiveNoSpeech('no_speech');
      return;
    }

    const downsampled = downsampleMonoPcm(pcm, inputSampleRate, TARGET_SAMPLE_RATE_HZ);
    const normalized = normalizeMonoPcmLevel(downsampled);
    const wavBuffer = encodePcm16Wav(normalized.samples, TARGET_SAMPLE_RATE_HZ);
    const diagnostics = analyzeMonoPcmCapture(
      normalized.samples,
      TARGET_SAMPLE_RATE_HZ,
      inputSampleRate,
      normalized.gainApplied
    );

    await this.handlers.onActiveAudio(
      {
        mimeType: 'audio/wav',
        fileName: 'assem-conversation-turn.wav',
        base64Data: arrayBufferToBase64(wavBuffer),
        durationMs: Math.round(this.now() - startedAt),
        diagnostics: {
          ...diagnostics,
          byteLength: wavBuffer.byteLength
        }
      },
      reason
    );
  }

  private async disposeActiveListening(): Promise<void> {
    const activeListening = this.activeListening;
    if (!activeListening) {
      return;
    }

    this.activeListening = null;
    activeListening.processor.onaudioprocess = null;
    activeListening.source.disconnect();
    activeListening.processor.disconnect();
    activeListening.stream.getTracks().forEach((track) => track.stop());
    await activeListening.audioContext.close().catch(() => undefined);
  }

  private delay(ms: number): Promise<void> {
    return (this.dependencies.delay ?? sleepUntilTimeoutOrAbort)(
      ms,
      this.stopController?.signal
    );
  }

  private async getUserMedia(): Promise<MediaStream> {
    if (this.dependencies.getUserMedia) {
      return await this.dependencies.getUserMedia();
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error('El microfono no esta disponible para modo conversacion.');
    }

    return await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  }

  private createAudioContext(): AudioContext {
    return this.dependencies.createAudioContext?.() ?? new AudioContext();
  }

  private now(): number {
    return this.dependencies.now?.() ?? performance.now();
  }
}
