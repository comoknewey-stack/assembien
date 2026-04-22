# ASSEM

ASSEM is a local-first assistant MVP built as a modular TypeScript monorepo. The desktop UI stays thin, the local agent owns orchestration and policy, providers remain interchangeable, and persistence is local by default.

## What Works Now

- Local desktop chat connected to a local HTTP agent.
- Native desktop shell wiring with Tauri, while keeping the local HTTP agent separate from the frontend.
- First desktop voice flow:
  - `Modo conversacion` toggle for continuous turn-taking without a wake word
  - separate `Mute` control that cuts microphone capture even when conversation mode is enabled
  - push-to-talk start/stop kept as a manual fallback/debug path
  - active conversation turns close on sustained silence or max duration
  - local transcript routed into the current chat session
  - optional auto-read for assistant replies
  - manual speak/stop controls for the latest assistant response
- Planner v1 for supported open tasks:
  - classify a supported objective
  - create a short persisted plan
  - attach real phases, steps and expected artifacts before runtime execution
- Task Manager v1 plus Task Runtime / Executor v1 with one persisted active task per session, real phase execution, artifact registration and deterministic chat answers for status, progress, pause, resume and cancel.
- Interrupt Handler v1 to distinguish active-task control, active-task refinements, clarifications and independent questions without losing the running task.
- Persistent sessions, task state, action history, profile memory, scheduler state and telemetry.
- Safe privacy/runtime modes:
  - `local_only`
  - `prefer_local`
  - `balanced`
  - `cloud_allowed`
  - `sandbox`
  - `live`
- Stable local API for chat, task state, confirmations, overrides, modes, health, profiles and scheduler.
- Local telemetry stored separately from the action log.
- Local tools for:
  - current time
  - mock calendar list/create
  - sandbox file create
  - sandbox directory list
  - sandbox file read
- Temporary policy overrides such as `Hoy no me preguntes mas`, with expiry, visibility and manual cancellation.
- Basic safe scheduler for reminders, internal reviews, summaries and simple checks.
- Provider router with health checks, timeout, ordered fallback and mode-aware selection.
- Ollama local provider wiring with ordered fallback to `demo-local` when Ollama is unavailable, unhealthy or times out.
- SSE event channel for state updates and a chat stream endpoint that emits lifecycle/completion events today, ready for finer-grained token streaming later.

## Still Mocked

- The calendar provider is still mock-only.
- `demo-local` remains a deterministic fallback provider for local development and failure recovery.
- Scheduler execution is intentionally limited to safe internal tasks. It does not perform aggressive system automation.
- Voice is desktop-only in this phase. The main flow is conversation mode plus explicit mute and push-to-talk fallback; it still does not include full duplex, always-on listening while disabled, advanced barge-in or a native ultra-low-power wake engine.

## Repository Structure

- `apps/desktop`: React desktop shell.
- `apps/local-agent`: local HTTP API and runtime wiring.
- `packages/shared-types`: contracts for providers, router, tools, memory, scheduler, telemetry and API payloads.
- `packages/config`: environment-driven runtime config.
- `packages/persistence`: local JSON/JSONL persistence helpers.
- `packages/memory`: session store and profile memory backend.
- `packages/model-router`: provider selection, timeout and fallback logic.
- `packages/policy-engine`: confirmation policy and temporary overrides.
- `packages/orchestrator`: chat orchestration and tool execution flow.
- `packages/task-manager`: persisted long-running task state and progress tracking.
- `packages/planner`: deterministic planning layer for supported long-running tasks.
- `packages/task-runtime`: background executor that advances persisted tasks through real phases.
- `packages/interrupt-handler`: deterministic active-task interruption classifier.
- `packages/scheduler`: safe internal task scheduler.
- `packages/telemetry`: persistent local telemetry sink.
- `packages/sdk`: frontend client for the local agent API.
- `packages/tool-registry`: tool registration and summaries.
- `integrations/*`: tools and provider adapters for clock, calendar and local files.
- `providers/*`: engine/model providers.
- `docs/`: technical documentation.
- `.assem-runtime/`: local-only third-party voice runtime assets for Whisper STT on this machine. It is ignored and should not be committed.
- `apps/local-agent/.assem-data/`: local-only persisted state for the current dev workflow. It is ignored and should not be committed.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- For the native Tauri desktop shell on Windows:
  - Microsoft C++ Build Tools with `Desktop development with C++`
  - Microsoft Edge WebView2 Runtime
  - Rust toolchain (`rustup`, `cargo`, `rustc`)

