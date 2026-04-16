# Local Agent API

Base URL: `http://localhost:4318`

## System

- `GET /api/health`
  - returns provider health, uptime and local paths
- `GET /api/system?sessionId=<id>`
  - returns combined UI state:
    - session snapshot
    - health
    - provider runtime:
      - configured provider id
      - active provider id
      - active model
      - fallback used
      - fallback reason
      - Ollama availability/error
    - voice:
      - availability status
      - voice settings
      - STT provider health
      - TTS provider health
      - microphone accessibility
      - current per-session voice state
    - profiles
    - active profile
    - scheduled tasks
    - pending actions
    - overrides
    - telemetry summary
    - tracked sessions
- `GET /api/events?sessionId=<id>`
  - SSE channel for `ready` and `system.updated`

## Sessions and Chat

- `POST /api/session`
- `GET /api/session/:id`
- `GET /api/sessions`
- `POST /api/chat`
- `POST /api/chat/stream`
  - current SSE events:
    - `chat.started`
    - `chat.completed`
  - this endpoint is not token-by-token model streaming yet

## Voice

- `GET /api/voice?sessionId=<id>`
- `POST /api/voice/settings?sessionId=<id>`
- `POST /api/voice/recording/start`
- `POST /api/voice/recording/stop`
- `POST /api/voice/recording/cancel`
- `POST /api/voice/speak`
- `POST /api/voice/stop-speaking`

`POST /api/voice/settings` example:

```json
{
  "settings": {
    "autoReadResponses": true,
    "preferredLanguage": "es-ES"
  }
}
```

`POST /api/voice/recording/start` example:

```json
{
  "sessionId": "session-id"
}
```

`POST /api/voice/recording/stop` example:

```json
{
  "sessionId": "session-id",
  "submitToChat": true,
  "audio": {
    "mimeType": "audio/wav",
    "fileName": "assem-recording.wav",
    "base64Data": "<base64-audio>",
    "durationMs": 1250,
    "diagnostics": {
      "byteLength": 32044,
      "sampleRateHz": 16000,
      "channelCount": 1,
      "bitDepth": 16,
      "approximateDurationMs": 1000,
      "peakLevel": 0.42,
      "rmsLevel": 0.18
    }
  }
}
```

Runtime note:

- the uploaded audio payload is handled locally by the agent
- during `whisper.cpp` transcription the agent writes a temporary file under `ASSEM_DATA_ROOT/voice-temp/session-*`
- after reading the generated JSON output, the agent removes that temporary folder on success
- the same temporary folder is also removed on failure through `finally`
- if `ASSEM_VOICE_DEBUG=true`, that temporary folder is kept so you can inspect `input.wav` and `transcript.json`
- the current STT diagnostic now distinguishes:
  - audio payload missing
  - audio decode failure
  - invalid WAV
  - audio too short
  - near-silent audio
  - transcript JSON missing
  - transcript JSON empty
  - transcript too short
  - likely language mismatch
- provider health for `whisper-cpp` now includes a small real self-check before it reports itself ready
- the active runtime does not register the old Windows STT provider anymore; `windows-system-stt` remains legacy-only code

`POST /api/voice/speak` example:

```json
{
  "sessionId": "session-id",
  "text": "Lee esta respuesta"
}
```

## Action History and Confirmations

- `GET /api/actions?sessionId=<id>`
- `GET /api/pending-actions?sessionId=<id>`
- `POST /api/pending-action`
  - body:

```json
{
  "sessionId": "session-id",
  "approved": true
}
```

## Mode and Overrides

- `GET /api/mode?sessionId=<id>`
- `POST /api/mode`
- `GET /api/overrides?sessionId=<id>`
- `POST /api/overrides`
- `DELETE /api/overrides/:overrideId?sessionId=<id>`

`POST /api/mode` example:

```json
{
  "sessionId": "session-id",
  "activeMode": {
    "privacy": "prefer_local",
    "runtime": "sandbox"
  }
}
```

`POST /api/overrides` example:

```json
{
  "sessionId": "session-id",
  "instruction": "Hoy no me preguntes mas"
}
```

## Profiles

- `GET /api/profiles`
- `POST /api/profiles`
- `POST /api/profiles/activate`
- `GET /api/profiles/:id/export`
- `POST /api/profiles/import`
- `POST /api/profiles/:id/reset`

## Scheduler

- `GET /api/scheduler/tasks`
- `POST /api/scheduler/tasks`
- `POST /api/scheduler/tasks/:id/toggle`
- `DELETE /api/scheduler/tasks/:id`
- `POST /api/scheduler/tasks/:id/run`

Task creation example:

```json
{
  "label": "Daily review",
  "prompt": "Review the current local state",
  "kind": "internal_review",
  "cadence": "daily"
}
```

## Telemetry

- `GET /api/telemetry?limit=20`
- each record includes:
  - telemetry channel (`chat`, `voice_capture`, `voice_stt`, `voice_tts`)
  - provider id
  - model
  - fallback used
  - fallback reason
  - audio duration when applicable
  - text length when applicable
  - sanitized error message when applicable

## Security Notes

- CORS is restricted to configured local origins.
- Errors are sanitized before being returned.
- The local file tool refuses path traversal and any path outside the sandbox root.
- Writes stay inside the sandbox root even in `live` mode.
