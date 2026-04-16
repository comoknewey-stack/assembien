import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  AssemTask,
  ChatMessage,
  MemoryBackend,
  ModelRequest,
  ModelResponse,
  ModelRouter,
  ProviderCapability,
  SessionState,
  SessionStore,
  TaskArtifact,
  TaskArtifactInput,
  TaskCreateInput,
  TaskExecutionContext,
  TaskExecutionRequest,
  TaskExecutionResult,
  TaskInterruptState,
  TaskManager,
  TaskPhaseAdvanceInput,
  TaskProgressUpdateInput,
  TaskRefinement,
  TaskRunner,
  TaskRuntime,
  TaskRuntimeEvent,
  TaskStepCompletionInput,
  TaskStep,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry
} from '@assem/shared-types';

interface TaskRuntimeDeps {
  taskManager: TaskManager;
  sessionStore: SessionStore;
  memoryBackend: MemoryBackend;
  toolRegistry: ToolRegistry;
  modelRouter: ModelRouter;
  sandboxRoot: string;
  dataRoot: string;
}

interface TaskRuntimeOptions {
  onEvent?: (event: TaskRuntimeEvent) => Promise<void> | void;
}

interface ExecutionHandle {
  taskId: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  pauseBarrier: Promise<void> | null;
  releasePauseBarrier: (() => void) | null;
  promise: Promise<void>;
}

interface RuntimeModelInvocationMetadata {
  providerId: string;
  model: string;
  configuredModel?: string;
  resolvedModel?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  timestamp: string;
}

interface ResearchReportMetadata {
  taskType: 'research_report_basic';
  workspaceRelativePath: string;
  reportRelativePath: string;
  summaryRelativePath: string;
  reportLanguage: 'es' | 'en';
  generatedReportMarkdown?: string;
  generatedSummaryText?: string;
  runtimeModelInvocation?: RuntimeModelInvocationMetadata;
  interruptState?: TaskInterruptState;
}

const RESEARCH_REPORT_STEPS: Array<{ id: string; label: string }> = [
  {
    id: 'prepare-workspace',
    label: 'Preparar carpeta de trabajo'
  },
  {
    id: 'draft-report',
    label: 'Generar borrador del informe'
  },
  {
    id: 'write-report',
    label: 'Guardar informe principal'
  },
  {
    id: 'write-summary',
    label: 'Guardar resumen ejecutivo'
  }
];

class TaskCancelledError extends Error {
  constructor(message = 'Task execution cancelled.') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
}

function isTerminalTaskStatus(task: AssemTask): boolean {
  return ['completed', 'failed', 'cancelled'].includes(task.status);
}

function buildProgressPercent(completedSteps: number, totalSteps: number): number {
  if (totalSteps <= 0) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(100, Math.round((completedSteps / totalSteps) * 100))
  );
}

function summarizeArtifacts(artifacts: TaskArtifact[]): string {
  if (artifacts.length === 0) {
    return 'sin artefactos adjuntos';
  }

  return artifacts.map((artifact) => artifact.label).join(', ');
}

function selectPlannedNextStep(task: AssemTask): TaskStep | null {
  if (!task.plan) {
    return null;
  }

  for (const plannedStep of task.plan.steps) {
    const taskStep = task.steps.find((candidate) => candidate.id === plannedStep.id);
    if (
      taskStep &&
      taskStep.status !== 'completed' &&
      taskStep.status !== 'cancelled'
    ) {
      return taskStep;
    }
  }

  return null;
}

function detectObjectiveLanguage(objective: string): 'es' | 'en' {
  return /\b(report|summary|draft|research|notes|brief)\b/i.test(objective)
    ? 'en'
    : 'es';
}

function slugifyObjective(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return normalized || 'task';
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-secret]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [redacted]');
}

function resolveSandboxPath(sandboxRoot: string, relativePath: string): string {
  const normalizedRoot = path.resolve(sandboxRoot);
  const candidate = path.resolve(normalizedRoot, relativePath);
  const rootLower = normalizedRoot.toLowerCase();
  const candidateLower = candidate.toLowerCase();
  const rootWithSeparator = rootLower.endsWith(path.sep.toLowerCase())
    ? rootLower
    : `${rootLower}${path.sep.toLowerCase()}`;

  if (candidateLower !== rootLower && !candidateLower.startsWith(rootWithSeparator)) {
    throw new Error('La ruta del runtime queda fuera del sandbox configurado.');
  }

  return candidate;
}

