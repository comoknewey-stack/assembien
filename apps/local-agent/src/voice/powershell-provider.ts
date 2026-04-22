import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import readline from 'node:readline';

import type {
  SpeechToTextProvider,
  SpeechToTextResult,
  SpeechToTextSession,
  SpeechToTextStartRequest,
  TextToSpeechPlayback,
  TextToSpeechProvider,
  TextToSpeechRequest,
  TextToSpeechResult,
  VoiceProviderHealth,
  VoiceSettings
} from '@assem/shared-types';

const WINDOWS_POWERSHELL = 'powershell.exe';
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const SESSION_SHUTDOWN_TIMEOUT_MS = 8_000;
const DEFAULT_VOICE_LANGUAGE = 'es-ES';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeVoiceLanguage(language: string | undefined): string {
  const normalized = (language ?? '').trim();
  if (!normalized) {
    return DEFAULT_VOICE_LANGUAGE;
  }

  if (/^es$/i.test(normalized)) {
    return DEFAULT_VOICE_LANGUAGE;
  }

  if (/^en$/i.test(normalized)) {
    return 'en-US';
  }

  return normalized;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildVoiceLanguageCandidates(language: string | undefined): string[] {
  const normalized = normalizeVoiceLanguage(language);
  const candidates = [normalized];
  const neutral = normalized.split('-')[0]?.toLowerCase();

  if (neutral && !candidates.includes(neutral)) {
    candidates.push(neutral);
  }

  return candidates;
}

function toPowerShellArrayLiteral(values: string[]): string {
  return `@(${values
    .map((value) => `'${escapePowerShellSingleQuoted(value)}'`)
    .join(', ')})`;
}

function createPowerShellVoicePrelude(language: string): string {
  const candidates = toPowerShellArrayLiteral(buildVoiceLanguageCandidates(language));

  return `
function Resolve-AssemPreferredLanguageCandidates {
  return ${candidates}
}

function Resolve-AssemRecognizerInfo {
  $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if (-not $installed -or $installed.Count -eq 0) {
    throw 'No hay ningun reconocedor de Windows Speech instalado.'
  }

  foreach ($candidate in (Resolve-AssemPreferredLanguageCandidates)) {
    $exact = $installed |
      Where-Object { $_.Culture -and $_.Culture.Name -eq $candidate } |
      Select-Object -First 1
    if ($exact) {
      return $exact
    }
  }

  foreach ($candidate in (Resolve-AssemPreferredLanguageCandidates)) {
    $neutral = ($candidate -split '-') | Select-Object -First 1
    if (-not $neutral) {
      continue
    }

    $compatible = $installed |
      Where-Object {
        $_.Culture -and $_.Culture.Name -and (
          $_.Culture.Name -eq $neutral -or $_.Culture.Name.StartsWith($neutral + '-')
        )
      } |
      Select-Object -First 1
    if ($compatible) {
      return $compatible
    }
  }

  return $installed | Select-Object -First 1
}

function Resolve-AssemInstalledVoice($synth) {
  try {
    $voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled }
  } catch {
    return $null
  }

  if (-not $voices -or $voices.Count -eq 0) {
    return $null
  }

  foreach ($candidate in (Resolve-AssemPreferredLanguageCandidates)) {
    $exact = $voices |
      Where-Object { $_.VoiceInfo -and $_.VoiceInfo.Culture -and $_.VoiceInfo.Culture.Name -eq $candidate } |
      Select-Object -First 1
    if ($exact) {
      return $exact
    }
  }

  foreach ($candidate in (Resolve-AssemPreferredLanguageCandidates)) {
    $neutral = ($candidate -split '-') | Select-Object -First 1
    if (-not $neutral) {
      continue
    }

    $compatible = $voices |
      Where-Object {
        $_.VoiceInfo -and $_.VoiceInfo.Culture -and $_.VoiceInfo.Culture.Name -and (
          $_.VoiceInfo.Culture.Name -eq $neutral -or
          $_.VoiceInfo.Culture.Name.StartsWith($neutral + '-')
        )
      } |
      Select-Object -First 1
    if ($compatible) {
      return $compatible
    }
  }

  return $voices | Select-Object -First 1
}
`;
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function sanitizePowerShellMessage(message: string): string {
  const withoutCliXmlHeader = message.replace(/^#<\s*CLIXML\s*/i, '');
  const decodedCliXml = withoutCliXmlHeader.replace(
    /_x([0-9A-Fa-f]{4})_/g,
    (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))
  );
  const withoutXmlTags = decodedCliXml.replace(/<[^>]+>/g, ' ');

  const normalized = withoutXmlTags
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    !normalized ||
    normalized === 'CLIXML' ||
    /^https?:\/\//i.test(normalized) ||
    /^(Objs|Obj|MS|TN|T|S)$/i.test(normalized)
  ) {
    return '';
  }

  if (/^<.*>$/.test(message.trim())) {
    return normalized;
  }

  return message
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createProviderHealth(
  providerId: string,
  label: string,
  kind: 'stt' | 'tts',
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

function isWindowsPlatform(): boolean {
  return process.platform === 'win32';
}

function spawnPowerShellProcess(
  script: string,
  environment: NodeJS.ProcessEnv = {}
): ChildProcessWithoutNullStreams {
  const encodedCommand = encodePowerShellCommand(script);

  return spawn(
    WINDOWS_POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
      env: {
        ...process.env,
        ...environment
      }
    }
  );
}

function killProcess(child: ChildProcess): void {
  if (!child.killed) {
    child.kill();
  }
}

function createSttProbeScript(language: string): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  ${createPowerShellVoicePrelude(language)}
  $recognizerInfo = Resolve-AssemRecognizerInfo
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizerInfo)
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.SetInputToDefaultAudioDevice()
  Write-Output ('OK::' + $recognizerInfo.Culture.Name)
} catch {
  Write-Output ('ERROR::' + $_.Exception.Message)
  exit 1
}
`;
}

function createTtsProbeScript(language: string): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  ${createPowerShellVoicePrelude(language)}
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voice = Resolve-AssemInstalledVoice $synth
  if ($voice) {
    $synth.SelectVoice($voice.VoiceInfo.Name)
    Write-Output ('OK::' + $voice.VoiceInfo.Name + '|' + $voice.VoiceInfo.Culture.Name)
  } else {
    Write-Output 'OK::default'
  }
} catch {
  Write-Output ('ERROR::' + $_.Exception.Message)
  exit 1
}
`;
}

