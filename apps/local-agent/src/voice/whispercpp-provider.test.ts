import { describe, expect, it } from 'vitest';

import { WhisperCppSpeechToTextProvider, whisperCppProviderInternals } from './whispercpp-provider';

describe('WhisperCppSpeechToTextProvider', () => {
  it('reports a clear unavailable health state when whisper.cpp is not configured', async () => {
    const provider = new WhisperCppSpeechToTextProvider({
      threads: 4
    });

    expect(provider.isConfigured()).toBe(false);

    const health = await provider.healthCheck({
      sttProviderId: 'whisper-cpp',
      ttsProviderId: 'windows-system-tts',
      preferredLanguage: 'es-ES',
      autoReadResponses: false
    });

    expect(health.status).toBe('unavailable');
    expect(health.configured).toBe(false);
    expect(health.available).toBe(false);
    expect(health.error).toContain('ASSEM_WHISPER_CPP_CLI_PATH');
  });
});

describe('whisperCppProviderInternals', () => {
  it.each([
    ['es-ES', 'es'],
    ['es', 'es'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['fr-FR', 'fr'],
    ['auto', 'auto'],
    [undefined, 'auto']
  ])('normalizes %s into %s', (input, expected) => {
    expect(whisperCppProviderInternals.normalizeWhisperLanguage(input)).toBe(expected);
  });

  it('extracts transcript text from the supported whisper.cpp JSON shapes', () => {
    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        text: ' hola mundo '
      })
    ).toBe('hola mundo');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        result: ' transcript from result '
      })
    ).toBe('transcript from result');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        transcription: ' transcript from transcription '
      })
    ).toBe('transcript from transcription');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        segments: [{ text: 'hola' }, { text: 'mundo' }]
      })
    ).toBe('hola mundo');
  });
});
