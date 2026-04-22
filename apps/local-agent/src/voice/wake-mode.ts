import type { VoiceSettings } from '@assem/shared-types';

const LETTER_NUMBER_MAP: Record<string, string> = {
  4: 'a',
  3: 'e',
  1: 'i',
  0: 'o'
};

export function normalizeWakePhrase(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[4310]/g, (match) => LETTER_NUMBER_MAP[match] ?? match)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveWakeWordCandidates(settings: VoiceSettings): string[] {
  const candidates = [settings.wakeWord, ...settings.wakeWordAliases]
    .map((candidate) => normalizeWakePhrase(candidate))
    .filter(Boolean);

  return [...new Set(candidates)];
}

function phraseTokens(value: string): string[] {
  return normalizeWakePhrase(value).split(' ').filter(Boolean);
}

function containsTokenSequence(tokens: string[], candidateTokens: string[]): boolean {
  if (candidateTokens.length === 0 || candidateTokens.length > tokens.length) {
    return false;
  }

  for (let start = 0; start <= tokens.length - candidateTokens.length; start += 1) {
    const matches = candidateTokens.every(
      (candidateToken, offset) => tokens[start + offset] === candidateToken
    );
    if (matches) {
      return true;
    }
  }

  return false;
}

export function transcriptContainsWakeWord(
  transcript: string,
  settings: VoiceSettings
): boolean {
  if (!settings.wakeWordEnabled) {
    return false;
  }

  const normalizedTranscript = normalizeWakePhrase(transcript);
  if (!normalizedTranscript) {
    return false;
  }

  const transcriptTokens = phraseTokens(normalizedTranscript);
  const candidates = resolveWakeWordCandidates(settings);

  return candidates.some((candidate) => {
    const candidateTokens = phraseTokens(candidate);
    return containsTokenSequence(transcriptTokens, candidateTokens);
  });
}
