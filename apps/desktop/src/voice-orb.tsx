import type { VoiceSystemState } from '@assem/shared-types';

import { AssemOrb, type AssemOrbState } from './assem-orb';
import { Surface } from './surface';

export type VoiceOrbState =
  | 'off'
  | 'muted'
  | 'idle'
  | 'conversation_waiting'
  | 'wake_listening'
  | 'wake_detected'
  | 'listening'
  | 'speech_detected'
  | 'silence_wait'
  | 'closing_turn'
  | 'processing'
  | 'speaking'
  | 'error';

const stateLabels: Record<VoiceOrbState, string> = {
  off: 'Apagada',
  muted: 'Microfono off',
  idle: 'Lista',
  conversation_waiting: 'Esperando voz',
  wake_listening: 'Esperando wake word',
  wake_detected: 'Wake word detectada',
  listening: 'Escuchando',
  speech_detected: 'Voz detectada',
  silence_wait: 'Cerrando frase',
  closing_turn: 'Cerrando turno',
  processing: 'Procesando',
  speaking: 'Hablando',
  error: 'No disponible'
};

function stateHint(state: VoiceOrbState, wakeWord: string): string {
  const hints: Record<VoiceOrbState, string> = {
    off: 'Modo conversacion apagado. Puedes usar push-to-talk manual cuando lo necesites.',
    muted: 'Mute corta el microfono por completo hasta que lo desactives.',
    idle: 'Preparada para texto y push-to-talk manual.',
    conversation_waiting: 'Modo conversacion activo: ASSEM espera tu siguiente turno de voz.',
    wake_listening: `Wake experimental: escucha ventanas cortas esperando "${wakeWord}".`,
    wake_detected: 'Wake word detectada; ASSEM pasa a escucharte de forma activa.',
    listening: 'Capturando audio del microfono.',
    speech_detected: 'Hay voz util en la frase actual.',
    silence_wait: 'ASSEM espera un silencio sostenido para cerrar la frase.',
    closing_turn: 'ASSEM mantiene un pequeno margen final antes de transcribir.',
    processing: 'Transcribiendo y preparando el mensaje.',
    speaking: 'Leyendo la respuesta de ASSEM.',
    error: 'Revisa microfono, STT/TTS o runtime de voz.'
  };

  return hints[state];
}

const orbStateMap: Record<VoiceOrbState, AssemOrbState> = {
  off: 'degraded',
  muted: 'degraded',
  idle: 'idle',
  conversation_waiting: 'idle',
  wake_listening: 'listening',
  wake_detected: 'listening',
  listening: 'listening',
  speech_detected: 'listening',
  silence_wait: 'listening',
  closing_turn: 'listening',
  processing: 'processing',
  speaking: 'speaking',
  error: 'error'
};

export function resolveVoiceOrbState(
  voice: VoiceSystemState | null | undefined
): VoiceOrbState {
  if (!voice || !voice.available || voice.status === 'unavailable' || voice.lastError) {
    return 'error';
  }

  const session = voice.session;

  if (voice.settings.micMuted || session?.voiceModeState === 'muted') {
    return 'muted';
  }

  if (session?.recordingState === 'error' || session?.speakingState === 'error') {
    return 'error';
  }

  if (
    session?.recordingState === 'recording' &&
    (!session.wakeModeEnabled || session.voiceModeState === 'off' || session.voiceModeState === 'idle')
  ) {
    return 'listening';
  }

  if (
    session?.recordingState === 'transcribing' &&
    (!session.wakeModeEnabled || session.voiceModeState === 'off' || session.voiceModeState === 'idle')
  ) {
    return 'processing';
  }

  if (
    session?.speakingState === 'speaking' &&
    (!session.wakeModeEnabled || session.voiceModeState === 'off' || session.voiceModeState === 'idle')
  ) {
    return 'speaking';
  }

  switch (session?.voiceModeState) {
    case 'off':
      return 'off';
    case 'conversation_waiting':
      return 'conversation_waiting';
    case 'wake_listening':
      return 'wake_listening';
    case 'wake_detected':
      return 'wake_detected';
    case 'active_listening':
      return 'listening';
    case 'speech_detected':
      return 'speech_detected';
    case 'silence_wait':
      return 'silence_wait';
    case 'closing_turn':
      return 'closing_turn';
    case 'transcribing':
    case 'processing':
      return 'processing';
    case 'speaking':
      return 'speaking';
    case 'error':
      return 'error';
    case 'idle':
    case undefined:
      break;
  }

  if (session?.recordingState === 'recording') {
    return 'listening';
  }

  if (session?.recordingState === 'transcribing') {
    return 'processing';
  }

  if (session?.speakingState === 'speaking') {
    return 'speaking';
  }

  return 'idle';
}

export function voiceOrbStateLabel(state: VoiceOrbState): string {
  return stateLabels[state];
}

export interface VoiceOrbProps {
  state: VoiceOrbState;
  availabilityLabel: string;
  activityLabel: string;
  sttLabel: string;
  ttsLabel: string;
  microphoneLabel: string;
  languageLabel: string;
  wakeWord: string;
  diagnostic?: string;
}

export function VoiceOrb({
  state,
  availabilityLabel,
  activityLabel,
  sttLabel,
  ttsLabel,
  microphoneLabel,
  languageLabel,
  wakeWord,
  diagnostic
}: VoiceOrbProps) {
  const label = voiceOrbStateLabel(state);

  return (
    <Surface
      aria-label={`Nucleo visual de voz: ${label}`}
      className={`voice-orb voice-orb--${state}`}
      data-state={state}
      glow={state === 'speaking' ? 'amber' : state === 'error' ? 'red' : 'cyan'}
      radius="lg"
      variant={state === 'error' ? 'error' : state === 'off' ? 'warning' : 'soft'}
    >
      <AssemOrb label={label} size="compact" state={orbStateMap[state]} />

      <div className="voice-orb__readout">
        <div>
          <span className="summary-card__label">Voz</span>
          <strong>{label}</strong>
          <p>{stateHint(state, wakeWord)}</p>
        </div>
        <div className="voice-orb__meta">
          <span>{availabilityLabel}</span>
          <span>{activityLabel}</span>
          <span>{microphoneLabel}</span>
          <span>Idioma {languageLabel}</span>
          <span>STT {sttLabel}</span>
          <span>TTS {ttsLabel}</span>
        </div>
        {diagnostic && <p className="voice-orb__diagnostic">{diagnostic}</p>}
      </div>
    </Surface>
  );
}