function resolveResearchReportMetadata(task: AssemTask): ResearchReportMetadata {
  const metadata = task.metadata ?? {};

  if (metadata.taskType !== 'research_report_basic') {
    throw new Error(`Unsupported task type for runtime task ${task.id}.`);
  }

  if (
    typeof metadata.workspaceRelativePath !== 'string' ||
    typeof metadata.reportRelativePath !== 'string' ||
    typeof metadata.summaryRelativePath !== 'string' ||
    (metadata.reportLanguage !== 'es' && metadata.reportLanguage !== 'en')
  ) {
    throw new Error(`The runtime metadata for task ${task.id} is incomplete.`);
  }

  return metadata as unknown as ResearchReportMetadata;
}

function resolveInterruptState(
  metadata: ResearchReportMetadata
): TaskInterruptState {
  return metadata.interruptState ?? {
    refinements: []
  };
}

function findLatestRefinement(
  metadata: ResearchReportMetadata,
  type: TaskRefinement['type']
): TaskRefinement | null {
  const refinements = resolveInterruptState(metadata).refinements.filter(
    (refinement) => refinement.type === type
  );

  return refinements.at(-1) ?? null;
}

function resolveEffectiveReportLanguage(
  metadata: ResearchReportMetadata
): 'es' | 'en' {
  const languageRefinement = findLatestRefinement(metadata, 'language');
  if (languageRefinement?.value === 'en' || languageRefinement?.value === 'es') {
    return languageRefinement.value;
  }

  return metadata.reportLanguage;
}

function shouldPreferShorterOutput(metadata: ResearchReportMetadata): boolean {
  return findLatestRefinement(metadata, 'length')?.value === 'shorter';
}

function shouldPrioritizeSummary(metadata: ResearchReportMetadata): boolean {
  return findLatestRefinement(metadata, 'summary_priority')?.value === 'first';
}

function shouldIncludeTable(metadata: ResearchReportMetadata): boolean {
  return findLatestRefinement(metadata, 'format')?.value === 'table';
}

function resolveFocusAdjustment(metadata: ResearchReportMetadata): string | null {
  return findLatestRefinement(metadata, 'focus')?.value ?? null;
}

function buildResearchSystemPrompt(language: 'es' | 'en'): string {
  if (language === 'en') {
    return 'You are ASSEM preparing a local-first working report. Use only the given objective and general reasoning. Do not claim internet access, browsing, citations or verified external facts. Make uncertainty explicit.';
  }

  return 'Eres ASSEM redactando un informe de trabajo local-first. Usa solo el objetivo dado y razonamiento general. No afirmes navegacion web, citas ni hechos externos verificados. Explicita cualquier incertidumbre.';
}

function buildResearchUserPrompt(
  objective: string,
  language: 'es' | 'en',
  metadata: ResearchReportMetadata
): string {
  const promptAdditions: string[] = [];
  const focusAdjustment = resolveFocusAdjustment(metadata);

  if (shouldPreferShorterOutput(metadata)) {
    promptAdditions.push(
      language === 'en'
        ? 'Keep the report shorter than usual and avoid unnecessary filler.'
        : 'Haz el informe mas corto de lo habitual y evita relleno innecesario.'
    );
  }

  if (shouldIncludeTable(metadata)) {
    promptAdditions.push(
      language === 'en'
        ? 'Include one compact markdown table if it helps summarize the work.'
        : 'Incluye una tabla breve en markdown si ayuda a resumir el trabajo.'
    );
  }

  if (focusAdjustment) {
    promptAdditions.push(
      language === 'en'
        ? `Focus the report on: ${focusAdjustment}.`
        : `Cambia el enfoque del informe hacia: ${focusAdjustment}.`
    );
  }

  if (language === 'en') {
    return `Objective: ${objective}\n\nWrite a concise markdown report with these sections:\n- Objective\n- Initial findings\n- Risks or limits\n- Next actions\n\nKeep it practical and local-first.${promptAdditions.length > 0 ? `\n\nAdditional instructions:\n- ${promptAdditions.join('\n- ')}` : ''}`;
  }

  return `Objetivo: ${objective}\n\nRedacta un informe breve en markdown con estas secciones:\n- Objetivo\n- Hallazgos iniciales\n- Riesgos o limites\n- Proximos pasos\n\nMantenlo practico y alineado con un flujo local-first.${promptAdditions.length > 0 ? `\n\nInstrucciones adicionales:\n- ${promptAdditions.join('\n- ')}` : ''}`;
}

