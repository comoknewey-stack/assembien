import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { InMemorySessionStore } from '@assem/memory';
import { DeterministicTaskPlanner } from '@assem/planner';
import { FileTaskManager } from '@assem/task-manager';
import { ToolRegistry } from '@assem/tool-registry';
import type {
  AssemTask,
  MemoryBackend,
  ModelRequest,
  ModelResponse,
  ModelRouter,
  ProfileCreateInput,
  ProfileImportPayload,
  ProfileMemory,
  ProfileSummary,
  ProviderSummary,
  ProviderHealth,
  TaskCreateInput,
  TaskExecutionRequest,
  TaskExecutionResult,
  TaskRunner,
  TaskRuntimeEvent,
  TaskStep
} from '@assem/shared-types';

import {
  ResearchReportBasicTaskRunner,
  TaskRuntimeExecutor
} from './index';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForTask(
  taskManager: FileTaskManager,
  taskId: string,
  predicate: (task: AssemTask) => boolean,
  timeoutMs = 4_000
): Promise<AssemTask> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const task = await taskManager.getTask(taskId);
    if (task && predicate(task)) {
      return task;
    }

    await sleep(20);
  }

  throw new Error(`Timed out while waiting for task ${taskId}.`);
}

class TestMemoryBackend implements MemoryBackend {
  private profile: ProfileMemory = {
    id: 'profile-default',
    name: 'Default profile',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    preferences: {},
    notes: ['Default runtime profile'],
    contacts: [],
    savedSummaries: [],
    derivedData: {}
  };

  async createProfile(input: ProfileCreateInput): Promise<ProfileMemory> {
    this.profile = {
      ...this.profile,
      id: crypto.randomUUID(),
      name: input.name,
      updatedAt: new Date().toISOString(),
      preferences: input.preferences ?? {},
      notes: input.notes ?? [],
      contacts: input.contacts ?? [],
      savedSummaries: input.savedSummaries ?? [],
      derivedData: input.derivedData ?? {},
      isActive: true
    };

    return this.profile;
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    return [
      {
        id: this.profile.id,
        name: this.profile.name,
        isActive: this.profile.isActive,
        updatedAt: this.profile.updatedAt,
        notesCount: this.profile.notes.length,
        contactsCount: this.profile.contacts.length,
        summariesCount: this.profile.savedSummaries.length
      }
    ];
  }

  async getActiveProfile(): Promise<ProfileMemory | null> {
    return this.profile;
  }

  async activateProfile(): Promise<ProfileMemory> {
    this.profile = {
      ...this.profile,
      isActive: true,
      updatedAt: new Date().toISOString()
    };
    return this.profile;
  }

  async exportProfile(): Promise<ProfileMemory> {
    return this.profile;
  }

  async importProfile(payload: ProfileImportPayload): Promise<ProfileMemory> {
    this.profile = {
      ...payload.profile,
      isActive: payload.activate ?? payload.profile.isActive
    };
    return this.profile;
  }

  async resetProfile(): Promise<ProfileMemory> {
    this.profile = {
      ...this.profile,
      preferences: {},
      notes: [],
      contacts: [],
      savedSummaries: [],
      derivedData: {},
      updatedAt: new Date().toISOString()
    };
    return this.profile;
  }
}

function createModelRouter(
  onRespond?: (request: ModelRequest) => Promise<ModelResponse> | ModelResponse
): ModelRouter {
  return {
    listProviders(): ProviderSummary[] {
      return [
        {
          id: 'demo-local',
          label: 'Demo local provider',
          configured: true,
          defaultModel: 'demo-local-heuristic',
          supportsLocalOnly: true,
          capabilities: ['chat', 'tool_reasoning', 'telemetry'],
          supportsPrivacyModes: [
            'local_only',
            'prefer_local',
            'balanced',
            'cloud_allowed'
          ]
        }
      ];
    },
    async healthCheck(): Promise<ProviderHealth[]> {
      return [
        {
          providerId: 'demo-local',
          label: 'Demo local provider',
          status: 'ok',
          checkedAt: new Date().toISOString(),
          configured: true,
          supportsLocalOnly: true,
          defaultModel: 'demo-local-heuristic',
          capabilities: ['chat', 'tool_reasoning', 'telemetry'],
          supportsPrivacyModes: [
            'local_only',
            'prefer_local',
            'balanced',
            'cloud_allowed'
          ]
        }
      ];
    },
    async respond(request: ModelRequest): Promise<ModelResponse> {
      if (onRespond) {
        return onRespond(request);
      }

      return {
        text: '# Informe de trabajo\n\n## Objetivo\nPreparar informe semanal\n\n## Hallazgos iniciales\n- El runtime genero un borrador local.\n- La salida es determinista en tests.\n\n## Riesgos o limites\n- No hay navegacion web.\n\n## Proximos pasos\n- Revisar el informe.',
        confidence: 0.81,
        providerId: 'demo-local',
        model: 'demo-local-heuristic',
        usage: {
          latencyMs: 8,
          estimatedCostUsd: 0
        }
      };
    }
  };
}

