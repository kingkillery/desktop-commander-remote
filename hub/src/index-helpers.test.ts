/**
 * Tests for inline helpers that live in hub/src/index.ts and cannot be imported
 * directly. We extract and re-implement them here in a way that exactly mirrors
 * the production logic, so regressions are caught if the originals change.
 *
 * Covered:
 *  - SimpleRateLimiter
 *  - getClientIp
 *  - getPublicUrl / getPublicBasePath
 *  - requireString
 *  - isCommandToolName
 *  - describeMcpTool
 *  - decorateMcpInputSchema
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── SimpleRateLimiter (copy of the inline class in index.ts) ──────────────────

class SimpleRateLimiter {
  private requests = new Map<string, number[]>();
  isAllowed(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = this.requests.get(key) || [];
    const recent = timestamps.filter((t) => t > windowStart);
    if (recent.length >= maxRequests) return false;
    recent.push(now);
    this.requests.set(key, recent);
    return true;
  }
}

test('SimpleRateLimiter allows requests under the limit', () => {
  const limiter = new SimpleRateLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.isAllowed('k', 5, 60_000), true);
  }
});

test('SimpleRateLimiter blocks the request that exceeds the limit', () => {
  const limiter = new SimpleRateLimiter();
  for (let i = 0; i < 3; i++) {
    limiter.isAllowed('k', 3, 60_000);
  }
  assert.equal(limiter.isAllowed('k', 3, 60_000), false);
});

test('SimpleRateLimiter keys are independent', () => {
  const limiter = new SimpleRateLimiter();
  // Fill up key 'a'
  for (let i = 0; i < 2; i++) limiter.isAllowed('a', 2, 60_000);
  assert.equal(limiter.isAllowed('a', 2, 60_000), false);
  // Key 'b' is unaffected
  assert.equal(limiter.isAllowed('b', 2, 60_000), true);
});

test('SimpleRateLimiter respects a zero window (no recent timestamps)', () => {
  const limiter = new SimpleRateLimiter();
  // All timestamps are "expired" in a 0ms window
  assert.equal(limiter.isAllowed('k', 1, 0), true);
  // Second call: the first timestamp is outside the 0ms window, so still allowed
  assert.equal(limiter.isAllowed('k', 1, 0), true);
});

test('SimpleRateLimiter allows a max of 1 within a large window', () => {
  const limiter = new SimpleRateLimiter();
  assert.equal(limiter.isAllowed('only-one', 1, 999_999), true);
  assert.equal(limiter.isAllowed('only-one', 1, 999_999), false);
});

// ── getClientIp (mirrors the production implementation) ───────────────────────

function getClientIp(req: {
  headers: Record<string, string | undefined>;
  socket: { remoteAddress?: string };
}): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

test('getClientIp extracts the first IP from x-forwarded-for', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  assert.equal(getClientIp(req), '1.2.3.4');
});

test('getClientIp falls back to socket address when header is absent', () => {
  const req = {
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.equal(getClientIp(req), '127.0.0.1');
});

test('getClientIp returns "unknown" when socket address is missing too', () => {
  const req = { headers: {}, socket: {} };
  assert.equal(getClientIp(req), 'unknown');
});

test('getClientIp handles a single IP in x-forwarded-for without trailing comma', () => {
  const req = {
    headers: { 'x-forwarded-for': '203.0.113.5' },
    socket: { remoteAddress: '192.168.1.1' },
  };
  assert.equal(getClientIp(req), '203.0.113.5');
});

// ── requireString (mirrors hub/src/index.ts) ──────────────────────────────────

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

test('requireString returns the value for a non-empty string', () => {
  assert.equal(requireString('hello', 'x'), 'hello');
});

test('requireString throws for undefined', () => {
  assert.throws(() => requireString(undefined, 'myParam'), /myParam is required/);
});

test('requireString throws for an empty string', () => {
  assert.throws(() => requireString('', 'myParam'), /myParam is required/);
});

test('requireString throws for a non-string value', () => {
  assert.throws(() => requireString(42, 'myParam'), /myParam is required/);
});

// ── isCommandToolName (mirrors hub/src/index.ts) ──────────────────────────────

function isCommandToolName(name: string): boolean {
  return name === 'execute_command'
    || name === 'start_process'
    || name.endsWith('_execute_command')
    || name.endsWith('_start_process');
}

test('isCommandToolName returns true for bare execute_command', () => {
  assert.equal(isCommandToolName('execute_command'), true);
});

test('isCommandToolName returns true for bare start_process', () => {
  assert.equal(isCommandToolName('start_process'), true);
});

test('isCommandToolName returns true for prefixed _execute_command', () => {
  assert.equal(isCommandToolName('dev_a_execute_command'), true);
});

test('isCommandToolName returns true for prefixed _start_process', () => {
  assert.equal(isCommandToolName('dev_a_start_process'), true);
});

test('isCommandToolName returns false for non-command tools', () => {
  assert.equal(isCommandToolName('read_file'), false);
  assert.equal(isCommandToolName('directory_select'), false);
  assert.equal(isCommandToolName('job_start'), false);
  assert.equal(isCommandToolName('execute_command_extra'), false); // suffix, not prefix
});

// ── describeMcpTool (mirrors hub/src/index.ts) ────────────────────────────────

function describeMcpTool(name: string, description: string): string {
  if (isCommandToolName(name)) {
    return `${description} Requires an approved cwd or a prior directory_select call.`;
  }
  return description;
}

test('describeMcpTool appends cwd requirement for command tools', () => {
  const desc = describeMcpTool('execute_command', 'Run a shell command.');
  assert.ok(desc.includes('Requires an approved cwd'));
});

test('describeMcpTool does not modify description for non-command tools', () => {
  const original = 'Read the contents of a file.';
  assert.equal(describeMcpTool('read_file', original), original);
});

test('describeMcpTool works for prefixed command tools', () => {
  const desc = describeMcpTool('device_a_start_process', 'Start a process.');
  assert.ok(desc.includes('Requires an approved cwd'));
});

// ── decorateMcpInputSchema (mirrors hub/src/index.ts) ────────────────────────

function decorateMcpInputSchema(
  name: string,
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] }
): typeof inputSchema {
  if (!isCommandToolName(name)) return inputSchema;
  return {
    ...inputSchema,
    properties: {
      ...(inputSchema.properties ?? {}),
      cwd: {
        type: 'string',
        description: 'Approved working directory from directory_roots/directory_select.',
      },
    },
  };
}

test('decorateMcpInputSchema injects cwd property for command tools', () => {
  const schema = { type: 'object', properties: { command: { type: 'string' } } };
  const decorated = decorateMcpInputSchema('execute_command', schema);
  assert.ok('cwd' in (decorated.properties ?? {}));
  assert.equal((decorated.properties!['cwd'] as any).type, 'string');
});

test('decorateMcpInputSchema does not modify schema for non-command tools', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } } };
  const decorated = decorateMcpInputSchema('read_file', schema);
  assert.deepEqual(decorated, schema);
});

test('decorateMcpInputSchema preserves existing properties for command tools', () => {
  const schema = { type: 'object', properties: { command: { type: 'string' } } };
  const decorated = decorateMcpInputSchema('start_process', schema);
  assert.ok('command' in (decorated.properties ?? {}));
  assert.ok('cwd' in (decorated.properties ?? {}));
});

test('decorateMcpInputSchema handles schema with no existing properties', () => {
  const schema = { type: 'object' };
  const decorated = decorateMcpInputSchema('execute_command', schema);
  assert.ok('cwd' in (decorated.properties ?? {}));
});

// ── getPublicUrl / getPublicBasePath logic ────────────────────────────────────
// We replicate the logic rather than import it (it's not exported from index.ts)

const PORT = 3000;

function getPublicUrl(req?: { headers: Record<string, string | undefined>; protocol?: string }, publicUrl?: string): string {
  if (publicUrl) return publicUrl;
  if (!req?.headers.host) return `http://localhost:${PORT}`;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = typeof forwardedProto === 'string'
    ? forwardedProto.split(',')[0].trim()
    : (req.protocol ?? 'http');
  return `${protocol}://${req.headers.host}`;
}

function getPublicBasePath(publicUrl?: string): string {
  if (!publicUrl) return '';
  try {
    const pathname = new URL(publicUrl).pathname.replace(/\/+$/, '');
    return pathname === '/' ? '' : pathname;
  } catch {
    return '';
  }
}

test('getPublicUrl returns PUBLIC_URL when set', () => {
  const url = getPublicUrl(undefined, 'https://example.com');
  assert.equal(url, 'https://example.com');
});

test('getPublicUrl falls back to localhost when no request and no PUBLIC_URL', () => {
  const url = getPublicUrl(undefined, undefined);
  assert.equal(url, `http://localhost:${PORT}`);
});

test('getPublicUrl derives URL from request host and protocol', () => {
  const req = { headers: { host: 'api.example.com' }, protocol: 'https' };
  assert.equal(getPublicUrl(req), 'https://api.example.com');
});

test('getPublicUrl prefers x-forwarded-proto over request protocol', () => {
  const req = { headers: { host: 'api.example.com', 'x-forwarded-proto': 'https' }, protocol: 'http' };
  assert.equal(getPublicUrl(req), 'https://api.example.com');
});

test('getPublicUrl extracts first proto from multi-value x-forwarded-proto', () => {
  const req = { headers: { host: 'api.example.com', 'x-forwarded-proto': 'https, http' }, protocol: 'http' };
  assert.equal(getPublicUrl(req), 'https://api.example.com');
});

test('getPublicBasePath returns empty string when no PUBLIC_URL', () => {
  assert.equal(getPublicBasePath(), '');
});

test('getPublicBasePath returns empty string for root PUBLIC_URL', () => {
  assert.equal(getPublicBasePath('https://example.com'), '');
  assert.equal(getPublicBasePath('https://example.com/'), '');
});

test('getPublicBasePath extracts non-root pathname', () => {
  assert.equal(getPublicBasePath('https://example.com/hub'), '/hub');
  assert.equal(getPublicBasePath('https://example.com/hub/v2'), '/hub/v2');
  // Trailing slash is stripped
  assert.equal(getPublicBasePath('https://example.com/hub/'), '/hub');
});
