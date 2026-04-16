import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SpeechToTextAudioInput } from '@assem/shared-types';

import {
  WhisperCppSpeechToTextProvider,
  whisperCppProviderInternals
} from './whispercpp-provider';

const cleanupPaths: string[] = [];

const activeSettings = {
  sttProviderId: 'whisper-cpp',
  ttsProviderId: 'windows-system-tts',
  preferredLanguage: 'es-ES',
  autoReadResponses: false
} as const;

interface FakeWhisperCliOptions {
  jsonPayload?: unknown;
  captureArgs?: boolean;
  skipJsonOutput?: boolean;
}

function createTestWavBuffer(durationMs = 900, amplitude = 0.45): Buffer {
  const sampleRate = 16_000;
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1_000));
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = Math.sin((index / sampleRate) * Math.PI * 2 * 220) * amplitude;
  }

  const bytesPerSample = 2;
  const buffer = Buffer.alloc(44 + sampleCount * bytesPerSample);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + sampleCount * bytesPerSample, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(sampleCount * bytesPerSample, 40);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, offset);
    offset += 2;
  }

  return buffer;
}

function createAudioInput(
  wav: Buffer,
  overrides: Partial<SpeechToTextAudioInput> = {}
): SpeechToTextAudioInput {
  return {
    mimeType: 'audio/wav',
    fileName: 'assem-recording.wav',
    base64Data: wav.toString('base64'),
    durationMs: overrides.durationMs ?? 900,
    diagnostics: {
      byteLength: wav.length,
      sampleRateHz: 16_000,
      channelCount: 1,
      bitDepth: 16,
      approximateDurationMs: overrides.durationMs ?? 900,
      peakLevel: 0.45,
      rmsLevel: 0.21,
      wavValid: true,
      silenceDetected: false,
      suspicious: false
    },
    ...overrides
  };
}

