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
- searches configured web sources through `web-search.search`
- deduplicates and selects sources from real search results
- persists selection/discard reasons
- reads a very small bounded subset of selected public pages through `web-page-reader.fetch-page` when page fetch is enabled
- persists fetched-page status, cleaned excerpts, read-quality metrics and extracted evidence notes
- synthesizes findings through the configured model router using persisted evidence, preferring higher-quality page-read evidence over snippet-only or tangential evidence
- writes a real `sources.json`
- writes a real `evidence.json`
- persists `qualitySummary` and `reportReadiness` so later follow-up answers and guardrails use the same real quality judgement
- writes a real `report.md`
- writes a real `summary.txt`
- registers those outputs as artifacts

If the session is `local_only` or web search is not configured, the orchestrator blocks before runtime task creation.
If search fails, times out or produces no selected sources, the task fails with `metadata.research.searchError` and does not write empty report artifacts.
If page reading is disabled, unreadable or times out, runtime degrades honestly to snippet-only evidence when enough evidence still exists.
If there is no usable persisted evidence after selection/fetch, the task fails instead of inventing findings.
If page fetch succeeds but the cleaned content is still noisy or weak, the source can remain persisted as low-quality or tangential evidence instead of being treated as strong support.
If the persisted `qualitySummary` decides readiness is `insufficient`, runtime fails honestly instead of forcing a weak report.

## Real Phases

Current execution phases and steps:

1. `prepare-workspace`
2. `search-web`
3. `select-sources`
4. `fetch-pages`
5. `extract-evidence`
6. `synthesize-findings`
7. `write-report`
8. `write-summary`
9. `write-sources`
10. `write-evidence`

Progress is calculated from completed steps over total steps.

In this phase that means:

- 0% before step execution
- progress is derived from completed steps over the seven real runtime steps
- 100% only after report, summary, source audit and evidence audit are written and the task is completed

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
- `sources.json`
- `evidence.json`
- `report.md`
- `summary.txt`

`sources.json` is auditable and includes:

- exact search query
- provider id
- `retrievedAt`
- selected sources
- discarded sources
- selection/discard reasons
- evidence limitations
- `searchError` when relevant

`evidence.json` is auditable and includes:

- exact search query
- provider id
- `retrievedAt`
- evidence level
- evidence strength
- fetched page records with `fetchStatus`, `httpStatus`, `contentType`, `finalUrl`
- per-source evidence records
- persisted limitations

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
- `research_started`
- `research_search_started`
- `research_search_completed`
- `research_sources_selected`
- `research_page_fetch_started`
- `research_page_fetch_completed`
- `research_page_fetch_failed`
- `research_evidence_extracted`
- `research_evidence_saved`
- `research_synthesis_started`
- `research_report_written`
- `research_failed`

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
- full-page scraping or unlimited source-content extraction
- checkpointed mid-step recovery
- complex conflict resolution between concurrent runtime tasks
- automatic rewriting of already completed artifacts after a late refinement
