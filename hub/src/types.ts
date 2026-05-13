// Shared types for hub <-> device protocol

export interface DeviceTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  tools: DeviceTool[];
  connectedAt: Date;
}

export type JobStatus = 'starting' | 'running' | 'exited' | 'failed' | 'cancelled' | 'timed_out';

export type JobEventKind = 'started' | 'stdout' | 'stderr' | 'exit' | 'error' | 'cancelled';

export interface JobStartArgs {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface JobSummary {
  jobId: string;
  deviceId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface JobEvent {
  jobId: string;
  kind: JobEventKind;
  timestamp: string;
  stream?: 'stdout' | 'stderr';
  data?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}

// WebSocket message types (device <-> hub)
export type HubMessage =
  | { type: 'register'; deviceId: string; deviceName: string; tools: DeviceTool[]; apiKey: string }
  | { type: 'tool_result'; callId: string; result: unknown; error?: string }
  | { type: 'heartbeat' }
  | { type: 'job_started'; callId: string; summary?: JobSummary; error?: string }
  | { type: 'job_result'; callId: string; jobId?: string; summary?: JobSummary; result?: unknown; error?: string }
  | { type: 'job_event'; event: JobEvent; summary?: JobSummary }
  | { type: 'job_status_result'; callId: string; summary?: JobSummary; result?: unknown; error?: string };

export type DeviceMessage =
  | { type: 'registered'; deviceId: string }
  | { type: 'tool_call'; callId: string; toolName: string; toolArgs: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: 'job_start'; callId: string; jobArgs: JobStartArgs }
  | { type: 'job_status'; callId: string; jobId: string }
  | { type: 'job_tail'; callId: string; jobId: string; stream?: 'stdout' | 'stderr' | 'both'; bytes?: number }
  | { type: 'job_cancel'; callId: string; jobId: string }
  | { type: 'heartbeat_ack' }
  | { type: 'error'; message: string };

export interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}
