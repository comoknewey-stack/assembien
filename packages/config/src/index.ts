import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AssemConfig } from '@assem/shared-types';

import { resolveWhisperRuntimePaths } from './whisper-runtime';

const DEFAULT_AGENT_PORT = 4318;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2:latest';
const DEFAULT_VOICE_STT_PROVIDER = 'whisper-cpp';
const DEFAULT_VOICE_TTS_PROVIDER = 'windows-system-tts';
const DEFAULT_VOICE_LANGUAGE = 'es-ES';
const DEFAULT_VOICE_AUTO_READ_RESPONSES = false;
const DEFAULT_VOICE_DEBUG_ARTIFACTS = false;
const DEFAULT_VOICE_MODE_ENABLED_BY_DEFAULT = false;
const DEFAULT_WAKE_WORD_ENABLED = false;
const DEFAULT_WAKE_WORD = 'prolijo';
const DEFAULT_WAKE_WORD_ALIASES = ['pro lijo', 'polijo', 'prolijos', 'pro li jo'];
const DEFAULT_WAKE_WINDOW_MS = 2_500;
const DEFAULT_WAKE_INTERVAL_MS = 500;
const DEFAULT_ACTIVE_SILENCE_MS = 2_000;
const DEFAULT_ACTIVE_MAX_MS = 30_000;
const DEFAULT_ACTIVE_MIN_SPEECH_MS = 800;
const DEFAULT_ACTIVE_PREROLL_MS = 700;
const DEFAULT_ACTIVE_POSTROLL_MS = 500;
const DEFAULT_WAKE_DEBUG = false;
const DEFAULT_WHISPER_CPP_THREADS = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2) || 2));
const DEFAULT_WHISPER_CPP_BEAM_SIZE = 5;
const DEFAULT_WHISPER_CPP_INITIAL_PROMPT =
  'ASSEM. Comandos frecuentes en espanol: que hora es, hora actual, fecha actual, crear archivo, crear carpeta, lista el sandbox, lee el archivo, confirma, cancela, Ollama, whisper.cpp.';
const DEFAULT_WEB_SEARCH_PROVIDER = '';
const DEFAULT_WEB_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
const MAX_WEB_SEARCH_RESULTS = 10;
const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_WEB_PAGE_FETCH_ENABLED = true;
const DEFAULT_WEB_PAGE_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_WEB_PAGE_MAX_SOURCES = 3;
const MAX_WEB_PAGE_SOURCES = 5;
const DEFAULT_WEB_PAGE_MAX_CONTENT_CHARS = 20_000;
const MAX_WEB_PAGE_CONTENT_CHARS = 50_000;
const DEFAULT_WEB_PAGE_MIN_TEXT_CHARS = 220;
const DEFAULT_WEB_PAGE_MIN_TEXT_DENSITY = 0.18;
const DEFAULT_WEB_PAGE_MAX_LINK_DENSITY = 0.55;
const DEFAULT_BROWSER_AUTOMATION_ENABLED = true;
const DEFAULT_BROWSER_MAX_PAGES_PER_TASK = 3;
const MAX_BROWSER_MAX_PAGES_PER_TASK = 5;
const DEFAULT_BROWSER_MAX_LINKS_PER_PAGE = 20;
const MAX_BROWSER_MAX_LINKS_PER_PAGE = 40;
const DEFAULT_BROWSER_TEXT_MAX_CHARS = 12_000;
const MAX_BROWSER_TEXT_MAX_CHARS = 50_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 15_000;
const DEFAULT_BROWSER_ALLOW_SCREENSHOTS = false;
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost'
];
const loadedEnvDirectories = new Set<string>();

function parseEnvValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n');
  }

  return trimmed;
}

function resolveEnvCandidates(cwd: string): string[] {
  const candidates: string[] = [];
  let current = path.resolve(cwd);

  for (let depth = 0; depth < 4; depth += 1) {
    candidates.unshift(path.join(current, '.env'));

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return [...new Set(candidates)];
}

function loadWorkspaceEnvFiles(cwd = process.cwd()): void {
  const normalizedCwd = path.resolve(cwd);
  if (loadedEnvDirectories.has(normalizedCwd)) {
    return;
  }

  const inheritedKeys = new Set(Object.keys(process.env));
  const fileValues = new Map<string, string>();

  for (const candidate of resolveEnvCandidates(normalizedCwd)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const raw = fs.readFileSync(candidate, 'utf8');
    for (const line of raw.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }

      fileValues.set(match[1], parseEnvValue(match[2]));
    }
  }

  for (const [key, value] of fileValues) {
    if (!inheritedKeys.has(key)) {
      process.env[key] = value;
    }
  }

  loadedEnvDirectories.add(normalizedCwd);
}

