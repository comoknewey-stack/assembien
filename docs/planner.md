# Planner v1

Planner v1 is the first planning layer in ASSEM.

Its scope in this phase is deliberately narrow:

- recognize a supported open objective
- classify the task type
- build a short persisted plan
- hand that plan to Task Runtime for execution

It does not execute work itself.

The split in this phase is:

- Planner defines the structure of the work
- Task Runtime executes the work
- Task Manager stores the task, the plan, the state, the progress and the artifacts
- Interrupt Handler decides whether the user is asking about the running task or changing it

## Supported Task Types

Current supported task types:

- `research_report_basic`

Planner v1 does not yet plan:

- browser work
- desktop automation
- arbitrary multi-tool workflows
- generic file batch processing
- open-ended autonomous research

If a request does not fit `research_report_basic`, ASSEM answers honestly instead of fabricating a plan.

## What It Plans

For `research_report_basic`, Planner v1 currently creates a real plan with:

- objective
- task type
- phases
- steps
- expected artifacts
- active restrictions
- initial refinements if they exist

Current research plan structure:

1. prepare local workspace
2. generate initial draft
3. write main report
4. write executive summary

Expected artifacts:

- local workspace folder
- `report.md`
- `summary.txt`

Current restrictions are honest to the runtime that exists today:

- no real web browsing in this phase
- no verified external citations
- outputs stay inside the local sandbox

## Persistence

The plan is persisted with the task in:

- `ASSEM_DATA_ROOT/tasks.json`

That means the task record now contains:

- real state
- real progress
- current phase
- current step
- artifacts
- persisted plan

The plan is not stored in:

- profile memory
- free conversation history
- telemetry

## Orchestrator Integration

When the user asks for a supported open task, the orchestrator now:

1. sends the request to Planner v1
2. gets a real plan
3. creates the task with that plan already attached
4. passes the task to Task Runtime
5. keeps the conversation as the main user surface

Examples that Planner v1 handles in this phase:

- `hazme un informe sobre riesgos operativos`
- `abre una tarea para preparar el informe semanal`
- `prepare a report about operating costs`

If the user asks:

- `cual es el plan`
- `que pasos vas a seguir`

ASSEM responds from the persisted plan, not from a model hallucination.

## Refinements

Planner v1 can apply simple refinements to the persisted plan while the task is active.

Current supported refinements:

- `hazlo mas corto`
- `hazlo en ingles`
- `hazlo en espanol`
- `primero dame un resumen`
- `anade una tabla`
- simple focus shifts such as `cambia el enfoque a riesgos`

Current behavior:

- refinements update the plan
- compatible refinements also affect future runtime steps
- completed work is not silently rewritten

Example:

- `primero dame un resumen`

In this phase, that can reorder the remaining planned steps so the summary comes before the main report if the report output has not been written yet.

## Telemetry

Planner v1 emits local telemetry on the `task_planner` channel.

Current event types:

- `task_plan_created`
- `task_plan_refined`
- `task_plan_rejected`
- `task_plan_applied`

## Limits of This Phase

Planner v1 does not yet do:

- general-purpose task decomposition
- runtime re-planning after every step
- multiple task types beyond `research_report_basic`
- browser or desktop automation planning
- autonomous sub-planning
- conflict resolution across multiple simultaneous active tasks

This phase creates the first honest planning layer that the rest of the runtime can build on top of.