async function createFakeWhisperCli(
  root: string,
  options: FakeWhisperCliOptions = {}
): Promise<{ cliPath: string; argsPath: string }> {
  const runnerPath = path.join(root, 'fake-whisper-runner.cjs');
  const argsPath = path.join(root, 'fake-whisper-args.json');
  const jsonLiteral =
    options.jsonPayload === undefined ? 'undefined' : JSON.stringify(options.jsonPayload);

  await fs.writeFile(
    runnerPath,
    `
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const argsPath = ${JSON.stringify(argsPath)};
const jsonPayload = ${jsonLiteral};
const captureArgs = ${options.captureArgs ? 'true' : 'false'};
const skipJsonOutput = ${options.skipJsonOutput ? 'true' : 'false'};

if (captureArgs) {
  fs.writeFileSync(argsPath, JSON.stringify(args, null, 2), 'utf8');
}

if (args.includes('--help')) {
  process.stdout.write('fake whisper help');
  process.exit(0);
}

const outputIndex = args.indexOf('--output-file');
if (outputIndex < 0) {
  process.stderr.write('Missing --output-file');
  process.exit(1);
}

if (!skipJsonOutput) {
  const outputPrefix = args[outputIndex + 1];
  fs.mkdirSync(path.dirname(outputPrefix), { recursive: true });
  fs.writeFileSync(
    \`\${outputPrefix}.json\`,
    JSON.stringify(jsonPayload ?? { text: 'hola mundo' }),
    'utf8'
  );
}

process.exit(0);
`,
    'utf8'
  );

  if (process.platform === 'win32') {
    const commandPath = path.join(root, 'fake-whisper.cmd');
    await fs.writeFile(
      commandPath,
      `@echo off\r\n"${process.execPath}" "${runnerPath}" %*\r\n`,
      'utf8'
    );
    return {
      cliPath: commandPath,
      argsPath
    };
  }

  const commandPath = path.join(root, 'fake-whisper');
  await fs.writeFile(
    commandPath,
    `#!/usr/bin/env sh\n"${process.execPath}" "${runnerPath}" "$@"\n`,
    'utf8'
  );
  await fs.chmod(commandPath, 0o755);
  return {
    cliPath: commandPath,
    argsPath
  };
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    await fs.rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe('WhisperCppSpeechToTextProvider', () => {
  it('reports a clear unavailable health state when whisper.cpp is not configured', async () => {
    const provider = new WhisperCppSpeechToTextProvider({
      threads: 4
    });

    expect(provider.isConfigured()).toBe(false);

    const health = await provider.healthCheck(activeSettings);

    expect(health.status).toBe('unavailable');
    expect(health.configured).toBe(false);
    expect(health.available).toBe(false);
    expect(health.error).toContain('voice:bootstrap');
  });

  it('distinguishes a missing binary from a missing model', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-missing-'));
    cleanupPaths.push(root);
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const missingBinaryProvider = new WhisperCppSpeechToTextProvider({
      cliPath: path.join(root, 'bin', 'Release', 'whisper-cli.exe'),
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const missingBinaryHealth = await missingBinaryProvider.healthCheck(activeSettings);

    expect(missingBinaryHealth.status).toBe('degraded');
    expect(missingBinaryHealth.available).toBe(false);
    expect(missingBinaryHealth.error).toContain('Falta el binario');

    const { cliPath } = await createFakeWhisperCli(root);
    const missingModelProvider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath: path.join(root, 'models', 'ggml-small.bin'),
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const missingModelHealth = await missingModelProvider.healthCheck(activeSettings);

    expect(missingModelHealth.status).toBe('degraded');
    expect(missingModelHealth.available).toBe(false);
    expect(missingModelHealth.error).toContain('Falta el modelo');
  });

  it('runs a real self-check when cli and model exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-health-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root);
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });

    const health = await provider.healthCheck(activeSettings);

    expect(health.status).toBe('ok');
    expect(health.available).toBe(true);
  });

  it('cleans stale voice temp folders during initialization', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-cleanup-'));
    cleanupPaths.push(root);
    const tempRoot = path.join(root, 'voice-temp');
    const stalePath = path.join(tempRoot, 'session-stale');
    const freshPath = path.join(tempRoot, 'session-fresh');
    await fs.mkdir(stalePath, { recursive: true });
    await fs.mkdir(freshPath, { recursive: true });

    const staleDate = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(stalePath, staleDate, staleDate);

    const provider = new WhisperCppSpeechToTextProvider({
      threads: 4,
      tempRoot
    });

    await provider.initialize();

    await expect(fs.stat(stalePath)).rejects.toThrow();
    await expect(fs.stat(freshPath)).resolves.toBeTruthy();
  });

  it('propagates the configured language into whisper-cli and returns audio diagnostics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-language-'));
    cleanupPaths.push(root);
    const { cliPath, argsPath } = await createFakeWhisperCli(root, {
      captureArgs: true,
      jsonPayload: {
        text: 'hola mundo'
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(1_100), {
        durationMs: 1_100
      })
    });
    const args = JSON.parse(await fs.readFile(argsPath, 'utf8')) as string[];

    expect(result.transcript).toBe('hola mundo');
    expect(result.effectiveLanguage).toBe('es');
    expect(result.audioDiagnostics?.wavValid).toBe(true);
    expect(args[args.indexOf('--language') + 1]).toBe('es');
  });

  it('accepts a useful transcript from the real whisper.cpp transcription array shape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-real-shape-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root, {
      jsonPayload: {
        result: {
          language: 'es'
        },
        transcription: [
          {
            text: ' Explica que es Asim en dos frases.'
          }
        ]
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(1_300), {
        durationMs: 1_300
      })
    });

    expect(result.transcript).toBe('Explica que es Asim en dos frases.');
    expect(result.diagnostic).toBeUndefined();
    expect(result.effectiveLanguage).toBe('es');
  });

  it('accepts a short but valid transcript', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-short-valid-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root, {
      jsonPayload: {
        result: {
          language: 'es'
        },
        transcription: [
          {
            text: ' Hola.'
          }
        ]
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(900))
    });

    expect(result.transcript).toBe('Hola.');
    expect(result.diagnostic).toBeUndefined();
  });

  it('returns a clear diagnostic when the WAV is too short', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-short-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root);
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(120), {
        durationMs: 120,
        diagnostics: {
          byteLength: createTestWavBuffer(120).length,
          sampleRateHz: 16_000,
          channelCount: 1,
          bitDepth: 16,
          approximateDurationMs: 120,
          peakLevel: 0.45,
          rmsLevel: 0.21,
          wavValid: true,
          silenceDetected: false,
          suspicious: true
        }
      })
    });

    expect(result.transcript).toBe('');
    expect(result.diagnostic?.code).toBe('audio_too_short');
  });

  it('returns a clear diagnostic when the WAV payload is invalid', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-invalid-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root);
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: {
        mimeType: 'audio/wav',
        fileName: 'bad.wav',
        base64Data: Buffer.from('not-a-valid-wav', 'utf8').toString('base64'),
        durationMs: 500
      }
    });

    expect(result.transcript).toBe('');
    expect(result.diagnostic?.code).toBe('audio_invalid_wav');
  });

  it('distinguishes an empty transcript JSON from a missing execution error', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-empty-json-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root, {
      jsonPayload: {
        segments: []
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'auto'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(1_200), {
        durationMs: 1_200
      })
    });

    expect(result.transcript).toBe('');
    expect(result.diagnostic?.code).toBe('transcript_empty');
    expect(result.diagnostic?.transcriptJsonGenerated).toBe(true);
  });

  it('reports transcripts that are only punctuation or noise as not useful', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-garbage-transcript-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root, {
      jsonPayload: {
        result: {
          language: 'es'
        },
        transcription: [
          {
            text: ' ... ?!? '
          }
        ]
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(1_100), {
        durationMs: 1_100
      })
    });

    expect(result.transcript).toBe('');
    expect(result.diagnostic?.code).toBe('transcript_too_short');
  });

  it('does not mark a coherent transcript as language mismatch just because it is imperfect', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-no-false-mismatch-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root, {
      jsonPayload: {
        result: {
          language: 'es'
        },
        transcription: [
          {
            text: ' Explica que es Asim en dos frases.'
          }
        ]
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(1_250), {
        durationMs: 1_250
      })
    });

    expect(result.transcript).toContain('Asim');
    expect(result.diagnostic?.code).not.toBe('language_mismatch_suspected');
  });

  it('only marks language mismatch when whisper reports a different language and no usable text', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-true-mismatch-'));
    cleanupPaths.push(root);
    const { cliPath } = await createFakeWhisperCli(root, {
      jsonPayload: {
        result: {
          language: 'en'
        },
        transcription: []
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot: path.join(root, 'voice-temp')
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(1_200), {
        durationMs: 1_200
      })
    });

    expect(result.transcript).toBe('');
    expect(result.diagnostic?.code).toBe('language_mismatch_suspected');
  });

  it('keeps input.wav and transcript.json when debug artifacts are enabled', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-whisper-debug-'));
    cleanupPaths.push(root);
    const tempRoot = path.join(root, 'voice-temp');
    const { cliPath } = await createFakeWhisperCli(root, {
      jsonPayload: {
        text: 'hola mundo'
      }
    });
    const modelPath = path.join(root, 'models', 'ggml-base.bin');
    await fs.mkdir(path.dirname(modelPath), { recursive: true });
    await fs.writeFile(modelPath, 'model', 'utf8');

    const provider = new WhisperCppSpeechToTextProvider({
      cliPath,
      modelPath,
      threads: 4,
      tempRoot,
      debugArtifacts: true
    });
    const session = await provider.startListening({
      sessionId: 'voice-session',
      language: 'es-ES'
    });

    const result = await session.stop({
      audio: createAudioInput(createTestWavBuffer(1_000), {
        durationMs: 1_000
      })
    });
    const entries = await fs.readdir(tempRoot, { withFileTypes: true });
    const sessionFolder = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('session-'));

    expect(result.transcript).toBe('hola mundo');
    expect(sessionFolder).toBeTruthy();
    await expect(
      fs.stat(path.join(tempRoot, sessionFolder!.name, 'input.wav'))
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tempRoot, sessionFolder!.name, 'transcript.json'))
    ).resolves.toBeTruthy();
  });
});

