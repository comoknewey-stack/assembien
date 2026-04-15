import type { VoiceSystemState } from '@assem/shared-types';

function selectedVoiceProviderAvailable(
  voice: VoiceSystemState | null | undefined,
  kind: 'stt' | 'tts'
): boolean {
  if (!voice) {
    return false;
  }

  const providers = kind === 'stt' ? voice.sttProviders : voice.ttsProviders;
  const providerId =
    kind === 'stt' ? voice.settings.sttProviderId : voice.settings.ttsProviderId;

  return providers.some(
    (provider) => provider.providerId === providerId && provider.available
  );
}

export function voiceAvailabilityLabel(voice: VoiceSystemState | null | undefined): string {
  switch (voice?.status) {
    case 'ready':
      return 'lista';
    case 'degraded':
      return 'parcial';
    case 'unavailable':
      return 'no disponible';
    default:
      return 'sin datos';
  }
}

export function voiceActivityLabel(voice: VoiceSystemState | null | undefined): string {
  if (!voice) {
    return 'Sin datos';
  }

  const session = voice?.session;
  if (!session) {
    return voice.status === 'unavailable' ? 'No disponible' : 'Sin sesion de voz';
  }

  if (session.recordingState === 'recording') {
    return 'Grabando';
  }

  if (session.recordingState === 'transcribing') {
    return 'Transcribiendo';
  }

  if (session.speakingState === 'speaking') {
    return 'Leyendo respuesta';
  }

  if (session.recordingState === 'error' || session.speakingState === 'error') {
    return 'Ultimo intento fallido';
  }

  if (voice.status === 'unavailable') {
    return 'No disponible';
  }

  if (voice.status === 'degraded') {
    return 'Lista con limites';
  }

  return 'En espera';
}

export function canStartVoiceCapture(
  voice: VoiceSystemState | null | undefined,
  hasSession: boolean,
  isBusy: boolean
): boolean {
  if (!voice || !hasSession || isBusy) {
    return false;
  }

  return (
    selectedVoiceProviderAvailable(voice, 'stt') &&
    voice.microphoneAccessible &&
    voice.session?.recordingState !== 'recording' &&
    voice.session?.recordingState !== 'transcribing'
  );
}

export function canStopVoiceCapture(
  voice: VoiceSystemState | null | undefined,
  hasSession: boolean,
  isBusy: boolean
): boolean {
  if (!voice || !hasSession || isBusy) {
    return false;
  }

  return selectedVoiceProviderAvailable(voice, 'stt') && voice.session?.recordingState === 'recording';
}

export function canSpeakAssistantReply(
  voice: VoiceSystemState | null | undefined,
  hasSession: boolean,
  hasAssistantReply: boolean,
  isBusy: boolean
): boolean {
  if (!voice || !hasSession || !hasAssistantReply || isBusy) {
    return false;
  }

  return (
    selectedVoiceProviderAvailable(voice, 'tts') &&
    voice.session?.recordingState !== 'recording' &&
    voice.session?.recordingState !== 'transcribing'
  );
}
