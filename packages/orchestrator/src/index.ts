import path from 'node:path';

import { probeSandboxEntry } from '@assem/integration-local-files';
import type {
  ActionLogEntry,
  ActiveMode,
  AssemConfig,
  CalendarCreateInput,
  ChatMessage,
  ChatRequest,
  LocalDirectoryEntry,
  LocalDirectoryListOutput,
  LocalFileInput,
  LocalFileOutput,
  LocalFileReadOutput,
  MemoryBackend,
  ModeUpdateRequest,
  ModelResponse,
  OverrideCreateRequest,
  PendingAction,
  PendingActionResolutionRequest,
  ProfileSummary,
  SessionOperationalContext,
  SessionTemporalSnapshot,
  SessionSnapshot,
  SessionState,
  SessionStore,
  SessionWriteIntent,
  SupportedLanguage,
  TelemetryRecord,
  TelemetryResult,
  TelemetrySink,
  TemporaryPolicyOverride,
  TemporaryPolicyOverrideInput,
  TimeOutput,
  ToolSummary,
  ToolDefinition,
  ToolRegistry as ToolRegistryContract,
  ToolExecutionResult,
  ProviderHealth,
  ModelRouter as ModelRouterContract,
  PolicyEngine as PolicyEngineContract
} from '@assem/shared-types';

import { ActionLogService } from '@assem/action-log';
import { summarizeProfile } from '@assem/memory';

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

const LIST_PREVIEW_LIMIT = 8;
const FILE_CONTENT_PREVIEW_CHARS = 2_000;
const SPANISH_LOCALE = 'es-ES';
const ENGLISH_LOCALE = 'en-GB';
const WEEKDAY_INDEX_BY_ENGLISH_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};
const WEEKDAY_INDEX_BY_NAME: Record<string, number> = {
  domingo: 0,
  sunday: 0,
  lunes: 1,
  monday: 1,
  martes: 2,
  tuesday: 2,
  miercoles: 3,
  wednesday: 3,
  jueves: 4,
  thursday: 4,
  viernes: 5,
  friday: 5,
  sabado: 6,
  saturday: 6
};

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce(
    (score, pattern) => score + (pattern.test(text) ? 1 : 0),
    0
  );
}

