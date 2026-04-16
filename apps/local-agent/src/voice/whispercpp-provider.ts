import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { inspectWhisperRuntime } from '@assem/config';
import type {
  SpeechToTextAudioInput,
  SpeechToTextProvider,
  SpeechToTextResult,
  SpeechToTextSession,
  SpeechToTextStartRequest,
  SpeechToTextStopRequest,
  VoiceAudioDiagnostics,
  VoiceProviderHealth,
  VoiceSettings,
  VoiceTranscriptionDiagnostic,
  VoiceTranscriptionDiagnosticCode
} from '@assem/shared-types';

const SELF_CHECK_TIMEOUT_MS = 20_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const PROVIDER_HEALTH_CACHE_TTL_MS = 5 * 60_000;
const STALE_TEMP_ENTRY_MAX_AGE_MS = 30 * 60_000;
const MIN_AUDIO_DURATION_MS = 300;
const SILENCE_PEAK_THRESHOLD = 0.015;
const SILENCE_RMS_THRESHOLD = 0.0035;
const MIN_USEFUL_TRANSCRIPT_CHARACTERS = 2;

interface WhisperCppSpeechToTextProviderOptions {
  cliPath?: string;
  modelPath?: string;
  threads: number;
  tempRoot?: string;
  debugArtifacts?: boolean;
}

interface WhisperCppJsonSegment {
  text?: string;
}

interface WhisperCppJsonResult {
  text?: string;
  language?: string;
}

interface WhisperCppJsonOutput {
  text?: string;
  result?: string | WhisperCppJsonResult;
  transcription?: string | WhisperCppJsonSegment[];
  segments?: WhisperCppJsonSegment[];
}

interface WhisperProviderResolvedOptions {
  cliPath?: string;
  modelPath?: string;
  threads: number;
  tempRoot: string;
  debugArtifacts: boolean;
}

interface HealthCacheEntry {
  checkedAt: number;
  result: VoiceProviderHealth;
}

