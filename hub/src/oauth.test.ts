import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedRedirectUri } from './oauth.js';

test('accepts allowed OAuth redirect hosts', () => {
  assert.equal(isAllowedRedirectUri('https://chat.openai.com/connector/oauth'), true);
  assert.equal(isAllowedRedirectUri('https://chatgpt.com/connector/oauth/something'), true);
  assert.equal(isAllowedRedirectUri('https://chat.com/connector/oauth'), true);
});

test('rejects disallowed OAuth redirect hosts', () => {
  assert.equal(isAllowedRedirectUri('https://example.com/callback'), false);
  assert.equal(isAllowedRedirectUri('https://evil.example.com/auth'), false);
});

test('throws on malformed OAuth redirect URI', () => {
  assert.throws(
    () => isAllowedRedirectUri('not-a-valid-url'),
    (error) => error instanceof TypeError
  );
});

test('rejects non-https redirect URIs even for allowed hosts', () => {
  assert.equal(isAllowedRedirectUri('http://chat.openai.com/connector/oauth'), false);
  assert.equal(isAllowedRedirectUri('ftp://chat.com/connector/oauth'), false);
});
