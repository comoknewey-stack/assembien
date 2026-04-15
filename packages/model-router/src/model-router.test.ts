import { describe, expect, it } from 'vitest';

import type {
  EngineProvider,
  ModelRequest,
  ModelResponse,
  PrivacyMode,
  ProviderCapability,
  ProviderHealth,
  ProviderHealthStatus
} from '@assem/shared-types';

import { ModelRouter } from './index';

const allModes: PrivacyMode[] = [
  'local_only',
  'prefer_local',
  'balanced',
  'cloud_allowed'
];

interface FakeProviderOptions {
  id: string;
  label: string;
  defaultModel: string;
  supportsLocalOnly: boolean;
  capabilities?: ProviderCapability[];
  supportsPrivacyModes?: PrivacyMode[];
  timeoutMs?: number;
  configured?: boolean;
  healthFactory?: () => Promise<ProviderHealth>;
  responseFactory?: () => Promise<ModelResponse>;
}

class FakeProvider implements EngineProvider {
  readonly id: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly supportsLocalOnly: boolean;
  readonly capabilities: ProviderCapability[];
  readonly supportsPrivacyModes: PrivacyMode[];
  readonly timeoutMs?: number;

  private readonly configured: boolean;
  private readonly healthFactory?: () => Promise<ProviderHealth>;
  private readonly responseFactory: () => Promise<ModelResponse>;

  constructor(options: FakeProviderOptions) {
    this.id = options.id;
    this.label = options.label;
    this.defaultModel = options.defaultModel;
    this.supportsLocalOnly = options.supportsLocalOnly;
    this.capabilities = options.capabilities ?? ['chat'];
    this.supportsPrivacyModes = options.supportsPrivacyModes ?? [...allModes];
    this.timeoutMs = options.timeoutMs ?? 200;
    this.configured = options.configured ?? true;
    this.healthFactory = options.healthFactory;
    this.responseFactory =
      options.responseFactory ??
      (async () =>
        createResponse(this.id, this.defaultModel, `${this.id} response`));
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (this.healthFactory) {
      return this.healthFactory();
    }

    return createHealth(
      this,
      this.configured ? 'ok' : 'unavailable',
      this.configured ? undefined : 'Provider is not configured.'
    );
  }

  async run(_request: ModelRequest): Promise<ModelResponse> {
    return this.responseFactory();
  }
}

function createHealth(
  provider: EngineProvider,
  status: ProviderHealthStatus,
  error?: string
): ProviderHealth {
  return {
    providerId: provider.id,
    label: provider.label,
    status,
    checkedAt: new Date().toISOString(),
    error,
    configured: provider.isConfigured(),
    supportsLocalOnly: provider.supportsLocalOnly,
    defaultModel: provider.defaultModel,
    capabilities: provider.capabilities,
    supportsPrivacyModes: provider.supportsPrivacyModes
  };
}

function createResponse(
  providerId: string,
  model: string,
  text: string
): ModelResponse {
  return {
    text,
    confidence: 0.8,
    providerId,
    model
  };
}

const baseRequest: ModelRequest = {
  messages: [],
  availableTools: [],
  privacyMode: 'prefer_local',
  runtimeMode: 'sandbox',
  requiredCapabilities: ['chat']
};

