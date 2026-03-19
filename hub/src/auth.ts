import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.desktop-commander-hub');
const KEYS_FILE = path.join(CONFIG_DIR, 'api-keys.json');
const OAUTH_FILE = path.join(CONFIG_DIR, 'oauth.json');

export interface ApiKey {
  key: string;
  label: string;
  createdAt: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  name: string;
  createdAt: string;
}

export class AuthManager {
  private keys: Map<string, ApiKey> = new Map();
  private oauthClients: Map<string, OAuthClient> = new Map();

  async load() {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });

      // Load API keys
      try {
        const data = await fs.readFile(KEYS_FILE, 'utf8');
        const keys: ApiKey[] = JSON.parse(data);
        for (const k of keys) this.keys.set(k.key, k);
      } catch {
        // First run: generate a default key
        const key = await this.createKey('default');
        console.log('\n========================================');
        console.log('First run: API key generated');
        console.log(`Key: ${key.key}`);
        console.log('========================================\n');
      }
      console.log(`[Auth] Loaded ${this.keys.size} API key(s)`);

      // Load OAuth clients
      try {
        const oauthData = await fs.readFile(OAUTH_FILE, 'utf8');
        const clients: OAuthClient[] = JSON.parse(oauthData);
        for (const c of clients) this.oauthClients.set(c.clientId, c);
      } catch {
        // Create default OAuth client
        const client = await this.createOAuthClient('chatgpt', 'ChatGPT');
        console.log(`[Auth] Created OAuth client: ${client.clientId}`);
      }
      console.log(`[Auth] Loaded ${this.oauthClients.size} OAuth client(s)`);
    } catch (err: any) {
      throw err;
    }
  }

  async createKey(label: string): Promise<ApiKey> {
    const key: ApiKey = {
      key: randomUUID(),
      label,
      createdAt: new Date().toString(),
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

  // OAuth methods
  async createOAuthClient(name: string, displayName: string): Promise<OAuthClient> {
    const client: OAuthClient = {
      clientId: randomUUID(),
      clientSecret: randomUUID(),
      name: displayName,
      createdAt: new Date().toString(),
    };
    this.oauthClients.set(client.clientId, client);
    await this.saveOAuth();
    return client;
  }

  validateOAuthClient(clientId: string, clientSecret: string): boolean {
    const client = this.oauthClients.get(clientId);
    return client?.clientSecret === clientSecret;
  }

  // For OAuth token validation - map access token to API key
  // In simple mode: access_token = API key
  validateAccessToken(token: string): boolean {
    return this.keys.has(token);
  }

  getOAuthClient(clientId: string): OAuthClient | undefined {
    return this.oauthClients.get(clientId);
  }

  listOAuthClients(): OAuthClient[] {
    return Array.from(this.oauthClients.values()).map(c => ({
      ...c,
      clientSecret: '******' // Hide secret in listing
    }));
  }

  private async save() {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(KEYS_FILE, JSON.stringify(Array.from(this.keys.values()), null, 2), { mode: 0o600 });
  }

  private async saveOAuth() {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(OAUTH_FILE, JSON.stringify(Array.from(this.oauthClients.values()), null, 2), { mode: 0o600 });
  }
}
