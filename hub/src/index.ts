#!/usr/bin/env node
import express from 'express';
import { createServer } from 'http';
import { pathToFileURL } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DeviceRegistry } from './device-registry.js';
import { HubJobRegistry } from './job-registry.js';
import { AuthManager } from './auth.js';
import { HubMessage, JobStartArgs } from './types.js';
import { CliMcpRegistry } from './cli-mcp-adapter.js';
import { isAllowedRedirectUri, OAUTH_ALLOWED_ORIGINS } from './oauth.js';
import { getJobTools, validateJobStartArgs } from './job-tools.js';
import { getDirectoryTools, isDirectoryTool } from './directory-tools.js';
import {
  getDefaultApprovedDirectory,
  getDirectoryRoots,
  requireApprovedCwd,
  sanitizeExecutionArgs,
  validateDirectoryPath,
} from './directory-policy.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : null;
// Single-port mode: WS_PORT not set → WebSocket attaches to HTTP server (required for Cloud Run)
const SINGLE_PORT = WS_PORT === null || WS_PORT === PORT;

const registry = new DeviceRegistry();
const jobs = new HubJobRegistry();
const auth = new AuthManager();
const cliRegistry = new CliMcpRegistry();

// ─── Security: Rate Limiting ───────────────────────────────────────────────────
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
const oauthRateLimiter = new SimpleRateLimiter();
const sseRateLimiter = new SimpleRateLimiter();

function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const OAUTH_USERNAME = process.env.OAUTH_USERNAME;
const OAUTH_PASSWORD = process.env.OAUTH_PASSWORD;
const OAUTH_ENABLED = !!(OAUTH_USERNAME && OAUTH_PASSWORD);
const PUBLIC_BASE_PATH = getPublicBasePath();

// ─── Express (MCP over SSE) ───────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
// Body parsers — applied only to routes that need them.
// /messages must NOT be parsed (MCP SDK reads raw stream).
const jsonParser = express.json();
const urlencodedParser = express.urlencoded({ extended: true });

app.use('/oauth', jsonParser);
app.use('/oauth', urlencodedParser);
app.use('/tools', jsonParser);

function getPublicUrl(req?: express.Request): string {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL;
  }

  if (!req?.headers.host) {
    return `http://localhost:${PORT}`;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol =
    typeof forwardedProto === 'string'
      ? forwardedProto.split(',')[0].trim()
      : req.protocol;

  return `${protocol}://${req.headers.host}`;
}

function getPublicBasePath(): string {
  if (!process.env.PUBLIC_URL) return '';
  try {
    const pathname = new URL(process.env.PUBLIC_URL).pathname.replace(/\/+$/, '');
    return pathname === '/' ? '' : pathname;
  } catch {
    return '';
  }
}

// Health / status endpoint
app.get('/health', (_req, res) => {
  const devices = registry.getAll();
  const cliAdapters = cliRegistry.getAllAdapters().map(a => ({
    name: a.config.name,
    status: a.status,
    tools: a.tools.length,
    error: a.lastError,
  }));
  res.json({
    status: 'ok',
    version: '1.0.0',
    devices: devices.map((d) => ({
      id: d.deviceId,
      name: d.deviceName,
      tools: d.tools.length,
      connectedAt: d.connectedAt,
    })),
    cliAdapters,
  });
});

// OAuth discovery endpoint (required by ChatGPT MCP)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const publicUrl = getPublicUrl(req);
  res.json({
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported: ['tools'],
  });
});

// ─── Simple REST API for MCP Client ───────────────────────────────────────
// These endpoints provide a simpler alternative to the MCP/JSON-RPC protocol

const restRateLimiter = new SimpleRateLimiter();

function getBearerApiKey(req: express.Request): string | undefined {
  return req.headers.authorization?.replace('Bearer ', '');
}

function requireRestApiKey(req: express.Request, res: express.Response, label: string): boolean {
  const clientIp = getClientIp(req);
  const apiKey = getBearerApiKey(req);
  if (!apiKey || !auth.validate(apiKey)) {
    console.warn(`[REST] Rejected ${label} from ${clientIp}: invalid API key`);
    res.status(401).json({ error: 'Invalid API key' });
    return false;
  }
  return true;
}

// Get all tools from all devices
app.get('/tools', (req, res) => {
  const clientIp = getClientIp(req);
  if (!restRateLimiter.isAllowed(`rest:${clientIp}`, 60, 60000)) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }

  if (!requireRestApiKey(req, res, '/tools')) return;

  const tools = registry.getAllTools();
  res.json(tools);
});

