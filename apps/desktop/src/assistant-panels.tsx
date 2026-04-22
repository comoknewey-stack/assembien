import type { AssemTask, TaskPlan, TaskRefinement, TaskStep } from '@assem/shared-types';

import { Surface } from './surface';

function truncateText(value: string, maxLength = 160): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

interface TopbarStatusProps {
  healthLabel: string;
  modeLabel: string;
  profileName: string;
  sessionId?: string | null;
  pendingActionsCount: number;
  onOpenPermissions: () => void;
}

export function TopbarStatus({
  healthLabel,
  modeLabel,
  profileName,
  sessionId,
  pendingActionsCount,
  onOpenPermissions
}: TopbarStatusProps) {
  return (
    <div className="topbar__status topbar__status--compact">
      <span className="pill pill--accent">ASSEM {healthLabel}</span>
      <span className="pill">Sesion: #{(sessionId ?? 'sin sesion').slice(0, 6).toUpperCase()}</span>
      <span className="pill">{modeLabel}</span>
      <span className="pill">Perfil {profileName}</span>
      {pendingActionsCount > 0 && (
        <button className="pill pill--button" onClick={onOpenPermissions} type="button">
          {pendingActionsCount} confirmacion{pendingActionsCount === 1 ? '' : 'es'}
        </button>
      )}
    </div>
  );
}

interface SidebarSummaryProps {
  healthLabel: string;
  modeLabel: string;
  pendingActionsCount: number;
  activeTask: AssemTask | null;
  activeTaskStatusLabel: string;
  scheduledTaskCount: number;
}

export function SidebarSummary({
  healthLabel,
  modeLabel,
  pendingActionsCount,
  activeTask,
  activeTaskStatusLabel,
  scheduledTaskCount
}: SidebarSummaryProps) {
  return (
    <section className="sidebar__summary sidebar__summary--refined">
      <Surface as="article" className="summary-card summary-card--wide" glow="cyan" radius="lg" variant="soft">
        <span className="summary-card__label">ASSEM ahora</span>
        <strong>{healthLabel}</strong>
        <p>{modeLabel}</p>
        <p className="summary-card__detail">
          {activeTask
            ? `Trabajo activo: ${truncateText(activeTask.objective, 72)}`
            : 'Sin tarea larga activa en esta sesion.'}
        </p>
      </Surface>

      <Surface as="article" className="summary-card" radius="md" variant="soft">
        <span className="summary-card__label">Confirmaciones</span>
        <strong>{pendingActionsCount}</strong>
        <p>
          {pendingActionsCount > 0
            ? 'Revisa permisos pendientes'
            : 'Sin acciones bloqueadas'}
        </p>
      </Surface>

      <Surface as="article" className="summary-card" radius="md" variant="soft">
        <span className="summary-card__label">Trabajo</span>
        <strong>{activeTask ? activeTaskStatusLabel : `${scheduledTaskCount}`}</strong>
        <p>
          {activeTask
            ? 'La tarea activa vive dentro de la conversacion.'
            : `${scheduledTaskCount} tarea${scheduledTaskCount === 1 ? '' : 's'} programada${scheduledTaskCount === 1 ? '' : 's'}`}
        </p>
      </Surface>
    </section>
  );
}

interface AssistantStatusPanelProps {
  runtimeProviderLabel: string;
  runtimeModelLabel: string;
  runtimeModelValue: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  voiceAvailabilityLabel: string;
  voiceActivityLabel: string;
  microphoneAccessible: boolean;
  sttLabel: string;
  ttsLabel: string;
  effectiveLanguage: string;
  voiceModeEnabled: boolean;
  voiceModeState?: string;
  voiceDiagnostic?: string;
  activeTask: AssemTask | null;
  taskStatusLabel: string;
  taskProgressLabel: string;
  currentStepLabel: string;
  pendingActionsCount: number;
  onOpenPermissions: () => void;
}