interface TranscriptAnalysis {
  transcript: string;
  transcriptTextLength: number;
  wordCount: number;
  recognizableWordCount: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeProcessMessage(message: string): string {
  return message
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createProviderHealth(
  providerId: string,
  label: string,
  kind: 'stt',
  active: boolean,
  status: VoiceProviderHealth['status'],
  configured: boolean,
  available: boolean,
  error?: string
): VoiceProviderHealth {
  return {
    providerId,
    label,
    kind,
    status,
    checkedAt: nowIso(),
    configured,
    available,
    active,
    error
  };
}

function createDiagnostic(
  code: VoiceTranscriptionDiagnosticCode,
  summary: string,
  options: Omit<VoiceTranscriptionDiagnostic, 'code' | 'summary'> = {}
): VoiceTranscriptionDiagnostic {
  return {
    code,
    summary,
    ...options
  };
}

function normalizeWhisperLanguage(language: string | undefined): string {
  const normalized = (language ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'auto';
  }

  if (normalized === 'auto') {
    return 'auto';
  }

  if (normalized.startsWith('es')) {
    return 'es';
  }

  if (normalized.startsWith('en')) {
    return 'en';
  }

  const neutral = normalized.split('-')[0]?.trim();
  return neutral || 'auto';
}

function resolveAudioExtension(
  mimeType: string | undefined,
  fileName: string | undefined
): string {
  const lowerMimeType = (mimeType ?? '').toLowerCase();
  if (lowerMimeType.includes('wav')) {
    return '.wav';
  }

  if (fileName) {
    const extension = path.extname(fileName).trim();
    if (extension) {
      return extension;
    }
  }

  return '.wav';
}

function resolveTranscriptFromJson(payload: WhisperCppJsonOutput): string {
  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text.trim();
  }

  if (typeof payload.result === 'string' && payload.result.trim()) {
    return payload.result.trim();
  }

  if (typeof payload.result === 'object' && payload.result !== null) {
    if (typeof payload.result.text === 'string' && payload.result.text.trim()) {
      return payload.result.text.trim();
    }
  }

  if (typeof payload.transcription === 'string' && payload.transcription.trim()) {
    return payload.transcription.trim();
  }

  if (Array.isArray(payload.transcription)) {
    const combined = payload.transcription
      .map((segment) => segment.text?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();

    if (combined) {
      return combined;
    }
  }

  if (Array.isArray(payload.segments)) {
    const combined = payload.segments
      .map((segment) => segment.text?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();

    if (combined) {
      return combined;
    }
  }

  return '';
}

function normalizeTranscriptText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function extractTranscriptWords(text: string): string[] {
  return normalizeTranscriptText(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
}

function countUsefulTranscriptCharacters(text: string): number {
  return normalizeTranscriptText(text).replace(/[^\p{L}\p{N}]+/gu, '').length;
}

function isTranscriptUseful(text: string): boolean {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) {
    return false;
  }

  const usefulCharacterCount = countUsefulTranscriptCharacters(normalized);
  if (usefulCharacterCount < MIN_USEFUL_TRANSCRIPT_CHARACTERS) {
    return false;
  }

  const words = extractTranscriptWords(normalized);
  if (words.length === 0) {
    return false;
  }

  if (words.some((word) => word.length >= 2)) {
    return true;
  }

  return usefulCharacterCount >= 3 && words.length >= 2;
}

function resolveTranscriptLanguage(payload: WhisperCppJsonOutput): string | undefined {
  if (typeof payload.result === 'object' && payload.result !== null) {
    const language = payload.result.language?.trim().toLowerCase();
    if (language) {
      return language;
    }
  }

  return undefined;
}

function analyzeTranscriptPayload(payload: WhisperCppJsonOutput): TranscriptAnalysis {
  const transcript = normalizeTranscriptText(resolveTranscriptFromJson(payload));
  const words = extractTranscriptWords(transcript);

  return {
    transcript,
    transcriptTextLength: countUsefulTranscriptCharacters(transcript),
    wordCount: words.length,
    recognizableWordCount: words.filter((word) => word.length >= 2).length
  };
}

function createSilentWavBuffer(
  durationMs = 250,
  sampleRate = 16_000,
  channels = 1
): Buffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const samples = Math.max(1, Math.round((sampleRate * durationMs) / 1_000));
  const dataSize = samples * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function inspectWavBuffer(
  buffer: Buffer,
  audio: SpeechToTextAudioInput
): VoiceAudioDiagnostics {
  const diagnostics: VoiceAudioDiagnostics = {
    ...audio.diagnostics,
    mimeType: audio.mimeType,
    fileName: audio.fileName,
    byteLength: buffer.length,
    base64Length: audio.base64Data.length
  };

  if (
    buffer.length < 44 ||
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    return {
      ...diagnostics,
      wavValid: false,
      suspicious: true
    };
  }

  let offset = 12;
  let sampleRateHz: number | undefined;
  let channelCount: number | undefined;
  let bitDepth: number | undefined;
  let audioFormat: number | undefined;
  let dataOffset = -1;
  let dataByteLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    const nextOffset = chunkDataOffset + chunkSize + (chunkSize % 2);

    if (nextOffset > buffer.length + 1) {
      return {
        ...diagnostics,
        wavValid: false,
        suspicious: true
      };
    }

    if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataOffset + 16 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(chunkDataOffset);
      channelCount = buffer.readUInt16LE(chunkDataOffset + 2);
      sampleRateHz = buffer.readUInt32LE(chunkDataOffset + 4);
      bitDepth = buffer.readUInt16LE(chunkDataOffset + 14);
    }

    if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataByteLength = Math.max(0, Math.min(chunkSize, buffer.length - chunkDataOffset));
      break;
    }

    offset = nextOffset;
  }

  if (
    audioFormat !== 1 ||
    !sampleRateHz ||
    !channelCount ||
    !bitDepth ||
    dataOffset < 0
  ) {
    return {
      ...diagnostics,
      wavValid: false,
      suspicious: true
    };
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  if (!Number.isFinite(blockAlign) || blockAlign <= 0) {
    return {
      ...diagnostics,
      wavValid: false,
      suspicious: true
    };
  }

  const sampleCount = Math.floor(dataByteLength / blockAlign);
  const approximateDurationMs =
    sampleRateHz > 0 ? Math.round((sampleCount / sampleRateHz) * 1_000) : 0;

  let peakLevel = diagnostics.peakLevel ?? 0;
  let rmsLevel = diagnostics.rmsLevel ?? 0;

  if (bitDepth === 16 && sampleCount > 0) {
    let peak = 0;
    let squareSum = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      const sampleOffset = dataOffset + index * blockAlign;
      const sample = buffer.readInt16LE(sampleOffset) / 0x8000;
      const amplitude = Math.abs(sample);
      peak = Math.max(peak, amplitude);
      squareSum += sample * sample;
    }

    peakLevel = Number(peak.toFixed(5));
    rmsLevel = Number(Math.sqrt(squareSum / sampleCount).toFixed(5));
  }

