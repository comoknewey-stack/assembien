import { JsonFileStore } from '@assem/persistence';
import type {
  ScheduledTask,
  ScheduledTaskCadence,
  ScheduledTaskInput,
  ScheduledTaskRun,
  Scheduler,
  SchedulerRunContext
} from '@assem/shared-types';

interface SchedulerFileShape {
  tasks: ScheduledTask[];
}

export interface ScheduledTaskRunner {
  (
    task: ScheduledTask,
    context?: SchedulerRunContext
  ): Promise<{
    summary: string;
    errorMessage?: string;
  }>;
}

function isSafeCadence(cadence: ScheduledTaskCadence): boolean {
  return cadence === 'manual' || cadence === 'once' || cadence === 'daily';
}

function computeNextRun(task: ScheduledTask, now = new Date()): string | undefined {
  if (!task.enabled) {
    return undefined;
  }

  if (task.cadence === 'manual') {
    return undefined;
  }

  if (task.cadence === 'once') {
    return task.scheduleAt;
  }

  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function validateTaskInput(input: ScheduledTaskInput): void {
  if (!input.label.trim()) {
    throw new Error('Scheduled tasks require a label.');
  }

  if (!input.prompt.trim()) {
    throw new Error('Scheduled tasks require a prompt.');
  }

  if (!isSafeCadence(input.cadence ?? 'manual')) {
    throw new Error('Unsupported task cadence.');
  }
}

export class BasicScheduler implements Scheduler {
  private readonly store: JsonFileStore<SchedulerFileShape>;

  constructor(
    filePath: string,
    private readonly runner: ScheduledTaskRunner
  ) {
    this.store = new JsonFileStore(filePath, {
      tasks: []
    });
  }

  async createTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
    validateTaskInput(input);

    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      label: input.label.trim(),
      kind: input.kind,
      prompt: input.prompt.trim(),
      cadence: input.cadence ?? 'manual',
      scheduleAt: input.scheduleAt,
      enabled: input.enabled ?? true,
      safe: true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.scheduleAt
    };

    await this.store.update((current) => ({
      tasks: [...current.tasks, task]
    }));

    return task;
  }

  async listTasks(): Promise<ScheduledTask[]> {
    const current = await this.store.read();
    return [...current.tasks].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  async setTaskEnabled(
    taskId: string,
    enabled: boolean
  ): Promise<ScheduledTask> {
    await this.store.update((current) => ({
      tasks: current.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              enabled,
              updatedAt: new Date().toISOString(),
              nextRunAt: enabled ? computeNextRun(task) : undefined
            }
          : task
      )
    }));

    const task = (await this.listTasks()).find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Unknown scheduled task: ${taskId}`);
    }

    return task;
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.store.update((current) => ({
      tasks: current.tasks.filter((task) => task.id !== taskId)
    }));
  }

  async runTask(
    taskId: string,
    context?: SchedulerRunContext
  ): Promise<ScheduledTaskRun> {
    const current = await this.store.read();
    const task = current.tasks.find((entry) => entry.id === taskId);

    if (!task) {
      throw new Error(`Unknown scheduled task: ${taskId}`);
    }

    const startedAt = new Date().toISOString();

    try {
      const result = await this.runner(task, context);
      const finishedAt = new Date().toISOString();
      const run: ScheduledTaskRun = {
        id: crypto.randomUUID(),
        taskId,
        startedAt,
        finishedAt,
        status: 'success',
        summary: result.summary
      };

      await this.store.update((state) => ({
        tasks: state.tasks.map((entry) =>
          entry.id === taskId
            ? {
                ...entry,
                enabled:
                  entry.cadence === 'once' ? false : entry.enabled,
                updatedAt: finishedAt,
                lastRunAt: finishedAt,
                lastRun: run,
                nextRunAt:
                  entry.cadence === 'once'
                    ? undefined
                    : computeNextRun(entry, new Date(finishedAt))
              }
            : entry
        )
      }));

      return run;
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const run: ScheduledTaskRun = {
        id: crypto.randomUUID(),
        taskId,
        startedAt,
        finishedAt,
        status: 'error',
        summary: 'Task execution failed.',
        errorMessage:
          error instanceof Error ? error.message : 'Unknown scheduler error'
      };

      await this.store.update((state) => ({
        tasks: state.tasks.map((entry) =>
          entry.id === taskId
            ? {
                ...entry,
                updatedAt: finishedAt,
                lastRunAt: finishedAt,
                lastRun: run
              }
            : entry
        )
      }));

      return run;
    }
  }
}
