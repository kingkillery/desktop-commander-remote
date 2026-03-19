#!/usr/bin/env node
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DeviceRegistry } from './device-registry.js';
import { AuthManager } from './auth.js';
import { HubMessage } from './types.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : null;
// Single-port mode: WS_PORT not set → WebSocket attaches to HTTP server (required for Cloud Run)
const SINGLE_PORT = WS_PORT === null || WS_PORT === PORT;

const registry = new DeviceRegistry();
const auth = new AuthManager();

// ─── Express (MCP over SSE) ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health / status endpoint
app.get('/health', (_req, res) => {
  const devices = registry.getAll();
  res.json({
    status: 'ok',
    version: '1.0.0',
    devices: devices.map((d) => ({
      id: d.deviceId,
      name: d.deviceName,
      tools: d.tools.length,
      connectedAt: d.connectedAt,
    })),
  });
});

// ─── Simple REST API for MCP Client ───────────────────────────────────────
// These endpoints provide a simpler alternative to the MCP/JSON-RPC protocol

// Get all tools from all devices
app.get('/tools', (req, res) => {
  const apiKey = req.headers.authorization?.replace('Bearer ', '');
  if (!apiKey || !auth.validate(apiKey)) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const tools = registry.getAllTools();
  res.json(tools);
});

// Call a tool on a specific device
app.post('/tools/:toolName', async (req, res) => {
  const apiKey = req.headers.authorization?.replace('Bearer ', '');
  if (!apiKey || !auth.validate(apiKey)) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const { toolName } = req.params;
  const args = req.body || {};

  try {
    const result = await registry.callTool(toolName, args);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// OAuth configuration endpoint - returns client_id for ChatGPT setup
app.get('/oauth/info', (_req, res) => {
  const clients = auth.listOAuthClients();
  if (clients.length === 0) {
    res.status(500).json({ error: 'No OAuth clients configured' });
    return;
  }
  const client = clients[0];
  res.json({
    clientId: client.clientId,
    authUrl: `https://hub.pkking.computer/oauth/authorize`,
    tokenUrl: `https://hub.pkking.computer/oauth/token`,
  });
});

// ─── OAuth 2.0 Endpoints (for ChatGPT MCP) ───────────────────────────────────────

// CORS headers for OAuth
app.use('/oauth', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Authorization endpoint - returns a simple success page that redirects back
app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state } = req.query;

  console.log('[OAuth] Authorize request:', { client_id, redirect_uri, response_type });

  // Validate client_id (accept any known client)
  let client = null;
  if (client_id) {
    client = auth.getOAuthClient(client_id as string);
  }

  // If no valid client, create a temporary one or accept anyway
  if (!client) {
    console.warn('[OAuth] Unknown client_id, allowing anyway:', client_id);
  }

  // For self-hosted, auto-approve and redirect back
  // In production, you'd show a consent page here
  const redirectUrl = new URL(redirect_uri as string || 'https://chat.openai.com');
  redirectUrl.searchParams.set('code', 'auto_approved');
  if (state) redirectUrl.searchParams.set('state', state as string);

  // Simple HTML that auto-redirects
  res.send(`<!DOCTYPE html>
<html>
<head><title>Authorized</title></head>
<body>
<p>Authorized! Redirecting...</p>
<script>window.location.href = "${redirectUrl.toString()}";</script>
</body>
</html>`);
});

// Token endpoint - exchange code for access token
app.post('/oauth/token', (req, res) => {
  const { grant_type, client_id, client_secret, code, redirect_uri } = req.body;

  console.log('[OAuth] Token request:', { grant_type, client_id, code });

  // Validate client credentials (be permissive for now)
  const validClient = auth.validateOAuthClient(client_id, client_secret);
  if (!validClient) {
    // Try accepting any client_secret for development
    const keys = auth.listKeys();
    keys.then(apiKeys => {
      if (apiKeys.length > 0) {
        // Accept any valid client for now
        res.json({
          access_token: apiKeys[0].key,
          token_type: 'bearer',
          expires_in: 3600,
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
  // The code "auto_approved" maps to the default API key
  const accessToken = auth.listKeys().then(keys => keys[0]?.key || 'default');

  accessToken.then(token => {
    res.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
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

app.get('/sse', (req, res) => {
  // Require API key for SSE connections
  if (!validateApiKey(req)) {
    res.status(401).json({ error: 'Invalid or missing API key. Add ?api_key=YOUR_KEY to the URL.' });
    return;
  }

  const clientId = req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || 'unknown';
  console.log(`[MCP] AI client connected: ${clientId}`);

  const transport = new SSEServerTransport('/messages', res);

  // Store transport using the MCP SDK's session ID immediately
  sseTransports.set(transport.sessionId, transport);
  console.log(`[MCP] Session stored: ${transport.sessionId}`);

  const mcpServer = buildMcpServer();
  mcpServer.connect(transport).catch((err) => {
    console.error('[MCP] Server connect error:', err);
  });

  res.on('close', () => {
    sseTransports.delete(transport.sessionId);
    console.log(`[MCP] AI client disconnected: ${clientId}`);
  });
});

app.post('/messages', async (req, res) => {
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
    await transport.handlePostMessage(req, res);
    console.log(`[MCP] handlePostMessage completed`);
  } catch (err: any) {
    console.error(`[MCP] handlePostMessage error:`, err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'desktop-commander-remote', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registry.getAllTools();
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await registry.callTool(name, (args ?? {}) as Record<string, unknown>);
      // result is whatever the device returned (MCP tool result format)
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

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
