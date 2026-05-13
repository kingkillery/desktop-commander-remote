import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DeviceRegistry } from './device-registry.js';
import { DeviceMessage, DeviceTool } from './types.js';

class FakeWs extends EventEmitter {
  sent: DeviceMessage[] = [];
  terminated = false;

  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(JSON.parse(data) as DeviceMessage);
    cb?.();
  }

  terminate() {
    this.terminated = true;
  }
}

const tool: DeviceTool = {
  name: 'execute_command',
  description: 'Run a command',
  inputSchema: { type: 'object' },
};

test('register, getAll, getAllTools, isConnected, and remove manage device state', () => {
  const registry = new DeviceRegistry();
  const ws = new FakeWs();

  registry.register(ws as never, 'dev-a', 'Device A', [tool]);

  assert.equal(registry.isConnected('dev-a'), true);
  assert.equal(registry.getAll()[0].deviceName, 'Device A');
  assert.equal(registry.getAllTools()[0].name, 'execute_command');

  registry.remove('dev-a');
  assert.equal(registry.isConnected('dev-a'), false);
});

test('register replaces existing device connection', () => {
  const registry = new DeviceRegistry();
  const first = new FakeWs();
  const second = new FakeWs();

  registry.register(first as never, 'dev-a', 'Device A', [tool]);
  registry.register(second as never, 'dev-a', 'Device A', [tool]);

  assert.equal(first.terminated, true);
  assert.equal(registry.isConnected('dev-a'), true);
});

test('multi-device tool names are prefixed and resolved', () => {
  const registry = new DeviceRegistry();
  registry.register(new FakeWs() as never, 'dev-a', 'Device A', [tool]);
  registry.register(new FakeWs() as never, 'dev-b', 'Device B', [tool]);

  const tools = registry.getAllTools().map((t) => t.name).sort();
  assert.deepEqual(tools, ['dev-a_execute_command', 'dev-b_execute_command']);
  assert.equal(registry.findDeviceForTool('dev-b_execute_command'), 'dev-b');
  assert.equal(registry.resolveToolName('dev-b', 'dev-b_execute_command'), 'execute_command');
  assert.equal(registry.findDeviceForTool('missing'), undefined);
});

test('single-device routing and missing tool errors are explicit', async () => {
  const empty = new DeviceRegistry();
  await assert.rejects(empty.callTool('execute_command', {}, undefined, 1000), /No devices connected/);

  const registry = new DeviceRegistry();
  registry.register(new FakeWs() as never, 'dev-a', 'Device A', [tool]);
  assert.equal(registry.findDeviceForTool('anything'), 'dev-a');
  assert.equal(registry.resolveToolName('dev-a', 'dev-a_execute_command'), 'dev-a_execute_command');

  registry.register(new FakeWs() as never, 'dev-b', 'Device B', [tool]);
  await assert.rejects(registry.callTool('missing', {}, undefined, 1000), /No device found/);
});

test('getDeviceIdForRequest validates device selection', () => {
  const registry = new DeviceRegistry();
  assert.throws(() => registry.getDeviceIdForRequest(), /No devices connected/);

  registry.register(new FakeWs() as never, 'dev-a', 'Device A', [tool]);
  assert.equal(registry.getDeviceIdForRequest(), 'dev-a');
  assert.equal(registry.getDeviceIdForRequest('dev-a'), 'dev-a');
  assert.throws(() => registry.getDeviceIdForRequest('missing'), /Device not connected/);

  registry.register(new FakeWs() as never, 'dev-b', 'Device B', [tool]);
  assert.throws(() => registry.getDeviceIdForRequest(), /Multiple devices connected/);
});

