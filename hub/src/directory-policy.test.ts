import test from 'node:test';
import assert from 'node:assert/strict';

// Set test environment variable before importing directory-policy
process.env.APPROVED_DIRECTORIES = 'user_profile:User profile:C:\\Users\\prest,dev:Development:C:\\dev,spwr_artifacts:SPWR artifacts:C:\\Users\\prest\\Desktop\\SPWR-Daily\\Interconnection-Dash-2026\\.artifacts';

const {
  getDefaultApprovedDirectory,
  getDirectoryRoots,
  prepareDesktopCommanderArgs,
  requireApprovedCwd,
  sanitizeExecutionArgs,
  validateDirectoryPath,
} = await import('./directory-policy.js');


test('directory roots expose only approved Windows roots', () => {
  const roots = getDirectoryRoots();
  assert.deepEqual(roots.map((root) => root.path), [
    'C:\\Users\\prest',
    'C:\\dev',
    'C:\\Users\\prest\\Desktop\\SPWR-Daily\\Interconnection-Dash-2026\\.artifacts',
  ]);
});

test('validateDirectoryPath accepts approved roots and subdirectories', () => {
  assert.equal(validateDirectoryPath('C:\\dev').path, 'C:\\dev');
  assert.equal(validateDirectoryPath('c:/dev/Desktop-Projects').path, 'C:\\dev\\Desktop-Projects');
  assert.equal(validateDirectoryPath('C:\\Users\\prest\\Desktop').rootId, 'user_profile');
});

test('validateDirectoryPath rejects unsafe or unapproved paths', () => {
  assert.throws(() => validateDirectoryPath('C:\\Windows'), /outside/);
  assert.throws(() => validateDirectoryPath('C:\\dev\\..\\Windows'), /outside/);
  assert.throws(() => validateDirectoryPath('..\\Desktop'), /absolute Windows path/);
  assert.throws(() => validateDirectoryPath('C:dev'), /absolute Windows path/);
  assert.throws(() => validateDirectoryPath('\\\\server\\share'), /UNC/);
});

test('sanitizeExecutionArgs applies selected cwd and path policy', () => {
  assert.deepEqual(
    sanitizeExecutionArgs('execute_command', { command: 'dir' }, 'C:\\dev'),
    { command: 'dir', cwd: 'C:\\dev' }
  );
  assert.deepEqual(
    sanitizeExecutionArgs('read_file', { path: 'README.md' }, 'C:\\dev\\Desktop-Projects'),
    { path: 'C:\\dev\\Desktop-Projects\\README.md' }
  );
  assert.deepEqual(
    sanitizeExecutionArgs('write_file', { path: 'C:\\Users\\prest\\notes.txt' }),
    { path: 'C:\\Users\\prest\\notes.txt' }
  );
});

test('sanitizeExecutionArgs rejects command execution without approved cwd', () => {
  assert.throws(() => sanitizeExecutionArgs('execute_command', { command: 'dir' }), /Select an approved directory/);
  assert.throws(() => sanitizeExecutionArgs('execute_command', { command: 'dir', cwd: 'C:\\Windows' }), /outside/);
  assert.throws(() => sanitizeExecutionArgs('read_file', { path: 'README.md' }), /Relative path requires/);
  assert.equal(requireApprovedCwd({ cwd: 'C:\\dev' }), 'C:\\dev');
  assert.throws(() => requireApprovedCwd({}), /Select an approved directory/);
});

test('prepareDesktopCommanderArgs converts virtual cwd into shell command prefix', () => {
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
  assert.deepEqual(
    prepareDesktopCommanderArgs('read_file', { path: 'README.md' }, 'C:\\dev'),
    { path: 'C:\\dev\\README.md' }
  );
  assert.throws(() => prepareDesktopCommanderArgs('start_process', { timeout_ms: 1000 }, 'C:\\dev'), /Command tools require/);
});

test('getDefaultApprovedDirectory returns approved fallback when env unset', () => {
  const prev = process.env.DEFAULT_APPROVED_DIRECTORY;
  delete process.env.DEFAULT_APPROVED_DIRECTORY;
  try {
    assert.equal(getDefaultApprovedDirectory(), 'C:\\Users\\prest\\.mcporter');
  } finally {
    if (prev !== undefined) process.env.DEFAULT_APPROVED_DIRECTORY = prev;
  }
});

test('getDefaultApprovedDirectory honors env override and rejects unapproved values', () => {
  const prev = process.env.DEFAULT_APPROVED_DIRECTORY;
  try {
    process.env.DEFAULT_APPROVED_DIRECTORY = 'C:\\dev\\Desktop-Projects';
    assert.equal(getDefaultApprovedDirectory(), 'C:\\dev\\Desktop-Projects');

    process.env.DEFAULT_APPROVED_DIRECTORY = 'C:\\Windows';
    assert.equal(getDefaultApprovedDirectory(), undefined);
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_APPROVED_DIRECTORY;
    else process.env.DEFAULT_APPROVED_DIRECTORY = prev;
  }
});