## Environment

Copy `.env.example` to `.env` if you want to override defaults.

Available variables:

- `ASSEM_AGENT_PORT=4318`
- `ASSEM_SANDBOX_ROOT=./sandbox`
- `ASSEM_DATA_ROOT=./.assem-data`
- `ASSEM_DEFAULT_PROVIDER=ollama`
- `ASSEM_OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `ASSEM_OLLAMA_MODEL=llama3.2:latest`
- `ASSEM_PROVIDER_TIMEOUT_MS=15000`
- `ASSEM_VOICE_STT_PROVIDER=whisper-cpp`
- `ASSEM_VOICE_TTS_PROVIDER=windows-system-tts`
- `ASSEM_VOICE_LANGUAGE=es-ES`
- `ASSEM_VOICE_AUTO_READ_RESPONSES=false`
- `ASSEM_VOICE_DEBUG=false`
- `ASSEM_VOICE_MODE_ENABLED_BY_DEFAULT=false`
- `ASSEM_WAKE_WORD_ENABLED=false`
- `ASSEM_WAKE_WORD=prolijo`
- `ASSEM_WAKE_WORD_ALIASES=pro lijo,polijo,prolijos,pro li jo`
- `ASSEM_WAKE_WINDOW_MS=2500`
- `ASSEM_WAKE_INTERVAL_MS=500`
- `ASSEM_ACTIVE_SILENCE_MS=2000`
- `ASSEM_ACTIVE_MAX_MS=30000`
- `ASSEM_ACTIVE_MIN_SPEECH_MS=800`
- `ASSEM_ACTIVE_PREROLL_MS=700`
- `ASSEM_ACTIVE_POSTROLL_MS=500`
- `ASSEM_WAKE_DEBUG=false`
- `ASSEM_WHISPER_CPP_CLI_PATH=`
- `ASSEM_WHISPER_CPP_MODEL_PATH=`
- `ASSEM_WHISPER_CPP_THREADS=4`
- `ASSEM_WHISPER_CPP_BEAM_SIZE=5`
- `ASSEM_WHISPER_CPP_INITIAL_PROMPT=ASSEM. Comandos frecuentes en espanol: que hora es, hora actual, fecha actual, crear archivo, crear carpeta, lista el sandbox, lee el archivo, confirma, cancela, Ollama, whisper.cpp.`
- `ASSEM_ALLOWED_ORIGINS=http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost`

## Voice Setup

Current voice providers in this phase:

- STT: `whisper-cpp`
- TTS: `windows-system-tts`
- Legacy STT retained only as isolated reference code: `windows-system-stt` is not registered in runtime

This voice phase is local-first and desktop-only:

- microphone capture happens in the desktop UI and the local agent keeps the session orchestration
- STT runs locally through `whisper.cpp`
- `Modo conversacion` is explicit: when it is off, the desktop UI stops microphone capture
- when `Modo conversacion` is on and the microphone is not muted, the UI waits for speech, captures one complete turn, closes it after sustained silence or max duration, transcribes it and sends the transcript through the normal chat/orchestrator path
- `Mute` is a separate privacy control: when it is active, the microphone is not captured even if conversation mode remains enabled
- push-to-talk remains available as a manual fallback/debug path
- the active conversation listening state is not restored on startup; ASSEM always launches with conversation mode off until the user enables it again
- captured microphone audio is lightly normalized before WAV encoding when it is usable but too quiet
- Whisper runs with an initial ASSEM command prompt and configurable beam search to improve Spanish command recognition
- transcripts are inserted into the current chat session
- assistant replies can be read aloud automatically or manually
- text chat keeps working normally even if voice is unavailable

Wake word code is now isolated as experimental/legacy and disabled by default with `ASSEM_WAKE_WORD_ENABLED=false`. The main voice experience no longer requires saying `Prolijo`; future wake-word work should use a dedicated local detector rather than Whisper windows as the primary UX.

Current local runtime layout used by this setup:

- recommended local runtime folder: `<repo>/.assem-runtime/whispercpp`
- current STT binary path shape: `<repo>/.assem-runtime/whispercpp/bin/Release/whisper-cli.exe`
- current Whisper model path shape: `<repo>/.assem-runtime/whispercpp/models/ggml-base.bin`
- this folder contains third-party binaries and downloaded models only; it is not part of the repo
- ASSEM state is separate and currently lives under `apps/local-agent/.assem-data` when the agent is started through the workspace scripts

You can prepare that runtime from the repo itself:

```bash
npm run voice:bootstrap
```

The bootstrap is idempotent:

- if `.assem-runtime/whispercpp` is already ready, it does not redownload or duplicate files
- if the runtime binary is missing, it downloads and extracts the pinned `whisper.cpp` Windows x64 bundle
- if the default model is missing, it downloads `ggml-base.bin`
- it validates the expected binary/model paths at the end
- it removes its temporary download/extraction folder when finished

Optional bootstrap overrides:

- `ASSEM_WHISPER_CPP_ARCHIVE_URL`
- `ASSEM_WHISPER_CPP_MODEL_URL`
- `ASSEM_WHISPER_CPP_ARCHIVE_PATH`
- `ASSEM_WHISPER_CPP_MODEL_SOURCE_PATH`

Runtime discovery is also stricter now:

- if `ASSEM_WHISPER_CPP_CLI_PATH` and `ASSEM_WHISPER_CPP_MODEL_PATH` are empty, ASSEM resolves the standard `.assem-runtime/whispercpp` layout automatically
- if the binary is missing, the voice state reports that exact binary path
- if the model is missing, the voice state reports that exact model path
- if both files exist, ASSEM runs a small Whisper self-check instead of stopping at `--help`

Quick voice test:

1. Prepare the local Whisper runtime:

```bash
npm run voice:bootstrap
```

2. Make sure you are on Windows with a working default microphone and speakers.
3. Keep or copy the voice defaults in `.env`:

```bash
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

