import { describe, expect, it } from 'vitest';

import type { VoiceSettings } from '@assem/shared-types';

import {
  normalizeWakePhrase,
  transcriptContainsWakeWord
} from './wake-mode';

function settings(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    sttProviderId: 'whisper-cpp',
    ttsProviderId: 'windows-system-tts',
    preferredLanguage: 'es-ES',
    autoReadResponses: false,
    voiceModeEnabled: true,
    micMuted: false,
    wakeWordEnabled: true,
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
    ...overrides
  };
}

describe('wake word detection', () => {
  it('normalizes accents, punctuation and spacing before matching', () => {
    expect(normalizeWakePhrase(' Pro LIJO! ')).toBe('pro lijo');
  });

  it('detects the exact wake word', () => {
    expect(transcriptContainsWakeWord('prolijo escucha esto', settings())).toBe(true);
    expect(transcriptContainsWakeWord('hola prolijo', settings())).toBe(true);
  });

  it('detects common Whisper variants', () => {
    expect(transcriptContainsWakeWord('polijo dime la hora', settings())).toBe(true);
    expect(transcriptContainsWakeWord('pro lijo crea una nota', settings())).toBe(true);
    expect(transcriptContainsWakeWord('pro li jo revisa el sandbox', settings())).toBe(true);
  });

  it('does not detect unrelated text', () => {
    expect(transcriptContainsWakeWord('hola que tal estas', settings())).toBe(false);
  });

  it('stays disabled unless experimental wake word is explicitly enabled', () => {
    expect(
      transcriptContainsWakeWord(
        'prolijo escucha esto',
        settings({
          wakeWordEnabled: false
        })
      )
    ).toBe(false);
  });

  it('does not trigger aliases from inside larger words', () => {
    expect(transcriptContainsWakeWord('prolijamente escrito', settings())).toBe(false);
    expect(transcriptContainsWakeWord('improlijo pero claro', settings())).toBe(false);
    expect(transcriptContainsWakeWord('hay mucha prolijidad', settings())).toBe(false);
    expect(transcriptContainsWakeWord('xxxprolijoxxx ruido', settings())).toBe(false);
  });

  it('does not break explicit custom wake words', () => {
    expect(
      transcriptContainsWakeWord(
        'viernes prepara una tarea',
        settings({
          wakeWord: 'viernes',
          wakeWordAliases: []
        })
      )
    ).toBe(true);
    expect(
      transcriptContainsWakeWord(
        'prolijo prepara una tarea',
        settings({
          wakeWord: 'viernes',
          wakeWordAliases: []
        })
      )
    ).toBe(false);
  });
});
