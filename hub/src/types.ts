// Shared types for hub <-> device protocol

export interface DeviceTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  tools: DeviceTool[];
  connectedAt: Date;
}

// WebSocket message types (device <-> hub)
export type HubMessage =
  | { type: 'register'; deviceId: string; deviceName: string; tools: DeviceTool[]; apiKey: string }
  | { type: 'tool_result'; callId: string; result: unknown; error?: string }
  | { type: 'heartbeat' };

export type DeviceMessage =
  | { type: 'registered'; deviceId: string }
  | { type: 'tool_call'; callId: string; toolName: string; toolArgs: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: 'heartbeat_ack' }
  | { type: 'error'; message: string };

export interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}
