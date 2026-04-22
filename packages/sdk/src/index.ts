import type {
  ActionHistoryResponse,
  ActiveTaskResponse,
  ChatRequest,
  ChatResponse,
  CreateSessionResponse,
  ModeResponse,
  ModeUpdateRequest,
  OverrideCreateRequest,
  OverrideDeleteResponse,
  OverrideListResponse,
  PendingActionResolutionRequest,
  PendingActionResolutionResponse,
  PendingActionsResponse,
  ProfileResponse,
  ProfilesResponse,
  ProfileCreateInput,
  ProfileImportPayload,
  SchedulerRunResponse,
  SchedulerTaskResponse,
  SchedulerTasksResponse,
  ScheduledTaskInput,
  SessionResponse,
  SystemStateResponse,
  SystemStateSnapshot,
  TaskArtifactInput,
  TaskCreateInput,
  TaskCreateResponse,
  TaskExecutionRequest,
  TaskExecutionResponse,
  TaskPlanResponse,
  TaskPhaseAdvanceInput,
  TaskProgressUpdateInput,
  TaskResponse,
  TasksResponse,
  LocalFileInput,
  VoiceActiveListeningResponse,
  VoiceActiveListeningStartRequest,
  VoiceActiveListeningStateRequest,
  VoiceActiveListeningStopRequest,
  VoiceModeUpdateRequest,
  VoiceRecordingRequest,
  VoiceRecordingStopRequest,
  VoiceRecordingResponse,
  VoiceSettingsResponse,
  VoiceSettingsUpdateRequest,
  VoiceSpeakRequest,
  VoiceSpeakResponse,
  VoiceStateResponse,
  VoiceWakeWindowRequest,
  VoiceWakeWindowResponse
} from '@assem/shared-types';

export interface AssemEventHandlers {
  onReady?: (payload: unknown) => void;
  onSystemUpdated?: (state: SystemStateSnapshot) => void;
  onChatCompleted?: (payload: unknown) => void;
}

export class AssemClient {
  constructor(private readonly baseUrl = 'http://localhost:4318') {}

