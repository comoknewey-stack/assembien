import type { AssemTask, VoiceSystemState } from '@assem/shared-types';

import { AssemOrb, type AssemOrbState } from './assem-orb';
import { Surface } from './surface';

export type AssistantCoreState =
  | 'idle'
  | 'muted'
  | 'conversation_waiting'
  | 'wake_listening'
  | 'wake_detected'
  | 'listening'
  | 'speech_detected'
  | 'silence_wait'
  | 'closing_turn'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'task_running'
  | 'paused'
  | 'degraded'
  | 'error';

export interface AssistantCoreStateInput {
  voice: VoiceSystemState | null | undefined;
  activeTask: AssemTask | null | undefined;
  isBusy: boolean;
  hasError: boolean;
}

const coreLabels: Record<AssistantCoreState, string> = {
  idle: 'Lista',
  muted: 'Mic off',
  conversation_waiting: 'Esperando voz',
  wake_listening: 'En espera',
  wake_detected: 'Wake word',
  listening: 'Escuchando',
  speech_detected: 'Voz detectada',
  silence_wait: 'Cerrando frase',
  closing_turn: 'Cerrando turno',
  transcribing: 'Transcribiendo',
  thinking: 'Procesando',
  speaking: 'Hablando',
  task_running: 'Trabajando',
  paused: 'Pausada',
  degraded: 'Parcial',
  error: 'Revisar'
};

const coreHints: Record<AssistantCoreState, string> = {
  idle: 'ASSEM esta preparado para texto, voz y tareas locales.',
  muted: 'Mute esta activo: el microfono esta apagado aunque la app siga abierta.',
  conversation_waiting: 'Modo conversacion activo: ASSEM espera tu siguiente turno de voz.',
  wake_listening: 'Wake word legacy/experimental: escucha local por ventanas si esta habilitado por config.',
  wake_detected: 'Wake word detectada: ASSEM abre la escucha activa.',
  listening: 'El microfono esta capturando audio para la sesion actual.',
  speech_detected: 'Hay voz util en la frase activa.',
  silence_wait: 'ASSEM espera silencio sostenido para cerrar la frase sin cortarte.',
  closing_turn: 'ASSEM conserva un margen final para no cortar el cierre de la frase.',
  transcribing: 'Whisper esta convirtiendo la voz en texto antes de enviarlo al chat.',
  thinking: 'ASSEM esta procesando la solicitud actual.',
  speaking: 'La respuesta se esta leyendo con el TTS configurado.',
  task_running: 'Hay una tarea activa avanzando con estado real.',
  paused: 'La tarea activa esta pausada y espera una reanudacion.',
  degraded: 'Alguna parte del runtime funciona con limites.',
  error: 'Hay una incidencia real que necesita revision.'
};

const coreOrbStateMap: Record<AssistantCoreState, AssemOrbState> = {
  idle: 'idle',
  muted: 'degraded',
  conversation_waiting: 'idle',
  wake_listening: 'listening',
  wake_detected: 'listening',
  listening: 'listening',
  speech_detected: 'listening',
  silence_wait: 'listening',
  closing_turn: 'listening',
  transcribing: 'transcribing',
  thinking: 'thinking',
  speaking: 'speaking',
  task_running: 'task_running',
  paused: 'paused',
  degraded: 'degraded',
  error: 'error'
};

export function resolveAssistantCoreState({
  voice,
  activeTask,
  isBusy,
  hasError
}: AssistantCoreStateInput): AssistantCoreState {
  const voiceSession = voice?.session;

  if (!voice) {
    return isBusy ? 'thinking' : 'degraded';
  }

  if (
    hasError ||
    !voice.available ||
    voice.status === 'unavailable' ||
    voiceSession?.recordingState === 'error' ||
    voiceSession?.speakingState === 'error'
  ) {
    return 'error';
  }

  if (voice.settings.micMuted || voiceSession?.voiceModeState === 'muted') {
    return 'muted';
  }

  if (
    voiceSession?.recordingState === 'recording' &&
    (!voiceSession.wakeModeEnabled ||
      voiceSession.voiceModeState === 'off' ||
      voiceSession.voiceModeState === 'idle')
  ) {
    return 'listening';
  }

  if (
    voiceSession?.recordingState === 'transcribing' &&
    (!voiceSession.wakeModeEnabled ||
      voiceSession.voiceModeState === 'off' ||
      voiceSession.voiceModeState === 'idle')
  ) {
    return 'transcribing';
  }

  if (
    voiceSession?.speakingState === 'speaking' &&
    (!voiceSession.wakeModeEnabled ||
      voiceSession.voiceModeState === 'off' ||
      voiceSession.voiceModeState === 'idle')
  ) {
    return 'speaking';
  }

  switch (voiceSession?.voiceModeState) {
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
      return 'transcribing';
    case 'processing':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    case 'error':
      return 'error';
    case 'off':
    case 'idle':
    case undefined:
      break;
  }

  if (voiceSession?.recordingState === 'recording') {
    return 'listening';
  }

  if (voiceSession?.recordingState === 'transcribing') {
    return 'transcribing';
  }

  if (voiceSession?.speakingState === 'speaking') {
    return 'speaking';
  }

  if (activeTask?.status === 'paused') {
    return 'paused';
  }

  if (activeTask && ['active', 'pending', 'blocked'].includes(activeTask.status)) {
    return 'task_running';
  }

  if (isBusy) {
    return 'thinking';
  }

  if (voice.status === 'degraded' || voice.lastError) {
    return 'degraded';
  }

  return 'idle';
}

export function assistantCoreStateLabel(state: AssistantCoreState): string {
  return coreLabels[state];
}

interface AssistantCoreProps {
  state: AssistantCoreState;
  voiceAvailabilityLabel: string;
  voiceActivityLabel: string;
  voiceModeEnabled: boolean;
}

export function AssistantCore({
  state,
  voiceAvailabilityLabel,
  voiceActivityLabel,
  voiceModeEnabled
}: AssistantCoreProps) {
  const stateLabel = assistantCoreStateLabel(state);
  const displayStateLabel = !voiceModeEnabled && state === 'idle' ? 'Modo voz off' : stateLabel;

  return (
    <Surface
      as="section"
      className={`assistant-core assistant-core--${state}`}
      data-state={state}
      glow={state === 'speaking' || state === 'task_running' ? 'amber' : state === 'error' ? 'red' : 'cyan'}
      radius="hero"
      variant={state === 'error' ? 'error' : state === 'paused' || state === 'degraded' ? 'warning' : 'hero'}
    >
      <div aria-hidden="true" className="assistant-core__corners">
        <span />
        <span />
        <span />
        <span />
      </div>

      <div className="assistant-core__visual">
        <AssemOrb
          diagnostic={
            <span>
              {!voiceModeEnabled ? 'Modo voz off' : `Voz ${voiceAvailabilityLabel} - ${voiceActivityLabel}`}
            </span>
          }
          label={displayStateLabel.toUpperCase()}
          state={coreOrbStateMap[state]}
        />
      </div>

      <div className="assistant-core__content">
        <p className="eyebrow">Nucleo del asistente</p>
        <h2>{displayStateLabel.toUpperCase()}</h2>
        <p className="assistant-core__hint">{coreHints[state]}</p>
      </div>
    </Surface>
  );
}
