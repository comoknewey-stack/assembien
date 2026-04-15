# Runtime Services

## Persistence

ASSEM uses a file-backed persistence layer under `ASSEM_DATA_ROOT`.

Files currently used:

- `sessions.json`
- `profiles.json`
- `scheduler.json`
- `telemetry.jsonl`

The persistence package is intentionally small and isolated so the backend can be swapped later without rewriting router, orchestrator, memory or scheduler logic.

## Session Context

Session context contains:

- conversation messages
- action history
- pending confirmation
- temporary overrides
- mock calendar session state
- active execution mode

Session context does not contain:

- profile memory
- telemetry history
- internal server config

## Profile Memory

Profile memory is global and persistent across sessions.

Current profile data model:

- preferences
- notes
- frequent contacts
- saved summaries
- derived data

Supported operations:

- create
- list
- activate
- export
- import
- reset

## Telemetry

Telemetry is append-only and separate from the action log.

Recorded fields per interaction:

- timestamp
- session id
- provider
- model
- privacy mode
- runtime mode
- total duration
- provider latency
- tokens
- estimated cost
- tools used
- confirmation requirement
- result
- error message
- message preview
- fallback used
- fallback reason

## Policy Engine

The policy engine decides whether a tool:

- is allowed
- requires confirmation
- is covered by an active override

Temporary overrides:

- are time-bound
- carry scope
- list granted permissions
- list tool ids or `*`
- are stored in session state
- are visible in the UI
- can be cancelled manually

## Scheduler

The scheduler stores safe internal tasks and supports:

- create
- list
- enable/disable
- delete
- run on demand

Current safe task kinds:

- reminder
- internal_review
- summary
- simple_check

## Router

The model router supports:

- provider health checks
- per-provider timeout
- ordered fallback
- privacy-mode-aware selection
- capability filtering
- local Ollama preference with deterministic `demo-local` fallback

Supported privacy routing modes:

- `local_only`
- `prefer_local`
- `balanced`
- `cloud_allowed`
