# Interrupt Handler v1

Interrupt Handler v1 is the first deterministic layer that lets ASSEM stay conversational while a real task is still active.

Its job in this phase is narrow and explicit:

- inspect the new user message
- look at the active task for the current session
- decide whether the message is about that task
- route the message to real task state/control instead of letting the model improvise

It does not replace Task Manager or Task Runtime.

The split is:

- Planner defines and updates the persisted task plan
- Task Manager stores persisted task truth
- Task Runtime executes real work and updates that truth
- Interrupt Handler decides whether the latest message should read or control that truth

## Classification Model

When there is an active task, Interrupt Handler classifies the message into one of these categories:

- `task_status_query`
- `task_pause`
- `task_resume`
- `task_cancel`
- `task_goal_refinement`
- `task_output_refinement`
- `task_clarification_needed`
- `independent_query`

The classifier is intentionally rule-based first.

In this phase it relies on:

- normalized user text
- the presence of an active task in the current session
- deterministic phrase matching for status/control/refinement patterns

That means ASSEM does not need to ask the model whether `pausa` means pause or whether `que estas haciendo` is a task-status query.

## Supported Queries and Controls

Current status-style messages include patterns such as:

- `que estas haciendo`
- `cuanto te queda`
- `en que vas`
- `que te falta`
- `ya terminaste`
- `cual es el plan`
- `que pasos vas a seguir`
- `que fuentes has encontrado`
- `que fuentes estas usando`
- `cuantas fuentes tienes`
- `que fuentes has leido de verdad`
- `que paginas has podido leer`
- `que fuentes usaste solo como snippet`
- `que parte sale solo de snippets`
- `que evidencia tienes`
- `que fuentes descartaste`
- `que fuentes tienen evidencia fuerte`
- `que fuentes son debiles o tangenciales`
- `cual es la mejor fuente que encontraste`
- `que limitaciones tiene este informe`
- `hay base suficiente o no`

Current control messages include patterns such as:

- `pausa`
- `para`
- `reanuda`
- `sigue`
- `continua`
- `cancela`

If there is no active task in the current session, ASSEM answers that clearly instead of pretending there is background work.

## Supported Refinements

Interrupt Handler v1 supports simple refinements that can be stored on the active task and applied to future compatible steps.

Current output refinements:

- `hazlo mas corto`
- `hazlo en ingles`
- `hazlo en espanol`
- `primero dame un resumen`
- `anade una tabla`

Current research/source refinements:

- `usa fuentes oficiales`
- `no uses blogs`
- `prioriza fuentes recientes`

Current goal refinement shape:

- simple focus corrections such as `cambia el enfoque a riesgos`
- simple intent corrections such as `me referia a riesgos`

These refinements are persisted inside task metadata under the task interrupt state.

They are not stored in:

- session message history
- profile memory
- scheduler state

## Clarification Behavior

Some messages are not safe to apply directly.

Example:

- `eso no era lo que queria`

In that case Interrupt Handler classifies the input as `task_clarification_needed`.

Current behavior:

- ASSEM keeps the active task
- ASSEM stores the clarification marker in task metadata
- ASSEM asks for a short concrete clarification instead of silently rewriting or destroying the task

This is intentional.

It is safer than guessing whether the user wants:

- a refinement
- a full goal replacement
- or a cancellation

## Independent Questions While a Task Is Running

If there is an active task but the new message does not look like a task interruption, Interrupt Handler returns `independent_query`.

That means:

- the active task stays intact
- the message continues through the normal orchestration path
- tools can still run
- ordinary chat replies can still happen

Example:

- active task running in the background
- user asks `que hora es`
- ASSEM answers the time through the time tool
- the task remains active and queryable afterwards

## Persistence

Interrupt-related state is persisted with the task record in `ASSEM_DATA_ROOT/tasks.json`.

Current persisted interrupt state may include:

- stored refinements
- last interruption timestamp
- last clarification message

This keeps task adjustments local to the task itself instead of leaking them into profile memory or session-global settings.

## Telemetry

Interrupt Handler emits local telemetry events on the `task_interrupt` channel.

Current event types:

- `task_interrupt_status_query`
- `task_interrupt_pause`
- `task_interrupt_resume`
- `task_interrupt_cancel`
- `task_interrupt_refinement`
- `task_interrupt_clarification`
- `task_interrupt_independent_query`
- `task_interrupt_sources_query`

Research/source queries are answered from persisted task state, not from free-form model text. If a research task failed, has no selected sources, only has weak/tangential evidence or never generated an artifact, Interrupt Handler routes the question through deterministic task-state rendering so ASSEM does not invent sources, strength, reports or paths.

This now also includes persisted research quality state such as `qualitySummary` and `reportReadiness`, so questions about snippet dependence or whether there is enough basis for a solid report are answered from real task metadata instead of model improvisation.

These events are recorded separately from chat history.

## Limits of This Phase

Interrupt Handler v1 does not do:

- planner-driven intent rewriting
- multi-task arbitration
- complex conflict resolution between multiple active tasks
- automatic re-planning after a refinement
- rewriting already completed artifacts

In this phase it is a deterministic control-and-routing layer that makes ASSEM feel interruptible without pretending to have a full planner.

## Browser Automation v1 in Interrupt Handler

Interrupt Handler now also classifies browser-task follow-ups deterministically when the active task is `browser_read_basic`.

Supported browser status queries:

- `que pagina has abierto`
- `en que url estas`
- `que enlaces viste`
- `que has encontrado`
- `que pasos has dado`

Supported browser refinements:

- `sigue el enlace mas relevante`
- `busca X en la pagina`
- `ve a la fuente oficial`
- `no sigas blogs`

These answers come from persisted browser task state only:

- current URL and title
- visible links
- findings
- navigation log
- persisted artifacts

ASSEM does not infer unseen page content from the model when answering those browser questions.