  const silenceDetected =
    diagnostics.silenceDetected ??
    (peakLevel <= SILENCE_PEAK_THRESHOLD && rmsLevel <= SILENCE_RMS_THRESHOLD);
  const suspicious =
    diagnostics.suspicious ??
    (
      sampleCount === 0 ||
      approximateDurationMs < MIN_AUDIO_DURATION_MS ||
      silenceDetected
    );

  return {
    ...diagnostics,
    sampleRateHz,
    channelCount,
    bitDepth,
    sampleCount,
    approximateDurationMs,
    peakLevel,
    rmsLevel,
    wavValid: true,
    silenceDetected,
    suspicious
  };
}

function resolveApproximateAudioDurationMs(
  audio: SpeechToTextAudioInput,
  diagnostics: VoiceAudioDiagnostics
): number {
  return (
    diagnostics.approximateDurationMs ??
    audio.diagnostics?.approximateDurationMs ??
    audio.durationMs ??
    0
  );
}

function buildAudioTransportDetail(
  declaredDiagnostics: VoiceAudioDiagnostics | undefined,
  receivedDiagnostics: VoiceAudioDiagnostics
): string | undefined {
  if (!declaredDiagnostics) {
    return undefined;
  }

  const mismatches: string[] = [];

  if (
    typeof declaredDiagnostics.byteLength === 'number' &&
    declaredDiagnostics.byteLength !== receivedDiagnostics.byteLength
  ) {
    mismatches.push(
      `el frontend declaro ${declaredDiagnostics.byteLength} byte(s) y el agente recibio ${receivedDiagnostics.byteLength}`
    );
  }

  if (
    typeof declaredDiagnostics.sampleRateHz === 'number' &&
    typeof receivedDiagnostics.sampleRateHz === 'number' &&
    declaredDiagnostics.sampleRateHz !== receivedDiagnostics.sampleRateHz
  ) {
    mismatches.push(
      `el frontend declaro ${declaredDiagnostics.sampleRateHz} Hz y el WAV contiene ${receivedDiagnostics.sampleRateHz} Hz`
    );
  }

  return mismatches.length > 0 ? mismatches.join('; ') : undefined;
}

function shouldInspectAsWav(audio: SpeechToTextAudioInput): boolean {
  const mimeType = (audio.mimeType ?? '').toLowerCase();
  if (mimeType.includes('wav')) {
    return true;
  }

  const extension = path.extname(audio.fileName ?? '').toLowerCase();
  return extension === '.wav' || !extension;
}

function describeAudioDiagnostics(audio: VoiceAudioDiagnostics): string {
  const parts = [`${audio.byteLength} byte(s)`];

  if (typeof audio.approximateDurationMs === 'number') {
    parts.push(`${audio.approximateDurationMs} ms`);
  }

  if (typeof audio.sampleRateHz === 'number') {
    parts.push(`${audio.sampleRateHz} Hz`);
  }

  if (typeof audio.channelCount === 'number') {
    parts.push(audio.channelCount === 1 ? 'mono' : `${audio.channelCount} canales`);
  }

  if (typeof audio.peakLevel === 'number') {
    parts.push(`pico ${audio.peakLevel}`);
  }

  if (typeof audio.rmsLevel === 'number') {
    parts.push(`rms ${audio.rmsLevel}`);
  }

  return parts.join(', ');
}

function logTranscriptionDiagnostic(
  diagnostic: VoiceTranscriptionDiagnostic,
  options: {
    audio?: VoiceAudioDiagnostics;
    sessionRoot?: string;
  } = {}
): void {
  const message = [
    `[ASSEM voice][whisper] ${diagnostic.code}: ${diagnostic.summary}`,
    diagnostic.effectiveLanguage ? `idioma=${diagnostic.effectiveLanguage}` : '',
    options.audio ? `audio=${describeAudioDiagnostics(options.audio)}` : '',
    options.sessionRoot ? `temp=${options.sessionRoot}` : '',
    diagnostic.detail ? `detalle=${diagnostic.detail}` : ''
  ]
    .filter(Boolean)
    .join(' | ');

  if (diagnostic.code === 'whisper_execution_failed') {
    console.error(message);
    return;
  }

  console.warn(message);
}

