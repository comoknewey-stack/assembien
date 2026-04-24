import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  AssemTask,
  BrowserClickLinkOutput,
  BrowserFindOnPageOutput,
  BrowserOpenTransportRecord,
  BrowserPageLinkRecord,
  BrowserPageSnapshot,
  BrowserTaskMetadata,
  BrowserTaskVisitedPage,
  TaskArtifact,
  TaskCreateInput,
  TaskExecutionContext,
  TaskExecutionRequest,
  TaskExecutionResult,
  TaskInterruptState,
  TaskPhaseAdvanceInput,
  TaskProgressUpdateInput,
  TaskRunner,
  TaskStep
} from '@assem/shared-types';

interface BrowserReadBasicRunnerOptions {
  maxPagesPerTask?: number;
  maxLinksPerPage?: number;
  textMaxChars?: number;
}

interface BrowserReadBasicMetadata {
  taskType: 'browser_read_basic';
  workspaceRelativePath: string;
  notesRelativePath: string;
  snapshotRelativePath: string;
  navigationLogRelativePath: string;
  browser: BrowserTaskMetadata;
  interruptState?: TaskInterruptState;
}

const DEFAULT_BROWSER_MAX_PAGES_PER_TASK = 3;
const DEFAULT_BROWSER_MAX_LINKS_PER_PAGE = 20;
const DEFAULT_BROWSER_TEXT_MAX_CHARS = 12_000;

const BROWSER_READ_BASIC_STEPS: Array<{ id: string; label: string }> = [
  { id: 'prepare-workspace', label: 'Preparar carpeta de trabajo' },
  { id: 'open-page', label: 'Abrir pagina inicial' },
  { id: 'extract-page', label: 'Extraer contenido visible' },
  { id: 'follow-links', label: 'Seguir enlaces seguros si hace falta' },
  { id: 'extract-findings', label: 'Extraer hallazgos' },
  { id: 'write-browser-notes', label: 'Guardar notas del navegador' },
  { id: 'write-browser-snapshot', label: 'Guardar snapshot de pagina' },
  { id: 'write-navigation-log', label: 'Guardar log de navegacion' }
];

function slugifyObjective(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return normalized || 'browser-task';
}

function cleanObjective(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/[?!,.;:]+$/g, '').trim();
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/\bhttps?:\/\/[^\s<>"')]+/i);
  return match ? cleanObjective(match[0]) : null;
}

function stripUrlFromText(text: string, url: string | null): string {
  if (!url) {
    return cleanObjective(text);
  }

  return cleanObjective(text.replace(url, ' ').replace(/\s+/g, ' '));
}

function extractBrowserFindQuery(text: string): string | null {
  const patterns = [
    /(?:busca(?:\s+si\s+menciona)?|comprueba(?:\s+si\s+menciona)?|mira\s+si\s+menciona)\s+(.+?)(?:\s+en\s+(?:la\s+)?(?:pagina|web)|$)/i,
    /(?:find|search\s+for|check\s+whether\s+it\s+mentions)\s+(.+?)(?:\s+on\s+(?:the\s+)?(?:page|site)|$)/i
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = cleanObjective(match?.[1] ?? '');
    if (value) {
      return value;
    }
  }

  return null;
}

function detectFollowUpMode(
  text: string,
  targetQuery: string | null
): BrowserTaskMetadata['followUpMode'] {
  if (targetQuery) {
    return 'find_text';
  }

  if (/(?:enlaces?\s+principales|links?\s+principales|principal(?:es)?\s+links?)/i.test(text)) {
    return 'links';
  }

  return 'summarize';
}

function resolveInterruptState(
  metadata: BrowserReadBasicMetadata
): TaskInterruptState {
  return metadata.interruptState ?? {
    refinements: []
  };
}

function findLatestRefinement(
  metadata: BrowserReadBasicMetadata,
  type: string
) {
  return [...resolveInterruptState(metadata).refinements]
    .reverse()
    .find((refinement) => refinement.type === type);
}

function shouldPreferOfficialLinks(metadata: BrowserReadBasicMetadata): boolean {
  return findLatestRefinement(metadata, 'source_preference')?.value === 'official';
}