function normalizeReportMarkdown(
  rawText: string,
  objective: string,
  language: 'es' | 'en'
): string {
  const trimmed = rawText.trim();
  if (trimmed) {
    return trimmed;
  }

  if (language === 'en') {
    return `# Working Report\n\n## Objective\n${objective}\n\n## Initial findings\nA first draft could not be generated by the model, so this placeholder keeps the task output coherent.\n\n## Risks or limits\nThe current report is incomplete.\n\n## Next actions\n- Retry the generation step.\n- Review the objective.\n- Expand the report manually if needed.\n`;
  }

  return `# Informe de trabajo\n\n## Objetivo\n${objective}\n\n## Hallazgos iniciales\nNo se pudo generar un borrador completo con el modelo, asi que este texto base mantiene la salida coherente.\n\n## Riesgos o limites\nEl informe actual esta incompleto.\n\n## Proximos pasos\n- Reintentar la generacion.\n- Revisar el objetivo.\n- Ampliar el informe manualmente si hace falta.\n`;
}

function buildSummaryText(
  objective: string,
  markdown: string,
  language: 'es' | 'en'
): string {
  const contentLines = markdown
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, 4);

  if (contentLines.length === 0) {
    if (language === 'en') {
      return `Objective: ${objective}\nSummary: No condensed summary could be extracted from the draft report.`;
    }

    return `Objetivo: ${objective}\nResumen: No se pudo extraer un resumen breve del borrador.`;
  }

  if (language === 'en') {
    return `Objective: ${objective}\nSummary:\n- ${contentLines.join('\n- ')}\n`;
  }

  return `Objetivo: ${objective}\nResumen:\n- ${contentLines.join('\n- ')}\n`;
}

export class ResearchReportBasicTaskRunner implements TaskRunner {
  readonly taskType = 'research_report_basic' as const;

  createTaskInput(
    request: TaskExecutionRequest
  ): Omit<TaskCreateInput, 'sessionId' | 'objective'> {
    const slug = slugifyObjective(request.objective);
    const suffix = crypto.randomUUID().slice(0, 8);
    const workspaceRelativePath = path.posix.join(
      'task-runtime',
      `research-${slug}-${suffix}`
    );
    const reportRelativePath = path.posix.join(workspaceRelativePath, 'report.md');
    const summaryRelativePath = path.posix.join(workspaceRelativePath, 'summary.txt');
    const reportLanguage = detectObjectiveLanguage(request.objective);

    return {
      status: 'pending',
      progressPercent: 0,
      currentPhase:
        request.plan?.phases[0]?.label ??
        (reportLanguage === 'en' ? 'Pending execution' : 'Pendiente de ejecucion'),
      steps:
        request.plan?.steps.map((step) => ({
          id: step.id,
          label: step.label
        })) ??
        RESEARCH_REPORT_STEPS.map((step) => ({
          id: step.id,
          label: step.label
        })),
      currentStepId:
        request.plan?.steps[0]?.id ?? RESEARCH_REPORT_STEPS[0]?.id,
      plan: request.plan,
      metadata: {
        ...(request.metadata ?? {}),
        taskType: this.taskType,
        workspaceRelativePath,
        reportRelativePath,
        summaryRelativePath,
        reportLanguage,
        interruptState: {
          refinements: request.plan?.refinements ?? []
        }
      } satisfies ResearchReportMetadata
    };
  }

  selectNextStep(task: AssemTask): TaskStep | null {
    const metadata = resolveResearchReportMetadata(task);
    const pendingSteps = task.steps.filter(
      (step) => !['completed', 'cancelled'].includes(step.status)
    );

    if (pendingSteps.length === 0) {
      return null;
    }

    if (shouldPrioritizeSummary(metadata)) {
      const draftCompleted = task.steps.some(
        (step) => step.id === 'draft-report' && step.status === 'completed'
      );
      const pendingSummary = pendingSteps.find((step) => step.id === 'write-summary');
      const pendingReport = pendingSteps.find((step) => step.id === 'write-report');

      if (draftCompleted && pendingSummary && pendingReport) {
        return pendingSummary;
      }
    }

    return pendingSteps[0] ?? null;
  }

