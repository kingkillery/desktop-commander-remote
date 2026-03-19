#!/usr/bin/env node
/**
 * Desktop Commander Remote MCP Client - Direct HTTP Implementation
 *
 * This MCP client connects to the Desktop Commander Remote Hub
 * and exposes its tools via stdio (Claude Code standard).
 *
 * Usage:
 *   node index.js <hub-url> <api-key>
 *
 * Environment:
 *   DC_HUB_URL      - Hub URL (default: http://100.71.124.50:3000)
 *   DC_HUB_API_KEY - API key (required)
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import readline from 'readline';

const JSONRPC_VERSION = '2.0';

class HubMcpClient {
  constructor(hubUrl, apiKey) {
    this.hubUrl = new URL(hubUrl);
    this.apiKey = apiKey;
    this.http = this.hubUrl.protocol === 'https:' ? https : http;
  }

  // Get tools list from hub via HTTP POST to /mcp/tools
  async listTools() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hubUrl.hostname,
        port: this.hubUrl.port || (this.hubUrl.protocol === 'https:' ? 443 : 80),
        path: '/tools',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + this.apiKey
        }
      };

      const req = this.http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const tools = JSON.parse(data);
            resolve(tools);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  // Call a tool on the hub
  async callTool(name, args) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ name, args });

      const options = {
        hostname: this.hubUrl.hostname,
        port: this.hubUrl.port || (this.hubUrl.protocol === 'https:' ? 443 : 80),
        path: '/tools/' + name,
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = this.http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

// Get config from args or env
const hubUrl = process.argv[2] || process.env.DC_HUB_URL || 'http://100.71.124.50:3000';
const apiKey = process.argv[3] || process.env.DC_HUB_API_KEY;

if (!apiKey) {
  console.error('Error: API key required');
  console.error('Usage: node index.js <hub-url> <api-key>');
  console.error('Or set DC_HUB_API_KEY environment variable');
  process.exit(1);
}

console.error('[Hub MCP Client] Desktop Commander Remote');
console.error('[Hub] Connecting to:', hubUrl);

const hub = new HubMcpClient(hubUrl, apiKey);

// MCP stdio protocol
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let requestBuffer = '';
let initialized = false;
let toolsCache = [];

// Process each line as an MCP request
rl.on('line', async (line) => {
  requestBuffer += line;

  try {
    const request = JSON.parse(requestBuffer);
    requestBuffer = '';

    const { id, method } = request;

    // Initialize
    if (method === 'initialize') {
      initialized = true;
      const response = {
        jsonrpc: JSONRPC_VERSION,
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'desktop-commander-remote', version: '1.0.0' }
        }
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }

    // Ping
    if (method === 'ping') {
      const response = { jsonrpc: JSONRPC_VERSION, id, result: null };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }

    // Notifications don't need response
    if (method.startsWith('notifications/')) {
      return;
    }

    // Tools list - use simplified endpoint
    if (method === 'tools/list') {
      try {
        // Try the direct tools endpoint first
        const tools = await hub.listTools();
        toolsCache = tools;

        const response = {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: { tools: toolsCache }
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (err) {
        // Fallback: return empty tools if hub doesn't support /tools endpoint
        console.error('[Hub] Tools endpoint error:', err.message);
        const response = {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: { tools: [] }
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      }
      return;
    }

    // Tools call - simplified
    if (method === 'tools/call') {
      const { name, arguments: args } = request.params || {};
      try {
        const result = await hub.callTool(name, args || {});
        const response = {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: result || { content: [{ type: 'text', text: 'ok' }] }
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (err) {
        const response = {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: { content: [{ type: 'text', text: `Error: ${err.message}`, isError: true }] }
        };
        process.stdout.write(JSON.stringify(response) + '\n');
      }
      return;
    }

    // Unknown method
    const response = {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
    process.stdout.write(JSON.stringify(response) + '\n');

  } catch (e) {
    // Wait for more data
  }
});

console.error('[Hub] Ready for requests');
