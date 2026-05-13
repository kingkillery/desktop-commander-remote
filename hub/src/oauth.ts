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

export function isAllowedRedirectUri(redirectUri: string): boolean {
  const parsed = new URL(redirectUri);
  return parsed.protocol === 'https:' && OAUTH_ALLOWED_REDIRECT_HOSTS.has(parsed.hostname);
}
