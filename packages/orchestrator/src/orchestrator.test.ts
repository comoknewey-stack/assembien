import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionLogService } from '@assem/action-log';
import { createCalendarTools } from '@assem/integration-calendar';
import { createClockTimeTool } from '@assem/integration-clock-time';
import { createLocalFilesTools } from '@assem/integration-local-files';
import { FileProfileMemoryBackend, InMemorySessionStore } from '@assem/memory';
import { ModelRouter } from '@assem/model-router';
import { PolicyEngine } from '@assem/policy-engine';
import { DemoLocalModelProvider } from '@assem/provider-demo-local';
import { InMemoryTaskManager } from '@assem/task-manager';
import type {
  AssemTask,
  AssemConfig,
  ModelRouter as ModelRouterContract,
  PendingAction,
  TaskExecutionRequest,
  TaskRuntime as TaskRuntimeContract,
  TelemetryRecord,
  TelemetrySink,
  TelemetrySummary,
  WebSearchProvider
} from '@assem/shared-types';
import { ToolRegistry } from '@assem/tool-registry';

import { AssemOrchestrator } from './index';

const FIXED_NOW = new Date('2026-04-14T20:46:00.000Z');

function getLastAssistantMessage(snapshot: {
  messages: Array<{ role: string; content: string }>;
}): string {
  return snapshot.messages.at(-1)?.content ?? '';
}

function getLastTemporalSnapshot(snapshot: {
  operationalContext?: {
    lastTemporalSnapshot?: {
      iso: string;
      timeZone: string;
      utcOffset: string;
    };
  };
}) {
  return snapshot.operationalContext?.lastTemporalSnapshot;
}

function extractClockTime(content: string): string | null {
  return content.match(/\b\d{2}:\d{2}\b/)?.[0] ?? null;
}

function isSnapshotTuesday(snapshot: {
  iso: string;
  timeZone: string;
}): boolean {
  return (
    new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: snapshot.timeZone
    }).format(new Date(snapshot.iso)) === 'Tuesday'
  );
}

function expectSameTemporalValue(
  received:
    | {
        iso: string;
        timeZone: string;
        utcOffset: string;
      }
    | undefined,
  expected: {
    iso: string;
    timeZone: string;
    utcOffset: string;
  }
): void {
  expect(received).toMatchObject({
    iso: expected.iso,
    timeZone: expected.timeZone,
    utcOffset: expected.utcOffset
  });
}

function countTelemetryToolUses(
  telemetry: InMemoryTelemetrySink,
  toolId: string
): number {
  return telemetry.records.filter((record) => record.toolsUsed.includes(toolId)).length;
}

function extractTaskRefinementLabels(task: AssemTask | null | undefined): string[] {
  const refinements =
    (task?.metadata as
      | {
          interruptState?: {
            refinements?: Array<{ label?: string }>;
          };
        }
      | undefined)?.interruptState?.refinements ?? [];

  return refinements
    .map((refinement) => refinement.label)
    .filter((label): label is string => typeof label === 'string');
}

function createTestPendingAction(
  overrides: Partial<PendingAction> = {}
): PendingAction {
  const now = new Date().toISOString();
  return {
    id: 'pending-test',
    toolId: 'local-files.create-entry',
    toolLabel: 'Create local file or folder',
    input: {
      kind: 'file',
      relativePath: 'nota.txt'
    },
    reason: 'Test pending action',
    riskLevel: 'medium',
    permissions: ['write_safe'],
    confirmationMessage: 'Confirma crear el archivo "nota.txt" dentro del sandbox?',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

class InMemoryTelemetrySink implements TelemetrySink {
  readonly records: TelemetryRecord[] = [];

  async record(record: TelemetryRecord): Promise<void> {
    this.records.push(record);
  }

  async list(limit = 50): Promise<TelemetryRecord[]> {
    return this.records.slice(-limit);
  }

  async summarize(limit = 20): Promise<TelemetrySummary> {
    const recent = this.records.slice(-limit);
    return {
      totalInteractions: this.records.length,
      successes: this.records.filter((record) => record.result === 'success').length,
      rejections: this.records.filter((record) => record.result === 'rejected')
        .length,
      errors: this.records.filter((record) => record.result === 'error').length,
      lastInteractionAt: recent.at(-1)?.timestamp,
      lastError: [...recent]
        .reverse()
        .find((record) => record.result === 'error')?.errorMessage,
      recent
    };
  }
}

class TestTaskRuntime implements TaskRuntimeContract {
  constructor(private readonly taskManager: InMemoryTaskManager) {}

  async createTask(request: TaskExecutionRequest): Promise<AssemTask> {
    return this.taskManager.createTask({
      sessionId: request.sessionId,
      objective: request.objective,
      status: request.autoStart === false ? 'pending' : 'active',
      progressPercent: 0,
      currentPhase:
        request.plan?.phases[0]?.label ?? 'Preparando la tarea',
      steps:
        request.plan?.steps.map((step) => ({
          id: step.id,
          label: step.label
        })) ?? [
          {
            id: 'step-prepare',
            label: 'Preparar la tarea'
          },
          {
            id: 'step-draft',
            label: 'Redactar el informe'
          }
        ],
      currentStepId: request.plan?.steps[0]?.id ?? 'step-prepare',
      plan: request.plan,
      metadata: {
        ...(request.metadata ?? {}),
        taskType: request.taskType,
        interruptState: {
          refinements: request.plan?.refinements ?? []
        }
      }
    });
  }

  async startTask(taskId: string): Promise<AssemTask> {
    return this.taskManager.resumeTask(taskId);
  }

  async pauseTask(taskId: string, reason?: string): Promise<AssemTask> {
    return this.taskManager.pauseTask(taskId, reason);
  }

  async resumeTask(taskId: string): Promise<AssemTask> {
    return this.taskManager.resumeTask(taskId);
  }

  async cancelTask(taskId: string, reason?: string): Promise<AssemTask> {
    return this.taskManager.cancelTask(taskId, reason);
  }

  async recoverTasksOnStartup(): Promise<void> {
    return;
  }
}

interface TestOrchestratorOptions {
  configOverrides?: Partial<AssemConfig>;
  modelRouter?: ModelRouterContract;
  webSearchProvider?: WebSearchProvider;
}

function createMockWebSearchProvider(configured = true): WebSearchProvider {
  return {
    id: configured ? 'brave' : 'disabled',
    label: configured ? 'Brave Search' : 'Web search disabled',
    maxResults: 5,
    getStatus() {
      return {
        providerId: this.id,
        configured,
        available: configured,
        maxResults: 5
      };
    },
    async search() {
      throw new Error('Mock web search is not executed by orchestrator tests.');
    }
  };
}

async function createOrchestrator(options: TestOrchestratorOptions = {}) {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-orch-'));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-profiles-'));
  const profileBackend = new FileProfileMemoryBackend(
    path.join(dataRoot, 'profiles.json')
  );
  const telemetry = new InMemoryTelemetrySink();
  const toolRegistry = new ToolRegistry();
  const calendarTools = createCalendarTools();
  const localFilesTools = createLocalFilesTools();
  const taskManager = new InMemoryTaskManager();
  const taskRuntime = new TestTaskRuntime(taskManager);
  const sessionStore = new InMemorySessionStore('demo-local');

  toolRegistry.register(createClockTimeTool());
  toolRegistry.register(localFilesTools[0]);
  toolRegistry.register(localFilesTools[1]);
  toolRegistry.register(localFilesTools[2]);
  toolRegistry.register(calendarTools[0]);
  toolRegistry.register(calendarTools[1]);

  await profileBackend.createProfile({
    name: 'Default profile',
    notes: ['Persistent test profile']
  });

  return {
    taskManager,
    orchestrator: new AssemOrchestrator({
      config: {
        appName: 'ASSEM',
        agentPort: 4318,
        sandboxRoot,
        dataRoot,
        defaultProviderId: 'demo-local',
        providerTimeoutMs: 15_000,
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        ollamaModel: 'llama3.2',
        voiceSttProviderId: 'windows-system-stt',
        voiceTtsProviderId: 'windows-system-tts',
        voiceLanguage: 'es-ES',
        voiceAutoReadResponses: false,
        voiceDebugArtifacts: false,
        voiceModeEnabledByDefault: false,
        wakeWordEnabled: false,
        wakeWord: 'prolijo',
        wakeWordAliases: ['pro lijo', 'polijo', 'prolijos', 'pro li jo'],
        wakeWindowMs: 2_500,
        wakeIntervalMs: 500,
        activeSilenceMs: 2_000,
        activeMaxMs: 30_000,
        activeMinSpeechMs: 800,
        activePrerollMs: 700,
        activePostrollMs: 500,
        wakeDebug: false,
        whisperCppCliPath: undefined,
        whisperCppModelPath: undefined,
        whisperCppThreads: 4,
        whisperCppInitialPrompt: undefined,
        whisperCppBeamSize: undefined,
        webSearchProvider: 'brave',
        webSearchApiKey: 'test-key',
        webSearchEndpoint: 'https://api.search.brave.com/res/v1/web/search',
        webSearchMaxResults: 5,
        webSearchTimeoutMs: 10_000,
        webPageFetchEnabled: true,
        webPageFetchTimeoutMs: 12_000,
        webPageMaxSources: 3,
        webPageMaxContentChars: 20_000,
        webPageMinTextChars: 220,
        webPageMinTextDensity: 0.18,
        webPageMaxLinkDensity: 0.55,
        allowedOrigins: [],
        ...options.configOverrides
      },
      actionLog: new ActionLogService(),
      sessionStore,
      toolRegistry,
      policyEngine: new PolicyEngine(),
      modelRouter:
        options.modelRouter ??
        new ModelRouter([new DemoLocalModelProvider()], 'demo-local'),
      memoryBackend: profileBackend,
      telemetry,
      taskManager,
      taskRuntime,
      webSearchProvider: options.webSearchProvider ?? createMockWebSearchProvider(true)
    }),
    sessionStore,
    sandboxRoot,
    telemetry
  };
}