function shouldExcludeBlogs(metadata: BrowserReadBasicMetadata): boolean {
  return findLatestRefinement(metadata, 'source_exclusion')?.value === 'blogs';
}

function resolveFindQuery(metadata: BrowserReadBasicMetadata): string | undefined {
  const refinementValue = findLatestRefinement(metadata, 'browser_find_text')?.value;
  return refinementValue || metadata.browser.targetQuery;
}

function resolveFollowInstruction(metadata: BrowserReadBasicMetadata): string | undefined {
  return findLatestRefinement(metadata, 'browser_follow_link')?.value;
}

function resolveTextMaxChars(options: BrowserReadBasicRunnerOptions): number {
  return Math.max(1_000, options.textMaxChars ?? DEFAULT_BROWSER_TEXT_MAX_CHARS);
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, '[redacted-secret]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [redacted]');
}

function hasBrowserOpenFailure(
  transport: BrowserOpenTransportRecord | undefined
): boolean {
  return Boolean(transport?.openErrorType || transport?.openErrorMessage);
}

function buildBrowserTransportNotes(
  transport: BrowserOpenTransportRecord | undefined
): string[] {
  return transport?.transportNotes?.filter((note) => note.trim().length > 0) ?? [];
}

function buildBrowserTransportFailureSummary(
  transport: BrowserOpenTransportRecord | undefined
): string | undefined {
  if (!transport) {
    return undefined;
  }

  const parts: string[] = [];
  if (transport.openErrorType) {
    parts.push(`tipo=${transport.openErrorType}`);
  }
  if (transport.openErrorMessage) {
    parts.push(`mensaje=${transport.openErrorMessage}`);
  }
  if (transport.openErrorCause) {
    parts.push(`causa=${transport.openErrorCause}`);
  }
  if (transport.fallbackAttempted) {
    parts.push(
      transport.fallbackSucceeded
        ? `fallback=${transport.fallbackMode ?? 'unknown'} correcto`
        : `fallback=${transport.fallbackMode ?? 'unknown'} fallido`
    );
  } else {
    parts.push(`fallback=${transport.fallbackMode ?? 'none'} no intentado`);
  }

  return parts.length > 0 ? parts.join(' | ') : undefined;
}

function buildBrowserTaskError(
  url: string,
  transport: BrowserOpenTransportRecord | undefined
): string {
  const attemptedUrl = transport?.attemptedUrl ?? url;
  const summary =
    buildBrowserTransportFailureSummary(transport) ?? 'apertura degradada o bloqueada';
  return sanitizeErrorMessage(`No se pudo abrir ${attemptedUrl}: ${summary}`);
}

function resolveSandboxPath(sandboxRoot: string, relativePath: string): string {
  const normalizedRoot = path.resolve(sandboxRoot);
  const candidate = path.resolve(normalizedRoot, relativePath);
  const rootLower = normalizedRoot.toLowerCase();
  const candidateLower = candidate.toLowerCase();
  const rootWithSeparator = rootLower.endsWith(path.sep.toLowerCase())
    ? rootLower
    : `${rootLower}${path.sep.toLowerCase()}`;

  if (candidateLower !== rootLower && !candidateLower.startsWith(rootWithSeparator)) {
    throw new Error('La ruta del runtime queda fuera del sandbox configurado.');
  }

  return candidate;
}

function ensureBrowserMetadata(task: AssemTask): BrowserReadBasicMetadata {
  const metadata = task.metadata ?? {};

  if (metadata.taskType !== 'browser_read_basic') {
    throw new Error(`Unsupported task type for runtime task ${task.id}.`);
  }

  if (
    typeof metadata.workspaceRelativePath !== 'string' ||
    typeof metadata.notesRelativePath !== 'string' ||
    typeof metadata.snapshotRelativePath !== 'string' ||
    typeof metadata.navigationLogRelativePath !== 'string' ||
    typeof metadata.browser !== 'object' ||
    metadata.browser === null
  ) {
    throw new Error(`The browser runtime metadata for task ${task.id} is incomplete.`);
  }

  const resolved = metadata as unknown as BrowserReadBasicMetadata;
  return {
    ...resolved,
    browser: {
      ...resolved.browser,
      pagesVisited: resolved.browser.pagesVisited ?? [],
      navigationLog: resolved.browser.navigationLog ?? [],
      findings: resolved.browser.findings ?? [],
      safetyNotes: resolved.browser.safetyNotes ?? [],
      blockedActions: resolved.browser.blockedActions ?? [],
      transportNotes: resolved.browser.transportNotes ?? []
    }
  };
}

