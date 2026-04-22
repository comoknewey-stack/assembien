# ASSEM Desktop Voice v1

ASSEM voice v1 is the first desktop-only voice layer on top of the current architecture:

- Tauri remains a thin desktop shell
- the local agent remains the owner of orchestration
- the current chat session remains the single conversation flow
- text chat continues to work even when voice is degraded or unavailable

## What Works Now

- `Modo conversacion` flow with explicit on/off control
- Separate `Mute` control that cuts microphone capture even if conversation mode remains enabled
- Turn-taking through local speech/silence detection, without requiring a wake word
- Push-to-talk style voice flow with explicit start/stop controls, kept as the manual fallback/debug path
- Local transcript insertion into the current chat session
- Assistant response playback through system TTS
- Manual `speak` / `stop` controls
- Optional auto-read for assistant replies
- Voice state projected into the desktop UI and `/api/system`
- Voice provider, language, mute and auto-read settings persisted locally in `voice-settings.json`; wake word config stays owned by `.env` and is experimental/legacy
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

- full duplex conversation
- advanced interruption / barge-in
- native low-power wake-word engine
- wake word as the primary voice UX
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
ASSEM_VOICE_MODE_ENABLED_BY_DEFAULT=false
ASSEM_WAKE_WORD_ENABLED=false
ASSEM_WAKE_WORD=prolijo
ASSEM_WAKE_WORD_ALIASES=pro lijo,polijo,prolijos,pro li jo
ASSEM_WAKE_WINDOW_MS=2500
ASSEM_WAKE_INTERVAL_MS=500
ASSEM_ACTIVE_SILENCE_MS=2000
ASSEM_ACTIVE_MAX_MS=30000
ASSEM_ACTIVE_MIN_SPEECH_MS=800
ASSEM_ACTIVE_PREROLL_MS=700
ASSEM_ACTIVE_POSTROLL_MS=500
ASSEM_WAKE_DEBUG=false
ASSEM_WHISPER_CPP_CLI_PATH=
ASSEM_WHISPER_CPP_MODEL_PATH=
ASSEM_WHISPER_CPP_THREADS=4
ASSEM_WHISPER_CPP_BEAM_SIZE=5
ASSEM_WHISPER_CPP_INITIAL_PROMPT=ASSEM. Comandos frecuentes en espanol: que hora es, hora actual, fecha actual, crear archivo, crear carpeta, lista el sandbox, lee el archivo, confirma, cancela, Ollama, whisper.cpp.
```

These values are used as defaults for voice behavior. Auto-read, provider/language and mute settings can be persisted locally, but the active `Modo conversacion` listening state is intentionally not persisted: ASSEM always starts with conversation mode off until the user enables it again in that desktop session. Push-to-talk remains available independently as the manual fallback/debug path.

If the Whisper paths are empty, ASSEM now resolves the standard `.assem-runtime/whispercpp` structure automatically.

Recognition quality controls:

- the desktop recorder now requests browser/OS `autoGainControl` and applies a light local gain normalization when speech is usable but quiet
- conversation mode waits for speech, keeps a short pre-roll, and closes the turn only after sustained silence or the configured max duration is reached
- `ASSEM_ACTIVE_SILENCE_MS`, `ASSEM_ACTIVE_MIN_SPEECH_MS`, `ASSEM_ACTIVE_MAX_MS`, `ASSEM_ACTIVE_PREROLL_MS` and `ASSEM_ACTIVE_POSTROLL_MS` tune turn-taking
- push-to-talk does not use wake windows; it remains the direct manual capture path
- `ASSEM_WHISPER_CPP_BEAM_SIZE` defaults to `5`, which is slower than greedy decoding but improves command recognition
- `ASSEM_WHISPER_CPP_INITIAL_PROMPT` gives Whisper ASSEM-specific words and common Spanish commands such as `hora actual`, `sandbox`, `Ollama`, `crear archivo` and `confirma`
- for materially better STT quality, install a stronger local Whisper model such as `ggml-small.bin` or better and point `ASSEM_WHISPER_CPP_MODEL_PATH` to it; models remain local-only and must not be committed

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

Push-to-talk:

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

This path stays available even when conversation mode is off. It is the fallback for debugging microphones, noisy environments or cases where automatic turn detection is not ideal.

Modo conversacion:

1. The user enables `Modo conversacion` in the desktop UI.
2. If `Mute` is off, the UI requests microphone access and the agent marks the session as `conversation_waiting`.
3. The UI monitors local RMS/peak levels without sending partial transcripts to chat.
4. When speech is detected, the agent marks `speech_detected` / `active_listening` and the UI starts accumulating the spoken turn, including a short pre-roll so the beginning is not clipped.
5. Short pauses do not close the turn. Sustained silence moves through `silence_wait` / `closing_turn`, keeps a short post-roll, and then closes the WAV.
6. The final WAV is sent to `POST /api/voice/active-listening/stop`.
7. The local agent transcribes the final phrase and sends only the final transcript into the normal chat/orchestrator flow.
8. While ASSEM answers, the state moves through `processing` and optionally `speaking` if auto-read is enabled.
9. When the response is done, ASSEM returns to `conversation_waiting` if conversation mode is still enabled and `Mute` is off.
10. If no useful speech is detected, no empty transcript is sent to chat.

Mute:

- `Mute` is separate from conversation mode and is the strong privacy cut-off.
- When muted, the frontend stops/cancels capture and releases microphone resources.
- If conversation mode remains enabled while muted, unmuting lets ASSEM return to `conversation_waiting`.

Wake word:

- Wake word is experimental/legacy and disabled by default with `ASSEM_WAKE_WORD_ENABLED=false`.
- The main voice flow does not require saying `Prolijo`.
- If explicitly enabled for experiments, wake windows still use `POST /api/voice/wake-window`, but this is not the recommended primary UX.

When `Modo conversacion` is disabled, the UI stops its loop, cancels active listening if needed and releases microphone resources. There is no hidden listening while the toggle is off. If ASSEM is closed while conversation mode is enabled, the next launch still starts with conversation mode off for privacy.

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
- enable `Modo conversacion`
- confirm the state shows that ASSEM is waiting for voice, without asking for a wake word
- speak a complete request such as `que hora es`, then pause
- confirm that the request appears as a normal user message and that ASSEM returns to waiting for the next voice turn
- enable `Mute micro` and confirm the UI shows the microphone is off
- disable `Modo conversacion` and confirm the UI shows the microphone is not listening continuously

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
- if transcripts are consistently wrong rather than empty, verify `ASSEM_VOICE_LANGUAGE=es-ES`, keep `ASSEM_WHISPER_CPP_BEAM_SIZE=5` or higher, keep the initial prompt enabled and consider a stronger local model than `ggml-base.bin`
- if you need the raw artifacts, set `ASSEM_VOICE_DEBUG=true`, repeat the recording and inspect `apps/local-agent/.assem-data/voice-temp/session-*/input.wav` plus `transcript.json`

If conversation mode does not capture a turn:

- confirm `Modo conversacion` is enabled and `Mute micro` is off
- check that the microphone permission popup was accepted
- speak for at least `ASSEM_ACTIVE_MIN_SPEECH_MS`
- increase `ASSEM_ACTIVE_SILENCE_MS` if ASSEM cuts turns too early
- increase `ASSEM_ACTIVE_MAX_MS` if long turns are being closed by duration
- increase `ASSEM_ACTIVE_PREROLL_MS` if the first syllables are clipped
- keep `ASSEM_VOICE_LANGUAGE=es-ES` when speaking Spanish
- use `ASSEM_VOICE_DEBUG=true` only while debugging; raw audio is still not stored by default

If experimental wake mode is enabled and does not trigger:

- confirm `ASSEM_WAKE_WORD_ENABLED=true`
- verify `ASSEM_WAKE_WORD` and `ASSEM_WAKE_WORD_ALIASES`
- increase `ASSEM_WAKE_WINDOW_MS` slightly if the wake word is clipped
- increase `ASSEM_WAKE_INTERVAL_MS` if CPU usage feels too high

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
- mute toggle
- voice provider/language/autoread/mute settings
- the persisted voice settings file itself under `ASSEM_DATA_ROOT/voice-settings.json`

Not persisted:

- wake word, aliases, wake-mode thresholds and VAD thresholds; those come from `.env`/runtime config on each agent start
- the active `Modo conversacion` enabled/disabled listening state
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
- conversation mode enabled/disabled
- conversation waiting started
- mute enabled/disabled
- wake listening/window/detection events only when experimental wake is enabled
- active listening started
- active speech/silence detected
- active transcription success/error
- STT success/error
- TTS success/error
- provider id
- duration
- text length when applicable
