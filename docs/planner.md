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
- open-ended autonomous research beyond the controlled Research v1 flow

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
2. search web sources through the configured provider
3. select and deduplicate useful sources
4. read a bounded subset of selected pages when enabled
5. extract evidence from snippets and/or page reads
6. synthesize findings from persisted evidence
7. write main report
8. write executive summary
9. write source audit
10. write evidence audit

Expected artifacts:

- local workspace folder
- `report.md`
- `summary.txt`
- `sources.json`
- `evidence.json`

Current restrictions are honest to the runtime that exists today:

- web search is only available outside `local_only` and only when configured
- Research v2 uses Brave Search plus a bounded safe page-reader step when enabled
- fetched page content is treated as untrusted evidence, never as instructions
- no browser automation, aggressive scraping, crawling or full browsing in this phase
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
- `investiga el consumo de galletas en Islandia`
- `busca informacion sobre X y prepara un informe`
- `abre una tarea para preparar el informe semanal`
- `prepare a report about operating costs`

If the session is `local_only`, Planner v1 rejects web research before task creation.
If no web search provider is configured, Planner v1 rejects the request instead of creating an empty research task.

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
- `usa fuentes oficiales`
- `no uses blogs`
- `prioriza fuentes recientes`
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
- desktop automation planning
- autonomous sub-planning
- conflict resolution across multiple simultaneous active tasks

This phase creates the first honest planning layer that the rest of the runtime can build on top of.

## Browser Automation v1 in Planner

Planner now supports a second grounded task type:

- `browser_read_basic`

Detected requests include examples such as:

- `abre esta web y dime de que trata`
- `mira esta pagina y saca los enlaces principales`
- `visita esta URL y dime que dice`
- `busca X en esta pagina`

Planner only accepts browser tasks when:

- the session is not in `local_only`
- `ASSEM_BROWSER_AUTOMATION_ENABLED` is enabled in runtime config

The generated plan stays narrow and auditable:

- prepare workspace
- open page
- extract visible page state
- optionally follow a very small number of safe links
- extract findings
- persist notes and snapshots
