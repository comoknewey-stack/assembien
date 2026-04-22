import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AssemTask, VoiceSystemState } from '@assem/shared-types';

import { AssistantCore, resolveAssistantCoreState } from './assistant-core';

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
    sttProviders: [],
    ttsProviders: [],
    microphoneAccessible: true,
    session: {
      sessionId: 'session-1',
      recordingState: 'idle',
      speakingState: 'idle',
      voiceModeState: 'idle',
      wakeModeEnabled: false,
      micMuted: false,
      microphoneAccessible: true,
      autoReadResponses: false,
      preferredLanguage: 'es-ES',
      updatedAt: now
    },
    ...overrides
  };
}

const task: AssemTask = {
  id: 'task-1',
  sessionId: 'session-1',
  objective: 'Preparar un informe local',
  status: 'active',
  progressPercent: 42,
  currentPhase: 'Redaccion',
  currentStepId: 'step-1',
  steps: [
    {
      id: 'step-1',
      label: 'Escribir borrador',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
  ],
  artifacts: [],
  createdAt: now,
  updatedAt: now,
  startedAt: now
};

function renderCore(): string {
  return renderToStaticMarkup(
    <AssistantCore
      state="task_running"
      voiceActivityLabel="En espera"
      voiceAvailabilityLabel="lista"
      voiceModeEnabled={false}
    />
  );
}

describe('AssistantCore', () => {
  it('projects real voice and task states into one assistant core state', () => {
    expect(
      resolveAssistantCoreState({
        voice: makeVoice({
          session: {
            ...makeVoice().session!,
            recordingState: 'recording'
          }
        }),
        activeTask: null,
        isBusy: false,
        hasError: false
      })
    ).toBe('listening');
    expect(
      resolveAssistantCoreState({
        voice: makeVoice({
          session: {
            ...makeVoice().session!,
            recordingState: 'transcribing'
          }
        }),
        activeTask: null,
        isBusy: false,
        hasError: false
      })
    ).toBe('transcribing');
    expect(
      resolveAssistantCoreState({
        voice: makeVoice({
          session: {
            ...makeVoice().session!,
            speakingState: 'speaking'
          }
        }),
        activeTask: null,
        isBusy: false,
        hasError: false
      })
    ).toBe('speaking');
    expect(
      resolveAssistantCoreState({
        voice: makeVoice(),
        activeTask: task,
        isBusy: false,
        hasError: false
      })
    ).toBe('task_running');
    expect(
      resolveAssistantCoreState({
        voice: makeVoice(),
        activeTask: { ...task, status: 'paused' },
        isBusy: false,
        hasError: false
      })
    ).toBe('paused');
    expect(
      resolveAssistantCoreState({
        voice: makeVoice({ available: false, status: 'unavailable' }),
        activeTask: null,
        isBusy: false,
        hasError: false
      })
    ).toBe('error');
    expect(
      resolveAssistantCoreState({
        voice: makeVoice({
          status: 'degraded',
          lastError: 'Whisper diagnostic failed'
        }),
        activeTask: null,
        isBusy: false,
        hasError: false
      })
    ).toBe('degraded');
  });

  it('renders the central ASSEM identity with voice, runtime and task projections', () => {
    const html = renderCore();

    expect(html).toContain('ASSEM');
    expect(html).toContain('assistant-core--task_running');
    expect(html).toContain('TRABAJANDO');
    expect(html).not.toContain('Ollama');
    expect(html).not.toContain('whisper.cpp');
  });

  it('keeps the core as state projection instead of duplicating voice controls', () => {
    const html = renderCore();

    expect(html).toContain('Nucleo del asistente');
    expect(html).not.toContain('Sin ejecucion larga en curso');
    expect(html).not.toContain('Detener y enviar');
    expect(html).not.toContain('Leer ultima');
  });
});
