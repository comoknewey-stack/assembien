import type { ProviderRuntimeStatus } from '@assem/shared-types';

export interface RuntimeModelDisplay {
  label: 'Modelo activo' | 'Modelo resuelto' | 'Modelo configurado' | 'Modelo';
  value: string;
}

export function resolveRuntimeModelDisplay(
  providerRuntime: ProviderRuntimeStatus | null | undefined
): RuntimeModelDisplay {
  if (providerRuntime?.activeModel) {
    return {
      label: 'Modelo activo',
      value: providerRuntime.activeModel
    };
  }

  if (providerRuntime?.resolvedModel) {
    return {
      label: 'Modelo resuelto',
      value: providerRuntime.resolvedModel
    };
  }

  if (providerRuntime?.configuredModel) {
    return {
      label: 'Modelo configurado',
      value: providerRuntime.configuredModel
    };
  }

  return {
    label: 'Modelo',
    value: 'sin datos'
  };
}
