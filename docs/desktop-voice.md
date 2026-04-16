# ASSEM Desktop Voice v1

ASSEM voice v1 is the first desktop-only voice layer on top of the current architecture:

- Tauri remains a thin desktop shell
- the local agent remains the owner of orchestration
- the current chat session remains the single conversation flow
- text chat continues to work even when voice is degraded or unavailable

## What Works Now

- Push-to-talk style voice flow with explicit start/stop controls
- Local transcript insertion into the current chat session
- Assistant response playback through system TTS
- Manual `speak` / `stop` controls
- Optional auto-read for assistant replies
- Voice state projected into the desktop UI and `/api/system`
- Voice settings persisted locally in `voice-settings.json`
- Voice telemetry stored without saving raw audio

## Local Runtime Layout

Current runtime split in the local setup:

- ASSEM source code stays in the repo
- third-party Whisper runtime assets live in a local-only hidden folder: `<repo>/.assem-runtime/whispercpp`
- current expected STT binary path shape: `<repo>/.assem-runtime/whispercpp/bin/Release/whisper-cli.exe`
- current expected model path shape: `<repo>/.assem-runtime/whispercpp/models/ggml-base.bin`
- ASSEM persisted runtime state lives under `ASSEM_DATA_ROOT`

In the current `npm run dev:agent` / `npm run dev:desktop:app` workflow, `ASSEM_DATA_ROOT=./.assem-data` resolves inside the local-agent workspace, so the actual persisted files end up under `apps/local-agent/.assem-data/`.

What is local-only and should not go to GitHub:

- `.assem-runtime/whispercpp/bin/**`
- `.assem-runtime/whispercpp/models/**`
- `apps/local-agent/.assem-data/**`
- transient Whisper temp files under `apps/local-agent/.assem-data/voice-temp/**`

## Providers in This Phase

- STT: `whisper-cpp`
- TTS: `windows-system-tts`
- Legacy reference only: `windows-system-stt` is isolated and not registered in the active runtime

STT runs locally through `whisper.cpp` and a local model file.
TTS still uses Windows system speech through the local agent.

## What Does Not Exist Yet

- wake word
- full duplex conversation
- advanced interruption / barge-in
- mobile voice
- multi-device routing
- advanced emotion or expressive synthesis

## Configuration

Voice-related environment variables:

```env
ASSEM_VOICE_STT_PROVIDER=whisper-cpp
ASSEM_VOICE_TTS_PROVIDER=windows-system-tts
ASSEM_VOICE_LANGUAGE=es-ES
ASSEM_VOICE_AUTO_READ_RESPONSES=false
ASSEM_VOICE_DEBUG=false
ASSEM_WHISPER_CPP_CLI_PATH=
ASSEM_WHISPER_CPP_MODEL_PATH=
ASSEM_WHISPER_CPP_THREADS=4
```

These values are used as defaults. The user can later change auto-read from the desktop UI, and the change is persisted locally.

If the Whisper paths are empty, ASSEM now resolves the standard `.assem-runtime/whispercpp` structure automatically.

`ASSEM_VOICE_DEBUG=true` keeps the last `input.wav` and `transcript.json` inside `ASSEM_DATA_ROOT/voice-temp/session-*` instead of deleting them immediately. It stays off by default.

Bootstrap and validation commands:

```bash
npm run voice:bootstrap
npm run doctor:voice
```

Bootstrap behavior:

- creates `.assem-runtime/whispercpp` if missing
- downloads/extracts the pinned `whisper.cpp` Windows x64 bundle only when the CLI is missing
- downloads `ggml-base.bin` only when the model is missing
- validates the expected CLI/model paths at the end
- removes its temporary bootstrap folder when finished

Optional bootstrap overrides:

- `ASSEM_WHISPER_CPP_ARCHIVE_URL`
- `ASSEM_WHISPER_CPP_MODEL_URL`
- `ASSEM_WHISPER_CPP_ARCHIVE_PATH`
- `ASSEM_WHISPER_CPP_MODEL_SOURCE_PATH`

## How the Flow Works

