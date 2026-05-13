import WebSocket from 'ws';
import os from 'os';
import { randomUUID } from 'crypto';
import { DesktopCommanderIntegration } from './dc-integration.js';
import { HubMessage, DeviceMessage } from './types.js';
import { DeviceJobManager } from './job-manager.js';
import {
  getDirectoryRoots,
  listApprovedChildDirectories,
  prepareDesktopCommanderArgs,
  validateDirectoryPath,
} from './directory-policy.js';

const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15000;

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
    const tools = await this.dc.listTools();
    console.log(`   Local tools: ${tools.length}`);

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
