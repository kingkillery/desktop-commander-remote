import WebSocket from 'ws';
import os from 'os';
import { randomUUID } from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import { DesktopCommanderIntegration } from './dc-integration.js';
import { HubMessage, DeviceMessage } from './types.js';
import { DeviceJobManager } from './job-manager.js';
import {
  getDirectoryRoots,
  listApprovedChildDirectories,
  prepareDesktopCommanderArgs,
  validateDirectoryPath,
} from './directory-policy.js';
import { executeSearchFiles } from './search-tool.js';

const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15000;
const READ_MULTIPLE_FILES_BATCH_SIZE = Math.min(
  Math.max(1, Math.floor(Number(process.env.READ_MULTIPLE_FILES_BATCH_SIZE || 5))),
  20
);

export class DeviceClient {
  private hubUrl: string;
  private apiKey: string;
  private deviceId: string;
  private deviceName: string;
  private dc: DesktopCommanderIntegration;
  private jobs: DeviceJobManager;
  private ws?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private isShuttingDown = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.hubUrl = process.env.DC_HUB_URL || 'ws://localhost:3001';
    this.apiKey = process.env.DC_HUB_API_KEY || '';
    this.deviceId = process.env.DC_DEVICE_ID || randomUUID();
    this.deviceName = process.env.DC_DEVICE_NAME || os.hostname();
    this.dc = new DesktopCommanderIntegration();
    this.jobs = new DeviceJobManager();
    this.jobs.onEvent((event, summary) => {
      this.ws?.send(JSON.stringify({ type: 'job_event', event, summary } satisfies HubMessage));
    });