Leave those two Whisper paths empty if you want ASSEM to use the standard `.assem-runtime/whispercpp` layout automatically.

For better recognition quality, keep `ASSEM_VOICE_LANGUAGE=es-ES`, speak for at least one full second, keep the microphone close, and prefer a stronger Whisper model by setting `ASSEM_WHISPER_CPP_MODEL_PATH` to an installed `ggml-small.bin` or better model. Larger models are not committed to the repo and should stay inside `.assem-runtime` or another local-only path.

If you need to debug a failed transcription end to end, set:

```bash
ASSEM_VOICE_DEBUG=true
```

With that flag enabled, the agent keeps `input.wav` and `transcript.json` under `apps/local-agent/.assem-data/voice-temp/session-*` instead of deleting them immediately.

4. Validate the real voice runtime before opening the app:

```bash
npm run doctor:voice
```

5. Start the native desktop shell:

```bash
npm run dev:desktop:app
```

6. In the desktop app:
  - open `Voz`
  - confirm that voice shows `lista` or `parcial`
  - confirm that the STT provider is `whisper.cpp`
  - enable `Modo conversacion` to let ASSEM listen for complete spoken turns without a wake word
  - use `Mute micro` whenever you want the microphone fully off
  - speak one complete phrase and pause so silence detection can close the turn
  - confirm that the transcript appears as a normal user message in the current session
  - click `Hablar`
  - speak
  - click `Detener y enviar`
  - use push-to-talk as the manual fallback/debug path
  - click `Leer ultima` or enable `Autolectura de respuestas`
  - wake word is experimental/legacy and only runs if explicitly enabled with `ASSEM_WAKE_WORD_ENABLED=true`

