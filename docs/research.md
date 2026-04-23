# Research v2

Research v2 extends `research_report_basic` from search-result grounding into a safer, stronger web-research flow with limited real page reading.

It is deliberately scoped:

- provider: Brave Search
- abstraction: `WebSearchProvider`
- tool id: `web-search.search`
- page reader abstraction: `WebPageReaderProvider`
- tool id: `web-page-reader.fetch-page`
- evidence: selected search results, snippets and a small number of fetched page excerpts
- no browser automation
- no aggressive scraping
- no crawling
- no Playwright
- no invented sources
- no obeying page content as instructions

## Configuration

Use `.env`:

```env
ASSEM_WEB_SEARCH_PROVIDER=brave
ASSEM_WEB_SEARCH_API_KEY=
ASSEM_WEB_SEARCH_ENDPOINT=https://api.search.brave.com/res/v1/web/search
ASSEM_WEB_SEARCH_MAX_RESULTS=5
ASSEM_WEB_SEARCH_TIMEOUT_MS=10000
ASSEM_WEB_PAGE_FETCH_ENABLED=true
ASSEM_WEB_PAGE_FETCH_TIMEOUT_MS=12000
ASSEM_WEB_PAGE_MAX_SOURCES=3
ASSEM_WEB_PAGE_MAX_CONTENT_CHARS=20000
```

`ASSEM_WEB_SEARCH_MAX_RESULTS` defaults to `5` and is capped at `10`.
`ASSEM_WEB_PAGE_MAX_SOURCES` defaults to `3` and is capped at `5`.

The provider is considered configured only when `ASSEM_WEB_SEARCH_PROVIDER=brave` and `ASSEM_WEB_SEARCH_API_KEY` is set.

## Privacy Behavior

- `local_only`: blocks Research v2 before task creation.
- `prefer_local`, `balanced`, `cloud_allowed`: allow web search when Brave is configured.
- If web search is blocked or unconfigured, ASSEM responds clearly and does not create a task or empty artifacts.

Research v2 can send:

- the search query to Brave Search
- HTTP GET requests for a small number of selected public pages

It does not send local files, audio, profile memory or sandbox contents.

## Runtime Flow

Planner creates this plan:

1. prepare workspace
2. search web sources
3. select useful sources
4. read selected pages
5. extract evidence
6. synthesize findings
7. write `report.md`
8. write `summary.txt`
9. write `sources.json`
10. write `evidence.json`

Task Runtime executes the plan and Task Manager persists the state.

If search fails or times out:

- task status becomes `failed`
- `metadata.research.searchError` is persisted
- no empty `report.md` or `summary.txt` is written

If search succeeds but no useful source can be selected:

- task status becomes `failed`
- selected sources stay empty
- no report or summary is generated

If useful but limited sources exist:

- ASSEM may generate `report.md`
- the report must include explicit evidence limits
- if no page read succeeds, the report must say it is snippet-only
- if evidence is too weak even for snippet-only synthesis, the task fails instead of inventing findings

## Source Selection

Results are normalized before selection.

ASSEM:

- ignores invalid URLs
- deduplicates by normalized URL
- derives source domain from URL
- can discard obvious blogs when the user says `no uses blogs`
- can mark official/primary domains when the user says `usa fuentes oficiales`
- can request recency support when the user says `prioriza fuentes recientes`

Each source record includes:

- title
- URL
- domain
- snippet when available
- `retrievedAt`
- `selectionStatus`
- `selectionReason`
- `fetchAttempted`
- `fetchStatus`
- `finalUrl`
- `fetchedTitle`
- `contentExcerpt`
- `contentLength`
- `evidenceLevel`
- `usedAs`

Common reasons:

- `matched_query`
- `duplicate_url`
- `invalid_url`
- `blog_excluded`
- `official_preferred`
- `selected_for_page_read`
- `page_read_successfully`
- `page_unreadable`
- `snippet_only`

## Artifacts

Generated artifacts live in the sandbox task workspace:

- `sources.json`
- `evidence.json`
- `summary.txt`
- `report.md`

`sources.json` includes:

- exact `query`
- `providerId`
- `retrievedAt`
- selected sources
- discarded sources
- selection notes
- limitations
- `searchError` when relevant

`evidence.json` includes:

- exact `query`
- `providerId`
- `retrievedAt`
- evidence level
- per-source evidence records
- page fetch results
- persisted limitations

Only cleaned excerpts, summaries and extracted facts are persisted. Raw HTML is not stored by default.

## Page Reading Security

Fetched page content is always treated as untrusted evidence, never as instructions.

Research v2:

- accepts only `http` / `https`
- rejects local/private targets like `localhost`, `127.0.0.1`, private IP ranges and redirects into them
- rejects unsupported content types such as binaries, PDFs, videos or images in this phase
- limits redirects, timeout and content size
- strips noisy HTML and keeps only cleaned readable text
- records `fetchStatus`, `httpStatus`, `contentType`, `finalUrl` and discard/error reason

If a page contains text like `ignore previous instructions`, `log in`, `download this`, or similar, that text is treated as risky page content, not as an instruction for ASSEM.

## Interruptions

The Interrupt Handler can answer source questions from persisted task metadata:

- `que fuentes has encontrado`
- `que fuentes estas usando`
- `cuantas fuentes tienes`
- `que fuentes has leido de verdad`
- `que paginas has podido leer`
- `que fuentes usaste solo como snippet`
- `que evidencia tienes`
- `que fuentes descartaste`

It returns title, domain and URL. It does not invent missing sources.

Supported research refinements:

- `usa fuentes oficiales`
- `no uses blogs`
- `prioriza fuentes recientes`
- `hazlo mas corto`
- `anade una tabla`

If a source refinement arrives after source selection is already complete, ASSEM records it honestly and does not pretend it already changed past work.

## Limitations

Research v2 is stronger, but it is still not a full browser research agent.

Current limitations:

- reads only a small safe subset of pages
- no browser navigation
- no paywall handling
- no crawling
- no multi-query research strategy yet
- no independent source verification beyond basic URL normalization and source selection
- no automatic rerun when late refinements arrive
- no obedience to page instructions; web content is always treated as untrusted corpus
