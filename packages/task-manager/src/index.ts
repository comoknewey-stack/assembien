import { JsonFileStore } from '@assem/persistence';
import type {
  AssemTask,
  TaskArtifact,
  TaskArtifactInput,
  TaskCreateInput,
  TaskManager,
  TaskManagerEvent,
  TaskPhaseAdvanceInput,
  TaskProgressUpdateInput,
  TaskStepCompletionInput,
  TaskStatus,
  TaskStep,
  TaskStepInput
} from '@assem/shared-types';

interface TaskStoreShape {
  activeTaskIdsBySession: Record<string, string>;
  tasks: AssemTask[];
}

interface TaskStoreAdapter {
  read(): Promise<TaskStoreShape>;
  update(
    mutator: (current: TaskStoreShape) => TaskStoreShape | Promise<TaskStoreShape>
  ): Promise<TaskStoreShape>;
}

export interface TaskManagerOptions {
  onEvent?: (event: TaskManagerEvent) => Promise<void> | void;
}

const INITIAL_STORE: TaskStoreShape = {
  activeTaskIdsBySession: {},
  tasks: []
};

const DEFAULT_PHASE = 'Preparando la tarea';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireTask(task: AssemTask | null, message: string): AssemTask {
  if (!task) {
    throw new Error(message);
  }

  return task;
}

