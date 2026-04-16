import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AssemConfig } from '@assem/shared-types';

import { resolveWhisperRuntimePaths } from './whisper-runtime';

const DEFAULT_AGENT_PORT = 4318;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const DEFAULT_VOICE_STT_PROVIDER = 'whisper-cpp';
const DEFAULT_VOICE_TTS_PROVIDER = 'windows-system-tts';
const DEFAULT_VOICE_LANGUAGE = 'es-ES';
const DEFAULT_VOICE_AUTO_READ_RESPONSES = false;
const DEFAULT_VOICE_DEBUG_ARTIFACTS = false;
const DEFAULT_WHISPER_CPP_THREADS = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2) || 2));
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return /^(1|true|yes|on)$/i.test(value.trim());
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
      Number.parseInt(
        process.env.ASSEM_WHISPER_CPP_THREADS ?? `${DEFAULT_WHISPER_CPP_THREADS}`,
        10
      ),
    allowedOrigins:
      overrides.allowedOrigins ??
      parseAllowedOrigins(process.env.ASSEM_ALLOWED_ORIGINS)
  };
}

export * from './whisper-runtime';