function parseAllowedOrigins(value?: string): string[] {
  if (!value) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

export function createAssemConfig(
  overrides: Partial<AssemConfig> = {}
): AssemConfig {
  loadWorkspaceEnvFiles();
  const whisperRuntimePaths = resolveWhisperRuntimePaths({
    cwd: process.cwd()
  });

  return {
    appName: overrides.appName ?? 'ASSEM',
    agentPort:
      overrides.agentPort ??
      Number.parseInt(process.env.ASSEM_AGENT_PORT ?? `${DEFAULT_AGENT_PORT}`, 10),
    sandboxRoot:
      overrides.sandboxRoot ??
      resolveOptionalPath(process.env.ASSEM_SANDBOX_ROOT) ??
      path.resolve(process.cwd(), 'sandbox'),
    dataRoot:
      overrides.dataRoot ??
      resolveOptionalPath(process.env.ASSEM_DATA_ROOT) ??
      path.resolve(process.cwd(), '.assem-data'),
    defaultProviderId:
      overrides.defaultProviderId ??
      process.env.ASSEM_DEFAULT_PROVIDER ??
      'ollama',
    providerTimeoutMs:
      overrides.providerTimeoutMs ??
      Number.parseInt(
        process.env.ASSEM_PROVIDER_TIMEOUT_MS ?? `${DEFAULT_PROVIDER_TIMEOUT_MS}`,
        10
      ),
    ollamaBaseUrl:
      overrides.ollamaBaseUrl ??
      process.env.ASSEM_OLLAMA_BASE_URL ??
      DEFAULT_OLLAMA_BASE_URL,
    ollamaModel:
      overrides.ollamaModel ??
      process.env.ASSEM_OLLAMA_MODEL ??
      DEFAULT_OLLAMA_MODEL,
    voiceSttProviderId:
      overrides.voiceSttProviderId ??
      process.env.ASSEM_VOICE_STT_PROVIDER ??
      DEFAULT_VOICE_STT_PROVIDER,
    voiceTtsProviderId:
      overrides.voiceTtsProviderId ??
      process.env.ASSEM_VOICE_TTS_PROVIDER ??
      DEFAULT_VOICE_TTS_PROVIDER,
    voiceLanguage:
      overrides.voiceLanguage ??
      process.env.ASSEM_VOICE_LANGUAGE ??
      DEFAULT_VOICE_LANGUAGE,
    voiceAutoReadResponses:
      overrides.voiceAutoReadResponses ??
      parseBoolean(
        process.env.ASSEM_VOICE_AUTO_READ_RESPONSES,
        DEFAULT_VOICE_AUTO_READ_RESPONSES
      ),
    voiceDebugArtifacts:
      overrides.voiceDebugArtifacts ??
      parseBoolean(process.env.ASSEM_VOICE_DEBUG, DEFAULT_VOICE_DEBUG_ARTIFACTS),
    voiceModeEnabledByDefault:
      overrides.voiceModeEnabledByDefault ??
      parseBoolean(
        process.env.ASSEM_VOICE_MODE_ENABLED_BY_DEFAULT,
        DEFAULT_VOICE_MODE_ENABLED_BY_DEFAULT
      ),
    wakeWordEnabled:
      overrides.wakeWordEnabled ??
      parseBoolean(process.env.ASSEM_WAKE_WORD_ENABLED, DEFAULT_WAKE_WORD_ENABLED),
    wakeWord:
      overrides.wakeWord ??
      process.env.ASSEM_WAKE_WORD ??
      DEFAULT_WAKE_WORD,
    wakeWordAliases:
      overrides.wakeWordAliases ??
      parseStringList(process.env.ASSEM_WAKE_WORD_ALIASES, DEFAULT_WAKE_WORD_ALIASES),
    wakeWindowMs:
      overrides.wakeWindowMs ??
      parsePositiveInteger(process.env.ASSEM_WAKE_WINDOW_MS, DEFAULT_WAKE_WINDOW_MS),
    wakeIntervalMs:
      overrides.wakeIntervalMs ??
      parsePositiveInteger(process.env.ASSEM_WAKE_INTERVAL_MS, DEFAULT_WAKE_INTERVAL_MS),
    activeSilenceMs:
      overrides.activeSilenceMs ??
      parsePositiveInteger(process.env.ASSEM_ACTIVE_SILENCE_MS, DEFAULT_ACTIVE_SILENCE_MS),
    activeMaxMs:
      overrides.activeMaxMs ??
      parsePositiveInteger(process.env.ASSEM_ACTIVE_MAX_MS, DEFAULT_ACTIVE_MAX_MS),
    activeMinSpeechMs:
      overrides.activeMinSpeechMs ??
      parsePositiveInteger(
        process.env.ASSEM_ACTIVE_MIN_SPEECH_MS,
        DEFAULT_ACTIVE_MIN_SPEECH_MS
      ),
    activePrerollMs:
      overrides.activePrerollMs ??
      parsePositiveInteger(
        process.env.ASSEM_ACTIVE_PREROLL_MS,
        DEFAULT_ACTIVE_PREROLL_MS
      ),
    activePostrollMs:
      overrides.activePostrollMs ??
      parsePositiveInteger(
        process.env.ASSEM_ACTIVE_POSTROLL_MS,
        DEFAULT_ACTIVE_POSTROLL_MS
      ),
    wakeDebug:
      overrides.wakeDebug ??
      parseBoolean(process.env.ASSEM_WAKE_DEBUG, DEFAULT_WAKE_DEBUG),
    whisperCppCliPath:
      overrides.whisperCppCliPath ??
      resolveOptionalPath(process.env.ASSEM_WHISPER_CPP_CLI_PATH) ??
      whisperRuntimePaths.cliPath,
    whisperCppModelPath:
      overrides.whisperCppModelPath ??
      resolveOptionalPath(process.env.ASSEM_WHISPER_CPP_MODEL_PATH) ??
      whisperRuntimePaths.modelPath,
    whisperCppThreads:
      overrides.whisperCppThreads ??
      parsePositiveInteger(
        process.env.ASSEM_WHISPER_CPP_THREADS,
        DEFAULT_WHISPER_CPP_THREADS
      ),
    whisperCppInitialPrompt:
      overrides.whisperCppInitialPrompt ??
      process.env.ASSEM_WHISPER_CPP_INITIAL_PROMPT ??
      DEFAULT_WHISPER_CPP_INITIAL_PROMPT,
    whisperCppBeamSize:
      overrides.whisperCppBeamSize ??
      parsePositiveInteger(
        process.env.ASSEM_WHISPER_CPP_BEAM_SIZE,
        DEFAULT_WHISPER_CPP_BEAM_SIZE
      ),
    webSearchProvider:
      overrides.webSearchProvider ??
      process.env.ASSEM_WEB_SEARCH_PROVIDER ??
      DEFAULT_WEB_SEARCH_PROVIDER,
    webSearchApiKey:
      overrides.webSearchApiKey ??
      (process.env.ASSEM_WEB_SEARCH_API_KEY?.trim() || undefined),
    webSearchEndpoint:
      overrides.webSearchEndpoint ??
      (process.env.ASSEM_WEB_SEARCH_ENDPOINT?.trim() ||
        DEFAULT_WEB_SEARCH_ENDPOINT),
    webSearchMaxResults:
      clampInteger(
        overrides.webSearchMaxResults ??
          parsePositiveInteger(
            process.env.ASSEM_WEB_SEARCH_MAX_RESULTS,
            DEFAULT_WEB_SEARCH_MAX_RESULTS
          ),
        1,
        MAX_WEB_SEARCH_RESULTS
      ),
    webSearchTimeoutMs:
      overrides.webSearchTimeoutMs ??
      parsePositiveInteger(
        process.env.ASSEM_WEB_SEARCH_TIMEOUT_MS,
        DEFAULT_WEB_SEARCH_TIMEOUT_MS
      ),
    webPageFetchEnabled:
      overrides.webPageFetchEnabled ??
      parseBoolean(
        process.env.ASSEM_WEB_PAGE_FETCH_ENABLED,
        DEFAULT_WEB_PAGE_FETCH_ENABLED
      ),
    webPageFetchTimeoutMs:
      overrides.webPageFetchTimeoutMs ??
      parsePositiveInteger(
        process.env.ASSEM_WEB_PAGE_FETCH_TIMEOUT_MS,
        DEFAULT_WEB_PAGE_FETCH_TIMEOUT_MS
      ),
    webPageMaxSources:
      clampInteger(
        overrides.webPageMaxSources ??
          parsePositiveInteger(
            process.env.ASSEM_WEB_PAGE_MAX_SOURCES,
            DEFAULT_WEB_PAGE_MAX_SOURCES
          ),
        0,
        MAX_WEB_PAGE_SOURCES
      ),
    webPageMaxContentChars:
      clampInteger(
        overrides.webPageMaxContentChars ??
          parsePositiveInteger(
            process.env.ASSEM_WEB_PAGE_MAX_CONTENT_CHARS,
            DEFAULT_WEB_PAGE_MAX_CONTENT_CHARS
          ),
        1_000,
        MAX_WEB_PAGE_CONTENT_CHARS
      ),
    webPageMinTextChars:
      overrides.webPageMinTextChars ??
      clampInteger(
        parsePositiveInteger(
          process.env.ASSEM_WEB_PAGE_MIN_TEXT_CHARS,
          DEFAULT_WEB_PAGE_MIN_TEXT_CHARS
        ),
        80,
        5_000
      ),
    webPageMinTextDensity:
      overrides.webPageMinTextDensity ??
      Math.max(
        0.05,
        Math.min(
          1,
          parsePositiveFloat(
            process.env.ASSEM_WEB_PAGE_MIN_TEXT_DENSITY,
            DEFAULT_WEB_PAGE_MIN_TEXT_DENSITY
          )
        )
      ),
    webPageMaxLinkDensity:
      overrides.webPageMaxLinkDensity ??
      Math.max(
        0.05,
        Math.min(
          1,
          parsePositiveFloat(
            process.env.ASSEM_WEB_PAGE_MAX_LINK_DENSITY,
            DEFAULT_WEB_PAGE_MAX_LINK_DENSITY
          )
        )
      ),
    browserAutomationEnabled:
      overrides.browserAutomationEnabled ??
      parseBoolean(
        process.env.ASSEM_BROWSER_AUTOMATION_ENABLED,
        DEFAULT_BROWSER_AUTOMATION_ENABLED
      ),
    browserMaxPagesPerTask:
      clampInteger(
        overrides.browserMaxPagesPerTask ??
          parsePositiveInteger(
            process.env.ASSEM_BROWSER_MAX_PAGES_PER_TASK,
            DEFAULT_BROWSER_MAX_PAGES_PER_TASK
          ),
        1,
        MAX_BROWSER_MAX_PAGES_PER_TASK
      ),
    browserMaxLinksPerPage:
      clampInteger(
        overrides.browserMaxLinksPerPage ??
          parsePositiveInteger(
            process.env.ASSEM_BROWSER_MAX_LINKS_PER_PAGE,
            DEFAULT_BROWSER_MAX_LINKS_PER_PAGE
          ),
        1,
        MAX_BROWSER_MAX_LINKS_PER_PAGE
      ),
    browserTextMaxChars:
      clampInteger(
        overrides.browserTextMaxChars ??
          parsePositiveInteger(
            process.env.ASSEM_BROWSER_TEXT_MAX_CHARS,
            DEFAULT_BROWSER_TEXT_MAX_CHARS
          ),
        1_000,
        MAX_BROWSER_TEXT_MAX_CHARS
      ),
    browserTimeoutMs:
      overrides.browserTimeoutMs ??
      parsePositiveInteger(
        process.env.ASSEM_BROWSER_TIMEOUT_MS,
        DEFAULT_BROWSER_TIMEOUT_MS
      ),
    browserAllowScreenshots:
      overrides.browserAllowScreenshots ??
      parseBoolean(
        process.env.ASSEM_BROWSER_ALLOW_SCREENSHOTS,
        DEFAULT_BROWSER_ALLOW_SCREENSHOTS
      ),
    allowedOrigins:
      overrides.allowedOrigins ??
      parseAllowedOrigins(process.env.ASSEM_ALLOWED_ORIGINS)
  };
}

export * from './whisper-runtime';
