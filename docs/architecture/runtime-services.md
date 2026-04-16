# Runtime Services

## Persistence

ASSEM uses a file-backed persistence layer under `ASSEM_DATA_ROOT`.

Files currently used:

- `sessions.json`
- `tasks.json`
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
- task manager state
- telemetry history
- internal server config

## Task Manager

Task Manager v1 is a dedicated local service for long-running work state.

Current responsibilities:

- create and persist tasks
- keep one active task pointer per session
- track status, phase, progress and current step
- attach lightweight artifact metadata
- expose pause, resume, cancel, complete and fail transitions

Supported task states:

- `pending`
- `active`
- `paused`
- `blocked`
- `completed`
- `failed`
- `cancelled`

Task Manager is separate from:

- conversation message history
- profile memory
- scheduler tasks
- telemetry storage

In the current architecture:

- Task Manager persists to `tasks.json`
- the orchestrator reads it directly to answer task-status questions
- the local agent exposes it through `/api/tasks*`
- the UI renders it from `/api/system` and SSE state updates

## Task Runtime

Task Runtime / Executor v1 is the execution layer on top of Task Manager.

Current responsibilities:

- create runtime-backed tasks from chat or API requests
- execute real phases and steps in the background
- update Task Manager progress and phase state
- attach real artifacts
- pause, resume and cancel execution
- mark tasks completed or failed with real outcomes

Current runtime task type:

- `research_report_basic`

Current execution phases:

- prepare workspace
- generate draft report through the active model router
- write `report.md`
- write `summary.txt`

Restart behavior in this phase:

- Task Runtime does not attempt automatic mid-step recovery
- persisted runtime tasks that were still `active` are paused on startup
- the user can resume them manually from the last safe step

## Planner

Planner v1 is the task-structure layer that sits before Task Runtime.

Current responsibilities:

- classify supported open objectives
- build a persisted task plan
- define phases, steps and expected artifacts before execution starts
- keep the plan aligned with the real runtime capabilities of this phase
- adjust the persisted plan when a compatible refinement is applied

Current supported task types:

- `research_report_basic`

Current non-goals:

- general-purpose planning
- browser or desktop automation planning
- multi-task planning
- continuous re-planning after every runtime step

Current persistence model:

- the plan is stored with the task in `tasks.json`
- the plan stays separate from profile memory and free conversation history

## Interrupt Handler

Interrupt Handler v1 is the task-interruption router that sits in front of normal model fallback when a session has an active task.

Current responsibilities:

- classify whether the latest user message is about the active task
- answer real task status queries from persisted task state
- route pause, resume and cancel controls to the runtime/task manager
- persist simple refinements on the active task
- keep independent questions out of the task-control path

Supported interrupt classes:

- `task_status_query`
- `task_pause`
- `task_resume`
- `task_cancel`
- `task_goal_refinement`
- `task_output_refinement`
- `task_clarification_needed`
- `independent_query`

Current refinement examples:

- `hazlo mas corto`
- `hazlo en ingles`
- `hazlo en espanol`
- `primero dame un resumen`
- `anade una tabla`
- simple focus shifts such as `cambia el enfoque a riesgos`

Current persistence model:

- refinements and clarification markers are stored inside task metadata in `tasks.json`
- they remain attached to the task instead of polluting profile memory or session-global settings

Current safety rule:

- vague corrections such as `eso no era lo que queria` trigger clarification instead of destructive automatic changes

Current independence rule:

- if the message is classified as `independent_query`, the task stays active and the normal orchestration path continues

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

Task-related telemetry channels in this phase:

- `task_manager`
- `task_runtime`
- `task_planner`
- `task_interrupt`

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
