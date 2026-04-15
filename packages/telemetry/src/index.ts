import { appendJsonLine, readJsonLines } from '@assem/persistence';
import type {
  TelemetryRecord,
  TelemetrySink,
  TelemetrySummary
} from '@assem/shared-types';

function sortTelemetry(entries: TelemetryRecord[]): TelemetryRecord[] {
  return [...entries].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp)
  );
}

export class FileTelemetrySink implements TelemetrySink {
  constructor(private readonly filePath: string) {}

  async record(record: TelemetryRecord): Promise<void> {
    await appendJsonLine(this.filePath, record);
  }

  async list(limit = 50): Promise<TelemetryRecord[]> {
    const entries = await readJsonLines<TelemetryRecord>(this.filePath, limit);
    return sortTelemetry(entries).reverse();
  }

  async summarize(limit = 20): Promise<TelemetrySummary> {
    const allEntries = await readJsonLines<TelemetryRecord>(this.filePath);
    const recent = sortTelemetry(allEntries).reverse().slice(0, limit);
    const lastError = recent.find((entry) => entry.result === 'error');

    return {
      totalInteractions: allEntries.length,
      successes: allEntries.filter((entry) => entry.result === 'success').length,
      rejections: allEntries.filter((entry) => entry.result === 'rejected').length,
      errors: allEntries.filter((entry) => entry.result === 'error').length,
      lastInteractionAt: recent[0]?.timestamp,
      lastError: lastError?.errorMessage,
      recent
    };
  }
}
