import type { ActionLogEntry, SessionState } from '@assem/shared-types';

interface LogInput {
  kind: ActionLogEntry['kind'];
  title: string;
  detail: string;
  status: ActionLogEntry['status'];
}

export class ActionLogService {
  record(session: SessionState, input: LogInput): ActionLogEntry {
    const entry: ActionLogEntry = {
      id: crypto.randomUUID(),
      sessionId: session.sessionId,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      status: input.status,
      createdAt: new Date().toISOString()
    };

    session.actionLog.push(entry);
    return entry;
  }
}
