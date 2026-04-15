import type {
  EngineProvider,
  ModelRequest,
  ModelResponse,
  PrivacyMode,
  ProviderCapability,
  ProviderHealth
} from '@assem/shared-types';

interface OllamaProviderOptions {
  baseUrl: string;
  defaultModel: string;
  timeoutMs?: number;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface ParsedModelName {
  original: string;
  canonical: string;
  base: string;
  hasExplicitTag: boolean;
  latestAlias: string;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeModelName(value: string): string {
  return value.trim();
}

function parseModelName(value: string): ParsedModelName {
  const original = normalizeModelName(value);
  const separatorIndex = original.lastIndexOf(':');
  const hasExplicitTag = separatorIndex > -1;
  const rawBase = hasExplicitTag ? original.slice(0, separatorIndex) : original;
  const rawTag = hasExplicitTag ? original.slice(separatorIndex + 1) : '';
  const base = rawBase.trim().toLowerCase();
  const tag = rawTag.trim().toLowerCase();

  return {
    original,
    canonical: hasExplicitTag ? `${base}:${tag}` : base,
    base,
    hasExplicitTag,
    latestAlias: `${base}:latest`
  };
}

function createAvailableModelMap(models: string[]): Map<string, string> {
  const availableByCanonical = new Map<string, string>();

  for (const model of models) {
    const parsed = parseModelName(model);
    if (!availableByCanonical.has(parsed.canonical)) {
      availableByCanonical.set(parsed.canonical, model);
    }
  }

  return availableByCanonical;
}

function resolveInstalledModel(
  configuredModel: string,
  availableModels: string[]
): string | undefined {
  const configured = parseModelName(configuredModel);
  const availableByCanonical = createAvailableModelMap(availableModels);

  if (configured.hasExplicitTag) {
    return availableByCanonical.get(configured.canonical);
  }

  return (
    availableByCanonical.get(configured.canonical) ??
    availableByCanonical.get(configured.latestAlias)
  );
}

function formatMissingModelMessage(
  configuredModel: string,
  availableModels: string[]
): string {
  const configured = parseModelName(configuredModel);

  if (!configured.hasExplicitTag) {
    return `Configured model "${configuredModel}" is not installed in Ollama. ASSEM checked "${configuredModel}" and "${configuredModel}:latest".`;
  }

  return `Configured model "${configuredModel}" is not installed in Ollama.`;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  return undefined;
}

function estimateTokensFromCounts(
  promptEvalCount?: number,
  evalCount?: number
): NonNullable<ModelResponse['usage']>['tokens'] {
  if (promptEvalCount === undefined && evalCount === undefined) {
    return undefined;
  }

  const promptTokens = promptEvalCount;
  const completionTokens = evalCount;
  const totalTokens =
    (promptTokens ?? 0) + (completionTokens ?? 0) || undefined;

  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export class OllamaModelProvider implements EngineProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama local provider';
  readonly supportsLocalOnly = true;
  readonly capabilities: ProviderCapability[] = ['chat', 'tool_reasoning', 'telemetry'];
  readonly supportsPrivacyModes: PrivacyMode[] = [
    'local_only',
    'prefer_local',
    'balanced',
    'cloud_allowed'
  ];
  readonly timeoutMs?: number;
  readonly defaultModel: string;

  private readonly baseUrl: string;
  private resolvedDefaultModel?: string;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.defaultModel = normalizeModelName(options.defaultModel);
    this.timeoutMs = options.timeoutMs;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl) && Boolean(this.defaultModel);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = Date.now();

    if (!this.isConfigured()) {
      return {
        providerId: this.id,
        label: this.label,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        error: 'Ollama is not configured. Set ASSEM_OLLAMA_BASE_URL and ASSEM_OLLAMA_MODEL.',
        configured: false,
        supportsLocalOnly: this.supportsLocalOnly,
        defaultModel: this.defaultModel,
        resolvedModel: this.resolvedDefaultModel,
        capabilities: [...this.capabilities],
        supportsPrivacyModes: [...this.supportsPrivacyModes]
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET'
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        return {
          providerId: this.id,
          label: this.label,
          status: 'unavailable',
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          error:
            extractErrorMessage(payload) ??
            `Ollama health check failed with status ${response.status}.`,
          configured: this.isConfigured(),
          supportsLocalOnly: this.supportsLocalOnly,
          defaultModel: this.defaultModel,
          resolvedModel: this.resolvedDefaultModel,
          capabilities: [...this.capabilities],
          supportsPrivacyModes: [...this.supportsPrivacyModes]
        };
      }

      const payload = await parseJsonResponse<OllamaTagsResponse>(response);
      const availableModels = (payload.models ?? [])
        .map((model) => model.name ?? model.model ?? '')
        .map((model) => model.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      const resolvedModel = resolveInstalledModel(
        this.defaultModel,
        availableModels
      );
      this.resolvedDefaultModel = resolvedModel;
      const status =
        availableModels.length === 0 || !resolvedModel ? 'degraded' : 'ok';
      const error =
        availableModels.length === 0
          ? `Ollama is reachable at ${this.baseUrl}, but no models are installed.`
          : !resolvedModel
            ? formatMissingModelMessage(this.defaultModel, availableModels)
            : undefined;

      return {
        providerId: this.id,
        label: this.label,
        status,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        error,
        configured: this.isConfigured(),
        supportsLocalOnly: this.supportsLocalOnly,
        defaultModel: this.defaultModel,
        resolvedModel,
        capabilities: [...this.capabilities],
        supportsPrivacyModes: [...this.supportsPrivacyModes],
        availableModels
      };
    } catch (error) {
      return {
        providerId: this.id,
        label: this.label,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        error: this.formatConnectionError(error),
        configured: this.isConfigured(),
        supportsLocalOnly: this.supportsLocalOnly,
        defaultModel: this.defaultModel,
        resolvedModel: this.resolvedDefaultModel,
        capabilities: [...this.capabilities],
        supportsPrivacyModes: [...this.supportsPrivacyModes]
      };
    }
  }

  async run(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    const requestedModel = this.resolvedDefaultModel ?? this.defaultModel;
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: requestedModel,
        stream: false,
        messages: this.buildMessages(request)
      })
    }).catch((error) => {
      throw new Error(this.formatConnectionError(error));
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        extractErrorMessage(payload) ??
          `Ollama request failed with status ${response.status}.`
      );
    }

    const payload = await parseJsonResponse<OllamaChatResponse>(response);
    const text = payload.message?.content?.trim();

    if (!text) {
      throw new Error('Ollama returned an empty response.');
    }

    const resolvedModel = payload.model?.trim() || requestedModel;
    this.resolvedDefaultModel = resolvedModel;

    return {
      text,
      confidence: 0.82,
      providerId: this.id,
      model: resolvedModel,
      configuredModel: this.defaultModel,
      resolvedModel,
      usage: {
        latencyMs:
          payload.total_duration !== undefined
            ? Math.round(payload.total_duration / 1_000_000)
            : Date.now() - startedAt,
        tokens: estimateTokensFromCounts(
          payload.prompt_eval_count,
          payload.eval_count
        ),
        estimatedCostUsd: 0
      },
      finishReason:
        payload.done_reason === 'stop' || payload.done_reason === 'length'
          ? 'stop'
          : 'stop'
    };
  }

  private buildMessages(request: ModelRequest): Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> {
    const systemLines = [
      'You are ASSEM, a local-first assistant.',
      `Privacy mode: ${request.privacyMode}. Runtime mode: ${request.runtimeMode}.`,
      request.availableTools.length > 0
        ? `Local tools available through the orchestrator: ${request.availableTools
            .map((tool) => tool.label)
            .join(', ')}.`
        : '',
      request.activeProfile
        ? `Active profile: ${request.activeProfile.name}.`
        : '',
      'Keep answers concise and practical. The orchestrator handles confirmations, tool execution and persistence.'
    ].filter(Boolean);

    return [
      {
        role: 'system',
        content: systemLines.join(' ')
      },
      ...request.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ];
  }

  private formatConnectionError(error: unknown): string {
    if (error instanceof Error) {
      return `Unable to reach Ollama at ${this.baseUrl}. ${error.message}`;
    }

    return `Unable to reach Ollama at ${this.baseUrl}.`;
  }
}
