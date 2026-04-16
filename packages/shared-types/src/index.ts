export type MessageRole = 'system' | 'user' | 'assistant';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PermissionLevel =
  | 'read_only'
  | 'write_safe'
  | 'write_sensitive'
  | 'external_communication'
  | 'financial_or_irreversible'
  | 'system_control';

export type PrivacyMode =
  | 'local_only'
  | 'prefer_local'
  | 'balanced'
  | 'cloud_allowed';

export type RuntimeMode = 'live' | 'sandbox';

export type SupportedLanguage = 'es' | 'en';

export type ProviderCapability =
  | 'chat'
  | 'tool_reasoning'
  | 'streaming'
  | 'telemetry';

export type ProviderHealthStatus = 'ok' | 'degraded' | 'unavailable';

export type TelemetryResult = 'success' | 'rejected' | 'error';

export type VoiceAvailabilityStatus = 'ready' | 'degraded' | 'unavailable';

export type VoiceProviderKind = 'stt' | 'tts';

export type VoiceRecordingState = 'idle' | 'recording' | 'transcribing' | 'error';

export type VoiceSpeakingState = 'idle' | 'speaking' | 'error';

export type VoiceTranscriptionDiagnosticCode =
  | 'audio_payload_missing'
  | 'audio_decode_failed'
  | 'audio_empty'
  | 'audio_too_short'
  | 'audio_invalid_wav'
  | 'audio_silent'
  | 'transcript_missing'
  | 'transcript_empty'
  | 'transcript_too_short'
  | 'language_mismatch_suspected'
  | 'whisper_execution_failed';

export type TelemetryChannel = 'chat' | 'voice_capture' | 'voice_stt' | 'voice_tts';

export type PendingActionStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'cancelled'
  | 'completed'
  | 'failed';

export type ScheduledTaskKind =
  | 'reminder'
  | 'internal_review'
  | 'summary'
  | 'simple_check';

export type ScheduledTaskCadence = 'manual' | 'once' | 'daily';