export function AssistantStatusPanel({
  runtimeProviderLabel,
  runtimeModelLabel,
  runtimeModelValue,
  fallbackUsed,
  fallbackReason,
  voiceAvailabilityLabel,
  voiceActivityLabel,
  microphoneAccessible,
  sttLabel,
  ttsLabel,
  effectiveLanguage,
  voiceModeEnabled,
  voiceModeState,
  voiceDiagnostic,
  activeTask,
  taskStatusLabel,
  taskProgressLabel,
  currentStepLabel,
  pendingActionsCount,
  onOpenPermissions
}: AssistantStatusPanelProps) {
  const progressValue = Math.max(0, Math.min(100, activeTask?.progressPercent ?? 0));
  const voiceModeCopy = voiceModeEnabled
    ? `Conversacion ${voiceModeState ?? 'activa'}`
    : 'Conversacion off';

  return (
    <section className="stack assistant-status-panel">
      <div>
        <h2>Estado del asistente</h2>
        <p className="panel-copy">Runtime, voz y trabajo actual guardados fuera del HUD central.</p>
      </div>

      <div className="assistant-status-panel__grid">
        <Surface as="article" className="assistant-status-card" glow="cyan" radius="lg" variant="soft">
          <span className="summary-card__label">Runtime</span>
          <strong>{runtimeProviderLabel}</strong>
          <p>
            {runtimeModelLabel}: {runtimeModelValue}
          </p>
          {fallbackUsed && (
            <p className="small-copy">
              Fallback activo{fallbackReason ? ` - ${truncateText(fallbackReason, 110)}` : ''}
            </p>
          )}
        </Surface>

        <Surface as="article" className="assistant-status-card" glow="cyan" radius="lg" variant="soft">
          <span className="summary-card__label">Voz</span>
          <strong>{voiceAvailabilityLabel}</strong>
          <p>
            {voiceActivityLabel} - mic {microphoneAccessible ? 'accesible' : 'sin acceso'}
          </p>
          <p className="small-copy">
            {sttLabel} / {ttsLabel} - {effectiveLanguage} - {voiceModeCopy}
          </p>
          {voiceDiagnostic && <p className="small-copy">{truncateText(voiceDiagnostic, 140)}</p>}
        </Surface>

        <Surface as="article" className="assistant-status-card" glow="amber" radius="lg" variant="soft">
          <span className="summary-card__label">Trabajo</span>
          <strong>{activeTask ? taskStatusLabel : 'sin tarea activa'}</strong>
          <p>{activeTask ? truncateText(activeTask.objective, 120) : 'Sin ejecucion larga en curso.'}</p>
          {activeTask && (
            <>
              <div aria-hidden="true" className="assistant-status-panel__meter">
                <span style={{ width: `${progressValue}%` }} />
              </div>
              <p className="small-copy">
                {taskProgressLabel} - {activeTask.currentPhase ?? 'sin fase'} - {currentStepLabel}
              </p>
            </>
          )}
        </Surface>
      </div>

      <div className="assistant-status-panel__footer">
        {pendingActionsCount > 0 ? (
          <button className="pill pill--button" onClick={onOpenPermissions} type="button">
            {pendingActionsCount} confirmacion{pendingActionsCount === 1 ? '' : 'es'} pendiente
          </button>
        ) : (
          <span>Sin confirmaciones pendientes</span>
        )}
      </div>
    </section>
  );
}

interface AssistantSnapshotCardProps {
  runtimeProviderLabel: string;
  runtimeModelLabel: string;
  runtimeModelValue: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  voiceLabel: string;
  voiceActivity: string;
  microphoneAccessible: boolean;
  autoReadResponses: boolean;
  pendingActionsCount: number;
  onOpenPermissions: () => void;
}

