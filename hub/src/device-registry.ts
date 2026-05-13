import { WebSocket } from 'ws';
import { DeviceInfo, DeviceTool, DeviceMessage, JobStartArgs, PendingCall } from './types.js';
import { randomUUID } from 'crypto';

export class DeviceRegistry {
  private devices = new Map<string, { info: DeviceInfo; ws: WebSocket; pending: Map<string, PendingCall> }>();

  register(ws: WebSocket, deviceId: string, deviceName: string, tools: DeviceTool[]) {
    // Clean up existing connection for same device if any
    const existing = this.devices.get(deviceId);
    if (existing) {
      console.log(`[Registry] Replacing existing connection for device ${deviceId}`);
      existing.ws.terminate();
    }

    this.devices.set(deviceId, {
      info: { deviceId, deviceName, tools, connectedAt: new Date() },
      ws,
      pending: new Map(),
    });

    console.log(`[Registry] Device registered: ${deviceName} (${deviceId}) with ${tools.length} tools`);
  }

  remove(deviceId: string) {
    const entry = this.devices.get(deviceId);
    if (!entry) return;

    // Reject all pending calls
    for (const [callId, pending] of entry.pending) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`Device ${deviceId} disconnected`));
    }

    this.devices.delete(deviceId);
    console.log(`[Registry] Device removed: ${deviceId}`);
  }

  getAll(): DeviceInfo[] {
    return Array.from(this.devices.values()).map((e) => e.info);
  }

  getAllTools(): DeviceTool[] {
    const tools: DeviceTool[] = [];
    for (const entry of this.devices.values()) {
      for (const tool of entry.info.tools) {
        // Prefix with device name if multiple devices
        if (this.devices.size > 1) {
          tools.push({
            ...tool,
            name: `${entry.info.deviceId}_${tool.name}`,
            description: `[${entry.info.deviceName}] ${tool.description}`,
          });
        } else {
          tools.push(tool);
        }
      }
    }
    return tools;
  }

  findDeviceForTool(toolName: string): string | undefined {
    // Single device: route to it
    if (this.devices.size === 1) {
      return this.devices.keys().next().value;
    }
    // Multi-device: strip prefix
    for (const [deviceId] of this.devices) {
      if (toolName.startsWith(`${deviceId}_`)) {
        return deviceId;
      }
    }
    return undefined;
  }

  resolveToolName(deviceId: string, toolName: string): string {
    if (this.devices.size > 1) {
      return toolName.replace(`${deviceId}_`, '');
    }
    return toolName;
  }

  async callTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    timeoutMs = 120_000
  ): Promise<unknown> {
    const deviceId = this.findDeviceForTool(toolName);
    if (!deviceId) {
      throw new Error(
        this.devices.size === 0
          ? 'No devices connected. Start the device client on your machine.'
          : `No device found for tool: ${toolName}`
      );
    }

    const entry = this.devices.get(deviceId)!;
    const actualToolName = this.resolveToolName(deviceId, toolName);
    return this.callToolOnDevice(deviceId, actualToolName, toolArgs, metadata, timeoutMs);
  }

  async callToolOnDevice(
    deviceId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    metadata?: Record<string, unknown>,
    timeoutMs = 120_000
  ): Promise<unknown> {
    const entry = this.devices.get(deviceId);
    if (!entry) throw new Error(`Device not connected: ${deviceId}`);
    const callId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        entry.pending.delete(callId);
        reject(new Error(`Tool call timed out after ${timeoutMs}ms: ${toolName}`));
      }, timeoutMs);

      entry.pending.set(callId, { resolve, reject, timeoutId });

      const msg: DeviceMessage = {
        type: 'tool_call',
        callId,
        toolName,
        toolArgs,
        metadata,
      };

      entry.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          clearTimeout(timeoutId);
          entry.pending.delete(callId);
          reject(new Error(`Failed to send tool call: ${err.message}`));
        }
      });
    });
  }

  resolveCall(deviceId: string, callId: string, result: unknown, error?: string) {
    const entry = this.devices.get(deviceId);
    if (!entry) return;

    const pending = entry.pending.get(callId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    entry.pending.delete(callId);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }

  isConnected(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  getDeviceIdForRequest(deviceId?: string): string {
    if (deviceId) {
      if (!this.devices.has(deviceId)) throw new Error(`Device not connected: ${deviceId}`);
      return deviceId;
    }
    if (this.devices.size === 1) {
      return this.devices.keys().next().value!;
    }
    if (this.devices.size === 0) {
      throw new Error('No devices connected. Start the device client on your machine.');
    }
    throw new Error('Multiple devices connected. Provide deviceId.');
  }

  sendJobStart(jobArgs: JobStartArgs, deviceId?: string, timeoutMs = 30_000): Promise<unknown> {
    return this.sendJobMessage(this.getDeviceIdForRequest(deviceId), (callId) => ({
      type: 'job_start',
      callId,
      jobArgs,
    }), timeoutMs);
  }

  sendJobStatus(jobId: string, deviceId?: string, timeoutMs = 30_000): Promise<unknown> {
    return this.sendJobMessage(this.getDeviceIdForRequest(deviceId), (callId) => ({
      type: 'job_status',
      callId,
      jobId,
    }), timeoutMs);
  }

  sendJobTail(
    jobId: string,
    stream?: 'stdout' | 'stderr' | 'both',
    bytes?: number,
    deviceId?: string,
    timeoutMs = 30_000
  ): Promise<unknown> {
    return this.sendJobMessage(this.getDeviceIdForRequest(deviceId), (callId) => ({
      type: 'job_tail',
      callId,
      jobId,
      stream,
      bytes,
    }), timeoutMs);
  }

  sendJobCancel(jobId: string, deviceId?: string, timeoutMs = 30_000): Promise<unknown> {
    return this.sendJobMessage(this.getDeviceIdForRequest(deviceId), (callId) => ({
      type: 'job_cancel',
      callId,
      jobId,
    }), timeoutMs);
  }

  private sendJobMessage(
    deviceId: string,
    build: (callId: string) => DeviceMessage,
    timeoutMs: number
  ): Promise<unknown> {
    const entry = this.devices.get(deviceId);
    if (!entry) throw new Error(`Device not connected: ${deviceId}`);
    const callId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        entry.pending.delete(callId);
        reject(new Error(`Job request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      entry.pending.set(callId, { resolve, reject, timeoutId });

      entry.ws.send(JSON.stringify(build(callId)), (err) => {
        if (err) {
          clearTimeout(timeoutId);
          entry.pending.delete(callId);
          reject(new Error(`Failed to send job request: ${err.message}`));
        }
      });
    });
  }
}
