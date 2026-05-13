import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface CliMcpConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface DiscoveredTool {
  originalName: string;
  prefixedName: string;
  description: string;
  inputSchema: unknown;
}

export class CliMcpAdapter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  public tools: DiscoveredTool[] = [];
  public readonly config: CliMcpConfig;
  private connected = false;
  public lastError?: string;

  constructor(config: CliMcpConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log(`[CLI-MCP] ${this.config.name} is disabled, skipping`);
      return;
    }

    console.log(`[CLI-MCP] Starting ${this.config.name}: ${this.config.command} ${this.config.args.join(' ')}`);

    try {
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args,
        env: this.config.env,
        stderr: 'inherit',
      });

      this.client = new Client(
        { name: `hub-${this.config.name}`, version: '1.0.0' },
        { capabilities: {} }
      );

      await this.client.connect(this.transport);

      const toolsResult = await this.client.listTools();
      this.tools = (toolsResult.tools || []).map((t: any) => ({
        originalName: t.name,
        prefixedName: `${this.config.name}_${t.name}`,
        description: t.description || '',
        inputSchema: t.inputSchema || {},
      }));

      this.connected = true;
      console.log(`[CLI-MCP] ${this.config.name} ready with ${this.tools.length} tools`);
    } catch (err: any) {
      this.lastError = err.message;
      console.error(`[CLI-MCP] Failed to start ${this.config.name}:`, err.message);
    }
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client || !this.connected) {
      throw new Error(`${this.config.name} MCP server not connected`);
    }

    const tool = this.tools.find(t => t.prefixedName === prefixedName);
    if (!tool) {
      throw new Error(`Tool ${prefixedName} not found in ${this.config.name}`);
    }

    return this.client.callTool({
      name: tool.originalName,
      arguments: args,
    });
  }

  async stop(): Promise<void> {
    try {
      if (this.transport) {
        await this.transport.close();
      }
    } catch (err: any) {
      console.error(`[CLI-MCP] Error stopping ${this.config.name}:`, err.message);
    }
    this.connected = false;
    this.client = null;
    this.transport = null;
    this.tools = [];
    console.log(`[CLI-MCP] ${this.config.name} stopped`);
  }

  get status(): 'running' | 'stopped' | 'error' {
    if (this.connected && this.client) return 'running';
    if (!this.config.enabled) return 'stopped';
    if (this.lastError) return 'error';
    return 'stopped';
  }
}

export class CliMcpRegistry {
  private adapters = new Map<string, CliMcpAdapter>();

  register(config: CliMcpConfig): void {
    this.adapters.set(config.name, new CliMcpAdapter(config));
  }

  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  getAllTools(): DiscoveredTool[] {
    const tools: DiscoveredTool[] = [];
    for (const adapter of this.adapters.values()) {
      tools.push(...adapter.tools);
    }
    return tools;
  }

  getAdapterForTool(prefixedName: string): CliMcpAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.tools.some(t => t.prefixedName === prefixedName)) {
        return adapter;
      }
    }
    return undefined;
  }

  getAllAdapters(): CliMcpAdapter[] {
    return Array.from(this.adapters.values());
  }
}