function createSttSessionScript(language: string): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  ${createPowerShellVoicePrelude(language)}
  $recognizerInfo = Resolve-AssemRecognizerInfo
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizerInfo)
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.SetInputToDefaultAudioDevice()
  $recognizer.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
  $recognizer.BabbleTimeout = [TimeSpan]::FromSeconds(2)
  $recognizer.EndSilenceTimeout = [TimeSpan]::FromSeconds(1)
  $recognizer.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromSeconds(1)
  $segments = New-Object System.Collections.Generic.List[string]
  $completed = New-Object System.Threading.ManualResetEvent($false)
  $script:recognitionError = $null

  $recognizer.add_SpeechRecognized({
    param($sender, $eventArgs)
    if ($eventArgs.Result -and $eventArgs.Result.Text) {
      [void]$segments.Add($eventArgs.Result.Text)
    }
  })

  $recognizer.add_RecognizeCompleted({
    param($sender, $eventArgs)
    if ($eventArgs.Error) {
      $script:recognitionError = $eventArgs.Error.Message
    }
    $completed.Set() | Out-Null
  })

  Write-Output ('READY::' + $recognizerInfo.Culture.Name)
  $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

  while ($true) {
    if ([Console]::In.Peek() -ge 0) {
      $line = [Console]::In.ReadLine()
      if ($line -eq 'STOP') {
        break
      }
      if ($line -eq 'CANCEL') {
        $recognizer.RecognizeAsyncCancel()
        $completed.WaitOne(5000) | Out-Null
        Write-Output 'CANCELLED'
        exit 0
      }
    }

    Start-Sleep -Milliseconds 100
  }

  $recognizer.RecognizeAsyncStop()
  $completed.WaitOne(10000) | Out-Null

  if ($script:recognitionError) {
    Write-Output ('ERROR::' + $script:recognitionError)
    exit 1
  }

  $transcript = ($segments | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }) -join ' '
  Write-Output ('RESULT::' + $transcript)
  exit 0
} catch {
  Write-Output ('ERROR::' + $_.Exception.Message)
  exit 1
}
`;
}

function createTtsSessionScript(language: string): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $text = $env:ASSEM_TTS_TEXT
  ${createPowerShellVoicePrelude(language)}
  if (-not $text) {
    Write-Output 'ERROR::No text was provided for speech synthesis.'
    exit 1
  }

  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voice = Resolve-AssemInstalledVoice $synth
  if ($voice) {
    $synth.SelectVoice($voice.VoiceInfo.Name)
    Write-Output ('READY::' + $voice.VoiceInfo.Name + '|' + $voice.VoiceInfo.Culture.Name)
  } else {
    Write-Output 'READY::default'
  }

  $synth.SpeakAsync($text) | Out-Null

  while ($synth.State -ne [System.Speech.Synthesis.SynthesizerState]::Ready) {
    Start-Sleep -Milliseconds 100
  }

  Write-Output 'DONE'
  exit 0
} catch {
  Write-Output ('ERROR::' + $_.Exception.Message)
  exit 1
}
`;
}

