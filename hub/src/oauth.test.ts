import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  getOAuthAccessTokenTtlSeconds,
  isAllowedRedirectUri,
} from './oauth.js';

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

test('defaults OAuth access token TTL to 30 days', () => {
  assert.equal(DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS, 2592000);
  assert.equal(getOAuthAccessTokenTtlSeconds(undefined), DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS);
});

test('accepts configured positive OAuth access token TTL', () => {
  assert.equal(getOAuthAccessTokenTtlSeconds('7776000'), 7776000);
});

test('falls back to default OAuth access token TTL for invalid values', () => {
  assert.equal(getOAuthAccessTokenTtlSeconds('0'), 2592000);
  assert.equal(getOAuthAccessTokenTtlSeconds('-1'), 2592000);
  assert.equal(getOAuthAccessTokenTtlSeconds('not-a-number'), 2592000);
});
