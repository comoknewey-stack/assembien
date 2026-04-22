import { createServer } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import { ActionLogService } from '@assem/action-log';
import { createAssemConfig } from '@assem/config';
import { createCalendarTools } from '@assem/integration-calendar';
import { createClockTimeTool } from '@assem/integration-clock-time';
import { createLocalFilesTools } from '@assem/integration-local-files';
import {
  createSessionStorePaths,
  FileProfileMemoryBackend,
  FileSessionStore,
  summarizeProfile
} from '@assem/memory';
import { ModelRouter } from '@assem/model-router';
import { AssemOrchestrator } from '@assem/orchestrator';
import { DeterministicTaskPlanner } from '@assem/planner';
import { ensureDirectory } from '@assem/persistence';
import { PolicyEngine } from '@assem/policy-engine';
import { DemoLocalModelProvider } from '@assem/provider-demo-local';
import { OllamaModelProvider } from '@assem/provider-ollama';
import { BasicScheduler } from '@assem/scheduler';
import type {
  ActionHistoryResponse,
  ActiveTaskResponse,
  AgentHealthSnapshot,
  ChatRequest,
  ModeUpdateRequest,
  OverrideCreateRequest,
  PendingActionResolutionRequest,
  ProviderRuntimeStatus,
  ProfileCreateInput,
  ProfileImportPayload,
  SchedulerRunContext,
  ScheduledTask,
  ScheduledTaskInput,
  SystemStateSnapshot,
  TaskArtifactInput,
  TaskCreateInput,
  TaskCreateResponse,
  TaskExecutionRequest,
  TaskExecutionResponse,
  TaskManagerEvent,
  TaskPhaseAdvanceInput,
  TaskPlanResponse,
  TaskProgressUpdateInput,
  TaskResponse,
  TaskRuntimeEvent,
  TasksResponse,
  TelemetryRecord,
  TelemetrySink,
  VoiceActiveListeningStartRequest,
  VoiceActiveListeningStateRequest,
  VoiceActiveListeningStopRequest,
  VoiceModeUpdateRequest,
  VoiceRecordingRequest,
  VoiceRecordingStopRequest,
  VoiceSettingsUpdateRequest,
  VoiceSpeakRequest,
  VoiceWakeWindowRequest
} from '@assem/shared-types';
import { FileTaskManager } from '@assem/task-manager';
import { TaskRuntimeExecutor } from '@assem/task-runtime';
import { FileTelemetrySink } from '@assem/telemetry';
import { ToolRegistry } from '@assem/tool-registry';

import { VoiceCoordinator } from './voice/controller';
import {
  WindowsTextToSpeechProvider
} from './voice/powershell-provider';
import { WhisperCppSpeechToTextProvider } from './voice/whispercpp-provider';

type IncomingMessage = import('node:http').IncomingMessage;
type ServerResponse = import('node:http').ServerResponse;

interface EventSubscriber {
  response: ServerResponse;
  sessionId: string | null;
}

const config = createAssemConfig();
const startedAt = Date.now();

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-secret]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [redacted]');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resolveTaskRuntimeInvocation(
  metadata: Record<string, unknown> | undefined
): {
  providerId?: string;
  model?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
} {
  if (!metadata || !isObjectRecord(metadata.runtimeModelInvocation)) {
    return {};
  }

  const invocation = metadata.runtimeModelInvocation;
  return {
    providerId:
      typeof invocation.providerId === 'string' ? invocation.providerId : undefined,
    model: typeof invocation.model === 'string' ? invocation.model : undefined,
    fallbackUsed:
      typeof invocation.fallbackUsed === 'boolean'
        ? invocation.fallbackUsed
        : undefined,
    fallbackReason:
      typeof invocation.fallbackReason === 'string'
        ? invocation.fallbackReason
        : undefined
  };
}

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  return config.allowedOrigins.includes(origin);
}

function writeHead(
  response: ServerResponse,
  statusCode: number,
  origin: string | undefined,
  extraHeaders: Record<string, string> = {}
): void {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders
  };

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  response.writeHead(statusCode, headers);
}

function writeJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  writeHead(response, statusCode, request.headers.origin, {
    'Content-Type': 'application/json'
  });
  response.end(json(payload));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of request) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += next.length;

    if (totalLength > 1_000_000) {
      throw new Error('Request body too large.');
    }

    chunks.push(next);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

