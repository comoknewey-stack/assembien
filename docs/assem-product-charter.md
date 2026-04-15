# ASSEM Product Charter

## Status

This document is the canonical product brief for ASSEM.

When future implementation choices are ambiguous, this document should be treated as the primary decision guide for product direction, system behavior, and tradeoff resolution.

## Product Identity

- Product name: `ASSEM`
- Product type: general personal assistant and operational agent
- Target feel: one single assistant that can do many things, even if the internal architecture uses multiple modules or agents
- Initial personality: neutral
- Long-term aspiration: an assistant comparable to, or better than, fictional systems such as Jarvis or Friday in usefulness, versatility, and natural interaction

## North Star

ASSEM should become a cross-device assistant that can:

- talk naturally by text or voice
- understand the current conversation perfectly
- use tools and external systems to perform real actions
- operate on a computer or device when allowed
- work with calendars, messages, files, research tasks, and later many more domains
- remain modular enough that models, integrations, and runtime strategies can be replaced without rewriting the whole system
- stay usable for non-technical users through a clear interface

The user should feel they are talking to one assistant, not a collection of disconnected tools.

## Decision Priorities

When there is a tradeoff, prioritize in this order:

1. Quality of result and user trust
2. Privacy and user control
3. Sustainable cost
4. Modularity and replaceability
5. Versatility across devices and environments
6. Development speed
7. Low implementation complexity

Complexity is acceptable if it meaningfully improves quality, privacy, cost, or long-term flexibility.

## Product Principles

### 1. One assistant experience, modular internals

The product may be implemented with layers, modules, or even specialized agents, but the user experience must feel like a single assistant.

### 2. Local-first starting point

Development starts on a local computer, with desktop as the first primary platform.

The architecture should still be prepared for:

- browser access
- mobile access
- server-backed deployments
- hybrid local plus cloud execution

### 3. Replaceable intelligence layer

No provider should be hardcoded into the core architecture.

ASSEM must be able to switch or combine:

- LLM providers
- local models
- speech-to-text
- text-to-speech
- vision models
- search providers

### 4. Real actions with visible control

ASSEM is not only a chatbot. It must eventually be able to do real work such as:

- create calendar events
- read a calendar
- draft or send messages
- create files and folders
- open or close programs
- navigate websites
- fill forms
- inspect notifications
- use a camera feed
- act on a phone, tablet, or computer

### 5. Confirmation by default, autonomy when explicitly granted

ASSEM should ask for confirmation before sensitive actions unless the user explicitly grants temporary or situational autonomy.

Example intent:

- if the user asks to create an event, ASSEM can do it directly when that instruction is explicit
- if the user says `Hoy no me preguntes mas`, ASSEM should adapt its behavior for the granted scope and time period
- if the user revokes or changes the instruction, behavior should update accordingly

### 6. Visible history and inspectable memory

The assistant must expose what it did, what it remembers, and what permissions or overrides are currently active.

### 7. Privacy modes are a product feature, not an afterthought

ASSEM must support privacy-aware operation from the beginning, including the ability to keep data on-device or inside a local network when needed.

## Functional Vision

### Core capabilities for the final product

ASSEM should eventually support all of the following:

- text chat
- voice input and voice output
- wake word and push-to-talk style invocation
- conversational continuity with strong short-term context handling
- persistent user memory
- memory export, import, reset, and profile switching
- action history
- permissions management
- privacy mode controls
- calendar access and event creation
- messaging workflows
- local file system actions
- web research and report generation
- app and desktop control
- mobile-oriented actions such as notifications, calls, and messaging
- camera or visual understanding workflows
- multi-language interaction, with Spanish as the first priority and English also important
- specialization workflows, where ASSEM can focus deeply on a domain and produce a useful answer or report

### First useful version

The first version should prove that ASSEM is already becoming the intended product.

Minimum success criteria for an MVP:

- the user can ask a normal question and receive a useful answer
- the system can use current context such as time or available tools
- the user can ask ASSEM to perform a simple action and it works
- at least one real productivity workflow exists, such as creating or reading calendar data
- the interface is usable and clear
- the architecture already supports provider swapping and future expansion

Examples of MVP-grade requests:

- `Que tiempo hace hoy?`
- `Cuanto queda para que el Barca juegue contra el Atletico de Madrid?`
- `Crees que es mejor hacer ejercicio ahora o despues?`
- `Crea un archivo con mis notas de hoy`
- `Lee mi calendario`
- `Agrega una cita al calendario`

## Platform Strategy

### Start here

- primary starting environment: local desktop
- first practical target: Windows desktop
- current experience should remain usable while the architecture is expanded

### Required long-term platforms

ASSEM should ultimately support:

- Windows
- browser
- iPhone and iPad
- Linux
- Android
- macOS

### Architectural recommendation

The best fit for the stated goals is:

- a modular local-first core now
- a stable API boundary between clients and the assistant runtime
- the option to evolve into a backend plus multiple clients later

In practice, this means:

- keep the current local agent model
- avoid coupling the UI directly to providers or tools
- keep memory, policy, orchestration, providers, and integrations separated
- allow the same core runtime to later run locally, on a private server, or in a cloud deployment

This gives fast iteration now without blocking a future multi-device product shape.

## Interface Direction

The product should eventually include multiple user-facing surfaces:

- chat view
- control panel
- floating assistant mode

The user should be able to choose what stays open.

Important UI sections:

- chat
- voice
- automations
- history
- settings
- permissions
- privacy mode

Design direction:

- clear
- useful
- attractive
- low technical friction for daily use

Even if advanced configuration remains technical at first, the long-term product should reduce the need for technical knowledge.

## Voice and Conversation

### Voice priority

Voice does not need to be complete on day one, but it is a core product feature, not an optional extra.

