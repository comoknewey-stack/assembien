import net from 'node:net';

import type {
  BrowserAutomationProvider,
  BrowserAutomationProviderStatus,
  BrowserClickLinkInput,
  BrowserClickLinkOutput,
  BrowserClosePageOutput,
  BrowserFallbackMode,
  BrowserExtractVisibleTextInput,
  BrowserExtractVisibleTextOutput,
  BrowserFindOnPageInput,
  BrowserFindOnPageOutput,
  BrowserOpenErrorType,
  BrowserListVisibleLinksInput,
  BrowserListVisibleLinksOutput,
  BrowserNavigationEntry,
  BrowserOpenTransportRecord,
  BrowserOpenPageInput,
  BrowserOpenPageOutput,
  BrowserPageLinkRecord,
  BrowserPageReferenceInput,
  BrowserPageSnapshot,
  ToolDefinition,
  WebPageFetchInput,
  WebPageFetchOutput,
  WebPageReadQuality,
  WebPageFetchStatus,
  WebPageReaderProvider,
  WebPageReaderProviderStatus
} from '@assem/shared-types';

type FetchLike = typeof fetch;

export const DEFAULT_WEB_PAGE_FETCH_TIMEOUT_MS = 12_000;
export const DEFAULT_WEB_PAGE_MAX_SOURCES = 3;
export const MAX_WEB_PAGE_SOURCES = 5;
export const DEFAULT_WEB_PAGE_MAX_CONTENT_CHARS = 20_000;
export const MAX_WEB_PAGE_CONTENT_CHARS = 50_000;
export const DEFAULT_WEB_PAGE_MIN_TEXT_CHARS = 220;
export const DEFAULT_WEB_PAGE_MIN_TEXT_DENSITY = 0.18;
export const DEFAULT_WEB_PAGE_MAX_LINK_DENSITY = 0.55;
export const DEFAULT_BROWSER_MAX_PAGES_PER_TASK = 3;
export const MAX_BROWSER_MAX_PAGES_PER_TASK = 5;
export const DEFAULT_BROWSER_MAX_LINKS_PER_PAGE = 20;
export const MAX_BROWSER_MAX_LINKS_PER_PAGE = 40;
export const DEFAULT_BROWSER_TEXT_MAX_CHARS = 12_000;
export const MAX_BROWSER_TEXT_MAX_CHARS = 50_000;
export const DEFAULT_BROWSER_TIMEOUT_MS = 15_000;
export const DEFAULT_BROWSER_ALLOW_SCREENSHOTS = false;
const DEFAULT_BROWSER_HTML_MAX_CHARS = 120_000;

interface SimpleWebPageReaderOptions {
  enabled?: boolean;
  timeoutMs?: number;
  maxSources?: number;
  maxContentChars?: number;
  minTextChars?: number;
  minTextDensity?: number;
  maxLinkDensity?: number;
  fetchImpl?: FetchLike;
}

interface SimpleBrowserAutomationOptions {
  enabled?: boolean;
  timeoutMs?: number;
  maxPagesPerTask?: number;
  maxLinksPerPage?: number;
  textMaxChars?: number;
  allowScreenshots?: boolean;
  fetchImpl?: FetchLike;
}

interface UrlValidationResult {
  allowed: boolean;
  reason?: string;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
}

function clampRatio(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }

  return Math.max(0.01, Math.min(1, value ?? fallback));
}

export function normalizeWebPageMaxSources(value: number | undefined): number {
  return clampInteger(value, DEFAULT_WEB_PAGE_MAX_SOURCES, 0, MAX_WEB_PAGE_SOURCES);
}

export function normalizeWebPageMaxContentChars(value: number | undefined): number {
  return clampInteger(
    value,
    DEFAULT_WEB_PAGE_MAX_CONTENT_CHARS,
    1_000,
    MAX_WEB_PAGE_CONTENT_CHARS
  );
}

export function normalizeWebPageMinTextChars(value: number | undefined): number {
  return clampInteger(value, DEFAULT_WEB_PAGE_MIN_TEXT_CHARS, 80, 5_000);
}

export function normalizeWebPageMinTextDensity(value: number | undefined): number {
  return clampRatio(value, DEFAULT_WEB_PAGE_MIN_TEXT_DENSITY);
}

export function normalizeWebPageMaxLinkDensity(value: number | undefined): number {
  return clampRatio(value, DEFAULT_WEB_PAGE_MAX_LINK_DENSITY);
}

export function normalizeBrowserMaxPagesPerTask(value: number | undefined): number {
  return clampInteger(
    value,
    DEFAULT_BROWSER_MAX_PAGES_PER_TASK,
    1,
    MAX_BROWSER_MAX_PAGES_PER_TASK
  );
}

export function normalizeBrowserMaxLinksPerPage(value: number | undefined): number {
  return clampInteger(
    value,
    DEFAULT_BROWSER_MAX_LINKS_PER_PAGE,
    1,
    MAX_BROWSER_MAX_LINKS_PER_PAGE
  );
}

export function normalizeBrowserTextMaxChars(value: number | undefined): number {
  return clampInteger(
    value,
    DEFAULT_BROWSER_TEXT_MAX_CHARS,
    1_000,
    MAX_BROWSER_TEXT_MAX_CHARS
  );
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-secret]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [redacted]');
}

function buildSanitizedErrorDetails(
  error: unknown,
  fallbackMessage: string
): string {
  const messages: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (depth < 3 && current) {
    if (current instanceof Error) {
      if (current.message?.trim()) {
        messages.push(current.message.trim());
      }
      current = current.cause;
      depth += 1;
      continue;
    }

    if (typeof current === 'string' && current.trim()) {
      messages.push(current.trim());
    }
    break;
  }

  const uniqueMessages = [...new Set(messages)];
  return sanitizeErrorMessage(
    uniqueMessages.length > 0 ? uniqueMessages.join(' | cause: ') : fallbackMessage
  );
}

function collectErrorChainMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (depth < 4 && current) {
    if (current instanceof Error) {
      if (current.message?.trim()) {
        messages.push(sanitizeErrorMessage(current.message.trim()));
      }
      current = current.cause;
      depth += 1;
      continue;
    }

    if (typeof current === 'string' && current.trim()) {
      messages.push(sanitizeErrorMessage(current.trim()));
    }
    break;
  }

  return [...new Set(messages)];
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  const code = record.code;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function classifyBrowserOpenThrownError(error: unknown): BrowserOpenErrorType {
  const joined = collectErrorChainMessages(error).join(' | ').toLowerCase();
  const codes = new Set<string>();
  let current: unknown = error;
  let depth = 0;

  while (depth < 4 && current && typeof current === 'object') {
    const code = extractErrorCode(current);
    if (code) {
      codes.add(code.toUpperCase());
    }
    current = current instanceof Error ? current.cause : null;
    depth += 1;
  }

  if (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      codes.has('ETIMEDOUT') ||
      codes.has('UND_ERR_CONNECT_TIMEOUT') ||
      /\btimeout\b/.test(joined))
  ) {
    return 'timeout';
  }

  if (
    codes.has('UNABLE_TO_VERIFY_LEAF_SIGNATURE') ||
    codes.has('SELF_SIGNED_CERT_IN_CHAIN') ||
    codes.has('DEPTH_ZERO_SELF_SIGNED_CERT') ||
    codes.has('ERR_TLS_CERT_ALTNAME_INVALID') ||
    codes.has('CERT_HAS_EXPIRED') ||
    /\bcertificate\b/.test(joined) ||
    /\btls\b/.test(joined) ||
    /\bssl\b/.test(joined)
  ) {
    return 'tls_error';
  }

  if (
    codes.has('ENOTFOUND') ||
    codes.has('EAI_AGAIN') ||
    /\bgetaddrinfo\b/.test(joined) ||
    /\bdns\b/.test(joined) ||
    /\bhost not found\b/.test(joined)
  ) {
    return 'dns_error';
  }

  if (codes.has('ECONNREFUSED') || /\bconnection refused\b/.test(joined)) {
    return 'connection_refused';
  }

  if (/\bredirect\b/.test(joined)) {
    return 'redirect_error';
  }

  if (
    codes.has('ECONNRESET') ||
    codes.has('ENETUNREACH') ||
    codes.has('EHOSTUNREACH') ||
    /\bfetch failed\b/.test(joined) ||
    /\bnetwork\b/.test(joined) ||
    /\bconnect\b/.test(joined)
  ) {
    return 'network_error';
  }

  return 'unknown_error';
}

function extractBrowserOpenCause(error: unknown): string | undefined {
  const messages = collectErrorChainMessages(error);
  return messages.length > 1 ? messages.slice(1).join(' | cause: ') : undefined;
}

function buildDefaultTransportRecord(
  attemptedUrl: string,
  openAttemptedAt: string,
  overrides: Partial<BrowserOpenTransportRecord> = {}
): BrowserOpenTransportRecord {
  return {
    attemptedUrl,
    openAttemptedAt,
    fallbackAttempted: false,
    fallbackSucceeded: false,
    fallbackMode: 'none',
    transportNotes: [],
    ...overrides
  };
}

function buildTransportNotes(
  errorType: BrowserOpenErrorType | undefined,
  fallbackMode: BrowserFallbackMode,
  errorMessage: string | undefined
): string[] {
  const notes: string[] = [];

  switch (errorType) {
    case 'tls_error':
      notes.push(
        'La apertura fallo en la validacion TLS/certificado del stack HTTP de Node.'
      );
      break;
    case 'dns_error':
      notes.push('La apertura fallo al resolver DNS o el host remoto.');
      break;
    case 'timeout':
      notes.push('La apertura excedio el timeout configurado para Browser Automation.');
      break;
    case 'connection_refused':
      notes.push('La conexion fue rechazada por el host remoto o por la ruta de red.');
      break;
    case 'redirect_error':
      notes.push('La apertura fallo durante la cadena de redirecciones controladas.');
      break;
    case 'http_error':
      notes.push('La web respondio con un estado HTTP no valido para lectura.');
      break;
    case 'content_blocked':
      notes.push('La URL o el contenido quedaron bloqueados por la politica de seguridad.');
      break;
    case 'unsupported_content_type':
      notes.push('La respuesta no era texto HTML/plano soportado por Browser Automation v1.1.');
      break;
    case 'network_error':
      notes.push('La apertura fallo por un error de transporte o conectividad de red.');
      break;
    case 'unknown_error':
      notes.push('La apertura fallo por un error no clasificado del transporte web.');
      break;
  }

  if (fallbackMode === 'none') {
    notes.push(
      'No se intento fallback de solo lectura porque Browser Automation v1.1 no implementa una ruta segura adicional para este caso.'
    );
  }

  if (errorMessage && /unable to verify the first certificate/i.test(errorMessage)) {
    notes.push(
      'La causa concreta indica una cadena de certificados no validable por el runtime Node/undici actual.'
    );
  }

  return [...new Set(notes)];
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname);
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

export function validateFetchUrl(value: string): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      allowed: false,
      reason: 'invalid_url'
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      reason: 'unsupported_protocol'
    };
  }

  if (url.username || url.password) {
    return {
      allowed: false,
      reason: 'embedded_credentials_blocked'
    };
  }

  const hostname = stripIpv6Brackets(url.hostname.replace(/\.$/, ''));
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    return {
      allowed: false,
      reason: 'local_hostname_blocked'
    };
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    return {
      allowed: false,
      reason: 'private_ipv4_blocked'
    };
  }

  if (ipVersion === 6 && isPrivateIpv6(hostname)) {
    return {
      allowed: false,
      reason: 'private_ipv6_blocked'
    };
  }

  return {
    allowed: true
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const parsed = Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : '';
    });
}

function extractTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? decodeHtmlEntities(title.replace(/\s+/g, ' ').trim()) : undefined;
}

function stripAttributes(html: string): string {
  return html.replace(/\s+/g, ' ').trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildExcerpt(text: string, maxChars = 1_500): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/g)
    .map((sentence) => collapseWhitespace(sentence))
    .filter((sentence) => sentence.length >= 35);
  const selected: string[] = [];
  let length = 0;

  for (const sentence of sentences) {
    if (length + sentence.length > maxChars && selected.length > 0) {
      break;
    }

    selected.push(sentence);
    length += sentence.length;
    if (selected.length >= 3 || length >= maxChars) {
      break;
    }
  }

  if (selected.length === 0) {
    return text.slice(0, maxChars);
  }

  return selected.join(' ').slice(0, maxChars);
}

function stripTagsPreservingSpacing(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(?:br|\/p|\/div|\/section|\/article|\/li|\/tr|\/td|\/th|\/blockquote|\/h[1-6])\s*>/gi, '\n')
      .replace(/<(?:p|div|section|article|li|tr|td|th|blockquote|h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

const NOISE_CLASS_PATTERN =
  /\b(?:nav|menu|sidebar|aside|footer|header|related|share|social|comment|cookie|banner|promo|newsletter|subscribe|breadcrumb|toolbar|advert|ads|modal|popup|recommend|pagination)\b/i;
const CONTENT_HINT_PATTERN =
  /\b(?:article|content|post|story|entry|main|body|text|markdown|report)\b/i;

function removeNoisyContainers(html: string): string {
  let next = html;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    next = next.replace(
      /<(div|section|ul|ol)[^>]*(?:class|id)=["'][^"']*(?:nav|menu|sidebar|aside|footer|header|related|share|social|comment|cookie|banner|promo|newsletter|subscribe|breadcrumb|toolbar|advert|ads|modal|popup|recommend|pagination)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
      ' '
    );
  }

  return next;
}

function stripNoisyHtml(html: string): string {
  return removeNoisyContainers(
    html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>[\s\S]*?<\/script>/gi,
      ' '
    )
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside|form|button|iframe|canvas|picture|figure|template)[\s\S]*?<\/(?:nav|header|footer|aside|form|button|iframe|canvas|picture|figure|template)>/gi, ' ')
  );
}

