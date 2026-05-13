import { JobEvent, JobSummary } from './types.js';

const MAX_EVENTS_PER_JOB = 1000;
const MAX_EVENT_DATA_BYTES = 64 * 1024;

export class HubJobRegistry {
  private jobs = new Map<string, JobSummary>();
  private jobEvents = new Map<string, JobEvent[]>();

  recordStarted(deviceId: string, summary: JobSummary): void {
    this.jobs.set(summary.jobId, { ...summary, deviceId });
    if (!this.jobEvents.has(summary.jobId)) {
      this.jobEvents.set(summary.jobId, []);
    }
  }

  recordEvent(deviceId: string, event: JobEvent, summary?: JobSummary): void {
    const events = this.jobEvents.get(event.jobId) ?? [];
    events.push(this.normalizeEvent(event));
    while (events.length > MAX_EVENTS_PER_JOB) {
      events.shift();
    }
    this.jobEvents.set(event.jobId, events);

    if (summary) {
      this.jobs.set(event.jobId, { ...summary, deviceId });
      return;
    }

    const existing = this.jobs.get(event.jobId);
    if (!existing) return;
    if (event.kind === 'stdout') existing.stdoutBytes += Buffer.byteLength(event.data ?? '');
    if (event.kind === 'stderr') existing.stderrBytes += Buffer.byteLength(event.data ?? '');
    if (event.kind === 'exit' || event.kind === 'error' || event.kind === 'cancelled') {
      existing.endedAt = event.timestamp;
      existing.exitCode = event.exitCode;
      existing.signal = event.signal;
      existing.error = event.error;
      existing.status = event.kind === 'cancelled' ? 'cancelled' : event.kind === 'error' ? 'failed' : existing.status;
    }
  }

  recordFinal(deviceId: string, summary: JobSummary, error?: string): void {
    this.jobs.set(summary.jobId, { ...summary, deviceId, error: error ?? summary.error });
  }

  get(jobId: string): JobSummary | undefined {
    const summary = this.jobs.get(jobId);
    return summary ? { ...summary } : undefined;
  }

  list(deviceId?: string): JobSummary[] {
    return Array.from(this.jobs.values())
      .filter((job) => !deviceId || job.deviceId === deviceId)
      .map((job) => ({ ...job }));
  }

  events(jobId: string): JobEvent[] {
    return [...(this.jobEvents.get(jobId) ?? [])];
  }

  private normalizeEvent(event: JobEvent): JobEvent {
    if (!event.data || Buffer.byteLength(event.data) <= MAX_EVENT_DATA_BYTES) {
      return { ...event };
    }

    const truncated = Buffer.from(event.data).subarray(-MAX_EVENT_DATA_BYTES).toString('utf8');
    return { ...event, data: truncated };
  }
}