async function main() {
  await ensureDirectory(config.dataRoot);
  await ensureDirectory(config.sandboxRoot);

  const paths = createSessionStorePaths(config.dataRoot);
  const telemetryFilePath = path.join(config.dataRoot, 'telemetry.jsonl');
  const schedulerFilePath = path.join(config.dataRoot, 'scheduler.json');
  const taskManagerFilePath = path.join(config.dataRoot, 'tasks.json');
  const voiceSettingsFilePath = path.join(config.dataRoot, 'voice-settings.json');

  const toolRegistry = new ToolRegistry();
  const [listCalendarTool, createCalendarTool] = createCalendarTools();
  const [listSandboxTool, readSandboxTool, createSandboxTool] =
    createLocalFilesTools();

  toolRegistry.register(createClockTimeTool());
  toolRegistry.register(listSandboxTool);
  toolRegistry.register(readSandboxTool);
  toolRegistry.register(createSandboxTool);
  toolRegistry.register(listCalendarTool);
  toolRegistry.register(createCalendarTool);

  const sessionStore = new FileSessionStore(
    paths.sessionsFilePath,
    config.defaultProviderId
  );
  const memoryBackend = new FileProfileMemoryBackend(paths.profilesFilePath);
  const telemetry: TelemetrySink = new FileTelemetrySink(telemetryFilePath);
  let notifySystemStateChanged = async () => {};
  const taskManager = new FileTaskManager(taskManagerFilePath, {
    onEvent: async (event: TaskManagerEvent) => {
      const session = await sessionStore.getSession(event.task.sessionId);
      const result =
        event.type === 'task_failed'
          ? 'error'
          : event.type === 'task_cancelled'
            ? 'rejected'
            : 'success';
      const record: TelemetryRecord = {
        id: crypto.randomUUID(),
        timestamp: event.timestamp,
        sessionId: event.task.sessionId,
        providerId: 'task-manager',
        model: 'task-manager',
        channel: 'task_manager',
        privacyMode: session?.activeMode.privacy ?? 'local_only',
        runtimeMode: session?.activeMode.runtime ?? 'sandbox',
        totalDurationMs: 0,
        toolsUsed: [],
        confirmationRequired: false,
        result,
        errorMessage:
          event.type === 'task_failed'
            ? event.task.failureReason ?? event.detail
            : undefined,
        toolCount: 0,
        messagePreview: event.task.objective,
        eventType: event.type,
        taskId: event.task.id,
        taskStatus: event.task.status
      };

      await telemetry.record(record);
      await notifySystemStateChanged();
    }
  });
  const modelRouter = new ModelRouter(
    [
      new OllamaModelProvider({
        baseUrl: config.ollamaBaseUrl,
        defaultModel: config.ollamaModel,
        timeoutMs: config.providerTimeoutMs
      }),
      new DemoLocalModelProvider()
    ],
    config.defaultProviderId,
    {
      providerTimeoutMs: config.providerTimeoutMs
    }
  );
  const actionLog = new ActionLogService();
  const planner = new DeterministicTaskPlanner();
  const taskRuntime = new TaskRuntimeExecutor(
    {
      taskManager,
      sessionStore,
      memoryBackend,
      toolRegistry,
      modelRouter,
      sandboxRoot: config.sandboxRoot,
      dataRoot: config.dataRoot
    },
    {
      onEvent: async (event: TaskRuntimeEvent) => {
        const session = await sessionStore.getSession(event.task.sessionId);
        const invocation = resolveTaskRuntimeInvocation(event.task.metadata);
        const result =
          event.type === 'task_execution_failed'
            ? 'error'
            : event.type === 'task_execution_cancelled'
              ? 'rejected'
              : 'success';
        const record: TelemetryRecord = {
          id: crypto.randomUUID(),
          timestamp: event.timestamp,
          sessionId: event.task.sessionId,
          providerId: invocation.providerId ?? 'task-runtime',
          model: invocation.model ?? 'task-runtime',
          channel: 'task_runtime',
          privacyMode: session?.activeMode.privacy ?? 'local_only',
          runtimeMode: session?.activeMode.runtime ?? 'sandbox',
          totalDurationMs: 0,
          toolsUsed: [],
          confirmationRequired: false,
          result,
          errorMessage:
            event.type === 'task_execution_failed'
              ? event.task.failureReason ?? event.detail
              : undefined,
          toolCount: 0,
          messagePreview: event.task.objective,
          fallbackUsed: invocation.fallbackUsed,
          fallbackReason: invocation.fallbackReason,
          eventType: event.type,
          taskId: event.task.id,
          taskStatus: event.task.status
        };

        await telemetry.record(record);
        await notifySystemStateChanged();
      }
    }
  );

  const orchestrator = new AssemOrchestrator({
    config,
    actionLog,
    sessionStore,
    toolRegistry,
    policyEngine: new PolicyEngine(),
    modelRouter,
    memoryBackend,
    telemetry,
    taskManager,
    taskRuntime
  });

  const scheduler = new BasicScheduler(
    schedulerFilePath,
    async (
      task: ScheduledTask,
      context?: SchedulerRunContext
    ): Promise<{ summary: string; errorMessage?: string }> => {
      if (task.kind === 'reminder') {
        return {
          summary: `Reminder: ${task.prompt}`
        };
      }

      if (task.kind === 'summary') {
        const recentMessages = context?.session?.messages.slice(-3) ?? [];
        const summary =
          recentMessages.length > 0
            ? recentMessages
                .map((message) => `${message.role}: ${message.content}`)
                .join(' | ')
            : 'No recent messages are available.';

        return {
          summary: `Summary task "${task.label}": ${summary}`
        };
      }

      if (task.kind === 'internal_review') {
        const pendingCount = context?.session?.pendingAction ? 1 : 0;
        const overrideCount = context?.session?.temporaryOverrides.length ?? 0;
        return {
          summary: `Internal review: ${pendingCount} pending confirmation(s), ${overrideCount} active override(s), active profile ${context?.activeProfile?.name ?? 'none'}.`
        };
      }

      return {
        summary: `System check: ${context?.systemHealth?.status ?? 'ok'} with ${context?.systemHealth?.providerHealth.length ?? 0} provider health entry(ies).`
      };
    }
  );

  const profiles = await memoryBackend.listProfiles();
  if (profiles.length === 0) {
    await memoryBackend.createProfile({
      name: 'Default profile',
      notes: [
        'Local-first default profile for ASSEM. Add persistent preferences and notes here.'
      ]
    });
  }

  const subscribers = new Set<EventSubscriber>();
  let voiceController: VoiceCoordinator;

  async function buildHealthSnapshot(): Promise<AgentHealthSnapshot> {
    const providerHealth = await modelRouter.healthCheck();
    const status = providerHealth.every((provider) => provider.status === 'ok')
      ? 'ok'
      : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      uptimeMs: Date.now() - startedAt,
      sandboxRoot: config.sandboxRoot,
      dataRoot: config.dataRoot,
      configuredDefaultProviderId: config.defaultProviderId,
      providerHealth
    };
  }

  function buildProviderRuntime(
    sessionId: string | null,
    health: AgentHealthSnapshot,
    session: SystemStateSnapshot['session']
  ): ProviderRuntimeStatus {
    const configuredProviderHealth = health.providerHealth.find(
      (provider) => provider.providerId === config.defaultProviderId
    );
    const ollamaHealth = health.providerHealth.find(
      (provider) => provider.providerId === 'ollama'
    );

    return {
      configuredDefaultProviderId: config.defaultProviderId,
      configuredModel: configuredProviderHealth?.defaultModel,
      resolvedModel:
        session?.lastModelInvocation?.providerId === config.defaultProviderId
          ? session?.lastModelInvocation?.resolvedModel ??
            session?.lastModelInvocation?.model
          : configuredProviderHealth?.resolvedModel,
      activeProviderId: session?.lastModelInvocation?.providerId,
      activeModel: session?.lastModelInvocation?.model,
      fallbackUsed: session?.lastModelInvocation?.fallbackUsed,
      fallbackReason: session?.lastModelInvocation?.fallbackReason,
      ollamaAvailable: ollamaHealth?.status === 'ok',
      ollamaError:
        ollamaHealth && ollamaHealth.status !== 'ok'
          ? ollamaHealth.error
          : undefined
    };
  }

  async function buildSystemState(
    sessionId: string | null
  ): Promise<SystemStateSnapshot> {
    const session = sessionId
      ? await orchestrator.getSessionSnapshot(sessionId)
      : null;
    const activeProfile = await memoryBackend.getActiveProfile();
    const health = await buildHealthSnapshot();
    const taskManagerTasks = await taskManager.listTasks(sessionId ?? undefined);
    const activeTask = sessionId
      ? await taskManager.getActiveTaskForSession(sessionId)
      : null;

    return {
      session,
      health,
      providerRuntime: buildProviderRuntime(sessionId, health, session),
      taskManager: {
        activeTask,
        tasks: taskManagerTasks
      },
      voice: (await voiceController.getState(sessionId)).voice,
      profiles: await memoryBackend.listProfiles(),
      activeProfile: activeProfile ? summarizeProfile(activeProfile) : null,
      scheduledTasks: await scheduler.listTasks(),
      pendingActions: session?.pendingAction ? [session.pendingAction] : [],
      overrides: session?.temporaryOverrides ?? [],
      telemetry: await telemetry.summarize(10),
      sessions: await orchestrator.listSessions()
    };
  }

  function sendEvent(
    response: ServerResponse,
    event: string,
    payload: unknown
  ): void {
    response.write(`event: ${event}\n`);
    response.write(`data: ${json(payload)}\n\n`);
  }

  async function broadcastSystemState(): Promise<void> {
    for (const subscriber of [...subscribers]) {
      if (subscriber.response.destroyed) {
        subscribers.delete(subscriber);
        continue;
      }

      try {
        sendEvent(subscriber.response, 'system.updated', {
          state: await buildSystemState(subscriber.sessionId)
        });
      } catch {
        subscribers.delete(subscriber);
        subscriber.response.end();
      }
    }
  }

  notifySystemStateChanged = async () => {
    await broadcastSystemState();
  };

  async function recordSchedulerRunInSession(
    sessionId: string | undefined,
    summary: string,
    status: 'completed' | 'error'
  ): Promise<void> {
    if (!sessionId) {
      return;
    }

    const session = await sessionStore.getSession(sessionId);
    if (!session) {
      return;
    }

    actionLog.record(session, {
      kind: 'scheduler',
      title: 'Scheduled task run',
      detail: summary,
      status
    });
    await sessionStore.saveSession(session);
  }

  function getRequiredSessionId(url: URL): string {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      throw new Error('sessionId query parameter is required.');
    }

    return sessionId;
  }

  voiceController = new VoiceCoordinator({
    config,
    telemetry,
    settingsFilePath: voiceSettingsFilePath,
    chatRuntime: {
      handleChat: (request) => orchestrator.handleChat(request),
      getSessionSnapshot: (sessionId) => orchestrator.getSessionSnapshot(sessionId)
    },
    sttProviders: [
      // Whisper is the only active STT runtime in this phase. The old Windows STT
      // implementation stays isolated as legacy code and is not registered here.
      new WhisperCppSpeechToTextProvider({
        cliPath: config.whisperCppCliPath,
        modelPath: config.whisperCppModelPath,
        threads: config.whisperCppThreads,
        initialPrompt: config.whisperCppInitialPrompt,
        beamSize: config.whisperCppBeamSize,
        tempRoot: path.join(config.dataRoot, 'voice-temp'),
        debugArtifacts: config.voiceDebugArtifacts
      })
    ],
    ttsProviders: [new WindowsTextToSpeechProvider()],
    onStateChanged: async () => {
      await broadcastSystemState();
    }
  });
  await taskRuntime.recoverTasksOnStartup();
  await voiceController.initialize();

  const server = createServer(async (request, response) => {
    if (!request.url) {
      writeJson(request, response, 400, { error: 'Missing URL' });
      return;
    }

    if (!isAllowedOrigin(request.headers.origin)) {
      writeJson(request, response, 403, { error: 'Origin not allowed.' });
      return;
    }

    if (request.method === 'OPTIONS') {
      writeHead(response, 204, request.headers.origin);
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        writeJson(request, response, 200, {
          health: await buildHealthSnapshot()
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/system') {
        writeJson(request, response, 200, {
          state: await buildSystemState(url.searchParams.get('sessionId'))
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/voice') {
        writeJson(
          request,
          response,
          200,
          await voiceController.getState(url.searchParams.get('sessionId'))
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/events') {
        writeHead(response, 200, request.headers.origin, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });

        const subscriber: EventSubscriber = {
          response,
          sessionId: url.searchParams.get('sessionId')
        };
        subscribers.add(subscriber);

        sendEvent(response, 'ready', {
          sessionId: subscriber.sessionId
        });
        sendEvent(response, 'system.updated', {
          state: await buildSystemState(subscriber.sessionId)
        });

        const heartbeat = setInterval(() => {
          if (!response.destroyed) {
            response.write(': keep-alive\n\n');
          }
        }, 25_000);

        request.on('close', () => {
          clearInterval(heartbeat);
          subscribers.delete(subscriber);
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/session') {
        const snapshot = await orchestrator.createSession();
        await broadcastSystemState();
        writeJson(request, response, 200, { snapshot });
        return;
      }

      if (
        request.method === 'GET' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'session'
      ) {
        const snapshot = await orchestrator.getSessionSnapshot(segments[2]);
        writeJson(request, response, 200, { snapshot });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        writeJson(request, response, 200, {
          sessions: await orchestrator.listSessions()
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJson<ChatRequest>(request);
        const snapshot = await orchestrator.handleChat(body);
        await voiceController.maybeAutoReadSnapshot(snapshot.sessionId, snapshot);
        await broadcastSystemState();
        writeJson(request, response, 200, { snapshot });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/stream') {
        const body = await readJson<ChatRequest>(request);
        writeHead(response, 200, request.headers.origin, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });

        sendEvent(response, 'chat.started', {
          sessionId: body.sessionId ?? null
        });

        const snapshot = await orchestrator.handleChat(body);
        await voiceController.maybeAutoReadSnapshot(snapshot.sessionId, snapshot);
        sendEvent(response, 'chat.completed', { snapshot });
        response.end();
        await broadcastSystemState();
        return;
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/api/actions'
      ) {
        const sessionId = getRequiredSessionId(url);
        const payload: ActionHistoryResponse = {
          sessionId,
          actionLog: await orchestrator.listActionLog(sessionId)
        };
        writeJson(request, response, 200, payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/pending-actions') {
        const sessionId = getRequiredSessionId(url);
        writeJson(request, response, 200, {
          sessionId,
          pendingActions: await orchestrator.listPendingActions(sessionId)
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/pending-action') {
        const body = await readJson<PendingActionResolutionRequest>(request);
        const snapshot = await orchestrator.resolvePendingAction(body);
        await voiceController.maybeAutoReadSnapshot(snapshot.sessionId, snapshot);
        await broadcastSystemState();
        writeJson(request, response, 200, { snapshot });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/settings') {
        const body = await readJson<VoiceSettingsUpdateRequest>(request);
        writeJson(
          request,
          response,
          200,
          await voiceController.updateSettings(body, url.searchParams.get('sessionId'))
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/mode') {
        const body = await readJson<VoiceModeUpdateRequest>(request);
        writeJson(request, response, 200, await voiceController.updateVoiceMode(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/wake-window') {
        const body = await readJson<VoiceWakeWindowRequest>(request);
        writeJson(request, response, 200, await voiceController.submitWakeWindow(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/active-listening/start') {
        const body = await readJson<VoiceActiveListeningStartRequest>(request);
        writeJson(request, response, 200, await voiceController.startActiveListening(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/active-listening/state') {
        const body = await readJson<VoiceActiveListeningStateRequest>(request);
        writeJson(request, response, 200, await voiceController.updateActiveListeningState(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/active-listening/stop') {
        const body = await readJson<VoiceActiveListeningStopRequest>(request);
        writeJson(request, response, 200, await voiceController.stopActiveListening(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/active-listening/cancel') {
        const body = await readJson<VoiceRecordingRequest>(request);
        writeJson(request, response, 200, await voiceController.cancelActiveListening(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/recording/start') {
        const body = await readJson<VoiceRecordingRequest>(request);
        writeJson(request, response, 200, await voiceController.startRecording(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/recording/stop') {
        const body = await readJson<VoiceRecordingStopRequest>(request);
        writeJson(request, response, 200, await voiceController.stopRecording(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/recording/cancel') {
        const body = await readJson<VoiceRecordingRequest>(request);
        writeJson(request, response, 200, await voiceController.cancelRecording(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/speak') {
        const body = await readJson<VoiceSpeakRequest>(request);
        writeJson(request, response, 200, await voiceController.speak(body));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/voice/stop-speaking') {
        const body = await readJson<{ sessionId?: string }>(request);
        writeJson(request, response, 200, await voiceController.stopSpeaking(body));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/mode') {
        const sessionId = getRequiredSessionId(url);
        writeJson(request, response, 200, {
          sessionId,
          activeMode: await orchestrator.getMode(sessionId)
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/mode') {
        const body = await readJson<ModeUpdateRequest>(request);
        const activeMode = await orchestrator.updateMode(body);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          sessionId: body.sessionId,
          activeMode
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/overrides') {
        const sessionId = getRequiredSessionId(url);
        writeJson(request, response, 200, {
          sessionId,
          overrides: await orchestrator.listOverrides(sessionId)
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/overrides') {
        const body = await readJson<OverrideCreateRequest>(request);
        const overrides = await orchestrator.createOverride(body);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          sessionId: body.sessionId,
          overrides
        });
        return;
      }

      if (
        request.method === 'DELETE' &&
        segments.length === 3 &&
        segments[0] === 'api' &&
        segments[1] === 'overrides'
      ) {
        const sessionId = getRequiredSessionId(url);
        const removed = await orchestrator.cancelOverride(sessionId, segments[2]);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          sessionId,
          removed
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/profiles') {
        const activeProfile = await memoryBackend.getActiveProfile();
        writeJson(request, response, 200, {
          profiles: await memoryBackend.listProfiles(),
          activeProfile: activeProfile ? summarizeProfile(activeProfile) : null
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/profiles') {
        const profile = await memoryBackend.createProfile(
          await readJson<ProfileCreateInput>(request)
        );
        await broadcastSystemState();
        writeJson(request, response, 200, {
          profile
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/profiles/activate') {
        const body = await readJson<{ profileId: string }>(request);
        const profile = await memoryBackend.activateProfile(body.profileId);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          profile
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/profiles/import') {
        const body = await readJson<ProfileImportPayload>(request);
        const profile = await memoryBackend.importProfile(body);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          profile
        });
        return;
      }

      if (
        request.method === 'GET' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'profiles' &&
        segments[3] === 'export'
      ) {
        writeJson(request, response, 200, {
          profile: await memoryBackend.exportProfile(segments[2])
        });
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'profiles' &&
        segments[3] === 'reset'
      ) {
        const profile = await memoryBackend.resetProfile(segments[2]);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          profile
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/telemetry') {
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
        writeJson(request, response, 200, {
          telemetry: await telemetry.list(limit)
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        const payload: TasksResponse = {
          tasks: await taskManager.listTasks(url.searchParams.get('sessionId') ?? undefined)
        };
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'GET' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'plan'
      ) {
        const task = await taskManager.getTask(segments[2]);
        const payload: TaskPlanResponse = {
          taskId: segments[2],
          plan: task?.plan ?? null
        };
        writeJson(request, response, 200, payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/tasks/active') {
        const sessionId = getRequiredSessionId(url);
        const payload: ActiveTaskResponse = {
          sessionId,
          task: await taskManager.getActiveTaskForSession(sessionId)
        };
        writeJson(request, response, 200, payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks/runtime') {
        const body = await readJson<TaskExecutionRequest>(request);
        const session = await sessionStore.getSession(body.sessionId);
        if (!session) {
          throw new Error(`Unknown session: ${body.sessionId}`);
        }

        const plannedTask:
          | { accepted: true; plan: NonNullable<TaskExecutionRequest['plan']>; clarificationMessage?: undefined; reason?: undefined }
          | ReturnType<typeof planner.createPlan> =
          body.plan
            ? { accepted: true, plan: body.plan }
            : planner.createPlan({
                session,
                text: body.objective,
                objective: body.objective,
                requestedTaskType: body.taskType
              });

        if (!plannedTask.plan) {
          throw new Error(
            plannedTask.clarificationMessage ??
              plannedTask.reason ??
              'Planner v1 no pudo preparar un plan real para esta tarea runtime.'
          );
        }

        const payload: TaskExecutionResponse = {
          task: await taskRuntime.createTask({
            ...body,
            plan: plannedTask.plan
          })
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await readJson<TaskCreateInput>(request);
        const session = await sessionStore.getSession(body.sessionId);
        if (!session) {
          throw new Error(`Unknown session: ${body.sessionId}`);
        }

        const payload: TaskCreateResponse = {
          task: await taskManager.createTask(body)
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'start'
      ) {
        const payload: TaskResponse = {
          task: await taskRuntime.startTask(segments[2])
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'progress'
      ) {
        const body = await readJson<TaskProgressUpdateInput>(request);
        const payload: TaskResponse = {
          task: await taskManager.updateTaskProgress(segments[2], body)
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'phase'
      ) {
        const body = await readJson<TaskPhaseAdvanceInput>(request);
        const payload: TaskResponse = {
          task: await taskManager.advanceTaskPhase(segments[2], body)
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'artifacts'
      ) {
        const body = await readJson<TaskArtifactInput>(request);
        const payload: TaskResponse = {
          task: await taskManager.attachArtifact(segments[2], body)
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'pause'
      ) {
        const body = await readJson<{ reason?: string }>(request);
        const payload: TaskResponse = {
          task: await taskRuntime.pauseTask(segments[2], body.reason)
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'resume'
      ) {
        const payload: TaskResponse = {
          task: await taskRuntime.resumeTask(segments[2])
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'cancel'
      ) {
        const body = await readJson<{ reason?: string }>(request);
        const payload: TaskResponse = {
          task: await taskRuntime.cancelTask(segments[2], body.reason)
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'complete'
      ) {
        const payload: TaskResponse = {
          task: await taskManager.completeTask(segments[2])
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'tasks' &&
        segments[3] === 'fail'
      ) {
        const body = await readJson<{ reason: string }>(request);
        const payload: TaskResponse = {
          task: await taskManager.failTask(segments[2], body.reason)
        };
        await broadcastSystemState();
        writeJson(request, response, 200, payload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/scheduler/tasks') {
        writeJson(request, response, 200, {
          tasks: await scheduler.listTasks()
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/scheduler/tasks') {
        const body = await readJson<ScheduledTaskInput>(request);
        const task = await scheduler.createTask(body);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          task
        });
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'scheduler' &&
        segments[2] === 'tasks' &&
        segments[4] === 'toggle'
      ) {
        const body = await readJson<{ enabled: boolean }>(request);
        const task = await scheduler.setTaskEnabled(segments[3], body.enabled);
        await broadcastSystemState();
        writeJson(request, response, 200, {
          task
        });
        return;
      }

      if (
        request.method === 'DELETE' &&
        segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'scheduler' &&
        segments[2] === 'tasks'
      ) {
        await scheduler.deleteTask(segments[3]);
        await broadcastSystemState();
        writeJson(request, response, 200, {});
        return;
      }

      if (
        request.method === 'POST' &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'scheduler' &&
        segments[2] === 'tasks' &&
        segments[4] === 'run'
      ) {
        const body = await readJson<{ sessionId?: string }>(request);
        const activeProfile = await memoryBackend.getActiveProfile();
        const run = await scheduler.runTask(segments[3], {
          session: body.sessionId
            ? (await orchestrator.getSessionSnapshot(body.sessionId)) ?? undefined
            : undefined,
          activeProfile: activeProfile ? summarizeProfile(activeProfile) : null,
          systemHealth: await buildHealthSnapshot()
        });
        await recordSchedulerRunInSession(
          body.sessionId,
          run.summary,
          run.status === 'success' ? 'completed' : 'error'
        );
        await broadcastSystemState();
        writeJson(request, response, 200, {
          run
        });
        return;
      }

      writeJson(request, response, 404, { error: 'Not found' });
    } catch (error) {
      writeJson(request, response, 500, {
        error:
          error instanceof Error
            ? sanitizeErrorMessage(error.message)
            : 'Unknown server error'
      });
    }
  });

  server.listen(config.agentPort, () => {
    console.log(
      `[ASSEM local-agent] listening on http://localhost:${config.agentPort}`
    );
  });
}

void main();