function collectHtmlCandidates(rawHtml: string): Array<{ html: string; hinted: boolean }> {
  const candidates: Array<{ html: string; hinted: boolean }> = [];
  const baseHtml = stripNoisyHtml(rawHtml);
  const pushCandidate = (html: string, hinted: boolean): void => {
    const trimmed = html.trim();
    if (trimmed.length > 0) {
      candidates.push({
        html: trimmed,
        hinted
      });
    }
  };

  const articleMatches = baseHtml.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi);
  for (const match of articleMatches) {
    pushCandidate(match[2], true);
  }

  const hintedMatches = baseHtml.matchAll(
    /<(section|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi
  );
  for (const match of hintedMatches) {
    const attrs = stripAttributes(match[2] ?? '');
    if (CONTENT_HINT_PATTERN.test(attrs) && !NOISE_CLASS_PATTERN.test(attrs)) {
      pushCandidate(match[3], true);
    }
  }

  pushCandidate(baseHtml, false);
  return candidates;
}

function countLinkTextCharacters(html: string): number {
  let total = 0;
  const matches = html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of matches) {
    total += collapseWhitespace(stripTagsPreservingSpacing(match[1] ?? '')).length;
  }

  return total;
}

function estimateTechnicalNoiseRatio(text: string): number {
  const words = text.split(/\s+/g).filter(Boolean).length || 1;
  const braceNoise = (text.match(/[{}[\];<>]/g) ?? []).length;
  const technicalTokens =
    (text.match(
      /\b(?:schema|json|javascript|stylesheet|font-family|display|flex|var|const|function|return|@media|color:|padding:|margin:|window\.__|__next_data__|schema\.org|@context|@type|tailwind|webpack|chunk|hydrate)\b/gi
    ) ?? []).length + braceNoise / 4;

  return Math.max(0, Math.min(1, technicalTokens / words));
}

function estimateBoilerplateNoiseRatio(text: string): number {
  const words = text.split(/\s+/g).filter(Boolean).length || 1;
  const noiseTokens =
    (text.match(
      /\b(?:cookie|cookies|privacy|policy|policies|terms|accept|consent|subscribe|newsletter|share|comments?|related|recommended|all rights reserved|follow us|sign up|iniciar sesion|suscribete|compartir|comentarios?)\b/gi
    ) ?? []).length;

  return Math.max(0, Math.min(1, noiseTokens / words));
}

function estimateEditorialSignal(text: string): number {
  const sentences = text
    .split(/(?<=[.!?])\s+/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 30);
  const paragraphs = text
    .split(/\n{2,}/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 80);
  const sentenceScore = Math.min(1, sentences.length / 5);
  const paragraphScore = Math.min(1, paragraphs.length / 3);

  return Math.max(0, Math.min(1, sentenceScore * 0.6 + paragraphScore * 0.4));
}

interface ExtractedReadableText {
  title?: string;
  text: string;
  excerpt: string;
  textDensity: number;
  linkDensity: number;
  qualityScore: number;
  readQuality: WebPageReadQuality;
  qualityNotes: string[];
}

function classifyReadQuality(
  textChars: number,
  textDensity: number,
  linkDensity: number,
  technicalNoiseRatio: number,
  boilerplateNoiseRatio: number,
  editorialSignal: number,
  hintedCandidate: boolean,
  minTextChars: number,
  minTextDensity: number,
  maxLinkDensity: number
): {
  qualityScore: number;
  readQuality: WebPageReadQuality;
  qualityNotes: string[];
} {
  const qualityNotes: string[] = [];
  const lengthScore = Math.min(1, textChars / Math.max(minTextChars * 5, 1));
  const densityScore = Math.min(1, textDensity / Math.max(minTextDensity * 2.2, 0.01));
  const linkScore = Math.max(0, 1 - linkDensity / Math.max(maxLinkDensity * 1.4, 0.05));
  const noiseScore = Math.max(0, 1 - technicalNoiseRatio / 0.45);
  const boilerplateScore = Math.max(0, 1 - boilerplateNoiseRatio / 0.3);
  const editorialScore = Math.max(0, Math.min(1, editorialSignal));
  const hintedBonus = hintedCandidate ? 0.06 : 0;
  const qualityScore = Math.max(
    0,
    Math.min(
      1,
      lengthScore * 0.28 +
        densityScore * 0.22 +
        linkScore * 0.14 +
        noiseScore * 0.16 +
        boilerplateScore * 0.1 +
        editorialScore * 0.1 +
        hintedBonus
    )
  );

  if (textChars < minTextChars) {
    qualityNotes.push('text_too_short_after_cleanup');
  }
  if (textDensity < minTextDensity) {
    qualityNotes.push('low_text_density');
  }
  if (linkDensity > maxLinkDensity) {
    qualityNotes.push('high_link_density');
  }
  if (technicalNoiseRatio > 0.22) {
    qualityNotes.push('technical_noise_detected');
  }
  if (boilerplateNoiseRatio > 0.14) {
    qualityNotes.push('boilerplate_noise_detected');
  }
  if (editorialSignal < 0.22) {
    qualityNotes.push('low_editorial_signal');
  }
  if (hintedCandidate) {
    qualityNotes.push('article_like_container_selected');
  }

  if (
    qualityScore >= 0.74 &&
    textChars >= Math.max(minTextChars + 80, Math.round(minTextChars * 1.5)) &&
    textDensity >= minTextDensity &&
    linkDensity <= maxLinkDensity &&
    technicalNoiseRatio <= 0.18 &&
    boilerplateNoiseRatio <= 0.1 &&
    editorialSignal >= 0.32
  ) {
    qualityNotes.push('readable_editorial_content');
    return {
      qualityScore,
      readQuality: 'high',
      qualityNotes
    };
  }

  if (
    qualityScore >= 0.5 &&
    textChars >= minTextChars &&
    textDensity >= minTextDensity * 0.8 &&
    technicalNoiseRatio <= 0.32 &&
    editorialSignal >= 0.16
  ) {
    qualityNotes.push('usable_but_partially_noisy_content');
    return {
      qualityScore,
      readQuality: 'medium',
      qualityNotes
    };
  }

  qualityNotes.push('low_quality_extraction');
  return {
    qualityScore,
    readQuality: 'low',
    qualityNotes
  };
}

