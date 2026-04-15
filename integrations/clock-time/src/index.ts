import type { TimeOutput, ToolDefinition } from '@assem/shared-types';

function formatOffsetFromLabel(offsetLabel: string | undefined): string | null {
  if (!offsetLabel) {
    return null;
  }

  if (offsetLabel === 'GMT' || offsetLabel === 'UTC') {
    return 'UTC+00:00';
  }

  const match = offsetLabel.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    return null;
  }

  const [, sign, hours, minutes = '00'] = match;
  return `UTC${sign}${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}

function formatUtcOffset(date: Date, timeZone: string): string {
  const offsetLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset'
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;

  const formattedOffset = formatOffsetFromLabel(offsetLabel);
  if (formattedOffset) {
    return formattedOffset;
  }

  const totalMinutes = -date.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(totalMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0');
  const minutes = String(absoluteMinutes % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

export function createClockTimeTool(): ToolDefinition<undefined, TimeOutput> {
  return {
    id: 'clock-time.get-current',
    label: 'Current time',
    description: 'Returns the current local date and time for contextual answers.',
    riskLevel: 'low',
    requiresConfirmation: false,
    requiresPermissions: ['read_only'],
    async execute(_input, context) {
      const timeZone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const formatter = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone
      });
      const utcOffset = formatUtcOffset(context.now, timeZone);

      const output: TimeOutput = {
        iso: context.now.toISOString(),
        localLabel: formatter.format(context.now),
        timeZone,
        utcOffset
      };

      return {
        summary: 'Time snapshot captured.',
        output
      };
    }
  };
}