If voice is partially available:

- missing STT keeps text chat and TTS usable
- missing TTS keeps text chat and STT usable
- if both are unavailable, the desktop still works in text mode
- the voice panel now distinguishes between runtime ready, missing Whisper binary, missing Whisper model, partial voice availability and recent runtime errors
- failed transcriptions now distinguish between:
  - audio too short
  - audio almost silent
  - invalid WAV
  - missing/empty transcript JSON
  - transcript too short
  - likely language mismatch
- the voice panel also makes explicit that Windows STT is legacy and not active in runtime

## Ollama Setup

Basic local setup:

1. Install Ollama on the machine that will run ASSEM.
2. Start the Ollama service or app so it listens on `http://127.0.0.1:11434`.
3. Pull a test model:

```bash
ollama pull llama3.2:latest
```

4. Create the local env file and keep it aligned with the Ollama endpoint and model:

```bash
cp .env.example .env
```

```bash
ASSEM_DEFAULT_PROVIDER=ollama
ASSEM_OLLAMA_BASE_URL=http://127.0.0.1:11434
ASSEM_OLLAMA_MODEL=llama3.2:latest
```

5. Start ASSEM with `npm run dev`.

How to confirm ASSEM is using Ollama:

- In the desktop System panel:
  - `Configured provider` should be `ollama`
  - `Runtime provider` should switch to `ollama` after a model-routed chat turn
  - the model badges should show either the active model for the last routed turn or the resolved configured model when the session has not used Ollama yet
- In telemetry:
  - recent entries should show `providerId: ollama`
  - fallback fields stay empty when Ollama handled the turn directly
- In `GET /api/health`:
  - the Ollama provider should report `status: ok`

How to detect fallback to demo-local:

- The System panel shows `Fallback used: yes`
- The runtime card displays the fallback reason
- Recent telemetry entries show `providerId: demo-local` plus the fallback reason

Troubleshooting:

- If Ollama is installed but not reachable, start it and re-check `GET /api/health`.
- If health is `degraded`, the configured model is usually missing and needs `ollama pull <model>`.
- If Ollama is too slow for `ASSEM_PROVIDER_TIMEOUT_MS`, ASSEM falls back to `demo-local` and records the timeout reason.
- If you want to force the deterministic fallback provider during local debugging, set `ASSEM_DEFAULT_PROVIDER=demo-local`.

## Install

```bash
npm install
```

If you want the native desktop shell as well, install the OS prerequisites first. On Windows, the official Tauri prerequisites are documented here:

