import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAssemConfig } from './index';

const trackedKeys = [
  'ASSEM_DEFAULT_PROVIDER',
  'ASSEM_OLLAMA_BASE_URL',
  'ASSEM_OLLAMA_MODEL',
  'ASSEM_VOICE_STT_PROVIDER',
  'ASSEM_VOICE_TTS_PROVIDER',
  'ASSEM_VOICE_LANGUAGE',
  'ASSEM_VOICE_AUTO_READ_RESPONSES',
  'ASSEM_VOICE_DEBUG',
  'ASSEM_VOICE_MODE_ENABLED_BY_DEFAULT',
  'ASSEM_WAKE_WORD_ENABLED',
  'ASSEM_WAKE_WORD',
  'ASSEM_WAKE_WORD_ALIASES',
  'ASSEM_WAKE_WINDOW_MS',
  'ASSEM_WAKE_INTERVAL_MS',
  'ASSEM_ACTIVE_SILENCE_MS',
  'ASSEM_ACTIVE_MAX_MS',
  'ASSEM_ACTIVE_MIN_SPEECH_MS',
  'ASSEM_ACTIVE_PREROLL_MS',
  'ASSEM_ACTIVE_POSTROLL_MS',
  'ASSEM_WAKE_DEBUG',
  'ASSEM_WHISPER_CPP_CLI_PATH',
  'ASSEM_WHISPER_CPP_MODEL_PATH',
  'ASSEM_WHISPER_CPP_THREADS',
  'ASSEM_WHISPER_CPP_BEAM_SIZE',
  'ASSEM_WHISPER_CPP_INITIAL_PROMPT',
  'ASSEM_WEB_SEARCH_PROVIDER',
  'ASSEM_WEB_SEARCH_API_KEY',
  'ASSEM_WEB_SEARCH_ENDPOINT',
  'ASSEM_WEB_SEARCH_MAX_RESULTS',
  'ASSEM_WEB_SEARCH_TIMEOUT_MS',
  'ASSEM_WEB_PAGE_FETCH_ENABLED',
  'ASSEM_WEB_PAGE_FETCH_TIMEOUT_MS',
  'ASSEM_WEB_PAGE_MAX_SOURCES',
  'ASSEM_WEB_PAGE_MAX_CONTENT_CHARS',
  'ASSEM_WEB_PAGE_MIN_TEXT_CHARS',
  'ASSEM_WEB_PAGE_MIN_TEXT_DENSITY',
  'ASSEM_WEB_PAGE_MAX_LINK_DENSITY',
  'ASSEM_ALLOWED_ORIGINS'
] as const;

function clearTrackedEnv(): void {
  for (const key of trackedKeys) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearTrackedEnv();
});

