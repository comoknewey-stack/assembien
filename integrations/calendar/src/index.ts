import type {
  CalendarCreateInput,
  CalendarCreateOutput,
  CalendarEvent,
  CalendarListOutput,
  CalendarProvider,
  SessionState,
  ToolDefinition
} from '@assem/shared-types';

function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt)
  );
}

function validateEventInput(input: CalendarCreateInput): void {
  if (!input.title.trim()) {
    throw new Error('Calendar events require a title.');
  }

  if (
    Number.isNaN(Date.parse(input.startsAt)) ||
    Number.isNaN(Date.parse(input.endsAt))
  ) {
    throw new Error('Calendar events require valid start and end dates.');
  }

  if (new Date(input.startsAt) >= new Date(input.endsAt)) {
    throw new Error('Calendar events must end after they start.');
  }
}

export class MockCalendarProvider implements CalendarProvider {
  readonly id = 'calendar-mock';
  readonly label = 'Mock calendar provider';

  async listEvents(session: SessionState): Promise<CalendarEvent[]> {
    return sortEvents(session.calendarEvents);
  }

  async createEvent(
    input: CalendarCreateInput,
    context: Parameters<CalendarProvider['createEvent']>[1]
  ): Promise<CalendarCreateOutput> {
    validateEventInput(input);

    const event: CalendarEvent = {
      id: crypto.randomUUID(),
      title: input.title.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      notes: input.notes?.trim() || undefined,
      source: 'mock'
    };

    if (context.activeMode.runtime !== 'sandbox') {
      context.session.calendarEvents.push(event);
    }

    return {
      event,
      simulated: context.activeMode.runtime === 'sandbox'
    };
  }
}

export function createCalendarTools(
  provider: CalendarProvider = new MockCalendarProvider()
): [
  ToolDefinition<undefined, CalendarListOutput>,
  ToolDefinition<CalendarCreateInput, CalendarCreateOutput>
] {
  const listEvents: ToolDefinition<undefined, CalendarListOutput> = {
    id: 'calendar.list-events',
    label: 'List calendar events',
    description:
      'Lists the current calendar events through the active calendar provider.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(_input, context) {
      const events = await provider.listEvents(context.session);

      if (events.length === 0) {
        return {
          summary: 'There are no events in the calendar right now.',
          output: {
            events: []
          }
        };
      }

      const eventSummary = events
        .slice(0, 4)
        .map((event) => {
          const start = new Intl.DateTimeFormat('en-GB', {
            dateStyle: 'medium',
            timeStyle: 'short'
          }).format(new Date(event.startsAt));

          return `${event.title} on ${start}`;
        })
        .join('; ');

      return {
        summary: `Upcoming events: ${eventSummary}.`,
        output: {
          events
        }
      };
    }
  };

  const createEvent: ToolDefinition<CalendarCreateInput, CalendarCreateOutput> = {
    id: 'calendar.create-event',
    label: 'Create calendar event',
    description:
      'Creates a calendar event through the active calendar provider.',
    riskLevel: 'medium',
    requiresConfirmation: true,
    requiresPermissions: ['write_sensitive'],
    async execute(input, context) {
      const output = await provider.createEvent(input, context);
      const startLabel = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(output.event.startsAt));

      return {
        summary: output.simulated
          ? `Sandbox mode: ASSEM would create "${output.event.title}" on ${startLabel}.`
          : `Created "${output.event.title}" on ${startLabel}.`,
        output
      };
    }
  };

  return [listEvents, createEvent];
}