describe('AssemOrchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers "que hora es" in Spanish using the clock tool snapshot', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hora es'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Son las');
    expect(snapshot.actionLog.some((entry) => entry.kind === 'tool_result')).toBe(
      true
    );
    expect(telemetry.records.at(-1)?.toolsUsed).toContain('clock-time.get-current');
    expect(getLastTemporalSnapshot(snapshot)).toMatchObject({
      iso: FIXED_NOW.toISOString()
    });
  });

  it('forces the clock tool for "que dia es y que hora es"', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que dia es y que hora es'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Son las');
    expect(getLastAssistantMessage(snapshot)).toContain('martes');
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(1);
    expect(snapshot.lastModelInvocation).toBeUndefined();
  });

  it('forces the clock tool for noisy Spanish voice text around "hora actual"', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'verificar ahora actual pero que hora es'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Son las');
    expect(getLastAssistantMessage(snapshot)).toContain('martes');
    expect(getLastAssistantMessage(snapshot)).not.toContain('[verificar hora actual]');
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(1);
    expect(snapshot.lastModelInvocation).toBeUndefined();
  });

  it('answers "como esta" deterministically instead of letting the model invent a time placeholder', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Como esta, por favor'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Hola.');
    expect(getLastAssistantMessage(snapshot)).not.toContain('[verificar hora actual]');
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(0);
    expect(snapshot.lastModelInvocation).toBeUndefined();
  });

  it('does not show model placeholders for time and executes the clock tool instead', async () => {
    const modelRouter: ModelRouterContract = {
      listProviders() {
        return [];
      },
      async healthCheck() {
        return [];
      },
      async respond() {
        return {
          text: 'Estoy funcionando correctamente. La hora actual es [verificar hora actual].',
          confidence: 0.6,
          providerId: 'demo-local',
          model: 'demo-local-heuristic',
          fallbackUsed: false,
          finishReason: 'stop'
        };
      }
    };
    const { orchestrator, telemetry } = await createOrchestrator({
      modelRouter
    });
    const session = await orchestrator.createSession();
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'necesito una respuesta general'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Son las');
    expect(getLastAssistantMessage(snapshot)).not.toContain('[verificar hora actual]');
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(1);
  });

  it('reformulates the same temporal snapshot in Spanish after "en espanol"', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const initial = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'What time is it?'
    });
    const initialMessage = getLastAssistantMessage(initial);
    const initialTemporalSnapshot = {
      ...getLastTemporalSnapshot(initial)!
    };
    const translated = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'en espanol'
    });

    expect(initialMessage).toContain('It is');
    expect(getLastAssistantMessage(translated)).toContain('Son las');
    expectSameTemporalValue(
      getLastTemporalSnapshot(translated),
      initialTemporalSnapshot
    );
    expect(extractClockTime(getLastAssistantMessage(translated))).toBe(
      extractClockTime(initialMessage)
    );
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(1);
  });

  it('reformulates the same temporal snapshot in English after "en ingles"', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const initial = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hora es'
    });
    const initialMessage = getLastAssistantMessage(initial);
    const initialTemporalSnapshot = {
      ...getLastTemporalSnapshot(initial)!
    };
    const translated = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'en ingles'
    });

    expect(initialMessage).toContain('Son las');
    expect(getLastAssistantMessage(translated)).toContain('It is');
    expectSameTemporalValue(
      getLastTemporalSnapshot(translated),
      initialTemporalSnapshot
    );
    expect(extractClockTime(getLastAssistantMessage(translated))).toBe(
      extractClockTime(initialMessage)
    );
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(1);
  });

  it('toggles the same temporal snapshot when the user says "traducelo"', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hora es'
    });
    const english = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'in english'
    });
    const englishMessage = getLastAssistantMessage(english);
    const englishTemporalSnapshot = {
      ...getLastTemporalSnapshot(english)!
    };
    const translatedBack = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'traducelo'
    });

    expect(englishMessage).toContain('It is');
    expect(getLastAssistantMessage(translatedBack)).toContain('Son las');
    expectSameTemporalValue(
      getLastTemporalSnapshot(translatedBack),
      englishTemporalSnapshot
    );
    expect(extractClockTime(getLastAssistantMessage(translatedBack))).toBe(
      extractClockTime(englishMessage)
    );
  });

  it('checks "es martes?" coherently against the previous temporal snapshot', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const initial = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hora es'
    });
    const initialMessage = getLastAssistantMessage(initial);
    const temporalSnapshot = {
      ...getLastTemporalSnapshot(initial)!
    };
    const verification = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'es martes?'
    });

    expectSameTemporalValue(getLastTemporalSnapshot(verification), temporalSnapshot);
    expect(getLastAssistantMessage(verification).startsWith(
      isSnapshotTuesday(temporalSnapshot)
        ? 'Si. Manteniendo el mismo dato temporal'
        : 'No. Manteniendo el mismo dato temporal'
    )).toBe(true);
    expect(extractClockTime(getLastAssistantMessage(verification))).toBe(
      extractClockTime(initialMessage)
    );
  });

  it('keeps the same snapshot when the user challenges the hour manually', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const initial = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hora es'
    });
    const initialTemporalSnapshot = {
      ...getLastTemporalSnapshot(initial)!
    };
    const correction = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'esta mal, es la 1, no las 2'
    });

    expectSameTemporalValue(getLastTemporalSnapshot(correction), initialTemporalSnapshot);
    expect(getLastAssistantMessage(correction)).toContain(initialTemporalSnapshot.timeZone);
    expect(getLastAssistantMessage(correction)).toContain(initialTemporalSnapshot.utcOffset);
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(1);
  });

  it('reuses the current temporal snapshot when the user says "eso esta mal"', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const initial = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hora es'
    });
    const initialMessage = getLastAssistantMessage(initial);
    const initialTemporalSnapshot = {
      ...getLastTemporalSnapshot(initial)!
    };
    const correction = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'eso esta mal'
    });

    expect(getLastAssistantMessage(correction)).toContain(
      'Estoy revisando el mismo dato temporal que acabo de usar'
    );
    expectSameTemporalValue(getLastTemporalSnapshot(correction), initialTemporalSnapshot);
    expect(extractClockTime(getLastAssistantMessage(correction))).toBe(
      extractClockTime(initialMessage)
    );
    expect(countTelemetryToolUses(telemetry, 'clock-time.get-current')).toBe(1);
  });

  it('answers capability questions from real system state instead of scaffold text', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que herramientas y providers tienes'
    });

    expect(getLastAssistantMessage(snapshot)).toContain(
      'ASSEM se esta ejecutando en modo'
    );
    expect(getLastAssistantMessage(snapshot)).toContain(
      'Proveedor configurado por defecto: demo-local'
    );
    expect(getLastAssistantMessage(snapshot)).toContain('hora y fecha actuales');
    expect(getLastAssistantMessage(snapshot)).not.toContain('local scaffold mode');
  });

  it('keeps greetings in Spanish for a Spanish session', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Hola'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Hola.');
    expect(getLastAssistantMessage(snapshot)).not.toContain('Hello');
    expect(getLastAssistantMessage(snapshot)).not.toContain('local scaffold mode');
  });

  it('asks for clarification instead of inventing an answer for ambiguous requests', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'dame la obra que tienes'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('No tengo claro');
    expect(getLastAssistantMessage(snapshot)).toContain('"obra"');
    expect(getLastAssistantMessage(snapshot)).not.toContain('local scaffold mode');
  });

  it.each([
    {
      text: 'Create a file called roadmap in the sandbox',
      expected: {
        kind: 'file',
        relativePath: 'roadmap.txt'
      }
    },
    {
      text: 'Crea un archivo llamado nota.txt en el sandbox',
      expected: {
        kind: 'file',
        relativePath: 'nota.txt'
      }
    },
    {
      text: 'Crea una carpeta llamada proyectos',
      expected: {
        kind: 'directory',
        relativePath: 'proyectos'
      }
    },
    {
      text: 'Crea un archivo de nombre nota.txt',
      expected: {
        kind: 'file',
        relativePath: 'nota.txt'
      }
    },
    {
      text: 'Crea una carpeta con nombre proyectos',
      expected: {
        kind: 'directory',
        relativePath: 'proyectos'
      }
    },
    {
      text: 'crea un archivo que se llame Gayeta',
      expected: {
        kind: 'file',
        relativePath: 'Gayeta.txt'
      }
    },
    {
      text: 'puedes crear un archivo.txt en la carpeta donde estes ahora mismo donde lo puedas crear que se llame Gayeta',
      expected: {
        kind: 'file',
        relativePath: 'Gayeta.txt'
      }
    }
  ])('extracts local-file arguments for "$text"', async ({ text, expected }) => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text
    });

    expect(snapshot.pendingAction?.toolId).toBe('local-files.create-entry');
    expect(snapshot.pendingAction?.input).toEqual(expected);
    expect(snapshot.messages.at(-1)?.content).toContain('Esperando confirmacion');
  });

  it('asks for clarification instead of inventing a file name when none is provided', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'crea un archivo'
    });

    expect(snapshot.pendingAction).toBeNull();
    expect(snapshot.messages.at(-1)?.content).toContain(
      'Necesito el nombre del archivo para prepararlo.'
    );
    expect(snapshot.messages.at(-1)?.content).not.toContain('donde est');
  });

  it('creates a pending action for a new file without executing it immediately', async () => {
    const { orchestrator, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });

    expect(snapshot.pendingAction?.toolId).toBe('local-files.create-entry');
    expect(snapshot.pendingAction?.status).toBe('pending');
    expect(snapshot.messages.at(-1)?.content).toContain('Esperando confirmacion');
    expect(snapshot.messages.at(-1)?.content).not.toContain('He creado');
    await expect(fs.access(path.join(sandboxRoot, 'nota.txt'))).rejects.toThrow();
  });

  it('returns a useful sandbox listing with names and types', async () => {
    const { orchestrator, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await fs.mkdir(path.join(sandboxRoot, 'proyectos'));
    await fs.writeFile(path.join(sandboxRoot, 'nota.txt'), 'hola mundo', 'utf8');

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Lista el sandbox'
    });

    expect(snapshot.messages.at(-1)?.content).toContain('He encontrado 2 elemento(s)');
    expect(snapshot.messages.at(-1)?.content).toContain('[carpeta] proyectos');
    expect(snapshot.messages.at(-1)?.content).toContain('[archivo] nota.txt');
    expect(snapshot.actionLog.some((entry) => entry.kind === 'tool_result')).toBe(
      true
    );
  });

  it('returns the real file contents in chat when reading a sandbox file', async () => {
    const { orchestrator, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await fs.writeFile(path.join(sandboxRoot, 'nota.txt'), 'hola mundo', 'utf8');

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Lee el archivo nota.txt'
    });

    expect(snapshot.messages.at(-1)?.content).toContain('Contenido de "nota.txt"');
    expect(snapshot.messages.at(-1)?.content).toContain('hola mundo');
  });

  it.each([
    'confirmo',
    'confirmo todo',
    'lo confirmo',
    'lo confirmo todo',
    'Lo confirmo, hazlo.',
    'confirmo todo, hazlo',
    'la confirmo',
    'confirmo todas las acciones pendientes',
    'hazlo',
    's\u00ed',
    'confirmar',
    'creala',
    'crea la'
  ])(
    'executes the most recent pending action when the follow-up is "%s"',
    async (followUp) => {
      const { orchestrator, sandboxRoot, telemetry } = await createOrchestrator();
      const session = await orchestrator.createSession();

      const pendingSnapshot = await orchestrator.handleChat({
        sessionId: session.sessionId,
        text: 'Crea un archivo llamado nota.txt en el sandbox'
      });

      expect(pendingSnapshot.pendingAction?.toolId).toBe('local-files.create-entry');

      const snapshot = await orchestrator.handleChat({
        sessionId: session.sessionId,
        text: followUp
      });

      expect(snapshot.pendingAction).toBeNull();
      expect(snapshot.messages.at(-1)?.content).toContain(
        'He creado el archivo "nota.txt" en'
      );
      expect(
        snapshot.actionLog.some((entry) => entry.kind === 'tool_result')
      ).toBe(true);
      expect(telemetry.records.at(-1)?.result).toBe('success');

      const createdFile = await fs.readFile(path.join(sandboxRoot, 'nota.txt'), 'utf8');
      expect(createdFile).toContain('Created by ASSEM');
    }
  );

  it('does not mix waiting-for-confirmation and completed creation in the same transition', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const pendingSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });
    const pendingMessage = pendingSnapshot.messages.at(-1)?.content ?? '';
    const completionSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'confirmo'
    });

    expect(pendingMessage).toContain('Esperando confirmacion');
    expect(pendingMessage).not.toContain('He creado');
    expect(completionSnapshot.messages.at(-1)?.content).toContain('He creado el archivo "nota.txt"');
    expect(completionSnapshot.messages.at(-1)?.content).not.toContain('Esperando confirmacion');
  });

  it('shows the pending-action reminder only when the follow-up is not a valid confirmation or rejection', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'cuentame mas'
    });

    expect(snapshot.pendingAction?.toolId).toBe('local-files.create-entry');
    expect(snapshot.messages.at(-1)?.content).toBe(
      'Todavia hay una accion pendiente esperando confirmacion. Confirmala, rechazala o cancelala antes de iniciar otra accion de escritura.'
    );
  });

  it('does not block the chat with a completed pending-action ghost', async () => {
    const { orchestrator, sessionStore } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const state = await sessionStore.getSession(session.sessionId);

    expect(state).not.toBeNull();
    state!.pendingAction = createTestPendingAction({ status: 'completed' });
    await sessionStore.saveSession(state!);

    const visibleBeforeChat = await orchestrator.getSessionSnapshot(session.sessionId);
    expect(visibleBeforeChat?.pendingAction).toBeNull();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'cuentame mas'
    });
    const sessions = await orchestrator.listSessions();

    expect(snapshot.pendingAction).toBeNull();
    expect(getLastAssistantMessage(snapshot)).not.toContain(
      'Todavia hay una accion pendiente'
    );
    expect(
      sessions.find((entry) => entry.sessionId === session.sessionId)
        ?.hasPendingAction
    ).toBe(false);
  });

  it('does not treat legacy pending-action objects without status as active confirmations', async () => {
    const { orchestrator, sessionStore } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const state = await sessionStore.getSession(session.sessionId);

    expect(state).not.toBeNull();
    const legacyPendingAction = createTestPendingAction();
    delete (legacyPendingAction as Partial<PendingAction>).status;
    state!.pendingAction = legacyPendingAction as PendingAction;
    await sessionStore.saveSession(state!);

    const pendingActions = await orchestrator.listPendingActions(session.sessionId);
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'lo confirmo todo'
    });

    expect(pendingActions).toHaveLength(0);
    expect(snapshot.pendingAction).toBeNull();
    expect(getLastAssistantMessage(snapshot)).toBe(
      'No hay ninguna accion pendiente para confirmar en esta sesion.'
    );
  });

  it('resolves the follow-up "l\u00e9elo" using the last file in session context', async () => {
    const { orchestrator, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await fs.writeFile(path.join(sandboxRoot, 'nota.txt'), 'contenido reutilizable', 'utf8');

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Lee el archivo nota.txt'
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'l\u00e9elo'
    });

    expect(snapshot.messages.at(-1)?.content).toContain('Contenido de "nota.txt"');
    expect(snapshot.messages.at(-1)?.content).toContain('contenido reutilizable');
  });

  it('resolves the follow-up "what items" using the last sandbox listing', async () => {
    const { orchestrator, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await fs.mkdir(path.join(sandboxRoot, 'proyectos'));
    await fs.writeFile(path.join(sandboxRoot, 'nota.txt'), 'hola mundo', 'utf8');

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'List the sandbox'
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'what items'
    });

    expect(snapshot.messages.at(-1)?.content).toContain('[carpeta] proyectos');
    expect(snapshot.messages.at(-1)?.content).toContain('[archivo] nota.txt');
  });

  it('records a rejected pending action in telemetry and history', async () => {
    const { orchestrator, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Create a file called roadmap in the sandbox'
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'no'
    });

    expect(snapshot.messages.at(-1)?.content).toContain('He cancelado');
    expect(snapshot.pendingAction).toBeNull();
    expect(
      snapshot.actionLog.some((entry) => entry.kind === 'tool_rejected')
    ).toBe(true);
    expect(telemetry.records.at(-1)?.result).toBe('rejected');
  });

  it.each(['confirmo', 'hazlo'])(
    'returns a clear message when a confirmation follow-up arrives without a pending action ("%s")',
    async (followUp) => {
      const { orchestrator } = await createOrchestrator();
      const session = await orchestrator.createSession();

      const snapshot = await orchestrator.handleChat({
        sessionId: session.sessionId,
        text: followUp
      });

      expect(snapshot.pendingAction).toBeNull();
      expect(snapshot.messages.at(-1)?.content).toBe(
        'No hay ninguna accion pendiente para confirmar en esta sesion.'
      );
    }
  );

  it('returns a clear message when a listing follow-up arrives without prior context', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hay'
    });

    expect(snapshot.messages.at(-1)?.content).toBe(
      'No tengo un listado reciente del sandbox para mostrar. Pideme primero que liste el sandbox.'
    );
  });

  it('blocks creation before confirmation when the sandbox path already exists', async () => {
    const { orchestrator, sandboxRoot, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await fs.writeFile(path.join(sandboxRoot, 'nota.txt'), 'ya existe', 'utf8');

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });

    expect(snapshot.pendingAction).toBeNull();
    expect(snapshot.messages.at(-1)?.content).toContain(
      'La ruta "nota.txt" ya existe'
    );
    expect(telemetry.records.at(-1)?.result).toBe('error');
  });

  it('creates a clean replacement pending action when the user asks for another name', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });

    const replacementSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'crealo con otro nombre como patata'
    });

    expect(replacementSnapshot.pendingAction?.toolId).toBe('local-files.create-entry');
    expect(replacementSnapshot.pendingAction?.status).toBe('pending');
    expect(replacementSnapshot.pendingAction?.input).toEqual({
      kind: 'file',
      relativePath: 'patata.txt'
    });
    expect(replacementSnapshot.messages.at(-1)?.content).toContain('Esperando confirmacion');
    expect(replacementSnapshot.messages.at(-1)?.content).not.toContain('He creado');
  });

  it('replaces the pending action cleanly when the user says "mejor que se llame patata.txt"', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });

    const replacementSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'mejor que se llame patata.txt'
    });

    expect(replacementSnapshot.pendingAction?.toolId).toBe('local-files.create-entry');
    expect(replacementSnapshot.pendingAction?.input).toEqual({
      kind: 'file',
      relativePath: 'patata.txt'
    });
    expect(replacementSnapshot.messages.at(-1)?.content).toContain('Esperando confirmacion');
  });

  it('keeps the current pending action blocked when a new unrelated write request arrives', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'crea una carpeta llamada proyectos'
    });

    expect(snapshot.pendingAction?.toolId).toBe('local-files.create-entry');
    expect(snapshot.pendingAction?.input).toEqual({
      kind: 'file',
      relativePath: 'nota.txt'
    });
    expect(snapshot.messages.at(-1)?.content).toBe(
      'Todavia hay una accion pendiente esperando confirmacion. Confirmala, rechazala o cancelala antes de iniciar otra accion de escritura.'
    );
  });

  it('can recover from an existing-path preflight error with a new clean pending action', async () => {
    const { orchestrator, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();

    await fs.writeFile(path.join(sandboxRoot, 'nota.txt'), 'ya existe', 'utf8');

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'Crea un archivo llamado nota.txt en el sandbox'
    });

    const replacementSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'crealo con otro nombre como patata'
    });

    expect(replacementSnapshot.pendingAction?.toolId).toBe('local-files.create-entry');
    expect(replacementSnapshot.pendingAction?.input).toEqual({
      kind: 'file',
      relativePath: 'patata.txt'
    });
    expect(replacementSnapshot.messages.at(-1)?.content).toContain('Esperando confirmacion');
  });

  it('reports clearly when there is no active task in the session', async () => {
    const { orchestrator } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const statusSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que estas haciendo'
    });
    const pauseSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'pausa'
    });

    expect(getLastAssistantMessage(statusSnapshot)).toContain(
      'No hay ninguna tarea activa en esta sesion.'
    );
    expect(getLastAssistantMessage(pauseSnapshot)).toContain(
      'No hay ninguna tarea activa en esta sesion.'
    );
  });

  it('creates an active task from chat and reports its real status', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await orchestrator.updateMode({
      sessionId: session.sessionId,
      activeMode: { privacy: 'balanced' }
    });

    const createdSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'abre una tarea para preparar el informe semanal'
    });
    const createdMessage = getLastAssistantMessage(createdSnapshot);
    const activeTask = await taskManager.getActiveTaskForSession(session.sessionId);
    const statusSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que estas haciendo'
    });
    const statusMessage = getLastAssistantMessage(statusSnapshot);

    expect(createdMessage).toContain('He abierto una nueva tarea activa');
    expect(activeTask?.objective).toBe('preparar el informe semanal');
    expect(statusMessage).toContain('preparar el informe semanal');
    expect(statusMessage).toContain('Preparar workspace local');
  });

  it('creates a planned research task from "hazme un informe sobre X" and can answer with the real plan', async () => {
    const { orchestrator, taskManager, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await orchestrator.updateMode({
      sessionId: session.sessionId,
      activeMode: { privacy: 'balanced' }
    });

    const createdSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'hazme un informe sobre riesgos operativos'
    });
    const createdMessage = getLastAssistantMessage(createdSnapshot);
    const activeTask = await taskManager.getActiveTaskForSession(session.sessionId);
    const planSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'cual es el plan'
    });

    expect(createdMessage).toContain('He abierto una nueva tarea activa');
    expect(activeTask?.plan?.taskType).toBe('research_report_basic');
    expect(activeTask?.plan?.steps.map((step) => step.id)).toEqual([
      'prepare-workspace',
      'search-web',
      'select-sources',
      'fetch-pages',
      'extract-evidence',
      'synthesize-findings',
      'write-report',
      'write-summary',
      'write-sources',
      'write-evidence'
    ]);
    expect(getLastAssistantMessage(planSnapshot)).toContain('research_report_basic');
    expect(getLastAssistantMessage(planSnapshot)).toContain(
      'Preparar carpeta de trabajo'
    );
    expect(
      telemetry.records.some((record) => record.eventType === 'task_plan_created')
    ).toBe(true);
    expect(
      telemetry.records.some((record) => record.eventType === 'task_plan_applied')
    ).toBe(true);
  });

  it('blocks research in local_only before creating a task', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'hazme un informe sobre el consumo de galletas en Islandia'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('modo local_only');
    expect(await taskManager.getActiveTaskForSession(session.sessionId)).toBeNull();
  });

  it('blocks research before creating a task when web search is not configured', async () => {
    const { orchestrator, taskManager } = await createOrchestrator({
      webSearchProvider: createMockWebSearchProvider(false)
    });
    const session = await orchestrator.createSession();
    await orchestrator.updateMode({
      sessionId: session.sessionId,
      activeMode: { privacy: 'balanced' }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'investiga el consumo de galletas en Islandia'
    });

    expect(getLastAssistantMessage(snapshot)).toContain(
      'provider de busqueda web configurado'
    );
    expect(await taskManager.getActiveTaskForSession(session.sessionId)).toBeNull();
  });

  it('rejects unsupported open tasks honestly instead of inventing a plan', async () => {
    const { orchestrator, taskManager, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'abre una tarea para organizar archivos del proyecto'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('research_report_basic');
    expect(await taskManager.getActiveTaskForSession(session.sessionId)).toBeNull();
    expect(
      telemetry.records.some((record) => record.eventType === 'task_plan_rejected')
    ).toBe(true);
  });

  it('answers progress, phase and pause-resume-cancel commands from the real task state', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe semanal',
      status: 'active',
      progressPercent: 35,
      currentPhase: 'Recopilando notas',
      steps: [
        {
          id: 'step-collect',
          label: 'Recopilar notas'
        }
      ],
      currentStepId: 'step-collect'
    });

    const progressSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'cuanto te queda'
    });
    const progressMessage = getLastAssistantMessage(progressSnapshot);
    const stepSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'en que vas'
    });
    const stepMessage = getLastAssistantMessage(stepSnapshot);
    const pausedSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'pausa'
    });
    const pausedMessage = getLastAssistantMessage(pausedSnapshot);
    const pausedStatus = (await taskManager.getTask(task.id))?.status;
    const resumedSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'reanuda'
    });
    const resumedMessage = getLastAssistantMessage(resumedSnapshot);
    const resumedStatus = (await taskManager.getTask(task.id))?.status;
    const cancelledSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'cancela'
    });
    const cancelledMessage = getLastAssistantMessage(cancelledSnapshot);

    expect(progressMessage).toContain('35%');
    expect(progressMessage).toContain('65%');
    expect(stepMessage).toContain('Recopilar notas');
    expect(pausedMessage).toContain('He pausado la tarea');
    expect(pausedStatus).toBe('paused');
    expect(resumedMessage).toContain('He reanudado la tarea');
    expect(resumedStatus).toBe('active');
    expect(cancelledMessage).toContain('He cancelado la tarea');
    expect(await taskManager.getActiveTaskForSession(session.sessionId)).toBeNull();
  });

  it('answers source queries from persisted research metadata', async () => {
    const { orchestrator, taskManager, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const retrievedAt = new Date().toISOString();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 45,
      currentPhase: 'Seleccionar fuentes',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de galletas Islandia',
          providerId: 'brave',
          retrievedAt,
          searchedAt: retrievedAt,
          sourcesFound: [
            {
              id: 'source-1',
              title: 'Statistics Iceland',
              url: 'https://statice.is/example',
              normalizedUrl: 'https://statice.is/example',
              domain: 'statice.is',
              retrievedAt,
              selectionStatus: 'selected',
              selectionReason: 'matched_query'
            }
          ],
          sourcesSelected: [
            {
              id: 'source-1',
              title: 'Statistics Iceland',
              url: 'https://statice.is/example',
              normalizedUrl: 'https://statice.is/example',
              domain: 'statice.is',
              retrievedAt,
              selectionStatus: 'selected',
              selectionReason: 'matched_query'
            }
          ],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: []
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que fuentes has encontrado'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Statistics Iceland');
    expect(getLastAssistantMessage(snapshot)).toContain('statice.is');
    expect(getLastAssistantMessage(snapshot)).toContain('https://statice.is/example');
    expect(
      telemetry.records.some((record) => record.eventType === 'task_interrupt_sources_query')
    ).toBe(true);
  });

  it('answers progress for a failed research task from persisted failure state without inventing sources', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const searchedAt = new Date().toISOString();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas en Islandia',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Buscar fuentes web',
      steps: [
        {
          id: 'search-web',
          label: 'Buscar fuentes web'
        }
      ],
      currentStepId: 'search-web',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de galletas Islandia',
          providerId: 'brave',
          searchedAt,
          retrievedAt: searchedAt,
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          searchError: 'Brave Search timeout'
        }
      }
    });
    await taskManager.failTask(task.id, 'search-web failed');

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'como va la tarea'
    });
    const message = getLastAssistantMessage(snapshot);

    expect(await taskManager.getActiveTaskForSession(session.sessionId)).toBeNull();
    expect(message).toContain('Brave Search timeout');
    expect(message).toContain('No hay report.md registrado');
    expect(message).toContain('Fuentes persistidas: 0 seleccionada');
    expect(message).not.toContain('New York Times');
    expect(message).not.toContain('Euromonitor');
  });

  it('does not claim a failed research report is ready when no report artifact exists', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const searchedAt = new Date().toISOString();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas en Islandia',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Buscar fuentes web',
      steps: [
        {
          id: 'search-web',
          label: 'Buscar fuentes web'
        }
      ],
      currentStepId: 'search-web',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de galletas Islandia',
          providerId: 'brave',
          searchedAt,
          retrievedAt: searchedAt,
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          searchError: 'Provider not configured'
        }
      }
    });
    await taskManager.failTask(task.id, 'search-web failed');

    const doneSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'ya esta?'
    });
    const doneMessage = getLastAssistantMessage(doneSnapshot);
    const locationSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'donde esta el informe?'
    });
    const locationMessage = getLastAssistantMessage(locationSnapshot);

    expect(doneMessage).toContain('No.');
    expect(doneMessage).toContain('No hay artefacto de informe registrado');
    expect(locationMessage).toContain('No se genero report.md');
    expect(locationMessage).toContain('Provider not configured');
  });

  it('does not present a workspace folder as a final report artifact', async () => {
    const { orchestrator, taskManager, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const workspacePath = path.join(sandboxRoot, 'research-galletas');
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 10,
      currentPhase: 'Preparar workspace local',
      metadata: {
        taskType: 'research_report_basic'
      }
    });
    await taskManager.attachArtifact(task.id, {
      kind: 'directory',
      label: 'Carpeta de trabajo',
      filePath: workspacePath
    });

    const reportSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'donde esta el informe?'
    });
    const reportMessage = getLastAssistantMessage(reportSnapshot);
    const workspaceSnapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'donde esta la carpeta de trabajo?'
    });
    const workspaceMessage = getLastAssistantMessage(workspaceSnapshot);

    expect(reportMessage).toContain(
      'No hay ningun artefacto report.md registrado'
    );
    expect(reportMessage).toContain(workspacePath);
    expect(workspaceMessage).toContain(workspacePath);
    expect(workspaceMessage).not.toContain('report.md');
  });

  it('returns the exact persisted report path for a completed research task', async () => {
    const { orchestrator, taskManager, sandboxRoot } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const reportPath = path.join(sandboxRoot, 'research-galletas', 'report.md');
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 90,
      currentPhase: 'Guardar informe',
      metadata: {
        taskType: 'research_report_basic'
      }
    });
    await taskManager.attachArtifact(task.id, {
      kind: 'report',
      label: 'Informe principal',
      filePath: reportPath,
      contentType: 'text/markdown'
    });
    await taskManager.completeTask(task.id);

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'donde esta el informe?'
    });

    expect(getLastAssistantMessage(snapshot)).toContain(reportPath);
    expect(getLastAssistantMessage(snapshot)).toContain('El informe registrado');
  });

  it('answers source queries honestly when research has no selected sources', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const retrievedAt = new Date().toISOString();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 45,
      currentPhase: 'Seleccionar fuentes',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de galletas Islandia',
          providerId: 'brave',
          retrievedAt,
          searchedAt: retrievedAt,
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: []
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que fuentes has encontrado?'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('No hay fuentes seleccionadas');
    expect(getLastAssistantMessage(snapshot)).toContain('Resultados encontrados persistidos: 0');
  });

  it('answers "que fuentes has leido de verdad" from persisted page-read state', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre refrescos',
      status: 'active',
      progressPercent: 60,
      currentPhase: 'Leer paginas seleccionadas',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de refrescos usa',
          providerId: 'brave',
          retrievedAt: new Date().toISOString(),
          searchedAt: new Date().toISOString(),
          sourcesFound: [],
          sourcesSelected: [
            {
              id: 'src-1',
              title: 'USDA food data',
              url: 'https://www.usda.gov/food-data',
              normalizedUrl: 'https://www.usda.gov/food-data',
              domain: 'usda.gov',
              selectionStatus: 'selected',
              selectionReason: 'official_preferred',
              fetchAttempted: true,
              fetchStatus: 'ok',
              evidenceLevel: 'page_read',
              evidenceStrength: 'strong',
              evidenceRelevance: 'direct',
              readQuality: 'high',
              usedAs: 'page_read'
            }
          ],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          pagesFetched: [
            {
              sourceId: 'src-1',
              url: 'https://www.usda.gov/food-data',
              fetchedAt: new Date().toISOString(),
              fetchStatus: 'ok',
              contentType: 'text/html'
            }
          ],
          evidence: []
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que fuentes has leido de verdad'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('USDA food data');
    expect(getLastAssistantMessage(snapshot)).toContain('usda.gov');
    expect(getLastAssistantMessage(snapshot)).toContain('https://www.usda.gov/food-data');
  });

  it('answers "que fuentes tienen evidencia fuerte" from persisted evidence strength', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre refrescos',
      status: 'active',
      progressPercent: 72,
      currentPhase: 'Extraer evidencia',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de refrescos usa',
          providerId: 'brave',
          retrievedAt: new Date().toISOString(),
          searchedAt: new Date().toISOString(),
          sourcesFound: [],
          sourcesSelected: [
            {
              id: 'src-strong',
              title: 'USDA food data',
              url: 'https://www.usda.gov/food-data',
              normalizedUrl: 'https://www.usda.gov/food-data',
              domain: 'usda.gov',
              selectionStatus: 'selected',
              selectionReason: 'official_preferred',
              evidenceLevel: 'page_read',
              evidenceStrength: 'strong',
              evidenceRelevance: 'direct',
              readQuality: 'high',
              usedAs: 'page_read'
            },
            {
              id: 'src-weak',
              title: 'Packaging market blog',
              url: 'https://example.org/packaging',
              normalizedUrl: 'https://example.org/packaging',
              domain: 'example.org',
              selectionStatus: 'selected',
              selectionReason: 'selected_tangential',
              evidenceLevel: 'snippet_only',
              evidenceStrength: 'tangential',
              evidenceRelevance: 'tangential',
              usedAs: 'snippet_only'
            }
          ],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          evidenceStrength: 'strong'
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que fuentes tienen evidencia fuerte'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('USDA food data');
    expect(getLastAssistantMessage(snapshot)).toContain('strength: strong');
    expect(getLastAssistantMessage(snapshot)).not.toContain('Packaging market blog');
  });

  it('answers "que fuentes usaste solo como snippet" from persisted snippet-only state', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre refrescos',
      status: 'active',
      progressPercent: 65,
      currentPhase: 'Extraer evidencia',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de refrescos usa',
          providerId: 'brave',
          retrievedAt: new Date().toISOString(),
          searchedAt: new Date().toISOString(),
          sourcesFound: [],
          sourcesSelected: [
            {
              id: 'src-2',
              title: 'Market overview',
              url: 'https://example.org/overview',
              normalizedUrl: 'https://example.org/overview',
              domain: 'example.org',
              selectionStatus: 'selected',
              selectionReason: 'matched_query',
              evidenceLevel: 'snippet_only',
              usedAs: 'snippet_only',
              snippet: 'Snippet persisted for evidence.'
            }
          ],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: []
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que fuentes usaste solo como snippet'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Market overview');
    expect(getLastAssistantMessage(snapshot)).toContain('example.org');
  });

  it('answers "que evidencia tienes" from persisted evidence records', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre refrescos',
      status: 'active',
      progressPercent: 75,
      currentPhase: 'Sintetizar hallazgos',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de refrescos usa',
          providerId: 'brave',
          retrievedAt: new Date().toISOString(),
          searchedAt: new Date().toISOString(),
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          evidence: [
            {
              id: 'ev-1',
              sourceId: 'src-1',
              sourceTitle: 'USDA food data',
              sourceUrl: 'https://www.usda.gov/food-data',
              sourceDomain: 'usda.gov',
              evidenceLevel: 'page_read',
              evidenceStrength: 'strong',
              evidenceRelevance: 'direct',
              basis: 'page_content',
              summary: 'USDA data indicates category-level beverage consumption trends.',
              facts: ['USDA data indicates category-level beverage consumption trends.'],
              extractedAt: new Date().toISOString()
            }
          ]
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que evidencia tienes'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('USDA food data');
    expect(getLastAssistantMessage(snapshot)).toContain('page_content');
    expect(getLastAssistantMessage(snapshot)).toContain('beverage consumption trends');
  });

  it('answers "que limitaciones tiene este informe" from persisted research limitations', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre refrescos',
      status: 'active',
      progressPercent: 80,
      currentPhase: 'Sintetizar hallazgos',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de refrescos usa',
          providerId: 'brave',
          retrievedAt: new Date().toISOString(),
          searchedAt: new Date().toISOString(),
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [
            'Parte del informe se apoya en snippets y fuentes tangenciales.',
            'Solo una pagina se pudo leer con calidad media.'
          ],
          evidenceStrength: 'weak'
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que limitaciones tiene este informe'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('snippets y fuentes tangenciales');
    expect(getLastAssistantMessage(snapshot)).toContain('calidad media');
  });

  it('answers "que fuentes descartaste" from persisted discarded sources', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre refrescos',
      status: 'active',
      progressPercent: 55,
      currentPhase: 'Seleccionar fuentes',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de refrescos usa',
          providerId: 'brave',
          retrievedAt: new Date().toISOString(),
          searchedAt: new Date().toISOString(),
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [
            {
              id: 'src-3',
              title: 'Personal beverage blog',
              url: 'https://beverageblog.example/post',
              normalizedUrl: 'https://beverageblog.example/post',
              domain: 'beverageblog.example',
              selectionStatus: 'discarded',
              selectionReason: 'blog_excluded'
            }
          ],
          selectionNotes: [],
          limitations: []
        }
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que fuentes descartaste'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Personal beverage blog');
    expect(getLastAssistantMessage(snapshot)).toContain('blog_excluded');
  });

  it('answers source queries with the persisted search error when research failed', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const searchedAt = new Date().toISOString();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Buscar fuentes web',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de galletas Islandia',
          providerId: 'brave',
          retrievedAt: searchedAt,
          searchedAt,
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          searchError: 'Network error'
        }
      }
    });
    await taskManager.failTask(task.id, 'search-web failed');

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que fuentes has encontrado?'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('La busqueda fallo: Network error');
    expect(getLastAssistantMessage(snapshot)).toContain('No voy a inventar fuentes');
  });

  it('does not pretend to apply source refinements to a failed research task', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const searchedAt = new Date().toISOString();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Buscar fuentes web',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de galletas Islandia',
          providerId: 'brave',
          retrievedAt: searchedAt,
          searchedAt,
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          searchError: 'Network error'
        }
      }
    });
    await taskManager.failTask(task.id, 'search-web failed');

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'usa fuentes oficiales'
    });
    const failedTask = await taskManager.getTask(task.id);

    expect(getLastAssistantMessage(snapshot)).toContain('No he aplicado');
    expect(getLastAssistantMessage(snapshot)).toContain('Network error');
    expect(extractTaskRefinementLabels(failedTask)).not.toContain(
      'Priorizar fuentes oficiales'
    );
  });

  it('still lets independent questions go to the model after a failed task', async () => {
    const modelRouter: ModelRouterContract = {
      listProviders() {
        return [];
      },
      async healthCheck() {
        return [];
      },
      async respond() {
        return {
          text: 'Respuesta libre desde el modelo.',
          confidence: 0.7,
          providerId: 'demo-local',
          model: 'demo-local-heuristic',
          fallbackUsed: false,
          finishReason: 'stop'
        };
      }
    };
    const { orchestrator, taskManager } = await createOrchestrator({
      modelRouter
    });
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Buscar fuentes web',
      metadata: {
        taskType: 'research_report_basic',
        research: {
          query: 'consumo de galletas Islandia',
          providerId: 'brave',
          sourcesFound: [],
          sourcesSelected: [],
          sourcesDiscarded: [],
          selectionNotes: [],
          limitations: [],
          searchError: 'Network error'
        }
      }
    });
    await taskManager.failTask(task.id, 'search-web failed');

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'cuentame una curiosidad'
    });

    expect(getLastAssistantMessage(snapshot)).toBe('Respuesta libre desde el modelo.');
  });

  it('keeps the active task intact while answering an independent question like "que hora es"', async () => {
    const { orchestrator, taskManager, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe semanal',
      status: 'active',
      progressPercent: 35,
      currentPhase: 'Recopilando notas',
      steps: [
        {
          id: 'step-collect',
          label: 'Recopilar notas'
        }
      ],
      currentStepId: 'step-collect',
      metadata: {
        taskType: 'research_report_basic'
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'que hora es'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('Son las');
    expect((await taskManager.getActiveTaskForSession(session.sessionId))?.id).toBe(
      task.id
    );
    expect(
      telemetry.records.some(
        (record) => record.eventType === 'task_interrupt_independent_query'
      )
    ).toBe(true);
  });

  it('stores a simple refinement for "hazlo más corto" on the active task', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe semanal',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Generando borrador',
      steps: [
        {
          id: 'prepare-workspace',
          label: 'Preparar carpeta'
        },
        {
          id: 'draft-report',
          label: 'Generar borrador'
        }
      ],
      currentStepId: 'draft-report',
      metadata: {
        taskType: 'research_report_basic'
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'hazlo más corto'
    });
    const updatedTask = await taskManager.getTask(task.id);

    expect(getLastAssistantMessage(snapshot)).toContain('mas corto');
    expect(extractTaskRefinementLabels(updatedTask)).toContain('Salida mas corta');
    expect(updatedTask?.plan?.restrictions.join(' ')).toContain('Longitud de salida');
  });

  it('stores a language refinement for "hazlo en inglés" on the active task', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe semanal',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Generando borrador',
      steps: [
        {
          id: 'prepare-workspace',
          label: 'Preparar carpeta'
        },
        {
          id: 'draft-report',
          label: 'Generar borrador'
        }
      ],
      currentStepId: 'draft-report',
      metadata: {
        taskType: 'research_report_basic'
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'hazlo en inglés'
    });
    const updatedTask = await taskManager.getTask(task.id);

    expect(getLastAssistantMessage(snapshot)).toContain('ingles');
    expect(extractTaskRefinementLabels(updatedTask)).toContain('Salida en ingles');
    expect(updatedTask?.plan?.restrictions.join(' ')).toContain('Idioma de salida');
  });

  it('stores source refinements for active research tasks', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe sobre galletas',
      status: 'active',
      progressPercent: 20,
      currentPhase: 'Buscar fuentes web',
      steps: [
        {
          id: 'search-web',
          label: 'Buscar fuentes web'
        }
      ],
      currentStepId: 'search-web',
      metadata: {
        taskType: 'research_report_basic'
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'usa fuentes oficiales'
    });
    const updatedTask = await taskManager.getTask(task.id);

    expect(getLastAssistantMessage(snapshot)).toContain('fuentes');
    expect(extractTaskRefinementLabels(updatedTask)).toContain(
      'Priorizar fuentes oficiales'
    );
    expect(updatedTask?.plan?.restrictions.join(' ')).toContain('Fuentes');
  });

  it('reorders the pending plan when the user says "primero dame un resumen"', async () => {
    const { orchestrator, taskManager } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe semanal',
      status: 'active',
      progressPercent: 25,
      currentPhase: 'Generando borrador',
      steps: [
        {
          id: 'prepare-workspace',
          label: 'Preparar carpeta'
        },
        {
          id: 'draft-report',
          label: 'Generar borrador'
        },
        {
          id: 'write-report',
          label: 'Guardar informe'
        },
        {
          id: 'write-summary',
          label: 'Guardar resumen'
        }
      ],
      currentStepId: 'draft-report',
      metadata: {
        taskType: 'research_report_basic'
      }
    });

    await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'primero dame un resumen'
    });
    const updatedTask = await taskManager.getTask(task.id);

    expect(updatedTask?.plan?.steps.map((step) => step.id)).toEqual([
      'prepare-workspace',
      'search-web',
      'select-sources',
      'fetch-pages',
      'extract-evidence',
      'synthesize-findings',
      'write-summary',
      'write-report',
      'write-sources',
      'write-evidence'
    ]);
  });

  it('asks for clarification when the user says "eso no era lo que quería"', async () => {
    const { orchestrator, taskManager, telemetry } = await createOrchestrator();
    const session = await orchestrator.createSession();
    const task = await taskManager.createTask({
      sessionId: session.sessionId,
      objective: 'Preparar informe semanal',
      status: 'active',
      currentPhase: 'Generando borrador',
      metadata: {
        taskType: 'research_report_basic'
      }
    });

    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'eso no era lo que quería'
    });

    expect(getLastAssistantMessage(snapshot)).toContain('que cambio quieres');
    expect((await taskManager.getActiveTaskForSession(session.sessionId))?.id).toBe(
      task.id
    );
    expect(
      telemetry.records.some(
        (record) => record.eventType === 'task_interrupt_clarification'
      )
    ).toBe(true);
  });

  it('records provider, model and fallback details in telemetry when the router falls back', async () => {
    const modelRouter: ModelRouterContract = {
      listProviders() {
        return [
          {
            id: 'ollama',
            label: 'Ollama local provider',
            configured: true,
            defaultModel: 'llama3.2',
            supportsLocalOnly: true,
            capabilities: ['chat', 'tool_reasoning', 'telemetry'],
            supportsPrivacyModes: [
              'local_only',
              'prefer_local',
              'balanced',
              'cloud_allowed'
            ]
          },
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
      async healthCheck() {
        return [
          {
            providerId: 'ollama',
            label: 'Ollama local provider',
            status: 'unavailable',
            checkedAt: new Date().toISOString(),
            error: 'Unable to reach Ollama at http://127.0.0.1:11434.',
            configured: true,
            supportsLocalOnly: true,
            defaultModel: 'llama3.2',
            capabilities: ['chat', 'tool_reasoning', 'telemetry'],
            supportsPrivacyModes: [
              'local_only',
              'prefer_local',
              'balanced',
              'cloud_allowed'
            ]
          },
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
      async respond() {
        return {
          text: 'Fallback reply from demo-local.',
          confidence: 0.72,
          providerId: 'demo-local',
          model: 'demo-local-heuristic',
          fallbackUsed: true,
          fallbackReason:
            'ollama: Unable to reach Ollama at http://127.0.0.1:11434.',
          usage: {
            latencyMs: 12,
            estimatedCostUsd: 0,
            fallbackReason:
              'ollama: Unable to reach Ollama at http://127.0.0.1:11434.'
          },
          finishReason: 'fallback'
        };
      }
    };

    const { orchestrator, telemetry } = await createOrchestrator({
      configOverrides: {
        defaultProviderId: 'ollama'
      },
      modelRouter
    });
    const session = await orchestrator.createSession();
    const snapshot = await orchestrator.handleChat({
      sessionId: session.sessionId,
      text: 'necesito una respuesta general'
    });

    expect(snapshot.lastModelInvocation?.providerId).toBe('demo-local');
    expect(snapshot.lastModelInvocation?.model).toBe('demo-local-heuristic');
    expect(snapshot.lastModelInvocation?.fallbackUsed).toBe(true);
    expect(snapshot.lastModelInvocation?.fallbackReason).toContain('ollama');

    expect(telemetry.records.at(-1)).toMatchObject({
      providerId: 'demo-local',
      model: 'demo-local-heuristic',
      fallbackUsed: true
    });
    expect(telemetry.records.at(-1)?.fallbackReason).toContain('ollama');
  });
});
