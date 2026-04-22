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

  if (
    session.recordingState === 'recording' &&
    (!session.wakeModeEnabled || session.voiceModeState === 'off' || session.voiceModeState === 'idle')
  ) {
    return 'Grabando';
  }

  if (
    session.recordingState === 'transcribing' &&
    (!session.wakeModeEnabled || session.voiceModeState === 'off' || session.voiceModeState === 'idle')
  ) {
    return 'Transcribiendo';
  }

  if (
    session.speakingState === 'speaking' &&
    (!session.wakeModeEnabled || session.voiceModeState === 'off' || session.voiceModeState === 'idle')
  ) {
    return 'Leyendo respuesta';
  }

  if (session.voiceModeState === 'off') {
    return 'Modo conversacion apagado';
  }

  if (session.voiceModeState === 'muted') {
    return 'Microfono muteado';
  }

  if (session.voiceModeState === 'conversation_waiting') {
    return 'Esperando voz';
  }

  if (session.voiceModeState === 'wake_listening') {
    return `Wake experimental: esperando "${voice.settings.wakeWord}"`;
  }

  if (session.voiceModeState === 'wake_detected') {
    return 'Wake word detectada';
  }

  if (session.voiceModeState === 'active_listening') {
    return 'Te escucho';
  }

  if (session.voiceModeState === 'speech_detected') {
    return 'Voz detectada';
  }

  if (session.voiceModeState === 'silence_wait') {
    return 'Cerrando frase por silencio';
  }

  if (session.voiceModeState === 'closing_turn') {
    return 'Cerrando turno';
  }

  if (session.voiceModeState === 'processing') {
    return 'Respondiendo';
  }

  if (session.voiceModeState === 'speaking') {
    return 'Leyendo respuesta';
  }

  if (session.voiceModeState === 'error') {
    return 'Error de voz';
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
    !voice.settings.micMuted &&
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