function isTerminalStatus(status: TaskStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

function isCurrentTaskStatus(status: TaskStatus): boolean {
  return ['pending', 'active', 'paused', 'blocked'].includes(status);
}

function sortTasks(tasks: AssemTask[]): AssemTask[] {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function validateObjective(objective: string): void {
  if (!objective.trim()) {
    throw new Error('Tasks require a non-empty objective.');
  }
}

function validateProgress(progressPercent: number | null): void {
  if (progressPercent === null) {
    return;
  }

  if (!Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) {
    throw new Error('Task progress must be between 0 and 100.');
  }
}

function normalizeSteps(
  steps: TaskStepInput[] | undefined,
  status: Extract<TaskStatus, 'pending' | 'active'>,
  now: string,
  currentStepId?: string
): TaskStep[] {
  return (steps ?? []).map((step, index) => {
    const id = step.id?.trim() || crypto.randomUUID();
    const active =
      status === 'active' &&
      (currentStepId ? currentStepId === id : index === 0);

    return {
      id,
      label: step.label.trim() || `Paso ${index + 1}`,
      status: active ? 'active' : 'pending',
      createdAt: now,
      updatedAt: now,
      startedAt: active ? now : undefined
    };
  });
}

function withMergedMetadata(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!current && !next) {
    return undefined;
  }

  return {
    ...(current ?? {}),
    ...(next ?? {})
  };
}

function completeCurrentStep(task: AssemTask, now: string): TaskStep[] {
  return task.steps.map((step) =>
    step.id === task.currentStepId && step.status !== 'completed'
      ? {
          ...step,
          status: 'completed',
          updatedAt: now,
          completedAt: step.completedAt ?? now
        }
      : step
  );
}

function markStepsForTerminalStatus(
  steps: TaskStep[],
  nextStatus: 'cancelled' | 'blocked' | 'completed',
  now: string
): TaskStep[] {
  return steps.map((step) => {
    if (nextStatus === 'completed') {
      return step.status === 'completed'
        ? step
        : {
            ...step,
            status: 'completed',
            updatedAt: now,
            startedAt: step.startedAt ?? now,
            completedAt: step.completedAt ?? now
          };
    }

    if (step.status === 'completed') {
      return step;
    }

    return {
      ...step,
      status: nextStatus,
      updatedAt: now
    };
  });
}

function ensureStepForPhase(
  task: AssemTask,
  stepId: string | undefined,
  stepLabel: string | undefined,
  now: string
): { steps: TaskStep[]; currentStepId: string | undefined } {
  if (!stepId && !stepLabel) {
    return {
      steps: task.steps,
      currentStepId: task.currentStepId
    };
  }

  const resolvedStepId = stepId ?? crypto.randomUUID();
  const existing = task.steps.find((step) => step.id === resolvedStepId);
  const label =
    stepLabel?.trim() ||
    existing?.label ||
    task.currentPhase ||
    DEFAULT_PHASE;

  const baseSteps = task.steps.map((step) => {
    if (step.id === task.currentStepId && step.id !== resolvedStepId && step.status === 'active') {
      return {
        ...step,
        status: 'completed' as const,
        updatedAt: now,
        completedAt: step.completedAt ?? now
      };
    }

    if (step.id === resolvedStepId) {
      return {
        ...step,
        label,
        status: 'active' as const,
        updatedAt: now,
        startedAt: step.startedAt ?? now
      };
    }

    return step;
  });

  if (existing) {
    return {
      steps: baseSteps,
      currentStepId: resolvedStepId
    };
  }

  return {
    steps: [
      ...baseSteps,
      {
        id: resolvedStepId,
        label,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        startedAt: now
      }
    ],
    currentStepId: resolvedStepId
  };
}

function buildTask(input: TaskCreateInput, now: string): AssemTask {
  validateObjective(input.objective);
  validateProgress(input.progressPercent ?? null);
  const status = input.status ?? 'active';
  const steps = normalizeSteps(input.steps, status, now, input.currentStepId);
  const currentStepId =
    input.currentStepId ??
    steps.find((step) => step.status === 'active')?.id;

  return {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    objective: input.objective.trim(),
    status,
    progressPercent: input.progressPercent ?? null,
    currentPhase: input.currentPhase?.trim() || DEFAULT_PHASE,
    steps,
    currentStepId,
    artifacts: [],
    createdAt: now,
    updatedAt: now,
    startedAt: status === 'active' ? now : undefined,
    plan: input.plan ? clone(input.plan) : undefined,
    metadata: input.metadata ? clone(input.metadata) : undefined
  };
}

function findTaskIndex(state: TaskStoreShape, taskId: string): number {
  return state.tasks.findIndex((task) => task.id === taskId);
}

function resolveActiveTaskFromState(
  state: TaskStoreShape,
  sessionId: string
): AssemTask | null {
  const activeTaskId = state.activeTaskIdsBySession[sessionId];
  if (activeTaskId) {
    const pointedTask =
      state.tasks.find((task) => task.id === activeTaskId && task.sessionId === sessionId) ??
      null;
    if (pointedTask && isCurrentTaskStatus(pointedTask.status)) {
      return pointedTask;
    }
  }

  return (
    sortTasks(
      state.tasks.filter(
        (task) => task.sessionId === sessionId && isCurrentTaskStatus(task.status)
      )
    )[0] ?? null
  );
}

class MemoryTaskStoreAdapter implements TaskStoreAdapter {
  private state = clone(INITIAL_STORE);

  async read(): Promise<TaskStoreShape> {
    return clone(this.state);
  }

  async update(
    mutator: (current: TaskStoreShape) => TaskStoreShape | Promise<TaskStoreShape>
  ): Promise<TaskStoreShape> {
    this.state = clone(await mutator(clone(this.state)));
    return clone(this.state);
  }
}

class JsonTaskStoreAdapter implements TaskStoreAdapter {
  private readonly store: JsonFileStore<TaskStoreShape>;

  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, INITIAL_STORE);
  }

  read(): Promise<TaskStoreShape> {
    return this.store.read();
  }

  update(
    mutator: (current: TaskStoreShape) => TaskStoreShape | Promise<TaskStoreShape>
  ): Promise<TaskStoreShape> {
    return this.store.update(mutator);
  }
}

abstract class BaseTaskManager implements TaskManager {
  constructor(
    private readonly store: TaskStoreAdapter,
    private readonly options: TaskManagerOptions = {}
  ) {}

  async createTask(input: TaskCreateInput): Promise<AssemTask> {
    const events: TaskManagerEvent[] = [];
    let createdTask: AssemTask | null = null;
    const now = new Date().toISOString();

    await this.store.update((current) => {
      const next = clone(current);
      const previousActive = resolveActiveTaskFromState(next, input.sessionId);

      if (previousActive && !isTerminalStatus(previousActive.status)) {
        const previousIndex = findTaskIndex(next, previousActive.id);
        if (previousIndex !== -1) {
          const pausedTask: AssemTask = {
            ...previousActive,
            status: 'paused',
            updatedAt: now,
            pausedAt: now
          };
          next.tasks[previousIndex] = pausedTask;
          events.push({
            type: 'task_paused',
            task: pausedTask,
            timestamp: now,
            detail: 'La tarea activa anterior se ha pausado al abrir una nueva tarea.'
          });
        }
      }

      const task = buildTask(input, now);
      createdTask = task;
      next.tasks.push(task);
      next.activeTaskIdsBySession[input.sessionId] = task.id;
      events.push({
        type: 'task_created',
        task,
        timestamp: now
      });

      if (task.status === 'active') {
        events.push({
          type: 'task_started',
          task,
          timestamp: now
        });
      }

      return next;
    });

    await this.emitEvents(events);
    return requireTask(createdTask, 'The task could not be created.');
  }

