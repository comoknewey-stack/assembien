import { startTransition, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { AssemClient } from '@assem/sdk';
import type {
  ActiveMode,
  AssemTask,
  ProfileImportPayload,
  ProfileMemory,
  ScheduledTask,
  SpeechToTextAudioInput,
  SessionSnapshot,
  SystemStateSnapshot,
  TaskPlan,
  TaskRefinement,
  VoiceAudioDiagnostics
} from '@assem/shared-types';

import {
  canSpeakAssistantReply,
  canStartVoiceCapture,
  canStopVoiceCapture,
  voiceActivityLabel,
  voiceAvailabilityLabel
} from './voice-ui';
import { BrowserVoiceRecorder } from './audio-recorder';

type Tab = 'history' | 'permissions' | 'system' | 'voice' | 'profiles' | 'schedule' | 'settings';

const tabs: Array<[Tab, string]> = [
  ['history', 'Historial'],
  ['permissions', 'Confirmaciones'],
  ['system', 'Sistema'],
  ['voice', 'Voz'],
  ['profiles', 'Perfiles'],
  ['schedule', 'Tareas'],
  ['settings', 'Ajustes']
];

const prompts = [
  'Que hora es ahora mismo?',
  'Muestrame el calendario de hoy',
  'Lista el sandbox',
  'Crea una carpeta llamada notas-de-proyecto',
  'Hoy no me preguntes mas'
];

const SESSION_STORAGE_KEY = 'assem-session-id';

function fmt(value?: string): string {
  return value
    ? new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'short',
        timeStyle: 'short'
      }).format(new Date(value))
    : 'Nunca';
}

function modeLabel(mode: ActiveMode): string {
  const privacyLabel =
    mode.privacy === 'local_only'
      ? 'Solo local'
      : mode.privacy === 'prefer_local'
        ? 'Prioriza local'
        : mode.privacy === 'balanced'
          ? 'Equilibrado'
          : 'Permite nube';
  const runtimeLabel = mode.runtime === 'sandbox' ? 'Sandbox' : 'En vivo';

  return `${privacyLabel} / ${runtimeLabel}`;
}

function statusLabel(status?: string): string {
  switch (status) {
    case 'completed':
    case 'success':
      return 'completado';
    case 'pending':
      return 'pendiente';
    case 'rejected':
      return 'rechazado';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

function healthStatusLabel(status?: string): string {
  switch (status) {
    case 'ok':
      return 'disponible';
    case 'degraded':
      return 'parcial';
    case 'warning':
      return 'aviso';
    case 'error':
      return 'error';
    case 'unavailable':
      return 'no disponible';
    default:
      return status ?? 'sin datos';
  }
}

function taskStatusLabel(status?: AssemTask['status']): string {
  switch (status) {
    case 'pending':
      return 'pendiente';
    case 'active':
      return 'activa';
    case 'paused':
      return 'pausada';
    case 'blocked':
      return 'bloqueada';
    case 'completed':
      return 'completada';
    case 'failed':
      return 'fallida';
    case 'cancelled':
      return 'cancelada';
    default:
      return 'sin datos';
  }
}

function taskProgressLabel(task: AssemTask | null | undefined): string {
  if (!task) {
    return 'sin tarea';
  }

  return task.progressPercent === null ? 'sin porcentaje' : `${task.progressPercent}%`;
}

function isTaskRefinement(value: unknown): value is TaskRefinement {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.instruction === 'string' &&
    typeof value.category === 'string' &&
    typeof value.type === 'string'
  );
}

function extractTaskRefinements(task: AssemTask | null | undefined): TaskRefinement[] {
  if (!task || !isObjectRecord(task.metadata)) {
    return [];
  }

  const interruptState = task.metadata.interruptState;
  if (!isObjectRecord(interruptState) || !Array.isArray(interruptState.refinements)) {
    return [];
  }

  return interruptState.refinements.filter(isTaskRefinement);
}

function isTaskPlan(value: unknown): value is TaskPlan {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.objective === 'string' &&
    typeof value.taskType === 'string' &&
    typeof value.summary === 'string' &&
    Array.isArray(value.phases) &&
    Array.isArray(value.steps) &&
    Array.isArray(value.expectedArtifacts) &&
    Array.isArray(value.restrictions) &&
    Array.isArray(value.refinements)
  );
}

function extractTaskPlan(task: AssemTask | null | undefined): TaskPlan | null {
  if (!task || !isTaskPlan(task.plan)) {
    return null;
  }

  return task.plan;
}

function extractPendingPlannedSteps(task: AssemTask | null | undefined): string[] {
  const plan = extractTaskPlan(task);
  if (!task || !plan) {
    return [];
  }

  return plan.steps
    .filter((planStep) => {
      const taskStep = task.steps.find((candidate) => candidate.id === planStep.id);
      return !taskStep || !['completed', 'cancelled'].includes(taskStep.status);
    })
    .map((planStep) => planStep.label);
}

function localizedLabel(label?: string): string {
  switch (label) {
    case 'Current time':
      return 'Hora actual';
    case 'List sandbox directory':
      return 'Listar directorio del sandbox';
    case 'Read sandbox file':
      return 'Leer archivo del sandbox';
    case 'Create local file or folder':
      return 'Crear archivo o carpeta local';
    case 'List calendar events':
      return 'Listar eventos del calendario';
    case 'Create calendar event':
      return 'Crear evento del calendario';
    default:
      return label ?? 'desconocido';
  }
}

function formatVoiceAudioDiagnostics(audio: VoiceAudioDiagnostics | undefined): string {
  if (!audio) {
    return 'Sin muestras de audio todavia.';
  }

  const details = [`${audio.byteLength} byte(s)`];

  if (typeof audio.approximateDurationMs === 'number') {
    details.push(`${audio.approximateDurationMs} ms`);
  }

  if (typeof audio.sampleRateHz === 'number') {
    details.push(`${audio.sampleRateHz} Hz`);
  }

  if (typeof audio.channelCount === 'number') {
    details.push(audio.channelCount === 1 ? 'mono' : `${audio.channelCount} canales`);
  }

  if (typeof audio.peakLevel === 'number') {
    details.push(`pico ${audio.peakLevel}`);
  }

  if (audio.silenceDetected) {
    details.push('silencio detectado');
  }

  if (audio.wavValid === false) {
    details.push('WAV invalido');
  }

  return details.join(' - ');
}

function completedTitleLabel(label: string): string {
  switch (label) {
    case 'Current time':
      return 'Hora actual completada';
    case 'List sandbox directory':
      return 'Listado del sandbox completado';
    case 'Read sandbox file':
      return 'Lectura de archivo del sandbox completada';
    case 'Create local file or folder':
      return 'Creacion de archivo o carpeta completada';
    case 'List calendar events':
      return 'Listado del calendario completado';
    case 'Create calendar event':
      return 'Creacion del evento completada';
    default:
      return `${localizedLabel(label)} completado`;
  }
}

