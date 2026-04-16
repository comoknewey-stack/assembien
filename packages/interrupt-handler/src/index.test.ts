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