function extractReadableText(
  raw: string,
  contentType: string | undefined,
  minTextChars: number,
  minTextDensity: number,
  maxLinkDensity: number
): {
  title?: string;
  text: string;
  excerpt: string;
  textDensity: number;
  linkDensity: number;
  qualityScore: number;
  readQuality: WebPageReadQuality;
  qualityNotes: string[];
} {
  if (contentType?.includes('text/plain')) {
    const text = collapseWhitespace(raw);
    return {
      text,
      excerpt: buildExcerpt(text),
      textDensity: 1,
      linkDensity: 0,
      qualityScore: text.length >= minTextChars ? 0.78 : 0.4,
      readQuality:
        text.length >= minTextChars * 2
          ? 'high'
          : text.length >= minTextChars
            ? 'medium'
            : 'low',
      qualityNotes:
        text.length >= minTextChars
          ? ['plain_text_source']
          : ['plain_text_source', 'text_too_short_after_cleanup']
    };
  }

  const title = extractTitle(raw);
  const candidates = collectHtmlCandidates(raw);
  let bestCandidate: ExtractedReadableText | null = null;

  for (const candidate of candidates) {
    const stripped = stripTagsPreservingSpacing(candidate.html)
      .split(/\r?\n/g)
      .map((line) => collapseWhitespace(line))
      .filter((line) => line.length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!stripped) {
      continue;
    }

    const textChars = stripped.replace(/\s/g, '').length;
    const htmlChars = Math.max(candidate.html.length, 1);
    const linkTextChars = countLinkTextCharacters(candidate.html);
    const textDensity = Math.max(0, Math.min(1, textChars / htmlChars));
    const linkDensity = Math.max(0, Math.min(1, linkTextChars / Math.max(textChars, 1)));
    const technicalNoiseRatio = estimateTechnicalNoiseRatio(stripped);
    const boilerplateNoiseRatio = estimateBoilerplateNoiseRatio(stripped);
    const editorialSignal = estimateEditorialSignal(stripped);
    const quality = classifyReadQuality(
      textChars,
      textDensity,
      linkDensity,
      technicalNoiseRatio,
      boilerplateNoiseRatio,
      editorialSignal,
      candidate.hinted,
      minTextChars,
      minTextDensity,
      maxLinkDensity
    );

    const extractedCandidate: ExtractedReadableText = {
      title,
      text: stripped,
      excerpt: buildExcerpt(stripped),
      textDensity,
      linkDensity,
      qualityScore: quality.qualityScore,
      readQuality: quality.readQuality,
      qualityNotes: quality.qualityNotes
    };

    if (
      !bestCandidate ||
      extractedCandidate.qualityScore > bestCandidate.qualityScore ||
      (extractedCandidate.qualityScore === bestCandidate.qualityScore &&
        extractedCandidate.text.length > bestCandidate.text.length)
    ) {
      bestCandidate = extractedCandidate;
    }
  }

  return {
    title,
    text: bestCandidate?.text ?? '',
    excerpt: bestCandidate?.excerpt ?? '',
    textDensity: bestCandidate?.textDensity ?? 0,
    linkDensity: bestCandidate?.linkDensity ?? 1,
    qualityScore: bestCandidate?.qualityScore ?? 0,
    readQuality: bestCandidate?.readQuality ?? 'low',
    qualityNotes: bestCandidate?.qualityNotes ?? ['no_readable_candidate']
  };
}

function detectPromptInjectionRisk(text: string): string[] {
  const notes: string[] = [];
  if (
    /\b(ignore|disregard)\s+(all\s+)?(previous|prior)\s+instructions\b/i.test(text) ||
    /\bignora\s+(las\s+)?instrucciones\s+anteriores\b/i.test(text)
  ) {
    notes.push('possible_prompt_injection_instruction');
  }

  if (/\b(login|haz login|ejecuta|execute|download|descarga)\b/i.test(text)) {
    notes.push('web_content_contains_action_like_instruction');
  }

  return notes;
}

