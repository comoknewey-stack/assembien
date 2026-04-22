import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { VoiceSystemState } from '@assem/shared-types';

import { VoiceOrb, resolveVoiceOrbState } from './voice-orb';

const now = '2026-04-21T10:00:00.000Z';

function makeVoice(overrides: Partial<VoiceSystemState> = {}): VoiceSystemState {
  return {
    available: true,
    status: 'ready',
    settings: {
      sttProviderId: 'whisper-cpp',
      ttsProviderId: 'windows-system-tts',
      preferredLanguage: 'es-ES',
      autoReadResponses: false,
      voiceModeEnabled: false,
      micMuted: false,
      wakeWordEnabled: false,
      wakeWord: 'prolijo',
      wakeWordAliases: ['pro lijo', 'polijo'],
      wakeWindowMs: 5000,
      wakeIntervalMs: 1000,
      activeSilenceMs: 900,
      activeMaxMs: 10000,
      activeMinSpeechMs: 400,
      activePrerollMs: 700,
      activePostrollMs: 500,
      wakeDebug: false
    },
    sttProviders: [
      {
        providerId: 'whisper-cpp',
        label: 'whisper.cpp',
        kind: 'stt',
        status: 'ok',
        checkedAt: now,
        configured: true,
        available: true,
        active: true
      }
    ],
    ttsProviders: [
      {
        providerId: 'windows-system-tts',
        label: 'Windows System TTS',
        kind: 'tts',
        status: 'ok',
        checkedAt: now,
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
      voiceModeState: 'idle',
      wakeModeEnabled: false,
      micMuted: false,
      microphoneAccessible: true,
      sttProviderId: 'whisper-cpp',
      ttsProviderId: 'windows-system-tts',
      autoReadResponses: false,
      preferredLanguage: 'es-ES',
      updatedAt: now
    },
    ...overrides
  };
}

function renderOrb(state: ReturnType<typeof resolveVoiceOrbState>): string {
  return renderToStaticMarkup(
    <VoiceOrb
      activityLabel="En espera"
      availabilityLabel="lista"
      languageLabel="es-ES"
      microphoneLabel="Mic listo"
      state={state}
      sttLabel="whisper.cpp"
      ttsLabel="Voz de Windows"
      wakeWord="prolijo"
    />
  );
}

describe('VoiceOrb', () => {
  it('renders the ASSEM voice core with the idle state', () => {
    const html = renderOrb('idle');

    expect(html).toContain('ASSEM');
    expect(html).toContain('voice-orb--idle');
    expect(html).toContain('Preparada para texto y push-to-talk manual');
  });

  it('maps real voice states into visual states', () => {
    expect(resolveVoiceOrbState(makeVoice())).toBe('idle');
    expect(
      resolveVoiceOrbState(
        makeVoice({
          settings: {
            ...makeVoice().settings,
            voiceModeEnabled: true
          },
          session: {
            ...makeVoice().session!,
            voiceModeState: 'wake_listening',
            wakeModeEnabled: true
          }
        })
      )
    ).toBe('wake_listening');
    expect(
      resolveVoiceOrbState(
        makeVoice({
          session: {
            ...makeVoice().session!,
            recordingState: 'recording'
          }
        })
      )
    ).toBe('listening');
    expect(
      resolveVoiceOrbState(
        makeVoice({
          session: {
            ...makeVoice().session!,
            recordingState: 'transcribing'
          }
        })
      )
    ).toBe('processing');
    expect(
      resolveVoiceOrbState(
        makeVoice({
          session: {
            ...makeVoice().session!,
            speakingState: 'speaking'
          }
        })
      )
    ).toBe('speaking');
    expect(resolveVoiceOrbState(makeVoice({ available: false, status: 'unavailable' }))).toBe(
      'error'
    );
  });

  it('renders state-specific classes for every active visual mode', () => {
    expect(renderOrb('listening')).toContain('voice-orb--listening');
    expect(renderOrb('wake_listening')).toContain('voice-orb--wake_listening');
    expect(renderOrb('wake_detected')).toContain('voice-orb--wake_detected');
    expect(renderOrb('speech_detected')).toContain('voice-orb--speech_detected');
    expect(renderOrb('silence_wait')).toContain('voice-orb--silence_wait');
    expect(renderOrb('processing')).toContain('voice-orb--processing');
    expect(renderOrb('speaking')).toContain('voice-orb--speaking');
    expect(renderOrb('error')).toContain('voice-orb--error');
  });

  it('shows compact real diagnostics without duplicating controls', () => {
    const html = renderToStaticMarkup(
      <VoiceOrb
        activityLabel="Transcribiendo"
        availabilityLabel="lista"
        diagnostic="Audio demasiado corto"
        languageLabel="es-ES"
        microphoneLabel="Mic listo"
        state="processing"
        sttLabel="whisper.cpp"
        ttsLabel="Voz de Windows"
        wakeWord="prolijo"
      />
    );

    expect(html).toContain('Audio demasiado corto');
    expect(html).toContain('STT whisper.cpp');
    expect(html).toContain('TTS Voz de Windows');
    expect(html).not.toContain('Detener y enviar');
  });
});
