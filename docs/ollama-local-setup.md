# Ollama Local Setup

## Goal

ASSEM can run against a local Ollama instance and fall back to `demo-local` if Ollama is unavailable, unhealthy or too slow.

## Recommended Baseline

- Ollama listening on `http://127.0.0.1:11434`
- A small local model already pulled, for example `llama3.2:latest`
- ASSEM configured with:

```bash
ASSEM_DEFAULT_PROVIDER=ollama
ASSEM_OLLAMA_BASE_URL=http://127.0.0.1:11434
ASSEM_OLLAMA_MODEL=llama3.2:latest
ASSEM_PROVIDER_TIMEOUT_MS=15000
```

## Install and Start Ollama

Typical local flow:

1. Install Ollama on the machine.
2. Start the Ollama app or service.
3. Pull a test model:

```bash
ollama pull llama3.2:latest
```

4. If you need to start the server manually:

```bash
ollama serve
```

## Run ASSEM With Ollama

From the repository root:

```bash
cp .env.example .env
npm install
npm run dev
```

The desktop shell is served on `http://localhost:1420` and the local agent on `http://localhost:4318`.

## Verify Runtime Selection

In the desktop UI:

- System panel:
  - `Configured provider` should show `ollama`
  - `Configured model` should match `ASSEM_OLLAMA_MODEL`
  - `Runtime provider` should show `ollama` after a model-routed turn
  - the runtime model badges should show the active model after a routed turn, or the resolved configured model before the first real invocation
- Telemetry card:
  - recent entries show provider/model/result
  - fallback entries show the fallback reason

Through the API:

- `GET /api/health`
  - Ollama should report `status: ok`
- `GET /api/system?sessionId=<id>`
  - `providerRuntime.activeProviderId` shows the last provider actually used
  - `providerRuntime.activeModel` shows the last model actually used
  - `providerRuntime.fallbackUsed` and `providerRuntime.fallbackReason` explain fallback when it happened

## Troubleshooting

### Ollama unavailable

Symptoms:

- health shows Ollama as `unavailable`
- the UI shows an Ollama error
- chat falls back to `demo-local`

Checks:

- make sure the Ollama app or service is running
- verify the URL in `ASSEM_OLLAMA_BASE_URL`
- check whether another process or firewall is blocking `127.0.0.1:11434`

### Ollama degraded

Symptoms:

- health shows Ollama as `degraded`
- ASSEM falls back to `demo-local`

Most common cause:

- the configured model is not installed locally

Fix:

```bash
ollama pull llama3.2:latest
```

or pull whichever model matches `ASSEM_OLLAMA_MODEL`.

### Ollama timeout

Symptoms:

- the runtime provider switches to `demo-local`
- fallback reason mentions timeout

Fixes:

- use a smaller local model
- increase `ASSEM_PROVIDER_TIMEOUT_MS`
- reduce concurrent load on the local machine

## Streaming Status

`POST /api/chat/stream` currently emits SSE lifecycle events for the ASSEM request flow:

- `chat.started`
- `chat.completed`

ASSEM is not doing token-by-token streaming from Ollama yet in this phase.
