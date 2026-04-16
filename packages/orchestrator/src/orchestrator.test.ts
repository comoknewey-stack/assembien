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
import type {
  AssemConfig,
  ModelRouter as ModelRouterContract,
  TelemetryRecord,
  TelemetrySink,
  TelemetrySummary
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

interface TestOrchestratorOptions {
  configOverrides?: Partial<AssemConfig>;
  modelRouter?: ModelRouterContract;
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
        whisperCppCliPath: undefined,
        whisperCppModelPath: undefined,
        whisperCppThreads: 4,
        allowedOrigins: [],
        ...options.configOverrides
      },
      actionLog: new ActionLogService(),
      sessionStore: new InMemorySessionStore('demo-local'),
      toolRegistry,
      policyEngine: new PolicyEngine(),
      modelRouter:
        options.modelRouter ??
        new ModelRouter([new DemoLocalModelProvider()], 'demo-local'),
      memoryBackend: profileBackend,
      telemetry
    }),
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