function normalizeIntentText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[`"'’]/g, '')
    .replace(/[?!,.;:¡¿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingNamingQualifier(value: string): string {
  return value
    .replace(/^(?:called|named|llamad[oa]|de nombre|con nombre)\s+/i, '')
    .trim();
}

function stripTrailingSandboxQualifier(value: string): string {
  return value
    .replace(
      /\s+(?:in|inside|within|from)\s+(?:the\s+)?sandbox(?:\s+root)?$/i,
      ''
    )
    .replace(
      /\s+(?:en|del|desde|dentro de|dentro del)\s+(?:el\s+)?sandbox(?:\s+(?:root|raiz))?$/i,
      ''
    )
    .trim();
}

function normalizeRelativeReference(value: string | undefined): string {
  return (value ?? '').trim().replace(/\\/g, '/');
}

function describeEntryKind(kind: 'file' | 'directory'): string {
  return kind === 'directory' ? 'carpeta' : 'archivo';
}

function shortenText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatListEntries(entries: LocalDirectoryEntry[]): string {
  return entries
    .map((entry) => `[${describeEntryKind(entry.kind)}] ${entry.name}`)
    .join(', ');
}

function isAffirmative(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(?:yes|y|si|confirm|confirma|confirmar|confirmo|confirmo todo|confirmo la accion|confirmo todas? las acciones? pendientes|la confirmo|confirmala|ok|okay|dale|hazlo|adelante|vale|de acuerdo|do it|go ahead|crealo|creala|crea la|crea lo)(?:\s+(?:please|por favor))?$/.test(
    normalized
  );
}

function isNegative(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(no|cancel|cancela|cancelar|cancelo|stop|reject|rechaza|rechazar|not now|no lo hagas)(?:\s+(?:please|por favor))?$/.test(
    normalized
  );
}

function resolvePendingActionIntent(text: string): 'approve' | 'reject' | null {
  if (isAffirmative(text)) {
    return 'approve';
  }

  if (isNegative(text)) {
    return 'reject';
  }

  return null;
}

function isTimeRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /\bwhat\s+(?:time|date|day)\s+is\s+it\b/i.test(normalized) ||
    /\bwhat\s+day\s+is\s+today\b/i.test(normalized) ||
    /\bwhat\s+date\s+is\s+today\b/i.test(normalized) ||
    /\bcurrent\s+(?:time|date)\b/i.test(normalized) ||
    /\btime\s+now\b/i.test(normalized) ||
    /\bque\s+(?:hora|ahora|fecha|dia)\s+es\b/i.test(normalized) ||
    /\b(?:hora|fecha|dia)\s+actual\b/i.test(normalized) ||
    /\bfecha\s+de\s+hoy\b/i.test(normalized) ||
    /\bdia\s+de\s+hoy\b/i.test(normalized)
  );
}

function isTemporalDisputeRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(?:eso esta mal|esta mal|la hora esta mal|la fecha esta mal|ese dia(?: tambien)? esta mal|ese dia tambien esta mal|no eso no|that is wrong|the time is wrong|the date is wrong|the day is wrong|no that is not it)$/.test(
    normalized
  );
}

function isGreetingRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(?:hola|hola assem|buenas|buenos dias|buenas tardes|buenas noches|hello|hi|hey)(?:\s+assem)?$/.test(
    normalized
  );
}

function isSystemCapabilitiesRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /(?:what can you do|que puedes hacer|que puede hacer assem)/i.test(
      normalized
    ) ||
    /(?:what tools do you have|what tools are available|que herramientas(?:\s+(?:tienes|hay|puedes usar))?)/i.test(
      normalized
    ) ||
    /(?:what providers do you have|what provider is active|que providers?(?:\s+(?:tienes|hay|activos?))?|que proveedor(?:\s+(?:tienes|activo))?)/i.test(
      normalized
    ) ||
    /(?:what model are you using|what model do you use|que modelo(?:\s+(?:usas|tienes|activo))?)/i.test(
      normalized
    ) ||
    /(?:what environment are you running in|en que entorno te ejecutas|estado del sistema|system status|runtime status)/i.test(
      normalized
    )
  );
}

function isAmbiguousSystemRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(?:dame la obra que tienes|que tienes|que haces|what do you have|what do you do)$/.test(
    normalized
  );
}

function isTemporalRephraseRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /^(en espanol|en castellano|en ingles|in spanish|in english|traducelo|translate it)$/.test(
      normalized
    ) ||
    /\btraducelo\b/.test(normalized)
  );
}

function isTemporalReassuranceRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(seguro|sure)$/.test(normalized);
}

function extractRequestedWeekdayIndex(text: string): number | null {
  const normalized = normalizeIntentText(text);

  for (const [name, index] of Object.entries(WEEKDAY_INDEX_BY_NAME)) {
    const pattern = new RegExp(`\\b${name}\\b`, 'i');
    if (pattern.test(normalized)) {
      return index;
    }
  }

  return null;
}

function isTemporalWeekdayQuestion(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    extractRequestedWeekdayIndex(text) !== null &&
    (/^(es|is)\b/.test(normalized) ||
      /\b(hoy|today|fecha|date|dia|day)\b/.test(normalized))
  );
}

function detectMessageLanguage(text: string): SupportedLanguage | null {
  const normalized = normalizeIntentText(text);
  if (!normalized) {
    return null;
  }

  const spanishScore = countPatternMatches(normalized, [
    /\bhola\b/,
    /\bbuenas\b/,
    /\bque\b/,
    /\bhora\b/,
    /\bdia\b/,
    /\bfecha\b/,
    /\ben espanol\b/,
    /\ben castellano\b/,
    /\btraducelo\b/,
    /\bseguro\b/,
    /\bes\b/,
    /\blunes\b|\bmartes\b|\bmiercoles\b|\bjueves\b|\bviernes\b|\bsabado\b|\bdomingo\b/
  ]);
  const englishScore = countPatternMatches(normalized, [
    /\bhello\b|\bhi\b|\bhey\b/,
    /\bwhat\b/,
    /\btime\b/,
    /\bday\b/,
    /\bdate\b/,
    /\bin english\b/,
    /\bin spanish\b/,
    /\btranslate\b/,
    /\bsure\b/,
    /\bis\b/,
    /\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b|\bsaturday\b|\bsunday\b/
  ]);

  if (spanishScore === 0 && englishScore === 0) {
    return null;
  }

  if (spanishScore === englishScore) {
    return null;
  }

  return spanishScore > englishScore ? 'es' : 'en';
}

function localeForLanguage(language: SupportedLanguage): string {
  return language === 'es' ? SPANISH_LOCALE : ENGLISH_LOCALE;
}

function extractTimeZone(snapshot: SessionTemporalSnapshot): string {
  return snapshot.timeZone || 'UTC';
}

function formatTemporalParts(
  snapshot: SessionTemporalSnapshot
): Record<'weekday' | 'day' | 'month' | 'year' | 'hour' | 'minute', string> {
  const formatter = new Intl.DateTimeFormat(snapshot.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: extractTimeZone(snapshot)
  });

  const parts = formatter.formatToParts(new Date(snapshot.iso));
  const values = Object.fromEntries(
    parts
      .filter((part) =>
        ['weekday', 'day', 'month', 'year', 'hour', 'minute'].includes(part.type)
      )
      .map((part) => [part.type, part.value])
  ) as Partial<Record<'weekday' | 'day' | 'month' | 'year' | 'hour' | 'minute', string>>;

  return {
    weekday: values.weekday ?? '',
    day: values.day ?? '',
    month: values.month ?? '',
    year: values.year ?? '',
    hour: values.hour ?? '',
    minute: values.minute ?? ''
  };
}

function getSnapshotWeekdayIndex(snapshot: SessionTemporalSnapshot): number {
  const weekdayName = normalizeIntentText(
    new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: extractTimeZone(snapshot)
    }).format(new Date(snapshot.iso))
  );

  return WEEKDAY_INDEX_BY_ENGLISH_NAME[weekdayName] ?? new Date(snapshot.iso).getUTCDay();
}

function formatTemporalReference(snapshot: SessionTemporalSnapshot): string {
  return `${snapshot.timeZone} (${snapshot.utcOffset})`;
}

function extractSnapshotHour(snapshot: SessionTemporalSnapshot): number {
  const parts = formatTemporalParts(snapshot);
  return Number.parseInt(parts.hour, 10);
}

function parseTemporalCorrection(
  text: string
): { claimedHour?: number; rejectedHour?: number } | null {
  const normalized = normalizeIntentText(text);
  if (
    !/^(esta mal|eso esta mal|thats wrong|that is wrong|incorrecto|incorrect)$/.test(
      normalized
    ) &&
    !/\besta mal\b/.test(normalized) &&
    !/\bno las?\b/.test(normalized)
  ) {
    return null;
  }

  const claimedHour = Number.parseInt(
    normalized.match(/(?:es la|son las)\s+(\d{1,2})/)?.[1] ?? '',
    10
  );
  const rejectedHour = Number.parseInt(
    normalized.match(/no\s+(?:es la|son las|la|las)\s+(\d{1,2})/)?.[1] ?? '',
    10
  );

  if (Number.isNaN(claimedHour) && Number.isNaN(rejectedHour)) {
    return null;
  }

  return {
    claimedHour: Number.isNaN(claimedHour) ? undefined : claimedHour,
    rejectedHour: Number.isNaN(rejectedHour) ? undefined : rejectedHour
  };
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function truncateAtNoiseMarker(value: string): string {
  const markers = [
    /\bdonde\b/i,
    /\bwhere\b/i,
    /\bpor ejemplo\b/i,
    /\bfor example\b/i,
    /\bpara empezar\b/i,
    /\bto start\b/i,
    /\bahora mismo\b/i,
    /\bright now\b/i,
    /\ben\s+(?:la|el)\s+(?:carpeta|directorio)\b/i,
    /\bdentro\s+del\s+sandbox\b/i,
    /\bdentro\s+de\s+la\s+carpeta\b/i,
    /\bin\s+(?:the\s+)?(?:folder|directory)\b/i,
    /\bin\s+(?:the\s+)?sandbox\b/i,
    /\ben\s+(?:el\s+)?sandbox\b/i,
    /\binside\s+(?:the\s+)?sandbox\b/i,
    /\bwithin\s+(?:the\s+)?sandbox\b/i
  ];
  let cutIndex = value.length;

  for (const marker of markers) {
    const match = marker.exec(value);
    if (match && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  return value.slice(0, cutIndex).trim();
}

function sanitizeLocalEntryName(value: string): string {
  let cleaned = value.trim();
  cleaned = cleaned.replace(/^["']|["']$/g, '').trim();
  cleaned = cleaned.replace(
    /^(?:que\s+se\s+llame|que\s+se\s+llama|llamad[oa]|de\s+nombre|con\s+nombre|named|called)\s+/i,
    ''
  );
  cleaned = truncateAtNoiseMarker(cleaned);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/[?!,;:]+$/, '').trim();
  return cleanName(cleaned, '');
}

function isClearLocalEntryName(value: string): boolean {
  const normalized = normalizeIntentText(value);
  if (!normalized || !/[a-z0-9]/i.test(value)) {
    return false;
  }

  if (
    /^(?:un|una|el|la|a|an|the|que|se|llame|llamado|llamada|nombre|archivo|fichero|file|carpeta|directorio|folder|directory|sandbox|donde|where|por ejemplo|for example|para empezar|to start|ahora mismo|right now)$/.test(
      normalized
    )
  ) {
    return false;
  }

  return !/\b(?:donde|where|por ejemplo|for example|para empezar|to start|ahora mismo|right now)\b/i.test(
    normalized
  );
}

interface LocalCreateTarget {
  kind: 'file' | 'directory';
  extensionHint?: string;
  matchEnd: number;
}

interface LocalCreateIntentParseResult {
  input: LocalFileInput | null;
  missingNameForKind: 'file' | 'directory' | null;
}

function resolveLocalCreateTarget(text: string): LocalCreateTarget | null {
  const directPatterns: Array<{
    kind: 'file' | 'directory';
    regex: RegExp;
  }> = [
    {
      kind: 'file',
      regex:
        /\b(?:create|make|write|crear|crea|genera|generar)\b(?:\s+(?:me|lo|la|un|una|el|la|a|an|the|otro|otra))*\s+(?:archivo|fichero|file)(?:\.([a-z0-9]+))?\b/i
    },
    {
      kind: 'directory',
      regex:
        /\b(?:create|make|write|crear|crea|genera|generar)\b(?:\s+(?:me|lo|la|un|una|el|la|a|an|the|otro|otra))*\s+(?:carpeta|directorio|folder|directory)\b/i
    }
  ];

  let bestMatch:
    | {
        kind: 'file' | 'directory';
        match: RegExpExecArray;
      }
    | null = null;

  for (const candidate of directPatterns) {
    const match = candidate.regex.exec(text);
    if (!match) {
      continue;
    }

    if (!bestMatch || match.index < bestMatch.match.index) {
      bestMatch = {
        kind: candidate.kind,
        match
      };
    }
  }

  if (bestMatch) {
    return {
      kind: bestMatch.kind,
      extensionHint:
        bestMatch.kind === 'file' ? bestMatch.match[1]?.toLowerCase() : undefined,
      matchEnd: bestMatch.match.index + bestMatch.match[0].length
    };
  }

  const searchText = normalizeSearchText(text);
  const createMatch = /\b(?:create|make|write|crear|crea|genera|generar)\b/i.exec(
    searchText
  );
  if (!createMatch) {
    return null;
  }

  const slice = searchText.slice(createMatch.index);
  const fileMatch = /\b(?:archivo|fichero|file)(?:\.([a-z0-9]+))?\b/i.exec(slice);
  const directoryMatch = /\b(?:carpeta|directorio|folder|directory)\b/i.exec(
    slice
  );

  if (!fileMatch && !directoryMatch) {
    return null;
  }

  if (
    fileMatch &&
    (!directoryMatch || fileMatch.index <= directoryMatch.index)
  ) {
    return {
      kind: 'file',
      extensionHint: fileMatch[1]?.toLowerCase(),
      matchEnd: createMatch.index + fileMatch.index + fileMatch[0].length
    };
  }

  if (directoryMatch) {
    return {
      kind: 'directory',
      matchEnd: createMatch.index + directoryMatch.index + directoryMatch[0].length
    };
  }

  return null;
}

function extractExplicitLocalEntryName(text: string): string | null {
  const quoted = extractQuotedValue(text);
  if (quoted) {
    const candidate = sanitizeLocalEntryName(quoted);
    return isClearLocalEntryName(candidate) ? candidate : null;
  }

  const patterns = [
    /(?:mejor\s+que\s+se\s+llame|better\s+call\s+it)\s+(.+)$/i,
    /(?:hazlo\s+con\s+otro\s+nombre(?:\s+como)?|make\s+it\s+with\s+another\s+name(?:\s+like)?)\s+(.+)$/i,
    /(?:otro\s+nombre(?:\s+como)?|other\s+name(?:\s+like)?|nombre\s+alternativo(?:\s+como)?)\s+(.+)$/i,
    /(?:que\s+se\s+llame|que\s+se\s+llama|named|called|llamad[oa]|de\s+nombre|con\s+nombre)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) {
      continue;
    }

    const candidate = sanitizeLocalEntryName(match[1]);
    if (isClearLocalEntryName(candidate)) {
      return candidate;
    }
  }

  return null;
}

function applySuggestedFileExtension(
  relativePath: string,
  extensionHint?: string
): string {
  if (/\.[a-z0-9]+$/i.test(relativePath)) {
    return relativePath;
  }

  if (extensionHint) {
    return `${relativePath}.${extensionHint}`;
  }

  return `${relativePath}.txt`;
}

function extractAlternativeEntryName(text: string): string | null {
  if (!isLocalCreateReformulationRequest(text)) {
    return null;
  }

  return extractExplicitLocalEntryName(text);
}

function isHistoryRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /(show history|historial|what did you do|activity log|action history)/i.test(
    normalized
  );
}

function isCalendarListRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /(calendar|calendario)/i.test(normalized) &&
    /(show|list|today|hoy|agenda|what is on)/i.test(normalized)
    ? true
    : /(show my schedule|list my events|mis eventos)/i.test(normalized);
}

function wantsCalendarCreate(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /(calendar|calendario|event|evento|meeting|reunion)/i.test(normalized) &&
    /(create|add|schedule|crear|crea|anade|programa|agenda)/i.test(normalized)
  );
}

function wantsLocalFileCreate(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /\b(create|make|new|write|crear|crea|genera)\b/i.test(normalized) &&
    /\b(file|folder|directory|archivo|fichero|carpeta|directorio)\b/i.test(
      normalized
    )
  );
}

function isLocalCreateReformulationRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /(?:\botro nombre\b|\bnombre alternativo\b|\bmejor que se llame\b|\bhazlo con otro nombre\b|\bque se llame\b|\bcalled\b|\bnamed\b|\brename it\b|\bother name\b)/i.test(
    normalized
  );
}

function wantsLocalDirectoryList(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /\b(list|show|browse|open|see|ver|listar|lista|muestra|mostrar|ensena|ensenar)\b/i.test(
      normalized
    ) &&
    /\b(sandbox|folder|directory|carpeta|directorio|contenido)\b/i.test(
      normalized
    )
  );
}

function wantsLocalFileRead(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /\b(read|open|show|leer|lee|abrir|abre|muestra|mostrar)\b/i.test(
      normalized
    ) &&
    (/\b(file|archivo|fichero)\b/i.test(normalized) ||
      /\b[a-z0-9_.-]+\.[a-z0-9]+\b/i.test(text))
  );
}

function isFileReadFollowUp(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(leelo|read it|open it)$/.test(normalized);
}

function isShowFollowUp(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(muestralo|ensenamelo|show it)$/.test(
    normalized
  );
}

function isListFollowUp(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /^(que hay|que items|what items|muestralos|show them)$/.test(
    normalized
  );
}

function extractQuotedValue(text: string): string | null {
  const match = text.match(/["']([^"']+)["']/);
  return match?.[1]?.trim() ?? null;
}

function cleanName(value: string, fallback: string): string {
  const cleaned = value.replace(/[.?!]+$/, '').trim();
  return cleaned || fallback;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-secret]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [redacted]');
}

function summarizeMessage(text: string): string {
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function createDirectOverride(input: TemporaryPolicyOverrideInput): TemporaryPolicyOverride {
  return {
    id: crypto.randomUUID(),
    label: input.label?.trim() || 'Manual policy override',
    scope: input.scope,
    permissionsGranted: input.permissionsGranted,
    confirmationsDisabledFor: input.confirmationsDisabledFor,
    expiresAt: input.expiresAt,
    createdAt: new Date().toISOString(),
    createdFromUserInstruction: input.createdFromUserInstruction
  };
}

function extractLocalFileInput(text: string): LocalCreateIntentParseResult {
  const target = resolveLocalCreateTarget(text);
  if (!target) {
    return {
      input: null,
      missingNameForKind: null
    };
  }

  const explicitName = extractExplicitLocalEntryName(text);
  const remainder = text.slice(target.matchEnd).trim();
  const directName = explicitName
    ? null
    : (() => {
        const candidate = sanitizeLocalEntryName(remainder);
        return isClearLocalEntryName(candidate) ? candidate : null;
      })();
  const relativePathCandidate = explicitName ?? directName;

  if (!relativePathCandidate) {
    return {
      input: null,
      missingNameForKind: target.kind
    };
  }

  const relativePath =
    target.kind === 'file'
      ? applySuggestedFileExtension(relativePathCandidate, target.extensionHint)
      : relativePathCandidate;

  return {
    input: {
      kind: target.kind,
      relativePath
    },
    missingNameForKind: null
  };
}

function extractReadablePath(text: string): string {
  const quoted = extractQuotedValue(text);
  const namingMatch = text.match(
    /(?:named|called|llamad[oa]|de nombre|con nombre)\s+([a-z0-9_\-./ ]+)/i
  );
  const genericMatch = text.match(
    /(?:file|archivo|fichero|folder|directory|carpeta|directorio)(?:\s+(?:named|called|llamad[oa]|de nombre|con nombre))?\s+([a-z0-9_\-./ ]+)/i
  );

  return cleanName(
    stripTrailingSandboxQualifier(
      stripLeadingNamingQualifier(
        quoted ?? namingMatch?.[1] ?? genericMatch?.[1] ?? ''
      )
    ),
    ''
  );
}

function extractCalendarCreateInput(
  text: string,
  now: Date
): CalendarCreateInput {
  const quoted = extractQuotedValue(text);
  const titleMatch = text.match(/(?:for|sobre|called|title)\s+([a-z0-9_\- ]+)/i);
  const title = cleanName(quoted ?? titleMatch?.[1] ?? 'New event', 'New event');

  const tomorrow = /\b(tomorrow|manana)\b/i.test(normalizeIntentText(text));
  const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const base = new Date(now);

  if (tomorrow) {
    base.setDate(base.getDate() + 1);
  }

  const rawHour = Number.parseInt(timeMatch?.[1] ?? '10', 10);
  const rawMinutes = Number.parseInt(timeMatch?.[2] ?? '0', 10);
  const meridiem = timeMatch?.[3]?.toLowerCase();

  let hours = rawHour;
  if (meridiem === 'pm' && rawHour < 12) {
    hours += 12;
  } else if (meridiem === 'am' && rawHour === 12) {
    hours = 0;
  }

  const startsAt = new Date(base);
  startsAt.setHours(hours, rawMinutes, 0, 0);

  const endsAt = addMinutes(startsAt, 30);

  return {
    title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString()
  };
}

interface InteractionTrace {
  startedAt: number;
  messagePreview: string;
  toolsUsed: string[];
  confirmationRequired: boolean;
  providerId?: string;
  model?: string;
  usage?: ModelResponse['usage'];
  result?: TelemetryResult;
  errorMessage?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
}

export interface AssemOrchestratorDeps {
  config: AssemConfig;
  actionLog: ActionLogService;
  sessionStore: SessionStore;
  toolRegistry: ToolRegistryContract;
  policyEngine: PolicyEngineContract;
  modelRouter: ModelRouterContract;
  memoryBackend: MemoryBackend;
  telemetry: TelemetrySink;
}

export class AssemOrchestrator {
  constructor(private readonly deps: AssemOrchestratorDeps) {}

  async createSession(): Promise<SessionSnapshot> {
    const session = await this.deps.sessionStore.createSession();
    await this.deps.sessionStore.saveSession(session);
    return this.snapshot(session);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const session = await this.deps.sessionStore.getSession(sessionId);
    return session ? this.snapshot(session) : null;
  }

  async listActionLog(sessionId: string): Promise<ActionLogEntry[]> {
    const session = await this.requireSession(sessionId);
    return [...session.actionLog].reverse();
  }

  async listPendingActions(sessionId: string): Promise<PendingAction[]> {
    const session = await this.requireSession(sessionId);
    return session.pendingAction ? [session.pendingAction] : [];
  }

  async getMode(sessionId: string): Promise<ActiveMode> {
    const session = await this.requireSession(sessionId);
    return session.activeMode;
  }

  async updateMode(request: ModeUpdateRequest): Promise<ActiveMode> {
    const session = await this.requireSession(request.sessionId);
    session.activeMode = {
      ...session.activeMode,
      ...request.activeMode
    };

    this.deps.actionLog.record(session, {
      kind: 'system',
      title: 'Modo actualizado',
      detail: `Privacidad: ${session.activeMode.privacy}; ejecucion: ${session.activeMode.runtime}.`,
      status: 'info'
    });

    await this.deps.sessionStore.saveSession(session);
    return session.activeMode;
  }

  async listOverrides(sessionId: string): Promise<TemporaryPolicyOverride[]> {
    const session = await this.requireSession(sessionId);
    this.deps.policyEngine.pruneExpired(session);
    await this.deps.sessionStore.saveSession(session);
    return [...session.temporaryOverrides];
  }

  async createOverride(
    request: OverrideCreateRequest
  ): Promise<TemporaryPolicyOverride[]> {
    const session = await this.requireSession(request.sessionId);
    this.deps.policyEngine.pruneExpired(session);

    const override =
      request.override !== undefined
        ? createDirectOverride(request.override)
        : request.instruction
          ? this.deps.policyEngine.parseTemporaryOverride(request.instruction)
          : null;

    if (!override) {
      throw new Error('The override request could not be parsed.');
    }

    session.temporaryOverrides.push(override);
    this.deps.actionLog.record(session, {
      kind: 'policy',
      title: 'Override temporal anadido',
      detail: `${override.label} activo hasta ${new Date(override.expiresAt).toLocaleString()}.`,
      status: 'completed'
    });

    await this.deps.sessionStore.saveSession(session);
    return [...session.temporaryOverrides];
  }

  async cancelOverride(
    sessionId: string,
    overrideId: string
  ): Promise<TemporaryPolicyOverride | null> {
    const session = await this.requireSession(sessionId);
    const removed = this.deps.policyEngine.cancelOverride(session, overrideId);

    if (removed) {
      this.deps.actionLog.record(session, {
        kind: 'policy',
        title: 'Override temporal cancelado',
        detail: `${removed.label} se ha cancelado manualmente.`,
        status: 'rejected'
      });
      await this.deps.sessionStore.saveSession(session);
    }

    return removed;
  }

  async listSessions() {
    return this.deps.sessionStore.listSessions();
  }

  async handleChat(request: ChatRequest): Promise<SessionSnapshot> {
    const session = await this.deps.sessionStore.getOrCreateSession(request.sessionId);
    const trace: InteractionTrace = {
      startedAt: Date.now(),
      messagePreview: summarizeMessage(request.text ?? ''),
      toolsUsed: [],
      confirmationRequired: false
    };

    try {
      const text = request.text.trim();

      if (request.activeMode) {
        session.activeMode = {
          ...session.activeMode,
          ...request.activeMode
        };
      }

      if (!text) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          'Escribe una peticion para continuar. Por ejemplo: "Que hora es?" o "Crea una carpeta llamada notas".'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      this.pushMessage(session, 'user', text);

      const pendingActionIntent = resolvePendingActionIntent(text);

      if (session.pendingAction) {
        if (pendingActionIntent === 'approve') {
          return await this.resolvePendingAction({
            sessionId: session.sessionId,
            approved: true
          });
        }

        if (pendingActionIntent === 'reject') {
          return await this.resolvePendingAction({
            sessionId: session.sessionId,
            approved: false
          });
        }

        const replacementSnapshot = await this.handlePendingLocalCreateReplacement(
          session,
          text,
          trace
        );
        if (replacementSnapshot) {
          return replacementSnapshot;
        }

        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          'Todavia hay una accion pendiente esperando confirmacion. Confirmala, rechazala o cancelala antes de iniciar otra accion de escritura.'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      if (pendingActionIntent !== null) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          pendingActionIntent === 'approve'
            ? 'No hay ninguna accion pendiente para confirmar en esta sesion.'
            : 'No hay ninguna accion pendiente para rechazar en esta sesion.'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const override = this.deps.policyEngine.parseTemporaryOverride(text);
      if (override) {
        session.temporaryOverrides.push(override);
        this.deps.actionLog.record(session, {
          kind: 'policy',
          title: 'Override temporal anadido',
          detail: `${override.label} activo hasta ${new Date(override.expiresAt).toLocaleString()}.`,
          status: 'completed'
        });

        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';

        const snapshot = await this.reply(
          session,
          `He guardado el override temporal hasta ${new Date(override.expiresAt).toLocaleString()}. Reducire las confirmaciones dentro de ese alcance.`
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const modeResponse = this.applyModeInstruction(session, text);
      if (modeResponse) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(session, modeResponse);
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      if (isHistoryRequest(text)) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(session, this.renderHistory(session));
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const greetingResponse = await this.handleGreetingIntent(
        session,
        text,
        trace
      );
      if (greetingResponse) {
        return greetingResponse;
      }

      const capabilitiesResponse = await this.handleSystemCapabilitiesIntent(
        session,
        text,
        trace
      );
      if (capabilitiesResponse) {
        return capabilitiesResponse;
      }

      const temporalResponse = await this.handleTemporalIntent(
        session,
        text,
        trace
      );
      if (temporalResponse) {
        return temporalResponse;
      }

      if (wantsCalendarCreate(text)) {
        return await this.executeOrQueue(
          session,
          'calendar.create-event',
          extractCalendarCreateInput(text, new Date()),
          trace
        );
      }

      if (isCalendarListRequest(text)) {
        return await this.executeOrQueue(
          session,
          'calendar.list-events',
          undefined,
          trace
        );
      }

      if (wantsLocalDirectoryList(text)) {
        return await this.executeOrQueue(
          session,
          'local-files.list-directory',
          {
            relativePath: extractReadablePath(text)
          },
          trace
        );
      }

      if (wantsLocalFileRead(text)) {
        return await this.executeOrQueue(
          session,
          'local-files.read-file',
          {
            relativePath: extractReadablePath(text)
          },
          trace
        );
      }

      const localCreateClarification = await this.handleLocalCreateClarification(
        session,
        text,
        trace
      );
      if (localCreateClarification) {
        return localCreateClarification;
      }

      const localCreateInput = this.resolveLocalCreateIntent(session, text);
      if (localCreateInput) {
        return await this.executeOrQueue(
          session,
          'local-files.create-entry',
          localCreateInput,
          trace
        );
      }

      const contextualFollowUp = await this.handleContextualLocalFollowUp(
        session,
        text,
        trace
      );
      if (contextualFollowUp) {
        return contextualFollowUp;
      }

      const ambiguousResponse = await this.handleAmbiguousIntent(
        session,
        text,
        trace
      );
      if (ambiguousResponse) {
        return ambiguousResponse;
      }

      const activeProfile = await this.deps.memoryBackend.getActiveProfile();
      const profileSummary: ProfileSummary | null = activeProfile
        ? summarizeProfile(activeProfile)
        : null;
      const response = await this.deps.modelRouter.respond({
        messages: session.messages,
        availableTools: this.deps.toolRegistry.summaries(),
        privacyMode: session.activeMode.privacy,
        runtimeMode: session.activeMode.runtime,
        preferredProviderId: session.settings.preferredProviderId,
        requiredCapabilities: ['chat'],
        activeProfile: profileSummary
      });

      trace.providerId = response.providerId;
      trace.model = response.model;
      trace.usage = response.usage;
      trace.fallbackUsed = response.fallbackUsed;
      trace.fallbackReason =
        response.fallbackReason ?? response.usage?.fallbackReason;
      trace.result = 'success';
      session.lastModelInvocation = {
        providerId: response.providerId,
        model: response.model,
        configuredModel: response.configuredModel,
        resolvedModel: response.resolvedModel ?? response.model,
        timestamp: new Date().toISOString(),
        fallbackUsed: response.fallbackUsed,
        fallbackReason:
          response.fallbackReason ?? response.usage?.fallbackReason
      };

      const snapshot = await this.reply(session, response.text);
      await this.recordTelemetry(session, trace);
      return snapshot;
    } catch (error) {
      trace.providerId ??= trace.toolsUsed.length > 0 ? 'tool-only' : undefined;
      trace.model ??= trace.providerId ? 'tool-only' : undefined;
      trace.result = 'error';
        trace.errorMessage =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown error';

      const snapshot = await this.replyError(
        session,
        trace.errorMessage,
        'No he podido completar la solicitud.'
      );
      await this.recordTelemetry(session, trace);
      return snapshot;
    }
  }

  async resolvePendingAction(
    request: PendingActionResolutionRequest
  ): Promise<SessionSnapshot> {
    const session = await this.requireSession(request.sessionId);
    const pendingAction = session.pendingAction;
    const trace: InteractionTrace = {
      startedAt: Date.now(),
      messagePreview: request.approved ? 'pending-action:approved' : 'pending-action:rejected',
      toolsUsed: pendingAction ? [pendingAction.toolId] : [],
      confirmationRequired: true,
      providerId: 'tool-only',
      model: 'tool-only'
    };

    try {
      if (!pendingAction) {
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          'No hay ninguna accion pendiente para confirmar.'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      if (!request.approved) {
        pendingAction.status = 'cancelled';
        pendingAction.updatedAt = new Date().toISOString();
        this.rememberWriteIntent(session, {
          toolId: pendingAction.toolId,
          toolLabel: pendingAction.toolLabel,
          input: pendingAction.input,
          status: 'cancelled',
          recordedAt: pendingAction.updatedAt
        });
        session.pendingAction = null;
        this.deps.actionLog.record(session, {
          kind: 'tool_rejected',
          title: 'Accion rechazada',
          detail: `Se ha rechazado ${pendingAction.toolLabel}.`,
          status: 'rejected'
        });

        trace.result = 'rejected';
        const snapshot = await this.reply(
          session,
          `He cancelado ${pendingAction.toolLabel}.`
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      pendingAction.status = 'confirmed';
      pendingAction.updatedAt = new Date().toISOString();
      this.rememberWriteIntent(session, {
        toolId: pendingAction.toolId,
        toolLabel: pendingAction.toolLabel,
        input: pendingAction.input,
        status: 'confirmed',
        recordedAt: pendingAction.updatedAt
      });
      session.pendingAction = null;

      return await this.runTool(
        session,
        pendingAction.toolId,
        pendingAction.input,
        trace
      );
    } catch (error) {
      if (pendingAction) {
        const errorMessage =
          error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown error';
        this.rememberWriteIntent(session, {
          toolId: pendingAction.toolId,
          toolLabel: pendingAction.toolLabel,
          input: pendingAction.input,
          status: 'failed',
          recordedAt: new Date().toISOString(),
          errorMessage
        });
      }
      trace.result = 'error';
      trace.errorMessage =
        error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown error';
      const snapshot = await this.replyError(
        session,
        trace.errorMessage,
        'No he podido resolver la accion pendiente.'
      );
      await this.recordTelemetry(session, trace);
      return snapshot;
    }
  }

  private async executeOrQueue(
    session: SessionState,
    toolId: string,
    input: unknown,
    trace: InteractionTrace
  ): Promise<SessionSnapshot> {
    const tool = this.deps.toolRegistry.get(toolId);
    const localCreateInput =
      tool.id === 'local-files.create-entry' ? (input as LocalFileInput) : null;
    trace.toolsUsed = [tool.id];
    trace.confirmationRequired = false;
    trace.providerId = 'tool-only';
    trace.model = 'tool-only';

    if (localCreateInput) {
      const preflightSnapshot = await this.preflightLocalCreate(
        session,
        tool,
        localCreateInput,
        trace
      );
      if (preflightSnapshot) {
        return preflightSnapshot;
      }
    }

    const decision = this.deps.policyEngine.evaluate(session, tool);
    trace.confirmationRequired = decision.requiresConfirmation;

    if (!decision.allowed) {
      trace.result = 'error';
      trace.errorMessage = decision.reason;
      const snapshot = await this.reply(session, decision.reason);
      await this.recordTelemetry(session, trace);
      return snapshot;
    }

    if (!decision.requiresConfirmation) {
      return await this.runTool(session, tool.id, input, trace);
    }

    const pendingAction: PendingAction = {
      id: crypto.randomUUID(),
      toolId: tool.id,
      toolLabel: tool.label,
      input,
      reason: decision.reason,
      riskLevel: tool.riskLevel,
      permissions: tool.requiresPermissions,
      confirmationMessage: this.describeConfirmation(tool, input),
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    session.pendingAction = pendingAction;
    this.rememberWriteIntent(session, {
      toolId: pendingAction.toolId,
      toolLabel: pendingAction.toolLabel,
      input: pendingAction.input,
      status: 'pending',
      recordedAt: pendingAction.createdAt
    });
    this.deps.actionLog.record(session, {
      kind: 'tool_request',
      title: `Confirmacion solicitada para ${tool.label}`,
      detail: pendingAction.confirmationMessage,
      status: 'pending'
    });

    trace.result = 'success';
    const snapshot = await this.reply(
      session,
      `Esperando confirmacion. ${pendingAction.confirmationMessage}`
    );
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private async runTool(
    session: SessionState,
    toolId: string,
    input: unknown,
    trace: InteractionTrace
  ): Promise<SessionSnapshot> {
    const tool = this.deps.toolRegistry.get(toolId);
    trace.toolsUsed = [tool.id];
    trace.providerId = 'tool-only';
    trace.model = 'tool-only';
    try {
      const result = await this.executeTool(tool, session, input);
      const responseText = this.renderToolResponse(session, tool, input, result);
      this.updateOperationalContext(session, tool, input, result, responseText);
      this.rememberWriteIntent(session, {
        toolId: tool.id,
        toolLabel: tool.label,
        input,
        status: 'completed',
        recordedAt: new Date().toISOString()
      });

      this.deps.actionLog.record(session, {
        kind: 'tool_result',
        title: `${tool.label} completado`,
        detail: responseText,
        status: 'completed'
      });

      trace.result = 'success';
      const snapshot = await this.reply(session, responseText);
      await this.recordTelemetry(session, trace);
      return snapshot;
    } catch (error) {
      this.rememberWriteIntent(session, {
        toolId: tool.id,
        toolLabel: tool.label,
        input,
        status: 'failed',
        recordedAt: new Date().toISOString(),
        errorMessage:
          error instanceof Error ? sanitizeErrorMessage(error.message) : 'Unknown error'
      });
      throw error;
    }
  }

  private async executeTool(
    tool: ToolDefinition,
    session: SessionState,
    input: unknown
  ): Promise<ToolExecutionResult> {
    const activeProfile = await this.deps.memoryBackend.getActiveProfile();

    return tool.execute(input, {
      now: new Date(),
      sandboxRoot: this.deps.config.sandboxRoot,
      activeMode: session.activeMode,
      session,
      activeProfile
    });
  }

  private snapshot(session: SessionState): SessionSnapshot {
    return {
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
      actionLog: session.actionLog,
      pendingAction: session.pendingAction,
      temporaryOverrides: session.temporaryOverrides,
      calendarEvents: session.calendarEvents,
      activeMode: session.activeMode,
      settings: session.settings,
      operationalContext: session.operationalContext,
      lastModelInvocation: session.lastModelInvocation,
      availableProviders: this.deps.modelRouter.listProviders(),
      availableTools: this.deps.toolRegistry.summaries()
    };
  }

  private pushMessage(
    session: SessionState,
    role: ChatMessage['role'],
    content: string
  ): void {
    session.messages.push({
      id: crypto.randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString()
    });
  }

  private async reply(
    session: SessionState,
    text: string,
    kind: ActionLogEntry['kind'] = 'assistant',
    status: ActionLogEntry['status'] = 'info',
    title = 'Respuesta de ASSEM'
  ): Promise<SessionSnapshot> {
    this.pushMessage(session, 'assistant', text);
    this.deps.actionLog.record(session, {
      kind,
      title,
      detail: text,
      status
    });
    await this.deps.sessionStore.saveSession(session);
    return this.snapshot(session);
  }

  private async replyError(
    session: SessionState,
    detail: string,
    fallbackTitle: string
  ): Promise<SessionSnapshot> {
    return this.reply(
      session,
      `${fallbackTitle} ${detail}`,
      'system',
      'error',
      'Error de solicitud'
    );
  }

  private applyModeInstruction(
    session: SessionState,
    text: string
  ): string | null {
    const updates: Partial<ActiveMode> = {};

    if (/(local only mode|modo local|solo local)/i.test(text)) {
      updates.privacy = 'local_only';
    }

    if (/(prefer local|prioriza local)/i.test(text)) {
      updates.privacy = 'prefer_local';
    }

    if (/(balanced mode|modo balanceado)/i.test(text)) {
      updates.privacy = 'balanced';
    }

    if (/(cloud allowed|permite nube)/i.test(text)) {
      updates.privacy = 'cloud_allowed';
    }

    if (/(sandbox mode|modo sandbox)/i.test(text)) {
      updates.runtime = 'sandbox';
    }

    if (/(live mode|modo live|real mode)/i.test(text)) {
      updates.runtime = 'live';
    }

    if (!updates.privacy && !updates.runtime) {
      return null;
    }

    session.activeMode = {
      ...session.activeMode,
      ...updates
    };

    const parts = [
      updates.privacy ? `el modo de privacidad ahora es ${session.activeMode.privacy}` : '',
      updates.runtime ? `el modo de ejecucion ahora es ${session.activeMode.runtime}` : ''
    ].filter(Boolean);

    return `He actualizado el modo de la sesion: ${parts.join(' y ')}.`;
  }

  private renderHistory(session: SessionState): string {
    if (session.actionLog.length === 0) {
      return 'El historial de acciones esta vacio por ahora.';
    }

    const preview = session.actionLog
      .slice(-4)
      .map((entry) => `${entry.title} (${entry.status})`)
      .join('; ');

    return `Actividad reciente: ${preview}.`;
  }

  private async handleLocalCreateClarification(
    session: SessionState,
    text: string,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    const parsedIntent = extractLocalFileInput(text);
    if (!wantsLocalFileCreate(text) || !parsedIntent.missingNameForKind) {
      return null;
    }

    trace.providerId = 'tool-only';
    trace.model = 'tool-only';
    trace.result = 'success';
    const snapshot = await this.reply(
      session,
      this.renderMissingLocalCreateName(parsedIntent.missingNameForKind)
    );
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private renderMissingLocalCreateName(kind: 'file' | 'directory'): string {
    if (kind === 'directory') {
      return 'Necesito el nombre de la carpeta para prepararla. Dime algo como "crea una carpeta llamada proyectos".';
    }

    return 'Necesito el nombre del archivo para prepararlo. Dime algo como "crea un archivo llamado nota.txt".';
  }

  private async handleGreetingIntent(
    session: SessionState,
    text: string,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    if (!isGreetingRequest(text)) {
      return null;
    }

    const language = this.resolveConversationLanguage(session, text);
    trace.providerId = 'tool-only';
    trace.model = 'tool-only';
    trace.result = 'success';
    const snapshot = await this.reply(session, this.renderGreeting(language));
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private async handleSystemCapabilitiesIntent(
    session: SessionState,
    text: string,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    if (!isSystemCapabilitiesRequest(text)) {
      return null;
    }

    const language = this.resolveConversationLanguage(session, text);
    const providerHealth = await this.deps.modelRouter.healthCheck();
    trace.providerId = 'tool-only';
    trace.model = 'tool-only';
    trace.result = 'success';
    const snapshot = await this.reply(
      session,
      this.renderSystemCapabilities(session, providerHealth, language)
    );
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private async handleAmbiguousIntent(
    session: SessionState,
    text: string,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    if (!isAmbiguousSystemRequest(text)) {
      return null;
    }

    const language = this.resolveConversationLanguage(session, text);
    trace.providerId = 'tool-only';
    trace.model = 'tool-only';
    trace.result = 'success';
    const snapshot = await this.reply(
      session,
      this.renderAmbiguousClarification(text, language)
    );
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private renderGreeting(language: SupportedLanguage): string {
    const availableToolIds = new Set(
      this.deps.toolRegistry.summaries().map((tool) => tool.id)
    );
    const capabilityChunks =
      language === 'es'
        ? [
            availableToolIds.has('clock-time.get-current')
              ? 'consultar la fecha y la hora reales'
              : null,
            availableToolIds.has('local-files.list-directory')
              ? 'trabajar dentro del sandbox local'
              : null,
            availableToolIds.has('calendar.list-events')
              ? 'revisar el calendario mock'
              : null,
            'mostrar el estado real del sistema'
          ].filter(Boolean)
        : [
            availableToolIds.has('clock-time.get-current')
              ? 'check the real date and time'
              : null,
            availableToolIds.has('local-files.list-directory')
              ? 'work inside the local sandbox'
              : null,
            availableToolIds.has('calendar.list-events')
              ? 'review the mock calendar'
              : null,
            'show the real system status'
          ].filter(Boolean);

    if (language === 'es') {
      return `Hola. Puedo ${capabilityChunks.join(', ')}.`;
    }

    return `Hello. I can ${capabilityChunks.join(', ')}.`;
  }

  private renderSystemCapabilities(
    session: SessionState,
    providerHealth: ProviderHealth[],
    language: SupportedLanguage
  ): string {
    const tools = this.deps.toolRegistry
      .summaries()
      .map((tool) => this.describeAvailableTool(tool, language))
      .join(', ');
    const providers = providerHealth
      .map((health) => this.describeProviderHealth(health, language))
      .join('; ');
    const lastInvocation = session.lastModelInvocation;

    if (language === 'es') {
      const lastProviderSentence = lastInvocation
        ? `Ultimo provider usado en esta sesion: ${lastInvocation.providerId} con ${lastInvocation.resolvedModel ?? lastInvocation.model}.`
        : 'Todavia no he usado ningun provider conversacional en esta sesion.';
      return `ASSEM se esta ejecutando en modo ${session.activeMode.privacy} / ${session.activeMode.runtime}. Herramientas disponibles ahora mismo: ${tools}. Proveedor configurado por defecto: ${this.deps.config.defaultProviderId}. Estado real de providers: ${providers}. ${lastProviderSentence}`;
    }

    const lastProviderSentence = lastInvocation
      ? `Last provider used in this session: ${lastInvocation.providerId} with ${lastInvocation.resolvedModel ?? lastInvocation.model}.`
      : 'No conversational provider has been used in this session yet.';
    return `ASSEM is running in ${session.activeMode.privacy} / ${session.activeMode.runtime} mode. Available tools right now: ${tools}. Configured default provider: ${this.deps.config.defaultProviderId}. Real provider status: ${providers}. ${lastProviderSentence}`;
  }

  private describeAvailableTool(
    tool: ToolSummary,
    language: SupportedLanguage
  ): string {
    if (language === 'es') {
      switch (tool.id) {
        case 'clock-time.get-current':
          return 'hora y fecha actuales';
        case 'local-files.list-directory':
          return 'listar el sandbox';
        case 'local-files.read-file':
          return 'leer archivos del sandbox';
        case 'local-files.create-entry':
          return 'crear archivos o carpetas con confirmacion';
        case 'calendar.list-events':
          return 'listar el calendario mock';
        case 'calendar.create-event':
          return 'crear eventos mock';
        default:
          return tool.label;
      }
    }

    switch (tool.id) {
      case 'clock-time.get-current':
        return 'current time and date';
      case 'local-files.list-directory':
        return 'list the sandbox';
      case 'local-files.read-file':
        return 'read sandbox files';
      case 'local-files.create-entry':
        return 'create files or folders with confirmation';
      case 'calendar.list-events':
        return 'list the mock calendar';
      case 'calendar.create-event':
        return 'create mock events';
      default:
        return tool.label;
    }
  }

  private describeProviderHealth(
    health: ProviderHealth,
    language: SupportedLanguage
  ): string {
    const status =
      language === 'es'
        ? health.status === 'ok'
          ? 'ok'
          : health.status === 'degraded'
            ? 'degradado'
            : 'no disponible'
        : health.status === 'ok'
          ? 'ok'
          : health.status === 'degraded'
            ? 'degraded'
            : 'unavailable';
    const configured =
      language === 'es'
        ? health.configured
          ? 'configurado'
          : 'no configurado'
        : health.configured
          ? 'configured'
          : 'not configured';
    const model = health.resolvedModel ?? health.defaultModel;

    if (language === 'es') {
      return `${health.providerId} (${status}, ${configured}, modelo ${model})`;
    }

    return `${health.providerId} (${status}, ${configured}, model ${model})`;
  }

  private renderAmbiguousClarification(
    text: string,
    language: SupportedLanguage
  ): string {
    const normalized = normalizeIntentText(text);
    const mentionsWork = /\bobra\b/.test(normalized);

    if (language === 'es') {
      if (mentionsWork) {
        return 'No tengo claro a que te refieres con "obra". Si preguntas por herramientas, por el estado del sistema o por el contenido del sandbox, dimelo asi de forma directa.';
      }

      return 'No me queda claro si preguntas por mis herramientas, por el estado del sistema o por el contenido del sandbox. Aclaramelo en una frase.';
    }

    if (mentionsWork) {
      return 'I am not sure what you mean by "obra". If you mean tools, system status, or sandbox contents, ask for that directly.';
    }

    return 'I am not sure whether you are asking about my tools, the system status, or the sandbox contents. Clarify it in one short sentence.';
  }

  private describeConfirmation(tool: ToolDefinition, input: unknown): string {
    if (tool.id === 'local-files.create-entry') {
      const localInput = input as LocalFileInput;
      const kind = localInput.kind === 'directory' ? 'carpeta' : 'archivo';
      const article = localInput.kind === 'directory' ? 'la' : 'el';
      return `Confirma crear ${article} ${kind} "${localInput.relativePath}" dentro del sandbox?`;
    }

    if (tool.id === 'calendar.create-event') {
      const calendarInput = input as CalendarCreateInput;
      return `Confirma crear el evento "${calendarInput.title}" para ${new Date(calendarInput.startsAt).toLocaleString()}?`;
    }

    return `Confirma ejecutar ${tool.label}?`;
  }

  private tracksWriteIntent(toolId: string): boolean {
    return toolId === 'local-files.create-entry' || toolId === 'calendar.create-event';
  }

  private rememberWriteIntent(
    session: SessionState,
    writeIntent: SessionWriteIntent
  ): void {
    if (!this.tracksWriteIntent(writeIntent.toolId)) {
      return;
    }

    const nextContext: SessionOperationalContext = {
      ...(session.operationalContext ?? {})
    };

    nextContext.lastWriteIntent = writeIntent;
    session.operationalContext = nextContext;
  }

  private resolveLastCreateEntryInput(session: SessionState): LocalFileInput | null {
    if (session.pendingAction?.toolId === 'local-files.create-entry') {
      return session.pendingAction.input as LocalFileInput;
    }

    const lastWriteIntent = session.operationalContext?.lastWriteIntent;
    if (lastWriteIntent?.toolId === 'local-files.create-entry') {
      return lastWriteIntent.input as LocalFileInput;
    }

    return null;
  }

  private resolveLocalCreateIntent(
    session: SessionState,
    text: string
  ): LocalFileInput | null {
    if (wantsLocalFileCreate(text)) {
      return extractLocalFileInput(text).input;
    }

    const alternativeName = extractAlternativeEntryName(text);
    if (!alternativeName) {
      return null;
    }

    const previousInput = this.resolveLastCreateEntryInput(session);
    if (!previousInput) {
      return null;
    }

    let relativePath = sanitizeLocalEntryName(
      stripTrailingSandboxQualifier(
        stripLeadingNamingQualifier(alternativeName)
      )
    );

    if (!isClearLocalEntryName(relativePath)) {
      return null;
    }

    if (previousInput.kind === 'file' && !/\.[a-z0-9]+$/i.test(relativePath)) {
      relativePath = `${relativePath}.txt`;
    }

    return {
      kind: previousInput.kind,
      relativePath
    };
  }

  private async handlePendingLocalCreateReplacement(
    session: SessionState,
    text: string,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    const pendingAction = session.pendingAction;
    if (pendingAction?.toolId !== 'local-files.create-entry') {
      return null;
    }

    if (wantsLocalFileCreate(text)) {
      return null;
    }

    if (!isLocalCreateReformulationRequest(text)) {
      return null;
    }

    const replacementInput = this.resolveLocalCreateIntent(session, text);
    if (!replacementInput) {
      trace.providerId = 'tool-only';
      trace.model = 'tool-only';
      trace.result = 'success';
      const kind = (pendingAction.input as LocalFileInput).kind;
      const snapshot = await this.reply(
        session,
        this.renderPendingCreateReformulationClarification(kind)
      );
      await this.recordTelemetry(session, trace);
      return snapshot;
    }

    pendingAction.status = 'cancelled';
    pendingAction.updatedAt = new Date().toISOString();
    pendingAction.errorMessage =
      'La solicitud pendiente se ha sustituido por una nueva intencion.';
    this.rememberWriteIntent(session, {
      toolId: pendingAction.toolId,
      toolLabel: pendingAction.toolLabel,
      input: pendingAction.input,
      status: 'cancelled',
      recordedAt: pendingAction.updatedAt,
      errorMessage: pendingAction.errorMessage
    });
    this.deps.actionLog.record(session, {
      kind: 'tool_rejected',
      title: 'Accion cancelada',
      detail:
        'La solicitud pendiente se ha cancelado y se ha preparado una nueva intencion de creacion.',
      status: 'rejected'
    });
    session.pendingAction = null;

    return this.executeOrQueue(
      session,
      'local-files.create-entry',
      replacementInput,
      trace
    );
  }

  private renderPendingCreateReformulationClarification(
    kind: 'file' | 'directory'
  ): string {
    if (kind === 'directory') {
      return 'Si quieres cambiar la accion pendiente, dime el nuevo nombre de la carpeta. Por ejemplo: "mejor que se llame proyectos".';
    }

    return 'Si quieres cambiar la accion pendiente, dime el nuevo nombre del archivo. Por ejemplo: "mejor que se llame Gayeta.txt".';
  }

  private async preflightLocalCreate(
    session: SessionState,
    tool: ToolDefinition,
    input: LocalFileInput,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    const probe = await probeSandboxEntry(
      this.deps.config.sandboxRoot,
      input.relativePath
    );

    if (!probe.exists) {
      return null;
    }

    const kindLabel = probe.kind === 'directory' ? 'carpeta' : 'archivo';
    const message = `La ruta "${normalizeRelativeReference(
      input.relativePath
    )}" ya existe en ${probe.absolutePath}. Ya hay ${probe.kind === 'directory' ? 'una carpeta' : 'un archivo'} ahi. Usa otro nombre para crear un ${kindLabel} nuevo. El sobrescrito no esta habilitado en esta fase.`;

    this.rememberWriteIntent(session, {
      toolId: tool.id,
      toolLabel: tool.label,
      input,
      status: 'failed',
      recordedAt: new Date().toISOString(),
      errorMessage: message
    });

    trace.result = 'error';
    trace.errorMessage = 'La ruta solicitada del sandbox ya existe.';
    const snapshot = await this.reply(
      session,
      message,
      'system',
      'error',
      'Creacion bloqueada'
    );
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private async handleTemporalIntent(
    session: SessionState,
    text: string,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    if (isTimeRequest(text)) {
      return this.executeOrQueue(session, 'clock-time.get-current', undefined, trace);
    }

    const activeSnapshot = this.resolveActiveTemporalSnapshot(session);

    if (isTemporalRephraseRequest(text)) {
      if (!activeSnapshot) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          'No tengo un dato temporal reciente para reformular. Pideme primero la hora o la fecha.'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const language = this.resolveTemporalFollowUpLanguage(
        session,
        text,
        activeSnapshot
      );
      const nextSnapshot = {
        ...activeSnapshot,
        locale: localeForLanguage(language),
        renderedLanguage: language
      };
      const snapshot = await this.replyFromTemporalSnapshot(
        session,
        trace,
        nextSnapshot,
        this.renderTemporalSnapshot(nextSnapshot)
      );
      return snapshot;
    }

    const requestedWeekdayIndex = extractRequestedWeekdayIndex(text);
    if (requestedWeekdayIndex !== null && isTemporalWeekdayQuestion(text)) {
      const language = this.resolveConversationLanguage(session, text);

      if (activeSnapshot) {
        const nextSnapshot = {
          ...activeSnapshot,
          locale: localeForLanguage(language),
          renderedLanguage: language
        };
        return this.replyFromTemporalSnapshot(
          session,
          trace,
          nextSnapshot,
          this.renderTemporalVerification(nextSnapshot, requestedWeekdayIndex)
        );
      }

      return this.executeFreshTemporalVerification(
        session,
        trace,
        language,
        requestedWeekdayIndex
      );
    }

    const temporalCorrection = parseTemporalCorrection(text);
    if (temporalCorrection) {
      if (!activeSnapshot) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          'No tengo un dato temporal reciente para revisar. Pideme primero la hora o la fecha.'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const language = this.resolveConversationLanguage(session, text);
      const nextSnapshot = {
        ...activeSnapshot,
        locale: localeForLanguage(language),
        renderedLanguage: language
      };

      return this.replyFromTemporalSnapshot(
        session,
        trace,
        nextSnapshot,
        this.renderTemporalCorrection(nextSnapshot, temporalCorrection)
      );
    }

    if (isTemporalDisputeRequest(text)) {
      if (!activeSnapshot) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          'No tengo un dato temporal reciente para revisar. Pideme primero la hora o la fecha.'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const language = this.resolveConversationLanguage(session, text);
      const nextSnapshot = {
        ...activeSnapshot,
        locale: localeForLanguage(language),
        renderedLanguage: language
      };
      return this.replyFromTemporalSnapshot(
        session,
        trace,
        nextSnapshot,
        this.renderTemporalDispute(nextSnapshot)
      );
    }

    if (isTemporalReassuranceRequest(text)) {
      if (!activeSnapshot) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          'No tengo un dato temporal reciente para verificar. Pideme primero la hora o la fecha.'
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const language = this.resolveConversationLanguage(session, text);
      const nextSnapshot = {
        ...activeSnapshot,
        locale: localeForLanguage(language),
        renderedLanguage: language
      };
      return this.replyFromTemporalSnapshot(
        session,
        trace,
        nextSnapshot,
        this.renderTemporalReassurance(nextSnapshot)
      );
    }

    return null;
  }

  private async executeFreshTemporalVerification(
    session: SessionState,
    trace: InteractionTrace,
    language: SupportedLanguage,
    requestedWeekdayIndex: number
  ): Promise<SessionSnapshot> {
    const tool = this.deps.toolRegistry.get('clock-time.get-current');
    trace.toolsUsed = [tool.id];
    trace.providerId = 'tool-only';
    trace.model = 'tool-only';
    const result = await this.executeTool(tool, session, undefined);
    const output = result.output as TimeOutput;
    const temporalSnapshot = this.createTemporalSnapshot(output, language);
    const responseText = this.renderTemporalVerification(
      temporalSnapshot,
      requestedWeekdayIndex
    );

    this.updateOperationalContext(session, tool, undefined, result, responseText);
    this.deps.actionLog.record(session, {
      kind: 'tool_result',
      title: `${tool.label} completado`,
      detail: responseText,
      status: 'completed'
    });

    trace.result = 'success';
    const snapshot = await this.reply(session, responseText);
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private async replyFromTemporalSnapshot(
    session: SessionState,
    trace: InteractionTrace,
    temporalSnapshot: SessionTemporalSnapshot,
    responseText: string
  ): Promise<SessionSnapshot> {
    trace.providerId = 'tool-only';
    trace.model = 'tool-only';
    trace.result = 'success';
    this.rememberTemporalSnapshot(session, temporalSnapshot, responseText);
    const snapshot = await this.reply(session, responseText);
    await this.recordTelemetry(session, trace);
    return snapshot;
  }

  private resolveConversationLanguage(
    session: SessionState,
    currentText?: string
  ): SupportedLanguage {
    const directMatch = currentText ? detectMessageLanguage(currentText) : null;
    if (directMatch) {
      return directMatch;
    }

    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (message.role !== 'user') {
        continue;
      }

      const detected = detectMessageLanguage(message.content);
      if (detected) {
        return detected;
      }
    }

    return (
      this.resolveActiveTemporalSnapshot(session)?.renderedLanguage ??
      session.operationalContext?.lastTemporalSnapshot?.renderedLanguage ??
      'es'
    );
  }

  private resolveTemporalFollowUpLanguage(
    session: SessionState,
    text: string,
    snapshot: SessionTemporalSnapshot
  ): SupportedLanguage {
    const normalized = normalizeIntentText(text);

    if (/^(en espanol|en castellano|in spanish)$/.test(normalized)) {
      return 'es';
    }

    if (/^(en ingles|in english)$/.test(normalized)) {
      return 'en';
    }

    if (/^(traducelo|translate it)$/.test(normalized)) {
      return snapshot.renderedLanguage === 'es' ? 'en' : 'es';
    }

    return this.resolveConversationLanguage(session, text);
  }

  private resolveActiveTemporalSnapshot(
    session: SessionState
  ): SessionTemporalSnapshot | null {
    const lastToolResult = session.operationalContext?.lastToolResult;
    const lastAssistantMessage = [...session.messages]
      .reverse()
      .find((message) => message.role === 'assistant');

    if (
      lastToolResult?.toolId === 'clock-time.get-current' &&
      lastToolResult.temporalSnapshot &&
      lastAssistantMessage?.content === lastToolResult.renderedText
    ) {
      return lastToolResult.temporalSnapshot;
    }

    if (
      session.operationalContext?.lastRelevantEntity?.kind === 'time' &&
      session.operationalContext.lastTemporalSnapshot &&
      lastAssistantMessage?.content === session.operationalContext.lastToolResult?.renderedText
    ) {
      return session.operationalContext.lastTemporalSnapshot;
    }

    return null;
  }

  private createTemporalSnapshot(
    output: TimeOutput,
    language: SupportedLanguage
  ): SessionTemporalSnapshot {
    return {
      iso: output.iso,
      timeZone: output.timeZone || 'UTC',
      utcOffset: output.utcOffset,
      locale: localeForLanguage(language),
      renderedLanguage: language
    };
  }

  private rememberTemporalSnapshot(
    session: SessionState,
    temporalSnapshot: SessionTemporalSnapshot,
    renderedText: string
  ): void {
    const nextContext: SessionOperationalContext = {
      ...(session.operationalContext ?? {})
    };

    nextContext.lastTemporalSnapshot = temporalSnapshot;

    if (nextContext.lastToolResult?.toolId === 'clock-time.get-current') {
      nextContext.lastToolResult = {
        ...nextContext.lastToolResult,
        renderedText,
        temporalSnapshot
      };
    }

    if (nextContext.lastRelevantEntity?.toolId === 'clock-time.get-current') {
      nextContext.lastRelevantEntity = {
        ...nextContext.lastRelevantEntity,
        kind: 'time',
        title: 'Tiempo actual'
      };
    }

    session.operationalContext = nextContext;
  }

  private renderTemporalSnapshot(
    temporalSnapshot: SessionTemporalSnapshot
  ): string {
    const parts = formatTemporalParts(temporalSnapshot);
    const reference = formatTemporalReference(temporalSnapshot);

    if (temporalSnapshot.renderedLanguage === 'es') {
      return `Son las ${parts.hour}:${parts.minute} del ${parts.weekday}, ${parts.day} de ${parts.month} de ${parts.year} en ${reference}.`;
    }

    return `It is ${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute} in ${reference}.`;
  }

  private renderTemporalVerification(
    temporalSnapshot: SessionTemporalSnapshot,
    requestedWeekdayIndex: number
  ): string {
    const actualWeekdayIndex = getSnapshotWeekdayIndex(temporalSnapshot);
    const parts = formatTemporalParts(temporalSnapshot);
    const reference = formatTemporalReference(temporalSnapshot);
    const matches = actualWeekdayIndex === requestedWeekdayIndex;

    if (temporalSnapshot.renderedLanguage === 'es') {
      return `${
        matches ? 'Si' : 'No'
      }. Manteniendo el mismo dato temporal, es ${parts.weekday}, ${parts.day} de ${parts.month} de ${parts.year} y son las ${parts.hour}:${parts.minute} en ${reference}.`;
    }

    return `${
      matches ? 'Yes' : 'No'
    }. Using the same time snapshot, it is ${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute} in ${reference}.`;
  }

  private renderTemporalReassurance(
    temporalSnapshot: SessionTemporalSnapshot
  ): string {
    if (temporalSnapshot.renderedLanguage === 'es') {
      return `Si. Sigo usando el mismo dato temporal: ${this.renderTemporalSnapshot(
        temporalSnapshot
      )}`;
    }

    return `Yes. I am still using the same time snapshot: ${this.renderTemporalSnapshot(
      temporalSnapshot
    )}`;
  }

  private renderTemporalDispute(
    temporalSnapshot: SessionTemporalSnapshot
  ): string {
    if (temporalSnapshot.renderedLanguage === 'es') {
      return `Estoy revisando el mismo dato temporal que acabo de usar: ${this.renderTemporalSnapshot(
        temporalSnapshot
      )} Si quieres una comprobacion nueva, pideme que vuelva a consultar la hora y la fecha.`;
    }

    return `I am reviewing the same time snapshot I just used: ${this.renderTemporalSnapshot(
      temporalSnapshot
    )} If you want a fresh check, ask me to query the time and date again.`;
  }

  private renderTemporalCorrection(
    temporalSnapshot: SessionTemporalSnapshot,
    correction: { claimedHour?: number; rejectedHour?: number }
  ): string {
    const actualHour = extractSnapshotHour(temporalSnapshot);
    const paddedActualHour = String(actualHour).padStart(2, '0');
    const reference = formatTemporalReference(temporalSnapshot);

    if (temporalSnapshot.renderedLanguage === 'es') {
      if (correction.claimedHour === actualHour) {
        return `Con el mismo snapshot temporal, tu correccion coincide: marca las ${paddedActualHour}:00 en ${reference}.`;
      }

      return `Con el mismo snapshot temporal no cambia el dato: marca las ${paddedActualHour}:00 en ${reference}. Si tu esperabas ${String(
        correction.claimedHour ?? correction.rejectedHour ?? actualHour
      ).padStart(2, '0')}:00, entonces estamos hablando de otra zona horaria o de otra referencia temporal.`;
    }

    if (correction.claimedHour === actualHour) {
      return `Using the same time snapshot, your correction matches it: it shows ${paddedActualHour}:00 in ${reference}.`;
    }

    return `Using the same time snapshot, the value does not change: it shows ${paddedActualHour}:00 in ${reference}. If you expected ${String(
      correction.claimedHour ?? correction.rejectedHour ?? actualHour
    ).padStart(2, '0')}:00, then you are referring to a different time zone or a different temporal reference.`;
  }

  private async handleContextualLocalFollowUp(
    session: SessionState,
    text: string,
    trace: InteractionTrace
  ): Promise<SessionSnapshot | null> {
    if (isFileReadFollowUp(text) || isShowFollowUp(text)) {
      const lastFilePath = this.resolveLastFileReference(session);

      if (lastFilePath) {
        return this.executeOrQueue(
          session,
          'local-files.read-file',
          {
            relativePath: lastFilePath
          },
          trace
        );
      }

      if (isShowFollowUp(text)) {
        const recentResult = session.operationalContext?.lastToolResult;
        if (
          recentResult?.toolId === 'local-files.list-directory' &&
          recentResult.entries &&
          recentResult.absolutePath
        ) {
          trace.providerId = 'tool-only';
          trace.model = 'tool-only';
          trace.result = 'success';
          const snapshot = await this.reply(
            session,
            this.renderDirectoryListing({
              absolutePath: recentResult.absolutePath,
              entries: recentResult.entries
            })
          );
          await this.recordTelemetry(session, trace);
          return snapshot;
        }
      }

      trace.providerId = 'tool-only';
      trace.model = 'tool-only';
      trace.result = 'success';
      const snapshot = await this.reply(
        session,
        isFileReadFollowUp(text)
          ? 'No tengo un archivo reciente del sandbox para leer. Pideme primero un archivo concreto.'
          : 'No tengo un resultado reciente del sandbox para mostrar. Pideme primero leer un archivo o listar el sandbox.'
      );
      await this.recordTelemetry(session, trace);
      return snapshot;
    }

    if (isListFollowUp(text)) {
      const recentResult = session.operationalContext?.lastToolResult;
      if (
        recentResult?.toolId === 'local-files.list-directory' &&
        recentResult.entries &&
        recentResult.absolutePath
      ) {
        trace.providerId = 'tool-only';
        trace.model = 'tool-only';
        trace.result = 'success';
        const snapshot = await this.reply(
          session,
          this.renderDirectoryListing({
            absolutePath: recentResult.absolutePath,
            entries: recentResult.entries
          })
        );
        await this.recordTelemetry(session, trace);
        return snapshot;
      }

      const directoryReference = this.resolveLastDirectoryReference(session);
      if (directoryReference !== null) {
        return this.executeOrQueue(
          session,
          'local-files.list-directory',
          {
            relativePath: directoryReference
          },
          trace
        );
      }

      trace.providerId = 'tool-only';
      trace.model = 'tool-only';
      trace.result = 'success';
      const snapshot = await this.reply(
        session,
        'No tengo un listado reciente del sandbox para mostrar. Pideme primero que liste el sandbox.'
      );
      await this.recordTelemetry(session, trace);
      return snapshot;
    }

    return null;
  }

  private resolveLastFileReference(session: SessionState): string | null {
    const context = session.operationalContext;
    const entity = context?.lastRelevantEntity;

    if (entity?.kind === 'file' && entity.relativePath) {
      return normalizeRelativeReference(entity.relativePath);
    }

    const lastToolResult = context?.lastToolResult;
    if (
      lastToolResult?.toolId === 'local-files.read-file' &&
      lastToolResult.relativePath
    ) {
      return normalizeRelativeReference(lastToolResult.relativePath);
    }

    if (
      lastToolResult?.toolId === 'local-files.create-entry' &&
      context?.lastRelevantEntity?.kind === 'file' &&
      lastToolResult.relativePath
    ) {
      return normalizeRelativeReference(lastToolResult.relativePath);
    }

    return null;
  }

  private resolveLastDirectoryReference(session: SessionState): string | null {
    const context = session.operationalContext;
    const entity = context?.lastRelevantEntity;

    if (entity?.kind === 'directory') {
      return normalizeRelativeReference(entity.relativePath);
    }

    if (entity?.kind === 'file' && entity.relativePath) {
      const parent = path.posix.dirname(normalizeRelativeReference(entity.relativePath));
      return parent === '.' ? '' : parent;
    }

    const lastToolResult = context?.lastToolResult;
    if (
      lastToolResult?.toolId === 'local-files.list-directory' &&
      lastToolResult.relativePath !== undefined
    ) {
      return normalizeRelativeReference(lastToolResult.relativePath);
    }

    return null;
  }

  private renderToolResponse(
    session: SessionState,
    tool: ToolDefinition,
    input: unknown,
    result: ToolExecutionResult
  ): string {
    if (tool.id === 'clock-time.get-current') {
      const language = this.resolveConversationLanguage(session);
      const temporalSnapshot = this.createTemporalSnapshot(
        result.output as TimeOutput,
        language
      );
      return this.renderTemporalSnapshot(temporalSnapshot);
    }

    if (tool.id === 'local-files.list-directory') {
      return this.renderDirectoryListing(result.output as LocalDirectoryListOutput);
    }

    if (tool.id === 'local-files.read-file') {
      return this.renderFileRead(
        normalizeRelativeReference(
          (input as { relativePath?: string } | undefined)?.relativePath
        ),
        result.output as LocalFileReadOutput
      );
    }

    if (tool.id === 'local-files.create-entry') {
      const localInput = input as LocalFileInput;
      return this.renderLocalCreate(localInput, result.output as LocalFileOutput);
    }

    return result.summary;
  }

  private renderDirectoryListing(output: LocalDirectoryListOutput): string {
    if (output.entries.length === 0) {
      return `El directorio ${output.absolutePath} del sandbox esta vacio.`;
    }

    const preview = output.entries.slice(0, LIST_PREVIEW_LIMIT);
    const suffix =
      output.entries.length > LIST_PREVIEW_LIMIT
        ? ` Mostrando los primeros ${LIST_PREVIEW_LIMIT} elemento(s).`
        : '';

    return `He encontrado ${output.entries.length} elemento(s) en ${output.absolutePath}: ${formatListEntries(preview)}.${suffix}`;
  }

  private renderFileRead(
    relativePath: string,
    output: LocalFileReadOutput
  ): string {
    const displayPath = relativePath || path.basename(output.absolutePath);

    if (output.isText === false) {
      return `El archivo "${displayPath}" existe en ${output.absolutePath}, pero no parece un texto legible.`;
    }

    const contents = output.contents.trim().replace(/\r?\n/g, '\\n');
    const preview = shortenText(
      contents.length > 0 ? contents : '[empty file]',
      FILE_CONTENT_PREVIEW_CHARS
    );
    const suffix =
      output.truncated || (contents.length > 0 && preview !== contents)
        ? ` Mostrando una vista parcial de ${output.totalBytes ?? preview.length} byte(s).`
        : '';

    return `Contenido de "${displayPath}" en ${output.absolutePath}:${suffix} ${preview}`;
  }

  private renderLocalCreate(
    input: LocalFileInput,
    output: LocalFileOutput
  ): string {
    const kind = input.kind === 'directory' ? 'carpeta' : 'archivo';
    const article = input.kind === 'directory' ? 'la' : 'el';
    return `He creado ${article} ${kind} "${normalizeRelativeReference(input.relativePath)}" en ${output.absolutePath}.`;
  }

  private updateOperationalContext(
    session: SessionState,
    tool: ToolDefinition,
    input: unknown,
    result: ToolExecutionResult,
    renderedText: string
  ): void {
    const nextContext: SessionOperationalContext = {
      ...(session.operationalContext ?? {})
    };
    const recordedAt = new Date().toISOString();

    if (tool.id === 'clock-time.get-current') {
      const language = this.resolveConversationLanguage(session);
      const temporalSnapshot = this.createTemporalSnapshot(
        result.output as TimeOutput,
        language
      );

      nextContext.lastRelevantEntity = {
        kind: 'time',
        toolId: tool.id,
        title: 'Tiempo actual'
      };
      nextContext.lastToolResult = {
        toolId: tool.id,
        toolLabel: tool.label,
        recordedAt,
        summary: result.summary,
        renderedText,
        temporalSnapshot
      };
      nextContext.lastTemporalSnapshot = temporalSnapshot;
      session.operationalContext = nextContext;
      return;
    }

    if (tool.id === 'local-files.list-directory') {
      const listInput = input as { relativePath?: string };
      const output = result.output as LocalDirectoryListOutput;
      const relativePath = normalizeRelativeReference(listInput.relativePath);

      nextContext.lastRelevantEntity = {
        kind: 'directory',
        relativePath,
        absolutePath: output.absolutePath,
        toolId: tool.id,
        title: relativePath
          ? `Sandbox directory ${relativePath}`
          : 'Sandbox root'
      };
      nextContext.lastToolResult = {
        toolId: tool.id,
        toolLabel: tool.label,
        recordedAt,
        summary: result.summary,
        renderedText,
        relativePath,
        absolutePath: output.absolutePath,
        entries: output.entries
      };
      session.operationalContext = nextContext;
      return;
    }

    if (tool.id === 'local-files.read-file') {
      const readInput = input as { relativePath: string };
      const output = result.output as LocalFileReadOutput;
      const relativePath = normalizeRelativeReference(readInput.relativePath);

      nextContext.lastRelevantEntity = {
        kind: 'file',
        relativePath,
        absolutePath: output.absolutePath,
        toolId: tool.id,
        title: `Sandbox file ${relativePath}`
      };
      nextContext.lastToolResult = {
        toolId: tool.id,
        toolLabel: tool.label,
        recordedAt,
        summary: result.summary,
        renderedText,
        relativePath,
        absolutePath: output.absolutePath,
        fileContents: output.contents,
        truncated: output.truncated
      };
      session.operationalContext = nextContext;
      return;
    }

    if (tool.id === 'local-files.create-entry') {
      const localInput = input as LocalFileInput;
      const output = result.output as LocalFileOutput;
      const relativePath = normalizeRelativeReference(localInput.relativePath);

      nextContext.lastRelevantEntity = {
        kind: localInput.kind,
        relativePath,
        absolutePath: output.absolutePath,
        toolId: tool.id,
        title: `${describeEntryKind(localInput.kind)} ${relativePath}`
      };
      nextContext.lastToolResult = {
        toolId: tool.id,
        toolLabel: tool.label,
        recordedAt,
        summary: result.summary,
        renderedText,
        relativePath,
        absolutePath: output.absolutePath
      };
      session.operationalContext = nextContext;
    }
  }

  private async recordTelemetry(
    session: SessionState,
    trace: InteractionTrace
  ): Promise<void> {
    const duration = Date.now() - trace.startedAt;
    const record: TelemetryRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: session.sessionId,
      providerId: trace.providerId,
      model: trace.model,
      privacyMode: session.activeMode.privacy,
      runtimeMode: session.activeMode.runtime,
      totalDurationMs: duration,
      providerLatencyMs: trace.usage?.latencyMs,
      tokens: trace.usage?.tokens,
      estimatedCostUsd: trace.usage?.estimatedCostUsd,
      toolsUsed: trace.toolsUsed,
      confirmationRequired: trace.confirmationRequired,
      result: trace.result ?? 'success',
      errorMessage: trace.errorMessage,
      toolCount: trace.toolsUsed.length,
      messagePreview: trace.messagePreview,
      fallbackUsed: trace.fallbackUsed,
      fallbackReason: trace.fallbackReason
    };

    await this.deps.telemetry.record(record);
  }

  private async requireSession(sessionId: string): Promise<SessionState> {
    const session = await this.deps.sessionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    return session;
  }
}
