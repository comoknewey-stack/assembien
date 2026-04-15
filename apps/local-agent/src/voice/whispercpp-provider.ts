import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import type {
  SpeechToTextAudioInput,
  SpeechToTextProvider,
  SpeechToTextResult,
  SpeechToTextSession,
  SpeechToTextStartRequest,
  SpeechToTextStopRequest,
  VoiceProviderHealth,
  VoiceSettings
} from '@assem/shared-types';

const HEALTHCHECK_TIMEOUT_MS = 5_000;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

interface WhisperCppSpeechToTextProviderOptions {
  cliPath?: string;
  modelPath?: string;
  threads: number;
  tempRoot?: string;
}

interface WhisperCppJsonSegment {
  text?: string;
}

interface WhisperCppJsonOutput {
  text?: string;
  result?: string;
  transcription?: string;
  segments?: WhisperCppJsonSegment[];
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

function resolveAudioExtension(mimeType: string | undefined, fileName: string | undefined): string {
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

  if (typeof payload.transcription === 'string' && payload.transcription.trim()) {
    return payload.transcription.trim();
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

async function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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

class WhisperCppSpeechToTextSession implements SpeechToTextSession {
  private cancelled = false;
  private stopped = false;

  constructor(
    private readonly options: Required<WhisperCppSpeechToTextProviderOptions>,
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
    if (!audio?.base64Data) {
      throw new Error('No se ha recibido audio para transcribir con whisper.cpp.');
    }

    return await transcribeWithWhisperCpp(this.options, this.request, audio);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

async function transcribeWithWhisperCpp(
  options: Required<WhisperCppSpeechToTextProviderOptions>,
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

  try {
    await fs.writeFile(inputPath, Buffer.from(audio.base64Data, 'base64'));

    const args = [
      '--model',
      options.modelPath,
      '--file',
      inputPath,
      '--language',
      normalizeWhisperLanguage(request.language),
      '--threads',
      `${options.threads}`,
      '--output-json',
      '--output-file',
      outputPrefix,
      '--no-prints',
      '--no-timestamps'
    ];

    await runCommand(options.cliPath, args, TRANSCRIPTION_TIMEOUT_MS);

    const rawJson = await fs.readFile(outputJsonPath, 'utf8');
    const parsed = JSON.parse(rawJson) as WhisperCppJsonOutput;
    const transcript = resolveTranscriptFromJson(parsed);

    return {
      transcript,
      audioDurationMs: audio.durationMs ?? 0
    };
  } finally {
    await fs.rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class WhisperCppSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'whisper-cpp';
  readonly label = 'whisper.cpp';
  readonly kind = 'stt' as const;

  constructor(private readonly options: WhisperCppSpeechToTextProviderOptions) {}

  isConfigured(): boolean {
    return Boolean(this.options.cliPath && this.options.modelPath);
  }

  async healthCheck(settings: VoiceSettings): Promise<VoiceProviderHealth> {
    const active = settings.sttProviderId === this.id;
    if (!this.isConfigured()) {
      return createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        'unavailable',
        false,
        false,
        'Configura ASSEM_WHISPER_CPP_CLI_PATH y ASSEM_WHISPER_CPP_MODEL_PATH.'
      );
    }

    try {
      await fs.access(this.options.cliPath!);
      await fs.access(this.options.modelPath!);
      await runCommand(this.options.cliPath!, ['--help'], HEALTHCHECK_TIMEOUT_MS);

      return createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        'ok',
        true,
        true
      );
    } catch (error) {
      return createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        'unavailable',
        true,
        false,
        error instanceof Error ? sanitizeProcessMessage(error.message) : 'Unknown whisper.cpp error'
      );
    }
  }

  async startListening(
    request: SpeechToTextStartRequest
  ): Promise<SpeechToTextSession> {
    if (!this.isConfigured()) {
      throw new Error('whisper.cpp no esta configurado en este equipo.');
    }

    return new WhisperCppSpeechToTextSession(
      {
        cliPath: this.options.cliPath!,
        modelPath: this.options.modelPath!,
        threads: this.options.threads,
        tempRoot:
          this.options.tempRoot ?? path.join(os.tmpdir(), 'assem-whispercpp')
      },
      request
    );
  }
}

export const whisperCppProviderInternals = {
  normalizeWhisperLanguage,
  resolveTranscriptFromJson
};