function appendVisitedPage(
  metadata: BrowserReadBasicMetadata,
  snapshot: BrowserPageSnapshot
): BrowserTaskVisitedPage[] {
  return [
    ...metadata.browser.pagesVisited,
    {
      ...snapshot,
      navigationIndex: metadata.browser.pagesVisited.length
    }
  ];
}

function isOfficialDomain(domain: string): boolean {
  return /\.(?:gov|edu|int)$/i.test(domain) || /(?:^|\.)europa\.eu$/i.test(domain);
}

function isBlogDomain(domain: string, url: string): boolean {
  return (
    /(?:^|\.)medium\.com$/i.test(domain) ||
    /(?:^|\.)substack\.com$/i.test(domain) ||
    /(?:^|\.)wordpress\.com$/i.test(domain) ||
    /(?:^|\.)blogspot\.com$/i.test(domain) ||
    /\bblog\b/i.test(domain) ||
    /\/blog(?:\/|$)/i.test(url)
  );
}

function scoreBrowserLink(
  link: BrowserPageLinkRecord,
  metadata: BrowserReadBasicMetadata
): number {
  if (link.safety !== 'safe_navigation') {
    return -100;
  }

  let score = 0;
  if (link.sameDomain) {
    score += 5;
  }
  if (!link.externalDomain) {
    score += 2;
  }

  const query = resolveFindQuery(metadata)?.toLowerCase();
  if (query && `${link.text} ${link.url}`.toLowerCase().includes(query)) {
    score += 6;
  }

  const instruction = resolveFollowInstruction(metadata)?.toLowerCase();
  if (instruction && `${link.text} ${link.url}`.toLowerCase().includes(instruction)) {
    score += 8;
  }

  if (shouldPreferOfficialLinks(metadata) && isOfficialDomain(link.domain)) {
    score += 7;
  }

  if (shouldExcludeBlogs(metadata) && isBlogDomain(link.domain, link.url)) {
    score -= 12;
  }

  if (/official|oficial|source|fuente|report|dataset|data|statistics|estadisticas?/i.test(link.text)) {
    score += 3;
  }

  return score;
}

