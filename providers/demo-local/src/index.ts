import type {
  EngineProvider,
  ModelRequest,
  ModelResponse,
  PrivacyMode,
  ProviderCapability,
  ProviderHealth
} from '@assem/shared-types';

function normalizeMessage(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[?!,.;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectLanguage(text: string): 'es' | 'en' {
  const normalized = normalizeMessage(text);
  const spanishScore = [
    /\bhola\b/,
    /\bbuenas\b/,
    /\bque\b/,
    /\bpuedes\b/,
    /\bherramientas\b/,
    /\bproveedor\b|\bproviders\b/,
    /\bhora\b/,
    /\bfecha\b/,
    /\bsandbox\b/
  ].filter((pattern) => pattern.test(normalized)).length;
  const englishScore = [
    /\bhello\b|\bhi\b|\bhey\b/,
    /\bwhat\b/,
    /\bcan\b/,
    /\btools\b/,
    /\bprovider\b/,
    /\btime\b/,
    /\bdate\b/,
    /\bsandbox\b/
  ].filter((pattern) => pattern.test(normalized)).length;

  return englishScore > spanishScore ? 'en' : 'es';
}

function listTools(request: ModelRequest): string {
  return request.availableTools.map((tool) => tool.label).join(', ');
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class DemoLocalModelProvider implements EngineProvider {
  readonly id = 'demo-local';
  readonly label = 'Demo local provider';
  readonly defaultModel = 'demo-local-heuristic';
  readonly supportsLocalOnly = true;
  readonly capabilities: ProviderCapability[] = [
    'chat',
    'tool_reasoning',
    'telemetry'
  ];
  readonly supportsPrivacyModes: PrivacyMode[] = [
    'local_only',
    'prefer_local',
    'balanced',
    'cloud_allowed'
  ];
  readonly timeoutMs = 2_000;

  isConfigured(): boolean {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      providerId: this.id,
      label: this.label,
      status: 'ok',
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      configured: true,
      supportsLocalOnly: this.supportsLocalOnly,
      defaultModel: this.defaultModel,
      capabilities: [...this.capabilities],
      supportsPrivacyModes: [...this.supportsPrivacyModes]
    };
  }

  async run(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    const lastUserMessage =
      [...request.messages].reverse().find((message) => message.role === 'user')
        ?.content ?? '';
    const normalized = normalizeMessage(lastUserMessage);
    const language = detectLanguage(lastUserMessage);
    const toolSummary = listTools(request);
    const activeProfile = request.activeProfile?.name;

    let text =
      language === 'es'
        ? 'Puedo ayudarte dentro del entorno local actual. Si quieres algo concreto, pideme la hora y la fecha, el estado del sistema, el sandbox o una accion local segura.'
        : 'I can help within the current local environment. Ask for the time and date, the system status, the sandbox, or a safe local action.';

    if (/(what can you do|help|ayuda|que puedes hacer)/i.test(normalized)) {
      text =
        language === 'es'
          ? `Ahora mismo puedo usar estas herramientas: ${toolSummary}. Tambien mantengo historial, confirmaciones, perfiles, scheduler y modos de privacidad/runtime dentro del entorno local actual.`
          : `Right now I can use these tools: ${toolSummary}. I also keep action history, confirmations, profiles, the scheduler, and privacy/runtime modes inside the current local environment.`;
    } else if (/(privacy|private mode|modo privado|local only)/i.test(normalized)) {
      text =
        language === 'es'
          ? `El modo actual es ${request.privacyMode} / ${request.runtimeMode}.`
          : `The current mode is ${request.privacyMode} / ${request.runtimeMode}.`;
    } else if (/(history|historial|what happened)/i.test(normalized)) {
      text =
        language === 'es'
          ? 'Puedo revisar historial de acciones, confirmaciones, resultados de tools, cambios de politica y ejecuciones del scheduler dentro de esta sesion.'
          : 'I can review action history, confirmations, tool results, policy changes, and scheduler runs in this session.';
    } else if (/(profile|perfil)/i.test(normalized) && activeProfile) {
      text =
        language === 'es'
          ? `El perfil activo ahora mismo es "${activeProfile}".`
          : `The active profile right now is "${activeProfile}".`;
    }

    const latencyMs = Date.now() - startedAt;
    const promptTokens = estimateTokenCount(lastUserMessage);
    const completionTokens = estimateTokenCount(text);

    return {
      text,
      confidence: 0.68,
      providerId: this.id,
      model: this.defaultModel,
      usage: {
        latencyMs,
        tokens: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens
        },
        estimatedCostUsd: 0
      },
      finishReason: 'stop'
    };
  }
}
