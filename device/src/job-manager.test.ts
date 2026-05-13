import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceJobManager } from './job-manager.js';

const APPROVED_TEST_CWD = 'C:\\dev';

function waitForFinal(manager: DeviceJobManager, jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      stop();
      reject(new Error(`Timed out waiting for ${jobId}`));
    }, 7000);
    const stop = manager.onEvent((_event, summary) => {
      if (summary.jobId === jobId && summary.status !== 'running') {
        clearTimeout(deadline);
        stop();
        resolve();
      }
    });
  });
}

test('start, status, tail, list, and onEvent track a successful stdout job', async () => {
  const manager = new DeviceJobManager();
  const events: string[] = [];
  const unsubscribe = manager.onEvent((event) => events.push(event.kind));

  const started = manager.start({
    command: process.execPath,
    args: ['-e', 'console.log("hello-job")'],
    cwd: APPROVED_TEST_CWD,
    timeoutMs: 5000,
  });
  await waitForFinal(manager, started.jobId);
  unsubscribe();

  const final = manager.status(started.jobId);
  assert.equal(final?.status, 'exited');
  assert.equal(manager.list().length, 1);
  assert.match(manager.tail(started.jobId, 'stdout').stdout ?? '', /hello-job/);
  assert.equal(manager.tail(started.jobId, 'stderr').stderr, '');
  assert.ok(events.includes('started'));
  assert.ok(events.includes('stdout'));
  assert.ok(events.includes('exit'));
});

test('captures stderr and failed exit status', async () => {
  const manager = new DeviceJobManager();
  const started = manager.start({
    command: process.execPath,
    args: ['-e', 'console.error("bad-job"); process.exit(7)'],
    cwd: APPROVED_TEST_CWD,
    timeoutMs: 5000,
  });

  await waitForFinal(manager, started.jobId);
  const final = manager.status(started.jobId);
  assert.equal(final?.status, 'failed');
  assert.equal(final?.exitCode, 7);
  assert.match(manager.tail(started.jobId, 'stderr').stderr ?? '', /bad-job/);
});

test('cancel stops a running job and unknown/non-running jobs return false', async () => {
  const manager = new DeviceJobManager();
  const started = manager.start({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: APPROVED_TEST_CWD,
    timeoutMs: 15000,
  });

  assert.equal(manager.cancel('missing'), false);
  assert.equal(manager.cancel(started.jobId), true);
  await waitForFinal(manager, started.jobId);
  assert.equal(manager.status(started.jobId)?.status, 'cancelled');
  assert.equal(manager.cancel(started.jobId), false);
});

test('times out a long-running job', async () => {
  const manager = new DeviceJobManager();
  const started = manager.start({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: APPROVED_TEST_CWD,
    timeoutMs: 50,
  });

  await waitForFinal(manager, started.jobId);
  const final = manager.status(started.jobId);
  assert.equal(final?.status, 'timed_out');
  assert.match(final?.error ?? '', /timed out/);
});

test('rejects invalid start and unknown tail/status requests', () => {
  const manager = new DeviceJobManager();

  assert.throws(() => manager.start({ command: '' }), /Job command is required/);
  assert.throws(() => manager.start({ command: 'echo no-cwd' }), /Select an approved directory/);
  assert.throws(() => manager.start({ command: 'echo bad-cwd', cwd: 'C:\\Windows' }), /outside the approved directories/);
  assert.equal(manager.status('missing'), undefined);
  assert.throws(() => manager.tail('missing'), /Unknown job/);
});

test('bounds tail output and event chunks', async () => {
  const manager = new DeviceJobManager();
  let maxEventBytes = 0;
  manager.onEvent((event) => {
    if (event.data) {
      maxEventBytes = Math.max(maxEventBytes, Buffer.byteLength(event.data));
    }
  });

  const started = manager.start({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(80 * 1024))'],
    cwd: APPROVED_TEST_CWD,
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  });
  await waitForFinal(manager, started.jobId);

  assert.equal(Buffer.byteLength(manager.tail(started.jobId, 'stdout', 10_000).stdout ?? ''), 1024);
  assert.ok(maxEventBytes <= 64 * 1024);
});

test('supports shell command mode and disabled timeout', async () => {
  const manager = new DeviceJobManager();
  const started = manager.start({
    command: 'echo shell-job',
    cwd: APPROVED_TEST_CWD,
    timeoutMs: 0,
  });

  await waitForFinal(manager, started.jobId);
  assert.equal(manager.status(started.jobId)?.status, 'exited');
  assert.doesNotThrow(() => manager.tail(started.jobId, 'both', -1));
});