export function AssistantSnapshotCard({
  runtimeProviderLabel,
  runtimeModelLabel,
  runtimeModelValue,
  fallbackUsed,
  fallbackReason,
  voiceLabel,
  voiceActivity,
  microphoneAccessible,
  autoReadResponses,
  pendingActionsCount,
  onOpenPermissions
}: AssistantSnapshotCardProps) {
  return (
    <article className="assistant-brief">
      <div className="assistant-brief__grid">
        <section className="assistant-brief__item">
          <span className="summary-card__label">Runtime</span>
          <strong>{runtimeProviderLabel}</strong>
          <p>
            {runtimeModelLabel}: {runtimeModelValue}
          </p>
          {fallbackUsed && (
            <p className="small-copy">
              Fallback activo{fallbackReason ? ` - ${truncateText(fallbackReason, 88)}` : ''}
            </p>
          )}
        </section>

        <section className="assistant-brief__item">
          <span className="summary-card__label">Voz</span>
          <strong>{voiceLabel}</strong>
          <p>{voiceActivity}</p>
          <p className="small-copy">
            Microfono {microphoneAccessible ? 'accesible' : 'sin acceso'} - Autolectura{' '}
            {autoReadResponses ? 'activa' : 'manual'}
          </p>
        </section>

        <section className="assistant-brief__item">
          <span className="summary-card__label">Flujo</span>
          <strong>
            {pendingActionsCount > 0
              ? `${pendingActionsCount} pendiente${pendingActionsCount === 1 ? '' : 's'}`
              : 'Sin bloqueos'}
          </strong>
          <p>
            {pendingActionsCount > 0
              ? 'ASSEM espera tu confirmacion antes de seguir.'
              : 'Conversacion lista para texto, voz y tareas.'}
          </p>
          {pendingActionsCount > 0 && (
            <button className="assistant-brief__action" onClick={onOpenPermissions} type="button">
              Revisar confirmaciones
            </button>
          )}
        </section>
      </div>
    </article>
  );
}

interface TaskSpotlightCardProps {
  task: AssemTask | null;
  taskStatusLabel: string;
  taskProgressLabel: string;
  currentStep: TaskStep | null;
  artifacts: AssemTask['artifacts'];
  refinements: TaskRefinement[];
  plan: TaskPlan | null;
  pendingPlanSteps: string[];
}

