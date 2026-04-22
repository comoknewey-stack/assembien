import { describe, expect, it } from 'vitest';

import type { ProviderRuntimeStatus } from '@assem/shared-types';

import { resolveRuntimeModelDisplay } from './runtime-display';

function createProviderRuntime(
  overrides: Partial<ProviderRuntimeStatus> = {}
): ProviderRuntimeStatus {
  return {
    configuredDefaultProviderId: 'ollama',
    configuredModel: 'llama3.2:latest',
    resolvedModel: 'llama3.2:latest',
    activeProviderId: undefined,
    activeModel: undefined,
    fallbackUsed: false,
    fallbackReason: undefined,
    ollamaAvailable: true,
    ollamaError: undefined,
    ...overrides
  };
}

describe('resolveRuntimeModelDisplay', () => {
  it('prefers the active model when the session already used a provider', () => {
    expect(
      resolveRuntimeModelDisplay(
        createProviderRuntime({
          activeProviderId: 'ollama',
          activeModel: 'llama3.2:q4_k_m'
        })
      )
    ).toEqual({
      label: 'Modelo activo',
      value: 'llama3.2:q4_k_m'
    });
  });

  it('falls back to the resolved configured model before the first active turn', () => {
    expect(resolveRuntimeModelDisplay(createProviderRuntime())).toEqual({
      label: 'Modelo resuelto',
      value: 'llama3.2:latest'
    });
  });

  it('falls back to the configured model when there is no resolved model yet', () => {
    expect(
      resolveRuntimeModelDisplay(
        createProviderRuntime({
          resolvedModel: undefined
        })
      )
    ).toEqual({
      label: 'Modelo configurado',
      value: 'llama3.2:latest'
    });
  });

  it('returns a safe empty-state label when no model information exists', () => {
    expect(
      resolveRuntimeModelDisplay({
        configuredDefaultProviderId: 'ollama',
        configuredModel: undefined,
        resolvedModel: undefined,
        activeProviderId: undefined,
        activeModel: undefined,
        fallbackUsed: false,
        fallbackReason: undefined,
        ollamaAvailable: false,
        ollamaError: 'Ollama no disponible'
      })
    ).toEqual({
      label: 'Modelo',
      value: 'sin datos'
    });
  });
});
