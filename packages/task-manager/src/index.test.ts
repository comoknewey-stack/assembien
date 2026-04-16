import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileTaskManager, InMemoryTaskManager } from './index';

describe('TaskManager', () => {
  it('creates a task and exposes it as the active task for the session', async () => {
    const manager = new InMemoryTaskManager();

    const task = await manager.createTask({
      sessionId: 'session-a',
      objective: 'Preparar un informe local',
      currentPhase: 'Recopilando contexto'
    });

    expect(task.status).toBe('active');
    expect(task.progressPercent).toBeNull();
    expect(task.currentPhase).toBe('Recopilando contexto');
    await expect(manager.getActiveTaskForSession('session-a')).resolves.toMatchObject({
      id: task.id,
      objective: 'Preparar un informe local'
    });
  });

  it('persists tasks on disk', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-task-manager-'));
    const filePath = path.join(dataRoot, 'tasks.json');
    const writer = new FileTaskManager(filePath);

    const created = await writer.createTask({
      sessionId: 'session-persisted',
      objective: 'Documento persistente'
    });

    const reader = new FileTaskManager(filePath);
    const restored = await reader.getTask(created.id);

    expect(restored).toMatchObject({
      id: created.id,
      sessionId: 'session-persisted',
      objective: 'Documento persistente'
    });
  });

  it('keeps one current task pointer per session and pauses the previous active task when a new one is created', async () => {
    const manager = new InMemoryTaskManager();
    const first = await manager.createTask({
      sessionId: 'session-switch',
      objective: 'Primera tarea'
    });
    const second = await manager.createTask({
      sessionId: 'session-switch',
      objective: 'Segunda tarea'
    });

    const reloadedFirst = await manager.getTask(first.id);
    const active = await manager.getActiveTaskForSession('session-switch');

    expect(reloadedFirst?.status).toBe('paused');
    expect(active?.id).toBe(second.id);
  });

  it('updates task progress and phase with real persisted state', async () => {
    const manager = new InMemoryTaskManager();
    const task = await manager.createTask({
      sessionId: 'session-progress',
      objective: 'Tarea con progreso',
      steps: [
        { id: 'step-1', label: 'Primer paso' },
        { id: 'step-2', label: 'Segundo paso' }
      ]
    });

    const updated = await manager.advanceTaskPhase(task.id, {
      currentPhase: 'Ejecutando',
      currentStepId: 'step-2',
      progressPercent: 55
    });

    expect(updated.progressPercent).toBe(55);
    expect(updated.currentPhase).toBe('Ejecutando');
    expect(updated.currentStepId).toBe('step-2');
    expect(updated.steps.find((step) => step.id === 'step-2')?.status).toBe('active');
  });

  it('completes the current step without inventing a new one', async () => {
    const manager = new InMemoryTaskManager();
    const task = await manager.createTask({
      sessionId: 'session-step-complete',
      objective: 'Cerrar paso actual',
      progressPercent: 0,
      currentPhase: 'Primer paso',
      steps: [
        { id: 'step-1', label: 'Primer paso' },
        { id: 'step-2', label: 'Segundo paso' }
      ],
      currentStepId: 'step-1'
    });

    const updated = await manager.completeCurrentStep(task.id, {
      progressPercent: 50,
      currentPhase: 'Primer paso completado'
    });

    expect(updated.currentStepId).toBeUndefined();
    expect(updated.progressPercent).toBe(50);
    expect(updated.currentPhase).toBe('Primer paso completado');
    expect(updated.steps.find((step) => step.id === 'step-1')?.status).toBe(
      'completed'
    );
    expect(updated.steps.find((step) => step.id === 'step-2')?.status).toBe(
      'pending'
    );
  });

  it('pauses, resumes and cancels the active task', async () => {
    const manager = new InMemoryTaskManager();
    const task = await manager.createTask({
      sessionId: 'session-control',
      objective: 'Control manual'
    });

    const paused = await manager.pauseTask(task.id, 'Pausa solicitada');
    const resumed = await manager.resumeTask(task.id);
    const cancelled = await manager.cancelTask(task.id, 'Cancelada por el usuario');

    expect(paused.status).toBe('paused');
    expect(resumed.status).toBe('active');
    expect(cancelled.status).toBe('cancelled');
    await expect(manager.getActiveTaskForSession('session-control')).resolves.toBeNull();
  });

  it('completes and fails tasks with terminal state', async () => {
    const manager = new InMemoryTaskManager();
    const completedTask = await manager.createTask({
      sessionId: 'session-done',
      objective: 'Cerrar tarea'
    });
    const failedTask = await manager.createTask({
      sessionId: 'session-failed',
      objective: 'Romper tarea'
    });

    const completed = await manager.completeTask(completedTask.id);
    const failed = await manager.failTask(failedTask.id, 'Bloqueo real');

    expect(completed.status).toBe('completed');
    expect(completed.progressPercent).toBe(100);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('Bloqueo real');
  });

  it('attaches structured artifacts to a task', async () => {
    const manager = new InMemoryTaskManager();
    const task = await manager.createTask({
      sessionId: 'session-artifact',
      objective: 'Generar un artefacto'
    });

    const updated = await manager.attachArtifact(task.id, {
      kind: 'report',
      label: 'Informe final',
      filePath: 'sandbox/informe.md'
    });

    expect(updated.artifacts).toHaveLength(1);
    expect(updated.artifacts[0]).toMatchObject({
      kind: 'report',
      label: 'Informe final',
      filePath: 'sandbox/informe.md'
    });
  });
});