  async getTask(taskId: string): Promise<AssemTask | null> {
    const current = await this.store.read();
    return current.tasks.find((task) => task.id === taskId) ?? null;
  }

  async listTasks(sessionId?: string): Promise<AssemTask[]> {
    const current = await this.store.read();
    const tasks = sessionId
      ? current.tasks.filter((task) => task.sessionId === sessionId)
      : current.tasks;
    return sortTasks(tasks);
  }

  async getActiveTaskForSession(sessionId: string): Promise<AssemTask | null> {
    const current = await this.store.read();
    return resolveActiveTaskFromState(current, sessionId);
  }

  async updateTaskProgress(
    taskId: string,
    input: TaskProgressUpdateInput
  ): Promise<AssemTask> {
    validateProgress(input.progressPercent);
    const now = new Date().toISOString();
    const events: TaskManagerEvent[] = [];
    let updatedTask: AssemTask | null = null;

    await this.store.update((current) => {
      const next = clone(current);
      const index = findTaskIndex(next, taskId);
      if (index === -1) {
        throw new Error(`Unknown task: ${taskId}`);
      }

      const task = next.tasks[index];
      if (isTerminalStatus(task.status)) {
        throw new Error('Cannot update progress on a finished task.');
      }

      const stepUpdate = ensureStepForPhase(
        task,
        input.currentStepId,
        undefined,
        now
      );
      updatedTask = {
        ...task,
        status: task.status === 'pending' ? 'active' : task.status,
        progressPercent: input.progressPercent,
        currentPhase:
          input.currentPhase === undefined
            ? task.currentPhase
            : input.currentPhase?.trim() || null,
        currentStepId: stepUpdate.currentStepId,
        steps: stepUpdate.steps,
        updatedAt: now,
        startedAt: task.startedAt ?? now,
        plan: input.plan ? clone(input.plan) : task.plan,
        metadata: withMergedMetadata(task.metadata, input.metadata)
      };
      next.tasks[index] = updatedTask;
      next.activeTaskIdsBySession[task.sessionId] = task.id;
      events.push({
        type: 'task_progress_updated',
        task: updatedTask,
        timestamp: now
      });
      return next;
    });

    await this.emitEvents(events);
    return requireTask(updatedTask, 'The task progress could not be updated.');
  }

  async advanceTaskPhase(
    taskId: string,
    input: TaskPhaseAdvanceInput
  ): Promise<AssemTask> {
    if (!input.currentPhase.trim()) {
      throw new Error('Task phases require a non-empty label.');
    }

    if (input.progressPercent !== undefined) {
      validateProgress(input.progressPercent);
    }

    const now = new Date().toISOString();
    const events: TaskManagerEvent[] = [];
    let updatedTask: AssemTask | null = null;

    await this.store.update((current) => {
      const next = clone(current);
      const index = findTaskIndex(next, taskId);
      if (index === -1) {
        throw new Error(`Unknown task: ${taskId}`);
      }

      const task = next.tasks[index];
      if (isTerminalStatus(task.status)) {
        throw new Error('Cannot advance the phase of a finished task.');
      }

      const completedSteps = completeCurrentStep(task, now);
      const stepUpdate = ensureStepForPhase(
        {
          ...task,
          steps: completedSteps
        },
        input.currentStepId,
        input.currentStepLabel,
        now
      );

      updatedTask = {
        ...task,
        status: task.status === 'pending' ? 'active' : task.status,
        currentPhase: input.currentPhase.trim(),
        currentStepId: stepUpdate.currentStepId,
        steps: stepUpdate.steps,
        progressPercent:
          input.progressPercent === undefined
            ? task.progressPercent
            : input.progressPercent,
        updatedAt: now,
        startedAt: task.startedAt ?? now,
        plan: input.plan ? clone(input.plan) : task.plan,
        metadata: withMergedMetadata(task.metadata, input.metadata)
      };
      next.tasks[index] = updatedTask;
      next.activeTaskIdsBySession[task.sessionId] = task.id;
      events.push({
        type: 'task_progress_updated',
        task: updatedTask,
        timestamp: now
      });
      return next;
    });

    await this.emitEvents(events);
    return requireTask(updatedTask, 'The task phase could not be advanced.');
  }