  async executeStep(step: TaskStep, context: TaskExecutionContext): Promise<void> {
    await context.waitIfPaused();
    await context.ensureNotCancelled();

    const task = await context.getTask();
    const metadata = resolveResearchReportMetadata(task);
    const effectiveLanguage = resolveEffectiveReportLanguage(metadata);

    if (step.id === 'prepare-workspace') {
      const absoluteWorkspacePath = resolveSandboxPath(
        context.sandboxRoot,
        metadata.workspaceRelativePath
      );
      await fs.mkdir(absoluteWorkspacePath, { recursive: true });
      await context.ensureArtifact({
        kind: 'directory',
        label: 'Carpeta de trabajo',
        filePath: absoluteWorkspacePath,
        description:
          metadata.reportLanguage === 'en'
            ? 'Workspace folder for the research report task.'
            : 'Carpeta de trabajo para la tarea de informe.'
      });
      return;
    }

    if (step.id === 'draft-report') {
      const response = await context.invokeModel(
        [
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: buildResearchSystemPrompt(effectiveLanguage),
            createdAt: new Date().toISOString()
          },
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: buildResearchUserPrompt(
              task.objective,
              effectiveLanguage,
              metadata
            ),
            createdAt: new Date().toISOString()
          }
        ],
        ['chat']
      );

      const reportMarkdown = normalizeReportMarkdown(
        response.text,
        task.objective,
        effectiveLanguage
      );
      await context.mergeMetadata({
        generatedReportMarkdown: reportMarkdown,
        runtimeModelInvocation: {
          providerId: response.providerId,
          model: response.model,
          configuredModel: response.configuredModel,
          resolvedModel: response.resolvedModel ?? response.model,
          fallbackUsed: response.fallbackUsed,
          fallbackReason: response.fallbackReason ?? response.usage?.fallbackReason,
          timestamp: new Date().toISOString()
        } satisfies RuntimeModelInvocationMetadata
      });
      return;
    }

    if (step.id === 'write-report') {
      const latestTask = await context.getTask();
      const latestMetadata = resolveResearchReportMetadata(latestTask);
      const reportMarkdown = latestMetadata.generatedReportMarkdown;

      if (!reportMarkdown?.trim()) {
        throw new Error('No hay un borrador de informe disponible para guardar.');
      }

      const absoluteReportPath = resolveSandboxPath(
        context.sandboxRoot,
        latestMetadata.reportRelativePath
      );
      await fs.mkdir(path.dirname(absoluteReportPath), { recursive: true });
      await fs.writeFile(absoluteReportPath, reportMarkdown, 'utf8');
      await context.ensureArtifact({
        kind: 'report',
        label: 'Informe principal',
        filePath: absoluteReportPath,
        contentType: 'text/markdown',
        description:
          latestMetadata.reportLanguage === 'en'
            ? 'Main markdown report generated by ASSEM.'
            : 'Informe principal en markdown generado por ASSEM.'
      });
      return;
    }

    if (step.id === 'write-summary') {
      const latestTask = await context.getTask();
      const latestMetadata = resolveResearchReportMetadata(latestTask);
      const reportMarkdown = latestMetadata.generatedReportMarkdown;

      if (!reportMarkdown?.trim()) {
        throw new Error('No hay contenido base para generar el resumen ejecutivo.');
      }

      const summaryText = buildSummaryText(
        latestTask.objective,
        reportMarkdown,
        resolveEffectiveReportLanguage(latestMetadata)
      );
      const absoluteSummaryPath = resolveSandboxPath(
        context.sandboxRoot,
        latestMetadata.summaryRelativePath
      );

      await fs.mkdir(path.dirname(absoluteSummaryPath), { recursive: true });
      await fs.writeFile(absoluteSummaryPath, summaryText, 'utf8');
      await context.mergeMetadata({
        generatedSummaryText: summaryText
      });
      await context.ensureArtifact({
        kind: 'document',
        label: 'Resumen ejecutivo',
        filePath: absoluteSummaryPath,
        contentType: 'text/plain',
        description:
          latestMetadata.reportLanguage === 'en'
            ? 'Short execution summary for the generated report.'
            : 'Resumen ejecutivo breve del informe generado.'
      });
      return;
    }

    throw new Error(`Unknown research report step: ${step.id}`);
  }

  async buildExecutionResult(task: AssemTask): Promise<TaskExecutionResult> {
    const metadata = resolveResearchReportMetadata(task);
    const effectiveLanguage = resolveEffectiveReportLanguage(metadata);
    const summary =
      effectiveLanguage === 'en'
        ? `Task "${task.objective}" completed. Artifacts: ${summarizeArtifacts(task.artifacts)}.`
        : `La tarea "${task.objective}" se ha completado. Artefactos: ${summarizeArtifacts(task.artifacts)}.`;

    return {
      taskId: task.id,
      taskType: this.taskType,
      status:
        task.status === 'failed' || task.status === 'cancelled'
          ? task.status
          : 'completed',
      summary,
      artifacts: task.artifacts,
      completedAt: task.completedAt ?? new Date().toISOString()
    };
  }
}