async function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
        ? spawn(process.env.ComSpec ?? 'cmd.exe', [
            '/d',
            '/s',
            '/c',
            [executable, ...args]
              .map((value) =>
                /\s|"/.test(value)
                  ? `"${value.replace(/"/g, '""')}"`
                  : value
              )
              .join(' ')
          ], {
            stdio: 'pipe',
            windowsHide: true
          })
        : spawn(executable, args, {
            stdio: 'pipe',
            windowsHide: true
          });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('Timed out while running whisper.cpp.'));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk.toString('utf8'));
    });

    child.stderr.on('data', (chunk) => {
      stderr.push(chunk.toString('utf8'));
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }

      const stdoutText = sanitizeProcessMessage(stdout.join(' '));
      const stderrText = sanitizeProcessMessage(stderr.join(' '));

      if (code !== 0) {
        settled = true;
        reject(
          new Error(
            stderrText || stdoutText || 'whisper.cpp exited with a non-zero status.'
          )
        );
        return;
      }

      settled = true;
      resolve({
        stdout: stdoutText,
        stderr: stderrText
      });
    });
  });
}

async function cleanupStaleWhisperTempArtifacts(
  tempRoot: string,
  maxAgeMs = STALE_TEMP_ENTRY_MAX_AGE_MS
): Promise<void> {
  const normalizedRoot = path.resolve(tempRoot);
  await fs.mkdir(normalizedRoot, { recursive: true });

  const entries = await fs.readdir(normalizedRoot, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    entries.map(async (entry) => {
      if (!/^session-|^health-/.test(entry.name)) {
        return;
      }

      const entryPath = path.join(normalizedRoot, entry.name);
      try {
        const stats = await fs.stat(entryPath);
        if (now - stats.mtimeMs < maxAgeMs) {
          return;
        }

        await fs.rm(entryPath, { recursive: true, force: true });
      } catch {
        return;
      }
    })
  );
}

