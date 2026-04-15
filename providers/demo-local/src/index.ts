import type {
  EngineProvider,
  ModelRequest,
  ModelResponse,
  PrivacyMode,
  ProviderCapability,
  ProviderHealth
} from '@assem/shared-types';

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
    const normalized = lastUserMessage.toLowerCase();
    const toolSummary = listTools(request);
    const activeProfile = request.activeProfile?.name;

    let text =
      'I am running in local scaffold mode. I can already answer time questions, manage a mock calendar, and create local files or folders through a confirmation flow.';

    if (/(what can you do|help|ayuda|que puedes hacer)/i.test(normalized)) {
      text = `This MVP can use these tools right now: ${toolSummary}. It also understands policy instructions like "Hoy no me preguntes mas" and supports sandbox versus live execution.`;
    } else if (/(privacy|private mode|modo privado|local only)/i.test(normalized)) {
      text =
        'Privacy mode is currently local-first. The router can keep execution fully local or relax it later without changing the UI.';
    } else if (/(history|historial|what happened)/i.test(normalized)) {
      text =
        'The side panel shows action history, including confirmations, tool results, policy changes, and scheduler runs.';
    } else if (/(profile|perfil)/i.test(normalized) && activeProfile) {
      text = `The active profile right now is "${activeProfile}". Its persistent notes and preferences can be used to steer future providers without changing the orchestration layer.`;
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
