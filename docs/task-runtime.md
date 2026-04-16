# Task Runtime / Executor v1

Task Runtime / Executor v1 is the first real execution layer for long-running work in ASSEM.

It does not replace Task Manager.

The split in this phase is:

- Task Manager stores persisted truth
- Task Runtime executes steps and updates that truth

## Current Task Type

Current runtime-backed task type:

- `research_report_basic`

This task is intentionally simple but real.

It:

- receives an objective
- creates a local workspace inside the sandbox
- generates a first markdown draft through the configured model router
- writes a real `report.md`
- writes a real `summary.txt`
- registers those outputs as artifacts

## Real Phases

Current execution phases and steps:

1. `prepare-workspace`
2. `draft-report`
3. `write-report`
4. `write-summary`

Progress is calculated from completed steps over total steps.

In this phase that means:

- 0% before step execution
- 25% after step 1
- 50% after step 2
- 75% after step 3
- 100% after step 4 and task completion

## Execution Model

The runtime:

- creates or resumes a task
- consumes the persisted plan created by Planner v1
- runs in the local agent process
- does not block the conversation loop
- updates Task Manager after each real step
- emits runtime telemetry events

The conversation remains the main surface.

The user can still ask:

- `que estas haciendo`
- `cuanto te queda`
- `en que vas`
- `pausa`
- `reanuda`
- `cancela`

Those answers come from Task Manager state, not from invented model text.

If there is an active task and the new message is independent, Interrupt Handler lets the message continue through the normal orchestration path without dropping the running task.

## Artifacts

Current artifact kinds used by `research_report_basic`:

- `directory`
- `report`
- `document`

Typical outputs:

- sandbox workspace directory
- `report.md`
- `summary.txt`

## API Integration

Current local-agent endpoints relevant to runtime execution:

- `POST /api/tasks/runtime`
- `POST /api/tasks/:id/start`
- `POST /api/tasks/:id/pause`
- `POST /api/tasks/:id/resume`
- `POST /api/tasks/:id/cancel`
- `GET /api/tasks`
- `GET /api/tasks/active`

## Restart Behavior

This phase does not implement automatic checkpoint resume.

If ASSEM restarts while a runtime task is still marked `active`:

- startup recovery pauses that task
- the task remains persisted in `tasks.json`
- ASSEM reports that it can be resumed manually from the last safe step

This is intentional.

It is safer than pretending a partially executed step can always continue correctly.

## Telemetry

Current runtime telemetry events:

- `task_execution_started`
- `task_step_started`
- `task_step_completed`
- `task_execution_paused`
- `task_execution_resumed`
- `task_execution_cancelled`
- `task_execution_completed`
- `task_execution_failed`

These events are stored separately from chat history and separately from Task Manager telemetry.

Related interrupt telemetry is emitted on a separate `task_interrupt` channel so control/refinement messages do not get mixed into runtime-step execution events.

Related planning telemetry is emitted on `task_planner`, so plan creation/refinement remains distinct from step execution telemetry.

## Limits of This Phase

This phase does not include:

- planner-generated task graphs
- multiple task types beyond `research_report_basic`
- sub-agents or worker delegation
- browser automation
- desktop automation
- checkpointed mid-step recovery
- complex conflict resolution between concurrent runtime tasks
- automatic rewriting of already completed artifacts after a late refinement
