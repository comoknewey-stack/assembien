import type {
  AssemTask,
  SupportedLanguage,
  TaskPlan,
  TaskPlanArtifact,
  TaskPlanPhase,
  TaskPlanResult,
  TaskPlanStep,
  TaskPlanner,
  TaskPlanningContext,
  TaskRefinement,
  TaskType
} from '@assem/shared-types';

function normalizeIntentText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[`"'â€™]/g, '')
    .replace(/[?!,.;:Â¡Â¿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanObjective(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[?!,.;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectLanguage(text: string): SupportedLanguage {
  const normalized = normalizeIntentText(text);
  return /\b(report|brief|research|write|prepare|draft|english|summary)\b/i.test(
    normalized
  )
    ? 'en'
    : 'es';
}

function looksLikeExplicitTaskRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /\b(?:abre|inicia|crea|empieza|arranca|start|open|create|begin)\b/i.test(
    normalized
  ) && /\b(?:tarea|task)\b/i.test(normalized);
}

function extractExplicitTaskObjective(text: string): string | null {
  const quoted = text.match(/["']([^"']+)["']/)?.[1]?.trim();
  if (quoted) {
    return cleanObjective(quoted);
  }

  const match =
    text.match(
      /(?:abre|inicia|crea|empieza|arranca|start|open|create|begin)\s+(?:una\s+)?(?:nueva\s+)?(?:tarea|task)\s+(?:para|to)\s+(.+)$/i
    ) ??
    text.match(
      /(?:abre|inicia|crea|empieza|arranca|start|open|create|begin)\s+(?:una\s+)?(?:nueva\s+)?(?:tarea|task)\s+(.+)$/i
    );

  return match?.[1] ? cleanObjective(match[1]) : null;
}

function extractResearchObjective(text: string): string | null {
  const patterns: Array<{
    regex: RegExp;
    formatter: (topic: string) => string;
  }> = [
    {
      regex:
        /(?:hazme|haz|prepara|crea|redacta)\s+(?:me\s+)?(?:un\s+)?(?:informe|reporte)\s+(?:sobre|de)\s+(.+)$/i,
      formatter: (topic) => `Preparar un informe sobre ${topic}`
    },
    {
      regex:
        /(?:make|create|prepare|write|draft)\s+(?:me\s+)?(?:a\s+)?(?:report|brief)\s+(?:about|on)\s+(.+)$/i,
      formatter: (topic) => `Prepare a report about ${topic}`
    }
  ];

  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    const topic = cleanObjective(match?.[1] ?? '');
    if (topic) {
      return cleanObjective(pattern.formatter(topic));
    }
  }

  return null;
}

function looksLikeResearchObjective(objective: string): boolean {
  return /\b(?:informe|reporte|report|brief|research)\b/i.test(objective);
}

function clonePlan(plan: TaskPlan): TaskPlan {
  return JSON.parse(JSON.stringify(plan)) as TaskPlan;
}

function upsertRestriction(
  restrictions: string[],
  prefix: string,
  value: string
): string[] {
  const next = restrictions.filter((restriction) => !restriction.startsWith(prefix));
  next.push(value);
  return next;
}

function buildResearchPhases(language: SupportedLanguage): TaskPlanPhase[] {
  if (language === 'en') {
    return [
      {
        id: 'phase-prepare',
        label: 'Prepare local workspace',
        description: 'Create the local sandbox workspace for the task.',
        stepIds: ['prepare-workspace']
      },
      {
        id: 'phase-draft',
        label: 'Generate initial draft',
        description: 'Produce an initial report draft from the stated objective.',
        stepIds: ['draft-report']
      },
      {
        id: 'phase-output',
        label: 'Write local deliverables',
        description: 'Persist the main report and executive summary locally.',
        stepIds: ['write-report', 'write-summary']
      }
    ];
  }

  return [
    {
      id: 'phase-prepare',
      label: 'Preparar workspace local',
      description: 'Crear la carpeta de trabajo local dentro del sandbox.',
      stepIds: ['prepare-workspace']
    },
    {
      id: 'phase-draft',
      label: 'Generar borrador inicial',
      description: 'Producir un borrador inicial a partir del objetivo indicado.',
      stepIds: ['draft-report']
    },
    {
      id: 'phase-output',
      label: 'Guardar entregables locales',
      description: 'Persistir el informe principal y el resumen ejecutivo en local.',
      stepIds: ['write-report', 'write-summary']
    }
  ];
}

function buildResearchSteps(language: SupportedLanguage): TaskPlanStep[] {
  if (language === 'en') {
    return [
      {
        id: 'prepare-workspace',
        phaseId: 'phase-prepare',
        label: 'Prepare workspace folder',
        description: 'Create the sandbox folder for the report task.',
        expectedArtifactIds: ['artifact-workspace']
      },
      {
        id: 'draft-report',
        phaseId: 'phase-draft',
        label: 'Generate report draft',
        description: 'Generate the first local-first report draft without claiming web research.'
      },
      {
        id: 'write-report',
        phaseId: 'phase-output',
        label: 'Write main report',
        description: 'Persist the report markdown to the sandbox.',
        expectedArtifactIds: ['artifact-report']
      },
      {
        id: 'write-summary',
        phaseId: 'phase-output',
        label: 'Write executive summary',
        description: 'Persist a short summary text to the sandbox.',
        expectedArtifactIds: ['artifact-summary']
      }
    ];
  }

  return [
    {
      id: 'prepare-workspace',
      phaseId: 'phase-prepare',
      label: 'Preparar carpeta de trabajo',
      description: 'Crear la carpeta de trabajo en el sandbox.',
      expectedArtifactIds: ['artifact-workspace']
    },
    {
      id: 'draft-report',
      phaseId: 'phase-draft',
      label: 'Generar borrador del informe',
      description:
        'Generar un primer borrador local-first sin fingir navegacion web real.'
    },
    {
      id: 'write-report',
      phaseId: 'phase-output',
      label: 'Guardar informe principal',
      description: 'Guardar el informe markdown dentro del sandbox.',
      expectedArtifactIds: ['artifact-report']
    },
    {
      id: 'write-summary',
      phaseId: 'phase-output',
      label: 'Guardar resumen ejecutivo',
      description: 'Guardar un resumen breve en texto dentro del sandbox.',
      expectedArtifactIds: ['artifact-summary']
    }
  ];
}

function buildResearchExpectedArtifacts(
  language: SupportedLanguage
): TaskPlanArtifact[] {
  if (language === 'en') {
    return [
      {
        id: 'artifact-workspace',
        kind: 'directory',
        label: 'Workspace folder',
        description: 'Local sandbox folder for the task.',
        relatedStepId: 'prepare-workspace'
      },
      {
        id: 'artifact-report',
        kind: 'report',
        label: 'Main report',
        description: 'Markdown report written to report.md.',
        relatedStepId: 'write-report'
      },
      {
        id: 'artifact-summary',
        kind: 'document',
        label: 'Executive summary',
        description: 'Text summary written to summary.txt.',
        relatedStepId: 'write-summary'
      }
    ];
  }

  return [
    {
      id: 'artifact-workspace',
      kind: 'directory',
      label: 'Carpeta de trabajo',
      description: 'Carpeta local del sandbox para la tarea.',
      relatedStepId: 'prepare-workspace'
    },
    {
      id: 'artifact-report',
      kind: 'report',
      label: 'Informe principal',
      description: 'Informe markdown guardado en report.md.',
      relatedStepId: 'write-report'
    },
    {
      id: 'artifact-summary',
      kind: 'document',
      label: 'Resumen ejecutivo',
      description: 'Resumen en texto guardado en summary.txt.',
      relatedStepId: 'write-summary'
    }
  ];
}

function buildBaseRestrictions(language: SupportedLanguage): string[] {
  if (language === 'en') {
    return [
      'No real web browsing or external verification in this phase.',
      'The draft is based on the stated objective plus general reasoning only.',
      'Outputs stay inside the local sandbox.'
    ];
  }

  return [
    'Sin navegacion web real ni verificacion externa en esta fase.',
    'El borrador se basa solo en el objetivo indicado y razonamiento general.',
    'Los entregables se guardan dentro del sandbox local.'
  ];
}

function buildPlanSummary(
  objective: string,
  language: SupportedLanguage,
  refinements: TaskRefinement[]
): string {
  const activeAdjustments = refinements.slice(-3).map((refinement) => refinement.label);

  if (language === 'en') {
    const base = `ASSEM will prepare a local workspace, generate an initial report draft for "${objective}", then write report.md and summary.txt locally.`;
    return activeAdjustments.length > 0
      ? `${base} Active adjustments: ${activeAdjustments.join(', ')}.`
      : base;
  }

  const base = `ASSEM preparara un workspace local, generara un borrador inicial para "${objective}" y despues guardara report.md y summary.txt en local.`;
  return activeAdjustments.length > 0
    ? `${base} Ajustes activos: ${activeAdjustments.join(', ')}.`
    : base;
}

function determinePlanLanguage(
  context: TaskPlanningContext,
  objective: string
): SupportedLanguage {
  return detectLanguage(`${context.text} ${objective}`);
}

function deriveResearchObjective(context: TaskPlanningContext): string | null {
  if (context.objective) {
    return cleanObjective(context.objective);
  }

  const explicitTaskObjective = extractExplicitTaskObjective(context.text);
  if (explicitTaskObjective) {
    return explicitTaskObjective;
  }

  return extractResearchObjective(context.text);
}

function reorderResearchSteps(
  plan: TaskPlan,
  task?: AssemTask
): TaskPlanStep[] {
  const latestSummaryPriority = [...plan.refinements]
    .reverse()
    .find((refinement) => refinement.type === 'summary_priority');
  const shouldPrioritizeSummary = latestSummaryPriority?.value === 'first';

  const stepMap = new Map(plan.steps.map((step) => [step.id, step]));
  const defaultOrder = [
    'prepare-workspace',
    'draft-report',
    'write-report',
    'write-summary'
  ];

  if (!shouldPrioritizeSummary) {
    return defaultOrder
      .map((id) => stepMap.get(id))
      .filter((step): step is TaskPlanStep => Boolean(step));
  }

  const reportCompleted = task?.steps.some(
    (step) => step.id === 'write-report' && step.status === 'completed'
  );
  const summaryCompleted = task?.steps.some(
    (step) => step.id === 'write-summary' && step.status === 'completed'
  );

  if (reportCompleted || summaryCompleted) {
    return defaultOrder
      .map((id) => stepMap.get(id))
      .filter((step): step is TaskPlanStep => Boolean(step));
  }

  return ['prepare-workspace', 'draft-report', 'write-summary', 'write-report']
    .map((id) => stepMap.get(id))
    .filter((step): step is TaskPlanStep => Boolean(step));
}

function deriveRestrictions(
  language: SupportedLanguage,
  refinements: TaskRefinement[]
): string[] {
  let restrictions = buildBaseRestrictions(language);

  const latestLength = [...refinements]
    .reverse()
    .find((refinement) => refinement.type === 'length');
  if (latestLength?.value === 'shorter') {
    restrictions = upsertRestriction(
      restrictions,
      language === 'en' ? 'Output length:' : 'Longitud de salida:',
      language === 'en'
        ? 'Output length: keep the report short and practical.'
        : 'Longitud de salida: mantener el informe corto y practico.'
    );
  }

  const latestLanguage = [...refinements]
    .reverse()
    .find((refinement) => refinement.type === 'language');
  if (latestLanguage?.value === 'en' || latestLanguage?.value === 'es') {
    restrictions = upsertRestriction(
      restrictions,
      language === 'en' ? 'Output language:' : 'Idioma de salida:',
      language === 'en'
        ? `Output language: ${latestLanguage.value === 'en' ? 'English' : 'Spanish'}.`
        : `Idioma de salida: ${latestLanguage.value === 'en' ? 'ingles' : 'espanol'}.`
    );
  }

  const latestFormat = [...refinements]
    .reverse()
    .find((refinement) => refinement.type === 'format');
  if (latestFormat?.value === 'table') {
    restrictions = upsertRestriction(
      restrictions,
      language === 'en' ? 'Format:' : 'Formato:',
      language === 'en'
        ? 'Format: include a compact markdown table if it helps.'
        : 'Formato: incluir una tabla breve en markdown si ayuda.'
    );
  }

  const latestFocus = [...refinements]
    .reverse()
    .find((refinement) => refinement.type === 'focus' && refinement.value);
  if (latestFocus?.value) {
    restrictions = upsertRestriction(
      restrictions,
      language === 'en' ? 'Focus:' : 'Enfoque:',
      language === 'en'
        ? `Focus: prioritize ${latestFocus.value}.`
        : `Enfoque: priorizar ${latestFocus.value}.`
    );
  }

  return restrictions;
}

function rebuildPlan(
  plan: TaskPlan,
  language: SupportedLanguage,
  task?: AssemTask
): TaskPlan {
  const nextPlan = clonePlan(plan);
  nextPlan.steps = reorderResearchSteps(nextPlan, task);
  nextPlan.restrictions = deriveRestrictions(language, nextPlan.refinements);
  nextPlan.summary = buildPlanSummary(nextPlan.objective, language, nextPlan.refinements);
  return nextPlan;
}

function buildResearchPlan(
  objective: string,
  language: SupportedLanguage,
  refinements: TaskRefinement[] = [],
  now = new Date()
): TaskPlan {
  const basePlan: TaskPlan = {
    id: crypto.randomUUID(),
    objective,
    taskType: 'research_report_basic',
    summary: '',
    phases: buildResearchPhases(language),
    steps: buildResearchSteps(language),
    expectedArtifacts: buildResearchExpectedArtifacts(language),
    restrictions: [],
    refinements: refinements.map((refinement) => ({ ...refinement })),
    source: 'planner_v1',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };

  return rebuildPlan(basePlan, language);
}

function deriveTaskType(
  context: TaskPlanningContext,
  objective: string
): TaskType | null {
  if (context.requestedTaskType === 'research_report_basic') {
    return 'research_report_basic';
  }

  if (looksLikeResearchObjective(objective)) {
    return 'research_report_basic';
  }

  return null;
}

function buildUnsupportedResult(language: SupportedLanguage): TaskPlanResult {
  return {
    accepted: false,
    reason: 'unsupported_task_type',
    clarificationMessage:
      language === 'en'
        ? 'Planner v1 currently supports only the local research report workflow (`research_report_basic`).'
        : 'Planner v1 solo soporta por ahora el flujo local de informes (`research_report_basic`).'
  };
}

export class DeterministicTaskPlanner implements TaskPlanner {
  createPlan(context: TaskPlanningContext): TaskPlanResult {
    const explicitTaskRequest = looksLikeExplicitTaskRequest(context.text);
    const explicitObjective = deriveResearchObjective(context);
    const language = determinePlanLanguage(context, explicitObjective ?? context.text);

    if (!explicitObjective && explicitTaskRequest) {
      return {
        accepted: false,
        reason: 'clarification_needed',
        clarificationMessage:
          language === 'en'
            ? 'Tell me the concrete objective of the task so I can build a real plan.'
            : 'Necesito el objetivo concreto de la tarea para poder construir un plan real.'
      };
    }

    if (!explicitObjective) {
      return {
        accepted: false,
        reason: 'not_planning_request'
      };
    }

    const taskType = deriveTaskType(context, explicitObjective);
    if (!taskType) {
      return buildUnsupportedResult(language);
    }

    if (taskType !== 'research_report_basic') {
      return buildUnsupportedResult(language);
    }

    const now = context.now ?? new Date();
    const refinements = context.initialRefinements ?? [];

    return {
      accepted: true,
      plan: buildResearchPlan(explicitObjective, language, refinements, now)
    };
  }

  refinePlan(task: AssemTask, refinement: TaskRefinement): TaskPlanResult {
    const taskType =
      task.plan?.taskType ??
      (typeof task.metadata?.taskType === 'string'
        ? (task.metadata.taskType as string)
        : undefined);
    const fallbackLanguage = detectLanguage(task.objective);

    if (taskType !== 'research_report_basic') {
      return buildUnsupportedResult(fallbackLanguage);
    }

    if (
      !['length', 'language', 'summary_priority', 'format', 'focus'].includes(
        refinement.type
      )
    ) {
      return {
        accepted: false,
        reason: 'clarification_needed',
        clarificationMessage:
          fallbackLanguage === 'en'
            ? 'I need a more concrete planning refinement before I can adjust the remaining steps safely.'
            : 'Necesito un refinamiento mas concreto para poder ajustar los pasos pendientes con seguridad.'
      };
    }

    const basePlan =
      task.plan ??
      buildResearchPlan(task.objective, fallbackLanguage, [], new Date(task.createdAt));
    const nextPlan = clonePlan(basePlan);
    nextPlan.refinements = [...nextPlan.refinements, { ...refinement }];
    nextPlan.updatedAt = new Date().toISOString();

    return {
      accepted: true,
      plan: rebuildPlan(nextPlan, fallbackLanguage, task)
    };
  }
}
