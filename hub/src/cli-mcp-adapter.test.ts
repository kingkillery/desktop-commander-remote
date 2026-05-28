import test from 'node:test';
import assert from 'node:assert/strict';
import { CliMcpRegistry, CliMcpAdapter, CliMcpConfig } from './cli-mcp-adapter.js';

// ── CliMcpAdapter status reporting ───────────────────────────────────────────

function makeConfig(overrides: Partial<CliMcpConfig> = {}): CliMcpConfig {
  return {
    name: 'test-adapter',
    command: 'node',
    args: ['--version'],
    enabled: true,
    ...overrides,
  };
}

test('CliMcpAdapter status is stopped when disabled', () => {
  const adapter = new CliMcpAdapter(makeConfig({ enabled: false }));
  assert.equal(adapter.status, 'stopped');
});

test('CliMcpAdapter status is stopped before start() is called', () => {
  const adapter = new CliMcpAdapter(makeConfig());
  assert.equal(adapter.status, 'stopped');
});

test('CliMcpAdapter.start() skips connection when disabled', async () => {
  const adapter = new CliMcpAdapter(makeConfig({ enabled: false }));
  await adapter.start(); // must not throw
  assert.equal(adapter.status, 'stopped');
  assert.equal(adapter.tools.length, 0);
});

test('CliMcpAdapter.start() records lastError on a bad command', async () => {
  const adapter = new CliMcpAdapter(makeConfig({
    command: 'definitely-not-a-real-command-xyz-12345',
    args: [],
  }));
  await adapter.start(); // swallows the error
  assert.equal(adapter.status, 'error');
  assert.ok(typeof adapter.lastError === 'string' && adapter.lastError.length > 0);
});

test('CliMcpAdapter.stop() resets state to stopped', async () => {
  const adapter = new CliMcpAdapter(makeConfig({ enabled: false }));
  await adapter.stop(); // should not throw even if never started
  assert.equal(adapter.status, 'stopped');
  assert.equal(adapter.tools.length, 0);
});

// ── CliMcpRegistry management ─────────────────────────────────────────────────

test('CliMcpRegistry.register adds adapters that appear in getAllAdapters', () => {
  const registry = new CliMcpRegistry();
  registry.register(makeConfig({ name: 'alpha' }));
  registry.register(makeConfig({ name: 'beta' }));

  const adapters = registry.getAllAdapters();
  assert.equal(adapters.length, 2);
  const names = adapters.map((a) => a.config.name).sort();
  assert.deepEqual(names, ['alpha', 'beta']);
});

test('CliMcpRegistry.getAllTools returns empty when no adapters have tools', () => {
  const registry = new CliMcpRegistry();
  registry.register(makeConfig({ enabled: false }));
  assert.deepEqual(registry.getAllTools(), []);
});

test('CliMcpRegistry.getAdapterForTool returns undefined for unknown tool', () => {
  const registry = new CliMcpRegistry();
  registry.register(makeConfig({ name: 'myapp' }));
  assert.equal(registry.getAdapterForTool('myapp_nonexistent'), undefined);
});

test('CliMcpRegistry.getAdapterForTool finds adapter by prefixed tool name', () => {
  const registry = new CliMcpRegistry();
  registry.register(makeConfig({ name: 'myapp' }));
  const adapter = registry.getAllAdapters()[0];

  // Inject a fake discovered tool into the adapter
  (adapter as any).tools = [
    { originalName: 'my_tool', prefixedName: 'myapp_my_tool', description: 'test', inputSchema: {} },
  ];

  const found = registry.getAdapterForTool('myapp_my_tool');
  assert.ok(found !== undefined);
  assert.equal(found?.config.name, 'myapp');
});

test('CliMcpRegistry.getAllTools aggregates tools from multiple adapters', () => {
  const registry = new CliMcpRegistry();
  registry.register(makeConfig({ name: 'alpha' }));
  registry.register(makeConfig({ name: 'beta' }));

  const [alpha, beta] = registry.getAllAdapters();
  (alpha as any).tools = [{ originalName: 'op1', prefixedName: 'alpha_op1', description: '', inputSchema: {} }];
  (beta as any).tools = [{ originalName: 'op2', prefixedName: 'beta_op2', description: '', inputSchema: {} }];

  const allTools = registry.getAllTools();
  assert.equal(allTools.length, 2);
  const prefixed = allTools.map((t) => t.prefixedName).sort();
  assert.deepEqual(prefixed, ['alpha_op1', 'beta_op2']);
});

test('CliMcpAdapter.callTool throws when not connected', async () => {
  const adapter = new CliMcpAdapter(makeConfig({ enabled: false }));
  await assert.rejects(
    adapter.callTool('test-adapter_some_tool', {}),
    /not connected/
  );
});

test('CliMcpAdapter.callTool throws for unknown prefixed tool name', async () => {
  const adapter = new CliMcpAdapter(makeConfig());
  // Force into a "connected" state with fake internals
  (adapter as any).connected = true;
  (adapter as any).client = {}; // non-null truthy sentinel

  (adapter as any).tools = [
    { originalName: 'known', prefixedName: 'test-adapter_known', description: '', inputSchema: {} },
  ];

  await assert.rejects(
    adapter.callTool('test-adapter_unknown', {}),
    /not found/
  );
});

test('CliMcpRegistry.startAll and stopAll iterate all adapters without throwing on disabled ones', async () => {
  const registry = new CliMcpRegistry();
  registry.register(makeConfig({ name: 'disabled-one', enabled: false }));
  registry.register(makeConfig({ name: 'disabled-two', enabled: false }));

  // Should complete without throwing
  await assert.doesNotReject(registry.startAll());
  await assert.doesNotReject(registry.stopAll());
});
