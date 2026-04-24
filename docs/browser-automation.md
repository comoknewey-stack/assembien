# Browser Automation v1.1

Browser Automation v1.1 adds a bounded, traceable web-reading workflow to ASSEM. It is integrated into the existing planner, task runtime, task manager, interrupt handler and orchestrator, but it is intentionally not a free-form browser agent.

Current implementation choice:

- provider id: `safe-http-browser`
- implementation strategy: bounded HTTP fetch + page snapshot extraction + safe-link classification
- not yet: full interactive Playwright automation
- not yet: any unsafe TLS bypass or permissive fallback route

## Scope

Task type:

- `browser_read_basic`

Supported capabilities in this phase:

- open a public page
- navigate to a URL
- read title and visible text
- list visible links
- search for a query inside the current page snapshot
- follow a very small number of safe navigation links
- persist grounded task artifacts and answer follow-up questions from real state

Not supported in v1:

- login flows
- credentials
- purchases or payments
- irreversible form submission
- uploads
- email/webmail actions
- account settings changes
- aggressive crawling
- unrestricted cross-site browsing

## Opening failures and transport diagnostics

Browser Automation v1.1 classifies page-opening failures instead of collapsing them into a generic `fetch failed`.

Supported opening-failure categories:

- `dns_error`
- `tls_error`
- `timeout`
- `connection_refused`
- `redirect_error`
- `http_error`
- `content_blocked`
- `unsupported_content_type`
- `network_error`
- `unknown_error`

When opening a page fails, ASSEM persists:

- attempted URL
- final URL if known
- opening timestamp
- classified error type
- primary error message
- original cause if available
- whether fallback was attempted
- whether fallback succeeded
- fallback mode
- transport notes
- HTTP status and content type when they exist

These diagnostics are stored in browser task metadata and also appear in `page-snapshot.json`, `navigation-log.json` and `browser-notes.md`.

Important behavior:

- if the initial page cannot be opened, the browser task fails honestly
- no visible text or findings are fabricated
- ASSEM does not mark the task as completed
- if a secondary page fails later in a bounded navigation flow, that failure can be persisted as a partial navigation failure without pretending that the page was read

## TLS and fallback policy

Browser Automation v1.1 does **not** disable TLS validation globally.

Explicit non-goals in this phase:

- no `NODE_TLS_REJECT_UNAUTHORIZED=0`
- no global trust relaxation
- no blanket acceptance of invalid certificates

Fallback policy in v1.1:

- there is no extra permissive fallback route for TLS or transport failures
- fallback is persisted as `not attempted` in these cases
- this is deliberate: ASSEM prefers a clear, grounded failure over an unsafe read path

## Safety model

Browser Automation v1 is read-first and bounded.

Allowed without extra confirmation:

- open URL
- read page
- extract visible text
- list visible links
- search within the current page
- follow clearly safe navigation links
- close page state

Blocked or treated as sensitive:

- links that look like `login`, `sign in`, `buy`, `pay`, `submit`, `register`, `delete`, `accept`, `authorize`
- non-HTTP(S) links
- private/local destinations
- binary or unsupported content types

Web content is always treated as untrusted external data:

- it cannot change prompts, policies or tools
- it cannot issue instructions to ASSEM
- suspicious text is persisted as `safetyNotes`

## Planner / Runtime flow

Planner detects requests such as:

- `abre esta web y dime de que trata`
- `mira esta pagina y saca los enlaces principales`
- `visita esta URL y dime que dice`
- `busca X en esta pagina`

The plan for `browser_read_basic` is:

1. `prepare-workspace`
2. `open-page`
3. `extract-page`
4. `follow-links`
5. `extract-findings`
6. `write-browser-notes`
7. `write-browser-snapshot`
8. `write-navigation-log`

The runtime executes those phases with real tool calls and persists metadata plus artifacts.

## Persisted state

Browser task metadata stores, at minimum:

- current URL and title
- pages visited
- visible text excerpt
- visible links
- navigation log
- findings
- blocked actions
- safety notes
- last in-page search result
- opening transport diagnostics

Generated artifacts:

- `browser-notes.md`
- `page-snapshot.json`
- `navigation-log.json`

## Interrupts and follow-ups

These follow-ups are answered from persisted task state, not from model guesses:

- `que pagina has abierto`
- `en que url estas`
- `que enlaces viste`
- `que has encontrado`
- `que pasos has dado`
- `por que ha fallado`
- `que error dio`
- `intentaste otra ruta`

Supported refinements in this phase:

- `sigue el enlace mas relevante`
- `busca X en la pagina`
- `ve a la fuente oficial`
- `no sigas blogs`
- `quedate solo con paginas oficiales`

If a refinement arrives after the relevant step already finished, ASSEM persists it honestly and does not pretend to have replayed completed navigation.

## Privacy and modes

- `local_only` blocks browser automation before task creation.
- In other modes, browser tasks run only if `ASSEM_BROWSER_AUTOMATION_ENABLED=true`.
- Browser Automation v1 uses bounded HTTP page access and safe link following.
- It does not use desktop automation.

## Configuration

```env
ASSEM_BROWSER_AUTOMATION_ENABLED=true
ASSEM_BROWSER_MAX_PAGES_PER_TASK=3
ASSEM_BROWSER_MAX_LINKS_PER_PAGE=20
ASSEM_BROWSER_TEXT_MAX_CHARS=12000
ASSEM_BROWSER_TIMEOUT_MS=15000
ASSEM_BROWSER_ALLOW_SCREENSHOTS=false
```

Notes:

- screenshots remain disabled by default in this phase
- page count, link count and extracted text are all hard-limited
- Browser Automation v1.1 is designed to stay auditable and cheap, not broad
- transport failures are persisted with classified error types instead of generic success/failure text
