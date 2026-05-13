import test from 'node:test';
import assert from 'node:assert/strict';
import { HubJobRegistry } from './job-registry.js';
import { getJobTools, validateJobStartArgs } from './job-tools.js';
import { getDirectoryTools, isDirectoryTool } from './directory-tools.js';

test('HubJobRegistry records started jobs, events, and final summaries', () => {
  const registry = new HubJobRegistry();
  const started = {
    jobId: 'job-1',
    command: 'node',
    args: ['--version'],
    status: 'running' as const,
    startedAt: '2026-05-13T00:00:00.000Z',
    stdoutBytes: 0,
    stderrBytes: 0,
  };

  registry.recordStarted('device-a', started);
  registry.recordEvent('device-a', {
    jobId: 'job-1',
    kind: 'stdout',
    timestamp: '2026-05-13T00:00:01.000Z',
    stream: 'stdout',
    data: 'v22.0.0',
  });
  registry.recordFinal('device-a', {
    ...started,
    status: 'exited',
    endedAt: '2026-05-13T00:00:02.000Z',
    exitCode: 0,
    signal: null,
    stdoutBytes: 7,
    stderrBytes: 0,
  });

  assert.equal(registry.get('job-1')?.deviceId, 'device-a');
  assert.equal(registry.get('job-1')?.status, 'exited');
  assert.equal(registry.list('device-a').length, 1);
  assert.equal(registry.list('device-b').length, 0);
  assert.equal(registry.events('job-1').length, 1);
});

test('HubJobRegistry updates summaries for stderr, cancel, error, and summary events', () => {
  const registry = new HubJobRegistry();
  registry.recordEvent('device-a', {
    jobId: 'missing-job',
    kind: 'stdout',
    timestamp: '2026-05-13T00:00:00.000Z',
    data: 'ignored',
  });
  assert.equal(registry.get('missing-job'), undefined);

  registry.recordStarted('device-a', {
    jobId: 'job-status',
    command: 'node',
    status: 'running',
    startedAt: '2026-05-13T00:00:00.000Z',
    stdoutBytes: 0,
    stderrBytes: 0,
  });
  registry.recordEvent('device-a', {
    jobId: 'job-status',
    kind: 'stderr',
    timestamp: '2026-05-13T00:00:01.000Z',
    stream: 'stderr',
    data: 'warn',
  });
  assert.equal(registry.get('job-status')?.stderrBytes, 4);

  registry.recordEvent('device-a', {
    jobId: 'job-status',
    kind: 'cancelled',
    timestamp: '2026-05-13T00:00:02.000Z',
    signal: 'SIGTERM',
    error: 'cancelled',
  });
  assert.equal(registry.get('job-status')?.status, 'cancelled');

  registry.recordEvent('device-a', {
    jobId: 'job-status',
    kind: 'error',
    timestamp: '2026-05-13T00:00:03.000Z',
    error: 'failed',
  });
  assert.equal(registry.get('job-status')?.status, 'failed');

  registry.recordEvent('device-b', {
    jobId: 'job-status',
    kind: 'exit',
    timestamp: '2026-05-13T00:00:04.000Z',
  }, {
    jobId: 'job-status',
    deviceId: 'ignored-device',
    command: 'node',
    status: 'exited',
    startedAt: '2026-05-13T00:00:00.000Z',
    stdoutBytes: 1,
    stderrBytes: 2,
  });
  assert.equal(registry.get('job-status')?.deviceId, 'device-b');
  assert.equal(registry.get('job-status')?.status, 'exited');
});

test('MCP job tool schemas expose the managed CLI controls', () => {
  const tools = getJobTools();
  const names = tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, ['job_cancel', 'job_list', 'job_start', 'job_status', 'job_tail']);
  assert.deepEqual(tools.find((tool) => tool.name === 'job_start')?.inputSchema.required, ['command']);
  assert.deepEqual(tools.find((tool) => tool.name === 'job_status')?.inputSchema.required, ['jobId']);
  assert.deepEqual(tools.find((tool) => tool.name === 'job_cancel')?.inputSchema.required, ['jobId']);
});

test('MCP directory tool schemas expose picker controls', () => {
  const tools = getDirectoryTools();
  const names = tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, ['directory_current', 'directory_list', 'directory_roots', 'directory_select']);
  assert.equal(isDirectoryTool('directory_select'), true);
  assert.equal(isDirectoryTool('job_start'), false);
  assert.deepEqual(tools.find((tool) => tool.name === 'directory_list')?.inputSchema.required, ['path']);
  assert.deepEqual(tools.find((tool) => tool.name === 'directory_select')?.inputSchema.required, ['path']);
});

test('HubJobRegistry bounds retained event history and event payload size', () => {
  const registry = new HubJobRegistry();
  registry.recordStarted('device-a', {
    jobId: 'job-2',
    command: 'spam',
    status: 'running',
    startedAt: '2026-05-13T00:00:00.000Z',
    stdoutBytes: 0,
    stderrBytes: 0,
  });

  for (let i = 0; i < 1005; i += 1) {
    registry.recordEvent('device-a', {
      jobId: 'job-2',
      kind: 'stdout',
      timestamp: `2026-05-13T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      stream: 'stdout',
      data: `${i}:` + 'x'.repeat(70 * 1024),
    });
  }

  const events = registry.events('job-2');
  assert.equal(events.length, 1000);
  assert.ok(Buffer.byteLength(events[0].data ?? '') <= 64 * 1024);
});

test('validateJobStartArgs accepts valid job start payloads', () => {
  assert.doesNotThrow(() => validateJobStartArgs({
    command: 'node',
    args: ['--version'],
    cwd: 'C:\\tmp',
    env: { FOO: 'bar' },
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  }));
});

test('validateJobStartArgs rejects invalid job start payloads', () => {
  assert.throws(() => validateJobStartArgs({}), /command is required/);
  assert.throws(() => validateJobStartArgs({ command: 'node', args: ['ok', 1 as unknown as string] }), /args must be/);
  assert.throws(() => validateJobStartArgs({ command: 'node', cwd: 1 as unknown as string }), /cwd must be/);
  assert.throws(() => validateJobStartArgs({ command: 'node', env: [] as unknown as Record<string, string> }), /env must be/);
  assert.throws(() => validateJobStartArgs({ command: 'node', timeoutMs: Number.NaN }), /timeoutMs/);
  assert.throws(() => validateJobStartArgs({ command: 'node', maxOutputBytes: Number.POSITIVE_INFINITY }), /maxOutputBytes/);
});