  async completeCurrentStep(
    taskId: string,
    input: TaskStepCompletionInput = {}
  ): Promise<AssemTask> {
    if (input.progressPercent !== undefined) {
      validateProgress(input.progressPercent);
    }

    const now = new Date().toISOString();
    const events: TaskManagerEvent[] = [];
    let updatedTask: AssemTask | null = null;

    await this.store.update((current) => {
      const next = clone(current);
      const index = findTaskIndex(next, taskId);
      if (index === -1) {
        throw new Error(`Unknown task: ${taskId}`);
      }

      const task = next.tasks[index];
      if (isTerminalStatus(task.status)) {
        throw new Error('Cannot complete a step on a finished task.');
      }

      updatedTask = {
        ...task,
        status: task.status === 'pending' ? 'active' : task.status,
        steps: completeCurrentStep(task, now),
        currentStepId: undefined,
        progressPercent:
          input.progressPercent === undefined
            ? task.progressPercent
            : input.progressPercent,
        currentPhase:
          input.currentPhase === undefined
            ? task.currentPhase
            : input.currentPhase?.trim() || null,
        updatedAt: now,
        startedAt: task.startedAt ?? now,
        plan: input.plan ? clone(input.plan) : task.plan,
        metadata: withMergedMetadata(task.metadata, input.metadata)
      };

      next.tasks[index] = updatedTask;
      next.activeTaskIdsBySession[task.sessionId] = task.id;
      events.push({
        type: 'task_progress_updated',
        task: updatedTask,
        timestamp: now
      });
      return next;
    });

    await this.emitEvents(events);
    return requireTask(updatedTask, 'The current task step could not be completed.');
  }

  async attachArtifact(taskId: string, input: TaskArtifactInput): Promise<AssemTask> {
    if (!input.label.trim()) {
      throw new Error('Task artifacts require a label.');
    }

    const now = new Date().toISOString();
    let updatedTask: AssemTask | null = null;

    await this.store.update((current) => {
      const next = clone(current);
      const index = findTaskIndex(next, taskId);
      if (index === -1) {
        throw new Error(`Unknown task: ${taskId}`);
      }

      const task = next.tasks[index];
      const artifact: TaskArtifact = {
        id: crypto.randomUUID(),
        kind: input.kind,
        label: input.label.trim(),
        createdAt: now,
        filePath: input.filePath,
        contentType: input.contentType,
        description: input.description,
        metadata: input.metadata ? clone(input.metadata) : undefined
      };

      updatedTask = {
        ...task,
        artifacts: [...task.artifacts, artifact],
        updatedAt: now
      };
      next.tasks[index] = updatedTask;
      return next;
    });

    return requireTask(updatedTask, 'The task artifact could not be attached.');
  }

  async pauseTask(taskId: string, reason?: string): Promise<AssemTask> {
    return this.updateStatus(taskId, 'paused', reason);
  }

  async resumeTask(taskId: string): Promise<AssemTask> {
    return this.updateStatus(taskId, 'active');
  }

  async cancelTask(taskId: string, reason?: string): Promise<AssemTask> {
    return this.updateStatus(taskId, 'cancelled', reason);
  }

  async completeTask(taskId: string): Promise<AssemTask> {
    return this.updateStatus(taskId, 'completed');
  }

  async failTask(taskId: string, reason: string): Promise<AssemTask> {
    if (!reason.trim()) {
      throw new Error('Failed tasks require a reason.');
    }

    return this.updateStatus(taskId, 'failed', reason);
  }