export class TaskRuntimeExecutor implements TaskRuntime {
  private readonly runners = new Map<string, TaskRunner>();
  private readonly executions = new Map<string, ExecutionHandle>();

  constructor(
    private readonly deps: TaskRuntimeDeps,
    private readonly options: TaskRuntimeOptions = {}
  ) {
    this.registerRunner(new ResearchReportBasicTaskRunner());
  }

  registerRunner(runner: TaskRunner): void {
    this.runners.set(runner.taskType, runner);
  }

  async createTask(request: TaskExecutionRequest): Promise<AssemTask> {
    const runner = this.requireRunner(request.taskType);
    const previousActiveTask = await this.deps.taskManager.getActiveTaskForSession(
      request.sessionId
    );

    if (previousActiveTask) {
      this.requestPauseExecution(previousActiveTask.id);
    }

    const blueprint = runner.createTaskInput(request);
    const task = await this.deps.taskManager.createTask({
      sessionId: request.sessionId,
      objective: request.objective,
      ...blueprint
    });

    if (request.autoStart !== false) {
      return this.spawnExecution(task.id, true);
    }

    return task;
  }

  async startTask(taskId: string): Promise<AssemTask> {
    return this.spawnExecution(taskId, true);
  }

  async pauseTask(taskId: string, reason?: string): Promise<AssemTask> {
    this.requestPauseExecution(taskId);

    const task = requireValue(
      await this.deps.taskManager.getTask(taskId),
      `Unknown task: ${taskId}`
    );

    if (!isTerminalTaskStatus(task) && task.status !== 'paused') {
      await this.deps.taskManager.pauseTask(taskId, reason);
      await this.emitEvent({
        type: 'task_execution_paused',
        task: requireValue(
          await this.deps.taskManager.getTask(taskId),
          `Unknown task: ${taskId}`
        ),
        timestamp: new Date().toISOString(),
        detail: reason
      });
    }

    return requireValue(
      await this.deps.taskManager.getTask(taskId),
      `Unknown task: ${taskId}`
    );
  }

  async resumeTask(taskId: string): Promise<AssemTask> {
    const currentTask = requireValue(
      await this.deps.taskManager.getTask(taskId),
      `Unknown task: ${taskId}`
    );

    if (isTerminalTaskStatus(currentTask)) {
      throw new Error('Cannot resume a completed, failed or cancelled task.');
    }

    if (this.executions.has(taskId)) {
      const handle = requireValue(this.executions.get(taskId), `Unknown task: ${taskId}`);
      handle.pauseRequested = false;

      if (currentTask.status !== 'active') {
        await this.deps.taskManager.resumeTask(taskId);
      }

      if (handle.releasePauseBarrier) {
        handle.releasePauseBarrier();
        handle.releasePauseBarrier = null;
        handle.pauseBarrier = null;
      }

      await this.emitEvent({
        type: 'task_execution_resumed',
        task: requireValue(
          await this.deps.taskManager.getTask(taskId),
          `Unknown task: ${taskId}`
        ),
        timestamp: new Date().toISOString()
      });

      return requireValue(
        await this.deps.taskManager.getTask(taskId),
        `Unknown task: ${taskId}`
      );
    }

    await this.deps.taskManager.resumeTask(taskId);
    await this.emitEvent({
      type: 'task_execution_resumed',
      task: requireValue(
        await this.deps.taskManager.getTask(taskId),
        `Unknown task: ${taskId}`
      ),
      timestamp: new Date().toISOString()
    });

    return this.spawnExecution(taskId, false);
  }