function selectBestLink(
  links: BrowserPageLinkRecord[],
  metadata: BrowserReadBasicMetadata
): BrowserPageLinkRecord | null {
  const ranked = links
    .map((link) => ({
      link,
      score: scoreBrowserLink(link, metadata)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.link ?? null;
}

function buildFindings(
  metadata: BrowserReadBasicMetadata
): string[] {
  const transport = metadata.browser.openTransport;
  if (hasBrowserOpenFailure(transport)) {
    const attemptedUrl =
      transport?.attemptedUrl ??
      metadata.browser.currentUrl ??
      metadata.browser.initialUrl;
    const summary = buildBrowserTransportFailureSummary(transport);
    const findings = [
      `No se pudo abrir ${attemptedUrl}.`,
      summary ? `Diagnostico de transporte: ${summary}.` : ''
    ].filter(Boolean);

    if (metadata.browser.visibleTextExcerpt) {
      const currentUrl = metadata.browser.currentUrl ?? metadata.browser.initialUrl;
      const currentTitle = metadata.browser.currentTitle ?? currentUrl;
      findings.push(
        `Se conserva el ultimo contenido valido persistido de ${currentTitle} (${currentUrl}).`
      );
      findings.push(`Resumen visible: ${metadata.browser.visibleTextExcerpt}`);
    }

    const notes = buildBrowserTransportNotes(transport);
    if (notes.length > 0) {
      findings.push(`Notas de transporte: ${notes.join(' | ')}.`);
    }

    return findings;
  }

  const findings: string[] = [];
  const currentUrl = metadata.browser.currentUrl ?? metadata.browser.initialUrl;
  const currentTitle = metadata.browser.currentTitle ?? currentUrl;
  findings.push(`Pagina actual: ${currentTitle} (${currentUrl}).`);

  if (metadata.browser.visibleTextExcerpt) {
    findings.push(`Resumen visible: ${metadata.browser.visibleTextExcerpt}`);
  }

  if (metadata.browser.lastFindResult) {
    findings.push(
      metadata.browser.lastFindResult.found
        ? `La pagina menciona "${metadata.browser.lastFindResult.query}" ${metadata.browser.lastFindResult.matchCount} vez/veces.`
        : `No he encontrado "${metadata.browser.lastFindResult.query}" en el texto visible persistido.`
    );
  }

  if (metadata.browser.visibleLinks?.length) {
    const preview = metadata.browser.visibleLinks
      .slice(0, 5)
      .map((link) => `${link.text} -> ${link.url}`)
      .join(' | ');
    findings.push(`Enlaces visibles: ${preview}`);
  }

  if (metadata.browser.safetyNotes.length > 0) {
    findings.push(
      `Notas de seguridad: ${metadata.browser.safetyNotes.join(', ')}.`
    );
  }

  return findings;
}

function buildBrowserNotesMarkdown(metadata: BrowserReadBasicMetadata): string {
  const transport = metadata.browser.openTransport;
  const lines: string[] = [
    `# Browser notes`,
    ``,
    `- URL inicial: ${metadata.browser.initialUrl}`,
    `- URL actual: ${metadata.browser.currentUrl ?? metadata.browser.initialUrl}`,
    `- Titulo actual: ${metadata.browser.currentTitle ?? 'sin titulo'}`,
    `- Paginas visitadas: ${metadata.browser.pagesVisited.length}`,
    `- Enlaces visibles actuales: ${metadata.browser.visibleLinks?.length ?? 0}`,
    ``
  ];

  if (transport) {
    lines.push(`## Apertura / transporte`);
    lines.push(`- Intento de apertura: ${transport.openAttemptedAt}`);
    lines.push(`- URL intentada: ${transport.attemptedUrl}`);
    if (transport.finalUrl) {
      lines.push(`- URL final: ${transport.finalUrl}`);
    }
    lines.push(
      `- Fallback: ${transport.fallbackAttempted ? `intentado (${transport.fallbackMode})` : `no intentado (${transport.fallbackMode})`}`
    );
    if (transport.openErrorType) {
      lines.push(`- Tipo de fallo: ${transport.openErrorType}`);
    }
    if (transport.openErrorMessage) {
      lines.push(`- Mensaje: ${transport.openErrorMessage}`);
    }
    if (transport.openErrorCause) {
      lines.push(`- Causa: ${transport.openErrorCause}`);
    }
    if (transport.transportNotes.length > 0) {
      for (const note of transport.transportNotes) {
        lines.push(`- Nota: ${note}`);
      }
    }
    lines.push(``);
  }

  if (metadata.browser.lastFindResult) {
    lines.push(`## Consulta en pagina`);
    lines.push(
      metadata.browser.lastFindResult.found
        ? `Se encontro "${metadata.browser.lastFindResult.query}" ${metadata.browser.lastFindResult.matchCount} vez/veces.`
        : `No se encontro "${metadata.browser.lastFindResult.query}" en el texto visible persistido.`
    );
    if (metadata.browser.lastFindResult.excerpt) {
      lines.push(``);
      lines.push(metadata.browser.lastFindResult.excerpt);
    }
    lines.push(``);
  }

  lines.push(`## Hallazgos`);
  for (const finding of metadata.browser.findings) {
    lines.push(`- ${finding}`);
  }
  lines.push(``);
  lines.push(`## Paginas visitadas`);
  for (const page of metadata.browser.pagesVisited) {
    lines.push(
      `- ${page.title ?? 'sin titulo'} | ${page.finalUrl} | estado=${page.status}`
    );
  }
  lines.push(``);
  lines.push(`## Notas de seguridad`);
  if (metadata.browser.safetyNotes.length === 0) {
    lines.push(`- sin notas de seguridad registradas`);
  } else {
    for (const note of metadata.browser.safetyNotes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join('\n');
}

function buildPageSnapshotJson(metadata: BrowserReadBasicMetadata): string {
  return JSON.stringify(
    {
      initialUrl: metadata.browser.initialUrl,
      currentUrl: metadata.browser.currentUrl,
      currentTitle: metadata.browser.currentTitle,
      openTransport: metadata.browser.openTransport,
      transportNotes: metadata.browser.transportNotes,
      pagesVisited: metadata.browser.pagesVisited,
      lastSnapshot: metadata.browser.lastSnapshot,
      lastFindResult: metadata.browser.lastFindResult,
      visibleLinks: metadata.browser.visibleLinks,
      safetyNotes: metadata.browser.safetyNotes,
      blockedActions: metadata.browser.blockedActions
    },
    null,
    2
  );
}

function buildNavigationLogJson(metadata: BrowserReadBasicMetadata): string {
  return JSON.stringify(
    {
      initialUrl: metadata.browser.initialUrl,
      currentUrl: metadata.browser.currentUrl,
      openTransport: metadata.browser.openTransport,
      transportNotes: metadata.browser.transportNotes,
      navigationLog: metadata.browser.navigationLog
    },
    null,
    2
  );
}

export class BrowserReadBasicTaskRunner implements TaskRunner {
  readonly taskType = 'browser_read_basic' as const;

  constructor(private readonly options: BrowserReadBasicRunnerOptions = {}) {}

  createTaskInput(
    request: TaskExecutionRequest
  ): Omit<TaskCreateInput, 'sessionId' | 'objective'> {
    const objective = cleanObjective(request.objective);
    const initialUrl = extractFirstUrl(objective);
    if (!initialUrl) {
      throw new Error('Browser Automation v1 necesita una URL publica para abrir la tarea.');
    }

    const objectiveSlug = slugifyObjective(objective);
    const timestamp = Date.now();
    const workspaceRelativePath = path.posix.join(
      'tasks',
      `${objectiveSlug}-${timestamp}`
    );

    const targetQuery = extractBrowserFindQuery(stripUrlFromText(objective, initialUrl));

    const metadata: BrowserReadBasicMetadata = {
      taskType: 'browser_read_basic',
      workspaceRelativePath,
      notesRelativePath: path.posix.join(workspaceRelativePath, 'browser-notes.md'),
      snapshotRelativePath: path.posix.join(workspaceRelativePath, 'page-snapshot.json'),
      navigationLogRelativePath: path.posix.join(
        workspaceRelativePath,
        'navigation-log.json'
      ),
      browser: {
        initialUrl,
        targetQuery: targetQuery ?? undefined,
        targetInstruction: stripUrlFromText(objective, initialUrl),
        pagesVisited: [],
        navigationLog: [],
        findings: [],
        safetyNotes: [],
        transportNotes: [],
        followUpMode: detectFollowUpMode(objective, targetQuery),
        blockedActions: []
      },
      interruptState: {
        refinements: request.plan?.refinements ?? []
      }
    };

    return {
      status: request.autoStart === false ? 'pending' : 'active',
      progressPercent: 0,
      currentPhase: request.plan?.phases[0]?.label ?? 'Preparando la tarea web',
      steps:
        request.plan?.steps.map((step) => ({
          id: step.id,
          label: step.label
        })) ?? BROWSER_READ_BASIC_STEPS,
      currentStepId: request.plan?.steps[0]?.id ?? BROWSER_READ_BASIC_STEPS[0].id,
      plan: request.plan,
      metadata: metadata as unknown as Record<string, unknown>
    };
  }

  selectNextStep(task: AssemTask): TaskStep | null {
    return (
      task.steps.find(
        (step) => step.status !== 'completed' && step.status !== 'cancelled'
      ) ?? null
    );
  }

  async executeStep(step: TaskStep, context: TaskExecutionContext): Promise<void> {
    const task = await context.getTask();
    const metadata = ensureBrowserMetadata(task);

    if (step.id === 'prepare-workspace') {
      const absoluteWorkspacePath = resolveSandboxPath(
        context.sandboxRoot,
        metadata.workspaceRelativePath
      );
      await fs.mkdir(absoluteWorkspacePath, { recursive: true });
      await context.ensureArtifact({
        kind: 'directory',
        label: 'Carpeta de trabajo',
        filePath: absoluteWorkspacePath,
        description: 'Workspace local de la tarea web.'
      });
      return;
    }

    if (step.id === 'open-page') {
      const opened = await context.executeTool<
        { url: string },
        { pageId: string; snapshot: BrowserPageSnapshot }
      >('browser-automation.open-page', {
        url: metadata.browser.initialUrl
      });
      const snapshot = opened.output.snapshot;
      const transport = snapshot.transport;
      const browserError = hasBrowserOpenFailure(transport)
        ? buildBrowserTaskError(metadata.browser.initialUrl, transport)
        : undefined;
      const nextMetadata: BrowserReadBasicMetadata = {
        ...metadata,
        browser: {
          ...metadata.browser,
          currentPageId: opened.output.pageId,
          currentUrl: snapshot.finalUrl,
          currentTitle: snapshot.title,
          lastSnapshot: snapshot,
          pagesVisited: appendVisitedPage(metadata, snapshot),
          visibleTextExcerpt: snapshot.visibleTextExcerpt,
          visibleLinks: snapshot.links,
          openTransport: transport,
          transportNotes: [
            ...new Set([
              ...(metadata.browser.transportNotes ?? []),
              ...buildBrowserTransportNotes(transport)
            ])
          ],
          safetyNotes: [...new Set([...metadata.browser.safetyNotes, ...(snapshot.safetyNotes ?? [])])],
          browserError,
          navigationLog: [
            ...metadata.browser.navigationLog,
            {
              id: crypto.randomUUID(),
              pageId: snapshot.pageId,
              action: 'open',
              toUrl: snapshot.finalUrl,
              title: snapshot.title,
              detail: snapshot.snapshotSummary,
              recordedAt: new Date().toISOString(),
              transport
            }
          ]
        }
      };
      await context.mergeMetadata(nextMetadata as unknown as Record<string, unknown>);
      if (snapshot.status === 'error' || snapshot.status === 'blocked') {
        throw new Error(browserError ?? buildBrowserTaskError(metadata.browser.initialUrl, transport));
      }
      return;
    }

    if (step.id === 'extract-page') {
      if (!metadata.browser.currentPageId) {
        throw new Error('No hay pagina activa para extraer contenido visible.');
      }

      const visibleText = await context.executeTool<
        { pageId: string; maxChars: number },
        { pageId: string; excerpt: string; contentLength: number }
      >('browser-automation.extract-visible-text', {
        pageId: metadata.browser.currentPageId,
        maxChars: resolveTextMaxChars(this.options)
      });
      const links = await context.executeTool<
        { pageId: string; maxLinks: number },
        { pageId: string; links: BrowserPageLinkRecord[] }
      >('browser-automation.list-visible-links', {
        pageId: metadata.browser.currentPageId,
        maxLinks: this.options.maxLinksPerPage ?? DEFAULT_BROWSER_MAX_LINKS_PER_PAGE
      });

      let lastFindResult: BrowserFindOnPageOutput | undefined;
      const targetQuery = resolveFindQuery(metadata);
      if (targetQuery) {
        const findResult = await context.executeTool<
          { pageId: string; query: string },
          BrowserFindOnPageOutput
        >('browser-automation.find-on-page', {
          pageId: metadata.browser.currentPageId,
          query: targetQuery
        });
        lastFindResult = findResult.output;
      }

      const snapshot = await context.executeTool<
        { pageId: string },
        BrowserPageSnapshot
      >('browser-automation.get-page-snapshot', {
        pageId: metadata.browser.currentPageId
      });
      const transport = snapshot.output.transport;

      const nextMetadata: BrowserReadBasicMetadata = {
        ...metadata,
        browser: {
          ...metadata.browser,
          currentUrl: snapshot.output.finalUrl,
          currentTitle: snapshot.output.title,
          lastSnapshot: snapshot.output,
          visibleTextExcerpt: visibleText.output.excerpt,
          visibleLinks: links.output.links,
          openTransport: transport,
          transportNotes: [
            ...new Set([
              ...(metadata.browser.transportNotes ?? []),
              ...buildBrowserTransportNotes(transport)
            ])
          ],
          lastFindResult,
          findings: buildFindings({
            ...metadata,
            browser: {
              ...metadata.browser,
              currentUrl: snapshot.output.finalUrl,
              currentTitle: snapshot.output.title,
              lastSnapshot: snapshot.output,
              visibleTextExcerpt: visibleText.output.excerpt,
              visibleLinks: links.output.links,
              lastFindResult,
              openTransport: transport,
              transportNotes: [
                ...new Set([
                  ...(metadata.browser.transportNotes ?? []),
                  ...buildBrowserTransportNotes(transport)
                ])
              ]
            }
          }),
          safetyNotes: [
            ...new Set([
              ...metadata.browser.safetyNotes,
              ...(snapshot.output.safetyNotes ?? [])
            ])
          ],
          browserError: hasBrowserOpenFailure(transport)
            ? buildBrowserTaskError(metadata.browser.currentUrl ?? metadata.browser.initialUrl, transport)
            : undefined
        }
      };
      await context.mergeMetadata(nextMetadata as unknown as Record<string, unknown>);
      return;
    }

    if (step.id === 'follow-links') {
      if (!metadata.browser.currentPageId || !metadata.browser.visibleLinks?.length) {
        return;
      }

      const maxPages = Math.max(
        1,
        this.options.maxPagesPerTask ?? DEFAULT_BROWSER_MAX_PAGES_PER_TASK
      );
      if (metadata.browser.pagesVisited.length >= maxPages) {
        return;
      }

      const bestLink = selectBestLink(metadata.browser.visibleLinks, metadata);
      if (!bestLink) {
        return;
      }

      const clicked = await context.executeTool<
        { pageId: string; linkId: string },
        BrowserClickLinkOutput
      >('browser-automation.click-link', {
        pageId: metadata.browser.currentPageId,
        linkId: bestLink.id
      });

      if (clicked.output.navigation.blocked) {
        const nextMetadata: BrowserReadBasicMetadata = {
          ...metadata,
          browser: {
            ...metadata.browser,
            blockedActions: [
              ...metadata.browser.blockedActions,
              {
                action: 'click-link',
                url: clicked.output.navigation.toUrl,
                reason: clicked.output.navigation.reason ?? 'blocked_navigation',
                recordedAt: clicked.output.navigation.recordedAt
              }
            ],
            navigationLog: [
              ...metadata.browser.navigationLog,
              clicked.output.navigation
            ]
          }
        };
        await context.mergeMetadata(nextMetadata as unknown as Record<string, unknown>);
        return;
      }

      const snapshot = clicked.output.snapshot;
      const visibleText = await context.executeTool<
        { pageId: string; maxChars: number },
        { pageId: string; excerpt: string; contentLength: number }
      >('browser-automation.extract-visible-text', {
        pageId: snapshot.pageId,
        maxChars: resolveTextMaxChars(this.options)
      });
      const links = await context.executeTool<
        { pageId: string; maxLinks: number },
        { pageId: string; links: BrowserPageLinkRecord[] }
      >('browser-automation.list-visible-links', {
        pageId: snapshot.pageId,
        maxLinks: this.options.maxLinksPerPage ?? DEFAULT_BROWSER_MAX_LINKS_PER_PAGE
      });

      const nextMetadata: BrowserReadBasicMetadata = {
        ...metadata,
        browser: {
          ...metadata.browser,
          currentPageId: snapshot.pageId,
          currentUrl: snapshot.finalUrl,
          currentTitle: snapshot.title,
          lastSnapshot: snapshot,
          pagesVisited: appendVisitedPage(metadata, snapshot),
          visibleTextExcerpt: visibleText.output.excerpt,
          visibleLinks: links.output.links,
          navigationLog: [...metadata.browser.navigationLog, clicked.output.navigation],
          safetyNotes: [
            ...new Set([
              ...metadata.browser.safetyNotes,
              ...(snapshot.safetyNotes ?? [])
            ])
          ],
          openTransport: snapshot.transport,
          transportNotes: [
            ...new Set([
              ...(metadata.browser.transportNotes ?? []),
              ...buildBrowserTransportNotes(snapshot.transport)
            ])
          ],
          browserError: undefined
        }
      };

      if (snapshot.status === 'error' || snapshot.status === 'blocked') {
        const partialFailureMetadata: BrowserReadBasicMetadata = {
          ...metadata,
          browser: {
            ...metadata.browser,
            pagesVisited: appendVisitedPage(metadata, snapshot),
            navigationLog: [...metadata.browser.navigationLog, clicked.output.navigation],
            openTransport: snapshot.transport,
            transportNotes: [
              ...new Set([
                ...(metadata.browser.transportNotes ?? []),
                ...buildBrowserTransportNotes(snapshot.transport)
              ])
            ],
            browserError: buildBrowserTaskError(snapshot.finalUrl, snapshot.transport),
            findings: buildFindings({
              ...metadata,
              browser: {
                ...metadata.browser,
                openTransport: snapshot.transport,
                transportNotes: [
                  ...new Set([
                    ...(metadata.browser.transportNotes ?? []),
                    ...buildBrowserTransportNotes(snapshot.transport)
                  ])
                ]
              }
            })
          }
        };
        await context.mergeMetadata(
          partialFailureMetadata as unknown as Record<string, unknown>
        );
        return;
      }

      await context.mergeMetadata(nextMetadata as unknown as Record<string, unknown>);
      return;
    }

    if (step.id === 'extract-findings') {
      const nextMetadata: BrowserReadBasicMetadata = {
        ...metadata,
        browser: {
          ...metadata.browser,
          findings: buildFindings(metadata)
        }
      };
      await context.mergeMetadata(nextMetadata as unknown as Record<string, unknown>);
      return;
    }

    if (step.id === 'write-browser-notes') {
      const absoluteNotesPath = resolveSandboxPath(
        context.sandboxRoot,
        metadata.notesRelativePath
      );
      await fs.mkdir(path.dirname(absoluteNotesPath), { recursive: true });
      await fs.writeFile(absoluteNotesPath, buildBrowserNotesMarkdown(metadata), 'utf8');
      await context.ensureArtifact({
        kind: 'document',
        label: 'Notas del navegador',
        filePath: absoluteNotesPath,
        contentType: 'text/markdown',
        description: 'Hallazgos trazables derivados de snapshots persistidos.'
      });
      return;
    }

    if (step.id === 'write-browser-snapshot') {
      const absoluteSnapshotPath = resolveSandboxPath(
        context.sandboxRoot,
        metadata.snapshotRelativePath
      );
      await fs.mkdir(path.dirname(absoluteSnapshotPath), { recursive: true });
      await fs.writeFile(
        absoluteSnapshotPath,
        buildPageSnapshotJson(metadata),
        'utf8'
      );
      await context.ensureArtifact({
        kind: 'document',
        label: 'Snapshot de pagina',
        filePath: absoluteSnapshotPath,
        contentType: 'application/json',
        description: 'Estado persistido de paginas visitadas y contenido visible.'
      });
      return;
    }

    if (step.id === 'write-navigation-log') {
      const absoluteNavigationLogPath = resolveSandboxPath(
        context.sandboxRoot,
        metadata.navigationLogRelativePath
      );
      await fs.mkdir(path.dirname(absoluteNavigationLogPath), { recursive: true });
      await fs.writeFile(
        absoluteNavigationLogPath,
        buildNavigationLogJson(metadata),
        'utf8'
      );
      await context.ensureArtifact({
        kind: 'document',
        label: 'Log de navegacion',
        filePath: absoluteNavigationLogPath,
        contentType: 'application/json',
        description: 'Historial persistido de navegacion segura.'
      });
      return;
    }

    throw new Error(`Unknown browser task step: ${step.id}`);
  }

  async buildExecutionResult(task: AssemTask): Promise<TaskExecutionResult> {
    const metadata = ensureBrowserMetadata(task);
    const summary = `La tarea web "${task.objective}" se ha completado. Artefactos: ${task.artifacts.map((artifact: TaskArtifact) => artifact.label).join(', ') || 'sin artefactos adjuntos'}.`;

    return {
      taskId: task.id,
      taskType: this.taskType,
      status:
        task.status === 'failed' || task.status === 'cancelled'
          ? task.status
          : 'completed',
      summary,
      artifacts: task.artifacts,
      completedAt: task.completedAt ?? new Date().toISOString()
    };
  }
}