export function TaskSpotlightCard({
  task,
  taskStatusLabel,
  taskProgressLabel,
  currentStep,
  artifacts,
  refinements,
  plan,
  pendingPlanSteps
}: TaskSpotlightCardProps) {
  if (!task) {
    return (
      <Surface
        as="article"
        className="task-spotlight task-spotlight--empty"
        glow="cyan"
        radius="lg"
        variant="soft"
      >
        <div className="task-spotlight__header">
          <div className="stack stack--tight">
            <p className="eyebrow">Trabajo preparado</p>
            <h3>ASSEM esta listo para una tarea larga</h3>
          </div>
          <span className="tag tag--info">sin tarea activa</span>
        </div>
        <p className="small-copy">
          Pide una revision, informe o accion local desde el chat. Cuando exista una tarea real,
          este panel mostrara su plan, progreso y artefactos sin inventar estado.
        </p>
      </Surface>
    );
  }

  const progressValue = Math.max(0, Math.min(100, task.progressPercent ?? 0));

  return (
    <Surface as="article" className="task-spotlight" glow="amber" radius="lg" variant="active">
      <div className="task-spotlight__header">
        <div className="stack stack--tight">
          <p className="eyebrow">ASSEM esta trabajando</p>
          <h3>{task.objective}</h3>
        </div>
        <span className="tag tag--info">{taskStatusLabel}</span>
      </div>

      <div aria-hidden="true" className="task-spotlight__meter" role="presentation">
        <span className="task-spotlight__meter-fill" style={{ width: `${progressValue}%` }} />
      </div>

      <div className="task-spotlight__grid">
        <div className="subcard">
          <strong>{taskProgressLabel}</strong>
          <p className="small-copy">progreso real de la tarea</p>
        </div>
        <div className="subcard">
          <strong>{task.currentPhase ?? 'Sin fase definida'}</strong>
          <p className="small-copy">fase actual</p>
        </div>
        <div className="subcard">
          <strong>{currentStep?.label ?? 'Sin paso activo'}</strong>
          <p className="small-copy">paso actual</p>
        </div>
      </div>

      <div className="task-spotlight__details">
        <section className="subcard task-spotlight__panel">
          <strong>Siguiente recorrido</strong>
          {plan ? (
            <>
              <p className="small-copy">{plan.summary}</p>
              <ul className="detail-list">
                {(pendingPlanSteps.length > 0
                  ? pendingPlanSteps.slice(0, 3)
                  : ['No quedan pasos pendientes en el plan.']
                ).map((stepLabel, index) => (
                  <li key={`${stepLabel}-${index}`}>{stepLabel}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="small-copy">No hay un plan visible para esta tarea.</p>
          )}
        </section>

        <section className="subcard task-spotlight__panel">
          <strong>Artefactos recientes</strong>
          {artifacts.length > 0 ? (
            <ul className="detail-list">
              {artifacts.slice(-3).map((artifact) => (
                <li key={artifact.id}>
                  {artifact.label}
                  {artifact.filePath ? ` - ${truncateText(artifact.filePath, 72)}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small-copy">Todavia no hay artefactos generados.</p>
          )}
        </section>

        <section className="subcard task-spotlight__panel">
          <strong>Ajustes activos</strong>
          {refinements.length > 0 ? (
            <ul className="detail-list">
              {refinements.slice(-3).map((refinement) => (
                <li key={refinement.id}>{refinement.label}</li>
              ))}
            </ul>
          ) : (
            <p className="small-copy">Sin refinamientos activos sobre este trabajo.</p>
          )}
        </section>
      </div>

      <p className="small-copy task-spotlight__commands">
        Control conversacional disponible: di "pausa", "reanuda" o "cancela" para actuar
        sobre esta tarea sin salir del chat.
      </p>
    </Surface>
  );
}

export interface QuickActionItem {
  prompt: string;
  label: string;
  eyebrow: string;
  description: string;
}

export function createQuickActionItems(
  prompts: string[],
  hasActiveTask: boolean
): QuickActionItem[] {
  return prompts.map((prompt) => {
    const normalized = prompt.toLowerCase();
    const context = hasActiveTask ? 'Disponible mientras la tarea sigue su curso.' : 'Accion segura desde el chat.';

    if (normalized.includes('hora')) {
      return {
        prompt,
        eyebrow: 'Tiempo',
        label: 'Hora local',
        description: context
      };
    }

    if (normalized.includes('calendario')) {
      return {
        prompt,
        eyebrow: 'Agenda',
        label: 'Calendario de hoy',
        description: context
      };
    }

    if (normalized.includes('sandbox') || normalized.includes('archivo')) {
      return {
        prompt,
        eyebrow: 'Local',
        label: normalized.includes('crea') ? 'Accion local' : 'Explorar sandbox',
        description: context
      };
    }

    return {
      prompt,
      eyebrow: hasActiveTask ? 'Control' : 'Sugerencia',
      label: truncateText(prompt, 34),
      description: context
    };
  });
}

interface QuickActionsPanelProps {
  actions: QuickActionItem[];
  disabled: boolean;
  hasActiveTask: boolean;
  onSelectPrompt: (prompt: string) => void;
}

export function QuickActionsPanel({
  actions,
  disabled,
  hasActiveTask,
  onSelectPrompt
}: QuickActionsPanelProps) {
  return (
    <Surface className="starter-card" glow="cyan" radius="lg" variant="soft">
      <div className="stack stack--tight">
        <p className="eyebrow">{hasActiveTask ? 'Consulta rapida' : 'Primer paso'}</p>
        <h3>{hasActiveTask ? 'Sigue hablando mientras ASSEM trabaja' : 'Empieza con algo breve'}</h3>
        <p>
          {hasActiveTask
            ? 'Puedes consultar el estado, pedir la hora o lanzar una accion segura sin salir de la conversacion.'
            : 'Pregunta por la hora, lista el sandbox o pide una accion local segura.'}
        </p>
      </div>
      <div className="prompt-grid prompt-grid--compact">
        {actions.map((action) => (
          <button
            key={action.prompt}
            disabled={disabled}
            onClick={() => onSelectPrompt(action.prompt)}
            type="button"
          >
            <span>{action.eyebrow}</span>
            <strong>{action.label}</strong>
            <small>{action.description}</small>
          </button>
        ))}
      </div>
    </Surface>
  );
}

interface VoiceComposerDockProps {
  availabilityLabel: string;
  activityLabel: string;
  sttLabel: string;
  ttsLabel: string;
  effectiveLanguage: string;
  microphoneAccessible: boolean;
  autoReadResponses: boolean;
  voiceModeEnabled: boolean;
  voiceModeState?: string;
  wakeWord: string;
  latestTranscript?: string;
  latestAssistantMessage?: string;
  latestDiagnosticSummary?: string;
  latestDiagnosticDetail?: string;
  latestWakeDiagnosticSummary?: string;
  busy: boolean;
  recordingState?: string;
  speakingState?: string;
  canStartRecording: boolean;
  canStopRecording: boolean;
  canPlayLatestReply: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onSpeakLatestReply: () => void;
  onStopSpeaking: () => void;
  onToggleVoiceMode: (nextValue: boolean) => void;
  onToggleAutoReadResponses: (nextValue: boolean) => void;
}

export function VoiceComposerDock({
  availabilityLabel,
  activityLabel,
  sttLabel,
  ttsLabel,
  effectiveLanguage,
  microphoneAccessible,
  autoReadResponses,
  voiceModeEnabled,
  voiceModeState,
  wakeWord,
  latestTranscript,
  latestAssistantMessage,
  latestDiagnosticSummary,
  latestDiagnosticDetail,
  latestWakeDiagnosticSummary,
  busy,
  recordingState,
  speakingState,
  canStartRecording,
  canStopRecording,
  canPlayLatestReply,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onSpeakLatestReply,
  onStopSpeaking,
  onToggleVoiceMode,
  onToggleAutoReadResponses
}: VoiceComposerDockProps) {
  const hint = latestDiagnosticSummary
    ? `${latestDiagnosticSummary}${latestDiagnosticDetail ? ` - ${latestDiagnosticDetail}` : ''}`
    : latestTranscript
      ? `Ultimo transcript: "${truncateText(latestTranscript, 140)}"`
      : latestAssistantMessage
        ? `Ultima respuesta lista para leer: "${truncateText(latestAssistantMessage, 140)}"`
        : 'Habla o escribe; la voz usa la misma conversacion actual.';

  return (
    <Surface className="voice-dock" glow="cyan" radius="lg" variant="soft">
      <div className="voice-dock__row">
        <div className="voice-dock__status">
          <span className="pill pill--accent">Voz {availabilityLabel}</span>
          <span className="pill">{activityLabel}</span>
          <span className={voiceModeEnabled ? 'pill pill--accent' : 'pill'}>
            Modo voz {voiceModeEnabled ? 'activo' : 'apagado'}
          </span>
          <span className="pill">Mic {microphoneAccessible ? 'accesible' : 'sin acceso'}</span>
          <span className="pill">Idioma {effectiveLanguage}</span>
        </div>

        <div className="voice-dock__toggles">
          <label className="voice-toggle voice-toggle--mode">
            <input
              checked={voiceModeEnabled}
              disabled={busy && !voiceModeEnabled}
              onChange={(event) => onToggleVoiceMode(event.target.checked)}
              type="checkbox"
            />
            <span>Modo voz</span>
          </label>
          <label className="voice-toggle">
            <input
              checked={autoReadResponses}
              disabled={busy}
              onChange={(event) => onToggleAutoReadResponses(event.target.checked)}
              type="checkbox"
            />
            <span>Autolectura</span>
          </label>
        </div>
      </div>

      <div className="voice-dock__controls">
        <button className="primary" disabled={!canStartRecording} onClick={onStartRecording} type="button">
          Hablar
        </button>
        <button disabled={!canStopRecording} onClick={onStopRecording} type="button">
          Detener y enviar
        </button>
        <button disabled={recordingState !== 'recording' || busy} onClick={onCancelRecording} type="button">
          Cancelar
        </button>
        <button disabled={!canPlayLatestReply} onClick={onSpeakLatestReply} type="button">
          Leer ultima
        </button>
        <button disabled={speakingState !== 'speaking' || busy} onClick={onStopSpeaking} type="button">
          Parar voz
        </button>
      </div>

      <div className="voice-dock__details">
        <span>STT {sttLabel}</span>
        <span>TTS {ttsLabel}</span>
        <span>
          {voiceModeEnabled
            ? `Modo conversacion${voiceModeState ? ` - ${voiceModeState}` : ''}`
            : 'Conversacion apagada; push-to-talk manual disponible'}
        </span>
        {latestWakeDiagnosticSummary && (
          <span>Wake: {truncateText(latestWakeDiagnosticSummary, 72)}</span>
        )}
        <span>Chat y voz sincronizados</span>
      </div>

      <p className="voice-dock__hint">{hint}</p>
    </Surface>
  );
}
