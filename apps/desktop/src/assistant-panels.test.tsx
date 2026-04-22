import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AssemTask, TaskPlan, TaskRefinement } from '@assem/shared-types';

import {
  AssistantStatusPanel,
  AssistantSnapshotCard,
  createQuickActionItems,
  QuickActionsPanel,
  TaskSpotlightCard,
  TopbarStatus,
  VoiceComposerDock
} from './assistant-panels';

const now = '2026-04-17T10:00:00.000Z';

const refinement: TaskRefinement = {
  id: 'ref-1',
  category: 'output',
  type: 'length',
  instruction: 'Hazlo mas corto',
  label: 'Mas corto',
  createdAt: now
};

const plan: TaskPlan = {
  id: 'plan-1',
  objective: 'Preparar informe local',
  taskType: 'research_report_basic',
  summary: 'Preparar estructura, redactar y guardar el informe.',
  phases: [
    {
      id: 'phase-1',
      label: 'Preparacion',
      stepIds: ['step-1', 'step-2']
    }
  ],
  steps: [
    {
      id: 'step-1',
      phaseId: 'phase-1',
      label: 'Crear carpeta de trabajo'
    },
    {
      id: 'step-2',
      phaseId: 'phase-1',
      label: 'Escribir informe base'
    }
  ],
  expectedArtifacts: [
    {
      id: 'artifact-1',
      kind: 'report',
      label: 'Informe final'
    }
  ],
  restrictions: [],
  refinements: [refinement],
  source: 'planner_v1',
  createdAt: now,
  updatedAt: now
};

const task: AssemTask = {
  id: 'task-1',
  sessionId: 'session-1',
  objective: 'Preparar informe local',
  status: 'active',
  progressPercent: 50,
  currentPhase: 'Redaccion',
  currentStepId: 'step-2',
  steps: [
    {
      id: 'step-1',
      label: 'Crear carpeta de trabajo',
      status: 'completed',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now
    },
    {
      id: 'step-2',
      label: 'Escribir informe base',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      startedAt: now
    }
  ],
  artifacts: [
    {
      id: 'artifact-1',
      kind: 'report',
      label: 'Informe final',
      createdAt: now,
      filePath: 'C:/Users/garce/Documents/assem/apps/local-agent/sandbox/informe.md'
    }
  ],
  createdAt: now,
  updatedAt: now,
  startedAt: now,
  plan,
  metadata: {
    interruptState: {
      refinements: [refinement]
    }
  }
};

