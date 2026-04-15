# MVP Architecture Overview

## Intent

ASSEM remains desktop-first and local-first:

- the UI is a thin local desktop shell
- the local agent owns orchestration, tools, policy and persistence
- providers stay replaceable
- tools stay modular
- memory, action history and telemetry are separated

## Runtime Shape

```text
[Desktop React Shell]
        |
        v
[Local Agent HTTP Service]
        |
        v
[Orchestrator]
  |        |         |          |            |
  v        v         v          v            v
[Router] [Policy] [Memory] [Scheduler] [Telemetry]
                                 |
                                 v
                      [Clock / Calendar / Local Files]
```

## Key Decisions

- UI and core stay separated by the local SDK and HTTP API.
- Provider routing is mode-aware and supports health checks, timeout and fallback.
- Session data, profile memory, scheduler state and telemetry are persisted locally.
- Telemetry is intentionally separate from action history.
- The scheduler is restricted to safe internal tasks in this phase.
- The sandbox is preserved even when runtime mode is `live`.

## Current Boundaries

- The repo now includes an Ollama local provider and still keeps `demo-local` as a deterministic fallback path.
- The calendar remains a mock provider behind a clean contract.
- Scheduler runs are internal and safe, not broad desktop automation.

## Next Expansion Paths

- Add real providers under `providers/` without changing desktop contracts.
- Replace the mock calendar provider with a real integration by implementing `CalendarProvider`.
- Swap the file-backed persistence layer for SQLite later if needed.
- Expand scheduler execution using explicit safe contracts instead of direct OS control.
