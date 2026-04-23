import type {
  ToolDefinition,
  WebSearchInput,
  WebSearchOutput,
  WebSearchProvider,
  WebSearchProviderStatus,
  WebSearchResult
} from '@assem/shared-types';

const BRAVE_DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const MAX_WEB_SEARCH_RESULTS = 10;

type FetchLike = typeof fetch;

export interface BraveWebSearchProviderOptions {
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  age?: unknown;
  profile?: {
    name?: unknown;
  };
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-secret]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/X-Subscription-Token:\s*[a-zA-Z0-9._-]+/gi, 'X-Subscription-Token: [redacted]');
}

export function normalizeWebSearchMaxResults(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return DEFAULT_WEB_SEARCH_MAX_RESULTS;
  }

  return Math.max(
    1,
    Math.min(MAX_WEB_SEARCH_RESULTS, Math.floor(value ?? DEFAULT_WEB_SEARCH_MAX_RESULTS))
  );
}

function resolveFreshness(recencyDays: number | undefined): string | undefined {
  if (!recencyDays || recencyDays <= 0) {
    return undefined;
  }

  if (recencyDays <= 1) {
    return 'pd';
  }

  if (recencyDays <= 7) {
    return 'pw';
  }

  if (recencyDays <= 31) {
    return 'pm';
  }

  if (recencyDays <= 365) {
    return 'py';
  }

  return undefined;
}

function hostnameForUrl(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

export class UnconfiguredWebSearchProvider implements WebSearchProvider {
  readonly id = 'disabled';
  readonly label = 'Web search disabled';
  readonly maxResults: number;

  constructor(maxResults = DEFAULT_WEB_SEARCH_MAX_RESULTS) {
    this.maxResults = normalizeWebSearchMaxResults(maxResults);
  }

  getStatus(): WebSearchProviderStatus {
    return {
      providerId: this.id,
      configured: false,
      available: false,
      maxResults: this.maxResults,
      lastError:
        'Web search is not configured. Set ASSEM_WEB_SEARCH_PROVIDER=brave and ASSEM_WEB_SEARCH_API_KEY.'
    };
  }

  async search(_input: WebSearchInput): Promise<WebSearchOutput> {
    throw new Error(this.getStatus().lastError);
  }
}

export class BraveWebSearchProvider implements WebSearchProvider {
  readonly id = 'brave';
  readonly label = 'Brave Search';
  readonly maxResults: number;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private lastError: string | undefined;

  constructor(options: BraveWebSearchProviderOptions = {}) {
    this.endpoint = options.endpoint?.trim() || BRAVE_DEFAULT_ENDPOINT;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.maxResults = normalizeWebSearchMaxResults(options.maxResults);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getStatus(): WebSearchProviderStatus {
    const configured = Boolean(this.apiKey);
    return {
      providerId: this.id,
      configured,
      available: configured && !this.lastError,
      maxResults: this.maxResults,
      endpoint: this.endpoint,
      lastError: this.lastError
    };
  }

  async search(input: WebSearchInput): Promise<WebSearchOutput> {
    if (!this.apiKey) {
      this.lastError =
        'Brave Search is not configured. Set ASSEM_WEB_SEARCH_API_KEY.';
      throw new Error(this.lastError);
    }

    const query = input.query.trim();
    if (!query) {
      throw new Error('Web search requires a non-empty query.');
    }

    const maxResults = normalizeWebSearchMaxResults(
      input.maxResults ?? this.maxResults
    );
    const retrievedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = new URL(this.endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(maxResults));
      const freshness = resolveFreshness(input.recencyDays);
      if (freshness) {
        url.searchParams.set('freshness', freshness);
      }

      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Brave Search request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
        );
      }

      const payload = (await response.json()) as BraveSearchResponse;
      const results = (payload.web?.results ?? [])
        .slice(0, maxResults)
        .map((result): WebSearchResult | null => {
          const title = typeof result.title === 'string' ? result.title.trim() : '';
          const urlValue = typeof result.url === 'string' ? result.url.trim() : '';
          if (!title && !urlValue) {
            return null;
          }

          const snippet =
            typeof result.description === 'string'
              ? result.description.trim()
              : undefined;
          const source =
            typeof result.profile?.name === 'string'
              ? result.profile.name
              : hostnameForUrl(urlValue);
          const publishedAt =
            typeof result.age === 'string' ? result.age : undefined;

          return {
            title: title || urlValue,
            url: urlValue,
            snippet,
            source,
            publishedAt,
            retrievedAt
          };
        })
        .filter((result): result is WebSearchResult => Boolean(result));

      this.lastError = undefined;
      return {
        providerId: this.id,
        query,
        retrievedAt,
        results
      };
    } catch (error) {
      const rawMessage =
        error instanceof Error && error.name === 'AbortError'
          ? `Brave Search timed out after ${this.timeoutMs}ms.`
          : error instanceof Error
            ? error.message
            : 'Unknown Brave Search error.';
      this.lastError = sanitizeErrorMessage(rawMessage);
      throw new Error(this.lastError);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createWebSearchProvider(options: {
  providerId?: string;
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): WebSearchProvider {
  if (options.providerId === 'brave') {
    return new BraveWebSearchProvider({
      apiKey: options.apiKey,
      endpoint: options.endpoint,
      maxResults: options.maxResults,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl
    });
  }

  return new UnconfiguredWebSearchProvider(options.maxResults);
}

export function createWebSearchTool(
  provider: WebSearchProvider
): ToolDefinition<WebSearchInput, WebSearchOutput> {
  return {
    id: 'web-search.search',
    label: 'Search web',
    description:
      'Searches the public web through the configured web search provider and returns structured results.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['external_communication', 'read_only'],
    async execute(input, context) {
      if (context.activeMode.privacy === 'local_only') {
        throw new Error(
          'La busqueda web esta bloqueada en modo local_only. Cambia el modo de privacidad antes de investigar en la web.'
        );
      }

      const output = await provider.search(input);
      return {
        summary: `Found ${output.results.length} web result(s) for "${output.query}".`,
        output
      };
    }
  };
}
