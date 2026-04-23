import { describe, expect, it, vi } from 'vitest';

import {
  BraveWebSearchProvider,
  UnconfiguredWebSearchProvider,
  normalizeWebSearchMaxResults
} from './index';

describe('web-search integration', () => {
  it('keeps maxResults at default 5 and absolute max 10', () => {
    expect(normalizeWebSearchMaxResults(undefined)).toBe(5);
    expect(normalizeWebSearchMaxResults(0)).toBe(1);
    expect(normalizeWebSearchMaxResults(99)).toBe(10);
  });

  it('fails clearly when no provider is configured', async () => {
    const provider = new UnconfiguredWebSearchProvider();

    await expect(provider.search({ query: 'galletas islandia' })).rejects.toThrow(
      'Web search is not configured'
    );
    expect(provider.getStatus()).toMatchObject({
      configured: false,
      available: false
    });
  });

  it('maps Brave results into structured web search results', async () => {
    let calledUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: unknown) => {
      calledUrl = input instanceof URL ? input : new URL(String(input));
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'Iceland statistics',
                url: 'https://statice.is/example',
                description: 'Official statistical snippet',
                profile: {
                  name: 'Statistics Iceland'
                }
              }
            ]
          }
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    });
    const provider = new BraveWebSearchProvider({
      apiKey: 'test-key',
      maxResults: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const result = await provider.search({
      query: 'consumo de galletas en Islandia',
      maxResults: 50
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(calledUrl?.searchParams.get('count')).toBe('10');
    expect(result).toMatchObject({
      providerId: 'brave',
      query: 'consumo de galletas en Islandia',
      results: [
        {
          title: 'Iceland statistics',
          url: 'https://statice.is/example',
          snippet: 'Official statistical snippet',
          source: 'Statistics Iceland'
        }
      ]
    });
  });

  it('turns a slow Brave response into a timeout error', async () => {
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 5);
        })
    );
    const provider = new BraveWebSearchProvider({
      apiKey: 'test-key',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    await expect(provider.search({ query: 'slow query' })).rejects.toThrow(
      /timed out|Aborted/
    );
  });
});