describe('createAssemConfig', () => {
  it('loads ASSEM settings from a repository .env file when running from a nested workspace', async () => {
    const originalCwd = process.cwd();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-config-'));
    const workspace = path.join(root, 'apps', 'local-agent');

    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(root, '.env'),
      [
        'ASSEM_DEFAULT_PROVIDER=ollama',
        'ASSEM_OLLAMA_BASE_URL=http://127.0.0.1:11434',
        'ASSEM_OLLAMA_MODEL=llama3.2:latest'
      ].join('\n'),
      'utf8'
    );

    clearTrackedEnv();
    process.chdir(workspace);

    try {
      const config = createAssemConfig();

      expect(config.defaultProviderId).toBe('ollama');
      expect(config.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
      expect(config.ollamaModel).toBe('llama3.2:latest');
    } finally {
      process.chdir(originalCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to the stable Ollama default model tag when no env override exists', async () => {
    const originalCwd = process.cwd();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-config-defaults-'));

    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'assem',
          workspaces: ['apps/*', 'packages/*']
        },
        null,
        2
      ),
      'utf8'
    );

    clearTrackedEnv();
    process.chdir(root);

    try {
      const config = createAssemConfig();
      expect(config.ollamaModel).toBe('llama3.2:latest');
    } finally {
      process.chdir(originalCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('includes the Tauri localhost origins by default', () => {
    clearTrackedEnv();

    const config = createAssemConfig();

    expect(config.allowedOrigins).toContain('http://tauri.localhost');
    expect(config.allowedOrigins).toContain('https://tauri.localhost');
    expect(config.allowedOrigins).toContain('tauri://localhost');
  });

  it('loads voice defaults and boolean settings from the environment', () => {
    clearTrackedEnv();
    process.env.ASSEM_VOICE_STT_PROVIDER = 'whisper-cpp';
    process.env.ASSEM_VOICE_TTS_PROVIDER = 'windows-system-tts';
    process.env.ASSEM_VOICE_LANGUAGE = 'en-US';
    process.env.ASSEM_VOICE_AUTO_READ_RESPONSES = 'true';
    process.env.ASSEM_VOICE_DEBUG = 'true';
    process.env.ASSEM_VOICE_MODE_ENABLED_BY_DEFAULT = 'true';
    process.env.ASSEM_WAKE_WORD_ENABLED = 'true';
    process.env.ASSEM_WAKE_WORD = 'prolijo';
    process.env.ASSEM_WAKE_WORD_ALIASES = 'pro lijo, polijo, pro li jo';
    process.env.ASSEM_WAKE_WINDOW_MS = '2200';
    process.env.ASSEM_WAKE_INTERVAL_MS = '350';
    process.env.ASSEM_ACTIVE_SILENCE_MS = '900';
    process.env.ASSEM_ACTIVE_MAX_MS = '15000';
    process.env.ASSEM_ACTIVE_MIN_SPEECH_MS = '450';
    process.env.ASSEM_ACTIVE_PREROLL_MS = '700';
    process.env.ASSEM_ACTIVE_POSTROLL_MS = '550';
    process.env.ASSEM_WAKE_DEBUG = 'true';
    process.env.ASSEM_WHISPER_CPP_CLI_PATH = './bin/whisper-cli.exe';
    process.env.ASSEM_WHISPER_CPP_MODEL_PATH = './models/ggml-base.bin';
    process.env.ASSEM_WHISPER_CPP_THREADS = '6';
    process.env.ASSEM_WHISPER_CPP_BEAM_SIZE = '7';
    process.env.ASSEM_WHISPER_CPP_INITIAL_PROMPT = 'ASSEM hora actual sandbox';

    const config = createAssemConfig();

    expect(config.voiceSttProviderId).toBe('whisper-cpp');
    expect(config.voiceTtsProviderId).toBe('windows-system-tts');
    expect(config.voiceLanguage).toBe('en-US');
    expect(config.voiceAutoReadResponses).toBe(true);
    expect(config.voiceDebugArtifacts).toBe(true);
    expect(config.voiceModeEnabledByDefault).toBe(true);
    expect(config.wakeWordEnabled).toBe(true);
    expect(config.wakeWord).toBe('prolijo');
    expect(config.wakeWordAliases).toEqual(['pro lijo', 'polijo', 'pro li jo']);
    expect(config.wakeWindowMs).toBe(2200);
    expect(config.wakeIntervalMs).toBe(350);
    expect(config.activeSilenceMs).toBe(900);
    expect(config.activeMaxMs).toBe(15000);
    expect(config.activeMinSpeechMs).toBe(450);
    expect(config.activePrerollMs).toBe(700);
    expect(config.activePostrollMs).toBe(550);
    expect(config.wakeDebug).toBe(true);
    expect(config.whisperCppCliPath).toMatch(/bin[\\/]+whisper-cli\.exe$/);
    expect(config.whisperCppModelPath).toMatch(/models[\\/]+ggml-base\.bin$/);
    expect(config.whisperCppThreads).toBe(6);
    expect(config.whisperCppBeamSize).toBe(7);
    expect(config.whisperCppInitialPrompt).toBe('ASSEM hora actual sandbox');
  });

  it('falls back to the standard local whisper runtime paths when env paths are empty', () => {
    clearTrackedEnv();

    const config = createAssemConfig();

    expect(config.whisperCppCliPath).toMatch(
      /\.assem-runtime[\\/]whispercpp[\\/]bin[\\/]Release[\\/]whisper-cli\.exe$/
    );
    expect(config.whisperCppModelPath).toMatch(
      /\.assem-runtime[\\/]whispercpp[\\/]models[\\/]ggml-base\.bin$/
    );
  });

  it('loads web search config and clamps max results to the absolute cap', () => {
    clearTrackedEnv();
    process.env.ASSEM_WEB_SEARCH_PROVIDER = 'brave';
    process.env.ASSEM_WEB_SEARCH_API_KEY = 'test-key';
    process.env.ASSEM_WEB_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
    process.env.ASSEM_WEB_SEARCH_MAX_RESULTS = '99';
    process.env.ASSEM_WEB_SEARCH_TIMEOUT_MS = '12000';
    process.env.ASSEM_WEB_PAGE_FETCH_ENABLED = 'true';
    process.env.ASSEM_WEB_PAGE_FETCH_TIMEOUT_MS = '13000';
    process.env.ASSEM_WEB_PAGE_MAX_SOURCES = '99';
    process.env.ASSEM_WEB_PAGE_MAX_CONTENT_CHARS = '999999';
    process.env.ASSEM_WEB_PAGE_MIN_TEXT_CHARS = '320';
    process.env.ASSEM_WEB_PAGE_MIN_TEXT_DENSITY = '0.27';
    process.env.ASSEM_WEB_PAGE_MAX_LINK_DENSITY = '0.48';

    const config = createAssemConfig();

    expect(config.webSearchProvider).toBe('brave');
    expect(config.webSearchApiKey).toBe('test-key');
    expect(config.webSearchEndpoint).toBe(
      'https://api.search.brave.com/res/v1/web/search'
    );
    expect(config.webSearchMaxResults).toBe(10);
    expect(config.webSearchTimeoutMs).toBe(12000);
    expect(config.webPageFetchEnabled).toBe(true);
    expect(config.webPageFetchTimeoutMs).toBe(13000);
    expect(config.webPageMaxSources).toBe(5);
    expect(config.webPageMaxContentChars).toBe(50000);
    expect(config.webPageMinTextChars).toBe(320);
    expect(config.webPageMinTextDensity).toBe(0.27);
    expect(config.webPageMaxLinkDensity).toBe(0.48);
  });
});