  async cancelTask(taskId: string, reason?: string): Promise<AssemTask> {
    const handle = this.executions.get(taskId);
    if (handle) {
      handle.cancelRequested = true;
      handle.pauseRequested = false;
      if (handle.releasePauseBarrier) {
        handle.releasePauseBarrier();
        handle.releasePauseBarrier = null;
        handle.pauseBarrier = null;
      }
    }

    const currentTask = requireValue(
      await this.deps.taskManager.getTask(taskId),
      `Unknown task: ${taskId}`
    );

    if (!isTerminalTaskStatus(currentTask) && currentTask.status !== 'cancelled') {
      await this.deps.taskManager.cancelTask(taskId, reason);
      await this.emitEvent({
        type: 'task_execution_cancelled',
        task: requireValue(
          await this.deps.taskManager.getTask(taskId),
          `Unknown task: ${taskId}`
        ),
        timestamp: new Date().toISOString(),
        detail: reason
      });
    }

    return requireValue(
      await this.deps.taskManager.getTask(taskId),
      `Unknown task: ${taskId}`
    );
  }

  async recoverTasksOnStartup(): Promise<void> {
    const persistedTasks = await this.deps.taskManager.listTasks();

    for (const task of persistedTasks) {
      if (task.status !== 'active') {
        continue;
      }

      const pausedTask = await this.deps.taskManager.pauseTask(
        task.id,
        'ASSEM se ha reiniciado. Reanuda la tarea para continuar desde el ultimo paso seguro.'
      );
      await this.emitEvent({
        type: 'task_execution_paused',
        task: pausedTask,
        timestamp: new Date().toISOString(),
        detail:
          'La tarea ha quedado en pausa tras reiniciar ASSEM. Se puede reanudar desde el ultimo paso seguro.'
      });
    }
  }

  private async spawnExecution(
    taskId: string,
    emitStartedEvent: boolean
  ): Promise<AssemTask> {
    const task = requireValue(
      await this.deps.taskManager.getTask(taskId),
      `Unknown task: ${taskId}`
    );

    if (isTerminalTaskStatus(task)) {
      throw new Error('Cannot execute a completed, failed or cancelled task.');
    }

    this.requireRunnerFromTask(task);

    if (task.status !== 'active') {
      await this.deps.taskManager.resumeTask(taskId);
    }

    if (this.executions.has(taskId)) {
      return requireValue(
        await this.deps.taskManager.getTask(taskId),
        `Unknown task: ${taskId}`
      );
    }

    const handle: ExecutionHandle = {
      taskId,
      pauseRequested: false,
      cancelRequested: false,
      pauseBarrier: null,
      releasePauseBarrier: null,
      promise: Promise.resolve()
    };
    this.executions.set(taskId, handle);

    if (emitStartedEvent) {
      await this.emitEvent({
        type: 'task_execution_started',
        task: requireValue(
          await this.deps.taskManager.getTask(taskId),
          `Unknown task: ${taskId}`
        ),
        timestamp: new Date().toISOString()
      });
    }

    handle.promise = this.runExecutionLoop(handle).finally(() => {
      this.executions.delete(taskId);
    });

    return requireValue(
      await this.deps.taskManager.getTask(taskId),
      `Unknown task: ${taskId}`
    );
  }

