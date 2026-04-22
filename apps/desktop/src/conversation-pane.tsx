import type { SessionSnapshot } from '@assem/shared-types';

import { createQuickActionItems, QuickActionsPanel } from './assistant-panels';
import { Surface } from './surface';

type ConversationMessage = SessionSnapshot['messages'][number];

interface ConversationPaneProps {
  messages: ConversationMessage[];
  prompts: string[];
  disabled: boolean;
  hasActiveTask: boolean;
  latestTranscript?: string;
  voiceActivityLabel: string;
  formatTimestamp: (value?: string) => string;
  onSelectPrompt: (prompt: string) => void;
}

export function ConversationPane({
  messages,
  prompts,
  disabled,
  hasActiveTask,
  latestTranscript,
  voiceActivityLabel,
  formatTimestamp,
  onSelectPrompt
}: ConversationPaneProps) {
  const hasMessages = messages.length > 0;
  const quickActions = createQuickActionItems(prompts, hasActiveTask);

  return (
    <Surface as="section" className="conversation-pane" glow="neutral" radius="lg" variant="soft">
      <div className="conversation-pane__header">
        <div>
          <p className="eyebrow">Consola conversacional</p>
          <h2>Transcript / chat</h2>
        </div>
        <p className="panel-copy">
          {latestTranscript
            ? `Voz reconocida: ${latestTranscript}`
            : `Estado de voz: ${voiceActivityLabel}`}
        </p>
      </div>

      <div className="conversation-pane__transcript">
        <span>SYS</span>
        <p>{latestTranscript ?? 'ASSEM listo. Esperando texto, voz o tarea local.'}</p>
      </div>

      <div className={`chat__messages${hasMessages ? ' chat__messages--populated' : ''}`}>
        {hasMessages ? (
          messages.map((message) => (
            <article className={`message message--${message.role}`} key={message.id}>
              <div className="message__meta">
                <strong>{message.role === 'user' ? 'YOU' : 'ASSEM'}</strong>
                <span>{formatTimestamp(message.createdAt)}</span>
              </div>
              <p>{message.content}</p>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <QuickActionsPanel
              actions={quickActions}
              disabled={disabled}
              hasActiveTask={hasActiveTask}
              onSelectPrompt={onSelectPrompt}
            />
          </div>
        )}
      </div>
    </Surface>
  );
}