async function runSelfCheck(
  options: WhisperProviderResolvedOptions,
  language: string
): Promise<void> {
  if (!options.cliPath || !options.modelPath) {
    throw new Error('whisper.cpp no esta configurado.');
  }

  const tempRoot = path.resolve(options.tempRoot);
  await fs.mkdir(tempRoot, { recursive: true });
  const healthRoot = await fs.mkdtemp(path.join(tempRoot, 'health-'));
  const inputPath = path.join(healthRoot, 'probe.wav');
  const outputPrefix = path.join(healthRoot, 'probe');
  const outputJsonPath = `${outputPrefix}.json`;

  try {
    await fs.writeFile(inputPath, createSilentWavBuffer(), 'binary');

    await runCommand(
      options.cliPath,
      [
        '--model',
        options.modelPath,
        '--file',
        inputPath,
        '--language',
        normalizeWhisperLanguage(language),
        '--threads',
        '1',
        '--output-json',
        '--output-file',
        outputPrefix,
        '--no-prints',
        '--no-timestamps'
      ],
      SELF_CHECK_TIMEOUT_MS
    );

    const rawJson = await fs.readFile(outputJsonPath, 'utf8');
    JSON.parse(rawJson);
  } finally {
    await fs.rm(healthRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildMissingRuntimeMessage(
  cliPath: string | undefined,
  modelPath: string | undefined,
  status: {
    cliExists: boolean;
    modelExists: boolean;
  }
): string {
  if (!cliPath && !modelPath) {
    return 'Configura ASSEM_WHISPER_CPP_CLI_PATH y ASSEM_WHISPER_CPP_MODEL_PATH o ejecuta "npm run voice:bootstrap".';
  }

  if (!status.cliExists && !status.modelExists) {
    return `Faltan el binario de whisper.cpp (${cliPath}) y el modelo (${modelPath}). Ejecuta "npm run voice:bootstrap".`;
  }

  if (!status.cliExists) {
    return `Falta el binario de whisper.cpp en ${cliPath}. Ejecuta "npm run voice:bootstrap" o revisa ASSEM_WHISPER_CPP_CLI_PATH.`;
  }

  return `Falta el modelo de whisper.cpp en ${modelPath}. Ejecuta "npm run voice:bootstrap" o revisa ASSEM_WHISPER_CPP_MODEL_PATH.`;
}

class WhisperCppSpeechToTextSession implements SpeechToTextSession {
  private cancelled = false;
  private stopped = false;

  constructor(
    private readonly options: WhisperProviderResolvedOptions,
    private readonly request: SpeechToTextStartRequest
  ) {}

  async stop(stopRequest?: SpeechToTextStopRequest): Promise<SpeechToTextResult> {
    if (this.cancelled) {
      throw new Error('The recording was already cancelled.');
    }

    if (this.stopped) {
      throw new Error('The recording was already processed.');
    }

    this.stopped = true;
    const audio = stopRequest?.audio;
    const effectiveLanguage = normalizeWhisperLanguage(this.request.language);

    if (!audio?.base64Data) {
      return {
        transcript: '',
        audioDurationMs: 0,
        effectiveLanguage,
        diagnostic: createDiagnostic(
          'audio_payload_missing',
          'No se ha recibido audio WAV desde la app desktop para transcribir.',
          {
            effectiveLanguage
          }
        )
      };
    }

    return await transcribeWithWhisperCpp(this.options, this.request, audio);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

async function transcribeWithWhisperCpp(
  options: WhisperProviderResolvedOptions,
  request: SpeechToTextStartRequest,
  audio: SpeechToTextAudioInput
): Promise<SpeechToTextResult> {
  const tempRoot = path.resolve(options.tempRoot);
  await fs.mkdir(tempRoot, { recursive: true });

  const sessionRoot = await fs.mkdtemp(path.join(tempRoot, 'session-'));
  const extension = resolveAudioExtension(audio.mimeType, audio.fileName);
  const inputPath = path.join(sessionRoot, `input${extension}`);
  const outputPrefix = path.join(sessionRoot, 'transcript');
  const outputJsonPath = `${outputPrefix}.json`;
  const effectiveLanguage = normalizeWhisperLanguage(request.language);
  const normalizedBase64 = audio.base64Data.trim();
  let receivedDiagnostics: VoiceAudioDiagnostics = {
    ...audio.diagnostics,
    mimeType: audio.mimeType,
    fileName: audio.fileName,
    byteLength: 0,
    base64Length: normalizedBase64.length
  };

  try {
    const audioBuffer = normalizedBase64
      ? Buffer.from(normalizedBase64, 'base64')
      : Buffer.alloc(0);

    receivedDiagnostics = shouldInspectAsWav(audio)
      ? inspectWavBuffer(audioBuffer, audio)
      : {
          ...receivedDiagnostics,
          byteLength: audioBuffer.length
        };

    await fs.writeFile(inputPath, audioBuffer);

    const audioDurationMs = resolveApproximateAudioDurationMs(audio, receivedDiagnostics);
    const transportDetail = buildAudioTransportDetail(
      audio.diagnostics,
      receivedDiagnostics
    );

    if (!normalizedBase64) {
      const diagnostic = createDiagnostic(
        'audio_payload_missing',
        'La app desktop no envio ningun payload de audio al agente local.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail: transportDetail,
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    if (audioBuffer.length === 0) {
      const diagnostic = createDiagnostic(
        'audio_decode_failed',
        'El payload de audio no se pudo decodificar correctamente en el agente local.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail: transportDetail,
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    if (receivedDiagnostics.wavValid === false) {
      const diagnostic = createDiagnostic(
        'audio_invalid_wav',
        'El WAV recibido por el agente local no es valido o esta truncado.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail:
            transportDetail ??
            'El archivo no contiene una cabecera RIFF/WAVE valida o le falta el bloque de datos.',
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    if ((receivedDiagnostics.approximateDurationMs ?? 0) < MIN_AUDIO_DURATION_MS) {
      const diagnostic = createDiagnostic(
        'audio_too_short',
        `La grabacion es demasiado corta para Whisper (${receivedDiagnostics.approximateDurationMs ?? 0} ms).`,
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail:
            transportDetail ??
            'Pulsa hablar un poco mas de tiempo antes de detener y enviar.',
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    if (receivedDiagnostics.silenceDetected) {
      const diagnostic = createDiagnostic(
        'audio_silent',
        'El audio recibido parece casi silencioso o con un nivel demasiado bajo.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail:
            transportDetail ??
            'Revisa el microfono, el nivel de entrada y la distancia al hablar.',
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    if (options.debugArtifacts) {
      console.info(
        `[ASSEM voice][whisper] transcribiendo | idioma=${effectiveLanguage} | audio=${describeAudioDiagnostics(
          receivedDiagnostics
        )} | temp=${sessionRoot}`
      );
    }

    const args = [
      '--model',
      options.modelPath!,
      '--file',
      inputPath,
      '--language',
      effectiveLanguage,
      '--threads',
      `${options.threads}`,
      '--output-json',
      '--output-file',
      outputPrefix,
      '--no-prints',
      '--no-timestamps'
    ];

    try {
      await runCommand(options.cliPath!, args, TRANSCRIPTION_TIMEOUT_MS);
    } catch (error) {
      const diagnostic = createDiagnostic(
        'whisper_execution_failed',
        'Whisper no pudo completar la transcripcion del audio recibido.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail:
            error instanceof Error
              ? sanitizeProcessMessage(error.message)
              : 'error desconocido',
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined,
          transcriptJsonPath: options.debugArtifacts ? outputJsonPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    let rawJson: string;
    try {
      rawJson = await fs.readFile(outputJsonPath, 'utf8');
    } catch (error) {
      const diagnostic = createDiagnostic(
        'transcript_missing',
        'Whisper termino, pero no genero el transcript JSON esperado.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail:
            error instanceof Error
              ? sanitizeProcessMessage(error.message)
              : 'No se encontro transcript.json',
          transcriptJsonGenerated: false,
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined,
          transcriptJsonPath: options.debugArtifacts ? outputJsonPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    let parsed: WhisperCppJsonOutput;
    try {
      parsed = JSON.parse(rawJson) as WhisperCppJsonOutput;
    } catch (error) {
      const diagnostic = createDiagnostic(
        'whisper_execution_failed',
        'Whisper genero un transcript JSON invalido y no se pudo procesar.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail:
            error instanceof Error
              ? sanitizeProcessMessage(error.message)
              : 'JSON invalido',
          transcriptJsonGenerated: true,
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined,
          transcriptJsonPath: options.debugArtifacts ? outputJsonPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    const transcriptAnalysis = analyzeTranscriptPayload(parsed);
    const reportedLanguage = resolveTranscriptLanguage(parsed);

    if (!transcriptAnalysis.transcript) {
      const probableLanguageMismatch =
        effectiveLanguage !== 'auto' &&
        Boolean(reportedLanguage) &&
        reportedLanguage !== effectiveLanguage;
      const diagnostic = createDiagnostic(
        probableLanguageMismatch
          ? 'language_mismatch_suspected'
          : 'transcript_empty',
        probableLanguageMismatch
          ? `Whisper no devolvio texto util y reporto el idioma "${reportedLanguage}" en lugar de "${effectiveLanguage}".`
          : 'Whisper se ejecuto, pero transcript.json no contiene texto util.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail: probableLanguageMismatch
            ? 'Whisper indico un idioma distinto al configurado. Conviene revisar el idioma hablado o la configuracion de voz.'
            : 'El audio llego bien, pero Whisper no devolvio texto reconocible en esta pasada.',
          transcriptJsonGenerated: true,
          transcriptTextLength: 0,
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined,
          transcriptJsonPath: options.debugArtifacts ? outputJsonPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    if (!isTranscriptUseful(transcriptAnalysis.transcript)) {
      const diagnostic = createDiagnostic(
        'transcript_too_short',
        'Whisper devolvio un transcript demasiado corto o poco util para enviarlo al chat.',
        {
          effectiveLanguage,
          audio: receivedDiagnostics,
          detail:
            transcriptAnalysis.wordCount === 0
              ? 'El transcript solo contiene signos o ruido sin palabras reconocibles.'
              : 'El transcript contiene texto demasiado corto para ser util, pero no esta vacio.',
          transcriptJsonGenerated: true,
          transcriptTextLength: transcriptAnalysis.transcriptTextLength,
          debugArtifactsRetained: options.debugArtifacts,
          inputPath: options.debugArtifacts ? inputPath : undefined,
          transcriptJsonPath: options.debugArtifacts ? outputJsonPath : undefined
        }
      );
      logTranscriptionDiagnostic(diagnostic, {
        audio: receivedDiagnostics,
        sessionRoot
      });
      return {
        transcript: '',
        audioDurationMs,
        audioDiagnostics: receivedDiagnostics,
        effectiveLanguage,
        diagnostic
      };
    }

    return {
      transcript: transcriptAnalysis.transcript,
      audioDurationMs,
      audioDiagnostics: receivedDiagnostics,
      effectiveLanguage
    };
  } finally {
    if (!options.debugArtifacts) {
      await fs.rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export class WhisperCppSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'whisper-cpp';
  readonly label = 'whisper.cpp';
  readonly kind = 'stt' as const;
  private healthCache: HealthCacheEntry | null = null;

  constructor(private readonly options: WhisperCppSpeechToTextProviderOptions) {}

  isConfigured(): boolean {
    return Boolean(this.options.cliPath && this.options.modelPath);
  }

  async initialize(): Promise<void> {
    await cleanupStaleWhisperTempArtifacts(this.resolveOptions().tempRoot);
  }

  async healthCheck(settings: VoiceSettings): Promise<VoiceProviderHealth> {
    const active = settings.sttProviderId === this.id;
    const cached = this.healthCache;
    if (cached && Date.now() - cached.checkedAt < PROVIDER_HEALTH_CACHE_TTL_MS) {
      return {
        ...cached.result,
        active,
        checkedAt: nowIso()
      };
    }

    const resolvedOptions = this.resolveOptions();
    if (!resolvedOptions.cliPath || !resolvedOptions.modelPath) {
      const result = createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        'unavailable',
        false,
        false,
        buildMissingRuntimeMessage(resolvedOptions.cliPath, resolvedOptions.modelPath, {
          cliExists: false,
          modelExists: false
        })
      );
      this.healthCache = {
        checkedAt: Date.now(),
        result
      };
      return result;
    }

    const runtimeStatus = await inspectWhisperRuntime({
      repoRoot: process.cwd(),
      runtimeRoot: resolvedOptions.tempRoot,
      cliPath: resolvedOptions.cliPath,
      modelPath: resolvedOptions.modelPath
    });

    if (!runtimeStatus.ready) {
      const result = createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        (runtimeStatus.cliExists || runtimeStatus.modelExists) ? 'degraded' : 'unavailable',
        true,
        false,
        buildMissingRuntimeMessage(
          resolvedOptions.cliPath,
          resolvedOptions.modelPath,
          runtimeStatus
        )
      );
      this.healthCache = {
        checkedAt: Date.now(),
        result
      };
      return result;
    }

    try {
      await runSelfCheck(resolvedOptions, settings.preferredLanguage);
      const result = createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        'ok',
        true,
        true
      );
      this.healthCache = {
        checkedAt: Date.now(),
        result
      };
      return result;
    } catch (error) {
      const result = createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        'degraded',
        true,
        false,
        `Whisper esta instalado pero la transcripcion de prueba ha fallado: ${
          error instanceof Error
            ? sanitizeProcessMessage(error.message)
            : 'error desconocido'
        }`
      );
      this.healthCache = {
        checkedAt: Date.now(),
        result
      };
      return result;
    }
  }

  async startListening(
    request: SpeechToTextStartRequest
  ): Promise<SpeechToTextSession> {
    const resolvedOptions = this.resolveOptions();
    const runtimeStatus = await inspectWhisperRuntime({
      repoRoot: process.cwd(),
      runtimeRoot: resolvedOptions.tempRoot,
      cliPath: resolvedOptions.cliPath ?? '',
      modelPath: resolvedOptions.modelPath ?? ''
    });

    if (!resolvedOptions.cliPath || !resolvedOptions.modelPath || !runtimeStatus.ready) {
      throw new Error(
        buildMissingRuntimeMessage(
          resolvedOptions.cliPath,
          resolvedOptions.modelPath,
          runtimeStatus
        )
      );
    }

    return new WhisperCppSpeechToTextSession(resolvedOptions, request);
  }

  private resolveOptions(): WhisperProviderResolvedOptions {
    return {
      cliPath: this.options.cliPath,
      modelPath: this.options.modelPath,
      threads: this.options.threads,
      tempRoot: this.options.tempRoot ?? path.join(os.tmpdir(), 'assem-whispercpp'),
      debugArtifacts: this.options.debugArtifacts ?? false
    };
  }
}

export const whisperCppProviderInternals = {
  normalizeWhisperLanguage,
  normalizeTranscriptText,
  resolveTranscriptFromJson,
  resolveTranscriptLanguage,
  extractTranscriptWords,
  countUsefulTranscriptCharacters,
  isTranscriptUseful,
  analyzeTranscriptPayload,
  inspectWavBuffer,
  createSilentWavBuffer,
  cleanupStaleWhisperTempArtifacts
};