1. The desktop UI starts the local microphone capture.
2. The local agent opens the selected STT session and tracks voice state.
3. The user stops recording.
4. The desktop UI uploads the captured WAV audio to the local agent.
5. The local agent writes the uploaded audio into a temporary session folder under `ASSEM_DATA_ROOT/voice-temp/session-*`.
6. The local agent transcribes that audio with `whisper.cpp`.
7. The local agent validates the received WAV, logs the effective language, reads the generated JSON transcript and distinguishes empty/too-short/silent/invalid-audio cases.
8. The local agent removes the temporary session folder unless `ASSEM_VOICE_DEBUG=true`.
9. The transcript is sent into the current chat session through the same chat flow as typed input.
10. The assistant response is returned normally as text.
11. If auto-read is enabled, the local agent starts TTS playback for that response.

Before reporting the STT runtime as ready, ASSEM now runs a small Whisper self-check with a generated WAV probe. That check is cached for a short period so normal UI refreshes do not repeatedly pay the full startup cost.

The UI only renders state and sends actions. It does not own the main STT/TTS orchestration logic.

## How to Test It

1. Confirm Windows desktop prerequisites for the shell:

```bash
npm run doctor:desktop
```

2. Start ASSEM desktop with the local agent:

```bash
npm run dev:desktop:app
```

3. Validate the voice runtime:

```bash
npm run doctor:voice
```

4. In the app:

- open the `Voz` tab
- verify:
  - voice availability
  - STT provider
  - TTS provider
  - microphone accessibility
  - auto-read state
  - whether the Whisper runtime is really ready or only partially available
- click `Hablar`
- speak
- click `Detener y enviar`
- confirm the transcript appears as a normal user message
- confirm the assistant response appears in chat
- optionally click `Leer ultima`

## Troubleshooting

If voice shows `no disponible`:

- verify that ASSEM is running on Windows
- run `npm run voice:bootstrap`
- run `npm run doctor:voice`
- verify that `ASSEM_WHISPER_CPP_CLI_PATH` points to a real `whisper-cli.exe` or leave it empty so ASSEM resolves the standard runtime path
- verify that `ASSEM_WHISPER_CPP_MODEL_PATH` points to an installed model such as `ggml-base.bin` or leave it empty so ASSEM resolves the standard runtime path
- verify that the default microphone exists and is enabled
- verify that the default speakers/output device exists for TTS

If Whisper is partially prepared:

- the UI now distinguishes a missing binary from a missing model
- ASSEM reports the exact missing path in the voice status
- the TTS side can still stay usable while STT is degraded

If recording starts but transcription fails:

- check the `Voz` panel error card
- check the last STT diagnostic card for:
  - idioma efectivo
  - duracion del audio
  - tamano del WAV
  - si el transcript JSON llego a generarse
- check recent telemetry in the `Sistema` tab
- check that the microphone permission popup was accepted
- check that the configured `whisper.cpp` model is readable by the local agent
- check that the configured voice language is supported by `whisper.cpp`
- if you need the raw artifacts, set `ASSEM_VOICE_DEBUG=true`, repeat the recording and inspect `apps/local-agent/.assem-data/voice-temp/session-*/input.wav` plus `transcript.json`

If TTS fails but chat still works:

- this is expected degraded behavior
- the assistant text still appears in chat
- the voice state should show the TTS error without breaking the session

## Persistence and Telemetry

Persisted:

- preferred STT provider id
- preferred TTS provider id
- preferred voice language
- auto-read toggle
- the persisted voice settings file itself under `ASSEM_DATA_ROOT/voice-settings.json`

Not persisted:

- raw microphone audio
- Whisper temp files after a successful transcription
- the third-party Whisper runtime folder in GitHub

Cleanup policy:

- successful transcriptions remove their `voice-temp/session-*` working folder immediately
- failed transcriptions also remove that temporary working folder in `finally`
- agent startup removes stale `voice-temp/session-*` and `voice-temp/health-*` folders when they are old enough
- JSON persistence now removes stale `sessions.json.*.tmp`-style leftovers when they are old enough

Voice telemetry records:

- recording start
- STT success/error
- TTS success/error
- provider id
- duration
- text length when applicable
