import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from './auth.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
// Build an AuthManager with keys/clients pre-seeded without touching the
// filesystem (we bypass load() and inject state via the public create* methods
// which write to the in-memory Maps before delegating to save()).
// We override the private save methods so tests stay hermetic.

function makeAuth(): AuthManager {
  const auth = new AuthManager();
  // Patch private save helpers to no-op so no file system access occurs.
  (auth as any).save = async () => {};
  (auth as any).saveOAuth = async () => {};
  return auth;
}

// ── API key management ────────────────────────────────────────────────────────

test('AuthManager.createKey returns a key with the given label', async () => {
  const auth = makeAuth();
  const key = await auth.createKey('my-label');
  assert.equal(typeof key.key, 'string');
  assert.ok(key.key.length > 0);
  assert.equal(key.label, 'my-label');
  assert.equal(typeof key.createdAt, 'string');
});

test('AuthManager.validate returns true for a created key', async () => {
  const auth = makeAuth();
  const key = await auth.createKey('test');
  assert.equal(auth.validate(key.key), true);
});

test('AuthManager.validate returns false for an unknown key', () => {
  const auth = makeAuth();
  assert.equal(auth.validate('not-a-real-key'), false);
});

test('AuthManager.listKeys returns all created keys', async () => {
  const auth = makeAuth();
  const a = await auth.createKey('a');
  const b = await auth.createKey('b');
  const keys = await auth.listKeys();
  const keyValues = keys.map((k) => k.key);
  assert.ok(keyValues.includes(a.key));
  assert.ok(keyValues.includes(b.key));
  assert.equal(keys.length, 2);
});

test('AuthManager.revokeKey removes the key and returns true', async () => {
  const auth = makeAuth();
  const key = await auth.createKey('revoke-me');
  const result = await auth.revokeKey(key.key);
  assert.equal(result, true);
  assert.equal(auth.validate(key.key), false);
});

test('AuthManager.revokeKey returns false for a missing key', async () => {
  const auth = makeAuth();
  const result = await auth.revokeKey('does-not-exist');
  assert.equal(result, false);
});

test('AuthManager supports multiple keys independently', async () => {
  const auth = makeAuth();
  const a = await auth.createKey('a');
  const b = await auth.createKey('b');
  await auth.revokeKey(a.key);
  assert.equal(auth.validate(a.key), false);
  assert.equal(auth.validate(b.key), true);
});

// ── Access token (OAuth Bearer) ───────────────────────────────────────────────

test('AuthManager.validateAccessToken accepts a valid API key as bearer token', async () => {
  const auth = makeAuth();
  const key = await auth.createKey('bearer-test');
  assert.equal(auth.validateAccessToken(key.key), true);
});

test('AuthManager.validateAccessToken rejects an unknown token', () => {
  const auth = makeAuth();
  assert.equal(auth.validateAccessToken('garbage'), false);
});

test('AuthManager.validateAccessToken rejects a revoked key', async () => {
  const auth = makeAuth();
  const key = await auth.createKey('revoke-token');
  await auth.revokeKey(key.key);
  assert.equal(auth.validateAccessToken(key.key), false);
});

// ── OAuth client management ───────────────────────────────────────────────────

test('AuthManager.createOAuthClient returns a client with clientId and clientSecret', async () => {
  const auth = makeAuth();
  const client = await auth.createOAuthClient('chatgpt', 'ChatGPT');
  assert.equal(typeof client.clientId, 'string');
  assert.ok(client.clientId.length > 0);
  assert.equal(typeof client.clientSecret, 'string');
  assert.ok(client.clientSecret.length > 0);
  assert.equal(client.name, 'ChatGPT');
});

test('AuthManager.validateOAuthClient returns true for matching credentials', async () => {
  const auth = makeAuth();
  const client = await auth.createOAuthClient('chatgpt', 'ChatGPT');
  assert.equal(auth.validateOAuthClient(client.clientId, client.clientSecret), true);
});

test('AuthManager.validateOAuthClient returns false for wrong secret', async () => {
  const auth = makeAuth();
  const client = await auth.createOAuthClient('chatgpt', 'ChatGPT');
  assert.equal(auth.validateOAuthClient(client.clientId, 'wrong-secret'), false);
});

test('AuthManager.validateOAuthClient returns false for unknown clientId', async () => {
  const auth = makeAuth();
  assert.equal(auth.validateOAuthClient('no-such-id', 'any-secret'), false);
});

test('AuthManager.getOAuthClient retrieves the client by clientId', async () => {
  const auth = makeAuth();
  const client = await auth.createOAuthClient('chatgpt', 'ChatGPT');
  const found = auth.getOAuthClient(client.clientId);
  assert.equal(found?.clientId, client.clientId);
  assert.equal(found?.clientSecret, client.clientSecret);
});

test('AuthManager.getOAuthClient returns undefined for unknown clientId', () => {
  const auth = makeAuth();
  assert.equal(auth.getOAuthClient('no-such-id'), undefined);
});

test('AuthManager.listOAuthClients masks client secrets', async () => {
  const auth = makeAuth();
  const client = await auth.createOAuthClient('chatgpt', 'ChatGPT');
  const list = auth.listOAuthClients();
  assert.equal(list.length, 1);
  assert.equal(list[0].clientId, client.clientId);
  assert.notEqual(list[0].clientSecret, client.clientSecret);
  assert.equal(list[0].clientSecret, '******');
});

test('AuthManager manages multiple OAuth clients independently', async () => {
  const auth = makeAuth();
  const a = await auth.createOAuthClient('app-a', 'App A');
  const b = await auth.createOAuthClient('app-b', 'App B');
  assert.equal(auth.validateOAuthClient(a.clientId, a.clientSecret), true);
  assert.equal(auth.validateOAuthClient(b.clientId, b.clientSecret), true);
  // Cross-credential validation must fail
  assert.equal(auth.validateOAuthClient(a.clientId, b.clientSecret), false);
  assert.equal(auth.listOAuthClients().length, 2);
});
