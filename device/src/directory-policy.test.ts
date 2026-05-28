import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDirectoryRoots,
  listApprovedChildDirectories,
  prepareDesktopCommanderArgs,
  requireApprovedCwd,
  sanitizeExecutionArgs,
  validateDirectoryPath,
} from './directory-policy.js';

test('device directory policy accepts only approved roots', () => {
  assert.deepEqual(getDirectoryRoots().map((root) => root.path), [
    'C:\\Agent',
    'C:\\dev',
    'C:\\dev\\Desktop-Projects',
    'C:\\Users\\prest\\Desktop',
    'C:\\Users\\prest\\Desktop\\SPWR-Daily\\Interconnection-Dash-2026',
    'C:\\Users\\prest\\Documents',
    'C:\\Users\\prest\\Downloads',
  ]);
  assert.equal(validateDirectoryPath('C:\\dev\\Desktop-Projects').rootId, 'dev');
  assert.equal(validateDirectoryPath('c:/dev').path, 'C:\\dev');
  assert.throws(() => validateDirectoryPath('C:\\Windows'), /outside/);
  assert.throws(() => validateDirectoryPath('\\\\server\\share'), /UNC/);
  assert.throws(() => validateDirectoryPath('//server/share'), /UNC/);
});

test('device directory policy sanitizes execution arguments', () => {
  assert.deepEqual(
    sanitizeExecutionArgs('execute_command', { command: 'pwd', cwd: 'C:\\dev' }),
    { command: 'pwd', cwd: 'C:\\dev' }
  );
  assert.deepEqual(
    sanitizeExecutionArgs('read_file', { path: 'README.md' }, 'C:\\dev\\Desktop-Projects'),
    { path: 'C:\\dev\\Desktop-Projects\\README.md' }
  );
  assert.deepEqual(
    sanitizeExecutionArgs('dev-a_execute_command', { command: 'pwd' }, 'C:\\dev'),
    { command: 'pwd', cwd: 'C:\\dev' }
  );
  assert.equal(requireApprovedCwd({}, 'C:\\dev'), 'C:\\dev');
  assert.throws(() => sanitizeExecutionArgs('execute_command', { command: 'pwd' }), /Select an approved directory/);
  assert.throws(() => requireApprovedCwd({ cwd: 'C:\\Windows' }), /outside/);
});

test('device directory policy lists available approved child directories', () => {
  const dev = validateDirectoryPath('C:\\dev', { mustExist: true });
  assert.equal(dev.path, 'C:\\dev');

  const children = listApprovedChildDirectories('C:\\dev');
  assert.ok(children.every((child) => child.path.startsWith('C:\\dev\\')));
  assert.ok(children.some((child) => child.name === 'Desktop-Projects'));
});

test('device directory policy rejects unavailable, file, relative, and malformed paths', () => {
  assert.throws(() => validateDirectoryPath('C:\\dev\\does-not-exist-for-dc-remote', { mustExist: true }), /not available/);
  assert.throws(() => validateDirectoryPath('C:\\dev\\Desktop-Projects\\Desktop-Commander-Remote\\README.md', { mustExist: true }), /not available/);
  assert.throws(() => validateDirectoryPath('README.md'), /absolute Windows path/);
  assert.throws(() => validateDirectoryPath(''), /Path is required/);
  assert.throws(() => validateDirectoryPath('C:\\dev\0bad'), /null byte/);
  assert.throws(() => sanitizeExecutionArgs('read_file', { path: '' }, 'C:\\dev'), /Path argument cannot be empty/);
});

test('device directory policy normalizes arrays and selected relative paths', () => {
  assert.deepEqual(
    sanitizeExecutionArgs('read_multiple_files', { paths: ['README.md', 'docs'] }, 'C:\\dev\\Desktop-Projects\\Desktop-Commander-Remote'),
    {
      paths: [
        'C:\\dev\\Desktop-Projects\\Desktop-Commander-Remote\\README.md',
        'C:\\dev\\Desktop-Projects\\Desktop-Commander-Remote\\docs',
      ],
    }
  );
  assert.deepEqual(
    sanitizeExecutionArgs('move_file', { source_path: 'C:\\dev\\a', destination_path: 'C:\\dev\\b' }),
    { source_path: 'C:\\dev\\a', destination_path: 'C:\\dev\\b' }
  );
  assert.deepEqual(
    sanitizeExecutionArgs('noop', { path: { nested: true }, untouched: 'value' }, 'C:\\dev'),
    { path: { nested: true }, untouched: 'value' }
  );
  assert.deepEqual(
    sanitizeExecutionArgs('noop', { paths: ['README.md', 1] }, 'C:\\dev'),
    { paths: ['C:\\dev\\README.md', 1] }
  );
});

test('device directory policy prepares Desktop Commander command args without leaking cwd', () => {
  assert.deepEqual(
    prepareDesktopCommanderArgs('start_process', { command: 'echo hi', timeout_ms: 1000 }, 'C:\\dev'),
    { command: "Set-Location -LiteralPath 'C:\\dev'; echo hi", timeout_ms: 1000 }
  );
  assert.deepEqual(
    prepareDesktopCommanderArgs('start_process', { command: 'echo hi', shell: 'cmd', cwd: 'C:\\dev' }),
    { command: 'cd /d "C:\\dev" && echo hi', shell: 'cmd' }
  );
  assert.deepEqual(
    prepareDesktopCommanderArgs('start_process', { command: 'pwd', shell: 'bash', cwd: 'C:\\dev' }),
    { command: "cd 'C:\\dev' && pwd", shell: 'bash' }
  );
  assert.throws(() => prepareDesktopCommanderArgs('start_process', { timeout_ms: 1000 }, 'C:\\dev'), /Command tools require/);
});
