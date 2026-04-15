# ASSEM

ASSEM is a local-first assistant MVP built as a modular TypeScript monorepo. The desktop UI stays thin, the local agent owns orchestration and policy, providers remain interchangeable, and persistence is local by default.

## What Works Now

- Local desktop chat connected to a local HTTP agent.
- Native desktop shell wiring with Tauri, while keeping the local HTTP agent separate from the frontend.
- First desktop voice flow:
  - push-to-talk start/stop
  - local transcript routed into the current chat session
  - optional auto-read for assistant replies
  - manual speak/stop controls for the latest assistant response
- Persistent sessions, action history, profile memory, scheduler state and telemetry.
- Safe privacy/runtime modes:
  - `local_only`
  - `prefer_local`
  - `balanced`
  - `cloud_allowed`
  - `sandbox`
  - `live`
- Stable local API for chat, confirmations, overrides, modes, health, profiles and scheduler.
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
- Voice is desktop-only in this phase and intentionally does not include wake word, full duplex or advanced interruption.

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
- `packages/scheduler`: safe internal task scheduler.
- `packages/telemetry`: persistent local telemetry sink.
- `packages/sdk`: frontend client for the local agent API.
- `packages/tool-registry`: tool registration and summaries.
- `integrations/*`: tools and provider adapters for clock, calendar and local files.
- `providers/*`: engine/model providers.
- `docs/`: technical documentation.

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
- `ASSEM_OLLAMA_MODEL=llama3.2`
- `ASSEM_PROVIDER_TIMEOUT_MS=15000`
- `ASSEM_VOICE_STT_PROVIDER=whisper-cpp`
- `ASSEM_VOICE_TTS_PROVIDER=windows-system-tts`
- `ASSEM_VOICE_LANGUAGE=es-ES`
- `ASSEM_VOICE_AUTO_READ_RESPONSES=false`
- `ASSEM_WHISPER_CPP_CLI_PATH=`
- `ASSEM_WHISPER_CPP_MODEL_PATH=`
- `ASSEM_WHISPER_CPP_THREADS=4`
- `ASSEM_ALLOWED_ORIGINS=http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost`

## Voice Setup

Current voice providers in this phase:

- STT: `whisper-cpp`
- TTS: `windows-system-tts`

This voice phase is local-first and desktop-only:

- microphone capture happens in the desktop UI and the local agent keeps the session orchestration
- STT runs locally through `whisper.cpp`
- transcripts are inserted into the current chat session
- assistant replies can be read aloud automatically or manually
- text chat keeps working normally even if voice is unavailable

Quick voice test:

1. Install `whisper.cpp` and download a local model file such as `ggml-base.bin`.
2. Make sure you are on Windows with a working default microphone and speakers.
3. Keep or copy the voice defaults in `.env`:

```bash
ASSEM_VOICE_STT_PROVIDER=whisper-cpp
ASSEM_VOICE_TTS_PROVIDER=windows-system-tts
ASSEM_VOICE_LANGUAGE=es-ES
ASSEM_VOICE_AUTO_READ_RESPONSES=false
ASSEM_WHISPER_CPP_CLI_PATH=C:\\ruta\\a\\whisper-cli.exe
ASSEM_WHISPER_CPP_MODEL_PATH=C:\\ruta\\a\\ggml-base.bin
ASSEM_WHISPER_CPP_THREADS=4
```

4. Start the native desktop shell:

```bash
npm run dev:desktop:app
```

5. In the desktop app:
  - open `Voz`
  - confirm that voice shows `lista` or `parcial`
  - confirm that the STT provider is `whisper.cpp`
  - click `Hablar`
  - speak
  - click `Detener y enviar`
  - confirm that the transcript appears as a normal user message in the current session
  - click `Leer ultima` or enable `Autolectura de respuestas`

If voice is partially available:

- missing STT keeps text chat and TTS usable
- missing TTS keeps text chat and STT usable
- if both are unavailable, the desktop still works in text mode

## Ollama Setup

Basic local setup:

1. Install Ollama on the machine that will run ASSEM.
2. Start the Ollama service or app so it listens on `http://127.0.0.1:11434`.
3. Pull a test model:

```bash
ollama pull llama3.2
```

4. Create the local env file and keep it aligned with the Ollama endpoint and model:

```bash
cp .env.example .env
```

```bash
ASSEM_DEFAULT_PROVIDER=ollama
ASSEM_OLLAMA_BASE_URL=http://127.0.0.1:11434
ASSEM_OLLAMA_MODEL=llama3.2
```

5. Start ASSEM with `npm run dev`.

How to confirm ASSEM is using Ollama:

- In the desktop System panel:
  - `Configured provider` should be `ollama`
  - `Runtime provider` should switch to `ollama` after a model-routed chat turn
  - `Current model` should show the resolved Ollama model
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

## Test

```bash
npm test
```

## Persistence

ASSEM persists local state under `ASSEM_DATA_ROOT`:

- `sessions.json`: session snapshots, action history, overrides and session-scoped mock calendar state.
- `profiles.json`: profile memory packs and active profile pointer.
- `scheduler.json`: scheduled tasks and last run metadata.
- `telemetry.jsonl`: per-interaction telemetry records.

The persistence layer is abstracted behind file-backed helpers so the storage backend can later be swapped for SQLite without changing the higher-level interfaces.

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
- `POST /api/voice/recording/start`
- `POST /api/voice/recording/stop`
- `POST /api/voice/recording/cancel`
- `POST /api/voice/speak`
- `POST /api/voice/stop-speaking`
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
- The router is ready for more providers without changing the UI contract.
- The local file integration rejects path traversal and writes outside the sandbox root.
- TypeScript is split into `tsconfig.browser.json` and `tsconfig.node.json`; the Node-side config still uses `moduleResolution: "Bundler"` for the current `tsx` workflow and should be revisited before deeper native/server integrations.

## Tauri Phase Limits

- The native shell is wired into the repo and can be launched with Tauri once the machine has the Rust/Tauri prerequisites installed.
- The agent remains a separate Node-based local process; this phase does not yet bundle a standalone agent runtime into the native app.
- Voice is Windows-only in this phase because TTS still depends on Windows system speech and the desktop build currently targets Windows first.
- Voice is push-to-talk only: no wake word, no full duplex and no advanced barge-in.
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
