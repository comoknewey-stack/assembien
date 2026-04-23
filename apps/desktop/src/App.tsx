import { startTransition, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { AssemClient } from '@assem/sdk';
import type {
  ActiveMode,
  AssemTask,
  ProfileImportPayload,
  ProfileMemory,
  PendingAction,
  ScheduledTask,
  SpeechToTextAudioInput,
  SessionSnapshot,
  SystemStateSnapshot,
  TaskPlan,
  TaskRefinement,
  VoiceAudioDiagnostics,
  VoiceModeState,
  VoiceSystemState
} from '@assem/shared-types';

import {
  canSpeakAssistantReply,
  canStartVoiceCapture,
  canStopVoiceCapture,
  voiceActivityLabel,
  voiceAvailabilityLabel
} from './voice-ui';
import {
  AssistantStatusPanel,
  SidebarSummary
} from './assistant-panels';
import { AssistantCore, resolveAssistantCoreState } from './assistant-core';
import { BrowserVoiceRecorder } from './audio-recorder';
import { ConversationPane } from './conversation-pane';
import { resolveRuntimeModelDisplay } from './runtime-display';
import { VoiceOrb, resolveVoiceOrbState } from './voice-orb';
import { BrowserConversationModeLoop } from './wake-mode-loop';

type Tab =
  | 'status'
  | 'history'
  | 'permissions'
  | 'system'
  | 'voice'
  | 'profiles'
  | 'schedule'
  | 'settings';

const tabs: Array<[Tab, string]> = [
  ['status', 'Estado'],
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
const APP_VERSION = '0.1.0';

function formatClock(value: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(value);
}

function formatClockDate(value: Date): string {
  return new Intl.DateTimeFormat('es-ES', {
    weekday: 'short',
    day: '2-digit',
    month: 'short'
  }).format(value);
}

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

function isVisiblePendingAction(
  action: PendingAction | null | undefined
): action is PendingAction {
  return action?.status === 'pending';
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

function extractResearchSummary(task: AssemTask | null | undefined): {
  found: number;
  selected: number;
  discarded: number;
  read: number;
  snippetOnly: number;
  evidence: number;
  evidenceLevel?: string;
  searchError?: string;
} | null {
  if (!task || !isObjectRecord(task.metadata)) {
    return null;
  }

  const research = task.metadata.research;
  if (!isObjectRecord(research)) {
    return null;
  }

  const selectedSources = Array.isArray(research.sourcesSelected)
    ? research.sourcesSelected.filter(isObjectRecord)
    : [];
  const evidence = Array.isArray(research.evidence) ? research.evidence.length : 0;

  return {
    found: Array.isArray(research.sourcesFound) ? research.sourcesFound.length : 0,
    selected: selectedSources.length,
    discarded: Array.isArray(research.sourcesDiscarded)
      ? research.sourcesDiscarded.length
      : 0,
    read: selectedSources.filter(
      (source) =>
        source.evidenceLevel === 'page_read' ||
        source.fetchStatus === 'ok' ||
        source.usedAs === 'page_read'
    ).length,
    snippetOnly: selectedSources.filter(
      (source) =>
        source.evidenceLevel === 'snippet_only' ||
        source.usedAs === 'snippet_only'
    ).length,
    evidence,
    evidenceLevel:
      typeof research.evidenceLevel === 'string' ? research.evidenceLevel : undefined,
    searchError:
      typeof research.searchError === 'string' ? research.searchError : undefined
  };
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

  if (typeof audio.gainApplied === 'number' && audio.gainApplied > 1) {
    details.push(`ganancia x${audio.gainApplied}`);
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
  const conversationModeLoopRef = useRef<BrowserConversationModeLoop | null>(null);
  const conversationModeLoopSessionIdRef = useRef<string | null>(null);
  const conversationModeLoopSettingsRef = useRef<string | null>(null);
  const latestVoiceRef = useRef<VoiceSystemState | null>(null);
  const latestSessionIdRef = useRef<string | null>(null);

  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [systemState, setSystemState] = useState<SystemStateSnapshot | null>(null);
  const [uiMode, setUiMode] = useState<ActiveMode>({
    privacy: 'local_only',
    runtime: 'sandbox'
  });
  const [sidebarTab, setSidebarTab] = useState<Tab>('status');
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [clockNow, setClockNow] = useState(() => new Date());

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
  const activeConversationResearchSummary = extractResearchSummary(activeConversationTask);
  const activeConversationTaskPendingPlanSteps = extractPendingPlannedSteps(
    activeConversationTask
  );
  const providerHealth = systemState?.health.providerHealth ?? [];
  const providerRuntime = systemState?.providerRuntime;
  const voice = systemState?.voice ?? null;
  const voiceSession = voice?.session ?? null;
  latestVoiceRef.current = voice;
  latestSessionIdRef.current = currentSession?.sessionId ?? null;
  const effectiveVoiceLanguage =
    voiceSession?.lastTranscriptionLanguage ?? voice?.settings.preferredLanguage ?? 'sin definir';
  const latestVoiceDiagnostic = voiceSession?.lastDiagnostic;
  const latestVoiceAudio = voiceSession?.lastAudioDiagnostics;
  const latestWakeVoiceDiagnostic = voiceSession?.lastWakeDiagnostic;
  const latestWakeVoiceAudio = voiceSession?.lastWakeAudioDiagnostics;
  const voiceOrbState = resolveVoiceOrbState(voice);
  const selectedSttProvider = voice?.sttProviders.find(
    (provider) => provider.providerId === voice.settings.sttProviderId
  );
  const selectedTtsProvider = voice?.ttsProviders.find(
    (provider) => provider.providerId === voice.settings.ttsProviderId
  );
  const voiceDiagnosticSummary = latestVoiceDiagnostic?.summary;
  const wakeVoiceDiagnosticSummary = latestWakeVoiceDiagnostic?.summary;
  const telemetry = systemState?.telemetry;
  const configuredProvider = providerHealth.find(
    (provider) => provider.providerId === providerRuntime?.configuredDefaultProviderId
  );
  const runtimeModelDisplay = resolveRuntimeModelDisplay(providerRuntime);
  const configuredProviderLabel = providerLabel(
    providerRuntime?.activeProviderId ?? providerRuntime?.configuredDefaultProviderId,
    'sin uso'
  );
  const sessionMetaLabel = (currentSession?.sessionId ?? 'sin sesion').slice(0, 6).toUpperCase();
  const recentTelemetry = telemetry?.recent ?? [];
  const sessions = systemState?.sessions ?? [];
  const messages = currentSession?.messages ?? [];
  const latestAssistantMessage =
    [...messages].reverse().find((message) => message.role === 'assistant') ?? null;
  const actionLog = [...(currentSession?.actionLog ?? [])].reverse();
  const overrides = currentSession?.temporaryOverrides ?? [];
  const pendingActions = currentSession?.pendingAction
    ? isVisiblePendingAction(currentSession.pendingAction)
      ? [currentSession.pendingAction]
      : []
    : (systemState?.pendingActions ?? []).filter(isVisiblePendingAction);
  const enabledScheduledTaskCount = tasks.filter((task) => task.enabled).length;
  const lastAction = actionLog[0] ?? null;
  const lastTelemetry = recentTelemetry[0] ?? null;
  const busy = isBusy || isVoiceBusy;
  const voiceModeEnabled = voice?.settings.voiceModeEnabled ?? false;
  const micMuted = voice?.settings.micMuted ?? false;
  const canStartRecording =
    canStartVoiceCapture(voice, Boolean(currentSession), busy) && !voiceModeEnabled && !micMuted;
  const canStopRecording = canStopVoiceCapture(voice, Boolean(currentSession), busy);
  const canPlayLatestReply = canSpeakAssistantReply(
    voice,
    Boolean(currentSession),
    Boolean(latestAssistantMessage),
    busy
  );
  const assistantCoreState = resolveAssistantCoreState({
    voice,
    activeTask: activeConversationTask,
    isBusy: busy,
    hasError: Boolean(error)
  });
  const clockLabel = formatClock(clockNow);
  const clockDateLabel = formatClockDate(clockNow);

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

  async function stopConversationModeLoop(): Promise<void> {
    const loop = conversationModeLoopRef.current;
    conversationModeLoopRef.current = null;
    conversationModeLoopSessionIdRef.current = null;
    conversationModeLoopSettingsRef.current = null;
    await loop?.stop().catch(() => undefined);
  }

  function startConversationModeLoop(sessionId: string, sourceVoice: VoiceSystemState | null = latestVoiceRef.current): void {
    const settings = sourceVoice?.settings;
    const loopSettings = {
      activeSilenceMs: settings?.activeSilenceMs ?? 2_000,
      activeMaxMs: settings?.activeMaxMs ?? 30_000,
      activeMinSpeechMs: settings?.activeMinSpeechMs ?? 800,
      activePrerollMs: settings?.activePrerollMs ?? 700,
      activePostrollMs: settings?.activePostrollMs ?? 500,
      idleIntervalMs: 150
    };
    const loopSettingsKey = JSON.stringify(loopSettings);

    if (
      conversationModeLoopRef.current &&
      conversationModeLoopSessionIdRef.current === sessionId &&
      conversationModeLoopSettingsRef.current === loopSettingsKey
    ) {
      return;
    }

    if (conversationModeLoopRef.current) {
      void stopConversationModeLoop().then(() => startConversationModeLoop(sessionId, sourceVoice));
      return;
    }

    const loop = new BrowserConversationModeLoop(
      loopSettings,
      {
        shouldCaptureTurn: () => {
          const currentVoice = latestVoiceRef.current;
          const currentSessionId = latestSessionIdRef.current;
          const currentVoiceSession = currentVoice?.session;

          return Boolean(
            currentSessionId === sessionId &&
              currentVoice?.settings.voiceModeEnabled &&
              !currentVoice.settings.micMuted &&
              currentVoiceSession?.speakingState !== 'speaking' &&
              currentVoiceSession?.recordingState !== 'recording' &&
              currentVoiceSession?.recordingState !== 'transcribing'
          );
        },
        onConversationWaiting: async () => {
          const currentVoice = latestVoiceRef.current;
          if (currentVoice?.session?.voiceModeState === 'conversation_waiting') {
            return;
          }

          const response = await clientRef.current.updateVoiceActiveListeningState({
            sessionId,
            state: 'conversation_waiting',
            audioDurationMs: 0
          });
          applyVoiceState(response.voice);
        },
        onActiveListeningStart: async () => {
          const state = await clientRef.current.startVoiceActiveListening({
            sessionId
          });
          applyVoiceState(state.voice);
        },
        onActiveState: async (state: VoiceModeState, audioDurationMs: number) => {
          const response = await clientRef.current.updateVoiceActiveListeningState({
            sessionId,
            state,
            audioDurationMs
          });
          applyVoiceState(response.voice);
        },
        onActiveAudio: async (audio, reason) => {
          const response = await clientRef.current.stopVoiceActiveListening({
            sessionId,
            audio,
            reason
          });
          if (response.snapshot) {
            applySnapshot(response.snapshot);
          }
          applyVoiceState(response.voice);
        },
        onActiveNoSpeech: async () => {
          const response = await clientRef.current.stopVoiceActiveListening({
            sessionId,
            reason: 'no_speech'
          });
          applyVoiceState(response.voice);
        },
        onError: (caughtError) => {
          setError(caughtError.message);
          void stopConversationModeLoop();
          void clientRef.current
            .updateVoiceMode({
              sessionId,
              enabled: false
            })
            .then((response) => applyVoiceState(response.voice))
            .catch(() => undefined);
        }
      }
    );

    conversationModeLoopRef.current = loop;
    conversationModeLoopSessionIdRef.current = sessionId;
    conversationModeLoopSettingsRef.current = loopSettingsKey;
    loop.start();
  }

  async function toggleVoiceMode(nextEnabled: boolean): Promise<void> {
    if (!currentSession) {
      return;
    }

    await runVoiceBusy(async () => {
      if (!nextEnabled) {
        await stopConversationModeLoop();
      }

      const response = await clientRef.current.updateVoiceMode({
        sessionId: currentSession.sessionId,
        enabled: nextEnabled
      });
      applyVoiceState(response.voice);

      if (nextEnabled && !response.voice.settings.micMuted) {
        startConversationModeLoop(currentSession.sessionId, response.voice);
      }
    });
  }

  useEffect(() => {
    const sessionId = currentSession?.sessionId;
    if (!sessionId || !voice?.settings.voiceModeEnabled || voice.settings.micMuted) {
      void stopConversationModeLoop();
      return;
    }

    startConversationModeLoop(sessionId, voice);
  }, [
    currentSession?.sessionId,
    voice?.settings.voiceModeEnabled,
    voice?.settings.micMuted,
    voice?.settings.activeSilenceMs,
    voice?.settings.activeMaxMs,
    voice?.settings.activeMinSpeechMs,
    voice?.settings.activePrerollMs,
    voice?.settings.activePostrollMs
  ]);

  useEffect(() => {
    return () => {
      void stopConversationModeLoop();
    };
  }, []);

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

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockNow(new Date()), 1000);

    return () => window.clearInterval(intervalId);
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

  async function toggleMicMuted(nextValue: boolean) {
    await runVoiceBusy(async () => {
      if (nextValue) {
        await stopConversationModeLoop();
      }

      const response = await clientRef.current.updateVoiceSettings(
        {
          settings: {
            micMuted: nextValue
          }
        },
        currentSession?.sessionId
      );
      applyVoiceState(response.voice);

      if (!nextValue && currentSession && response.voice.settings.voiceModeEnabled) {
        startConversationModeLoop(currentSession.sessionId, response.voice);
      }
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

  function openSidebar(tab?: Tab) {
    if (tab) {
      setSidebarTab(tab);
    }
    setIsSidebarCollapsed(false);
  }

  return (
    <div className="shell">
      <div className="shell__backdrop" />
      <header className="topbar">
        <button
          aria-expanded={!isSidebarCollapsed}
          aria-label="Abrir menu de paneles"
          className="topbar__menu"
          onClick={() => setIsSidebarCollapsed((current) => !current)}
          type="button"
        >
          <span />
          <span />
          <span />
        </button>
        <div className="topbar__brand">
          <p className="eyebrow">Asistente personal local</p>
          <h1>ASSEM</h1>
          <p className="panel-copy">
            Interfaz local de asistente
          </p>
        </div>
        <time className="topbar__clock" dateTime={clockNow.toISOString()}>
          <span>{clockLabel}</span>
          <small>{clockDateLabel}</small>
        </time>
      </header>

      <main className={`layout${isSidebarCollapsed ? '' : ' layout--drawer-open'}`}>
        <section className="chat hud-cockpit">
          <aside className="hud-left-controls" aria-label="Controles principales de voz">
            <button
              aria-pressed={voiceModeEnabled}
              className={`voice-mode-beacon voice-mode-beacon--${micMuted ? 'muted' : voiceModeEnabled ? voiceOrbState : 'off'}`}
              disabled={!currentSession || (busy && !voiceModeEnabled)}
              onClick={() => void toggleVoiceMode(!voiceModeEnabled)}
              type="button"
            >
              <span>{micMuted ? 'MIC OFF' : 'CONVERSACION'}</span>
              <strong>
                {micMuted
                  ? 'Microfono muteado'
                  : voiceModeEnabled
                    ? voiceActivityLabel(voice)
                    : 'Modo conversacion apagado'}
              </strong>
              <small>
                {micMuted
                  ? 'Corte fuerte de privacidad'
                  : voiceModeEnabled
                    ? 'Escucha turnos hasta apagarlo'
                    : 'Microfono cerrado'}
              </small>
            </button>

            <div className="voice-control-rail">
              <span className="voice-control-rail__label">Push-to-talk</span>
              <button className="primary" disabled={!canStartRecording} onClick={() => void startVoiceRecording()} type="button">
                Hablar
              </button>
              <button disabled={!canStopRecording} onClick={() => void stopVoiceRecording()} type="button">
                Detener y enviar
              </button>
              <button disabled={voiceSession?.recordingState !== 'recording' || busy} onClick={() => void cancelVoiceRecording()} type="button">
                Cancelar
              </button>
              <button disabled={!canPlayLatestReply} onClick={() => void speakLatestAssistantReply()} type="button">
                Leer ultima
              </button>
              <button disabled={voiceSession?.speakingState !== 'speaking' || busy} onClick={() => void stopAssistantSpeech()} type="button">
                Parar voz
              </button>
              <label className="voice-control-rail__toggle">
                <input
                  checked={voice?.settings.autoReadResponses ?? false}
                  disabled={busy}
                  onChange={(event) => void toggleAutoReadResponses(event.target.checked)}
                  type="checkbox"
                />
                <span>Autolectura</span>
              </label>
              <label className="voice-control-rail__toggle voice-control-rail__toggle--danger">
                <input
                  checked={micMuted}
                  disabled={busy}
                  onChange={(event) => void toggleMicMuted(event.target.checked)}
                  type="checkbox"
                />
                <span>Mute micro</span>
              </label>
            </div>
          </aside>

          <div className="hud-center">
            <AssistantCore
              state={assistantCoreState}
              voiceActivityLabel={voiceActivityLabel(voice)}
              voiceAvailabilityLabel={voiceAvailabilityLabel(voice)}
              voiceModeEnabled={voiceModeEnabled}
            />

            <div className="hud-status-strip" aria-label="Resumen de estado">
              <span>Runtime {configuredProviderLabel}</span>
              <span>{runtimeModelDisplay.label}: {runtimeModelDisplay.value}</span>
              <span>{modeLabel(uiMode)}</span>
              <span>
                Voz {voiceAvailabilityLabel(voice)} / {micMuted ? 'mic off' : voiceModeEnabled ? 'conversacion' : 'manual'}
              </span>
              {pendingActions.length > 0 ? (
                <button className="pill pill--button pill--accent" onClick={() => openSidebar('permissions')} type="button">
                  {pendingActions.length} confirmacion{pendingActions.length === 1 ? '' : 'es'}
                </button>
              ) : (
                <span>Sin confirmaciones</span>
              )}
            </div>

            <div className="hud-middle-stack">
              {error && (
                <div className="banner banner--error">
                  <strong>Error del agente local</strong>
                  <span>{error}</span>
                </div>
              )}

              <article className={`hud-task-card${activeConversationTask ? '' : ' hud-task-card--idle'}`}>
                <div>
                  <span className="summary-card__label">Tarea activa</span>
                  <strong>
                    {activeConversationTask
                      ? activeConversationTask.objective
                      : 'Sin tarea larga activa'}
                  </strong>
                </div>
                <div className="hud-task-card__meter" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, activeConversationTask?.progressPercent ?? 0))}%`
                    }}
                  />
                </div>
                <div className="hud-task-card__meta">
                  <span>{taskStatusLabel(activeConversationTask?.status)}</span>
                  <span>{taskProgressLabel(activeConversationTask)}</span>
                  <span>{activeConversationTask?.currentPhase ?? 'sin fase'}</span>
                  <span>{activeConversationTaskStep?.label ?? 'sin paso activo'}</span>
                  {activeConversationResearchSummary && (
                    <span>
                      Fuentes: {activeConversationResearchSummary.selected}/
                      {activeConversationResearchSummary.found} · leidas{' '}
                      {activeConversationResearchSummary.read} · evidencia{' '}
                      {activeConversationResearchSummary.evidence}
                    </span>
                  )}
                  {activeConversationTaskArtifacts[0] && <span>Artefacto: {activeConversationTaskArtifacts[0].label}</span>}
                  {activeConversationTaskRefinements[0] && <span>Ajuste: {activeConversationTaskRefinements[0].label}</span>}
                  {activeConversationResearchSummary?.searchError && (
                    <span>Busqueda: error</span>
                  )}
                </div>
              </article>
            </div>

            <ConversationPane
              disabled={isBusy || !currentSession}
              formatTimestamp={fmt}
              hasActiveTask={Boolean(activeConversationTask)}
              latestTranscript={voiceSession?.lastTranscript}
              messages={messages}
              onSelectPrompt={(prompt) => void sendMessage(prompt)}
              prompts={prompts}
              voiceActivityLabel={voiceActivityLabel(voice)}
            />

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void sendMessage(composeValue);
              }}
            >
              <div className="command-bar">
                <textarea
                  disabled={!currentSession || isBusy}
                  rows={1}
                  value={composeValue}
                  onChange={(event) => setComposeValue(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder='Escribe un comando para ASSEM...'
                />
                <button className="primary" disabled={!currentSession || isBusy || !composeValue.trim()} type="submit">
                  {isBusy ? '...' : 'Enviar'}
                </button>
              </div>
              <div className="composer__footer">
                <div className="hud-meta-strip">
                  <span>v{APP_VERSION}</span>
                  <span>Sesion #{sessionMetaLabel}</span>
                  <span>Perfil {activeProfile?.name ?? 'ninguno'}</span>
                  <span>{voiceSession?.lastTranscript ? `Ultimo transcript: ${voiceSession.lastTranscript}` : 'Sin transcript reciente'}</span>
                </div>
              </div>
            </form>
          </div>
        </section>

        {!isSidebarCollapsed && (
          <button
            aria-label="Cerrar menu de paneles"
            className="sidebar__scrim"
            onClick={() => setIsSidebarCollapsed(true)}
            type="button"
          />
        )}

        <aside className={`sidebar sidebar--drawer${isSidebarCollapsed ? ' sidebar--collapsed' : ' sidebar--open'}`}>
          <div className="sidebar__rail-header">
            <div>
              <span className="summary-card__label">Paneles</span>
              <strong>Menu ASSEM</strong>
            </div>
            <button
              aria-expanded={!isSidebarCollapsed}
              className="sidebar__collapse"
              onClick={() => setIsSidebarCollapsed((current) => !current)}
              title={isSidebarCollapsed ? 'Abrir panel secundario' : 'Colapsar panel secundario'}
              type="button"
            >
              {isSidebarCollapsed ? 'Abrir' : 'Cerrar'}
            </button>
          </div>
          <div className="sidebar__tabs">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                aria-label={label}
                className={sidebarTab === id ? 'is-active' : ''}
                onClick={() => setSidebarTab(id)}
                title={label}
                type="button"
              >
                <span className="sidebar__tab-mark">{label.slice(0, 1)}</span>
                <span className="sidebar__tab-label">{label}</span>
              </button>
            ))}
          </div>

          <div className="sidebar__panel">
            <SidebarSummary
              activeTask={activeConversationTask}
              activeTaskStatusLabel={taskStatusLabel(activeConversationTask?.status)}
              healthLabel={healthStatusLabel(systemState?.health.status)}
              modeLabel={modeLabel(uiMode)}
              pendingActionsCount={pendingActions.length}
              scheduledTaskCount={enabledScheduledTaskCount}
            />
            {sidebarTab === 'status' && (
              <AssistantStatusPanel
                activeTask={activeConversationTask}
                currentStepLabel={activeConversationTaskStep?.label ?? 'sin paso activo'}
                effectiveLanguage={effectiveVoiceLanguage}
                fallbackReason={providerRuntime?.fallbackReason}
                fallbackUsed={providerRuntime?.fallbackUsed}
                microphoneAccessible={voice?.microphoneAccessible ?? false}
                onOpenPermissions={() => openSidebar('permissions')}
                pendingActionsCount={pendingActions.length}
                runtimeModelLabel={runtimeModelDisplay.label}
                runtimeModelValue={runtimeModelDisplay.value}
                runtimeProviderLabel={configuredProviderLabel}
                sttLabel={providerLabel(voice?.settings.sttProviderId, 'sin provider')}
                taskProgressLabel={taskProgressLabel(activeConversationTask)}
                taskStatusLabel={taskStatusLabel(activeConversationTask?.status)}
                ttsLabel={providerLabel(voice?.settings.ttsProviderId, 'sin provider')}
                voiceActivityLabel={voiceActivityLabel(voice)}
                voiceAvailabilityLabel={voiceAvailabilityLabel(voice)}
                voiceDiagnostic={voice?.lastError ?? voiceDiagnosticSummary}
                voiceModeEnabled={voiceModeEnabled}
                voiceModeState={voiceSession?.voiceModeState}
              />
            )}
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
                  <p>
                    {runtimeModelDisplay.label}: {runtimeModelDisplay.value}
                  </p>
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
                      {activeConversationResearchSummary && (
                        <p className="small-copy">
                          Fuentes research: {activeConversationResearchSummary.selected}{' '}
                          seleccionadas de {activeConversationResearchSummary.found};{' '}
                          {activeConversationResearchSummary.read} leidas;{' '}
                          {activeConversationResearchSummary.snippetOnly} snippet-only;{' '}
                          {activeConversationResearchSummary.evidence} evidencia(s)
                          {activeConversationResearchSummary.evidenceLevel
                            ? ` - nivel: ${activeConversationResearchSummary.evidenceLevel}`
                            : ''}
                          {activeConversationResearchSummary.searchError
                            ? ` - error: ${activeConversationResearchSummary.searchError}`
                            : ''}
                        </p>
                      )}
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
                  Los controles viven en el HUD principal. Aqui ves el runtime real, el transcript y el diagnostico.
                </p>
                <article className="card card--highlight voice-overview">
                  <div className="card__meta">
                    <strong>Resumen de voz</strong>
                    <span>{voiceAvailabilityLabel(voice)}</span>
                  </div>
                  <VoiceOrb
                    activityLabel={voiceActivityLabel(voice)}
                    availabilityLabel={voiceAvailabilityLabel(voice)}
                    diagnostic={voice?.lastError ?? voiceDiagnosticSummary}
                    languageLabel={effectiveVoiceLanguage}
                    microphoneLabel={voice?.microphoneAccessible ? 'Mic listo' : 'Mic sin acceso'}
                    state={voiceOrbState}
                    sttLabel={providerLabel(voice?.settings.sttProviderId, 'sin provider')}
                    ttsLabel={providerLabel(voice?.settings.ttsProviderId, 'sin provider')}
                    wakeWord={voice?.settings.wakeWord ?? 'prolijo'}
                  />
                  <div className="voice-overview__grid">
                    <div className="subcard">
                      <strong>{providerLabel(voice?.settings.sttProviderId, 'sin provider')}</strong>
                      <p className="small-copy">STT activo</p>
                    </div>
                    <div className="subcard">
                      <strong>{providerLabel(voice?.settings.ttsProviderId, 'sin provider')}</strong>
                      <p className="small-copy">TTS activo</p>
                    </div>
                    <div className="subcard">
                      <strong>{voice?.microphoneAccessible ? 'Microfono listo' : 'Microfono sin acceso'}</strong>
                      <p className="small-copy">idioma {effectiveVoiceLanguage}</p>
                    </div>
                  </div>
                  <p className="small-copy">
                    STT legado de Windows aislado. El flujo real de desktop usa whisper.cpp y reproduce con Windows System TTS.
                  </p>
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
                    <strong>Wake word experimental</strong>
                    <span>{voiceSession?.lastWakeWindowAt ? fmt(voiceSession.lastWakeWindowAt) : 'sin ventanas'}</span>
                  </div>
                  <p className="small-copy">
                    No forma parte del flujo principal. Ultima ventana: {voiceSession?.lastWakeTranscript ?? 'sin transcript wake.'}
                  </p>
                  <p className="small-copy">
                    Audio wake: {formatVoiceAudioDiagnostics(latestWakeVoiceAudio)}
                  </p>
                  {wakeVoiceDiagnosticSummary && (
                    <p className="small-copy">Diagnostico wake: {wakeVoiceDiagnosticSummary}</p>
                  )}
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
                  {voiceDiagnosticSummary && (
                    <p className="small-copy">Resumen: {voiceDiagnosticSummary}</p>
                  )}
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
      </main>
    </div>
  );
}
