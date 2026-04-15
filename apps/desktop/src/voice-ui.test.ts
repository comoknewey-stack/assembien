import { describe, expect, it } from 'vitest';

import type { VoiceSystemState } from '@assem/shared-types';

import {
  canSpeakAssistantReply,
  canStartVoiceCapture,
  canStopVoiceCapture,
  voiceActivityLabel,
  voiceAvailabilityLabel
} from './voice-ui';

function createVoiceState(
  overrides: Partial<VoiceSystemState> = {}
): VoiceSystemState {
  return {
    available: true,
    status: 'ready',
    settings: {
      sttProviderId: 'windows-system-stt',
      ttsProviderId: 'windows-system-tts',
      preferredLanguage: 'es-ES',
      autoReadResponses: false
    },
    sttProviders: [
      {
        providerId: 'windows-system-stt',
        label: 'Windows STT',
        kind: 'stt',
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true,
        active: true
      }
    ],
    ttsProviders: [
      {
        providerId: 'windows-system-tts',
        label: 'Windows TTS',
        kind: 'tts',
        status: 'ok',
        checkedAt: new Date().toISOString(),
        configured: true,
        available: true,
        active: true
      }
    ],
    microphoneAccessible: true,
    session: {
      sessionId: 'session-1',
      recordingState: 'idle',
      speakingState: 'idle',
      microphoneAccessible: true,
      sttProviderId: 'windows-system-stt',
      ttsProviderId: 'windows-system-tts',
      autoReadResponses: false,
      preferredLanguage: 'es-ES',
      updatedAt: new Date().toISOString()
    },
    ...overrides
  };
}

describe('voice-ui helpers', () => {
  it('describes ready voice availability in Spanish', () => {
    expect(voiceAvailabilityLabel(createVoiceState())).toBe('lista');
  });

  it('describes recording and transcribing activity states', () => {
    expect(
      voiceActivityLabel(
        createVoiceState({
          session: {
            ...createVoiceState().session!,
            recordingState: 'recording'
          }
        })
      )
    ).toBe('Grabando');

    expect(
      voiceActivityLabel(
        createVoiceState({
          session: {
            ...createVoiceState().session!,
            recordingState: 'transcribing'
          }
        })
      )
    ).toBe('Transcribiendo');
  });

  it('derives start and stop capture availability from voice state', () => {
    const idleVoice = createVoiceState();
    const recordingVoice = createVoiceState({
      session: {
        ...createVoiceState().session!,
        recordingState: 'recording'
      }
    });

    expect(canStartVoiceCapture(idleVoice, true, false)).toBe(true);
    expect(canStopVoiceCapture(idleVoice, true, false)).toBe(false);
    expect(canStartVoiceCapture(recordingVoice, true, false)).toBe(false);
    expect(canStopVoiceCapture(recordingVoice, true, false)).toBe(true);
  });

  it('reports unavailable or degraded states more honestly', () => {
    expect(
      voiceActivityLabel(
        createVoiceState({
          status: 'unavailable',
          available: false,
          session: null
        })
      )
    ).toBe('No disponible');

    expect(
      voiceActivityLabel(
        createVoiceState({
          status: 'degraded'
        })
      )
    ).toBe('Lista con limites');
  });

  it('disables capture when the selected STT provider is not available', () => {
    const unavailableSttVoice = createVoiceState({
      available: false,
      status: 'degraded',
      microphoneAccessible: false,
      sttProviders: [
        {
          ...createVoiceState().sttProviders[0],
          available: false,
          status: 'unavailable'
        }
      ]
    });

    expect(canStartVoiceCapture(unavailableSttVoice, true, false)).toBe(false);
    expect(canStopVoiceCapture(unavailableSttVoice, true, false)).toBe(false);
  });

  it('only enables manual speech when the TTS provider is available', () => {
    expect(canSpeakAssistantReply(createVoiceState(), true, true, false)).toBe(true);

    expect(
      canSpeakAssistantReply(
        createVoiceState({
          ttsProviders: [
            {
              ...createVoiceState().ttsProviders[0],
              available: false,
              status: 'unavailable'
            }
          ]
        }),
        true,
        true,
        false
      )
    ).toBe(false);

    expect(
      canSpeakAssistantReply(
        createVoiceState({
          session: {
            ...createVoiceState().session!,
            recordingState: 'recording'
          }
        }),
        true,
        true,
        false
      )
    ).toBe(false);
  });
});