describe('assistant-panels', () => {
  it('shows the compact topbar status with a pending confirmation shortcut', () => {
    const html = renderToStaticMarkup(
      <TopbarStatus
        healthLabel="disponible"
        modeLabel="Solo local / Sandbox"
        onOpenPermissions={() => undefined}
        pendingActionsCount={2}
        profileName="Default profile"
        sessionId="clixml42"
      />
    );

    expect(html).toContain('ASSEM disponible');
    expect(html).toContain('Sesion: #CLIXML');
    expect(html).toContain('2 confirmaciones');
  });

  it('renders the assistant snapshot fallback note and the primary runtime summary', () => {
    const html = renderToStaticMarkup(
      <AssistantSnapshotCard
        autoReadResponses={true}
        fallbackReason="Ollama no estaba disponible"
        fallbackUsed={true}
        microphoneAccessible={true}
        onOpenPermissions={() => undefined}
        pendingActionsCount={1}
        runtimeModelLabel="Modelo activo"
        runtimeModelValue="llama3.2:latest"
        runtimeProviderLabel="Ollama"
        voiceActivity="lista"
        voiceLabel="disponible"
      />
    );

    expect(html).toContain('Ollama');
    expect(html).toContain('Fallback activo');
    expect(html).toContain('Ollama no estaba disponible');
    expect(html).toContain('Revisar confirmaciones');
  });

  it('renders task progress, pending plan steps and artifacts in the spotlight card', () => {
    const html = renderToStaticMarkup(
      <TaskSpotlightCard
        artifacts={task.artifacts}
        currentStep={task.steps[1]}
        pendingPlanSteps={['Escribir informe base']}
        plan={plan}
        refinements={[refinement]}
        task={task}
        taskProgressLabel="50%"
        taskStatusLabel="activa"
      />
    );

    expect(html).toContain('Preparar informe local');
    expect(html).toContain('50%');
    expect(html).toContain('Escribir informe base');
    expect(html).toContain('Informe final');
    expect(html).toContain('Mas corto');
  });

  it('keeps runtime, voice and work details in the assistant status menu panel', () => {
    const html = renderToStaticMarkup(
      <AssistantStatusPanel
        activeTask={task}
        currentStepLabel="Escribir informe base"
        effectiveLanguage="es-ES"
        fallbackReason="Ollama no estaba disponible"
        fallbackUsed={true}
        microphoneAccessible={true}
        onOpenPermissions={() => undefined}
        pendingActionsCount={1}
        runtimeModelLabel="Modelo activo"
        runtimeModelValue="llama3.2:latest"
        runtimeProviderLabel="Ollama"
        sttLabel="whisper.cpp"
        taskProgressLabel="50%"
        taskStatusLabel="activa"
        ttsLabel="Voz de Windows"
        voiceActivityLabel="en espera"
        voiceAvailabilityLabel="lista"
        voiceDiagnostic="Whisper listo"
        voiceModeEnabled={true}
        voiceModeState="wake_listening"
      />
    );

    expect(html).toContain('Estado del asistente');
    expect(html).toContain('Ollama');
    expect(html).toContain('whisper.cpp');
    expect(html).toContain('Preparar informe local');
    expect(html).toContain('1 confirmacion pendiente');
  });

  it('renders an elegant empty task state without inventing active task data', () => {
    const html = renderToStaticMarkup(
      <TaskSpotlightCard
        artifacts={[]}
        currentStep={null}
        pendingPlanSteps={[]}
        plan={null}
        refinements={[]}
        task={null}
        taskProgressLabel="sin tarea"
        taskStatusLabel="sin datos"
      />
    );

    expect(html).toContain('ASSEM esta listo para una tarea larga');
    expect(html).toContain('sin tarea activa');
    expect(html).not.toContain('progreso real de la tarea');
  });

  it('switches the quick actions copy when a task is already active', () => {
    const html = renderToStaticMarkup(
      <QuickActionsPanel
        actions={createQuickActionItems(['Que hora es ahora mismo?'], true)}
        disabled={false}
        hasActiveTask={true}
        onSelectPrompt={() => undefined}
      />
    );

    expect(html).toContain('Sigue hablando mientras ASSEM trabaja');
    expect(html).toContain('Hora local');
    expect(html).toContain('Disponible mientras la tarea sigue su curso.');
  });

  it('prioritizes diagnostic feedback in the voice dock when voice had a recent issue', () => {
    const html = renderToStaticMarkup(
      <VoiceComposerDock
        activityLabel="ultimo intento fallido"
        autoReadResponses={false}
        availabilityLabel="lista"
        busy={false}
        canPlayLatestReply={true}
        canStartRecording={true}
        canStopRecording={false}
        effectiveLanguage="es-ES"
        latestAssistantMessage="Resumen listo."
        latestDiagnosticDetail="No se detecto audio suficiente"
        latestDiagnosticSummary="Audio demasiado corto"
        latestTranscript="hola"
        microphoneAccessible={true}
        onCancelRecording={() => undefined}
        onSpeakLatestReply={() => undefined}
        onStartRecording={() => undefined}
        onStopRecording={() => undefined}
        onStopSpeaking={() => undefined}
        onToggleAutoReadResponses={() => undefined}
        onToggleVoiceMode={() => undefined}
        recordingState="idle"
        speakingState="idle"
        sttLabel="whisper.cpp"
        ttsLabel="Voz de Windows (TTS)"
        voiceModeEnabled={false}
        voiceModeState="off"
        wakeWord="prolijo"
      />
    );

    expect(html).toContain('Audio demasiado corto');
    expect(html).toContain('No se detecto audio suficiente');
    expect(html).toContain('STT whisper.cpp');
    expect(html).toContain('Idioma es-ES');
  });
});