test('callTool sends requests and resolveCall settles pending calls', async () => {
  const registry = new DeviceRegistry();
  const ws = new FakeWs();
  registry.register(ws as never, 'dev-a', 'Device A', [tool]);

  const promise = registry.callTool('execute_command', { command: 'echo hi' }, undefined, 1000);
  const sent = ws.sent[0];
  assert.equal(sent.type, 'tool_call');
  if (sent.type !== 'tool_call') throw new Error('unexpected message');
  registry.resolveCall('dev-a', sent.callId, { ok: true });

  assert.deepEqual(await promise, { ok: true });

  const devicePromise = registry.callToolOnDevice('dev-a', '__directory_list', { path: 'C:\\dev' }, undefined, 1000);
  const deviceSent = ws.sent.at(-1)!;
  assert.equal(deviceSent.type, 'tool_call');
  if (deviceSent.type !== 'tool_call') throw new Error('unexpected message');
  assert.equal(deviceSent.toolName, '__directory_list');
  registry.resolveCall('dev-a', deviceSent.callId, { directories: [] });
  assert.deepEqual(await devicePromise, { directories: [] });

  await assert.rejects(registry.callToolOnDevice('missing', 'ping', {}, undefined, 1000), /Device not connected/);
});

test('sendJobStart/status/tail/cancel send job messages and resolve results', async () => {
  const registry = new DeviceRegistry();
  const ws = new FakeWs();
  registry.register(ws as never, 'dev-a', 'Device A', [tool]);

  const start = registry.sendJobStart({ command: 'node' }, undefined, 1000);
  let sent = ws.sent.at(-1)!;
  assert.equal(sent.type, 'job_start');
  if (sent.type !== 'job_start') throw new Error('unexpected message');
  registry.resolveCall('dev-a', sent.callId, { jobId: 'job-1' });
  assert.deepEqual(await start, { jobId: 'job-1' });

  const status = registry.sendJobStatus('job-1', undefined, 1000);
  sent = ws.sent.at(-1)!;
  assert.equal(sent.type, 'job_status');
  if (sent.type !== 'job_status') throw new Error('unexpected message');
  registry.resolveCall('dev-a', sent.callId, { status: 'running' });
  assert.deepEqual(await status, { status: 'running' });

  const tail = registry.sendJobTail('job-1', 'both', 100, undefined, 1000);
  sent = ws.sent.at(-1)!;
  assert.equal(sent.type, 'job_tail');
  if (sent.type !== 'job_tail') throw new Error('unexpected message');
  registry.resolveCall('dev-a', sent.callId, { stdout: 'hi' });
  assert.deepEqual(await tail, { stdout: 'hi' });

  const cancel = registry.sendJobCancel('job-1', undefined, 1000);
  sent = ws.sent.at(-1)!;
  assert.equal(sent.type, 'job_cancel');
  if (sent.type !== 'job_cancel') throw new Error('unexpected message');
  registry.resolveCall('dev-a', sent.callId, { cancelled: true });
  assert.deepEqual(await cancel, { cancelled: true });
});

test('pending calls reject on errors, disconnects, and send failures', async () => {
  const registry = new DeviceRegistry();
  const ws = new FakeWs();
  registry.register(ws as never, 'dev-a', 'Device A', [tool]);

  const errored = registry.callTool('execute_command', {}, undefined, 1000);
  const sent = ws.sent.at(-1)!;
  if (sent.type !== 'tool_call') throw new Error('unexpected message');
  registry.resolveCall('dev-a', sent.callId, undefined, 'boom');
  await assert.rejects(errored, /boom/);

  const disconnected = registry.callTool('execute_command', {}, undefined, 1000);
  registry.remove('dev-a');
  await assert.rejects(disconnected, /disconnected/);

  const badWs = new FakeWs();
  badWs.send = (_data: string, cb?: (err?: Error) => void) => cb?.(new Error('send failed'));
  registry.register(badWs as never, 'dev-b', 'Device B', [tool]);
  await assert.rejects(registry.callTool('execute_command', {}, undefined, 1000), /send failed/);
  await assert.rejects(registry.sendJobStart({ command: 'node' }, undefined, 1000), /send failed/);
  registry.resolveCall('missing', 'missing-call', {});
  registry.resolveCall('dev-b', 'missing-call', {});
});
