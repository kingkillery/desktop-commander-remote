#!/usr/bin/env node
// Load .env if present
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && !(key in process.env)) process.env[key] = rest.join('=');
  }
} catch {}

import { DeviceClient } from './device-client.js';

const client = new DeviceClient();
client.start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