  private async runExecutionLoop(handle: ExecutionHandle): Promise<void> {
    try {
      let task = requireValue(
        await this.deps.taskManager.getTask(handle.taskId),
        `Unknown task: ${handle.taskId}`
      );
      const runner = this.requireRunnerFromTask(task);

      while (true) {
        task = requireValue(
          await this.deps.taskManager.getTask(handle.taskId),
          `Unknown task: ${handle.taskId}`
        );

        if (isTerminalTaskStatus(task)) {
          return;
        }

        if (task.status === 'paused') {
          handle.pauseRequested = true;
        }

        const step =
          selectPlannedNextStep(task) ??
          runner.selectNextStep?.(task) ??
          task.steps.find(
            (candidate) =>
              candidate.status !== 'completed' && candidate.status !== 'cancelled'
          ) ??
          null;

        if (!step) {
          break;
        }

        await this.waitIfPaused(handle);
        this.ensureNotCancelled(handle);

        const completedBeforeStep = task.steps.filter(
          (candidate) => candidate.status === 'completed'
        ).length;
        const progressBeforeStep = buildProgressPercent(
          completedBeforeStep,
          task.steps.length
        );

        task = await this.deps.taskManager.advanceTaskPhase(handle.taskId, {
          currentPhase: step.label,
          currentStepId: step.id,
          currentStepLabel: step.label,
          progressPercent: progressBeforeStep
        });
        await this.emitEvent({
          type: 'task_step_started',
          task,
          timestamp: new Date().toISOString(),
          stepId: step.id,
          stepLabel: step.label
        });

        const context = await this.buildExecutionContext(task, handle);
        await runner.executeStep(step, context);

        const latestAfterStep = requireValue(
          await this.deps.taskManager.getTask(handle.taskId),
          `Unknown task: ${handle.taskId}`
        );
        if (latestAfterStep.status === 'cancelled' || handle.cancelRequested) {
          return;
        }

        const completedAfterStep =
          latestAfterStep.steps.filter((candidate) => candidate.status === 'completed')
            .length + 1;
        const progressAfterStep = buildProgressPercent(
          completedAfterStep,
          latestAfterStep.steps.length
        );
        task = await this.deps.taskManager.completeCurrentStep(handle.taskId, {
          progressPercent: progressAfterStep,
          currentPhase: step.label
        });
        await this.emitEvent({
          type: 'task_step_completed',
          task,
          timestamp: new Date().toISOString(),
          stepId: step.id,
          stepLabel: step.label
        });
      }

      const completedTask = await this.deps.taskManager.completeTask(handle.taskId);
      const result = await this.requireRunnerFromTask(completedTask).buildExecutionResult(
        completedTask
      );
      await this.emitEvent({
        type: 'task_execution_completed',
        task: completedTask,
        timestamp: new Date().toISOString(),
        result
      });
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        return;
      }

      const message =
        error instanceof Error
          ? sanitizeErrorMessage(error.message)
          : 'Unknown task runtime error.';
      const currentTask = await this.deps.taskManager.getTask(handle.taskId);
      if (currentTask && !isTerminalTaskStatus(currentTask)) {
        const failedTask = await this.deps.taskManager.failTask(handle.taskId, message);
        await this.emitEvent({
          type: 'task_execution_failed',
          task: failedTask,
          timestamp: new Date().toISOString(),
          detail: message
        });
      }
    }
  }

  private async buildExecutionContext(
    task: AssemTask,
    handle: ExecutionHandle
  ): Promise<TaskExecutionContext> {
    const session = requireValue(
      await this.deps.sessionStore.getSession(task.sessionId),
      `Unknown session for task ${task.id}.`
    );
    const activeProfile = await this.deps.memoryBackend.getActiveProfile();

    return {
      task,
      session,
      sandboxRoot: this.deps.sandboxRoot,
      dataRoot: this.deps.dataRoot,
      activeProfile,
      executeTool: async <Input, Output>(
        toolId: string,
        input: Input
      ): Promise<ToolExecutionResult<Output>> => {
        const tool = this.deps.toolRegistry.get(toolId);
        const latestSession = requireValue(
          await this.deps.sessionStore.getSession(task.sessionId),
          `Unknown session for task ${task.id}.`
        );
        const latestProfile = await this.deps.memoryBackend.getActiveProfile();
        const context: ToolExecutionContext = {
          now: new Date(),
          sandboxRoot: this.deps.sandboxRoot,
          activeMode: latestSession.activeMode,
          session: latestSession,
          activeProfile: latestProfile
        };

        return tool.execute(input, context) as Promise<ToolExecutionResult<Output>>;
      },
      invokeModel: async (
        messages: ChatMessage[],
        requiredCapabilities: ProviderCapability[] = ['chat']
      ): Promise<ModelResponse> => {
        const latestSession = requireValue(
          await this.deps.sessionStore.getSession(task.sessionId),
          `Unknown session for task ${task.id}.`
        );
        const latestProfile = await this.deps.memoryBackend.getActiveProfile();
        const request: ModelRequest = {
          messages,
          availableTools: this.deps.toolRegistry.summaries(),
          privacyMode: latestSession.activeMode.privacy,
          runtimeMode: latestSession.activeMode.runtime,
          preferredProviderId: latestSession.settings.preferredProviderId,
          requiredCapabilities,
          activeProfile: latestProfile
            ? {
                id: latestProfile.id,
                name: latestProfile.name,
                isActive: latestProfile.isActive,
                updatedAt: latestProfile.updatedAt,
                notesCount: latestProfile.notes.length,
                contactsCount: latestProfile.contacts.length,
                summariesCount: latestProfile.savedSummaries.length
              }
            : null
        };

        return this.deps.modelRouter.respond(request);
      },
      getTask: async () =>
        requireValue(
          await this.deps.taskManager.getTask(task.id),
          `Unknown task: ${task.id}`
        ),
      updateProgress: async (input: TaskProgressUpdateInput) =>
        this.deps.taskManager.updateTaskProgress(task.id, input),
      advancePhase: async (input: TaskPhaseAdvanceInput) =>
        this.deps.taskManager.advanceTaskPhase(task.id, input),
      completeCurrentStep: async (
        input: TaskStepCompletionInput = {}
      ) => this.deps.taskManager.completeCurrentStep(task.id, input),
      attachArtifact: async (input: TaskArtifactInput) =>
        this.deps.taskManager.attachArtifact(task.id, input),
      ensureArtifact: async (input: TaskArtifactInput) => {
        const latestTask = requireValue(
          await this.deps.taskManager.getTask(task.id),
          `Unknown task: ${task.id}`
        );
        const alreadyExists = latestTask.artifacts.some(
          (artifact) =>
            artifact.label === input.label &&
            artifact.filePath === input.filePath &&
            artifact.kind === input.kind
        );

        if (alreadyExists) {
          return latestTask;
        }

        return this.deps.taskManager.attachArtifact(task.id, input);
      },
      mergeMetadata: async (metadata: Record<string, unknown>) => {
        const latestTask = requireValue(
          await this.deps.taskManager.getTask(task.id),
          `Unknown task: ${task.id}`
        );

        return this.deps.taskManager.updateTaskProgress(task.id, {
          progressPercent: latestTask.progressPercent,
          currentPhase: latestTask.currentPhase,
          currentStepId: latestTask.currentStepId,
          metadata
        });
      },
      waitIfPaused: async () => {
        await this.waitIfPaused(handle);
      },
      ensureNotCancelled: async () => {
        this.ensureNotCancelled(handle);
        const latestTask = await this.deps.taskManager.getTask(task.id);
        if (latestTask?.status === 'cancelled') {
          throw new TaskCancelledError();
        }
      }
    };
  }

  private requireRunner(taskType: string): TaskRunner {
    const runner = this.runners.get(taskType);
    if (!runner) {
      throw new Error(`Unsupported task type: ${taskType}`);
    }

    return runner;
  }

  private requireRunnerFromTask(task: AssemTask): TaskRunner {
    const taskType = task.metadata?.taskType;
    if (typeof taskType !== 'string') {
      throw new Error(`Task ${task.id} does not declare a runtime task type.`);
    }

    return this.requireRunner(taskType);
  }

  private requestPauseExecution(taskId: string): void {
    const handle = this.executions.get(taskId);
    if (!handle) {
      return;
    }

    handle.pauseRequested = true;
  }

  private async waitIfPaused(handle: ExecutionHandle): Promise<void> {
    while (handle.pauseRequested) {
      if (handle.cancelRequested) {
        throw new TaskCancelledError();
      }

      if (!handle.pauseBarrier) {
        handle.pauseBarrier = new Promise<void>((resolve) => {
          handle.releasePauseBarrier = resolve;
        });
      }

      await handle.pauseBarrier;
    }
  }

  private ensureNotCancelled(handle: ExecutionHandle): void {
    if (handle.cancelRequested) {
      throw new TaskCancelledError();
    }
  }

  private async emitEvent(event: TaskRuntimeEvent): Promise<void> {
    if (!this.options.onEvent) {
      return;
    }

    await this.options.onEvent(event);
  }
}