export interface ActiveMode {
  privacy: PrivacyMode;
  runtime: RuntimeMode;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface UsageTokens {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ProviderUsage {
  latencyMs?: number;
  tokens?: UsageTokens;
  estimatedCostUsd?: number;
  fallbackReason?: string;
}

export interface ToolExecutionResult<Output = unknown> {
  summary: string;
  output: Output;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
  source: string;
}

export interface TemporaryPolicyOverride {
  id: string;
  label: string;
  scope: 'session' | 'day' | 'task';
  permissionsGranted: PermissionLevel[];
  confirmationsDisabledFor: string[];
  expiresAt: string;
  createdAt: string;
  createdFromUserInstruction: string;
}

export interface TemporaryPolicyOverrideInput {
  label?: string;
  scope: TemporaryPolicyOverride['scope'];
  permissionsGranted: PermissionLevel[];
  confirmationsDisabledFor: string[];
  expiresAt: string;
  createdFromUserInstruction: string;
}

export interface PendingAction {
  id: string;
  toolId: string;
  toolLabel: string;
  input: unknown;
  reason: string;
  riskLevel: RiskLevel;
  permissions: PermissionLevel[];
  confirmationMessage: string;
  status: PendingActionStatus;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

export interface ActionLogEntry {
  id: string;
  sessionId: string;
  kind:
    | 'assistant'
    | 'policy'
    | 'tool_request'
    | 'tool_result'
    | 'tool_rejected'
    | 'scheduler'
    | 'system';
  title: string;
  detail: string;
  status: 'info' | 'pending' | 'completed' | 'rejected' | 'error';
  createdAt: string;
}

export interface SessionSettings {
  preferredProviderId: string;
  autoApproveLowRisk: boolean;
}

export interface ProfilePreferences {
  [key: string]: string | number | boolean | null;
}

export interface FrequentContact {
  id: string;
  name: string;
  notes?: string;
  channels?: string[];
}

export interface SavedSummary {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  tags?: string[];
}

export interface ProfileMemory {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
  preferences: ProfilePreferences;
  notes: string[];
  contacts: FrequentContact[];
  savedSummaries: SavedSummary[];
  derivedData: Record<string, unknown>;
}

export interface ProfileSummary {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt: string;
  notesCount: number;
  contactsCount: number;
  summariesCount: number;
}

export interface ProfileCreateInput {
  name: string;
  preferences?: ProfilePreferences;
  notes?: string[];
  contacts?: FrequentContact[];
  savedSummaries?: SavedSummary[];
  derivedData?: Record<string, unknown>;
}

export interface ProfileImportPayload {
  profile: ProfileMemory;
  activate?: boolean;
}

export interface SessionState {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  actionLog: ActionLogEntry[];
  pendingAction: PendingAction | null;
  temporaryOverrides: TemporaryPolicyOverride[];
  calendarEvents: CalendarEvent[];
  activeMode: ActiveMode;
  settings: SessionSettings;
  operationalContext?: SessionOperationalContext;
  lastModelInvocation?: ModelInvocationRecord;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  hasPendingAction: boolean;
  activeMode: ActiveMode;
}

export interface ToolExecutionContext {
  now: Date;
  sandboxRoot: string;
  activeMode: ActiveMode;
  session: SessionState;
  activeProfile?: ProfileMemory | null;
}

export interface Tool<Input = unknown, Output = unknown> {
  id: string;
  label: string;
  description: string;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  requiresPermissions: PermissionLevel[];
  execute: (
    input: Input,
    context: ToolExecutionContext
  ) => Promise<ToolExecutionResult<Output>>;
}

export type ToolDefinition<Input = unknown, Output = unknown> = Tool<
  Input,
  Output
>;

export type AnyToolDefinition = ToolDefinition<any, any>;

export interface ToolSummary {
  id: string;
  label: string;
  description: string;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  requiresPermissions: PermissionLevel[];
}

export interface ToolRegistry {
  register<Input, Output>(tool: ToolDefinition<Input, Output>): void;
  get(toolId: string): AnyToolDefinition;
  list(): AnyToolDefinition[];
  summaries(): ToolSummary[];
}

export interface CalendarProvider {
  id: string;
  label: string;
  listEvents(session: SessionState): Promise<CalendarEvent[]>;
  createEvent(
    input: CalendarCreateInput,
    context: ToolExecutionContext
  ): Promise<CalendarCreateOutput>;
}

export interface ModelRequest {
  messages: ChatMessage[];
  availableTools: ToolSummary[];
  privacyMode: PrivacyMode;
  runtimeMode: RuntimeMode;
  preferredProviderId?: string;
  requiredCapabilities?: ProviderCapability[];
  activeProfile?: ProfileSummary | null;
}

export interface ProviderHealth {
  providerId: string;
  label: string;
  status: ProviderHealthStatus;
  checkedAt: string;
  latencyMs?: number;
  error?: string;
  configured: boolean;
  supportsLocalOnly: boolean;
  defaultModel: string;
  resolvedModel?: string;
  capabilities: ProviderCapability[];
  supportsPrivacyModes: PrivacyMode[];
  availableModels?: string[];
}

export interface ModelResponse {
  text: string;
  confidence: number;
  providerId: string;
  model: string;
  configuredModel?: string;
  resolvedModel?: string;
  usage?: ProviderUsage;
  finishReason?: 'stop' | 'fallback' | 'error';
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

export interface EngineProvider {
  id: string;
  label: string;
  defaultModel: string;
  supportsLocalOnly: boolean;
  capabilities: ProviderCapability[];
  supportsPrivacyModes: PrivacyMode[];
  timeoutMs?: number;
  isConfigured(): boolean;
  healthCheck(): Promise<ProviderHealth>;
  run(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelProvider = EngineProvider;

export interface ProviderSummary {
  id: string;
  label: string;
  configured: boolean;
  defaultModel: string;
  supportsLocalOnly: boolean;
  capabilities: ProviderCapability[];
  supportsPrivacyModes: PrivacyMode[];
}

export interface ModelInvocationRecord {
  providerId: string;
  model: string;
  configuredModel?: string;
  resolvedModel?: string;
  timestamp: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

export interface ModelRouter {
  listProviders(): ProviderSummary[];
  healthCheck(): Promise<ProviderHealth[]>;
  respond(request: ModelRequest): Promise<ModelResponse>;
}

export interface PolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason: string;
  activeOverrideId?: string;
}

export interface PolicyEngine {
  pruneExpired(session: SessionState, now?: Date): void;
  evaluate(
    session: SessionState,
    tool: ToolDefinition,
    now?: Date
  ): PolicyDecision;
  parseTemporaryOverride(
    instruction: string,
    now?: Date
  ): TemporaryPolicyOverride | null;
  cancelOverride(
    session: SessionState,
    overrideId: string
  ): TemporaryPolicyOverride | null;
}

export interface MemoryBackend {
  createProfile(input: ProfileCreateInput): Promise<ProfileMemory>;
  listProfiles(): Promise<ProfileSummary[]>;
  getActiveProfile(): Promise<ProfileMemory | null>;
  activateProfile(profileId: string): Promise<ProfileMemory>;
  exportProfile(profileId: string): Promise<ProfileMemory>;
  importProfile(payload: ProfileImportPayload): Promise<ProfileMemory>;
  resetProfile(profileId: string): Promise<ProfileMemory>;
}

export interface SessionStore {
  createSession(): Promise<SessionState>;
  getSession(sessionId: string): Promise<SessionState | null>;
  getOrCreateSession(sessionId?: string): Promise<SessionState>;
  saveSession(session: SessionState): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
}

export interface TelemetryRecord {
  id: string;
  timestamp: string;
  sessionId?: string;
  providerId?: string;
  model?: string;
  channel?: TelemetryChannel;
  privacyMode: PrivacyMode;
  runtimeMode: RuntimeMode;
  totalDurationMs: number;
  providerLatencyMs?: number;
  tokens?: UsageTokens;
  estimatedCostUsd?: number;
  toolsUsed: string[];
  confirmationRequired: boolean;
  result: TelemetryResult;
  errorMessage?: string;
  toolCount: number;
  messagePreview?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  audioDurationMs?: number;
  textLength?: number;
}

export interface TelemetrySummary {
  totalInteractions: number;
  successes: number;
  rejections: number;
  errors: number;
  lastInteractionAt?: string;
  lastError?: string;
  recent: TelemetryRecord[];
}

export interface TelemetrySink {
  record(record: TelemetryRecord): Promise<void>;
  list(limit?: number): Promise<TelemetryRecord[]>;
  summarize(limit?: number): Promise<TelemetrySummary>;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'error';
  summary: string;
  errorMessage?: string;
}

export interface ScheduledTask {
  id: string;
  label: string;
  kind: ScheduledTaskKind;
  prompt: string;
  cadence: ScheduledTaskCadence;
  scheduleAt?: string;
  enabled: boolean;
  safe: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastRun?: ScheduledTaskRun;
}

export interface ScheduledTaskInput {
  label: string;
  kind: ScheduledTaskKind;
  prompt: string;
  cadence?: ScheduledTaskCadence;
  scheduleAt?: string;
  enabled?: boolean;
}

export interface SchedulerRunContext {
  session?: SessionSnapshot;
  activeProfile?: ProfileSummary | null;
  systemHealth?: AgentHealthSnapshot;
  now?: Date;
}

export interface Scheduler {
  createTask(input: ScheduledTaskInput): Promise<ScheduledTask>;
  listTasks(): Promise<ScheduledTask[]>;
  setTaskEnabled(taskId: string, enabled: boolean): Promise<ScheduledTask>;
  deleteTask(taskId: string): Promise<void>;
  runTask(
    taskId: string,
    context?: SchedulerRunContext
  ): Promise<ScheduledTaskRun>;
}

export interface SessionSnapshot {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  actionLog: ActionLogEntry[];
  pendingAction: PendingAction | null;
  temporaryOverrides: TemporaryPolicyOverride[];
  calendarEvents: CalendarEvent[];
  activeMode: ActiveMode;
  settings: SessionSettings;
  operationalContext?: SessionOperationalContext;
  lastModelInvocation?: ModelInvocationRecord;
  availableProviders: ProviderSummary[];
  availableTools: ToolSummary[];
}

export interface AgentHealthSnapshot {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptimeMs: number;
  sandboxRoot: string;
  dataRoot: string;
  configuredDefaultProviderId: string;
  providerHealth: ProviderHealth[];
}

export interface ProviderRuntimeStatus {
  configuredDefaultProviderId: string;
  configuredModel?: string;
  resolvedModel?: string;
  activeProviderId?: string;
  activeModel?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  ollamaAvailable: boolean;
  ollamaError?: string;
}

export interface SystemStateSnapshot {
  session: SessionSnapshot | null;
  health: AgentHealthSnapshot;
  providerRuntime: ProviderRuntimeStatus;
  voice: VoiceSystemState;
  profiles: ProfileSummary[];
  activeProfile: ProfileSummary | null;
  scheduledTasks: ScheduledTask[];
  pendingActions: PendingAction[];
  overrides: TemporaryPolicyOverride[];
  telemetry: TelemetrySummary;
  sessions: SessionSummary[];
}

export interface CreateSessionResponse {
  snapshot: SessionSnapshot;
}

export interface SessionResponse {
  snapshot: SessionSnapshot | null;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

export interface ChatRequest {
  sessionId?: string;
  text: string;
  activeMode?: Partial<ActiveMode>;
}

export interface ChatResponse {
  snapshot: SessionSnapshot;
}

export interface PendingActionResolutionRequest {
  sessionId: string;
  approved: boolean;
}

export interface PendingActionResolutionResponse {
  snapshot: SessionSnapshot;
}

export interface HealthResponse {
  health: AgentHealthSnapshot;
}

export interface SystemStateResponse {
  state: SystemStateSnapshot;
}

export interface ActionHistoryResponse {
  sessionId: string;
  actionLog: ActionLogEntry[];
}

export interface PendingActionsResponse {
  sessionId: string;
  pendingActions: PendingAction[];
}

export interface ModeUpdateRequest {
  sessionId: string;
  activeMode: Partial<ActiveMode>;
}

export interface ModeResponse {
  sessionId: string;
  activeMode: ActiveMode;
}

export interface OverrideCreateRequest {
  sessionId: string;
  instruction?: string;
  override?: TemporaryPolicyOverrideInput;
}

export interface OverrideListResponse {
  sessionId: string;
  overrides: TemporaryPolicyOverride[];
}

export interface OverrideDeleteResponse {
  sessionId: string;
  removed: TemporaryPolicyOverride | null;
}

export interface ProfilesResponse {
  profiles: ProfileSummary[];
  activeProfile: ProfileSummary | null;
}

export interface ProfileResponse {
  profile: ProfileMemory;
}

export interface TelemetryListResponse {
  telemetry: TelemetryRecord[];
}

export interface SchedulerTasksResponse {
  tasks: ScheduledTask[];
}

export interface SchedulerTaskResponse {
  task: ScheduledTask;
}

export interface SchedulerRunResponse {
  run: ScheduledTaskRun;
}

export interface LocalFileInput {
  kind: 'file' | 'directory';
  relativePath: string;
  fileContents?: string;
}

export interface LocalFileOutput {
  kind: 'file' | 'directory';
  absolutePath: string;
  simulated: boolean;
}

export interface LocalDirectoryEntry {
  name: string;
  kind: 'file' | 'directory';
  relativePath: string;
}

export interface LocalDirectoryListInput {
  relativePath?: string;
}

export interface LocalDirectoryListOutput {
  absolutePath: string;
  entries: LocalDirectoryEntry[];
}

export interface LocalFileReadInput {
  relativePath: string;
}

export interface LocalFileReadOutput {
  absolutePath: string;
  contents: string;
  isText?: boolean;
  truncated?: boolean;
  totalBytes?: number;
}

export interface SessionTemporalSnapshot {
  iso: string;
  timeZone: string;
  utcOffset: string;
  locale: string;
  renderedLanguage: SupportedLanguage;
}

export interface SessionWriteIntent {
  toolId: string;
  toolLabel: string;
  input: unknown;
  status: PendingActionStatus;
  recordedAt: string;
  errorMessage?: string;
}

export interface SessionOperationalEntity {
  kind: 'file' | 'directory' | 'listing' | 'time';
  relativePath?: string;
  absolutePath?: string;
  toolId: string;
  title: string;
}

export interface SessionToolResultReference {
  toolId: string;
  toolLabel: string;
  recordedAt: string;
  summary: string;
  renderedText: string;
  relativePath?: string;
  absolutePath?: string;
  entries?: LocalDirectoryEntry[];
  fileContents?: string;
  truncated?: boolean;
  temporalSnapshot?: SessionTemporalSnapshot;
}

export interface SessionOperationalContext {
  lastRelevantEntity?: SessionOperationalEntity;
  lastToolResult?: SessionToolResultReference;
  lastTemporalSnapshot?: SessionTemporalSnapshot;
  lastWriteIntent?: SessionWriteIntent;
}

export interface CalendarCreateInput {
  title: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
}

export interface CalendarCreateOutput {
  event: CalendarEvent;
  simulated: boolean;
}

export interface CalendarListOutput {
  events: CalendarEvent[];
}

export interface TimeOutput {
  iso: string;
  localLabel: string;
  timeZone: string;
  utcOffset: string;
}

export interface VoiceSettings {
  sttProviderId: string;
  ttsProviderId: string;
  preferredLanguage: string;
  autoReadResponses: boolean;
}

export interface VoiceProviderHealth {
  providerId: string;
  label: string;
  kind: VoiceProviderKind;
  status: ProviderHealthStatus;
  checkedAt: string;
  configured: boolean;
  available: boolean;
  active: boolean;
  error?: string;
}

export interface VoiceAudioDiagnostics {
  mimeType?: string;
  fileName?: string;
  byteLength: number;
  base64Length?: number;
  captureSampleRateHz?: number;
  sampleRateHz?: number;
  channelCount?: number;
  bitDepth?: number;
  sampleCount?: number;
  approximateDurationMs?: number;
  peakLevel?: number;
  rmsLevel?: number;
  wavValid?: boolean;
  silenceDetected?: boolean;
  suspicious?: boolean;
}

export interface VoiceTranscriptionDiagnostic {
  code: VoiceTranscriptionDiagnosticCode;
  summary: string;
  detail?: string;
  effectiveLanguage?: string;
  audio?: VoiceAudioDiagnostics;
  transcriptJsonGenerated?: boolean;
  transcriptTextLength?: number;
  debugArtifactsRetained?: boolean;
  inputPath?: string;
  transcriptJsonPath?: string;
}

export interface SpeechToTextStartRequest {
  sessionId: string;
  language: string;
}

export interface SpeechToTextAudioInput {
  mimeType: string;
  base64Data: string;
  fileName?: string;
  durationMs?: number;
  diagnostics?: VoiceAudioDiagnostics;
}

export interface SpeechToTextStopRequest {
  audio?: SpeechToTextAudioInput;
}

export interface SpeechToTextResult {
  transcript: string;
  audioDurationMs: number;
  audioDiagnostics?: VoiceAudioDiagnostics;
  effectiveLanguage?: string;
  diagnostic?: VoiceTranscriptionDiagnostic;
}

export interface SpeechToTextSession {
  stop(request?: SpeechToTextStopRequest): Promise<SpeechToTextResult>;
  cancel(): Promise<void>;
}

export interface SpeechToTextProvider {
  id: string;
  label: string;
  kind: 'stt';
  isConfigured(): boolean;
  initialize?(): Promise<void>;
  healthCheck(settings: VoiceSettings): Promise<VoiceProviderHealth>;
  startListening(request: SpeechToTextStartRequest): Promise<SpeechToTextSession>;
}

export interface TextToSpeechRequest {
  sessionId: string;
  text: string;
  language: string;
}

export interface TextToSpeechResult {
  audioDurationMs: number;
}

export interface TextToSpeechPlayback {
  stop(): Promise<void>;
  completed: Promise<TextToSpeechResult>;
}

export interface TextToSpeechProvider {
  id: string;
  label: string;
  kind: 'tts';
  isConfigured(): boolean;
  initialize?(): Promise<void>;
  healthCheck(settings: VoiceSettings): Promise<VoiceProviderHealth>;
  speak(request: TextToSpeechRequest): Promise<TextToSpeechPlayback>;
}

export interface VoiceSessionState {
  sessionId: string | null;
  recordingState: VoiceRecordingState;
  speakingState: VoiceSpeakingState;
  microphoneAccessible: boolean;
  sttProviderId?: string;
  ttsProviderId?: string;
  autoReadResponses: boolean;
  preferredLanguage: string;
  lastTranscript?: string;
  lastAssistantMessage?: string;
  lastError?: string;
  lastDiagnostic?: VoiceTranscriptionDiagnostic;
  lastAudioDiagnostics?: VoiceAudioDiagnostics;
  lastTranscriptionLanguage?: string;
  recordingStartedAt?: string;
  audioDurationMs?: number;
  updatedAt: string;
}

export interface VoiceSystemState {
  available: boolean;
  status: VoiceAvailabilityStatus;
  settings: VoiceSettings;
  sttProviders: VoiceProviderHealth[];
  ttsProviders: VoiceProviderHealth[];
  microphoneAccessible: boolean;
  session: VoiceSessionState | null;
  lastError?: string;
}

export interface VoiceStateResponse {
  voice: VoiceSystemState;
}

export interface VoiceSettingsUpdateRequest {
  settings: Partial<VoiceSettings>;
}

export interface VoiceSettingsResponse {
  settings: VoiceSettings;
  voice: VoiceSystemState;
}

export interface VoiceRecordingRequest {
  sessionId: string;
}

export interface VoiceRecordingStopRequest {
  sessionId: string;
  submitToChat?: boolean;
  audio?: SpeechToTextAudioInput;
}

export interface VoiceRecordingResponse {
  voice: VoiceSystemState;
  transcript?: string;
  snapshot?: SessionSnapshot;
}

export interface VoiceSpeakRequest {
  sessionId: string;
  text?: string;
}

export interface VoiceSpeakResponse {
  voice: VoiceSystemState;
}

export interface AssemConfig {
  appName: string;
  agentPort: number;
  sandboxRoot: string;
  dataRoot: string;
  defaultProviderId: string;
  providerTimeoutMs: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  voiceSttProviderId: string;
  voiceTtsProviderId: string;
  voiceLanguage: string;
  voiceAutoReadResponses: boolean;
  voiceDebugArtifacts: boolean;
  whisperCppCliPath?: string;
  whisperCppModelPath?: string;
  whisperCppThreads: number;
  allowedOrigins: string[];
}
