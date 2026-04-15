import type {
  EngineProvider,
  ModelRequest,
  ModelResponse,
  ModelRouter as ModelRouterContract,
  PrivacyMode,
  ProviderCapability,
  ProviderHealth,
  ProviderSummary
} from '@assem/shared-types';

interface HealthCacheEntry {
  checkedAt: number;
  value: ProviderHealth;
}

interface RouterOptions {
  providerTimeoutMs?: number;
  healthTtlMs?: number;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  providerId: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Provider ${providerId} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function supportsCapabilities(
  provider: EngineProvider,
  required: ProviderCapability[] | undefined
): boolean {
  if (!required?.length) {
    return true;
  }

  return required.every((capability) =>
    provider.capabilities.includes(capability)
  );
}

function supportsMode(provider: EngineProvider, mode: PrivacyMode): boolean {
  if (mode === 'local_only' && !provider.supportsLocalOnly) {
    return false;
  }

  return provider.supportsPrivacyModes.includes(mode);
}

function formatFailure(providerId: string, reason: string): string {
  return `${providerId}: ${reason}`;
}

export class ModelRouter implements ModelRouterContract {
  private readonly providers = new Map<string, EngineProvider>();
  private readonly healthCache = new Map<string, HealthCacheEntry>();
  private readonly options: Required<RouterOptions>;

  constructor(
    providers: EngineProvider[],
    private readonly defaultProviderId: string,
    options: RouterOptions = {}
  ) {
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
    }

    this.options = {
      providerTimeoutMs: options.providerTimeoutMs ?? 15_000,
      healthTtlMs: options.healthTtlMs ?? 15_000
    };
  }

  listProviders(): ProviderSummary[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      label: provider.label,
      configured: provider.isConfigured(),
      defaultModel: provider.defaultModel,
      supportsLocalOnly: provider.supportsLocalOnly,
      capabilities: provider.capabilities,
      supportsPrivacyModes: provider.supportsPrivacyModes
    }));
  }

  async healthCheck(): Promise<ProviderHealth[]> {
    return Promise.all(
      [...this.providers.values()].map((provider) =>
        this.getProviderHealth(provider, true)
      )
    );
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const candidates = this.selectCandidates(request);
    const failures: string[] = [];
    let fallbackUsed = false;

    for (const provider of candidates) {
      const health = await this.getProviderHealth(provider, false);
      if (health.status !== 'ok') {
        fallbackUsed = true;
        failures.push(
          formatFailure(
            provider.id,
            health.error ?? `health status is ${health.status}`
          )
        );
        continue;
      }

      try {
        const response = await withTimeout(
          provider.run(request),
          provider.timeoutMs ?? this.options.providerTimeoutMs,
          provider.id
        );

        const health = await this.getProviderHealth(provider, true);
        this.healthCache.set(provider.id, {
          checkedAt: Date.now(),
          value: health
        });

        return {
          ...response,
          fallbackUsed,
          fallbackReason: fallbackUsed ? failures.join(' | ') : undefined,
          finishReason:
            fallbackUsed && response.finishReason === undefined
              ? 'fallback'
              : response.finishReason,
          usage: {
            ...(response.usage ?? {}),
            fallbackReason: fallbackUsed ? failures.join(' | ') : undefined
          }
        };
      } catch (error) {
        fallbackUsed = true;
        failures.push(
          formatFailure(
            provider.id,
            error instanceof Error ? error.message : 'unknown provider error'
          )
        );

        this.healthCache.set(provider.id, {
          checkedAt: Date.now(),
          value: {
            providerId: provider.id,
            label: provider.label,
            status: 'unavailable',
            checkedAt: new Date().toISOString(),
            error:
              error instanceof Error ? error.message : 'unknown provider error',
            configured: provider.isConfigured(),
            supportsLocalOnly: provider.supportsLocalOnly,
            defaultModel: provider.defaultModel,
            capabilities: provider.capabilities,
            supportsPrivacyModes: provider.supportsPrivacyModes
          }
        });
      }
    }

    throw new Error(
      failures.length > 0
        ? `No provider could satisfy the request. ${failures.join(' | ')}`
        : 'No provider could satisfy the request.'
    );
  }

  private selectCandidates(request: ModelRequest): EngineProvider[] {
    const configured = [...this.providers.values()].filter((provider) =>
      provider.isConfigured()
    );

    if (configured.length === 0) {
      throw new Error('No configured model providers are registered.');
    }

    const capable = configured.filter((provider) =>
      supportsCapabilities(provider, request.requiredCapabilities)
    );

    if (capable.length === 0) {
      throw new Error('No provider supports the required capabilities.');
    }

    const modeEligible = capable.filter((provider) =>
      supportsMode(provider, request.privacyMode)
    );

    if (request.privacyMode === 'local_only' && modeEligible.length === 0) {
      throw new Error('No local-only provider is available for this request.');
    }

    const basePool = modeEligible.length > 0 ? modeEligible : capable;
    const preferredId = request.preferredProviderId ?? this.defaultProviderId;

    return [...basePool].sort((left, right) => {
      const leftScore = this.providerScore(left, request.privacyMode, preferredId);
      const rightScore = this.providerScore(
        right,
        request.privacyMode,
        preferredId
      );

      return rightScore - leftScore;
    });
  }

  private providerScore(
    provider: EngineProvider,
    mode: PrivacyMode,
    preferredId: string
  ): number {
    let score = 0;
    const isOllama = provider.id === 'ollama';
    const isDemoLocal = provider.id === 'demo-local';
    const isCloudProvider = !provider.supportsLocalOnly;

    if (provider.id === preferredId) {
      score += 100;
    }

    switch (mode) {
      case 'local_only':
      case 'prefer_local':
        if (isOllama) {
          score += 300;
        } else if (isDemoLocal) {
          score += 200;
        } else if (provider.supportsLocalOnly) {
          score += 100;
        }
        break;
      case 'balanced':
        if (isOllama) {
          score += 260;
        } else if (isDemoLocal) {
          score += 160;
        } else if (provider.supportsLocalOnly) {
          score += 120;
        } else {
          score += 90;
        }
        break;
      case 'cloud_allowed':
        if (isCloudProvider) {
          score += 220;
        }
        if (isOllama) {
          score += 180;
        } else if (isDemoLocal) {
          score += 120;
        } else if (provider.supportsLocalOnly) {
          score += 100;
        }
        break;
    }

    if (provider.supportsLocalOnly) {
      score += 20;
    }

    return score;
  }

  private async getProviderHealth(
    provider: EngineProvider,
    forceRefresh = false
  ): Promise<ProviderHealth> {
    const cached = this.healthCache.get(provider.id);
    if (
      !forceRefresh &&
      cached &&
      Date.now() - cached.checkedAt < this.options.healthTtlMs
    ) {
      return cached.value;
    }

    try {
      const health = await withTimeout(
        provider.healthCheck(),
        provider.timeoutMs ?? this.options.providerTimeoutMs,
        provider.id
      );

      this.healthCache.set(provider.id, {
        checkedAt: Date.now(),
        value: health
      });

      return health;
    } catch (error) {
      const health: ProviderHealth = {
        providerId: provider.id,
        label: provider.label,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown health error',
        configured: provider.isConfigured(),
        supportsLocalOnly: provider.supportsLocalOnly,
        defaultModel: provider.defaultModel,
        capabilities: provider.capabilities,
        supportsPrivacyModes: provider.supportsPrivacyModes
      };

      this.healthCache.set(provider.id, {
        checkedAt: Date.now(),
        value: health
      });

      return health;
    }
  }
}