describe('whisperCppProviderInternals', () => {
  it.each([
    ['es-ES', 'es'],
    ['es', 'es'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['fr-FR', 'fr'],
    ['auto', 'auto'],
    [undefined, 'auto']
  ])('normalizes %s into %s', (input, expected) => {
    expect(whisperCppProviderInternals.normalizeWhisperLanguage(input)).toBe(expected);
  });

  it('extracts transcript text from the supported whisper.cpp JSON shapes', () => {
    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        text: ' hola mundo '
      })
    ).toBe('hola mundo');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        result: ' transcript from result '
      })
    ).toBe('transcript from result');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        transcription: ' transcript from transcription '
      })
    ).toBe('transcript from transcription');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        transcription: [{ text: ' Explica' }, { text: ' algo' }]
      })
    ).toBe('Explica algo');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        result: {
          text: ' desde result.text '
        }
      })
    ).toBe('desde result.text');

    expect(
      whisperCppProviderInternals.resolveTranscriptFromJson({
        segments: [{ text: 'hola' }, { text: 'mundo' }]
      })
    ).toBe('hola mundo');
  });

  it('marks punctuation-only transcripts as not useful', () => {
    expect(whisperCppProviderInternals.isTranscriptUseful('?')).toBe(false);
    expect(whisperCppProviderInternals.isTranscriptUseful('si')).toBe(true);
    expect(
      whisperCppProviderInternals.isTranscriptUseful('Explica que es Asim en dos frases.')
    ).toBe(true);
    expect(whisperCppProviderInternals.isTranscriptUseful('Hola.')).toBe(true);
  });

  it('inspects WAV metadata and amplitude from the received browser payload', () => {
    const wav = createTestWavBuffer(900);
    const inspection = whisperCppProviderInternals.inspectWavBuffer(
      wav,
      createAudioInput(wav)
    );

    expect(inspection.wavValid).toBe(true);
    expect(inspection.sampleRateHz).toBe(16_000);
    expect(inspection.channelCount).toBe(1);
    expect(inspection.approximateDurationMs).toBeGreaterThanOrEqual(850);
    expect(inspection.peakLevel).toBeGreaterThan(0.1);
  });

  it('creates a valid wav header for the health self-check audio', () => {
    const wav = whisperCppProviderInternals.createSilentWavBuffer(250);

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.length).toBeGreaterThan(44);
  });
});
