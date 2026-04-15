# ASSEM Desktop Shell with Tauri

This phase adds a native Tauri shell around the existing ASSEM desktop frontend without moving business logic out of the local agent.

## What Tauri Owns

- Native desktop window
- Desktop build entrypoint
- Tight desktop CSP for the existing local HTTP agent

## What Still Belongs to the Local Agent

- Chat orchestration
- Voice orchestration, STT and TTS session control
- Tool routing and execution
- Policy, confirmations and overrides
- Telemetry
- History
- Profile memory
- Scheduler
- Provider routing for Ollama and `demo-local`

The frontend still talks to the local agent over HTTP and SSE.

## Windows Prerequisites

Before running the native desktop shell on Windows, install:

1. Microsoft C++ Build Tools with `Desktop development with C++`
2. Microsoft Edge WebView2 Runtime
3. Rust toolchain (`rustup`, `cargo`, `rustc`)

Official references:

- [Tauri prerequisites](https://v2.tauri.app/fr/start/prerequisites/)
- [Tauri CLI reference](https://v2.tauri.app/ko/reference/cli/)

## Commands

Install project dependencies:

```bash
npm install
```

Run the existing web workflow:

```bash
npm run dev
```

Run only the local agent:

```bash
npm run dev:agent
```

Run only the web desktop frontend:

```bash
npm run dev:desktop
```

Run the native Tauri shell plus the local agent:

```bash
npm run dev:desktop:app
```

Check whether the local machine is ready for Tauri:

```bash
npm run doctor:desktop
```

Build the existing web/local-agent flow:

```bash
npm run build
```

Build the native desktop shell:

```bash
npm run build:desktop
```

## Security Notes

- The Tauri shell does not add frontend access to arbitrary filesystem APIs.
- The frontend keeps using the existing local agent API instead of duplicating native logic.
- Allowed origins now include the Tauri localhost origins required by the native shell.
- The Tauri CSP is restricted to local asset loading plus connections to the local agent on port `4318`.
- Voice in this phase does not require opening extra Tauri filesystem or shell capabilities in the frontend because the local agent remains the process that coordinates system speech access.

## Troubleshooting

If `npm run dev:desktop:app` fails immediately:

- Run `npm run doctor:desktop`
- Verify `cargo --version` and `rustc --version`
- Verify WebView2 is installed on Windows
- Verify the Microsoft C++ Build Tools workload is present

If the native window opens but cannot talk to the agent:

- Check that the agent responds on `http://127.0.0.1:4318/api/health`
- Check `.env` / `.env.example` for `ASSEM_ALLOWED_ORIGINS`
- Confirm the app is still using the expected agent URL in the frontend

If the web flow works but Tauri does not:

- The most common cause in this phase is missing Rust/Tauri prerequisites on the local machine, not a frontend regression

## Real Limitations in This Phase

- The native shell is integrated, but the Node-based local agent is still a separate process.
- This phase does not yet bundle a standalone agent runtime into the Tauri application package.
- Desktop voice is Windows-only in this phase because the first real providers use Windows system speech APIs.
- Installer packaging, code signing and branded icons are deferred until the next desktop-hardening phase.
