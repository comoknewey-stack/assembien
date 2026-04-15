import { describe, expect, it } from 'vitest';

import { InMemorySessionStore } from '@assem/memory';

import { PolicyEngine } from './index';

describe('PolicyEngine', () => {
  it('creates a daily override from a natural language instruction', () => {
    const engine = new PolicyEngine();
    const override = engine.parseTemporaryOverride('Hoy no me preguntes mas');

    expect(override).not.toBeNull();
    expect(override?.scope).toBe('day');
    expect(override?.confirmationsDisabledFor).toContain('*');
  });

  it('skips confirmation when a matching override is active', async () => {
    const store = new InMemorySessionStore('demo-local');
    const session = await store.createSession();
    const engine = new PolicyEngine();
    const override = engine.parseTemporaryOverride('Hoy no me preguntes mas');

    if (!override) {
      throw new Error('expected override to be created');
    }

    session.temporaryOverrides.push(override);

    const decision = engine.evaluate(session, {
      id: 'local-files.create-entry',
      label: 'Create local file',
      description: 'Creates a file inside the sandbox root.',
      riskLevel: 'medium',
      requiresConfirmation: true,
      requiresPermissions: ['write_safe'],
      execute: async () => ({
        summary: 'ok',
        output: null
      })
    });

    expect(decision.requiresConfirmation).toBe(false);
  });

  it('cancels an override manually', async () => {
    const store = new InMemorySessionStore('demo-local');
    const session = await store.createSession();
    const engine = new PolicyEngine();
    const override = engine.parseTemporaryOverride('Hoy no me preguntes mas');

    if (!override) {
      throw new Error('expected override to be created');
    }

    session.temporaryOverrides.push(override);
    const removed = engine.cancelOverride(session, override.id);

    expect(removed?.id).toBe(override.id);
    expect(session.temporaryOverrides).toHaveLength(0);
  });
});