async function createRuntimeHarness(
  onRespond?: (request: ModelRequest) => Promise<ModelResponse> | ModelResponse
) {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-runtime-sandbox-'));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-runtime-data-'));
  const taskManager = new FileTaskManager(path.join(dataRoot, 'tasks.json'));
  const sessionStore = new InMemorySessionStore('demo-local');
  const session = await sessionStore.createSession();
  const events: TaskRuntimeEvent[] = [];
  const runtime = new TaskRuntimeExecutor(
    {
      taskManager,
      sessionStore,
      memoryBackend: new TestMemoryBackend(),
      toolRegistry: new ToolRegistry(),
      modelRouter: createModelRouter(onRespond),
      sandboxRoot,
      dataRoot
    },
    {
      onEvent: async (event) => {
        events.push(event);
      }
    }
  );

  return {
    sandboxRoot,
    dataRoot,
    session,
    sessionId: session.sessionId,
    taskManager,
    runtime,
    events
  };
}

class ControlledRunner implements TaskRunner {
  readonly taskType = 'research_report_basic' as const;

  readonly firstStepStarted = deferred<void>();
  readonly firstStepGate = deferred<void>();

  createTaskInput(
    request: TaskExecutionRequest
  ): Omit<TaskCreateInput, 'sessionId' | 'objective'> {
    return {
      status: 'pending',
      progressPercent: 0,
      currentPhase: 'Pendiente de ejecucion',
      steps: [
        {
          id: 'step-one',
          label: 'Paso uno'
        },
        {
          id: 'step-two',
          label: 'Paso dos'
        }
      ],
      currentStepId: 'step-one',
      metadata: {
        ...(request.metadata ?? {}),
        taskType: this.taskType,
        workspaceRelativePath: 'task-runtime/test-workspace',
        reportRelativePath: 'task-runtime/test-workspace/report.md',
        summaryRelativePath: 'task-runtime/test-workspace/summary.txt',
        reportLanguage: 'es'
      }
    };
  }

  async executeStep(step: TaskStep, context: import('@assem/shared-types').TaskExecutionContext): Promise<void> {
    if (step.id === 'step-one') {
      this.firstStepStarted.resolve();
      await this.firstStepGate.promise;
      await context.ensureNotCancelled();
      await context.attachArtifact({
        kind: 'file',
        label: 'Paso uno',
        filePath: path.join(context.sandboxRoot, 'step-one.txt')
      });
      return;
    }

    await context.ensureNotCancelled();
    await context.attachArtifact({
      kind: 'file',
      label: 'Paso dos',
      filePath: path.join(context.sandboxRoot, 'step-two.txt')
    });
  }

  async buildExecutionResult(task: AssemTask): Promise<TaskExecutionResult> {
    return {
      taskId: task.id,
      taskType: this.taskType,
      status:
        task.status === 'failed' || task.status === 'cancelled'
          ? task.status
          : 'completed',
      summary: `Controlled task ${task.objective}`,
      artifacts: task.artifacts,
      completedAt: task.completedAt ?? new Date().toISOString()
    };
  }
}

class FailingRunner implements TaskRunner {
  readonly taskType = 'research_report_basic' as const;

  createTaskInput(
    request: TaskExecutionRequest
  ): Omit<TaskCreateInput, 'sessionId' | 'objective'> {
    return {
      status: 'pending',
      progressPercent: 0,
      currentPhase: 'Pendiente de ejecucion',
      steps: [
        {
          id: 'step-fail',
          label: 'Fallar'
        }
      ],
      currentStepId: 'step-fail',
      metadata: {
        ...(request.metadata ?? {}),
        taskType: this.taskType,
        workspaceRelativePath: 'task-runtime/failing-workspace',
        reportRelativePath: 'task-runtime/failing-workspace/report.md',
        summaryRelativePath: 'task-runtime/failing-workspace/summary.txt',
        reportLanguage: 'es'
      }
    };
  }

  async executeStep(): Promise<void> {
    throw new Error('Fallo controlado del runner');
  }

  async buildExecutionResult(task: AssemTask): Promise<TaskExecutionResult> {
    return {
      taskId: task.id,
      taskType: this.taskType,
      status:
        task.status === 'failed' || task.status === 'cancelled'
          ? task.status
          : 'completed',
      summary: task.objective,
      artifacts: task.artifacts,
      completedAt: task.completedAt ?? new Date().toISOString()
    };
  }
}

