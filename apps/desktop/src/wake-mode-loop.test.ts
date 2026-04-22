import { describe, expect, it, vi } from 'vitest';

import {
  BrowserConversationModeLoop,
  BrowserWakeModeLoop,
  measureAudioFrame,
  sleepUntilTimeoutOrAbort,
  updateActiveSpeechDetector,
  type ActiveSpeechDetectorState
} from './wake-mode-loop';

function detectorState(): ActiveSpeechDetectorState {
  return {
    startedAtMs: 0,
    speechDetected: false,
    lastState: 'active_listening'
  };
}

const config = {
  activeSilenceMs: 2_000,
  activeMaxMs: 30_000,
  activeMinSpeechMs: 800
};

describe('wake-mode active speech detector', () => {
  it('measures peak and RMS for an audio frame', () => {
    const levels = measureAudioFrame(new Float32Array([0, 0.1, -0.2, 0.1]));

    expect(levels.peakLevel).toBeCloseTo(0.2);
    expect(levels.rmsLevel).toBeGreaterThan(0.1);
  });

  it('transitions to speech_detected when frame energy is useful', () => {
    const update = updateActiveSpeechDetector(
      detectorState(),
      {
        nowMs: 300,
        peakLevel: 0.08,
        rmsLevel: 0.02
      },
      config
    );

    expect(update.stateEvent).toBe('speech_detected');
    expect(update.nextState.speechDetected).toBe(true);
  });

  it('closes active listening after sustained silence following speech', () => {
    const withSpeech = updateActiveSpeechDetector(
      detectorState(),
      {
        nowMs: 100,
        peakLevel: 0.08,
        rmsLevel: 0.02
      },
      config
    ).nextState;
    const silenceStart = updateActiveSpeechDetector(
      withSpeech,
      {
        nowMs: 1_100,
        peakLevel: 0,
        rmsLevel: 0
      },
      config
    ).nextState;
    const update = updateActiveSpeechDetector(
      silenceStart,
      {
        nowMs: 3_200,
        peakLevel: 0,
        rmsLevel: 0
      },
      config
    );

    expect(update.finishReason).toBe('silence');
  });

  it('closes by max duration without speech instead of sending empty audio', () => {
    const update = updateActiveSpeechDetector(
      detectorState(),
      {
        nowMs: 30_500,
        peakLevel: 0,
        rmsLevel: 0
      },
      config
    );

    expect(update.finishReason).toBe('no_speech');
  });

  it('closes by max duration after speech when the user never pauses', () => {
    const withSpeech = updateActiveSpeechDetector(
      detectorState(),
      {
        nowMs: 100,
        peakLevel: 0.08,
        rmsLevel: 0.02
      },
      config
    ).nextState;
    const update = updateActiveSpeechDetector(
      withSpeech,
      {
        nowMs: 30_100,
        peakLevel: 0.09,
        rmsLevel: 0.03
      },
      config
    );

    expect(update.finishReason).toBe('max_duration');
  });

  it('resolves wake waits immediately when stop aborts the loop', async () => {
    const abortController = new AbortController();
    const delay = sleepUntilTimeoutOrAbort(2_500, abortController.signal);

    abortController.abort();

    await expect(delay).resolves.toBeUndefined();
  });

  it('does not capture conversation audio while the mode is off or muted', async () => {
    let getUserMediaCalls = 0;
    const loop = new BrowserConversationModeLoop(
      {
        ...config,
        activePrerollMs: 700,
        activePostrollMs: 500,
        idleIntervalMs: 1
      },
      {
        shouldCaptureTurn: () => false,
        onConversationWaiting: async () => undefined,
        onActiveListeningStart: async () => undefined,
        onActiveState: async () => undefined,
        onActiveAudio: async () => undefined,
        onActiveNoSpeech: async () => undefined,
        onError: () => undefined
      },
      {
        delay: async () => undefined,
        getUserMedia: async () => {
          getUserMediaCalls += 1;
          throw new Error('should not capture');
        }
      }
    );

    loop.start();
    await loop.stop();

    expect(getUserMediaCalls).toBe(0);
  });

  it('does not mark active listening before the browser microphone is acquired', async () => {
    let loop: BrowserWakeModeLoop;
    let activeStarted = false;
    let capturedError: Error | undefined;
    const errorReceived = new Promise<void>((resolve) => {
      loop = new BrowserWakeModeLoop(
        {
          wakeWindowMs: 10,
          wakeIntervalMs: 10,
          activeSilenceMs: 1_200,
          activeMaxMs: 20_000,
          activeMinSpeechMs: 500
        },
        {
          onWakeWindow: async () => ({ wakeDetected: true }),
          onWakeDetected: async () => undefined,
          onActiveListeningStart: async () => {
            activeStarted = true;
          },
          onActiveState: async () => undefined,
          onActiveAudio: async () => undefined,
          onActiveNoSpeech: async () => undefined,
          onError: (error) => {
            capturedError = error;
            void loop.stop();
            resolve();
          }
        },
        {
          createWakeRecorder: () => ({
            start: vi.fn(async () => undefined),
            stop: vi.fn(async () => ({
              mimeType: 'audio/wav',
              base64Data: 'UklGRg==',
              durationMs: 10
            })),
            cancel: vi.fn(async () => undefined)
          }),
          delay: async () => undefined,
          getUserMedia: async () => {
            throw new Error('Microphone permission denied');
          }
        }
      );
    });

    loop!.start();
    await errorReceived;
    await loop!.stop();

    expect(activeStarted).toBe(false);
    expect(capturedError?.message).toContain('Microphone permission denied');
  });
});
