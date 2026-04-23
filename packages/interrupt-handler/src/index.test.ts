import { describe, expect, it } from 'vitest';

import type { AssemTask, SessionState } from '@assem/shared-types';

import { DeterministicTaskInterruptHandler } from './index';

function createSession(): SessionState {
  return {
    sessionId: 'session-interrupt',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    actionLog: [],
    pendingAction: null,
    temporaryOverrides: [],
    calendarEvents: [],
    activeMode: {
      privacy: 'local_only',
      runtime: 'sandbox'
    },
    settings: {
      preferredProviderId: 'demo-local',
      autoApproveLowRisk: false
    }
  };
}

function createTask(): AssemTask {
  return {
    id: 'task-active',
    sessionId: 'session-interrupt',
    objective: 'Preparar informe',
    status: 'active',
    progressPercent: 25,
    currentPhase: 'Generando borrador',
    currentStepId: 'draft-report',
    steps: [
      {
        id: 'prepare-workspace',
        label: 'Preparar carpeta',
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      },
      {
        id: 'draft-report',
        label: 'Generar borrador',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString()
      }
    ],
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    metadata: {
      taskType: 'research_report_basic'
    }
  };
}

describe('DeterministicTaskInterruptHandler', () => {
  const handler = new DeterministicTaskInterruptHandler();

  it('classifies status queries deterministically', () => {
    const result = handler.classify({
      text: '¿qué estás haciendo?',
      session: createSession(),
      activeTask: createTask()
    });

    expect(result.kind).toBe('task_status_query');
    expect(result.statusQueryKind).toBe('status');
  });

  it('classifies plan queries deterministically', () => {
    const result = handler.classify({
      text: '¿cuál es el plan?',
      session: createSession(),
      activeTask: createTask()
    });

    expect(result.kind).toBe('task_status_query');
    expect(result.statusQueryKind).toBe('plan');
  });

  it('classifies pause and resume commands', () => {
    const pause = handler.classify({
      text: 'pausa',
      session: createSession(),
      activeTask: createTask()
    });
    const resume = handler.classify({
      text: 'continúa',
      session: createSession(),
      activeTask: createTask()
    });

    expect(pause.kind).toBe('task_pause');
    expect(resume.kind).toBe('task_resume');
  });

  it('classifies output refinements like "hazlo más corto"', () => {
    const result = handler.classify({
      text: 'hazlo más corto',
      session: createSession(),
      activeTask: createTask()
    });

    expect(result.kind).toBe('task_output_refinement');
    expect(result.refinement).toMatchObject({
      type: 'length',
      value: 'shorter'
    });
  });

  it('classifies output refinements like "hazlo en inglés"', () => {
    const result = handler.classify({
      text: 'hazlo en inglés',
      session: createSession(),
      activeTask: createTask()
    });

    expect(result.kind).toBe('task_output_refinement');
    expect(result.refinement).toMatchObject({
      type: 'language',
      value: 'en'
    });
  });

  it('classifies source status queries for research tasks', () => {
    const result = handler.classify({
      text: 'que fuentes has encontrado',
      session: createSession(),
      activeTask: createTask()
    });

    expect(result.kind).toBe('task_status_query');
    expect(result.statusQueryKind).toBe('sources');
  });

  it('classifies read/snippet/discarded/evidence source queries deterministically', () => {
    const read = handler.classify({
      text: 'que fuentes has leido de verdad',
      session: createSession(),
      activeTask: createTask()
    });
    const snippet = handler.classify({
      text: 'que fuentes usaste solo como snippet',
      session: createSession(),
      activeTask: createTask()
    });
    const discarded = handler.classify({
      text: 'que fuentes descartaste',
      session: createSession(),
      activeTask: createTask()
    });
    const evidence = handler.classify({
      text: 'que evidencia tienes',
      session: createSession(),
      activeTask: createTask()
    });

    expect(read.statusQueryKind).toBe('read_sources');
    expect(snippet.statusQueryKind).toBe('snippet_sources');
    expect(discarded.statusQueryKind).toBe('discarded_sources');
    expect(evidence.statusQueryKind).toBe('evidence');
  });

  it('classifies evidence-strength and limitations queries deterministically', () => {
    const strong = handler.classify({
      text: 'que fuentes tienen evidencia fuerte',
      session: createSession(),
      activeTask: createTask()
    });
    const weak = handler.classify({
      text: 'que fuentes son debiles o tangenciales',
      session: createSession(),
      activeTask: createTask()
    });
    const best = handler.classify({
      text: 'cual es la mejor fuente que encontraste',
      session: createSession(),
      activeTask: createTask()
    });
    const limitations = handler.classify({
      text: 'que limitaciones tiene este informe',
      session: createSession(),
      activeTask: createTask()
    });

    expect(strong.statusQueryKind).toBe('strong_sources');
    expect(weak.statusQueryKind).toBe('weak_sources');
    expect(best.statusQueryKind).toBe('best_source');
    expect(limitations.statusQueryKind).toBe('report_limitations');
  });

  it('classifies snippet dependency and evidence sufficiency queries deterministically', () => {
    const snippetDependency = handler.classify({
      text: 'que parte sale solo de snippets',
      session: createSession(),
      activeTask: createTask()
    });
    const sufficiency = handler.classify({
      text: 'hay base suficiente o no',
      session: createSession(),
      activeTask: createTask()
    });

    expect(snippetDependency.statusQueryKind).toBe('snippet_dependency');
    expect(sufficiency.statusQueryKind).toBe('evidence_sufficiency');
  });

  it('classifies source refinements for research tasks', () => {
    const official = handler.classify({
      text: 'usa fuentes oficiales',
      session: createSession(),
      activeTask: createTask()
    });
    const noBlogs = handler.classify({
      text: 'no uses blogs',
      session: createSession(),
      activeTask: createTask()
    });
    const recent = handler.classify({
      text: 'prioriza fuentes recientes',
      session: createSession(),
      activeTask: createTask()
    });

    expect(official.refinement).toMatchObject({
      type: 'source_preference',
      value: 'official'
    });
    expect(noBlogs.refinement).toMatchObject({
      type: 'source_exclusion',
      value: 'blogs'
    });
    expect(recent.refinement).toMatchObject({
      type: 'recency',
      value: 'recent'
    });
  });

  it('asks for clarification when the goal correction is too vague', () => {
    const result = handler.classify({
      text: 'eso no era lo que quería',
      session: createSession(),
      activeTask: createTask()
    });

    expect(result.kind).toBe('task_clarification_needed');
    expect(result.clarificationMessage).toContain('que cambio quieres');
  });

  it('classifies unrelated questions as independent queries', () => {
    const result = handler.classify({
      text: 'que hora es',
      session: createSession(),
      activeTask: createTask()
    });

    expect(result.kind).toBe('independent_query');
  });
});
