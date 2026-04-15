import type {
  PolicyDecision,
  PolicyEngine as PolicyEngineContract,
  SessionState,
  TemporaryPolicyOverride,
  ToolDefinition
} from '@assem/shared-types';

function endOfDay(now: Date): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  );
}

function addHours(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

function includesMatch(
  override: TemporaryPolicyOverride,
  tool: ToolDefinition
): boolean {
  return (
    override.confirmationsDisabledFor.includes('*') ||
    override.confirmationsDisabledFor.includes(tool.id)
  );
}

function grantsPermissions(
  override: TemporaryPolicyOverride,
  tool: ToolDefinition
): boolean {
  return tool.requiresPermissions.every((permission) =>
    override.permissionsGranted.includes(permission)
  );
}

export class PolicyEngine implements PolicyEngineContract {
  pruneExpired(session: SessionState, now = new Date()): void {
    session.temporaryOverrides = session.temporaryOverrides.filter(
      (override) => new Date(override.expiresAt) > now
    );
  }

  evaluate(
    session: SessionState,
    tool: ToolDefinition,
    now = new Date()
  ): PolicyDecision {
    this.pruneExpired(session, now);

    const activeOverride = session.temporaryOverrides.find(
      (override) => includesMatch(override, tool) && grantsPermissions(override, tool)
    );

    if (!tool.requiresConfirmation) {
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: 'This tool is configured to run without confirmation.'
      };
    }

    if (session.settings.autoApproveLowRisk && tool.riskLevel === 'low') {
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: 'Low-risk actions are auto-approved in the current settings.'
      };
    }

    if (activeOverride) {
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: `The active override "${activeOverride.label}" disables confirmation for this action.`,
        activeOverrideId: activeOverride.id
      };
    }

    return {
      allowed: true,
      requiresConfirmation: true,
      reason: 'This action requires confirmation in the current policy.'
    };
  }

  parseTemporaryOverride(
    instruction: string,
    now = new Date()
  ): TemporaryPolicyOverride | null {
    const normalized = instruction.toLowerCase();

    if (
      /(hoy no me preguntes mas|no me preguntes mas hoy|don't ask me again today|no more confirmations today)/i.test(
        normalized
      )
    ) {
      return {
        id: crypto.randomUUID(),
        label: 'Day-wide confirmation override',
        scope: 'day',
        permissionsGranted: ['write_safe', 'write_sensitive'],
        confirmationsDisabledFor: ['*'],
        expiresAt: endOfDay(now).toISOString(),
        createdAt: now.toISOString(),
        createdFromUserInstruction: instruction
      };
    }

    if (
      /(durante esta tarea actua sin confirmacion|haz lo que necesites|for this task act without confirmation|do what you need to finish this task)/i.test(
        normalized
      )
    ) {
      return {
        id: crypto.randomUUID(),
        label: 'Task-scoped confirmation override',
        scope: 'task',
        permissionsGranted: ['write_safe'],
        confirmationsDisabledFor: ['*'],
        expiresAt: addHours(now, 2).toISOString(),
        createdAt: now.toISOString(),
        createdFromUserInstruction: instruction
      };
    }

    return null;
  }

  cancelOverride(
    session: SessionState,
    overrideId: string
  ): TemporaryPolicyOverride | null {
    const index = session.temporaryOverrides.findIndex(
      (override) => override.id === overrideId
    );

    if (index === -1) {
      return null;
    }

    const [removed] = session.temporaryOverrides.splice(index, 1);
    return removed;
  }
}