    if (!this.apiKey) {
      console.error('❌ DC_HUB_API_KEY environment variable is required');
      process.exit(1);
    }
  }

  async start() {
    console.log('🚀 Desktop Commander Remote Device starting...');
    console.log(`   Hub URL:     ${this.hubUrl}`);
    console.log(`   Device ID:   ${this.deviceId}`);
    console.log(`   Device Name: ${this.deviceName}`);

    // Initialize local Desktop Commander connection
    await this.dc.initialize();

    // List tools once to validate connection
    const dcTools = await this.dc.listTools();

    // Add native device tools (not provided by Desktop Commander)
    const nativeTools: typeof dcTools = [
      {
        name: 'search_files',
        description:
          'Ultra-fast file search using Voidtools Everything (es.exe). This is the PRIMARY and PREFERRED way to locate files, ' +
          'discover project structures, and gather information across the system. It searches filenames and paths instantly. ' +
          'Use this BEFORE directory_list when looking for specific files or exploring unknown locations. ' +
          'Supports Everything query syntax (wildcards, booleans, path filters).',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Everything search query. Examples: "*.md", "report 2025", "src\\*.ts", "path:projects invoice"',
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of results to return (default 50, max 200).',
            },
            path: {
              type: 'string',
              description:
                'Optional approved directory path to restrict results to (e.g., C:\\dev or C:\\Users\\prest).',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'ix_agent',
        description:
          'Executes browser automation tasks using the local IX Bridge Chrome/Edge extension. ' +
          'Use this for any browser tasks such as navigation, screenshots, clicking, typing, file upload, or DOM inspection. ' +
          'Requires the browser extension to be loaded and active.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'The browser tool action to execute.',
              enum: [
                'navigate',
                'find_tab',
                'snapshot',
                'click',
                'fill',
                'evaluate',
                'network',
                'mouse_click',
                'cdp',
                'key_type',
                'send_keys',
                'screenshot',
                'save_as_pdf',
                'upload',
                'list_tabs',
                'close_tab',
                'close_session',
                'wait',
                'highlight',
                'capture_trace',
              ],
            },
            args: {
              type: 'object',
              description: 'Arguments required for the selected action (e.g. { url: "..." } for navigate, { selector: "..." } for click).',
            },
            session: {
              type: 'string',
              description: 'Optional stable session name to group tabs (e.g., "demo", "teams", "github").',
            },
          },
          required: ['action'],
        },
      },
    ];

    const tools = [...this.decorateDesktopCommanderTools(dcTools), ...nativeTools];
    console.log(`   Local tools: ${dcTools.length} + ${nativeTools.length} native`);

    this.setupShutdownHandlers();
    this.connect(tools);
  }

  private connect(tools: Awaited<ReturnType<DesktopCommanderIntegration['listTools']>>) {
    if (this.isShuttingDown) return;

    console.log(`\n⏳ Connecting to hub at ${this.hubUrl}...`);
    this.ws = new WebSocket(this.hubUrl);

    this.ws.on('open', () => {
      console.log('✅ Connected to hub');

      const msg: HubMessage = {
        type: 'register',
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        tools,
        apiKey: this.apiKey,
      };
      this.ws!.send(JSON.stringify(msg));
      this.startHeartbeat();
    });

    this.ws.on('message', async (data) => {
      let msg: DeviceMessage;
      try {
        msg = JSON.parse(data.toString()) as DeviceMessage;
      } catch {
        console.error('[Device] Invalid message from hub');
        return;
      }

      if (msg.type === 'registered') {
        console.log(`✅ Registered with hub as: ${msg.deviceId}`);
        console.log('   Waiting for tool calls...\n');
        return;
      }

      if (msg.type === 'heartbeat_ack') return;

      if (msg.type === 'error') {
        console.error(`[Hub error] ${msg.message}`);
        return;
      }

      if (msg.type === 'tool_call') {
        await this.handleToolCall(msg.callId, msg.toolName, msg.toolArgs, msg.metadata);
        return;
      }

      if (msg.type === 'job_start') {
        this.handleJobStart(msg.callId, msg.jobArgs);
        return;
      }

      if (msg.type === 'job_status') {
        this.handleJobStatus(msg.callId, msg.jobId);
        return;
      }

      if (msg.type === 'job_tail') {
        this.handleJobTail(msg.callId, msg.jobId, msg.stream, msg.bytes);
        return;
      }

      if (msg.type === 'job_cancel') {
        this.handleJobCancel(msg.callId, msg.jobId);
        return;
      }
    });

    this.ws.on('close', (code, reason) => {
      this.stopHeartbeat();
      if (!this.isShuttingDown) {
        console.log(`\n⚠️ Hub connection closed (${code}: ${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
        this.reconnectTimer = setTimeout(() => this.connect(tools), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[WS] Error: ${err.message}`);
      // close event will fire after this and trigger reconnect
    });
  }

  private async handleToolCall(
    callId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ) {
    console.log(`🔧 Tool call [${callId}]: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}...)`);

    let result: unknown;
    let error: string | undefined;

    try {
      if (toolName === 'ping') {
        result = { content: [{ type: 'text', text: `pong ${new Date().toISOString()}` }] };
      } else if (toolName === 'shutdown') {
        result = { content: [{ type: 'text', text: `Shutdown at ${new Date().toISOString()}` }] };
        setTimeout(() => this.shutdown(), 1000);
      } else if (toolName === '__directory_roots') {
        result = { roots: getDirectoryRoots() };
      } else if (toolName === '__directory_list') {
        const path = typeof toolArgs.path === 'string' ? toolArgs.path : '';
        const directory = validateDirectoryPath(path, { mustExist: true });
        result = {
          directory,
          directories: listApprovedChildDirectories(directory.path),
        };
      } else if (toolName === '__directory_select') {
        result = validateDirectoryPath(String(toolArgs.path ?? ''), { mustExist: true });
      } else if (toolName === 'search_files') {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(await executeSearchFiles(toolArgs as any), null, 2),
            },
          ],
        };
      } else if (toolName === 'ix_agent') {
        const payload = await this.handleIxAgentCall(toolArgs);
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } else if (toolName === 'read_multiple_files') {
        result = await this.readMultipleFilesBatched(toolArgs, metadata);
      } else {
        const sanitizedArgs = prepareDesktopCommanderArgs(toolName, toolArgs);
        result = await this.dc.callTool(toolName, sanitizedArgs, metadata);
      }
      console.log(`   ✅ [${callId}] done`);
    } catch (err: any) {
      error = err.message;
      console.error(`   ❌ [${callId}] error: ${error}`);
    }

    const response: HubMessage = {
      type: 'tool_result',
      callId,
      result,
      error,
    };

    this.ws?.send(JSON.stringify(response));
  }

  private decorateDesktopCommanderTools(tools: Awaited<ReturnType<DesktopCommanderIntegration['listTools']>>) {
    return tools.map((tool) => {
      if (tool.name !== 'read_multiple_files') return tool;

      return {
        ...tool,
        description:
          `${tool.description}\n\n` +
          `Remote safety wrapper: large path lists are automatically split into batches of ` +
          `${READ_MULTIPLE_FILES_BATCH_SIZE} before being sent to Desktop Commander. Prefer focused ` +
          `batches and use read_file with offset/length for very large files.`,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...(tool.inputSchema.properties ?? {}),
            paths: {
              ...((tool.inputSchema.properties?.paths as Record<string, unknown> | undefined) ?? {}),
              description:
                `Absolute file paths to read. The remote device batches this list in groups of ` +
                `${READ_MULTIPLE_FILES_BATCH_SIZE} to avoid bulk-read safety blocks.`,
            },
          },
        },
      };
    });
  }

  private async readMultipleFilesBatched(
    toolArgs: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<unknown> {
    const paths = Array.isArray(toolArgs.paths) ? toolArgs.paths : undefined;
    if (!paths || paths.length <= READ_MULTIPLE_FILES_BATCH_SIZE) {
      const sanitizedArgs = prepareDesktopCommanderArgs('read_multiple_files', toolArgs);
      return this.dc.callTool('read_multiple_files', sanitizedArgs, metadata);
    }

    const content: unknown[] = [];
    const errors: string[] = [];
    const batchCount = Math.ceil(paths.length / READ_MULTIPLE_FILES_BATCH_SIZE);

    for (let i = 0; i < paths.length; i += READ_MULTIPLE_FILES_BATCH_SIZE) {
      const batchPaths = paths.slice(i, i + READ_MULTIPLE_FILES_BATCH_SIZE);
      const batchNumber = Math.floor(i / READ_MULTIPLE_FILES_BATCH_SIZE) + 1;

      try {
        const sanitizedArgs = prepareDesktopCommanderArgs('read_multiple_files', {
          ...toolArgs,
          paths: batchPaths,
        });
        const result = await this.dc.callTool('read_multiple_files', sanitizedArgs, metadata);
        if (result && typeof result === 'object' && 'content' in result && Array.isArray((result as any).content)) {
          content.push(...(result as any).content);
        } else {
          content.push({
            type: 'text',
            text: JSON.stringify(result),
          });
        }
      } catch (err: any) {
        errors.push(`Batch ${batchNumber}/${batchCount}: ${err.message}`);
      }
    }

    const summary = {
      type: 'text',
      text:
        `read_multiple_files completed in ${batchCount} batch(es) ` +
        `of up to ${READ_MULTIPLE_FILES_BATCH_SIZE} path(s).` +
        (errors.length ? `\n\nBatch errors:\n${errors.map((e) => `- ${e}`).join('\n')}` : ''),
    };

    return { content: [summary, ...content] };
  }

  private handleJobStart(callId: string, jobArgs: Parameters<DeviceJobManager['start']>[0]) {
    try {
      const summary = this.jobs.start(jobArgs);
      console.log(`Job started [${summary.jobId}]: ${summary.command}`);
      this.ws?.send(JSON.stringify({ type: 'job_started', callId, summary } satisfies HubMessage));
    } catch (err: any) {
      this.ws?.send(JSON.stringify({ type: 'job_started', callId, error: err.message } satisfies HubMessage));
    }
  }

  private handleJobStatus(callId: string, jobId: string) {
    const summary = this.jobs.status(jobId);
    this.ws?.send(JSON.stringify({
      type: 'job_status_result',
      callId,
      summary,
      error: summary ? undefined : `Unknown job: ${jobId}`,
    } satisfies HubMessage));
  }

  private handleJobTail(
    callId: string,
    jobId: string,
    stream?: 'stdout' | 'stderr' | 'both',
    bytes?: number
  ) {
    try {
      const result = this.jobs.tail(jobId, stream, bytes);
      const summary = this.jobs.status(jobId);
      this.ws?.send(JSON.stringify({ type: 'job_result', callId, jobId, summary, result } satisfies HubMessage));
    } catch (err: any) {
      this.ws?.send(JSON.stringify({ type: 'job_result', callId, jobId, error: err.message } satisfies HubMessage));
    }
  }

  private handleJobCancel(callId: string, jobId: string) {
    const cancelled = this.jobs.cancel(jobId);
    const summary = this.jobs.status(jobId);
    this.ws?.send(JSON.stringify({
      type: 'job_result',
      callId,
      jobId,
      summary,
      result: { cancelled },
      error: summary ? undefined : `Unknown job: ${jobId}`,
    } satisfies HubMessage));
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' } satisfies HubMessage));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private setupShutdownHandlers() {
    const shutdown = async (signal: string) => {
      console.log(`\n${signal} received. Shutting down...`);
      await this.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  private async handleIxAgentCall(toolArgs: Record<string, unknown>): Promise<unknown> {
    const action = String(toolArgs.action || '');
    const args = (toolArgs.args as Record<string, unknown> | undefined) || {};
    const session = typeof toolArgs.session === 'string' ? toolArgs.session : undefined;

    await this.ensureIxBridgeDaemon();

    // Verify status and check extension connection
    let status: any;
    try {
      const res = await fetch('http://127.0.0.1:18086/ix-bridge/status');
      status = await res.json();
    } catch (err: any) {
      throw new Error(`Failed to query IX Bridge daemon status: ${err.message}`);
    }

    if (!status.running) {
      throw new Error('IX Bridge daemon is not running properly.');
    }

    if (!status.extension_connected) {
      return {
        success: false,
        error: 'IX Bridge daemon is running, but the Chrome/Edge extension is not connected.\n' +
               'Please load the unpacked extension in your browser from C:\\dev\\Desktop-Projects\\IX-Bridge-Extension ' +
               'and verify that the browser is open and active.',
      };
    }

    // Call the tool
    try {
      const response = await fetch('http://127.0.0.1:18086/ix-bridge/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, args, session }),
      });
      const result: any = await response.json();
      if (result.error) {
        throw new Error(result.error);
      }
      return result.data;
    } catch (err: any) {
      throw new Error(`IX Bridge command failed: ${err.message}`);
    }
  }

  private async ensureIxBridgeDaemon(): Promise<void> {
    const checkRunning = async (): Promise<boolean> => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        const res = await fetch('http://127.0.0.1:18086/ix-bridge/status', { signal: controller.signal });
        clearTimeout(timeoutId);
        const status: any = await res.json();
        return !!status.running;
      } catch {
        return false;
      }
    };

    if (await checkRunning()) {
      return; // Already running
    }

    const daemonPath = 'C:\\dev\\Desktop-Projects\\IX-Bridge-Extension\\daemon.js';
    if (!fs.existsSync(daemonPath)) {
      throw new Error(`IX Bridge daemon.js not found at ${daemonPath}`);
    }

    console.log(`[IX Agent] Starting IX Bridge daemon from ${daemonPath}...`);
    const proc = spawn('node', [daemonPath], {
      detached: true,
      stdio: 'ignore',
      cwd: 'C:\\dev\\Desktop-Projects\\IX-Bridge-Extension',
    });
    proc.unref();

    // Poll status for up to 3 seconds (15 attempts * 200ms)
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (await checkRunning()) {
        console.log('[IX Agent] IX Bridge daemon started successfully.');
        return;
      }
    }

    throw new Error('IX Bridge daemon failed to start within 3 seconds.');
  }

  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Device shutting down');
    }

    await this.dc.close();
    console.log('✅ Shutdown complete');
  }
}