async function runPowerShellProbe(
  script: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    if (!isWindowsPlatform()) {
      reject(new Error('Windows speech providers are only available on Windows.'));
      return;
    }

    const child = spawnPowerShellProcess(script, environment);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      killProcess(child);
      if (!settled) {
        settled = true;
        reject(new Error('Timed out while probing the Windows speech provider.'));
      }
    }, HEALTHCHECK_TIMEOUT_MS);

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

      const output = sanitizePowerShellMessage(stdout.join(' '));
      const errorOutput = sanitizePowerShellMessage(stderr.join(' '));
      const combinedError =
        output.startsWith('ERROR::')
          ? output.slice('ERROR::'.length)
          : errorOutput || output;

      if (code !== 0) {
        settled = true;
        reject(new Error(combinedError || 'The Windows speech provider probe failed.'));
        return;
      }

      settled = true;
      resolve(output);
    });
  });
}

class WindowsSpeechToTextSession implements SpeechToTextSession {
  private readonly startedAt = Date.now();
  private readonly completion: Promise<SpeechToTextResult>;
  private readonly outputLines: string[] = [];
  private readonly errorLines: string[] = [];
  private transcript = '';
  private stopRequested = false;
  private cancelled = false;
  private resolved = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly stdoutReader: readline.Interface,
    private readonly stderrReader: readline.Interface
  ) {
    const handleStdoutLine = (line: string) => {
      const trimmed = sanitizePowerShellMessage(line);
      if (!trimmed || trimmed.startsWith('READY') || trimmed === 'CANCELLED') {
        return;
      }

      if (trimmed.startsWith('RESULT::')) {
        this.transcript = trimmed.slice('RESULT::'.length).trim();
        return;
      }

      if (trimmed.startsWith('ERROR::')) {
        this.errorLines.push(trimmed.slice('ERROR::'.length).trim());
        return;
      }

      this.outputLines.push(trimmed);
    };

    const handleStderrLine = (line: string) => {
      const trimmed = sanitizePowerShellMessage(line);
      if (trimmed) {
        this.errorLines.push(trimmed);
      }
    };

    stdoutReader.on('line', handleStdoutLine);
    stderrReader.on('line', handleStderrLine);

    this.completion = new Promise<SpeechToTextResult>((resolve, reject) => {
      const cleanup = () => {
        stdoutReader.off('line', handleStdoutLine);
        stderrReader.off('line', handleStderrLine);
        stdoutReader.close();
        stderrReader.close();
      };

      child.on('error', (error) => {
        if (!this.resolved) {
          this.resolved = true;
          cleanup();
          reject(error);
        }
      });

      child.on('exit', (code) => {
        if (this.resolved) {
          return;
        }

        this.resolved = true;
        cleanup();
        const audioDurationMs = Math.max(0, Date.now() - this.startedAt);
        if (this.cancelled) {
          resolve({
            transcript: '',
            audioDurationMs
          });
          return;
        }

        if (code !== 0) {
          const explicitError = this.errorLines.find(Boolean);
          reject(
            new Error(
              explicitError ||
                this.outputLines.find(Boolean) ||
                'The Windows speech recognition session failed.'
            )
          );
          return;
        }

        resolve({
          transcript: this.transcript,
          audioDurationMs
        });
      });
    });
  }

  async stop(): Promise<SpeechToTextResult> {
    if (this.cancelled) {
      throw new Error('The recording was already cancelled.');
    }

    if (!this.stopRequested) {
      this.stopRequested = true;
      this.child.stdin.write('STOP\n');
    }

    return await this.completion;
  }

  async cancel(): Promise<void> {
    if (this.cancelled) {
      return;
    }

    this.cancelled = true;

    try {
      this.child.stdin.write('CANCEL\n');
    } catch {
      killProcess(this.child);
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killProcess(this.child);
        resolve();
      }, SESSION_SHUTDOWN_TIMEOUT_MS);

      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

