import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { JobEvent, JobStartArgs, JobSummary } from './types.js';
import { requireApprovedCwd } from './directory-policy.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_EVENT_DATA_BYTES = 64 * 1024;

type Listener = (event: JobEvent, summary: JobSummary) => void;

interface ManagedJob {
  process: ChildProcessWithoutNullStreams;
  summary: JobSummary;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  maxOutputBytes: number;
  timeout?: ReturnType<typeof setTimeout>;
  cancelling: boolean;
}

export class DeviceJobManager {
  private jobs = new Map<string, ManagedJob>();
  private listeners = new Set<Listener>();

  start(args: JobStartArgs): JobSummary {
    if (!args.command?.trim()) {
      throw new Error('Job command is required');
    }

    const cwd = requireApprovedCwd(args);
    const jobId = randomUUID();
    const maxOutputBytes = this.clampPositive(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const timeoutMs = this.clampPositive(args.timeoutMs, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const child = spawn(args.command, args.args ?? [], {
      cwd,
      env: { ...process.env, ...args.env },
      shell: !args.args || args.args.length === 0,
      windowsHide: true,
    });

    const summary: JobSummary = {
      jobId,
      command: args.command,
      args: args.args,
      cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      stdoutBytes: 0,
      stderrBytes: 0,
    };

    const job: ManagedJob = {
      process: child,
      summary,
      stdout: [],
      stderr: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      maxOutputBytes,
      cancelling: false,
    };
    this.jobs.set(jobId, job);

    child.stdout.on('data', (chunk: Buffer) => {
      this.appendOutput(job, 'stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.appendOutput(job, 'stderr', chunk);
    });
    child.on('error', (error) => {
      summary.status = 'failed';
      summary.error = error.message;
      summary.endedAt = new Date().toISOString();
      this.emit({ jobId, kind: 'error', timestamp: summary.endedAt, error: error.message });
    });
    child.on('close', (exitCode, signal) => {
      if (job.timeout) clearTimeout(job.timeout);
      summary.exitCode = exitCode;
      summary.signal = signal;
      summary.endedAt = new Date().toISOString();
      if (summary.status === 'running') {
        summary.status = exitCode === 0 ? 'exited' : 'failed';
      }
      this.emit({
        jobId,
        kind: summary.status === 'cancelled' ? 'cancelled' : 'exit',
        timestamp: summary.endedAt,
        exitCode,
        signal,
        error: summary.error,
      });
    });

    if (timeoutMs > 0) {
      job.timeout = setTimeout(() => {
        if (summary.status !== 'running') return;
        summary.status = 'timed_out';
        summary.error = `Job timed out after ${timeoutMs}ms`;
        this.kill(job);
      }, timeoutMs);
      job.timeout.unref?.();
    }

    this.emit({ jobId, kind: 'started', timestamp: summary.startedAt });
    return { ...summary };
  }

  status(jobId: string): JobSummary | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job.summary } : undefined;
  }

  tail(
    jobId: string,
    stream: 'stdout' | 'stderr' | 'both' = 'both',
    bytes = 8192
  ): { jobId: string; stdout?: string; stderr?: string } {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const safeBytes = this.clampPositive(bytes, 8192, job.maxOutputBytes);

    const result: { jobId: string; stdout?: string; stderr?: string } = { jobId };
    if (stream === 'stdout' || stream === 'both') {
      result.stdout = this.readTail(job.stdout, safeBytes);
    }
    if (stream === 'stderr' || stream === 'both') {
      result.stderr = this.readTail(job.stderr, safeBytes);
    }
    return result;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.summary.status !== 'running') return false;

    job.cancelling = true;
    job.summary.status = 'cancelled';
    job.summary.error = 'Job cancelled';
    this.kill(job);
    return true;
  }

  list(): JobSummary[] {
    return Array.from(this.jobs.values()).map((job) => ({ ...job.summary }));
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private appendOutput(job: ManagedJob, stream: 'stdout' | 'stderr', chunk: Buffer) {
    const buffers = stream === 'stdout' ? job.stdout : job.stderr;
    buffers.push(chunk);
    if (stream === 'stdout') {
      job.stdoutBytes += chunk.length;
      job.summary.stdoutBytes = job.stdoutBytes;
    } else {
      job.stderrBytes += chunk.length;
      job.summary.stderrBytes = job.stderrBytes;
    }

    this.trimBuffers(buffers, job.maxOutputBytes);
    this.emit({
      jobId: job.summary.jobId,
      kind: stream,
      timestamp: new Date().toISOString(),
      stream,
      data: this.truncateChunk(chunk),
    });
  }

  private trimBuffers(buffers: Buffer[], maxBytes: number) {
    let total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    while (buffers.length > 1 && total > maxBytes) {
      const removed = buffers.shift()!;
      total -= removed.length;
    }
    if (buffers.length === 1 && total > maxBytes) {
      buffers[0] = buffers[0].subarray(total - maxBytes);
    }
  }

  private readTail(buffers: Buffer[], bytes: number): string {
    const joined = Buffer.concat(buffers);
    return joined.subarray(Math.max(0, joined.length - bytes)).toString('utf8');
  }

  private truncateChunk(chunk: Buffer): string {
    if (chunk.length <= MAX_EVENT_DATA_BYTES) {
      return chunk.toString('utf8');
    }
    return chunk.subarray(chunk.length - MAX_EVENT_DATA_BYTES).toString('utf8');
  }

  private clampPositive(value: number | undefined, fallback: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    if (value <= 0) return 0;
    return Math.min(Math.floor(value), max);
  }

  private kill(job: ManagedJob) {
    try {
      if (process.platform === 'win32' && job.process.pid) {
        spawn('taskkill', ['/pid', String(job.process.pid), '/t', '/f'], { windowsHide: true });
      } else {
        job.process.kill('SIGTERM');
      }
    } catch (error: any) {
      job.summary.error = error.message;
    }
  }

  private emit(event: JobEvent) {
    const job = this.jobs.get(event.jobId);
    if (!job) return;
    for (const listener of this.listeners) {
      listener(event, { ...job.summary });
    }
  }
}