### Long-term voice goals

- natural speech
- multilingual support
- real-time feel
- interruption handling
- fast responses
- both wake word and button-based interaction

### Language goals

- first priority: Spanish
- also important: English
- long-term goal: support many languages well enough for practical conversation and language practice

## Autonomy, Safety, and Permissions

### Baseline behavior

By default, ASSEM should be conservative with sensitive actions.

Actions that should normally require confirmation include:

- sending messages
- deleting files
- making purchases
- moving money
- publishing content
- completing high-impact external forms or bookings

### Temporary autonomy

ASSEM should support explicit user-granted temporary autonomy, including instructions such as:

- do not ask again today
- send it without asking
- do whatever is needed to complete this task

Temporary autonomy should always be:

- visible
- scoped
- time-bounded when appropriate
- reversible
- recorded in history

### Permission model

ASSEM should support granular permissions, especially in early phases.

Examples:

- can read calendar
- can create events
- can draft messages
- can send messages only with confirmation
- can read local files
- cannot delete files

### Safe testing mode

There should always be a safe or sandbox mode for testing before real-world actions are allowed.

## Memory Model

### Highest priority memory requirement

The most important memory requirement is excellent memory of the current conversation.

Conversation continuity should be treated as a core quality feature.

### Persistent memory requirements

ASSEM should also support persistent user memory, but it must remain manageable by the user.

Required capabilities:

- inspect memory
- edit memory
- delete memory
- export memory
- import memory
- switch between memory packs or profiles
- merge memories later if useful
- reset to a clean state

### Practical interpretation

Memory should be separated into at least:

- current conversation context
- persistent user profile memory
- action history
- task or research outputs

Long-term habit learning should only emerge when a long-lived memory profile remains active over time.

## Integrations

### First integration priorities

1. local files
2. calendar
3. WhatsApp

### Broader long-term integrations

ASSEM should eventually operate across:

- calendars
- messaging apps
- browser workflows
- local files
- reminders
- notes
- tasks
- phone notifications
- calls
- cloud drives
- music or media services
- workplace tools
- social platforms when explicitly enabled

When an official API is not available, UI automation is acceptable if it is the best option for quality, reliability, or cost.

## Intelligence and Model Strategy

### Non-negotiable requirement

The intelligence layer must be easy to change.

ASSEM should be able to compare and combine:

- cloud providers such as OpenAI, Anthropic, or Google
- local models
- hybrid routing strategies

### Model specialization

It is acceptable, and likely preferable, to use different systems for:

- conversation
- planning
- voice
- vision
- tool selection
- research

The actual split should be chosen based on quality, cost, privacy, and reliability.

### Tool choice

Long term, ASSEM should decide automatically which tool or provider to use when appropriate.

If multiple good options exist and the choice affects cost, privacy, or outcome quality, the system can ask the user.

## Privacy Strategy

ASSEM must support multiple privacy modes, including a mode where no data leaves the device or local network.

If cloud models are used, the system should be designed so that future privacy improvements remain possible, for example:

- sending only the minimum necessary context
- using local preprocessing or summarization
- swapping to local models
- routing sensitive tasks away from cloud providers

## Cost Strategy

The project should not commit permanently to one model provider without usage and cost evaluation.

Before locking in a production strategy, ASSEM should support cost estimation based on realistic assistant usage patterns.

The requested benchmark style includes scenarios such as:

- heavy daily usage, for example 10 total hours per day for one week
- moderate continuous usage, for example 2 hours per day for two more weeks
- comparisons across cloud providers
- comparison against a local or private server model setup

Cost evaluation should consider:

- tokens or credits
- latency
- quality
- privacy impact
- infrastructure cost
- operating complexity

Target mindset:

- stay near a practical monthly budget around EUR 50 when possible
- accept higher complexity if it reduces cost without sacrificing quality
- prefer architectures that preserve a path to better privacy

## Research and Specialist Work

ASSEM should eventually support deep research style workflows.

Examples:

- investigate a topic
- specialize in a subject for the current task
- produce a structured report
- gather and summarize evidence

This should be treated as a first-class capability, not just a side feature.

## Delivery Strategy

### Recommended implementation path

1. Keep improving the current local-first modular base.
2. Make a small number of real integrations genuinely reliable.
3. Add visible permissions, confirmations, and history before broad automation.
4. Add voice once the core text plus tools loop is solid.
5. Expand to more devices through stable APIs and shared contracts.
6. Compare provider strategies with telemetry-backed cost and latency data.

### What to avoid

- hardcoding one AI provider deep into the system
- mixing UI logic with provider logic
- storing all memory as one opaque blob
- adding broad automation without visibility or permission controls
- optimizing only for speed if it harms quality, privacy, or cost

## Guidance for Future Codex Sessions

When working on ASSEM, future sessions should assume the following:

- the end goal is a universal assistant, not a narrow chatbot
- short-term work can be incremental, but should not block the long-term architecture
- if forced to choose, preserve modularity around providers, tools, memory, and policy
- preserve the feeling of one assistant even if internals become multi-agent
- build for explicit permissions, inspectability, and reversibility
- favor designs that keep open both local-only and cloud-backed operation
- treat quality, privacy, and cost as more important than simplicity

## Open Questions To Revisit Later

These are intentionally not fixed yet and can be decided with more evidence:

- exact backend shape for multi-device synchronization
- when to split beyond a well-structured modular monolith
- the final mobile packaging strategy
- the best provider mix for voice, conversation, and deep research
- the final UX balance between simplicity and control

## Summary

ASSEM is a local-first, modular, cross-device personal assistant and action agent.

It should feel like one assistant, support voice and text, perform real actions safely, remember what matters, expose its history and permissions, protect privacy, and remain flexible enough to swap models, integrations, and deployment modes as the product matures.
