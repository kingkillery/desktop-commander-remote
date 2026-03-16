import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.desktop-commander-hub');
const KEYS_FILE = path.join(CONFIG_DIR, 'api-keys.json');

export interface ApiKey {
  key: string;
  label: string;
  createdAt: string;
}

export class AuthManager {
  private keys: Map<string, ApiKey> = new Map();

  async load() {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const data = await fs.readFile(KEYS_FILE, 'utf8');
      const keys: ApiKey[] = JSON.parse(data);
      for (const k of keys) this.keys.set(k.key, k);
      console.log(`[Auth] Loaded ${this.keys.size} API key(s)`);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // First run: generate a default key
        const key = await this.createKey('default');
        console.log('\n╔══════════════════════════════════════════════════╗');
        console.log('║  First run: API key generated                    ║');
        console.log('║                                                  ║');
        console.log(`║  Key: ${key.key}  ║`);
        console.log('║                                                  ║');
        console.log('║  Set DC_HUB_API_KEY=<key> on your device client  ║');
        console.log('╚══════════════════════════════════════════════════╝\n');
      } else {
        throw err;
      }
    }
  }

  async createKey(label: string): Promise<ApiKey> {
    const key: ApiKey = {
      key: randomUUID(),
      label,
      createdAt: new Date().toISOString(),
    };
    this.keys.set(key.key, key);
    await this.save();
    return key;
  }

  validate(key: string): boolean {
    return this.keys.has(key);
  }

  async listKeys(): Promise<ApiKey[]> {
    return Array.from(this.keys.values());
  }

  async revokeKey(key: string): Promise<boolean> {
    const deleted = this.keys.delete(key);
    if (deleted) await this.save();
    return deleted;
  }

  private async save() {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(KEYS_FILE, JSON.stringify(Array.from(this.keys.values()), null, 2), { mode: 0o600 });
  }
}