async function readLimitedResponseText(response: Response, maxChars: number): Promise<string> {
  const body = response.body;
  if (!body) {
    return (await response.text()).slice(0, maxChars);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let output = '';

  try {
    while (output.length < maxChars) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      output += decoder.decode(chunk.value, { stream: true });
      if (output.length >= maxChars) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    output += decoder.decode();
  }

  return output.slice(0, maxChars);
}

async function fetchWithLimitedRedirects(
  fetchImpl: FetchLike,
  initialUrl: string,
  init: RequestInit,
  maxRedirects = 3
): Promise<Response> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const validation = validateFetchUrl(currentUrl);
    if (!validation.allowed) {
      throw new Error(`URL blocked before fetch: ${validation.reason}`);
    }

    const response = await fetchImpl(currentUrl, {
      ...init,
      redirect: 'manual'
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    currentUrl = new URL(location, currentUrl).toString();
    const redirectValidation = validateFetchUrl(currentUrl);
    if (!redirectValidation.allowed) {
      throw new Error(`URL blocked after redirect: ${redirectValidation.reason}`);
    }
  }

  throw new Error(`Too many redirects while fetching ${initialUrl}.`);
}

export class SimpleWebPageReaderProvider implements WebPageReaderProvider {
  readonly id = 'simple-http';
  readonly label = 'Simple HTTP page reader';
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxContentChars: number;
  readonly maxSources: number;
  readonly minTextChars: number;
  readonly minTextDensity: number;
  readonly maxLinkDensity: number;
  private readonly fetchImpl: FetchLike;
  private lastError: string | undefined;

  constructor(options: SimpleWebPageReaderOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.timeoutMs = Math.max(
      1_000,
      options.timeoutMs ?? DEFAULT_WEB_PAGE_FETCH_TIMEOUT_MS
    );
    this.maxSources = normalizeWebPageMaxSources(options.maxSources);
    this.maxContentChars = normalizeWebPageMaxContentChars(
      options.maxContentChars
    );
    this.minTextChars = normalizeWebPageMinTextChars(options.minTextChars);
    this.minTextDensity = normalizeWebPageMinTextDensity(options.minTextDensity);
    this.maxLinkDensity = normalizeWebPageMaxLinkDensity(options.maxLinkDensity);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getStatus(): WebPageReaderProviderStatus {
    return {
      providerId: this.id,
      configured: true,
      available: this.enabled && !this.lastError,
      enabled: this.enabled,
      timeoutMs: this.timeoutMs,
      maxContentChars: this.maxContentChars,
      maxSources: this.maxSources,
      lastError: this.lastError
    };
  }

  async fetchPageContent(input: WebPageFetchInput): Promise<WebPageFetchOutput> {
    const fetchedAt = new Date().toISOString();
    if (!this.enabled) {
      return {
        url: input.url,
        fetchedAt,
        status: 'blocked',
        errorMessage: 'Web page fetch is disabled by configuration.'
      };
    }

    const validation = validateFetchUrl(input.url);
    if (!validation.allowed) {
      return {
        url: input.url,
        fetchedAt,
        status: 'blocked',
        errorMessage: validation.reason
      };
    }

    const timeoutMs = Math.max(1_000, input.timeoutMs ?? this.timeoutMs);
    const maxContentChars = normalizeWebPageMaxContentChars(
      input.maxContentChars ?? this.maxContentChars
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchWithLimitedRedirects(
        this.fetchImpl,
        input.url,
        {
          method: 'GET',
          headers: {
            Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
            'User-Agent': 'ASSEM Research Reader/0.1'
          },
          signal: controller.signal
        }
      );
      const finalUrl = response.url || input.url;
      const finalValidation = validateFetchUrl(finalUrl);
      if (!finalValidation.allowed) {
        return {
          url: input.url,
          finalUrl,
          fetchedAt,
          status: 'blocked',
          httpStatus: response.status,
          errorMessage: finalValidation.reason
        };
      }

      const contentType = response.headers.get('content-type') ?? undefined;
      if (!response.ok) {
        return {
          url: input.url,
          finalUrl,
          fetchedAt,
          status: response.status === 403 || response.status === 401 ? 'blocked' : 'error',
          httpStatus: response.status,
          contentType,
          errorMessage: `HTTP ${response.status}`
        };
      }

      if (
        contentType &&
        !/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)
      ) {
        return {
          url: input.url,
          finalUrl,
          fetchedAt,
          status: 'blocked',
          httpStatus: response.status,
          contentType,
          errorMessage: `Unsupported content type: ${contentType}`
        };
      }

      const raw = await readLimitedResponseText(response, maxContentChars);
      const extracted = extractReadableText(
        raw,
        contentType,
        this.minTextChars,
        this.minTextDensity,
        this.maxLinkDensity
      );
      const contentText = extracted.text.slice(0, maxContentChars);
      const safetyNotes = detectPromptInjectionRisk(contentText);
      const cleanedTextLength = contentText.replace(/\s/g, '').length;
      const qualityNotes = [...extracted.qualityNotes];

      if (cleanedTextLength < this.minTextChars) {
        qualityNotes.push('below_minimum_text_chars');
      }
      if (extracted.textDensity < this.minTextDensity) {
        qualityNotes.push('below_minimum_text_density');
      }
      if (extracted.linkDensity > this.maxLinkDensity) {
        qualityNotes.push('above_maximum_link_density');
      }

      if (
        cleanedTextLength < this.minTextChars ||
        extracted.textDensity < this.minTextDensity * 0.45
      ) {
        return {
          url: input.url,
          finalUrl,
          title: extracted.title,
          fetchedAt,
          status: 'unreadable',
          httpStatus: response.status,
          contentType,
          contentLength: contentText.length,
          excerpt: extracted.excerpt.slice(0, 500),
          readQuality: 'low',
          qualityScore: extracted.qualityScore,
          textDensity: extracted.textDensity,
          linkDensity: extracted.linkDensity,
          qualityNotes,
          errorMessage: 'Readable text was too short after cleanup.',
          safetyNotes
        };
      }

      this.lastError = undefined;
      return {
        url: input.url,
        finalUrl,
        title: extracted.title,
        contentText,
        excerpt: extracted.excerpt.slice(0, Math.min(2_000, maxContentChars)),
        contentLength: contentText.length,
        fetchedAt,
        status: 'ok',
        httpStatus: response.status,
        contentType,
        readQuality: extracted.readQuality,
        qualityScore: extracted.qualityScore,
        textDensity: extracted.textDensity,
        linkDensity: extracted.linkDensity,
        qualityNotes,
        safetyNotes
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      const status: WebPageFetchStatus =
        error instanceof Error && error.name === 'AbortError'
          ? 'timeout'
          : /URL blocked/i.test(errorMessage)
            ? 'blocked'
            : 'error';
      const message =
        status === 'timeout'
          ? `Page fetch timed out after ${timeoutMs}ms.`
          : buildSanitizedErrorDetails(error, 'Unknown page fetch error.');
      this.lastError = message;
      return {
        url: input.url,
        fetchedAt,
        status,
        errorMessage: message
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createWebPageReaderProvider(
  options: SimpleWebPageReaderOptions = {}
): WebPageReaderProvider {
  return new SimpleWebPageReaderProvider(options);
}

export function createWebPageReaderTool(
  provider: WebPageReaderProvider
): ToolDefinition<WebPageFetchInput, WebPageFetchOutput> {
  return {
    id: 'web-page-reader.fetch-page',
    label: 'Fetch web page content',
    description:
      'Fetches a single public HTTP/HTTPS page, extracts readable text and returns structured evidence without browser automation.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['external_communication', 'read_only'],
    async execute(input, context) {
      if (context.activeMode.privacy === 'local_only') {
        throw new Error(
          'La lectura de paginas web esta bloqueada en modo local_only.'
        );
      }

      const output = await provider.fetchPageContent(input);
      return {
        summary: `Page fetch for ${input.url}: ${output.status}.`,
        output
      };
    }
  };
}

const SENSITIVE_NAVIGATION_PATTERN =
  /\b(?:login|log in|sign in|register|checkout|buy|purchase|pay|payment|delete|remove|submit|accept|authorize|confirm|upload|subscribe|download|iniciar sesion|registr|comprar|pagar|borrar|eliminar|enviar|aceptar|autorizar|confirmar|suscrib|descargar)\b/i;

interface BrowserPageSession {
  pageId: string;
  openedAt: string;
  url: string;
  finalUrl: string;
  title?: string;
  rawHtml?: string;
  contentText: string;
  excerpt: string;
  links: BrowserPageLinkRecord[];
  safetyNotes: string[];
  lastUpdatedAt: string;
  status: BrowserPageSnapshot['status'];
  errorMessage?: string;
  transport: BrowserOpenTransportRecord;
}

function buildBrowserDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function buildSnapshotSummary(
  title: string | undefined,
  excerpt: string,
  linkCount: number,
  status: BrowserPageSnapshot['status'],
  transport?: BrowserOpenTransportRecord
): string {
  const head = title?.trim() || 'Pagina sin titulo';
  const summary = excerpt.trim().slice(0, 280);
  if (status === 'blocked' || status === 'error') {
    const errorType = transport?.openErrorType ? `${transport.openErrorType}` : 'error';
    const errorMessage = transport?.openErrorMessage ?? 'apertura degradada o bloqueada';
    return `${head}. No se pudo abrir la pagina (${errorType}): ${errorMessage}.`;
  }
  if (!summary) {
    return `${head}. Sin texto visible suficientemente util. ${linkCount} enlace(s) visible(s).`;
  }
  return `${head}. ${summary}${summary.endsWith('.') ? '' : '.'} ${linkCount} enlace(s) visible(s).`;
}

function buildBrowserPageSnapshot(session: BrowserPageSession): BrowserPageSnapshot {
  return {
    pageId: session.pageId,
    url: session.url,
    finalUrl: session.finalUrl,
    title: session.title,
    openedAt: session.openedAt,
    lastUpdatedAt: session.lastUpdatedAt,
    snapshotSummary: buildSnapshotSummary(
      session.title,
      session.excerpt,
      session.links.length,
      session.status,
      session.transport
    ),
    visibleTextExcerpt: session.excerpt,
    links: [...session.links],
    status: session.status,
    safetyNotes: [...session.safetyNotes],
    errorMessage: session.errorMessage,
    transport: session.transport
  };
}

function decodeAttributeValue(value: string): string {
  return decodeHtmlEntities(value.trim());
}

function resolveHref(baseUrl: string, href: string): string | null {
  const cleaned = decodeAttributeValue(href);
  if (!cleaned || /^#/i.test(cleaned)) {
    return null;
  }

  if (/^(?:javascript|mailto|tel|data):/i.test(cleaned)) {
    return cleaned;
  }

  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return null;
  }
}

function classifyLinkSafety(
  text: string,
  url: string,
  currentDomain: string
): { safety: BrowserPageLinkRecord['safety']; reason?: string; domain: string; sameDomain: boolean; externalDomain: boolean } {
  const domain = buildBrowserDomain(url);
  const sameDomain = Boolean(domain) && domain === currentDomain;
  const externalDomain = Boolean(domain) && domain !== currentDomain;

  if (!/^https?:/i.test(url)) {
    return {
      safety: 'blocked',
      reason: 'unsupported_protocol',
      domain,
      sameDomain,
      externalDomain
    };
  }

  const validation = validateFetchUrl(url);
  if (!validation.allowed) {
    return {
      safety: 'blocked',
      reason: validation.reason,
      domain,
      sameDomain,
      externalDomain
    };
  }

  if (SENSITIVE_NAVIGATION_PATTERN.test(`${text} ${url}`)) {
    return {
      safety: 'requires_confirmation',
      reason: 'sensitive_action_like_link',
      domain,
      sameDomain,
      externalDomain
    };
  }

  return {
    safety: 'safe_navigation',
    domain,
    sameDomain,
    externalDomain
  };
}

function extractVisibleLinksFromHtml(
  html: string,
  baseUrl: string,
  maxLinks: number
): BrowserPageLinkRecord[] {
  const currentDomain = buildBrowserDomain(baseUrl);
  const seenUrls = new Set<string>();
  const links: BrowserPageLinkRecord[] = [];
  const matches = html.matchAll(/<a\b[^>]*href=(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>([\s\S]*?)<\/a>/gi);

  for (const match of matches) {
    if (links.length >= maxLinks) {
      break;
    }

    const href = match[1] ?? match[2] ?? match[3] ?? '';
    const resolved = resolveHref(baseUrl, href);
    if (!resolved) {
      continue;
    }

    const text = collapseWhitespace(stripTagsPreservingSpacing(match[4] ?? ''));
    const label = text || decodeAttributeValue(href);
    const dedupeKey = resolved.replace(/\/$/g, '');
    if (!dedupeKey || seenUrls.has(dedupeKey)) {
      continue;
    }
    seenUrls.add(dedupeKey);

    const safety = classifyLinkSafety(label, resolved, currentDomain);
    links.push({
      id: crypto.randomUUID(),
      text: label.slice(0, 180) || dedupeKey,
      url: resolved,
      domain: safety.domain,
      sameDomain: safety.sameDomain,
      externalDomain: safety.externalDomain,
      safety: safety.safety,
      reason: safety.reason
    });
  }

  return links;
}

function buildFindExcerpt(text: string, query: string): string | undefined {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  const index = normalizedText.indexOf(normalizedQuery);
  if (index < 0) {
    return undefined;
  }

  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + query.length + 120);
  return collapseWhitespace(text.slice(start, end));
}

async function fetchBrowserPageSession(
  fetchImpl: FetchLike,
  input: {
    url: string;
    timeoutMs: number;
    textMaxChars: number;
    maxLinksPerPage: number;
  },
  existingPageId?: string,
  openedAt = new Date().toISOString()
): Promise<BrowserPageSession> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const fetchedAt = new Date().toISOString();

  try {
    const validation = validateFetchUrl(input.url);
    if (!validation.allowed) {
      const transport = buildDefaultTransportRecord(input.url, openedAt, {
        openErrorType: 'content_blocked',
        openErrorMessage: validation.reason,
        transportNotes: buildTransportNotes(
          'content_blocked',
          'none',
          validation.reason
        )
      });
      return {
        pageId: existingPageId ?? crypto.randomUUID(),
        openedAt,
        url: input.url,
        finalUrl: input.url,
        title: undefined,
        rawHtml: undefined,
        contentText: '',
        excerpt: '',
        links: [],
        safetyNotes: [],
        lastUpdatedAt: fetchedAt,
        status: 'blocked',
        errorMessage: validation.reason,
        transport
      };
    }

    const response = await fetchWithLimitedRedirects(
      fetchImpl,
      input.url,
      {
        method: 'GET',
        headers: {
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'User-Agent': 'ASSEM Browser Automation/0.1'
        },
        signal: controller.signal
      }
    );
    const finalUrl = response.url || input.url;
    const finalValidation = validateFetchUrl(finalUrl);
    if (!finalValidation.allowed) {
      const transport = buildDefaultTransportRecord(input.url, openedAt, {
        finalUrl,
        openErrorType: 'content_blocked',
        openErrorMessage: finalValidation.reason,
        transportNotes: buildTransportNotes(
          'content_blocked',
          'none',
          finalValidation.reason
        )
      });
      return {
        pageId: existingPageId ?? crypto.randomUUID(),
        openedAt,
        url: input.url,
        finalUrl,
        title: undefined,
        rawHtml: undefined,
        contentText: '',
        excerpt: '',
        links: [],
        safetyNotes: [],
        lastUpdatedAt: fetchedAt,
        status: 'blocked',
        errorMessage: finalValidation.reason,
        transport
      };
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    if (!response.ok) {
      const openErrorType: BrowserOpenErrorType =
        response.status === 401 || response.status === 403
          ? 'content_blocked'
          : 'http_error';
      const openErrorMessage = `HTTP ${response.status}`;
      const transport = buildDefaultTransportRecord(input.url, openedAt, {
        finalUrl,
        openErrorType,
        openErrorMessage,
        httpStatus: response.status,
        contentType,
        transportNotes: buildTransportNotes(openErrorType, 'none', openErrorMessage)
      });
      return {
        pageId: existingPageId ?? crypto.randomUUID(),
        openedAt,
        url: input.url,
        finalUrl,
        title: undefined,
        rawHtml: undefined,
        contentText: '',
        excerpt: '',
        links: [],
        safetyNotes: [],
        lastUpdatedAt: fetchedAt,
        status: response.status === 401 || response.status === 403 ? 'blocked' : 'error',
        errorMessage: openErrorMessage,
        transport
      };
    }

    if (
      contentType &&
      !/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)
    ) {
      const openErrorMessage = `Unsupported content type: ${contentType}`;
      const transport = buildDefaultTransportRecord(input.url, openedAt, {
        finalUrl,
        openErrorType: 'unsupported_content_type',
        openErrorMessage,
        contentType,
        httpStatus: response.status,
        transportNotes: buildTransportNotes(
          'unsupported_content_type',
          'none',
          openErrorMessage
        )
      });
      return {
        pageId: existingPageId ?? crypto.randomUUID(),
        openedAt,
        url: input.url,
        finalUrl,
        title: undefined,
        rawHtml: undefined,
        contentText: '',
        excerpt: '',
        links: [],
        safetyNotes: [],
        lastUpdatedAt: fetchedAt,
        status: 'blocked',
        errorMessage: openErrorMessage,
        transport
      };
    }

    const rawHtml = await readLimitedResponseText(
      response,
      Math.max(DEFAULT_BROWSER_HTML_MAX_CHARS, input.textMaxChars * 4)
    );
    const extracted = extractReadableText(
      rawHtml,
      contentType,
      DEFAULT_WEB_PAGE_MIN_TEXT_CHARS,
      DEFAULT_WEB_PAGE_MIN_TEXT_DENSITY,
      DEFAULT_WEB_PAGE_MAX_LINK_DENSITY
    );
    const contentText = extracted.text.slice(0, input.textMaxChars);
    const links = extractVisibleLinksFromHtml(
      stripNoisyHtml(rawHtml),
      finalUrl,
      input.maxLinksPerPage
    );
    const safetyNotes = detectPromptInjectionRisk(contentText);

    const transport = buildDefaultTransportRecord(input.url, openedAt, {
      finalUrl,
      contentType,
      httpStatus: response.status
    });
    return {
      pageId: existingPageId ?? crypto.randomUUID(),
      openedAt,
      url: input.url,
      finalUrl,
      title: extracted.title,
      rawHtml,
      contentText,
      excerpt: extracted.excerpt.slice(0, input.textMaxChars),
      links,
      safetyNotes,
      lastUpdatedAt: fetchedAt,
      status: existingPageId ? 'navigated' : 'open',
      transport
    };
  } catch (error) {
    const openErrorType = classifyBrowserOpenThrownError(error);
    const chainMessages = collectErrorChainMessages(error);
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `Page fetch timed out after ${input.timeoutMs}ms.`
        : chainMessages[0] ?? 'Unknown browser fetch error.';
    const cause = extractBrowserOpenCause(error);
    const transport = buildDefaultTransportRecord(input.url, openedAt, {
      openErrorType,
      openErrorMessage: message,
      openErrorCause: cause,
      transportNotes: buildTransportNotes(openErrorType, 'none', message)
    });
    return {
      pageId: existingPageId ?? crypto.randomUUID(),
      openedAt,
      url: input.url,
      finalUrl: input.url,
      title: undefined,
      rawHtml: undefined,
      contentText: '',
      excerpt: '',
      links: [],
      safetyNotes: [],
      lastUpdatedAt: fetchedAt,
      status: 'error',
      errorMessage: message,
      transport
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class SimpleBrowserAutomationProvider implements BrowserAutomationProvider {
  readonly id = 'safe-http-browser';
  readonly label = 'Safe HTTP browser automation';
  readonly enabled: boolean;
  readonly timeoutMs: number;
  readonly maxPagesPerTask: number;
  readonly maxLinksPerPage: number;
  readonly textMaxChars: number;
  readonly allowScreenshots: boolean;
  private readonly fetchImpl: FetchLike;
  private lastError: string | undefined;
  private readonly pages = new Map<string, BrowserPageSession>();

  constructor(options: SimpleBrowserAutomationOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS);
    this.maxPagesPerTask = normalizeBrowserMaxPagesPerTask(options.maxPagesPerTask);
    this.maxLinksPerPage = normalizeBrowserMaxLinksPerPage(options.maxLinksPerPage);
    this.textMaxChars = normalizeBrowserTextMaxChars(options.textMaxChars);
    this.allowScreenshots = options.allowScreenshots ?? DEFAULT_BROWSER_ALLOW_SCREENSHOTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getStatus(): BrowserAutomationProviderStatus {
    return {
      providerId: this.id,
      configured: true,
      available: this.enabled && !this.lastError,
      enabled: this.enabled,
      maxPagesPerTask: this.maxPagesPerTask,
      maxLinksPerPage: this.maxLinksPerPage,
      textMaxChars: this.textMaxChars,
      timeoutMs: this.timeoutMs,
      allowScreenshots: this.allowScreenshots,
      lastError: this.lastError
    };
  }

  async openPage(input: BrowserOpenPageInput): Promise<BrowserOpenPageOutput> {
    if (!this.enabled) {
      throw new Error('Browser automation is disabled by configuration.');
    }

    const session = await fetchBrowserPageSession(this.fetchImpl, {
      url: input.url,
      timeoutMs: this.timeoutMs,
      textMaxChars: this.textMaxChars,
      maxLinksPerPage: this.maxLinksPerPage
    });
    this.lastError = session.errorMessage;
    this.pages.set(session.pageId, session);
    return {
      pageId: session.pageId,
      snapshot: buildBrowserPageSnapshot(session)
    };
  }

  async getPageSnapshot(input: BrowserPageReferenceInput): Promise<BrowserPageSnapshot> {
    return buildBrowserPageSnapshot(this.requirePage(input.pageId));
  }

  async extractVisibleText(
    input: BrowserExtractVisibleTextInput
  ): Promise<BrowserExtractVisibleTextOutput> {
    const page = this.requirePage(input.pageId);
    const maxChars = normalizeBrowserTextMaxChars(input.maxChars ?? this.textMaxChars);
    return {
      pageId: page.pageId,
      excerpt: page.contentText.slice(0, maxChars),
      contentLength: page.contentText.length
    };
  }

  async listVisibleLinks(
    input: BrowserListVisibleLinksInput
  ): Promise<BrowserListVisibleLinksOutput> {
    const page = this.requirePage(input.pageId);
    const maxLinks = normalizeBrowserMaxLinksPerPage(input.maxLinks ?? this.maxLinksPerPage);
    return {
      pageId: page.pageId,
      links: page.links.slice(0, maxLinks)
    };
  }

  async clickLink(input: BrowserClickLinkInput): Promise<BrowserClickLinkOutput> {
    const page = this.requirePage(input.pageId);
    const link = page.links.find((candidate) => candidate.id === input.linkId);
    if (!link) {
      throw new Error(`Unknown browser link: ${input.linkId}`);
    }

    const blockedNavigation: BrowserNavigationEntry = {
      id: crypto.randomUUID(),
      pageId: page.pageId,
      action: 'navigate',
      fromUrl: page.finalUrl,
      toUrl: link.url,
      title: page.title,
      detail: link.text,
      recordedAt: new Date().toISOString(),
      blocked: link.safety !== 'safe_navigation',
      reason: link.reason,
      transport: buildDefaultTransportRecord(link.url, new Date().toISOString(), {
        finalUrl: link.url
      })
    };

    if (link.safety !== 'safe_navigation') {
      return {
        pageId: page.pageId,
        snapshot: buildBrowserPageSnapshot(page),
        navigation: blockedNavigation
      };
    }

    const nextPage = await fetchBrowserPageSession(
      this.fetchImpl,
      {
        url: link.url,
        timeoutMs: this.timeoutMs,
        textMaxChars: this.textMaxChars,
        maxLinksPerPage: this.maxLinksPerPage
      },
      page.pageId,
      page.openedAt
    );
    this.lastError = nextPage.errorMessage;
    const navigationTransport = nextPage.transport;
    if (nextPage.status !== 'error' && nextPage.status !== 'blocked') {
      this.pages.set(page.pageId, nextPage);
    }
    return {
      pageId: nextPage.pageId,
      snapshot: buildBrowserPageSnapshot(nextPage),
      navigation: {
        ...blockedNavigation,
        blocked: false,
        reason: undefined,
        toUrl: nextPage.finalUrl,
        title: nextPage.title,
        transport: navigationTransport
      }
    };
  }

  async findOnPage(input: BrowserFindOnPageInput): Promise<BrowserFindOnPageOutput> {
    const page = this.requirePage(input.pageId);
    const query = input.query.trim();
    const normalizedContent = page.contentText.toLowerCase();
    const normalizedQuery = query.toLowerCase();
    if (!normalizedQuery) {
      return {
        pageId: page.pageId,
        query,
        found: false,
        matchCount: 0
      };
    }

    let matchCount = 0;
    let fromIndex = 0;
    while (fromIndex < normalizedContent.length) {
      const nextIndex = normalizedContent.indexOf(normalizedQuery, fromIndex);
      if (nextIndex < 0) {
        break;
      }
      matchCount += 1;
      fromIndex = nextIndex + normalizedQuery.length;
    }

    return {
      pageId: page.pageId,
      query,
      found: matchCount > 0,
      matchCount,
      excerpt: matchCount > 0 ? buildFindExcerpt(page.contentText, query) : undefined
    };
  }

  async closePage(input: BrowserPageReferenceInput): Promise<BrowserClosePageOutput> {
    const page = this.requirePage(input.pageId);
    page.status = 'closed';
    page.lastUpdatedAt = new Date().toISOString();
    this.pages.delete(input.pageId);
    return {
      pageId: page.pageId,
      closedAt: page.lastUpdatedAt
    };
  }

  private requirePage(pageId: string): BrowserPageSession {
    const page = this.pages.get(pageId);
    if (!page) {
      throw new Error(`Unknown browser page: ${pageId}`);
    }

    return page;
  }
}

export function createBrowserAutomationProvider(
  options: SimpleBrowserAutomationOptions = {}
): BrowserAutomationProvider {
  return new SimpleBrowserAutomationProvider(options);
}

export function createBrowserOpenPageTool(
  provider: BrowserAutomationProvider
): ToolDefinition<BrowserOpenPageInput, BrowserOpenPageOutput> {
  return {
    id: 'browser-automation.open-page',
    label: 'Open browser page',
    description:
      'Opens a public web page in ASSEM safe browser automation v1 and stores a readable snapshot for later steps.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['external_communication', 'read_only'],
    async execute(input, context) {
      if (context.activeMode.privacy === 'local_only') {
        throw new Error('La automatizacion web esta bloqueada en modo local_only.');
      }

      const output = await provider.openPage(input);
      return {
        summary: `Opened ${output.snapshot.finalUrl}.`,
        output
      };
    }
  };
}

export function createBrowserGetPageSnapshotTool(
  provider: BrowserAutomationProvider
): ToolDefinition<BrowserPageReferenceInput, BrowserPageSnapshot> {
  return {
    id: 'browser-automation.get-page-snapshot',
    label: 'Get browser page snapshot',
    description: 'Returns the persisted page snapshot for an opened browser page.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(input) {
      const output = await provider.getPageSnapshot(input);
      return {
        summary: `Snapshot for ${output.finalUrl}.`,
        output
      };
    }
  };
}

export function createBrowserExtractVisibleTextTool(
  provider: BrowserAutomationProvider
): ToolDefinition<BrowserExtractVisibleTextInput, BrowserExtractVisibleTextOutput> {
  return {
    id: 'browser-automation.extract-visible-text',
    label: 'Extract visible browser text',
    description: 'Extracts visible text from an opened browser page.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(input) {
      const output = await provider.extractVisibleText(input);
      return {
        summary: `Extracted visible text for ${input.pageId}.`,
        output
      };
    }
  };
}

export function createBrowserListVisibleLinksTool(
  provider: BrowserAutomationProvider
): ToolDefinition<BrowserListVisibleLinksInput, BrowserListVisibleLinksOutput> {
  return {
    id: 'browser-automation.list-visible-links',
    label: 'List visible browser links',
    description: 'Lists visible HTTP/HTTPS links from an opened browser page.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(input) {
      const output = await provider.listVisibleLinks(input);
      return {
        summary: `Listed ${output.links.length} visible link(s) for ${input.pageId}.`,
        output
      };
    }
  };
}

export function createBrowserClickLinkTool(
  provider: BrowserAutomationProvider
): ToolDefinition<BrowserClickLinkInput, BrowserClickLinkOutput> {
  return {
    id: 'browser-automation.click-link',
    label: 'Navigate by browser link',
    description:
      'Follows a previously extracted navigation link when it is safe; action-like links stay blocked.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['external_communication', 'read_only'],
    async execute(input, context) {
      if (context.activeMode.privacy === 'local_only') {
        throw new Error('La automatizacion web esta bloqueada en modo local_only.');
      }

      const output = await provider.clickLink(input);
      return {
        summary: output.navigation.blocked
          ? `Blocked navigation to ${output.navigation.toUrl ?? 'unknown url'}.`
          : `Navigated to ${output.snapshot.finalUrl}.`,
        output
      };
    }
  };
}

export function createBrowserFindOnPageTool(
  provider: BrowserAutomationProvider
): ToolDefinition<BrowserFindOnPageInput, BrowserFindOnPageOutput> {
  return {
    id: 'browser-automation.find-on-page',
    label: 'Find text on browser page',
    description: 'Searches for text inside the visible content of an opened browser page.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(input) {
      const output = await provider.findOnPage(input);
      return {
        summary: output.found
          ? `Found ${output.matchCount} match(es) for "${input.query}".`
          : `No matches for "${input.query}".`,
        output
      };
    }
  };
}

export function createBrowserClosePageTool(
  provider: BrowserAutomationProvider
): ToolDefinition<BrowserPageReferenceInput, BrowserClosePageOutput> {
  return {
    id: 'browser-automation.close-page',
    label: 'Close browser page',
    description: 'Closes an opened browser page from the safe browser automation provider.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(input) {
      const output = await provider.closePage(input);
      return {
        summary: `Closed page ${input.pageId}.`,
        output
      };
    }
  };
}
