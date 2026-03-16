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

// MCP SSE endpoint — one MCP server per AI client connection
const sseTransports = new Map<string, SSEServerTransport>();

app.get('/sse', (req, res) => {
  const clientId = req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || 'unknown';
  console.log(`[MCP] AI client connected: ${clientId}`);

  const transport = new SSEServerTransport('/messages', res);
  const connectionId = Math.random().toString(36).slice(2);
  sseTransports.set(connectionId, transport);

  const mcpServer = buildMcpServer();
  mcpServer.connect(transport).catch((err) => {
    console.error('[MCP] Server connect error:', err);
  });

  res.on('close', () => {
    sseTransports.delete(connectionId);
    console.log(`[MCP] AI client disconnected: ${clientId}`);
  });
});

app.post('/messages', (req, res) => {
  // Route to the right transport by session ID in query
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  transport.handlePostMessage(req, res);
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
