import { describe, expect, it } from 'vitest';

import { DemoLocalModelProvider } from './index';

const provider = new DemoLocalModelProvider();

describe('DemoLocalModelProvider', () => {
  it('returns fallback text in Spanish for Spanish prompts', async () => {
    const response = await provider.run({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'necesito una respuesta general',
          createdAt: new Date('2026-04-16T10:00:00.000Z').toISOString()
        }
      ],
      availableTools: [],
      privacyMode: 'local_only',
      runtimeMode: 'sandbox'
    });

    expect(response.text).toContain('Puedo ayudarte dentro del entorno local actual');
    expect(response.text).not.toContain('local scaffold mode');
  });

  it('grounds help text in current request data instead of scaffold claims', async () => {
    const response = await provider.run({
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'que puedes hacer',
          createdAt: new Date('2026-04-16T10:00:00.000Z').toISOString()
        }
      ],
      availableTools: [
        {
          id: 'clock-time.get-current',
          label: 'Current time',
          description: 'Return the current time and date.',
          riskLevel: 'low',
          requiresConfirmation: false,
          requiresPermissions: []
        }
      ],
      privacyMode: 'local_only',
      runtimeMode: 'sandbox'
    });

    expect(response.text).toContain('Current time');
    expect(response.text).toContain('historial');
    expect(response.text).not.toContain('local scaffold mode');
  });
});