class WindowsTextToSpeechPlayback implements TextToSpeechPlayback {
  readonly completed: Promise<TextToSpeechResult>;
  private readonly startedAt = Date.now();
  private readonly outputLines: string[] = [];
  private readonly errorLines: string[] = [];
  private stopped = false;
  private resolved = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly stdoutReader: readline.Interface,
    private readonly stderrReader: readline.Interface
  ) {
    const handleStdoutLine = (line: string) => {
      const trimmed = sanitizePowerShellMessage(line);
      if (!trimmed || trimmed.startsWith('READY::')) {
        return;
      }

      if (trimmed.startsWith('ERROR::')) {
        this.errorLines.push(trimmed.slice('ERROR::'.length).trim());
        return;
      }

      this.outputLines.push(trimmed);
    };

    const handleStderrLine = (line: string) => {
      const trimmed = sanitizePowerShellMessage(line);
      if (trimmed) {
        this.errorLines.push(trimmed);
      }
    };

    stdoutReader.on('line', handleStdoutLine);
    stderrReader.on('line', handleStderrLine);

    this.completed = new Promise<TextToSpeechResult>((resolve, reject) => {
      const cleanup = () => {
        stdoutReader.off('line', handleStdoutLine);
        stderrReader.off('line', handleStderrLine);
        stdoutReader.close();
        stderrReader.close();
      };

      child.on('error', (error) => {
        if (!this.resolved) {
          this.resolved = true;
          cleanup();
          reject(error);
        }
      });

      child.on('exit', (code) => {
        if (this.resolved) {
          return;
        }

        this.resolved = true;
        cleanup();
        const audioDurationMs = Math.max(0, Date.now() - this.startedAt);
        if (code !== 0) {
          const explicitError = this.errorLines.find(Boolean);
          reject(
            new Error(
              explicitError ||
                this.outputLines.find(Boolean) ||
                'The Windows speech synthesis session failed.'
            )
          );
          return;
        }

        resolve({ audioDurationMs });
      });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    killProcess(this.child);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killProcess(this.child);
        resolve();
      }, SESSION_SHUTDOWN_TIMEOUT_MS);

      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export const powerShellProviderInternals = {
  sanitizePowerShellMessage,
  createTtsProbeScript,
  createTtsSessionScript
};

export const legacyWindowsSttProviderInternals = {
  sanitizePowerShellMessage,
  createSttProbeScript,
  createSttSessionScript
};

// Legacy STT provider kept for reference only.
// ASSEM no longer registers this provider in runtime because the active desktop STT flow
// goes through whisper.cpp with browser-recorded audio uploaded to the local agent.
export class LegacyWindowsSpeechToTextProvider implements SpeechToTextProvider {
  readonly id = 'windows-system-stt';
  readonly label = 'Windows System Speech Recognition';
  readonly kind = 'stt' as const;

  isConfigured(): boolean {
    return isWindowsPlatform();
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
        'Solo disponible en Windows.'
      );
    }

    try {
      await runPowerShellProbe(
        createSttProbeScript(normalizeVoiceLanguage(settings.preferredLanguage))
      );

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
        error instanceof Error ? sanitizePowerShellMessage(error.message) : 'Unknown error'
      );
    }
  }

  async startListening(
    request: SpeechToTextStartRequest
  ): Promise<SpeechToTextSession> {
    if (!this.isConfigured()) {
      throw new Error('Windows speech recognition is not available on this platform.');
    }

    const language = normalizeVoiceLanguage(request.language);
    const child = spawnPowerShellProcess(createSttSessionScript(language), {
      ASSEM_VOICE_LANGUAGE: language
    });
    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    await new Promise<void>((resolve, reject) => {
      const stderrLines: string[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          killProcess(child);
          reject(new Error('Timed out while opening the microphone.'));
        }
      }, HEALTHCHECK_TIMEOUT_MS);

      const handleStdoutLine = (line: string) => {
        const trimmed = sanitizePowerShellMessage(line);
        if (settled) {
          return;
        }

        if (trimmed.startsWith('READY')) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          resolve();
          return;
        }

        if (trimmed.startsWith('ERROR::')) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          killProcess(child);
          reject(new Error(trimmed.slice('ERROR::'.length).trim()));
        }
      };

      const handleStderrLine = (line: string) => {
        const trimmed = sanitizePowerShellMessage(line);
        if (trimmed) {
          stderrLines.push(trimmed);
        }
      };

      const handleChildError = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          reject(error);
        }
      };

      const handleChildExit = (code: number | null) => {
        if (!settled) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          reject(
            new Error(
              code === 0
                ? 'The recording session ended before it was ready.'
                : stderrLines.find(Boolean) ||
                    'The recording session failed before it was ready.'
            )
          );
        }
      };

      const cleanup = () => {
        stdoutReader.off('line', handleStdoutLine);
        stderrReader.off('line', handleStderrLine);
        child.off('error', handleChildError);
        child.off('exit', handleChildExit);
      };

      stdoutReader.on('line', handleStdoutLine);
      stderrReader.on('line', handleStderrLine);
      child.on('error', handleChildError);
      child.on('exit', handleChildExit);
    });

    return new WindowsSpeechToTextSession(child, stdoutReader, stderrReader);
  }
}

