import { describe, expect, it } from 'vitest';

import type { AssemTask, SessionState, TaskRefinement } from '@assem/shared-types';

import { DeterministicTaskPlanner } from './index';

function createSession(): SessionState {
  return {
    sessionId: 'session-plan',
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

function createTaskWithPlan(): AssemTask {
  const planner = new DeterministicTaskPlanner();
  const result = planner.createPlan({
    session: createSession(),
    text: 'hazme un informe sobre costes operativos'
  });
  const plan = result.plan!;

  return {
    id: 'task-plan',
    sessionId: 'session-plan',
    objective: plan.objective,
    status: 'active',
    progressPercent: 25,
    currentPhase: 'Generar borrador inicial',
    currentStepId: 'draft-report',
    steps: plan.steps.map((step, index) => ({
      id: step.id,
      label: step.label,
      status:
        index === 0 ? 'completed' : index === 1 ? 'active' : 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: index === 0 ? new Date().toISOString() : undefined
    })),
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    plan,
    metadata: {
      taskType: 'research_report_basic'
    }
  };
}

describe('DeterministicTaskPlanner', () => {
  const planner = new DeterministicTaskPlanner();

  it('creates a valid research_report_basic plan from an open report request', () => {
    const result = planner.createPlan({
      session: createSession(),
      text: 'hazme un informe sobre riesgos operativos'
    });

    expect(result.accepted).toBe(true);
    expect(result.plan).toMatchObject({
      taskType: 'research_report_basic',
      objective: 'Preparar un informe sobre riesgos operativos'
    });
    expect(result.plan?.steps.map((step) => step.id)).toEqual([
      'prepare-workspace',
      'draft-report',
      'write-report',
      'write-summary'
    ]);
    expect(result.plan?.expectedArtifacts.map((artifact) => artifact.label)).toEqual([
      'Carpeta de trabajo',
      'Informe principal',
      'Resumen ejecutivo'
    ]);
  });

  it('creates a valid research_report_basic plan from an explicit task objective', () => {
    const result = planner.createPlan({
      session: createSession(),
      text: 'abre una tarea para preparar el informe semanal',
      objective: 'preparar el informe semanal'
    });

    expect(result.accepted).toBe(true);
    expect(result.plan?.taskType).toBe('research_report_basic');
    expect(result.plan?.objective).toBe('preparar el informe semanal');
  });

  it('rejects unsupported task objectives honestly', () => {
    const result = planner.createPlan({
      session: createSession(),
      text: 'abre una tarea para organizar archivos del proyecto',
      objective: 'organizar archivos del proyecto'
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unsupported_task_type');
    expect(result.clarificationMessage).toContain('research_report_basic');
  });

  it('refines the plan by reordering pending steps when summary priority is requested', () => {
    const task = createTaskWithPlan();
    const refinement: TaskRefinement = {
      id: 'ref-summary',
      createdAt: new Date().toISOString(),
      category: 'output',
      type: 'summary_priority',
      instruction: 'primero dame un resumen',
      label: 'Priorizar resumen',
      value: 'first'
    };

    const result = planner.refinePlan(task, refinement);

    expect(result.accepted).toBe(true);
    expect(result.plan?.steps.map((step) => step.id)).toEqual([
      'prepare-workspace',
      'draft-report',
      'write-summary',
      'write-report'
    ]);
  });

  it('asks for clarification when the refinement is too generic to apply safely', () => {
    const task = createTaskWithPlan();
    const refinement: TaskRefinement = {
      id: 'ref-generic',
      createdAt: new Date().toISOString(),
      category: 'output',
      type: 'general',
      instruction: 'ajustalo mejor',
      label: 'Ajuste general'
    };

    const result = planner.refinePlan(task, refinement);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('clarification_needed');
    expect(result.clarificationMessage).toContain('Necesito');
  });
});
