import { describe, expect, it } from 'vitest';

import {
  buildVoiceLanguageCandidates,
  legacyWindowsSttProviderInternals,
  powerShellProviderInternals
} from './powershell-provider';

describe('Windows speech PowerShell provider internals', () => {
  it('builds exact and neutral language candidates', () => {
    expect(buildVoiceLanguageCandidates(undefined)).toEqual(['es-ES', 'es']);
    expect(buildVoiceLanguageCandidates('en')).toEqual(['en-US', 'en']);
    expect(buildVoiceLanguageCandidates('pt-BR')).toEqual(['pt-BR', 'pt']);
  });

  it('resolves speech recognizers by installed recognizer id', () => {
    const script = legacyWindowsSttProviderInternals.createSttProbeScript('es-ES');

    expect(script).toContain('InstalledRecognizers()');
    expect(script).toContain('Resolve-AssemRecognizerInfo');
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('SpeechRecognitionEngine($recognizerInfo)');
    expect(script).not.toContain('SpeechRecognitionEngine($recognizerInfo.Id)');
    expect(script).not.toContain('SpeechRecognitionEngine($culture)');
  });

  it('keeps TTS scripts ready to fall back to the default system voice', () => {
    const script = powerShellProviderInternals.createTtsSessionScript('es-ES');

    expect(script).toContain('Resolve-AssemInstalledVoice $synth');
    expect(script).toContain("Write-Output 'READY::default'");
    expect(script).toContain('GetInstalledVoices()');
  });

  it('does not block TTS completion by peeking redirected stdin while speaking', () => {
    const script = powerShellProviderInternals.createTtsSessionScript('es-ES');

    expect(script).toContain('$synth.SpeakAsync($text)');
    expect(script).toContain('$synth.State -ne [System.Speech.Synthesis.SynthesizerState]::Ready');
    expect(script).not.toContain('[Console]::In.Peek()');
    expect(script).not.toContain("[Console]::In.ReadLine()");
  });

  it('cleans CLIXML noise from PowerShell stream lines', () => {
    expect(powerShellProviderInternals.sanitizePowerShellMessage('#< CLIXML')).toBe('');
    expect(
      powerShellProviderInternals.sanitizePowerShellMessage(
        '<S S="Error">Timed out_x000D__x000A_</S>'
      )
    ).toBe('Timed out');
  });
});
