import { DeviceTool, JobStartArgs } from './types.js';

export function getJobTools(): DeviceTool[] {
  return [
    {
      name: 'job_start',
      description: 'Start a managed CLI job on a connected device.',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          env: { type: 'object' },
          timeoutMs: { type: 'number' },
          maxOutputBytes: { type: 'number' },
        },
        required: ['command'],
      },
    },
    {
      name: 'job_status',
      description: 'Get current status for a managed CLI job.',
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string' }, deviceId: { type: 'string' } },
        required: ['jobId'],
      },
    },
    {
      name: 'job_tail',
      description: 'Read recent stdout and/or stderr for a managed CLI job.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          deviceId: { type: 'string' },
          stream: { type: 'string', enum: ['stdout', 'stderr', 'both'] },
          bytes: { type: 'number' },
        },
        required: ['jobId'],
      },
    },
    {
      name: 'job_cancel',
      description: 'Cancel a running managed CLI job.',
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string' }, deviceId: { type: 'string' } },
        required: ['jobId'],
      },
    },
    {
      name: 'job_list',
      description: 'List managed CLI jobs known by the hub.',
      inputSchema: {
        type: 'object',
        properties: { deviceId: { type: 'string' } },
      },
    },
  ];
}

export function validateJobStartArgs(args: Partial<JobStartArgs>): asserts args is JobStartArgs {
  if (typeof args.command !== 'string' || !args.command.trim()) {
    throw new Error('command is required');
  }
  if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error('args must be an array of strings');
  }
  if (args.cwd !== undefined && typeof args.cwd !== 'string') {
    throw new Error('cwd must be a string');
  }
  if (args.env !== undefined && (typeof args.env !== 'object' || args.env === null || Array.isArray(args.env))) {
    throw new Error('env must be an object');
  }
  if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs))) {
    throw new Error('timeoutMs must be a finite number');
  }
  if (args.maxOutputBytes !== undefined && (typeof args.maxOutputBytes !== 'number' || !Number.isFinite(args.maxOutputBytes))) {
    throw new Error('maxOutputBytes must be a finite number');
  }
}
