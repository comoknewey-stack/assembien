import os from 'node:os';
import path from 'node:path';

import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { BasicScheduler } from './index';

describe('BasicScheduler', () => {
  it('creates, toggles, runs and deletes scheduled tasks', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assem-scheduler-'));
    const scheduler = new BasicScheduler(
      path.join(dataRoot, 'scheduler.json'),
      async (task) => ({
        summary: `ran ${task.label}`
      })
    );

    const created = await scheduler.createTask({
      label: 'Daily review',
      prompt: 'Review the current state',
      kind: 'internal_review',
      cadence: 'manual'
    });

    const toggled = await scheduler.setTaskEnabled(created.id, false);
    const run = await scheduler.runTask(created.id);
    const listedBeforeDelete = await scheduler.listTasks();
    await scheduler.deleteTask(created.id);
    const listedAfterDelete = await scheduler.listTasks();

    expect(toggled.enabled).toBe(false);
    expect(run.status).toBe('success');
    expect(listedBeforeDelete).toHaveLength(1);
    expect(listedAfterDelete).toHaveLength(0);
  });
});