describe('TaskRuntimeExecutor', () => {
  afterEach(async () => {
    // Let background promises settle between tests.
    await sleep(20);
  });

  it('executes research_report_basic and writes real report artifacts', async () => {
    const harness = await createRuntimeHarness();

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: 'Preparar informe semanal'
    });

    const completedTask = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'completed'
    );

    expect(completedTask.progressPercent).toBe(100);
    expect(completedTask.artifacts.map((artifact) => artifact.label)).toEqual([
      'Carpeta de trabajo',
      'Informe principal',
      'Resumen ejecutivo'
    ]);

    const reportArtifact = completedTask.artifacts.find(
      (artifact) => artifact.label === 'Informe principal'
    );
    const summaryArtifact = completedTask.artifacts.find(
      (artifact) => artifact.label === 'Resumen ejecutivo'
    );

    const reportContents = await fs.readFile(reportArtifact!.filePath!, 'utf8');
    const summaryContents = await fs.readFile(summaryArtifact!.filePath!, 'utf8');

    expect(reportContents).toContain('# Informe de trabajo');
    expect(summaryContents).toContain('Objetivo: Preparar informe semanal');
    expect(completedTask.metadata?.runtimeModelInvocation).toMatchObject({
      providerId: 'demo-local',
      model: 'demo-local-heuristic'
    });
    expect(harness.events.map((event) => event.type)).toContain('task_execution_started');
    expect(harness.events.map((event) => event.type)).toContain('task_step_started');
    expect(harness.events.map((event) => event.type)).toContain('task_step_completed');
    expect(harness.events.map((event) => event.type)).toContain('task_execution_completed');
  });

  it('can start a persisted pending task later through startTask', async () => {
    const harness = await createRuntimeHarness();

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: 'Preparar informe mensual',
      autoStart: false
    });

    expect(task.status).toBe('pending');

    await harness.runtime.startTask(task.id);

    const completedTask = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'completed'
    );

    expect(completedTask.progressPercent).toBe(100);
  });

  it('uses a persisted planner-generated plan before starting the runtime task', async () => {
    const harness = await createRuntimeHarness();
    const planner = new DeterministicTaskPlanner();
    const planResult = planner.createPlan({
      session: harness.session,
      text: 'hazme un informe sobre costes operativos'
    });
    expect(planResult.accepted).toBe(true);
    expect(planResult.plan).toBeTruthy();

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: planResult.plan!.objective,
      plan: planResult.plan!,
      autoStart: false
    });

    expect(task.plan?.steps.map((step) => step.id)).toEqual([
      'prepare-workspace',
      'draft-report',
      'write-report',
      'write-summary'
    ]);
    expect(task.steps.map((step) => step.id)).toEqual(task.plan?.steps.map((step) => step.id));

    await harness.runtime.startTask(task.id);
    const completedTask = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'completed'
    );

    expect(completedTask.plan?.taskType).toBe('research_report_basic');
  });

  it('applies a shorter-output refinement to the future draft prompt', async () => {
    let capturedPrompt = '';
    const harness = await createRuntimeHarness(async (request) => {
      capturedPrompt =
        request.messages.find((message) => message.role === 'user')?.content ?? '';

      return {
        text: '# Informe de trabajo\n\n## Objetivo\nPreparar informe\n\n## Hallazgos iniciales\n- Version corta.\n\n## Riesgos o limites\n- Sin web.\n\n## Proximos pasos\n- Revisar.',
        confidence: 0.8,
        providerId: 'demo-local',
        model: 'demo-local-heuristic'
      };
    });

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: 'Preparar informe semanal',
      autoStart: false
    });

    await harness.taskManager.updateTaskProgress(task.id, {
      progressPercent: 0,
      currentPhase: 'Pendiente de ejecucion',
      currentStepId: 'prepare-workspace',
      metadata: {
        interruptState: {
          refinements: [
            {
              id: 'ref-shorter',
              category: 'output',
              type: 'length',
              instruction: 'hazlo mas corto',
              label: 'Salida mas corta',
              value: 'shorter',
              createdAt: new Date().toISOString()
            }
          ]
        }
      }
    });

    await harness.runtime.startTask(task.id);
    await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'completed'
    );

    expect(capturedPrompt).toContain('Haz el informe mas corto');
  });

  it('applies a language refinement to future runtime output when compatible steps remain', async () => {
    const harness = await createRuntimeHarness(async () => ({
      text: '# Working Report\n\n## Objective\nPrepare weekly report\n\n## Initial findings\n- English draft.\n\n## Risks or limits\n- No web access.\n\n## Next actions\n- Review the draft.',
      confidence: 0.82,
      providerId: 'demo-local',
      model: 'demo-local-heuristic'
    }));

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: 'Prepare weekly report',
      autoStart: false
    });

    await harness.taskManager.updateTaskProgress(task.id, {
      progressPercent: 0,
      currentPhase: 'Pending execution',
      currentStepId: 'prepare-workspace',
      metadata: {
        interruptState: {
          refinements: [
            {
              id: 'ref-language',
              category: 'output',
              type: 'language',
              instruction: 'hazlo en ingles',
              label: 'Salida en ingles',
              value: 'en',
              createdAt: new Date().toISOString()
            }
          ]
        }
      }
    });

    await harness.runtime.startTask(task.id);
    const completedTask = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'completed'
    );
    const summaryArtifact = completedTask.artifacts.find(
      (artifact) => artifact.label === 'Resumen ejecutivo'
    );
    const summaryContents = await fs.readFile(summaryArtifact!.filePath!, 'utf8');

    expect(summaryContents).toContain('Objective: Prepare weekly report');
  });

  it('pauses and resumes a running task without losing real progress', async () => {
    const harness = await createRuntimeHarness();
    const runner = new ControlledRunner();
    harness.runtime.registerRunner(runner);

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: 'Controlar una pausa'
    });

    await runner.firstStepStarted.promise;
    const pausedTask = await harness.runtime.pauseTask(task.id, 'Pausa manual');
    expect(pausedTask.status).toBe('paused');

    runner.firstStepGate.resolve();

    const taskAfterPause = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'paused' && candidate.progressPercent === 50
    );
    expect(taskAfterPause.artifacts.map((artifact) => artifact.label)).toContain(
      'Paso uno'
    );

    await harness.runtime.resumeTask(task.id);
    const completedTask = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'completed'
    );

    expect(completedTask.progressPercent).toBe(100);
    expect(completedTask.artifacts.map((artifact) => artifact.label)).toEqual([
      'Paso uno',
      'Paso dos'
    ]);
  });

  it('cancels a running task cleanly and does not mark it completed afterwards', async () => {
    const harness = await createRuntimeHarness();
    const runner = new ControlledRunner();
    harness.runtime.registerRunner(runner);

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: 'Cancelar una tarea'
    });

    await runner.firstStepStarted.promise;
    const cancelledTask = await harness.runtime.cancelTask(task.id, 'Cancelacion manual');
    expect(cancelledTask.status).toBe('cancelled');

    runner.firstStepGate.resolve();

    const settledTask = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'cancelled'
    );

    expect(settledTask.status).toBe('cancelled');
    expect(settledTask.artifacts).toHaveLength(0);
    expect(harness.events.map((event) => event.type)).not.toContain(
      'task_execution_completed'
    );
  });

  it('fails the task when a runner step throws', async () => {
    const harness = await createRuntimeHarness();
    harness.runtime.registerRunner(new FailingRunner());

    const task = await harness.runtime.createTask({
      sessionId: harness.sessionId,
      taskType: 'research_report_basic',
      objective: 'Provocar un fallo'
    });

    const failedTask = await waitForTask(
      harness.taskManager,
      task.id,
      (candidate) => candidate.status === 'failed'
    );

    expect(failedTask.failureReason).toContain('Fallo controlado del runner');
    expect(harness.events.map((event) => event.type)).toContain('task_execution_failed');
  });

  it('pauses active persisted tasks on startup recovery instead of inventing a resume', async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-runtime-sandbox-'));
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-runtime-data-'));
    const taskManager = new FileTaskManager(path.join(dataRoot, 'tasks.json'));
    const sessionStore = new InMemorySessionStore('demo-local');
    const session = await sessionStore.createSession();
    const blueprint = new ResearchReportBasicTaskRunner().createTaskInput({
      sessionId: session.sessionId,
      taskType: 'research_report_basic',
      objective: 'Recuperar tarea tras reinicio'
    });

    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Recuperar tarea tras reinicio',
      ...blueprint,
      status: 'active',
      currentPhase: 'Generar borrador del informe',
      progressPercent: 25,
      currentStepId: 'draft-report'
    });

    const runtime = new TaskRuntimeExecutor({
      taskManager,
      sessionStore,
      memoryBackend: new TestMemoryBackend(),
      toolRegistry: new ToolRegistry(),
      modelRouter: createModelRouter(),
      sandboxRoot,
      dataRoot
    });

    await runtime.recoverTasksOnStartup();

    const recoveredTask = await waitForTask(
      taskManager,
      task.id,
      (candidate) => candidate.status === 'paused'
    );

    expect(recoveredTask.status).toBe('paused');
    expect(recoveredTask.pausedAt).toBeTruthy();
  });
});