  private async updateStatus(
    taskId: string,
    nextStatus: TaskStatus,
    detail?: string
  ): Promise<AssemTask> {
    const now = new Date().toISOString();
    const events: TaskManagerEvent[] = [];
    let updatedTask: AssemTask | null = null;

    await this.store.update((current) => {
      const next = clone(current);
      const index = findTaskIndex(next, taskId);
      if (index === -1) {
        throw new Error(`Unknown task: ${taskId}`);
      }

      const task = next.tasks[index];
      const priorStatus = task.status;

      if (nextStatus === 'active') {
        const previousActive = resolveActiveTaskFromState(next, task.sessionId);
        if (
          previousActive &&
          previousActive.id !== task.id &&
          !isTerminalStatus(previousActive.status)
        ) {
          const previousIndex = findTaskIndex(next, previousActive.id);
          if (previousIndex !== -1) {
            const pausedPrevious: AssemTask = {
              ...previousActive,
              status: 'paused',
              updatedAt: now,
              pausedAt: now
            };
            next.tasks[previousIndex] = pausedPrevious;
            events.push({
              type: 'task_paused',
              task: pausedPrevious,
              timestamp: now,
              detail:
                'La tarea activa anterior se ha pausado al reanudar otra tarea.'
            });
          }
        }
      }

      let steps = task.steps;
      if (nextStatus === 'completed') {
        steps = markStepsForTerminalStatus(task.steps, 'completed', now);
      } else if (nextStatus === 'cancelled') {
        steps = markStepsForTerminalStatus(task.steps, 'cancelled', now);
      } else if (nextStatus === 'failed') {
        steps = markStepsForTerminalStatus(task.steps, 'blocked', now);
      } else if (nextStatus === 'paused') {
        steps = task.steps.map((step) =>
          step.id === task.currentStepId && step.status === 'active'
            ? {
                ...step,
                status: 'paused',
                updatedAt: now
              }
            : step
        );
      } else if (nextStatus === 'active') {
        steps = task.steps.map((step) =>
          step.id === task.currentStepId && step.status !== 'completed'
            ? {
                ...step,
                status: 'active',
                updatedAt: now,
                startedAt: step.startedAt ?? now
              }
            : step
        );
      }

      updatedTask = {
        ...task,
        status: nextStatus,
        updatedAt: now,
        startedAt:
          nextStatus === 'active' ? task.startedAt ?? now : task.startedAt,
        pausedAt: nextStatus === 'paused' ? now : undefined,
        completedAt:
          nextStatus === 'completed' || nextStatus === 'cancelled'
            ? now
            : task.completedAt,
        failureReason: nextStatus === 'failed' || nextStatus === 'blocked' ? detail : undefined,
        progressPercent:
          nextStatus === 'completed'
            ? 100
            : nextStatus === 'cancelled' && task.progressPercent === null
              ? null
              : task.progressPercent,
        steps
      };
      next.tasks[index] = updatedTask;

      if (nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'cancelled') {
        if (next.activeTaskIdsBySession[task.sessionId] === task.id) {
          delete next.activeTaskIdsBySession[task.sessionId];
        }
      } else {
        next.activeTaskIdsBySession[task.sessionId] = task.id;
      }

      if (priorStatus !== nextStatus || detail) {
        const eventType =
          nextStatus === 'paused'
            ? 'task_paused'
            : nextStatus === 'active'
              ? 'task_resumed'
              : nextStatus === 'completed'
                ? 'task_completed'
                : nextStatus === 'failed'
                  ? 'task_failed'
                  : nextStatus === 'cancelled'
                    ? 'task_cancelled'
                    : 'task_progress_updated';

        events.push({
          type: eventType,
          task: updatedTask,
          timestamp: now,
          detail
        });
      }

      return next;
    });

    await this.emitEvents(events);
    return requireTask(updatedTask, 'The task status could not be updated.');
  }

  private async emitEvents(events: TaskManagerEvent[]): Promise<void> {
    if (!this.options.onEvent || events.length === 0) {
      return;
    }

    for (const event of events) {
      await this.options.onEvent(event);
    }
  }
}

export class InMemoryTaskManager extends BaseTaskManager {
  constructor(options: TaskManagerOptions = {}) {
    super(new MemoryTaskStoreAdapter(), options);
  }
}

export class FileTaskManager extends BaseTaskManager {
  constructor(filePath: string, options: TaskManagerOptions = {}) {
    super(new JsonTaskStoreAdapter(filePath), options);
  }
}
