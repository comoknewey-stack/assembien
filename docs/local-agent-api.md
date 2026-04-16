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
    - task manager:
      - active task for the requested session
      - persisted tasks visible to that session scope
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

## Task Manager and Task Runtime

- `GET /api/tasks?sessionId=<id>`
- `GET /api/tasks/:taskId/plan`
- `GET /api/tasks/active?sessionId=<id>`
- `POST /api/tasks`
- `POST /api/tasks/runtime`
- `POST /api/tasks/:id/start`
- `POST /api/tasks/:id/progress`
- `POST /api/tasks/:id/phase`
- `POST /api/tasks/:id/artifacts`
- `POST /api/tasks/:id/pause`
- `POST /api/tasks/:id/resume`
- `POST /api/tasks/:id/cancel`
- `POST /api/tasks/:id/complete`
- `POST /api/tasks/:id/fail`

Task state model in this phase:

- `pending`
- `active`
- `paused`
- `blocked`
- `completed`
- `failed`
- `cancelled`

`POST /api/tasks` example:

```json
{
  "sessionId": "session-id",
  "objective": "Preparar el informe semanal",
  "status": "active",
  "currentPhase": "Preparando la tarea",
  "progressPercent": 10,
  "steps": [
    {
      "id": "step-collect",
      "label": "Recopilar notas"
    }
  ],
  "currentStepId": "step-collect"
}
```

`POST /api/tasks/runtime` example:

```json
{
  "sessionId": "session-id",
  "taskType": "research_report_basic",
  "objective": "Preparar un informe semanal",
  "autoStart": true
}
```

`POST /api/tasks/:id/progress` example:

```json
{
  "progressPercent": 35,
  "currentPhase": "Recopilando notas",
  "currentStepId": "step-collect"
}
```

`POST /api/tasks/:id/phase` example:

```json
{
  "currentPhase": "Redactando borrador",
  "currentStepId": "step-draft",
  "currentStepLabel": "Redactar primer borrador",
  "progressPercent": 60
}
```

`POST /api/tasks/:id/artifacts` example:

```json
{
  "kind": "document",
  "label": "Borrador inicial",
  "filePath": "C:/Users/garce/Documents/assem/sandbox/borrador.md",
  "contentType": "text/markdown",
  "description": "Primer borrador del informe"
}
```

`POST /api/tasks/:id/pause` example:

```json
{
  "reason": "Pausa manual desde la UI"
}
```

`POST /api/tasks/:id/fail` example:

```json
{
  "reason": "Falta el archivo fuente requerido"
}
```

Runtime note:

- Task Manager persists locally in `ASSEM_DATA_ROOT/tasks.json`
- it keeps one active task pointer per session
- Planner v1 now creates a persisted plan before runtime-backed task execution starts
- Task Runtime / Executor v1 is the only layer that advances long-running task state automatically
- Interrupt Handler v1 runs inside the orchestrator before model fallback whenever the current session has an active task
- current runtime task type: `research_report_basic`
- current planner-supported task type: `research_report_basic`
- the runtime currently executes real phases:
  - prepare workspace
  - generate report draft
  - write `report.md`
  - write `summary.txt`
- `GET /api/tasks/:taskId/plan` returns the persisted `TaskPlan` associated with that task
- the plan is stored with the task and includes:
  - task type
  - phases
  - steps
  - expected artifacts
  - restrictions
  - refinements
- the orchestrator uses Task Manager state directly for `que estas haciendo`, `cuanto te queda`, `en que vas`, `pausa`, `reanuda` and `cancela`
- the orchestrator also answers `cual es el plan` and `que pasos vas a seguir` from the persisted task plan
- the model is not used to invent task progress or task phase for those questions
- simple interrupt refinements such as `hazlo mas corto`, `hazlo en ingles`, `hazlo en espanol`, `primero dame un resumen` and `anade una tabla` are persisted in task metadata and only affect future compatible steps
- compatible refinements now also update the persisted task plan
- vague corrections such as `eso no era lo que queria` do not silently rewrite the task; ASSEM asks for clarification and keeps the task active
- if the new message is independent, the active task remains active and the chat request continues through the normal tool/model path
- pausing, resuming and cancelling through `/api/tasks/:id/pause|resume|cancel` now route through the runtime executor
- if ASSEM restarts while a runtime task is still `active`, startup recovery pauses that task with a clear reason instead of pretending it resumed safely

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
  - telemetry channel (`chat`, `voice_capture`, `voice_stt`, `voice_tts`, `task_manager`, `task_runtime`, `task_planner`, `task_interrupt`)
  - provider id
  - model
  - fallback used
  - fallback reason
  - audio duration when applicable
  - text length when applicable
  - sanitized error message when applicable
  - task interrupt event types when applicable:
    - `task_interrupt_status_query`
    - `task_interrupt_pause`
    - `task_interrupt_resume`
    - `task_interrupt_cancel`
    - `task_interrupt_refinement`
    - `task_interrupt_clarification`
    - `task_interrupt_independent_query`
  - task planner event types when applicable:
    - `task_plan_created`
    - `task_plan_refined`
    - `task_plan_rejected`
    - `task_plan_applied`

## Security Notes

- CORS is restricted to configured local origins.
- Errors are sanitized before being returned.
- The local file tool refuses path traversal and any path outside the sandbox root.
- Writes stay inside the sandbox root even in `live` mode.
