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

## Providers in This Phase

- STT: `whisper-cpp`
- TTS: `windows-system-tts`

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
ASSEM_WHISPER_CPP_CLI_PATH=C:\\ruta\\a\\whisper-cli.exe
ASSEM_WHISPER_CPP_MODEL_PATH=C:\\ruta\\a\\ggml-base.bin
ASSEM_WHISPER_CPP_THREADS=4
```

These values are used as defaults. The user can later change auto-read from the desktop UI, and the change is persisted locally.

## How the Flow Works

1. The desktop UI starts the local microphone capture.
2. The local agent opens the selected STT session and tracks voice state.
3. The user stops recording.
4. The desktop UI uploads the captured WAV audio to the local agent.
5. The local agent transcribes that audio with `whisper.cpp`.
6. The transcript is sent into the current chat session through the same chat flow as typed input.
7. The assistant response is returned normally as text.
8. If auto-read is enabled, the local agent starts TTS playback for that response.

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

3. In the app:

- open the `Voz` tab
- verify:
  - voice availability
  - STT provider
  - TTS provider
  - microphone accessibility
  - auto-read state
- click `Hablar`
- speak
- click `Detener y enviar`
- confirm the transcript appears as a normal user message
- confirm the assistant response appears in chat
- optionally click `Leer ultima`

## Troubleshooting

If voice shows `no disponible`:

- verify that ASSEM is running on Windows
- verify that `ASSEM_WHISPER_CPP_CLI_PATH` points to a real `whisper-cli.exe`
- verify that `ASSEM_WHISPER_CPP_MODEL_PATH` points to an installed model such as `ggml-base.bin`
- verify that the default microphone exists and is enabled
- verify that the default speakers/output device exists for TTS

If recording starts but transcription fails:

- check the `Voz` panel error card
- check recent telemetry in the `Sistema` tab
- check that the microphone permission popup was accepted
- check that the configured `whisper.cpp` model is readable by the local agent
- check that the configured voice language is supported by `whisper.cpp`

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

Not persisted:

- raw microphone audio

Voice telemetry records:

- recording start
- STT success/error
- TTS success/error
- provider id
- duration
- text length when applicable