  async createSession(): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>('/api/session', {
      method: 'POST'
    });
  }

  async getSession(sessionId: string): Promise<SessionResponse> {
    return this.request<SessionResponse>(`/api/session/${sessionId}`, {
      method: 'GET'
    });
  }

  async getSystemState(sessionId?: string): Promise<SystemStateResponse> {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return this.request<SystemStateResponse>(`/api/system${suffix}`, {
      method: 'GET'
    });
  }

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    return this.request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async getVoiceState(sessionId?: string): Promise<VoiceStateResponse> {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return this.request<VoiceStateResponse>(`/api/voice${suffix}`, {
      method: 'GET'
    });
  }

  async updateVoiceSettings(
    request: VoiceSettingsUpdateRequest,
    sessionId?: string
  ): Promise<VoiceSettingsResponse> {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return this.request<VoiceSettingsResponse>(`/api/voice/settings${suffix}`, {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async updateVoiceMode(
    request: VoiceModeUpdateRequest
  ): Promise<VoiceStateResponse> {
    return this.request<VoiceStateResponse>('/api/voice/mode', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async submitVoiceWakeWindow(
    request: VoiceWakeWindowRequest
  ): Promise<VoiceWakeWindowResponse> {
    return this.request<VoiceWakeWindowResponse>('/api/voice/wake-window', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async startVoiceActiveListening(
    request: VoiceActiveListeningStartRequest
  ): Promise<VoiceStateResponse> {
    return this.request<VoiceStateResponse>('/api/voice/active-listening/start', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async updateVoiceActiveListeningState(
    request: VoiceActiveListeningStateRequest
  ): Promise<VoiceStateResponse> {
    return this.request<VoiceStateResponse>('/api/voice/active-listening/state', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async stopVoiceActiveListening(
    request: VoiceActiveListeningStopRequest
  ): Promise<VoiceActiveListeningResponse> {
    return this.request<VoiceActiveListeningResponse>('/api/voice/active-listening/stop', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async cancelVoiceActiveListening(
    request: VoiceRecordingRequest
  ): Promise<VoiceStateResponse> {
    return this.request<VoiceStateResponse>('/api/voice/active-listening/cancel', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async startVoiceRecording(
    request: VoiceRecordingRequest
  ): Promise<VoiceStateResponse> {
    return this.request<VoiceStateResponse>('/api/voice/recording/start', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async stopVoiceRecording(
    request: VoiceRecordingStopRequest
  ): Promise<VoiceRecordingResponse> {
    return this.request<VoiceRecordingResponse>('/api/voice/recording/stop', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async cancelVoiceRecording(
    request: VoiceRecordingRequest
  ): Promise<VoiceStateResponse> {
    return this.request<VoiceStateResponse>('/api/voice/recording/cancel', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async speakText(request: VoiceSpeakRequest): Promise<VoiceSpeakResponse> {
    return this.request<VoiceSpeakResponse>('/api/voice/speak', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async stopSpeaking(sessionId?: string): Promise<VoiceSpeakResponse> {
    return this.request<VoiceSpeakResponse>('/api/voice/stop-speaking', {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
  }

  async resolvePendingAction(
    request: PendingActionResolutionRequest
  ): Promise<PendingActionResolutionResponse> {
    return this.request<PendingActionResolutionResponse>('/api/pending-action', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async listActionLog(sessionId: string): Promise<ActionHistoryResponse> {
    return this.request<ActionHistoryResponse>(
      `/api/actions?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'GET'
      }
    );
  }

  async listPendingActions(sessionId: string): Promise<PendingActionsResponse> {
    return this.request<PendingActionsResponse>(
      `/api/pending-actions?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'GET'
      }
    );
  }

  async getMode(sessionId: string): Promise<ModeResponse> {
    return this.request<ModeResponse>(
      `/api/mode?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'GET'
      }
    );
  }

  async updateMode(request: ModeUpdateRequest): Promise<ModeResponse> {
    return this.request<ModeResponse>('/api/mode', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async listOverrides(sessionId: string): Promise<OverrideListResponse> {
    return this.request<OverrideListResponse>(
      `/api/overrides?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'GET'
      }
    );
  }

  async createOverride(request: OverrideCreateRequest): Promise<OverrideListResponse> {
    return this.request<OverrideListResponse>('/api/overrides', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async cancelOverride(
    sessionId: string,
    overrideId: string
  ): Promise<OverrideDeleteResponse> {
    return this.request<OverrideDeleteResponse>(
      `/api/overrides/${overrideId}?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'DELETE'
      }
    );
  }

  async listProfiles(): Promise<ProfilesResponse> {
    return this.request<ProfilesResponse>('/api/profiles', {
      method: 'GET'
    });
  }

  async createProfile(input: ProfileCreateInput): Promise<ProfileResponse> {
    return this.request<ProfileResponse>('/api/profiles', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async activateProfile(profileId: string): Promise<ProfileResponse> {
    return this.request<ProfileResponse>('/api/profiles/activate', {
      method: 'POST',
      body: JSON.stringify({ profileId })
    });
  }

  async exportProfile(profileId: string): Promise<ProfileResponse> {
    return this.request<ProfileResponse>(`/api/profiles/${profileId}/export`, {
      method: 'GET'
    });
  }

  async importProfile(payload: ProfileImportPayload): Promise<ProfileResponse> {
    return this.request<ProfileResponse>('/api/profiles/import', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async resetProfile(profileId: string): Promise<ProfileResponse> {
    return this.request<ProfileResponse>(`/api/profiles/${profileId}/reset`, {
      method: 'POST'
    });
  }

  async listTasks(sessionId?: string): Promise<TasksResponse> {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    return this.request<TasksResponse>(`/api/tasks${suffix}`, {
      method: 'GET'
    });
  }

  async getActiveTask(sessionId: string): Promise<ActiveTaskResponse> {
    return this.request<ActiveTaskResponse>(
      `/api/tasks/active?sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'GET'
      }
    );
  }

  async getTaskPlan(taskId: string): Promise<TaskPlanResponse> {
    return this.request<TaskPlanResponse>(`/api/tasks/${taskId}/plan`, {
      method: 'GET'
    });
  }

  async createTask(input: TaskCreateInput): Promise<TaskCreateResponse> {
    return this.request<TaskCreateResponse>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async createRuntimeTask(
    request: TaskExecutionRequest
  ): Promise<TaskExecutionResponse> {
    return this.request<TaskExecutionResponse>('/api/tasks/runtime', {
      method: 'POST',
      body: JSON.stringify(request)
    });
  }

  async updateTaskProgress(
    taskId: string,
    input: TaskProgressUpdateInput
  ): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/progress`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async advanceTaskPhase(
    taskId: string,
    input: TaskPhaseAdvanceInput
  ): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/phase`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async attachTaskArtifact(
    taskId: string,
    input: TaskArtifactInput
  ): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/artifacts`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async pauseTask(taskId: string, reason?: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
  }

  async startTask(taskId: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/start`, {
      method: 'POST'
    });
  }

  async resumeTask(taskId: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/resume`, {
      method: 'POST'
    });
  }

  async cancelTask(taskId: string, reason?: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
  }

  async completeTask(taskId: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/complete`, {
      method: 'POST'
    });
  }

  async failTask(taskId: string, reason: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/api/tasks/${taskId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
  }

  async listSchedulerTasks(): Promise<SchedulerTasksResponse> {
    return this.request<SchedulerTasksResponse>('/api/scheduler/tasks', {
      method: 'GET'
    });
  }

  async createSchedulerTask(
    input: ScheduledTaskInput
  ): Promise<SchedulerTaskResponse> {
    return this.request<SchedulerTaskResponse>('/api/scheduler/tasks', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  async setSchedulerTaskEnabled(
    taskId: string,
    enabled: boolean
  ): Promise<SchedulerTaskResponse> {
    return this.request<SchedulerTaskResponse>(
      `/api/scheduler/tasks/${taskId}/toggle`,
      {
        method: 'POST',
        body: JSON.stringify({ enabled })
      }
    );
  }

  async deleteSchedulerTask(taskId: string): Promise<void> {
    await this.request<void>(`/api/scheduler/tasks/${taskId}`, {
      method: 'DELETE'
    });
  }

  async runSchedulerTask(
    taskId: string,
    sessionId?: string
  ): Promise<SchedulerRunResponse> {
    return this.request<SchedulerRunResponse>(
      `/api/scheduler/tasks/${taskId}/run`,
      {
        method: 'POST',
        body: JSON.stringify({ sessionId })
      }
    );
  }

  subscribeToEvents(
    sessionId: string | undefined,
    handlers: AssemEventHandlers
  ): () => void {
    const suffix = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const source = new EventSource(`${this.baseUrl}/api/events${suffix}`);

    source.addEventListener('ready', (event) => {
      handlers.onReady?.(JSON.parse((event as MessageEvent).data));
    });

    source.addEventListener('system.updated', (event) => {
      handlers.onSystemUpdated?.(
        JSON.parse((event as MessageEvent).data).state as SystemStateSnapshot
      );
    });

    source.addEventListener('chat.completed', (event) => {
      handlers.onChatCompleted?.(JSON.parse((event as MessageEvent).data));
    });

    return () => {
      source.close();
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      const message = this.extractErrorMessage(body);
      throw new Error(message || `Request failed with status ${response.status}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private extractErrorMessage(body: string): string {
    const trimmed = body.trim();
    if (!trimmed) {
      return '';
    }

    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };

      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }

      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // Fall back to the raw response body when it is not JSON.
    }

    return trimmed;
  }
}

export type { LocalFileInput };
