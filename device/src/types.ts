// Shared with hub - keep in sync
export interface DeviceTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export type HubMessage =
  | { type: 'register'; deviceId: string; deviceName: string; tools: DeviceTool[]; apiKey: string }
  | { type: 'tool_result'; callId: string; result: unknown; error?: string }
  | { type: 'heartbeat' };

export type DeviceMessage =
  | { type: 'registered'; deviceId: string }
  | { type: 'tool_call'; callId: string; toolName: string; toolArgs: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: 'heartbeat_ack' }
  | { type: 'error'; message: string };