- [Tauri Windows prerequisites](https://v2.tauri.app/fr/start/prerequisites/)
- [Tauri CLI reference](https://v2.tauri.app/ko/reference/cli/)

## Run

Start desktop and local agent together:

```bash
npm run dev
```

Start only the agent:

```bash
npm run dev:agent
```

Start only the desktop shell:

```bash
npm run dev:desktop
```

Start the native Tauri desktop shell plus the local agent:

```bash
npm run dev:desktop:app
```

This keeps the current Vite workflow intact:

- `npm run dev`: agent + web desktop
- `npm run dev:agent`: agent only
- `npm run dev:desktop`: web desktop only
- `npm run dev:desktop:app`: agent + native Tauri shell

The native shell still talks to the same local HTTP agent on `http://127.0.0.1:4318`.

Default local URLs:

- agent: `http://localhost:4318`
- desktop: `http://localhost:1420`

## Build

```bash
npm run build
```

This runs repository-wide type-checking and the workspace build commands required by the current MVP.

Build the native desktop shell:

```bash
npm run build:desktop
```

Check whether the local machine is ready for Tauri:

```bash
npm run doctor:desktop
```

Check whether Whisper + Windows TTS are really ready:

```bash
npm run doctor:voice
```

## Test

```bash
npm test
```

## Persistence

ASSEM persists local state under `ASSEM_DATA_ROOT`:

- `sessions.json`: session snapshots, action history, overrides and session-scoped mock calendar state.
- `tasks.json`: Task Manager state, active task pointers per session, persisted plan, runtime metadata, progress and artifacts.
- `profiles.json`: profile memory packs and active profile pointer.
- `scheduler.json`: scheduled tasks and last run metadata.
- `telemetry.jsonl`: per-interaction telemetry records.
- `voice-settings.json`: persisted voice provider, language, auto-read and mute settings. Active conversation listening is never restored on startup. Wake word and VAD thresholds are owned by `.env`/runtime config, not by this file.
- `voice-temp/`: transient files created during Whisper transcription and removed after successful processing.
- `*.tmp` sibling files next to JSON stores: stale persistence leftovers that ASSEM now cleans when they are old enough.

The persistence layer is abstracted behind file-backed helpers so the storage backend can later be swapped for SQLite without changing the higher-level interfaces.

In the current local dev workflow, `ASSEM_DATA_ROOT=./.assem-data` is resolved from the local-agent workspace, so these files end up under `apps/local-agent/.assem-data/`.

In that same workflow, `ASSEM_SANDBOX_ROOT=./sandbox` is also resolved from the local-agent workspace, so sandbox files end up under `apps/local-agent/sandbox/` unless you override the path explicitly.

## Policy and Confirmations

- Read-only tools run without confirmation.
- Write tools remain sandboxed and request confirmation unless policy allows otherwise.
- Temporary overrides carry explicit scope and expiry metadata.
- Overrides are visible in the UI, recorded in action history and can be cancelled manually.
- Local file writes remain confined to the configured sandbox root in both runtime modes.
- Calendar creation is still simulated while the runtime is in `sandbox`.

## Profile Memory

Profile memory is separate from:

- current conversation context
- action history
- internal runtime config

Profiles currently support:

- preferences
- persistent notes
- frequent contacts
- saved summaries
- derived data for future expansion

Supported operations:

- create profile
- list profiles
- activate profile
- export profile
- import profile
- reset profile

## Task Manager v1

Task Manager v1 is the local source of truth for long-running work inside a chat session.

Current scope:

- one active task per session
- local persistence in `tasks.json`
- real task status, phase, progress percentage and current step
- basic artifact attachment metadata
- deterministic task-step completion through `completeCurrentStep`
- pause, resume, cancel, complete and fail lifecycle operations
- deterministic chat answers for:
  - `que estas haciendo`
  - `cuanto te queda`
  - `en que vas`
  - `pausa`
  - `reanuda`
  - `cancela`

Supported task states:

- `pending`
- `active`
- `paused`
- `blocked`
- `completed`
- `failed`
- `cancelled`

What it does not do yet:

- advanced planning
- multiple concurrent active tasks in the same session
- autonomous worker delegation
- browser or desktop automation

## Planner v1

Planner v1 is the first planning layer above Task Manager and before Task Runtime.

Current scope:

- supported task type: `research_report_basic`
- detect supported open requests such as:
  - `hazme un informe sobre X`
  - `abre una tarea para preparar el informe semanal`
  - `prepare a report about X`
- create a persisted plan before runtime execution starts
- keep the plan honest to current runtime capabilities:
  - prepare local workspace
  - generate initial draft
  - write `report.md`
  - write `summary.txt`
- answer plan questions such as:
  - `cual es el plan`
  - `que pasos vas a seguir`

What it does not do yet:

- generic planning for arbitrary objectives
- browser or desktop automation plans
- advanced re-planning after every step
- multiple runtime task types beyond `research_report_basic`

## Task Runtime / Executor v1

Task Runtime / Executor v1 is the execution layer that moves Task Manager state forward with real work.

Current scope:

- first real runtime task type: `research_report_basic`
- non-blocking background execution from the local agent
- real phases and steps:
  - prepare workspace
  - generate draft report
  - write `report.md`
  - write `summary.txt`
- artifact registration in the Task Manager store
- pause, resume and cancel routed through the runtime executor
- restart-safe behavior:
  - persisted `active` runtime tasks are paused on startup
  - ASSEM does not invent a magic resume after restart
  - the task can be resumed manually from the last safe step

What it does not do yet:

- generic task graphs beyond the persisted plan created by Planner v1
- multiple runtime task types
- browser or desktop automation
- autonomous sub-agents
- checkpointed mid-step resume

## Interrupt Handler v1

Interrupt Handler v1 is the layer that decides, when there is an active task, whether a new user message is:

- a real status query
- a pause/resume/cancel control
- an output refinement
- a goal correction
- a clarification request
- or an independent query outside the task

Current interrupt categories:

- `task_status_query`
- `task_pause`
- `task_resume`
- `task_cancel`
- `task_goal_refinement`
- `task_output_refinement`
- `task_clarification_needed`
- `independent_query`

Current refinements supported:

- `hazlo mas corto`
- `hazlo en ingles`
- `hazlo en espanol`
- `primero dame un resumen`
- `anade una tabla`
- simple focus changes such as `cambia el enfoque a riesgos`

Current behavior limits:

- refinements only affect future compatible steps
- they do not magically rewrite already completed work
- compatible refinements also update the persisted plan for the active task
- vague corrections like `eso no era lo que queria` trigger a short clarification instead of silent destructive changes

## Scheduler

The scheduler supports:

- create task
- list tasks
- enable/disable task
- delete task
- run task on demand

Safe task kinds currently enabled:

- `reminder`
- `internal_review`
- `summary`
- `simple_check`

## Local Agent API

Main routes:

- `GET /api/health`
- `GET /api/system`
- `GET /api/events`
- `POST /api/session`
- `GET /api/session/:id`
- `POST /api/chat`
- `POST /api/chat/stream`
- `GET /api/actions`
- `GET /api/pending-actions`
- `POST /api/pending-action`
- `GET /api/voice`
- `POST /api/voice/settings`
- `POST /api/voice/mode`
- `POST /api/voice/wake-window`
- `POST /api/voice/active-listening/start`
- `POST /api/voice/active-listening/state`
- `POST /api/voice/active-listening/stop`
- `POST /api/voice/active-listening/cancel`
- `POST /api/voice/recording/start`
- `POST /api/voice/recording/stop`
- `POST /api/voice/recording/cancel`
- `POST /api/voice/speak`
- `POST /api/voice/stop-speaking`
- `GET /api/tasks`
- `GET /api/tasks/:id/plan`
- `GET /api/tasks/active`
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
- `GET /api/mode`
- `POST /api/mode`
- `GET /api/overrides`
- `POST /api/overrides`
- `DELETE /api/overrides/:id`
- `GET /api/profiles`
- `POST /api/profiles`
- `POST /api/profiles/activate`
- `GET /api/profiles/:id/export`
- `POST /api/profiles/import`
- `POST /api/profiles/:id/reset`
- `GET /api/scheduler/tasks`
- `POST /api/scheduler/tasks`
- `POST /api/scheduler/tasks/:id/toggle`
- `DELETE /api/scheduler/tasks/:id`
- `POST /api/scheduler/tasks/:id/run`
- `GET /api/telemetry`

More detail is documented in [docs/local-agent-api.md](docs/local-agent-api.md).

Detailed Ollama instructions are documented in [docs/ollama-local-setup.md](docs/ollama-local-setup.md).

## Adding a New Provider

1. Create a new package under `providers/`.
2. Implement the `EngineProvider` contract from `@assem/shared-types`.
3. Expose:
   - `id`
   - `label`
   - `defaultModel`
   - `supportsLocalOnly`
   - `capabilities`
   - `supportsPrivacyModes`
   - `isConfigured()`
   - `healthCheck()`
   - `run()`
4. Register the provider in `apps/local-agent/src/server.ts`.

## Adding a New Tool

1. Add or update an integration package under `integrations/`.
2. Implement the `ToolDefinition` contract from `@assem/shared-types`.
3. Register the tool in `apps/local-agent/src/server.ts`.
4. Route to the tool from `packages/orchestrator/src/index.ts` if you want natural-language triggering.

## Technical Notes

- Secrets are not stored in `localStorage`.
- The desktop UI subscribes to agent state through SSE instead of polling.
- The Tauri desktop shell keeps using the same HTTP/SSE contract; it does not duplicate orchestrator logic.
- The Tauri shell is configured with a narrow CSP that only allows local agent connectivity to the existing HTTP API.
- This phase does not expose extra Tauri filesystem or shell permissions to the frontend.
- Voice in this phase still runs through the local agent. STT uses `whisper.cpp` and TTS uses Windows system speech; it does not add a second native business-logic layer inside Tauri.
- The old Windows STT implementation remains isolated as legacy code and is not part of the active runtime path anymore.
- The frontend captures microphone audio, converts it to WAV PCM and sends it to the local agent; the agent then invokes `whisper-cli.exe` with the configured local model.
- Conversation mode is explicit and controlled by the UI toggle. When disabled, the frontend stops microphone capture. When enabled and not muted, the frontend captures full spoken turns using local VAD/silence detection and the agent owns the runtime/session state. The active listening toggle itself is not persisted and never auto-starts on a new launch.
- Wake word remains experimental/legacy and disabled by default; it is not the main voice flow.
- Whisper now performs a cheap real self-check with a generated WAV probe before reporting itself ready.
- The agent cleans stale `voice-temp/session-*` directories on startup and cleans old `sessions.json.*.tmp`-style leftovers in the JSON persistence layer.
- The local third-party voice runtime folder `.assem-runtime/` is intentionally ignored from Git because it contains downloaded binaries and models, not ASSEM source code.
- Planner owns task structure; Runtime executes that structure; Task Manager persists both the plan and the execution state.
- Task Manager owns task status/progress answers; the model does not invent percentages or phases for those queries.
- Task Runtime owns execution; Task Manager remains the persisted source of truth for task status, phase, progress and artifacts.
- Interrupt Handler decides whether a message should control or refine the active task before the request falls back to tools or model responses.
- The router is ready for more providers without changing the UI contract.
- The local file integration rejects path traversal and writes outside the sandbox root.
- TypeScript is split into `tsconfig.browser.json` and `tsconfig.node.json`; the Node-side config still uses `moduleResolution: "Bundler"` for the current `tsx` workflow and should be revisited before deeper native/server integrations.

## Tauri Phase Limits

- The native shell is wired into the repo and can be launched with Tauri once the machine has the Rust/Tauri prerequisites installed.
- The agent remains a separate Node-based local process; this phase does not yet bundle a standalone agent runtime into the native app.
- Voice is Windows-only in this phase because TTS still depends on Windows system speech and the desktop build currently targets Windows first.
- Voice supports conversation mode, explicit mute and push-to-talk fallback. It is not full duplex, does not support advanced barge-in, and wake-word detection is experimental/legacy rather than a native low-power detector.
- Audio is not persisted; only transcript/state/telemetry metadata are stored locally.
- `npm run build:desktop` currently targets the native shell build itself. Installer packaging, signing and branded icons are intentionally deferred.
- The current machine still needs Rust tooling before `tauri dev` or `tauri build` can be validated end-to-end.

## Documentation

- [docs/assem-product-charter.md](docs/assem-product-charter.md)
- [docs/architecture/mvp-overview.md](docs/architecture/mvp-overview.md)
- [docs/architecture/runtime-services.md](docs/architecture/runtime-services.md)
- [docs/desktop-tauri.md](docs/desktop-tauri.md)
- [docs/desktop-voice.md](docs/desktop-voice.md)
- [docs/local-agent-api.md](docs/local-agent-api.md)
- [docs/ollama-local-setup.md](docs/ollama-local-setup.md)
- [docs/planner.md](docs/planner.md)
- [docs/task-manager.md](docs/task-manager.md)
- [docs/task-runtime.md](docs/task-runtime.md)
- [docs/interrupt-handler.md](docs/interrupt-handler.md)