// Call a tool on a specific device
app.post('/tools/:toolName', async (req, res) => {
  const clientIp = getClientIp(req);
  if (!restRateLimiter.isAllowed(`tool:${clientIp}`, 60, 60000)) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }

  if (!requireRestApiKey(req, res, 'tool call')) return;

  const { toolName } = req.params;
  console.log(`[REST] Tool call from ${clientIp}: ${toolName}`);

  try {
    const args = sanitizeExecutionArgs(toolName, req.body || {});
    const result = await registry.callTool(toolName, args);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/jobs', (req, res) => {
  const clientIp = getClientIp(req);
  if (!restRateLimiter.isAllowed(`jobs:${clientIp}`, 60, 60000)) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  if (!requireRestApiKey(req, res, '/jobs')) return;
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
  res.json(jobs.list(deviceId));
});

app.get('/jobs/:jobId', (req, res) => {
  if (!requireRestApiKey(req, res, '/jobs/:jobId')) return;
  const summary = jobs.get(req.params.jobId);
  if (!summary) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(summary);
});

app.get('/jobs/:jobId/events', (req, res) => {
  if (!requireRestApiKey(req, res, '/jobs/:jobId/events')) return;
  res.json(jobs.events(req.params.jobId));
});

app.post('/jobs/start', async (req, res) => {
  const clientIp = getClientIp(req);
  if (!restRateLimiter.isAllowed(`job-start:${clientIp}`, 30, 60000)) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  if (!requireRestApiKey(req, res, '/jobs/start')) return;
  try {
    const { deviceId, ...jobArgs } = req.body as JobStartArgs & { deviceId?: string };
    validateJobStartArgs(jobArgs);
    jobArgs.cwd = requireApprovedCwd(jobArgs);
    const result = await registry.sendJobStart(jobArgs, deviceId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/jobs/:jobId/cancel', async (req, res) => {
  if (!requireRestApiKey(req, res, '/jobs/:jobId/cancel')) return;
  try {
    const result = await registry.sendJobCancel(req.params.jobId, req.body?.deviceId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// OAuth configuration endpoint - returns client_id for ChatGPT setup
app.get('/oauth/info', (req, res) => {
  const clients = auth.listOAuthClients();
  if (clients.length === 0) {
    res.status(500).json({ error: 'No OAuth clients configured' });
    return;
  }
  const client = clients[0];
  const publicUrl = getPublicUrl(req);
  res.json({
    clientId: client.clientId,
    authUrl: `${publicUrl}/oauth/authorize`,
    tokenUrl: `${publicUrl}/oauth/token`,
  });
});

// ─── OAuth 2.0 Endpoints (for ChatGPT MCP) ───────────────────────────────────────

// CORS headers — needed for ChatGPT web frontend to reach SSE and /messages
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && OAUTH_ALLOWED_ORIGINS.has(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!OAUTH_ENABLED) {
    // Local/dev mode: allow any origin
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Authorization endpoint — password-gated when CONSENT_PASSWORD is set
app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state } = req.query;
  const clientIp = getClientIp(req);

  console.log(`[OAuth] Authorize request from ${clientIp}:`, { client_id, redirect_uri, response_type });

  // Rate limit
  if (!oauthRateLimiter.isAllowed(`auth:${clientIp}`, 10, 60000)) {
    res.status(429).send('<h1>429 Too Many Requests</h1><p>Please try again later.</p>');
    return;
  }

  // Validate client_id (accept any known client)
  let client = null;
  if (client_id) {
    client = auth.getOAuthClient(client_id as string);
  }
  if (!client) {
    console.warn('[OAuth] Unknown client_id, allowing anyway:', client_id);
  }

  // Validate redirect_uri
  const finalRedirectUri = redirect_uri as string || 'https://chat.openai.com';
  try {
    if (!isAllowedRedirectUri(finalRedirectUri)) {
      console.warn('[OAuth] Rejected invalid redirect_uri host:', new URL(finalRedirectUri).hostname);
      res.status(400).send('<h1>400 Bad Request</h1><p>Invalid redirect URI.</p>');
      return;
    }
  } catch {
    console.warn('[OAuth] Invalid redirect_uri:', finalRedirectUri);
    res.status(400).send('<h1>400 Bad Request</h1><p>Invalid redirect URI.</p>');
    return;
  }

  // Generate a unique authorization code
  const authCode = 'auth_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  // Store code with metadata (simple in-memory; restart clears it)
  if (!(globalThis as any).oauthCodes) {
    (globalThis as any).oauthCodes = new Map();
  }
  (globalThis as any).oauthCodes.set(authCode, {
    client_id: client_id as string,
    redirect_uri: finalRedirectUri,
    state: state as string,
    createdAt: Date.now(),
  });

  // Auto-approve and redirect (login form breaks ChatGPT popup flow)
  const redirectUrl = new URL(finalRedirectUri);
  redirectUrl.searchParams.set('code', authCode);
  if (state) redirectUrl.searchParams.set('state', state as string);

  res.redirect(redirectUrl.toString());
});

// OAuth approval POST handler (kept for backwards compatibility; now auto-approves in GET)
app.post('/oauth/approve', (req, res) => {
  const { username, password, return_url } = req.body;
  if (OAUTH_ENABLED && (username !== OAUTH_USERNAME || password !== OAUTH_PASSWORD)) {
    res.status(403).send('<h1>403 Forbidden</h1><p>Invalid username or password. <a href="/oauth/authorize">Try again</a></p>');
    return;
  }

  if (!return_url || typeof return_url !== 'string') {
    res.status(400).send('<h1>400 Bad Request</h1><p>Missing return URL.</p>');
    return;
  }

  let decodedReturnUrl = return_url;
  try {
    decodedReturnUrl = decodeURIComponent(return_url);
  } catch (error) {
    console.warn('[OAuth] Failed to decode return_url, using raw value', error);
  }

  let url: URL;
  try {
    url = new URL(decodedReturnUrl, `http://${req.headers.host}`);
  } catch {
    console.warn('[OAuth] Invalid return_url:', return_url);
    res.status(400).send('<h1>400 Bad Request</h1><p>Invalid return URL.</p>');
    return;
  }
  const redirect_uri = url.searchParams.get('redirect_uri') || 'https://chat.openai.com';
  const state = url.searchParams.get('state');

  try {
    if (!isAllowedRedirectUri(redirect_uri)) {
      console.warn('[OAuth] Rejected invalid redirect_uri host:', new URL(redirect_uri).hostname);
      res.status(400).send('<h1>400 Bad Request</h1><p>Invalid redirect URI.</p>');
      return;
    }
  } catch {
    console.warn('[OAuth] Invalid redirect_uri:', redirect_uri);
    res.status(400).send('<h1>400 Bad Request</h1><p>Invalid redirect URI.</p>');
    return;
  }

  const authCode = 'auth_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  if (!(globalThis as any).oauthCodes) {
    (globalThis as any).oauthCodes = new Map();
  }
  (globalThis as any).oauthCodes.set(authCode, {
    redirect_uri,
    state,
    createdAt: Date.now(),
  });


  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', authCode);
  if (state) redirectUrl.searchParams.set('state', state);

  res.redirect(redirectUrl.toString());
});

// Token endpoint - exchange code for access token
app.post('/oauth/token', (req, res) => {
  const clientIp = getClientIp(req);
  if (!oauthRateLimiter.isAllowed(`token:${clientIp}`, 10, 60000)) {
    res.status(429).json({ error: 'too_many_requests' });
    return;
  }

  const { grant_type, client_id, client_secret, code, redirect_uri } = req.body;
  console.log(`[OAuth] Token request from ${clientIp}:`, { grant_type, client_id, code });

  // Validate authorization code
  const oauthCodes = (globalThis as any).oauthCodes;
  if (!oauthCodes || !oauthCodes.has(code)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
    return;
  }

  const codeData = oauthCodes.get(code);
  // Codes expire after 10 minutes
  if (Date.now() - codeData.createdAt > 10 * 60 * 1000) {
    oauthCodes.delete(code);
    res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
    return;
  }

  // Validate redirect_uri matches what was used in authorize
  if (redirect_uri && redirect_uri !== codeData.redirect_uri) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    return;
  }

  // Mark code as used (single-use)
  oauthCodes.delete(code);

  // Validate client credentials (be permissive for now)
  const validClient = auth.validateOAuthClient(client_id, client_secret);
  if (!validClient) {
    // Try accepting any client_secret for development
    const keys = auth.listKeys();
    keys.then(apiKeys => {
      if (apiKeys.length > 0) {
        res.json({
          access_token: apiKeys[0].key,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'tools',
        });
      } else {
        res.status(401).json({ error: 'invalid_client' });
      }
    });
    return;
  }

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  // In simple mode: access token is the API key
  const accessToken = auth.listKeys().then(keys => keys[0]?.key || 'default');

  accessToken.then(token => {
    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'tools',
    });
  });
});