export class WindowsTextToSpeechProvider implements TextToSpeechProvider {
  readonly id = 'windows-system-tts';
  readonly label = 'Windows System Speech Synthesis';
  readonly kind = 'tts' as const;

  isConfigured(): boolean {
    return isWindowsPlatform();
  }

  async healthCheck(settings: VoiceSettings): Promise<VoiceProviderHealth> {
    const active = settings.ttsProviderId === this.id;
    if (!this.isConfigured()) {
      return createProviderHealth(
        this.id,
        this.label,
        this.kind,
        active,
        'unavailable',
        false,
        false,
        'Solo disponible en Windows.'
      );
    }

    try {
      await runPowerShellProbe(
        createTtsProbeScript(normalizeVoiceLanguage(settings.preferredLanguage))
      );

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
        'degraded',
        true,
        false,
        error instanceof Error ? sanitizePowerShellMessage(error.message) : 'Unknown error'
      );
    }
  }

  async speak(request: TextToSpeechRequest): Promise<TextToSpeechPlayback> {
    if (!this.isConfigured()) {
      throw new Error('Windows speech synthesis is not available on this platform.');
    }

    const language = normalizeVoiceLanguage(request.language);
    const child = spawnPowerShellProcess(createTtsSessionScript(language), {
      ASSEM_VOICE_LANGUAGE: language,
      ASSEM_TTS_TEXT: request.text
    });
    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    await new Promise<void>((resolve, reject) => {
      const stderrLines: string[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          killProcess(child);
          reject(new Error('Timed out while starting speech synthesis.'));
        }
      }, HEALTHCHECK_TIMEOUT_MS);

      const handleStdoutLine = (line: string) => {
        const trimmed = sanitizePowerShellMessage(line);
        if (settled) {
          return;
        }

        if (trimmed.startsWith('READY::')) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          resolve();
          return;
        }

        if (trimmed.startsWith('ERROR::')) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          killProcess(child);
          reject(new Error(trimmed.slice('ERROR::'.length).trim()));
        }
      };

      const handleStderrLine = (line: string) => {
        const trimmed = sanitizePowerShellMessage(line);
        if (trimmed) {
          stderrLines.push(trimmed);
        }
      };

      const handleChildError = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          reject(error);
        }
      };

      const handleChildExit = (code: number | null) => {
        if (!settled && code !== 0) {
          settled = true;
          cleanup();
          clearTimeout(timer);
          reject(
            new Error(
              stderrLines.find(Boolean) ||
                'The speech synthesis session failed before playback.'
            )
          );
        }
      };

      const cleanup = () => {
        stdoutReader.off('line', handleStdoutLine);
        stderrReader.off('line', handleStderrLine);
        child.off('error', handleChildError);
        child.off('exit', handleChildExit);
      };

      stdoutReader.on('line', handleStdoutLine);
      stderrReader.on('line', handleStderrLine);
      child.on('error', handleChildError);
      child.on('exit', handleChildExit);
    });

    return new WindowsTextToSpeechPlayback(child, stdoutReader, stderrReader);
  }
}
