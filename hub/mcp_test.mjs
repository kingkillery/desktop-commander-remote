// Quick MCP CLI test — connects to the dc-remote-hub, lists tools, calls one.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const HUB_URL = 'http://100.71.124.50:3000/sse';

const transport = new SSEClientTransport(new URL(HUB_URL));
const client = new Client({ name: 'cli-test', version: '1.0.0' }, { capabilities: {} });

console.log('Connecting to hub at', HUB_URL, '...');
await client.connect(transport);
console.log('Connected.\n');

// List tools
const { tools } = await client.listTools();
console.log(`Tools available (${tools.length}):`);
for (const t of tools) {
  console.log(`  ${t.name}`);
}

// Pick the first tool that looks like a simple read (get_config or list_* or screenshot)
const pick =
  tools.find((t) => t.name.includes('get_config')) ||
  tools.find((t) => t.name.includes('list_directory')) ||
  tools.find((t) => t.name.includes('execute_command')) ||
  tools[0];

if (!pick) {
  console.log('\nNo tools found.');
  await client.close();
  process.exit(0);
}

console.log(`\nCalling: ${pick.name}`);

// Build minimal args — for execute_command use a safe echo; for list_directory use home
let args = {};
if (pick.name.includes('execute_command')) {
  args = { command: 'echo "hello from MCP hub test"', timeout_ms: 5000 };
} else if (pick.name.includes('list_directory')) {
  args = { path: '.' };
} else if (pick.name.includes('get_config')) {
  args = {};
}

try {
  const result = await client.callTool({ name: pick.name, arguments: args });
  console.log('\nResult:');
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Tool call error:', err.message);
}

await client.close();
console.log('\nDone.');
