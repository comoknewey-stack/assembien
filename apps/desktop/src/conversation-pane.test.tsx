import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@assem/shared-types';

import { ConversationPane } from './conversation-pane';

const messages: ChatMessage[] = [
  {
    id: 'message-1',
    role: 'user',
    content: 'Hola',
    createdAt: '2026-04-21T10:00:00.000Z'
  },
  {
    id: 'message-2',
    role: 'assistant',
    content: 'Hola, soy ASSEM.',
    createdAt: '2026-04-21T10:00:05.000Z'
  }
];

describe('ConversationPane', () => {
  it('renders user and assistant messages with a clear conversation frame', () => {
    const html = renderToStaticMarkup(
      <ConversationPane
        disabled={false}
        formatTimestamp={() => '21/4/26, 12:00'}
        hasActiveTask={false}
        latestTranscript="Hola"
        messages={messages}
        onSelectPrompt={() => undefined}
        prompts={['Lista el sandbox']}
        voiceActivityLabel="En espera"
      />
    );

    expect(html).toContain('Transcript / chat');
    expect(html).toContain('Voz reconocida: Hola');
    expect(html).toContain('Hola, soy ASSEM.');
    expect(html).toContain('message--assistant');
    expect(html).not.toContain('Empieza con algo breve');
  });

  it('uses compact quick actions only when the conversation is empty', () => {
    const html = renderToStaticMarkup(
      <ConversationPane
        disabled={false}
        formatTimestamp={() => '21/4/26, 12:00'}
        hasActiveTask={true}
        messages={[]}
        onSelectPrompt={() => undefined}
        prompts={['Que hora es ahora mismo?']}
        voiceActivityLabel="En espera"
      />
    );

    expect(html).toContain('Sigue hablando mientras ASSEM trabaja');
    expect(html).toContain('Hora local');
  });
});
