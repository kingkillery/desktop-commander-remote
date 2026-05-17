export const OAUTH_ALLOWED_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://chat.com',
]);

export const OAUTH_ALLOWED_REDIRECT_HOSTS = new Set([
  'chat.openai.com',
  'chatgpt.com',
  'chat.com',
]);

export const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export function isAllowedRedirectUri(redirectUri: string): boolean {
  const parsed = new URL(redirectUri);
  return parsed.protocol === 'https:' && OAUTH_ALLOWED_REDIRECT_HOSTS.has(parsed.hostname);
}

export function getOAuthAccessTokenTtlSeconds(value = process.env.OAUTH_ACCESS_TOKEN_TTL_SECONDS): number {
  if (!value) return DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS;

  return parsed;
}