// ─── MCP SSE Endpoint (with Bearer token support) ───────────────────────────────

// MCP SSE endpoint — one MCP server per AI client connection
const sseTransports = new Map<string, SSEServerTransport>();

// API key / Bearer token validation for SSE endpoint
function validateApiKey(req: express.Request): boolean {
  // Check query param
  const queryKey = req.query.api_key as string;
  if (queryKey && auth.validate(queryKey)) return true;

  // Check x-api-key header
  const headerKey = req.headers['x-api-key'] as string;
  if (headerKey && auth.validate(headerKey)) return true;

  // Check Authorization: Bearer <token>
  const authHeader = req.headers['authorization'] as string;
  if (authHeader?.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7);
    if (auth.validateAccessToken(bearerToken)) return true;
  }

  return false;
}

const ssePaths = PUBLIC_BASE_PATH ? ['/sse', `${PUBLIC_BASE_PATH}/sse`] : ['/sse'];
const messagePaths = PUBLIC_BASE_PATH ? ['/messages', `${PUBLIC_BASE_PATH}/messages`] : ['/messages'];

app.get(ssePaths, (req, res) => {
  const clientIp = getClientIp(req);

  // Rate limit SSE connections
  if (!sseRateLimiter.isAllowed(`sse:${clientIp}`, 10, 60000)) {
    res.status(429).json({ error: 'Too many connection attempts. Please try again later.' });
    return;
  }

  // Require API key for SSE connections
  if (!validateApiKey(req)) {
    console.warn(`[MCP] Rejected SSE connection from ${clientIp}: invalid API key`);
    const publicUrl = getPublicUrl(req);
    res.status(401)
      .header('WWW-Authenticate', `Bearer realm="desktop-commander-remote", authorization_uri="${publicUrl}/oauth/authorize", token_uri="${publicUrl}/oauth/token"`)
      .json({ error: 'Invalid or missing API key.' });
    return;
  }

  console.log(`[MCP] AI client connected: ${clientIp}`);

  const endpoint = PUBLIC_BASE_PATH && req.path.startsWith(`${PUBLIC_BASE_PATH}/`)
    ? `${PUBLIC_BASE_PATH}/messages`
    : '/messages';
  const transport = new SSEServerTransport(endpoint, res);

  // Store transport using the MCP SDK's session ID immediately
  sseTransports.set(transport.sessionId, transport);
  console.log(`[MCP] Session stored: ${transport.sessionId}`);

  const mcpServer = buildMcpServer();
  mcpServer.connect(transport).catch((err) => {
    console.error('[MCP] Server connect error:', err);
  });

  res.on('close', () => {
    sseTransports.delete(transport.sessionId);
    console.log(`[MCP] AI client disconnected: ${clientIp}`);
  });
});

