/**
 * Bridges to the local Desktop Commander MCP server.
 * Spawns desktop-commander as a child process and communicates via stdio MCP.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DeviceTool } from './types.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDesktopCommanderCommand(): { command: string; args: string[] } {
  // 1. Local node_modules dependency (pk-desktop-commander)
  const localDep = path.resolve(__dirname, '../node_modules/pk-desktop-commander/dist/index.js');
  if (existsSync(localDep)) {
    return { command: 'node', args: [localDep] };
  }

  // 2. Local dev build (sibling repo checkout)
  const localBuild = path.resolve(__dirname, '../../../DesktopCommanderMCP/dist/index.js');
  if (existsSync(localBuild)) {
    return { command: 'node', args: [localBuild] };
  }

  // 3. Globally installed CLI (Windows .cmd wrapper)
  const globalCmd = path.join(process.env.APPDATA || '', 'npm', 'desktop-commander.cmd');
  if (existsSync(globalCmd)) {
    return { command: globalCmd, args: [] };
  }

  // 4. Globally installed CLI (Unix or in PATH)
  try {
    execSync('desktop-commander --version', { stdio: 'ignore' });
    return { command: 'desktop-commander', args: [] };
  } catch {}

  // 5. Fall back to npx (auto-downloads)
  return { command: 'npx', args: ['-y', 'pk-desktop-commander'] };
}

export class DesktopCommanderIntegration {
  private client: Client;
  private transport?: StdioClientTransport;

  constructor() {
    this.client = new Client(
      { name: 'dc-remote-device', version: '1.0.0' },
      { capabilities: {} }
    );
  }

  async initialize(): Promise<void> {
    const { command, args } = getDesktopCommanderCommand();
    console.log(`[DC] Starting Desktop Commander: ${command} ${args.join(' ')}`);

    this.transport = new StdioClientTransport({ command, args });
    await this.client.connect(this.transport);
    console.log('[DC] Connected to local Desktop Commander');
  }

  async listTools(): Promise<DeviceTool[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as DeviceTool['inputSchema']) ?? { type: 'object' },
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    _metadata?: Record<string, unknown>
  ): Promise<unknown> {
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
