import { DeviceTool } from './types.js';

export function getDirectoryTools(): DeviceTool[] {
  return [
    {
      name: 'directory_roots',
      description: 'List approved root directories that remote clients are allowed to browse and use as command working directories.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'directory_list',
      description: 'List approved child directories under an approved path on the connected Desktop Commander device.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          deviceId: { type: 'string' },
        },
        required: ['path'],
      },
    },
    {
      name: 'directory_select',
      description: 'Select an approved working directory for subsequent Desktop Commander command and job tools in this MCP session.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          deviceId: { type: 'string' },
        },
        required: ['path'],
      },
    },
    {
      name: 'directory_current',
      description: 'Show the currently selected approved working directory for this MCP session.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

export function isDirectoryTool(name: string): boolean {
  return name === 'directory_roots'
    || name === 'directory_list'
    || name === 'directory_select'
    || name === 'directory_current';
}