app.post(messagePaths, async (req, res) => {
  // Skip auth check - session ID proves authentication (was validated on /sse)
  // Route to the right transport by session ID in query
  const sessionId = req.query.sessionId as string;
  console.log(`[MCP] POST /messages, session: ${sessionId?.substring(0, 8)}...`);
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    console.log(`[MCP] Transport not found for session: ${sessionId?.substring(0, 8)}`);
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  try {
    console.log(`[MCP] Calling handlePostMessage`);
    await transport.handlePostMessage(req, res, req.body);
    console.log(`[MCP] handlePostMessage completed`);
  } catch (err: any) {
    console.error(`[MCP] handlePostMessage error:`, err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

function buildMcpServer(): McpServer {
  let selectedDirectory: string | undefined = getDefaultApprovedDirectory();

  const server = new McpServer(
    { name: 'desktop-commander-remote', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [...getDirectoryTools(), ...registry.getAllTools(), ...getJobTools()];
    const cliTools = cliRegistry.getAllTools();
    const allTools = [
      ...tools.map((t) => ({
        name: t.name,
        description: describeMcpTool(t.name, t.description),
        inputSchema: decorateMcpInputSchema(t.name, t.inputSchema),
      })),
      ...cliTools.map((t) => ({
        name: t.prefixedName,
        description: `[${t.originalName}] ${t.description}`,
        inputSchema: t.inputSchema,
      })),
    ];
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (isDirectoryTool(name)) {
        const result = await callDirectoryTool(name, (args ?? {}) as Record<string, unknown>, selectedDirectory);
        if (name === 'directory_select' && typeof result === 'object' && result && 'path' in result) {
          selectedDirectory = String((result as { path: string }).path);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      if (name.startsWith('job_')) {
        const result = await callJobTool(name, (args ?? {}) as Record<string, unknown>, selectedDirectory);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      // CLI-prefixed tools route to their own adapter (no cwd sanitization)
      const cliAdapter = cliRegistry.getAdapterForTool(name);
      if (cliAdapter) {
        const result = await cliAdapter.callTool(name, (args ?? {}) as Record<string, unknown>);
        if (result && typeof result === 'object' && 'content' in (result as object)) {
          return result as { content: unknown[] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      // Device-routed tools: enforce directory policy
      const sanitizedArgs = sanitizeExecutionArgs(name, (args ?? {}) as Record<string, unknown>, selectedDirectory);
      const result = await registry.callTool(name, sanitizedArgs);
      if (result && typeof result === 'object' && 'content' in (result as object)) {
        return result as { content: unknown[] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

function describeMcpTool(name: string, description: string): string {
  if (isCommandToolName(name)) {
    return `${description} Requires an approved cwd or a prior directory_select call.`;
  }
  return description;
}

function decorateMcpInputSchema(name: string, inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] }) {
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

function isCommandToolName(name: string): boolean {
  return name === 'execute_command' || name === 'start_process' || name.endsWith('_execute_command') || name.endsWith('_start_process');
}

async function callDirectoryTool(
  name: string,
  args: Record<string, unknown>,
  selectedDirectory?: string
): Promise<unknown> {
  if (name === 'directory_roots') {
    return {
      roots: getDirectoryRoots(),
      selected: selectedDirectory ? validateDirectoryPath(selectedDirectory) : undefined,
    };
  }
  if (name === 'directory_current') {
    return {
      selected: selectedDirectory ? validateDirectoryPath(selectedDirectory) : undefined,
      roots: getDirectoryRoots(),
    };
  }

  const deviceId = typeof args.deviceId === 'string' ? args.deviceId : undefined;
  const targetDeviceId = registry.getDeviceIdForRequest(deviceId);
  const path = requireString(args.path, 'path');
  const approved = validateDirectoryPath(path).path;

  if (name === 'directory_list') {
    return registry.callToolOnDevice(targetDeviceId, '__directory_list', { path: approved }, undefined, 30_000);
  }
  if (name === 'directory_select') {
    return registry.callToolOnDevice(targetDeviceId, '__directory_select', { path: approved }, undefined, 30_000);
  }
  throw new Error(`Unknown directory tool: ${name}`);
}

async function callJobTool(name: string, args: Record<string, unknown>, selectedDirectory?: string): Promise<unknown> {
  const deviceId = typeof args.deviceId === 'string' ? args.deviceId : undefined;
  if (name === 'job_list') {
    return jobs.list(deviceId);
  }
  if (name === 'job_start') {
    const { deviceId: _deviceId, ...jobArgs } = args as unknown as JobStartArgs & { deviceId?: string };
    validateJobStartArgs(jobArgs);
    jobArgs.cwd = requireApprovedCwd(jobArgs, selectedDirectory);
    return registry.sendJobStart(jobArgs, deviceId);
  }
  if (name === 'job_status') {
    const jobId = requireString(args.jobId, 'jobId');
    return registry.sendJobStatus(jobId, deviceId);
  }
  if (name === 'job_tail') {
    const jobId = requireString(args.jobId, 'jobId');
    const stream = args.stream === 'stdout' || args.stream === 'stderr' || args.stream === 'both'
      ? args.stream
      : undefined;
    const bytes = typeof args.bytes === 'number' ? args.bytes : undefined;
    return registry.sendJobTail(jobId, stream, bytes, deviceId);
  }
  if (name === 'job_cancel') {
    const jobId = requireString(args.jobId, 'jobId');
    return registry.sendJobCancel(jobId, deviceId);
  }
  throw new Error(`Unknown job tool: ${name}`);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

// ─── WebSocket server (device connections) ────────────────────────────────────
// Single-port mode: attach to HTTP server (Cloud Run, behind a reverse proxy)
// Dual-port mode: separate port (Pi/local, backward compat)
const wss = SINGLE_PORT
  ? new WebSocketServer({ noServer: true })
  : new WebSocketServer({ port: WS_PORT! });

wss.on('connection', (ws: WebSocket, req) => {
  const remoteAddr = req.socket.remoteAddress;
  console.log(`[WS] Device connection from: ${remoteAddr}`);

  let deviceId: string | undefined;

  ws.on('message', (data) => {
    let msg: HubMessage;
    try {
      msg = JSON.parse(data.toString()) as HubMessage;
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (msg.type === 'register') {
      if (!auth.validate(msg.apiKey)) {
        console.warn(`[WS] Auth failed from ${remoteAddr}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid API key' }));
        ws.close();
        return;
      }
      deviceId = msg.deviceId;
      registry.register(ws, msg.deviceId, msg.deviceName, msg.tools);
      ws.send(JSON.stringify({ type: 'registered', deviceId: msg.deviceId }));
      return;
    }

    if (!deviceId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not registered' }));
      return;
    }

    if (msg.type === 'tool_result') {
      registry.resolveCall(deviceId, msg.callId, msg.result, msg.error);
      return;
    }

    if (msg.type === 'job_started') {
      if (msg.summary) {
        jobs.recordStarted(deviceId, msg.summary);
      }
      registry.resolveCall(deviceId, msg.callId, msg.summary, msg.error);
      return;
    }

    if (msg.type === 'job_result') {
      if (msg.summary) {
        jobs.recordFinal(deviceId, msg.summary, msg.error);
      }
      registry.resolveCall(deviceId, msg.callId, msg.result ?? msg.summary, msg.error);
      return;
    }

    if (msg.type === 'job_status_result') {
      if (msg.summary) {
        jobs.recordFinal(deviceId, msg.summary, msg.error);
      }
      registry.resolveCall(deviceId, msg.callId, msg.result ?? msg.summary, msg.error);
      return;
    }

    if (msg.type === 'job_event') {
      jobs.recordEvent(deviceId, msg.event, msg.summary);
      return;
    }

    if (msg.type === 'heartbeat') {
      ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
      return;
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      registry.remove(deviceId);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for device ${deviceId}:`, err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  await auth.load();

  const httpServer = createServer(app);

  // Single-port mode: forward HTTP upgrade requests to WSS
  if (SINGLE_PORT) {
    httpServer.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket as any, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
  }

  // Register CLI MCP adapters (Codex, Claude, Gemini)
  // Use full paths or CLI_*_PATH env vars since launchd has a restricted PATH
  if (process.env.CLI_CODEX_ENABLED === 'true') {
    cliRegistry.register({
      name: 'codex',
      command: process.env.CLI_CODEX_PATH || '/opt/homebrew/bin/codex',
      args: ['mcp-server'],
      enabled: true,
    });
  }
  if (process.env.CLI_CLAUDE_ENABLED === 'true') {
    cliRegistry.register({
      name: 'claude',
      command: process.env.CLI_CLAUDE_PATH || '/opt/homebrew/bin/claude',
      args: ['mcp', 'serve'],
      enabled: true,
    });
  }
  await cliRegistry.startAll();

  httpServer.listen(PORT, '0.0.0.0', () => {
    const wsAddr = SINGLE_PORT ? `ws://0.0.0.0:${PORT}` : `ws://0.0.0.0:${WS_PORT}`;
    console.log(`\nDesktop Commander Hub running:`);
    console.log(`  MCP SSE:  http://0.0.0.0:${PORT}/sse`);
    console.log(`  Health:   http://0.0.0.0:${PORT}/health`);
    console.log(`  Devices:  ${wsAddr}`);
    if (SINGLE_PORT) {
      console.log(`  (single-port mode — WebSocket shares HTTP server)`);
    }
    console.log(`\n  Connect AI clients to: http://<host>:${PORT}/sse`);
    console.log(`  Start device client with DC_HUB_URL=${wsAddr}\n`);
  });

  if (!SINGLE_PORT) {
    wss.on('listening', () => {
      console.log(`[WS] Device WebSocket server listening on :${WS_PORT}`);
    });
  }

  process.on('SIGINT', () => {
    console.log('\nShutting down hub...');
    wss.close();
    httpServer.close();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
