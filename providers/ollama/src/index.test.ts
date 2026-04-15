import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelRequest } from '@assem/shared-types';

import { OllamaModelProvider } from './index';

const baseRequest: ModelRequest = {
  messages: [
    {
      id: 'user-1',
      role: 'user',
      content: 'Hola',
      createdAt: new Date().toISOString()
    }
  ],
  availableTools: [],
  privacyMode: 'local_only',
  runtimeMode: 'sandbox',
  requiredCapabilities: ['chat']
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OllamaModelProvider', () => {
  it('resolves an untagged configured model to :latest when Ollama exposes that tag', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          models: [{ name: 'llama3.2:latest' }, { name: 'mistral' }]
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaModelProvider({
      baseUrl: 'http://127.0.0.1:11434/',
      defaultModel: 'llama3.2',
      timeoutMs: 2_000
    });
    const health = await provider.healthCheck();

    expect(health.status).toBe('ok');
    expect(health.defaultModel).toBe('llama3.2');
    expect(health.resolvedModel).toBe('llama3.2:latest');
    expect(health.availableModels).toEqual(['llama3.2:latest', 'mistral']);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', {
      method: 'GET'
    });
  });

  it('keeps an explicit model tag when that exact model is installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            models: [{ name: 'llama3.2:latest' }, { name: 'llama3.2:q4_k_m' }]
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
    );

    const provider = new OllamaModelProvider({
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'llama3.2:q4_k_m'
    });
    const health = await provider.healthCheck();

    expect(health.status).toBe('ok');
    expect(health.defaultModel).toBe('llama3.2:q4_k_m');
    expect(health.resolvedModel).toBe('llama3.2:q4_k_m');
  });

  it('reports degraded health when the configured model does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            models: [{ name: 'mistral' }]
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
    );

    const provider = new OllamaModelProvider({
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'llama3.2'
    });
    const health = await provider.healthCheck();

    expect(health.status).toBe('degraded');
    expect(health.resolvedModel).toBeUndefined();
    expect(health.error).toContain('ASSEM checked "llama3.2" and "llama3.2:latest"');
  });

  it('does not treat a distinct explicit tag as equivalent to :latest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            models: [{ name: 'llama3.2:latest' }]
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
      )
    );

    const provider = new OllamaModelProvider({
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'llama3.2:q4_k_m'
    });
    const health = await provider.healthCheck();

    expect(health.status).toBe('degraded');
    expect(health.resolvedModel).toBeUndefined();
    expect(health.error).toBe(
      'Configured model "llama3.2:q4_k_m" is not installed in Ollama.'
    );
  });

  it('uses the resolved model name in chat requests and records the actual model returned by Ollama', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [{ name: 'llama3.2:latest' }]
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        );
      }

      return new Response(
        JSON.stringify({
          model: 'llama3.2:latest',
          message: {
            role: 'assistant',
            content: 'Respuesta desde Ollama'
          },
          done_reason: 'stop',
          total_duration: 240000000,
          prompt_eval_count: 11,
          eval_count: 7
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaModelProvider({
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'llama3.2'
    });

    await provider.healthCheck();
    const response = await provider.run(baseRequest);

    expect(response.providerId).toBe('ollama');
    expect(response.configuredModel).toBe('llama3.2');
    expect(response.resolvedModel).toBe('llama3.2:latest');
    expect(response.model).toBe('llama3.2:latest');
    expect(response.text).toBe('Respuesta desde Ollama');
    expect(response.usage).toMatchObject({
      latencyMs: 240,
      estimatedCostUsd: 0,
      tokens: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18
      }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3.2:latest',
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'You are ASSEM, a local-first assistant. Privacy mode: local_only. Runtime mode: sandbox. Keep answers concise and practical. The orchestrator handles confirmations, tool execution and persistence.'
          },
          {
            role: 'user',
            content: 'Hola'
          }
        ]
      })
    });
  });

  it('surfaces connection errors with a clear Ollama message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );

    const provider = new OllamaModelProvider({
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'llama3.2'
    });

    const health = await provider.healthCheck();
    expect(health.status).toBe('unavailable');
    expect(health.error).toContain('Unable to reach Ollama at http://127.0.0.1:11434.');

    await expect(provider.run(baseRequest)).rejects.toThrow(
      'Unable to reach Ollama at http://127.0.0.1:11434. connect ECONNREFUSED'
    );
  });
});
