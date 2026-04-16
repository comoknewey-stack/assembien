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
  'ASSEM_WHISPER_CPP_CLI_PATH',
  'ASSEM_WHISPER_CPP_MODEL_PATH',
  'ASSEM_WHISPER_CPP_THREADS',
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
        'ASSEM_OLLAMA_MODEL=llama3.2'
      ].join('\n'),
      'utf8'
    );

    clearTrackedEnv();
    process.chdir(workspace);

    try {
      const config = createAssemConfig();

      expect(config.defaultProviderId).toBe('ollama');
      expect(config.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
      expect(config.ollamaModel).toBe('llama3.2');
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
    process.env.ASSEM_WHISPER_CPP_CLI_PATH = './bin/whisper-cli.exe';
    process.env.ASSEM_WHISPER_CPP_MODEL_PATH = './models/ggml-base.bin';
    process.env.ASSEM_WHISPER_CPP_THREADS = '6';

    const config = createAssemConfig();

    expect(config.voiceSttProviderId).toBe('whisper-cpp');
    expect(config.voiceTtsProviderId).toBe('windows-system-tts');
    expect(config.voiceLanguage).toBe('en-US');
    expect(config.voiceAutoReadResponses).toBe(true);
    expect(config.voiceDebugArtifacts).toBe(true);
    expect(config.whisperCppCliPath).toMatch(/bin[\\/]+whisper-cli\.exe$/);
    expect(config.whisperCppModelPath).toMatch(/models[\\/]+ggml-base\.bin$/);
    expect(config.whisperCppThreads).toBe(6);
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
});