describe('ModelRouter', () => {
  it('falls back to demo-local when Ollama is unhealthy', async () => {
    const ollama = new FakeProvider({
      id: 'ollama',
      label: 'Ollama local provider',
      defaultModel: 'llama3.2',
      supportsLocalOnly: true,
      healthFactory: async () => ({
        providerId: 'ollama',
        label: 'Ollama local provider',
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        error: 'Unable to reach Ollama.',
        configured: true,
        supportsLocalOnly: true,
        defaultModel: 'llama3.2',
        capabilities: ['chat'],
        supportsPrivacyModes: [...allModes]
      })
    });
    const demoLocal = new FakeProvider({
      id: 'demo-local',
      label: 'Demo local provider',
      defaultModel: 'demo-local-heuristic',
      supportsLocalOnly: true,
      responseFactory: async () =>
        createResponse('demo-local', 'demo-local-heuristic', 'fallback worked')
    });
    const router = new ModelRouter([ollama, demoLocal], 'ollama');

    const response = await router.respond(baseRequest);

    expect(response.providerId).toBe('demo-local');
    expect(response.fallbackUsed).toBe(true);
    expect(response.fallbackReason).toContain('ollama: Unable to reach Ollama.');
  });

  it('falls back to demo-local when Ollama times out', async () => {
    const ollama = new FakeProvider({
      id: 'ollama',
      label: 'Ollama local provider',
      defaultModel: 'llama3.2',
      supportsLocalOnly: true,
      timeoutMs: 20,
      responseFactory: async () =>
        new Promise<ModelResponse>((resolve) => {
          setTimeout(() => {
            resolve(createResponse('ollama', 'llama3.2', 'late reply'));
          }, 60);
        })
    });
    const demoLocal = new FakeProvider({
      id: 'demo-local',
      label: 'Demo local provider',
      defaultModel: 'demo-local-heuristic',
      supportsLocalOnly: true,
      responseFactory: async () =>
        createResponse('demo-local', 'demo-local-heuristic', 'demo fallback')
    });
    const router = new ModelRouter([ollama, demoLocal], 'ollama', {
      providerTimeoutMs: 25,
      healthTtlMs: 0
    });

    const response = await router.respond(baseRequest);

    expect(response.providerId).toBe('demo-local');
    expect(response.fallbackUsed).toBe(true);
    expect(response.fallbackReason).toContain('ollama: Provider ollama timed out');
  });

  it('keeps local_only requests on local providers', async () => {
    const router = new ModelRouter(
      [
        new FakeProvider({
          id: 'cloud',
          label: 'Cloud provider',
          defaultModel: 'cloud-model',
          supportsLocalOnly: false,
          supportsPrivacyModes: ['balanced', 'cloud_allowed'],
          responseFactory: async () =>
            createResponse('cloud', 'cloud-model', 'cloud')
        }),
        new FakeProvider({
          id: 'demo-local',
          label: 'Demo local provider',
          defaultModel: 'demo-local-heuristic',
          supportsLocalOnly: true,
          responseFactory: async () =>
            createResponse('demo-local', 'demo-local-heuristic', 'local')
        })
      ],
      'cloud'
    );

    const response = await router.respond({
      ...baseRequest,
      privacyMode: 'local_only'
    });

    expect(response.providerId).toBe('demo-local');
  });

  it.each(['prefer_local', 'balanced'] satisfies PrivacyMode[])(
    'prioritizes Ollama in %s mode before demo-local',
    async (privacyMode) => {
      const router = new ModelRouter(
        [
          new FakeProvider({
            id: 'ollama',
            label: 'Ollama local provider',
            defaultModel: 'llama3.2',
            supportsLocalOnly: true,
            responseFactory: async () =>
              createResponse('ollama', 'llama3.2', 'ollama')
          }),
          new FakeProvider({
            id: 'demo-local',
            label: 'Demo local provider',
            defaultModel: 'demo-local-heuristic',
            supportsLocalOnly: true,
            responseFactory: async () =>
              createResponse('demo-local', 'demo-local-heuristic', 'demo')
          })
        ],
        'ollama'
      );

      const response = await router.respond({
        ...baseRequest,
        privacyMode
      });

      expect(response.providerId).toBe('ollama');
    }
  );

  it('allows a cloud provider in cloud_allowed mode when it is the preferred route', async () => {
    const router = new ModelRouter(
      [
        new FakeProvider({
          id: 'ollama',
          label: 'Ollama local provider',
          defaultModel: 'llama3.2',
          supportsLocalOnly: true,
          responseFactory: async () =>
            createResponse('ollama', 'llama3.2', 'ollama')
        }),
        new FakeProvider({
          id: 'cloud',
          label: 'Cloud provider',
          defaultModel: 'cloud-model',
          supportsLocalOnly: false,
          supportsPrivacyModes: ['balanced', 'cloud_allowed'],
          responseFactory: async () =>
            createResponse('cloud', 'cloud-model', 'cloud')
        }),
        new FakeProvider({
          id: 'demo-local',
          label: 'Demo local provider',
          defaultModel: 'demo-local-heuristic',
          supportsLocalOnly: true,
          responseFactory: async () =>
            createResponse('demo-local', 'demo-local-heuristic', 'demo')
        })
      ],
      'cloud'
    );

    const response = await router.respond({
      ...baseRequest,
      privacyMode: 'cloud_allowed',
      preferredProviderId: 'cloud'
    });

    expect(response.providerId).toBe('cloud');
  });
});
