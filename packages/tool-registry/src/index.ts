import type {
  AnyToolDefinition,
  ToolDefinition,
  ToolRegistry as ToolRegistryContract,
  ToolSummary
} from '@assem/shared-types';

export class ToolRegistry implements ToolRegistryContract {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register<Input, Output>(tool: ToolDefinition<Input, Output>): void {
    this.tools.set(tool.id, tool);
  }

  get(toolId: string): AnyToolDefinition {
    const tool = this.tools.get(toolId);

    if (!tool) {
      throw new Error(`Unknown tool: ${toolId}`);
    }

    return tool;
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  summaries(): ToolSummary[] {
    return this.list().map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
      riskLevel: tool.riskLevel,
      requiresConfirmation: tool.requiresConfirmation,
      requiresPermissions: tool.requiresPermissions
    }));
  }
}