function providerLabel(toolOrProviderId: string | undefined, fallback?: string): string {
  switch (toolOrProviderId) {
    case 'windows-system-stt':
      return 'Voz de Windows (STT legado)';
    case 'whisper-cpp':
      return 'whisper.cpp';
    case 'windows-system-tts':
      return 'Voz de Windows (TTS)';
    case 'clock-time.get-current':
      return 'Hora actual';
    case 'local-files.list-directory':
      return 'Listar directorio del sandbox';
    case 'local-files.read-file':
      return 'Leer archivo del sandbox';
    case 'local-files.create-entry':
      return 'Crear archivo o carpeta local';
    case 'calendar.list-events':
      return 'Listar eventos del calendario';
    case 'calendar.create-event':
      return 'Crear evento del calendario';
    case 'ollama':
      return 'Ollama';
    case 'demo-local':
      return 'Demo local';
    case 'task-manager':
      return 'Task Manager';
    case 'task-runtime':
      return 'Task Runtime';
    case 'task-interrupt':
      return 'Task Interrupt';
    default:
      return localizedLabel(fallback ?? toolOrProviderId);
  }
}

function actionTitleLabel(title: string): string {
  const confirmationMatch = title.match(/^Confirmation requested for (.+)$/);
  if (confirmationMatch) {
    return `Confirmacion solicitada para ${localizedLabel(confirmationMatch[1])}`;
  }

  const completionMatch = title.match(/^(.+) (?:finished|completado)$/);
  if (completionMatch) {
    return completedTitleLabel(completionMatch[1]);
  }

  switch (title) {
    case 'Assistant reply':
      return 'Respuesta de ASSEM';
    case 'Model response':
      return 'Respuesta del modelo';
    case 'Request error':
      return 'Error de solicitud';
    case 'Mode updated':
      return 'Modo actualizado';
    case 'Temporary override added':
      return 'Override temporal anadido';
    case 'Temporary override cancelled':
      return 'Override temporal cancelado';
    case 'Action rejected':
      return 'Accion rechazada';
    default:
      return title;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProfileMemory(value: unknown): value is ProfileMemory {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.isActive === 'boolean' &&
    Array.isArray(value.notes) &&
    Array.isArray(value.contacts) &&
    Array.isArray(value.savedSummaries) &&
    isObjectRecord(value.preferences) &&
    isObjectRecord(value.derivedData)
  );
}

function toProfileImportPayload(value: unknown): ProfileImportPayload {
  if (isObjectRecord(value) && 'profile' in value && isProfileMemory(value.profile)) {
    return {
      profile: value.profile,
      activate: typeof value.activate === 'boolean' ? value.activate : undefined
    };
  }

  if (isProfileMemory(value)) {
    return {
      profile: value
    };
  }

  throw new Error('El JSON del perfil no tiene el formato esperado.');
}

export default function App() {
  const clientRef = useRef(
    new AssemClient(import.meta.env.VITE_ASSEM_AGENT_URL ?? 'http://localhost:4318')
  );
  const browserVoiceRecorderRef = useRef<BrowserVoiceRecorder | null>(null);

  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [systemState, setSystemState] = useState<SystemStateSnapshot | null>(null);
  const [uiMode, setUiMode] = useState<ActiveMode>({
    privacy: 'local_only',
    runtime: 'sandbox'
  });
  const [sidebarTab, setSidebarTab] = useState<Tab>('history');
  const [composeValue, setComposeValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isVoiceBusy, setIsVoiceBusy] = useState(false);
  const [overrideInstruction, setOverrideInstruction] = useState('Hoy no me preguntes mas');
  const [profileName, setProfileName] = useState('');
  const [profileNote, setProfileNote] = useState('');
  const [profileExport, setProfileExport] = useState('');
  const [profileImport, setProfileImport] = useState('');
  const [taskLabel, setTaskLabel] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [taskKind, setTaskKind] = useState<ScheduledTask['kind']>('reminder');
  const [taskCadence, setTaskCadence] = useState<ScheduledTask['cadence']>('manual');
  const [taskScheduleAt, setTaskScheduleAt] = useState('');

  const currentSession = snapshot ?? systemState?.session ?? null;
  const profiles = systemState?.profiles ?? [];
  const activeProfile = systemState?.activeProfile ?? null;
  const tasks = systemState?.scheduledTasks ?? [];
  const taskManagerState = systemState?.taskManager;
  const activeConversationTask = taskManagerState?.activeTask ?? null;
  const activeConversationTaskStep =
    activeConversationTask?.steps.find((step) => step.id === activeConversationTask.currentStepId) ??
    activeConversationTask?.steps.find((step) => step.status === 'active') ??
    null;
  const activeConversationTaskArtifacts = activeConversationTask?.artifacts.slice(-3) ?? [];
  const activeConversationTaskRefinements = extractTaskRefinements(activeConversationTask);
  const activeConversationTaskPlan = extractTaskPlan(activeConversationTask);
  const activeConversationTaskPendingPlanSteps = extractPendingPlannedSteps(
    activeConversationTask
  );
  const providerHealth = systemState?.health.providerHealth ?? [];
  const providerRuntime = systemState?.providerRuntime;
  const voice = systemState?.voice ?? null;
  const voiceSession = voice?.session ?? null;
  const effectiveVoiceLanguage =
    voiceSession?.lastTranscriptionLanguage ?? voice?.settings.preferredLanguage ?? 'sin definir';
  const latestVoiceDiagnostic = voiceSession?.lastDiagnostic;
  const latestVoiceAudio = voiceSession?.lastAudioDiagnostics;
  const selectedSttProvider = voice?.sttProviders.find(
    (provider) => provider.providerId === voice.settings.sttProviderId
  );
  const selectedTtsProvider = voice?.ttsProviders.find(
    (provider) => provider.providerId === voice.settings.ttsProviderId
  );
  const telemetry = systemState?.telemetry;
  const configuredProvider = providerHealth.find(
    (provider) => provider.providerId === providerRuntime?.configuredDefaultProviderId
  );
  const recentTelemetry = telemetry?.recent ?? [];
  const sessions = systemState?.sessions ?? [];
  const messages = currentSession?.messages ?? [];
  const latestAssistantMessage =
    [...messages].reverse().find((message) => message.role === 'assistant') ?? null;
  const hasMessages = messages.length > 0;
  const actionLog = [...(currentSession?.actionLog ?? [])].reverse();
  const overrides = currentSession?.temporaryOverrides ?? [];
  const pendingActions = currentSession?.pendingAction
    ? [currentSession.pendingAction]
    : systemState?.pendingActions ?? [];
  const enabledScheduledTaskCount = tasks.filter((task) => task.enabled).length;
  const lastAction = actionLog[0] ?? null;
  const lastTelemetry = recentTelemetry[0] ?? null;
  const busy = isBusy || isVoiceBusy;
  const canStartRecording = canStartVoiceCapture(voice, Boolean(currentSession), busy);
  const canStopRecording = canStopVoiceCapture(voice, Boolean(currentSession), busy);
  const canPlayLatestReply = canSpeakAssistantReply(
    voice,
    Boolean(currentSession),
    Boolean(latestAssistantMessage),
    busy
  );

  function isWhisperCppSelected(): boolean {
    return voice?.settings.sttProviderId === 'whisper-cpp';
  }

  function getBrowserVoiceRecorder(): BrowserVoiceRecorder {
    if (!browserVoiceRecorderRef.current) {
      browserVoiceRecorderRef.current = new BrowserVoiceRecorder();
    }

    return browserVoiceRecorderRef.current;
  }

  function applySnapshot(nextSnapshot: SessionSnapshot) {
    startTransition(() => {
      setSnapshot(nextSnapshot);
      setUiMode(nextSnapshot.activeMode);
      setSystemState((current) =>
        current
          ? {
              ...current,
              session: nextSnapshot,
              providerRuntime: {
                ...current.providerRuntime,
                configuredModel:
                  nextSnapshot.lastModelInvocation?.configuredModel ??
                  current.providerRuntime.configuredModel,
                resolvedModel:
                  nextSnapshot.lastModelInvocation?.resolvedModel ??
                  nextSnapshot.lastModelInvocation?.model ??
                  current.providerRuntime.resolvedModel,
                activeProviderId: nextSnapshot.lastModelInvocation?.providerId,
                activeModel: nextSnapshot.lastModelInvocation?.model,
                fallbackUsed: nextSnapshot.lastModelInvocation?.fallbackUsed,
                fallbackReason: nextSnapshot.lastModelInvocation?.fallbackReason
              },
              pendingActions: nextSnapshot.pendingAction
                ? [nextSnapshot.pendingAction]
                : [],
              overrides: nextSnapshot.temporaryOverrides
            }
          : current
      );
    });
  }

  function applyVoiceState(voiceState: SystemStateSnapshot['voice']) {
    startTransition(() => {
      setSystemState((current) =>
        current
          ? {
              ...current,
              voice: voiceState
            }
          : current
      );
    });
  }

  async function runBusy(work: () => Promise<void>) {
    try {
      setIsBusy(true);
      await work();
      setError(null);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'La operacion ha fallado.'
      );
    } finally {
      setIsBusy(false);
    }
  }

  async function runVoiceBusy(work: () => Promise<void>) {
    try {
      setIsVoiceBusy(true);
      await work();
      setError(null);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : 'La operacion de voz ha fallado.'
      );
    } finally {
      setIsVoiceBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        setIsBusy(true);
        const storedId = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
        let nextSnapshot: SessionSnapshot | null = null;

        if (storedId) {
          nextSnapshot = (await clientRef.current.getSession(storedId)).snapshot;
        }
        if (!nextSnapshot) {
          nextSnapshot = (await clientRef.current.createSession()).snapshot;
        }

        window.sessionStorage.setItem(SESSION_STORAGE_KEY, nextSnapshot.sessionId);
        const state = await clientRef.current.getSystemState(nextSnapshot.sessionId);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setSnapshot(nextSnapshot);
          setSystemState(state.state);
          setUiMode(nextSnapshot.activeMode);
        });
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : 'No se puede conectar con el agente local.'
          );
        }
      } finally {
        if (!cancelled) {
          setIsBusy(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentSession?.sessionId) {
      return;
    }

    return clientRef.current.subscribeToEvents(currentSession.sessionId, {
      onSystemUpdated: (state) => {
        startTransition(() => {
          setSystemState(state);
          if (state.session) {
            setSnapshot(state.session);
            setUiMode(state.session.activeMode);
          }
        });
      }
    });
  }, [currentSession?.sessionId]);

  useEffect(() => {
    return () => {
      void browserVoiceRecorderRef.current?.cancel().catch(() => undefined);
    };
  }, []);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !currentSession) {
      return;
    }

    await runBusy(async () => {
      const response = await clientRef.current.sendMessage({
        sessionId: currentSession.sessionId,
        text: trimmed,
        activeMode: uiMode
      });
      applySnapshot(response.snapshot);
      startTransition(() => {
        setComposeValue('');
      });
    });
  }

  async function changeMode(nextMode: Partial<ActiveMode>) {
    if (!currentSession) {
      return;
    }
    const merged = { ...uiMode, ...nextMode };
    setUiMode(merged);
    await runBusy(async () => {
      await clientRef.current.updateMode({
        sessionId: currentSession.sessionId,
        activeMode: merged
      });
    });
  }

  async function resolvePendingAction(approved: boolean) {
    if (!currentSession) {
      return;
    }

    await runBusy(async () => {
      const response = await clientRef.current.resolvePendingAction({
        sessionId: currentSession.sessionId,
        approved
      });
      applySnapshot(response.snapshot);
    });
  }

  async function toggleAutoReadResponses(nextValue: boolean) {
    await runVoiceBusy(async () => {
      const response = await clientRef.current.updateVoiceSettings(
        {
          settings: {
            autoReadResponses: nextValue
          }
        },
        currentSession?.sessionId
      );
      applyVoiceState(response.voice);
    });
  }

  async function startVoiceRecording() {
    if (!currentSession) {
      return;
    }

    await runVoiceBusy(async () => {
      const usesBrowserAudio = isWhisperCppSelected();

      if (usesBrowserAudio) {
        await getBrowserVoiceRecorder().start();
      }

      try {
        const response = await clientRef.current.startVoiceRecording({
          sessionId: currentSession.sessionId
        });
        applyVoiceState(response.voice);
      } catch (error) {
        if (usesBrowserAudio) {
          await browserVoiceRecorderRef.current?.cancel().catch(() => undefined);
        }

        throw error;
      }
    });
  }

  async function stopVoiceRecording() {
    if (!currentSession) {
      return;
    }

    await runVoiceBusy(async () => {
      let audio: SpeechToTextAudioInput | undefined;

      if (isWhisperCppSelected()) {
        try {
          audio = await getBrowserVoiceRecorder().stop();
        } catch (error) {
          await clientRef.current
            .cancelVoiceRecording({
              sessionId: currentSession.sessionId
            })
            .catch(() => undefined);
          throw error;
        }
      }

      const response = await clientRef.current.stopVoiceRecording({
        sessionId: currentSession.sessionId,
        audio
      });
      if (response.snapshot) {
        applySnapshot(response.snapshot);
      }
      applyVoiceState(response.voice);
    });
  }

  async function cancelVoiceRecording() {
    if (!currentSession) {
      return;
    }

    await runVoiceBusy(async () => {
      if (isWhisperCppSelected()) {
        await browserVoiceRecorderRef.current?.cancel().catch(() => undefined);
      }

      const response = await clientRef.current.cancelVoiceRecording({
        sessionId: currentSession.sessionId
      });
      applyVoiceState(response.voice);
    });
  }

  async function speakLatestAssistantReply() {
    if (!currentSession || !latestAssistantMessage) {
      return;
    }

    await runVoiceBusy(async () => {
      const response = await clientRef.current.speakText({
        sessionId: currentSession.sessionId,
        text: latestAssistantMessage.content
      });
      applyVoiceState(response.voice);
    });
  }

  async function stopAssistantSpeech() {
    await runVoiceBusy(async () => {
      const response = await clientRef.current.stopSpeaking(currentSession?.sessionId);
      applyVoiceState(response.voice);
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }

    event.preventDefault();

    if (!currentSession || isBusy || !composeValue.trim()) {
      return;
    }

    void sendMessage(composeValue);
  }

  return (
    <div className="shell">
      <div className="shell__backdrop" />
      <header className="topbar">
        <div>
          <p className="eyebrow">ASSEM MVP</p>
          <h1>Espacio local de ASSEM</h1>
          <p className="panel-copy">
            Agente persistente, herramientas seguras, memoria de perfiles y tareas programadas.
          </p>
        </div>
        <div className="topbar__status">
          <span className="pill">{healthStatusLabel(systemState?.health.status)}</span>
          <span className="pill pill--accent">{modeLabel(uiMode)}</span>
          <span className="pill">
            Configurado: {providerLabel(providerRuntime?.configuredDefaultProviderId)}
          </span>
          <span className="pill">
            Proveedor activo: {providerLabel(providerRuntime?.activeProviderId, 'sin uso')}
          </span>
          <span className="pill">Modelo: {providerRuntime?.activeModel ?? 'pendiente'}</span>
          {providerRuntime?.resolvedModel &&
            providerRuntime.resolvedModel !== providerRuntime.configuredModel && (
              <span className="pill">
                Resuelto: {providerRuntime.resolvedModel}
              </span>
            )}
          <span className="pill">Voz: {voiceAvailabilityLabel(voice)}</span>
          <span className="pill">Actividad: {voiceActivityLabel(voice)}</span>
          <span className="pill">Perfil: {activeProfile?.name ?? 'Ninguno'}</span>
        </div>
      </header>

      <main className="layout">
        <aside className="sidebar">
          <div className="sidebar__tabs">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                className={sidebarTab === id ? 'is-active' : ''}
                onClick={() => setSidebarTab(id)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="sidebar__panel">
            <section className="sidebar__summary">
              <article className="summary-card">
                <span className="summary-card__label">Estado</span>
                <strong>{healthStatusLabel(systemState?.health.status)}</strong>
                <p>{modeLabel(uiMode)}</p>
              </article>
              <article className="summary-card">
                <span className="summary-card__label">Pendientes</span>
                <strong>{pendingActions.length}</strong>
                <p>{pendingActions.length === 1 ? 'accion pendiente' : 'acciones pendientes'}</p>
              </article>
              <article className="summary-card">
                <span className="summary-card__label">Tareas</span>
                <strong>{enabledScheduledTaskCount}</strong>
                <p>{tasks.length === 1 ? 'tarea total' : 'tareas totales'}</p>
              </article>
            </section>
            {sidebarTab === 'history' && (
              <section className="stack">
                <h2>Historial de acciones</h2>
                <p className="panel-copy">Lo ultimo que ASSEM hizo o dejo pendiente.</p>
                {lastAction && (
                  <article className="card card--compact card--highlight">
                    <div className="card__meta">
                      <strong>Ultima actividad</strong>
                      <span>{fmt(lastAction.createdAt)}</span>
                    </div>
                    <p className="small-copy">{lastAction.detail}</p>
                  </article>
                )}
                {actionLog.length === 0 ? (
                  <div className="card muted">Todavia no hay actividad en esta sesion.</div>
                ) : (
                  actionLog.slice(0, 6).map((entry) => (
                    <article className="card" key={entry.id}>
                      <div className="card__meta">
                        <strong>{actionTitleLabel(entry.title)}</strong>
                        <span>{fmt(entry.createdAt)}</span>
                      </div>
                      <p>{entry.detail}</p>
                      <span className={`tag tag--${entry.status}`}>{statusLabel(entry.status)}</span>
                    </article>
                  ))
                )}
              </section>
            )}

            {sidebarTab === 'permissions' && (
              <section className="stack">
                <h2>Confirmaciones</h2>
                <p className="panel-copy">Lo que tienes que confirmar, sin ruido extra.</p>
                {pendingActions.length > 0 ? (
                  pendingActions.map((pendingAction) => (
                    <article className="card card--highlight card--compact" key={pendingAction.id}>
                      <div className="card__meta">
                        <strong>{providerLabel(pendingAction.toolId, pendingAction.toolLabel)}</strong>
                        <span>{fmt(pendingAction.createdAt)}</span>
                      </div>
                      <p>{pendingAction.confirmationMessage}</p>
                      <p className="small-copy">
                        Herramienta: {providerLabel(pendingAction.toolId)} - Riesgo: {pendingAction.riskLevel}
                      </p>
                      <div className="inline-actions">
                        <button
                          disabled={isBusy}
                          onClick={() => void resolvePendingAction(false)}
                          type="button"
                        >
                          Rechazar
                        </button>
                        <button
                          className="primary"
                          disabled={isBusy}
                          onClick={() => void resolvePendingAction(true)}
                          type="button"
                        >
                          Confirmar
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="card muted">No hay confirmaciones pendientes.</div>
                )}
                <article className="card">
                  <label className="field">
                    <span>Override temporal</span>
                    <textarea
                      rows={3}
                      value={overrideInstruction}
                      onChange={(event) => setOverrideInstruction(event.target.value)}
                    />
                  </label>
                  <div className="inline-actions">
                    <button
                      className="primary"
                      disabled={isBusy || !currentSession}
                      onClick={() =>
                        void runBusy(async () => {
                          await clientRef.current.createOverride({
                            sessionId: currentSession!.sessionId,
                            instruction: overrideInstruction
                          });
                        })
                      }
                      type="button"
                    >
                      Anadir override
                    </button>
                  </div>
                </article>
                {overrides.map((override) => (
                  <article className="card" key={override.id}>
                    <div className="card__meta">
                      <strong>{override.label}</strong>
                      <span>{override.scope}</span>
                    </div>
                    <p>{override.createdFromUserInstruction}</p>
                    <p className="small-copy">Expira {fmt(override.expiresAt)}</p>
                    <div className="inline-actions">
                      <button
                        disabled={isBusy || !currentSession}
                        onClick={() =>
                          void runBusy(async () => {
                            await clientRef.current.cancelOverride(
                              currentSession!.sessionId,
                              override.id
                            );
                          })
                        }
                        type="button"
                      >
                        Cancelar override
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}

            {sidebarTab === 'system' && (
              <section className="stack">
                <h2>Sistema</h2>
                <p className="panel-copy">Estado general, proveedor activo y ultima ejecucion.</p>
                <article className="card">
                  <div className="card__meta">
                    <strong>Salud</strong>
                    <span>{healthStatusLabel(systemState?.health.status)}</span>
                  </div>
                  <p>Tiempo activo: {Math.round((systemState?.health.uptimeMs ?? 0) / 1000)} s</p>
                  <p className="small-copy">Raiz del sandbox: {systemState?.health.sandboxRoot}</p>
                  <p className="small-copy">Raiz de datos: {systemState?.health.dataRoot}</p>
                  <p className="small-copy">
                    Proveedor configurado: {providerLabel(providerRuntime?.configuredDefaultProviderId)}
                  </p>
                  <p className="small-copy">
                    Modelo configurado: {providerRuntime?.configuredModel ?? configuredProvider?.defaultModel ?? 'desconocido'}
                  </p>
                  {providerRuntime?.resolvedModel &&
                    providerRuntime.resolvedModel !== providerRuntime.configuredModel && (
                      <p className="small-copy">
                        Modelo resuelto: {providerRuntime.resolvedModel}
                      </p>
                    )}
                </article>
                <article className="card card--highlight">
                  <div className="card__meta">
                    <strong>Proveedor en runtime</strong>
                    <span>{providerLabel(providerRuntime?.activeProviderId, 'sin uso')}</span>
                  </div>
                  <p>Modelo actual: {providerRuntime?.activeModel ?? 'sin uso'}</p>
                  <p className="small-copy">
                    Ollama: {providerRuntime?.ollamaAvailable ? 'disponible' : 'no disponible'}
                  </p>
                  <p className="small-copy">
                    Fallback usado: {providerRuntime?.fallbackUsed ? 'si' : 'no'}
                  </p>
                  {providerRuntime?.fallbackUsed && (
                    <p className="small-copy">
                      Motivo del fallback: {providerRuntime.fallbackReason ?? 'el router ha seleccionado otro provider'}
                    </p>
                  )}
                  {providerRuntime?.ollamaError && (
                    <p className="small-copy">Error de Ollama: {providerRuntime.ollamaError}</p>
                  )}
                </article>
                <article className="card card--compact">
                  <div className="card__meta">
                    <strong>Tarea activa</strong>
                    <span>
                      {activeConversationTask
                        ? taskStatusLabel(activeConversationTask.status)
                        : 'ninguna'}
                    </span>
                  </div>
                  {activeConversationTask ? (
                    <>
                      <p>{activeConversationTask.objective}</p>
                      <p className="small-copy">
                        Progreso: {taskProgressLabel(activeConversationTask)}
                      </p>
                      <p className="small-copy">
                        Fase: {activeConversationTask.currentPhase ?? 'sin fase definida'}
                      </p>
                      <p className="small-copy">
                        Paso actual:{' '}
                        {activeConversationTaskStep?.label ?? 'sin paso activo'}
                      </p>
                      <p className="small-copy">
                        Artefactos: {activeConversationTask.artifacts.length}
                      </p>
                      {activeConversationTaskArtifacts.length > 0 && (
                        <div className="stack stack--tight">
                          {activeConversationTaskArtifacts.map((artifact) => (
                            <p className="small-copy" key={artifact.id}>
                              {artifact.label}
                              {artifact.filePath ? ` - ${artifact.filePath}` : ''}
                            </p>
                          ))}
                        </div>
                      )}
                      {activeConversationTaskRefinements.length > 0 && (
                        <div className="stack stack--tight">
                          <p className="small-copy">
                            Refinamientos activos: {activeConversationTaskRefinements.length}
                          </p>
                          {activeConversationTaskRefinements.slice(-3).map((refinement) => (
                            <p className="small-copy" key={refinement.id}>
                              {refinement.label}
                            </p>
                          ))}
                        </div>
                      )}
                      {activeConversationTaskPlan && (
                        <div className="stack stack--tight">
                          <p className="small-copy">
                            Plan: {activeConversationTaskPlan.phases.length} fase(s) -{' '}
                            {activeConversationTaskPlan.steps.length} paso(s)
                          </p>
                          <p className="small-copy">{activeConversationTaskPlan.summary}</p>
                          {activeConversationTaskPendingPlanSteps.slice(0, 3).map((stepLabel, index) => (
                            <p className="small-copy" key={`${stepLabel}-${index}`}>
                              Pendiente: {stepLabel}
                            </p>
                          ))}
                          <p className="small-copy">
                            Artefactos esperados: {activeConversationTaskPlan.expectedArtifacts.length}
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="small-copy">
                      No hay una tarea activa asociada a esta sesion.
                    </p>
                  )}
                </article>
                {lastTelemetry && (
                  <article className="card card--compact">
                    <div className="card__meta">
                      <strong>Ultima telemetria</strong>
                      <span>{fmt(lastTelemetry.timestamp)}</span>
                    </div>
                    <p className="small-copy">
                      {providerLabel(lastTelemetry.providerId, 'desconocido')} / {lastTelemetry.model ?? 'modelo desconocido'}
                    </p>
                    <p className="small-copy">
                      {statusLabel(lastTelemetry.result)} - {lastTelemetry.fallbackUsed ? 'con fallback' : 'sin fallback'}
                    </p>
                  </article>
                )}
                <article className="card">
                  <div className="card__meta">
                    <strong>Proveedores</strong>
                    <span>{providerHealth.length}</span>
                  </div>
                  <div className="stack">
                    {providerHealth.map((provider) => (
                      <div className="subcard" key={provider.providerId}>
                        <strong>{providerLabel(provider.providerId, provider.label)}</strong>
                        <p className="small-copy">
                          {healthStatusLabel(provider.status)} - modelo por defecto {provider.defaultModel}
                        </p>
                        {provider.resolvedModel &&
                          provider.resolvedModel !== provider.defaultModel && (
                            <p className="small-copy">
                              modelo resuelto: {provider.resolvedModel}
                            </p>
                          )}
                        <p className="small-copy">
                          configurado: {provider.configured ? 'si' : 'no'}
                        </p>
                        {provider.availableModels && provider.availableModels.length > 0 && (
                          <p className="small-copy">
                            modelos: {provider.availableModels.slice(0, 5).join(', ')}
                          </p>
                        )}
                        {provider.error && (
                          <p className="small-copy">error: {provider.error}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </article>
                <article className="card">
                  <div className="card__meta">
                    <strong>Telemetria</strong>
                    <span>{telemetry?.totalInteractions ?? 0}</span>
                  </div>
                  <p>
                    Exitos {telemetry?.successes ?? 0} - Rechazos {telemetry?.rejections ?? 0} - Errores {telemetry?.errors ?? 0}
                  </p>
                  <p className="small-copy">Ultima interaccion: {fmt(telemetry?.lastInteractionAt)}</p>
                  {recentTelemetry.length > 0 && (
                    <div className="stack">
                      {recentTelemetry.slice(0, 3).map((entry) => (
                        <div className="subcard" key={entry.id}>
                          <strong>
                            {providerLabel(entry.providerId, 'desconocido')} / {entry.model ?? 'modelo desconocido'}
                          </strong>
                          <p className="small-copy">
                            {statusLabel(entry.result)} - {fmt(entry.timestamp)}
                          </p>
                          {entry.fallbackUsed && (
                            <p className="small-copy">
                              fallback: {entry.fallbackReason ?? 'fallback del router'}
                            </p>
                          )}
                          {entry.errorMessage && (
                            <p className="small-copy">error: {entry.errorMessage}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
                <article className="card">
                  <div className="card__meta">
                    <strong>Sesiones</strong>
                    <span>{sessions.length}</span>
                  </div>
                  {sessions.slice(0, 5).map((session) => (
                    <div className="subcard" key={session.sessionId}>
                      <strong>{session.sessionId.slice(0, 8)}</strong>
                      <p className="small-copy">{session.messageCount} mensajes - {fmt(session.updatedAt)}</p>
                    </div>
                  ))}
                </article>
              </section>
            )}

            {sidebarTab === 'voice' && (
              <section className="stack">
                <h2>Voz</h2>
                <p className="panel-copy">
                  Pulsa para hablar, revisa el estado real del microfono y decide si ASSEM debe leer las respuestas automaticamente.
                </p>
                <article className="card card--highlight voice-panel">
                  <div
                    className={`voice-stage${
                      voiceSession?.recordingState === 'recording'
                        ? ' voice-stage--recording'
                        : voiceSession?.speakingState === 'speaking'
                          ? ' voice-stage--speaking'
                          : voiceSession?.lastError
                            ? ' voice-stage--error'
                            : ''
                    }`}
                    aria-hidden="true"
                  >
                    <span className="voice-ring voice-ring--outer" />
                    <span className="voice-ring voice-ring--mid" />
                    <span className="voice-ring voice-ring--inner" />
                    <span className="voice-wave voice-wave--one" />
                    <span className="voice-wave voice-wave--two" />
                    <span className="voice-wave voice-wave--three" />
                    <span className="voice-core">
                      {voiceSession?.recordingState === 'recording'
                        ? 'REC'
                        : voiceSession?.speakingState === 'speaking'
                          ? 'VOZ'
                          : voiceSession?.lastError
                            ? 'ERR'
                            : 'ASSEM'}
                    </span>
                  </div>
                  <div className="voice-copy">
                    <strong>Estado de voz: {voiceAvailabilityLabel(voice)}</strong>
                    <p>
                      STT activo: {providerLabel(voice?.settings.sttProviderId, 'sin provider')} - TTS activo:{' '}
                      {providerLabel(voice?.settings.ttsProviderId, 'sin provider')}
                    </p>
                    <p>
                      Microfono: {voice?.microphoneAccessible ? 'accesible' : 'no accesible'} - idioma configurado:{' '}
                      {voice?.settings.preferredLanguage ?? 'sin definir'} - idioma efectivo:{' '}
                      {effectiveVoiceLanguage}
                    </p>
                    <p className="small-copy">
                      STT legado de Windows: aislado y no activo en esta fase. El STT real de desktop va por whisper.cpp.
                    </p>
                  </div>
                </article>
                <article className="card card--compact">
                  <div className="card__meta">
                    <strong>Runtime STT</strong>
                    <span>{healthStatusLabel(selectedSttProvider?.status)}</span>
                  </div>
                  <p className="small-copy">
                    Provider: {providerLabel(selectedSttProvider?.providerId, selectedSttProvider?.label)}
                  </p>
                  <p className="small-copy">
                    Estado real: {selectedSttProvider?.available ? 'listo para transcribir' : 'no listo'}
                  </p>
                  {selectedSttProvider?.error && (
                    <p className="small-copy">Detalle: {selectedSttProvider.error}</p>
                  )}
                </article>
                <article className="card card--compact">
                  <div className="card__meta">
                    <strong>Runtime TTS</strong>
                    <span>{healthStatusLabel(selectedTtsProvider?.status)}</span>
                  </div>
                  <p className="small-copy">
                    Provider: {providerLabel(selectedTtsProvider?.providerId, selectedTtsProvider?.label)}
                  </p>
                  <p className="small-copy">
                    Estado real: {selectedTtsProvider?.available ? 'listo para leer respuestas' : 'no listo'}
                  </p>
                  {selectedTtsProvider?.error && (
                    <p className="small-copy">Detalle: {selectedTtsProvider.error}</p>
                  )}
                </article>
                <article className="card card--compact">
                  <div className="card__meta">
                    <strong>Controles</strong>
                    <span>{voiceActivityLabel(voice)}</span>
                  </div>
                  <div className="voice-controls">
                    <button
                      className="primary"
                      disabled={!canStartRecording}
                      onClick={() => void startVoiceRecording()}
                      type="button"
                    >
                      Iniciar grabacion
                    </button>
                    <button
                      disabled={!canStopRecording}
                      onClick={() => void stopVoiceRecording()}
                      type="button"
                    >
                      Detener y enviar
                    </button>
                    <button
                      disabled={voiceSession?.recordingState !== 'recording' || busy}
                      onClick={() => void cancelVoiceRecording()}
                      type="button"
                    >
                      Cancelar grabacion
                    </button>
                    <button
                      disabled={!canPlayLatestReply}
                      onClick={() => void speakLatestAssistantReply()}
                      type="button"
                    >
                      Leer ultima respuesta
                    </button>
                    <button
                      disabled={voiceSession?.speakingState !== 'speaking' || busy}
                      onClick={() => void stopAssistantSpeech()}
                      type="button"
                    >
                      Parar lectura
                    </button>
                  </div>
                  <label className="field field--inline">
                    <span>Autolectura de respuestas</span>
                    <input
                      checked={voice?.settings.autoReadResponses ?? false}
                      disabled={busy}
                      onChange={(event) => void toggleAutoReadResponses(event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                </article>
                <article className="card card--compact">
                  <div className="card__meta">
                    <strong>Transcript reciente</strong>
                    <span>{voiceSession?.audioDurationMs ? `${voiceSession.audioDurationMs} ms` : 'sin audio'}</span>
                  </div>
                  <p className="small-copy">
                    {voiceSession?.lastTranscript ?? 'Todavia no hay ningun transcript en esta sesion.'}
                  </p>
                  <p className="small-copy">
                    Audio: {formatVoiceAudioDiagnostics(latestVoiceAudio)}
                  </p>
                </article>
                <article className="card card--compact">
                  <div className="card__meta">
                    <strong>Ultima lectura</strong>
                    <span>{voiceSession?.speakingState === 'speaking' ? 'sonando' : 'en espera'}</span>
                  </div>
                  <p className="small-copy">
                    {voiceSession?.lastAssistantMessage ?? 'Todavia no hay ninguna respuesta lista para leer.'}
                  </p>
                </article>
                <article className="card card--compact">
                  <div className="card__meta">
                    <strong>Diagnostico de voz</strong>
                    <span>{voice?.lastError ? 'revisar' : 'estable'}</span>
                  </div>
                  <p className="small-copy">
                    {voice?.lastError ?? 'Sin incidencias de microfono, transcripcion o sintesis en esta sesion.'}
                  </p>
                  {latestVoiceDiagnostic?.detail && (
                    <p className="small-copy">Detalle: {latestVoiceDiagnostic.detail}</p>
                  )}
                  {latestVoiceDiagnostic && (
                    <p className="small-copy">
                      Codigo: {latestVoiceDiagnostic.code} - transcript.json:{' '}
                      {latestVoiceDiagnostic.transcriptJsonGenerated === undefined
                        ? 'sin dato'
                        : latestVoiceDiagnostic.transcriptJsonGenerated
                          ? 'generado'
                          : 'no generado'}
                    </p>
                  )}
                </article>
              </section>
            )}

            {sidebarTab === 'profiles' && (
              <section className="stack">
                <h2>Perfiles</h2>
                <p className="panel-copy">Memoria persistente, sin mezclarla con el chat.</p>
                <article className="card card--highlight">
                  <div className="card__meta">
                    <strong>Perfil activo</strong>
                    <span>{activeProfile?.name ?? 'Ninguno'}</span>
                  </div>
                  <p className="small-copy">Actualizado {fmt(activeProfile?.updatedAt)}</p>
                </article>
                <article className="card">
                  <label className="field">
                    <span>Nombre del perfil</span>
                    <input value={profileName} onChange={(event) => setProfileName(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Nota inicial</span>
                    <textarea rows={3} value={profileNote} onChange={(event) => setProfileNote(event.target.value)} />
                  </label>
                  <div className="inline-actions">
                    <button
                      className="primary"
                      disabled={isBusy || !profileName.trim()}
                      onClick={() =>
                        void runBusy(async () => {
                          await clientRef.current.createProfile({
                            name: profileName,
                            notes: profileNote.trim() ? [profileNote.trim()] : []
                          });
                          setProfileName('');
                          setProfileNote('');
                        })
                      }
                      type="button"
                    >
                      Crear perfil
                    </button>
                  </div>
                </article>
                {profiles.map((profile) => (
                  <article className="card" key={profile.id}>
                    <div className="card__meta">
                      <strong>{profile.name}</strong>
                      <span>{profile.isActive ? 'activo' : 'guardado'}</span>
                    </div>
                    <p className="small-copy">
                      {profile.notesCount} nota(s) - {profile.contactsCount} contacto(s) - {profile.summariesCount} resumen(es)
                    </p>
                    <div className="inline-actions">
                      <button
                        disabled={isBusy || profile.isActive}
                        onClick={() =>
                          void runBusy(async () => {
                            await clientRef.current.activateProfile(profile.id);
                          })
                        }
                        type="button"
                      >
                        Activar
                      </button>
                      <button
                        disabled={isBusy}
                        onClick={() =>
                          void runBusy(async () => {
                            const response = await clientRef.current.exportProfile(profile.id);
                            setProfileExport(JSON.stringify(response.profile, null, 2));
                          })
                        }
                        type="button"
                      >
                        Exportar
                      </button>
                      <button
                        disabled={isBusy}
                        onClick={() =>
                          void runBusy(async () => {
                            await clientRef.current.resetProfile(profile.id);
                          })
                        }
                        type="button"
                      >
                        Resetear
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}

            {sidebarTab === 'schedule' && (
              <section className="stack">
                <h2>Tareas programadas</h2>
                <p className="panel-copy">Recordatorios, revisiones y chequeos seguros.</p>
                <article className="card">
                  <label className="field">
                    <span>Etiqueta</span>
                    <input value={taskLabel} onChange={(event) => setTaskLabel(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Instruccion</span>
                    <textarea rows={3} value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} />
                  </label>
                  <div className="form-grid">
                    <label className="field">
                      <span>Tipo</span>
                      <select value={taskKind} onChange={(event) => setTaskKind(event.target.value as ScheduledTask['kind'])}>
                        <option value="reminder">recordatorio</option>
                        <option value="internal_review">revision interna</option>
                        <option value="summary">resumen</option>
                        <option value="simple_check">chequeo simple</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Cadencia</span>
                      <select value={taskCadence} onChange={(event) => setTaskCadence(event.target.value as ScheduledTask['cadence'])}>
                        <option value="manual">manual</option>
                        <option value="once">una vez</option>
                        <option value="daily">diaria</option>
                      </select>
                    </label>
                  </div>
                  <label className="field">
                    <span>Programar para</span>
                    <input type="datetime-local" value={taskScheduleAt} onChange={(event) => setTaskScheduleAt(event.target.value)} />
                  </label>
                  <div className="inline-actions">
                    <button
                      className="primary"
                      disabled={isBusy || !taskLabel.trim() || !taskPrompt.trim()}
                      onClick={() =>
                        void runBusy(async () => {
                          await clientRef.current.createSchedulerTask({
                            label: taskLabel,
                            prompt: taskPrompt,
                            kind: taskKind,
                            cadence: taskCadence,
                            scheduleAt: taskScheduleAt ? new Date(taskScheduleAt).toISOString() : undefined
                          });
                          setTaskLabel('');
                          setTaskPrompt('');
                          setTaskScheduleAt('');
                        })
                      }
                      type="button"
                    >
                      Crear tarea
                    </button>
                  </div>
                </article>
                {tasks.length === 0 ? (
                  <div className="card muted">Todavia no hay tareas programadas.</div>
                ) : (
                  tasks.map((task) => (
                    <article className="card card--compact" key={task.id}>
                      <div className="card__meta">
                        <strong>{task.label}</strong>
                        <span>{task.kind}</span>
                      </div>
                      <p>{task.prompt}</p>
                      <p className="small-copy">
                        {task.enabled ? 'Activa' : 'Pausada'} - {task.cadence} - siguiente {fmt(task.nextRunAt)}
                      </p>
                      {task.lastRun && (
                        <p className="small-copy">Ultima ejecucion {statusLabel(task.lastRun.status)} en {fmt(task.lastRun.finishedAt)}</p>
                      )}
                      <div className="inline-actions">
                        <button
                          disabled={isBusy}
                          onClick={() =>
                            void runBusy(async () => {
                              await clientRef.current.setSchedulerTaskEnabled(task.id, !task.enabled);
                            })
                          }
                          type="button"
                        >
                          {task.enabled ? 'Pausar' : 'Activar'}
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() =>
                            void runBusy(async () => {
                              await clientRef.current.runSchedulerTask(task.id, currentSession?.sessionId);
                            })
                          }
                          type="button"
                        >
                          Ejecutar ahora
                        </button>
                        <button
                          disabled={isBusy}
                          onClick={() =>
                            void runBusy(async () => {
                              await clientRef.current.deleteSchedulerTask(task.id);
                            })
                          }
                          type="button"
                        >
                          Borrar
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </section>
            )}

            {sidebarTab === 'settings' && (
              <section className="stack">
                <h2>Ajustes</h2>
                <article className="card">
                  <label className="field">
                    <span>Modo de privacidad</span>
                    <select value={uiMode.privacy} onChange={(event) => void changeMode({ privacy: event.target.value as ActiveMode['privacy'] })}>
                      <option value="local_only">Solo local</option>
                      <option value="prefer_local">Prioriza local</option>
                      <option value="balanced">Equilibrado</option>
                      <option value="cloud_allowed">Permite nube</option>
                    </select>
                  </label>
                </article>
                <article className="card">
                  <label className="field">
                    <span>Modo de ejecucion</span>
                    <select value={uiMode.runtime} onChange={(event) => void changeMode({ runtime: event.target.value as ActiveMode['runtime'] })}>
                      <option value="sandbox">Sandbox</option>
                      <option value="live">En vivo</option>
                    </select>
                  </label>
                </article>
                <article className="card">
                  <label className="field">
                    <span>Importar perfil en JSON</span>
                    <textarea rows={6} value={profileImport} onChange={(event) => setProfileImport(event.target.value)} />
                  </label>
                  <div className="inline-actions">
                    <button
                      className="primary"
                      disabled={isBusy || !profileImport.trim()}
                      onClick={() =>
                        void runBusy(async () => {
                          const parsed: unknown = JSON.parse(profileImport);
                          const payload = toProfileImportPayload(parsed);
                          await clientRef.current.importProfile(payload);
                          setProfileImport('');
                        })
                      }
                      type="button"
                    >
                      Importar perfil
                    </button>
                  </div>
                </article>
                {profileExport && (
                  <article className="card">
                    <label className="field">
                      <span>Perfil exportado en JSON</span>
                      <textarea readOnly rows={8} value={profileExport} />
                    </label>
                  </article>
                )}
              </section>
            )}
          </div>
        </aside>

        <section className="chat">
          <div className="chat__header">
            <div>
              <p className="eyebrow">Conversacion</p>
              <h2>Chat principal</h2>
            </div>
            <p className="panel-copy">
              La UI se mantiene ligera y el agente local controla la orquestacion, la persistencia, el routing y la politica.
            </p>
          </div>

          {error && (
            <div className="banner banner--error">
              <strong>Error del agente local</strong>
              <span>{error}</span>
            </div>
          )}

          {voice?.lastError && (
            <div className="banner banner--warning">
              <strong>Estado de voz</strong>
              <span>{voice.lastError}</span>
            </div>
          )}

          <div className="chat__statusbar">
            <span className="pill">Estado: {healthStatusLabel(systemState?.health.status)}</span>
            <span className="pill">Modo: {modeLabel(uiMode)}</span>
            <span className="pill">
              Proveedor: {providerLabel(providerRuntime?.activeProviderId ?? providerRuntime?.configuredDefaultProviderId)}
            </span>
            <span className="pill">Modelo: {providerRuntime?.activeModel ?? 'pendiente'}</span>
            {providerRuntime?.fallbackUsed && (
              <span className="pill">Fallback activo</span>
            )}
            <span className="pill">
              Tarea activa:{' '}
              {activeConversationTask
                ? taskStatusLabel(activeConversationTask.status)
                : 'ninguna'}
            </span>
            {activeConversationTask && (
              <>
                <span className="pill">Fase: {activeConversationTask.currentPhase ?? 'sin fase'}</span>
                <span className="pill">
                  Progreso: {taskProgressLabel(activeConversationTask)}
                </span>
                <span className="pill">
                  Paso: {activeConversationTaskStep?.label ?? 'sin paso'}
                </span>
                {activeConversationTaskArtifacts[0] && (
                  <span className="pill">
                    Ultimo artefacto: {activeConversationTaskArtifacts.at(-1)?.label}
                  </span>
                )}
                {activeConversationTaskPlan && (
                  <span className="pill">
                    Plan: {activeConversationTaskPendingPlanSteps.length} paso(s) pendientes
                  </span>
                )}
                {activeConversationTaskRefinements.length > 0 && (
                  <span className="pill">
                    Ajustes: {activeConversationTaskRefinements.length}
                  </span>
                )}
              </>
            )}
            <span className="pill">Voz: {voiceAvailabilityLabel(voice)}</span>
            <span className="pill">Mic: {voice?.microphoneAccessible ? 'accesible' : 'sin acceso'}</span>
            <span className="pill">
              Autolectura: {voice?.settings.autoReadResponses ? 'activa' : 'manual'}
            </span>
            {pendingActions.length > 0 && (
              <button
                className="pill pill--button"
                onClick={() => setSidebarTab('permissions')}
                type="button"
              >
                {pendingActions.length} confirmacion{pendingActions.length === 1 ? '' : 'es'} pendiente{pendingActions.length === 1 ? '' : 's'}
              </button>
            )}
            <span className="pill">Perfil: {activeProfile?.name ?? 'ninguno'}</span>
            <span className="pill">Tareas: {enabledScheduledTaskCount}</span>
          </div>

          <div
            className={`chat__messages${hasMessages ? ' chat__messages--populated' : ''}`}
          >
            {messages.length === 0 ? (
              <div className="empty-state">
                <h3>Empieza con una tarea breve</h3>
                <p>Pregunta por la hora, lista el sandbox o pide una accion local segura.</p>
                <div className="prompt-grid">
                  {prompts.map((prompt) => (
                    <button key={prompt} disabled={isBusy || !currentSession} onClick={() => void sendMessage(prompt)} type="button">
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article className={`message message--${message.role}`} key={message.id}>
                  <div className="message__meta">
                    <strong>{message.role === 'user' ? 'Tu' : 'ASSEM'}</strong>
                    <span>{fmt(message.createdAt)}</span>
                  </div>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage(composeValue);
            }}
          >
            <div className="composer__voice">
              <div className="composer__voice-status">
                <span className="pill">Voz {voiceAvailabilityLabel(voice)}</span>
                <span className="pill">{voiceActivityLabel(voice)}</span>
              </div>
              <div className="inline-actions">
                <button
                  className="primary"
                  disabled={!canStartRecording}
                  onClick={() => void startVoiceRecording()}
                  type="button"
                >
                  Hablar
                </button>
                <button
                  disabled={!canStopRecording}
                  onClick={() => void stopVoiceRecording()}
                  type="button"
                >
                  Detener y enviar
                </button>
                <button
                  disabled={voiceSession?.recordingState !== 'recording' || busy}
                  onClick={() => void cancelVoiceRecording()}
                  type="button"
                >
                  Cancelar
                </button>
                <button
                  disabled={!canPlayLatestReply}
                  onClick={() => void speakLatestAssistantReply()}
                  type="button"
                >
                  Leer ultima
                </button>
                <button
                  disabled={voiceSession?.speakingState !== 'speaking' || busy}
                  onClick={() => void stopAssistantSpeech()}
                  type="button"
                >
                  Parar voz
                </button>
              </div>
            </div>
            <textarea
              disabled={!currentSession || isBusy}
              rows={4}
              value={composeValue}
              onChange={(event) => setComposeValue(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder='Escribe algo como "Lista el sandbox" o "Crea un archivo llamado agenda.txt"'
            />
            <div className="composer__footer">
              <p className="small-copy">
                Modo actual: <strong>{modeLabel(uiMode)}</strong> - autolectura{' '}
                <strong>{voice?.settings.autoReadResponses ? 'activa' : 'manual'}</strong>
              </p>
              <button className="primary" disabled={!currentSession || isBusy || !composeValue.trim()} type="submit">
                {isBusy ? 'Enviando...' : 'Enviar'}
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
