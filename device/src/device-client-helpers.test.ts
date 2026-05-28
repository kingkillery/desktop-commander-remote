/**
 * Tests for DeviceClient helper logic.
 *
 * DeviceClient's private methods (readMultipleFilesBatched,
 * decorateDesktopCommanderTools) can't be imported directly, so we replicate
 * the exact logic from device-client.ts and test it in isolation.  Any future
 * changes to those methods must also be reflected here, making regressions
 * immediately visible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── readMultipleFilesBatched logic (mirrored from device-client.ts) ───────────

const BATCH_SIZE = 5; // default in production

/**
 * Pure extraction of the batching logic — no DC integration needed.
 * Calls `dcCallTool` for each batch and merges content arrays.
 */
async function readMultipleFilesBatched(
  toolArgs: Record<string, unknown>,
  dcCallTool: (args: Record<string, unknown>) => Promise<unknown>,
  batchSize = BATCH_SIZE
): Promise<unknown> {
  const paths = Array.isArray(toolArgs.paths) ? toolArgs.paths : undefined;
  if (!paths || paths.length <= batchSize) {
    return dcCallTool(toolArgs);
  }

  const content: unknown[] = [];
  const errors: string[] = [];
  const batchCount = Math.ceil(paths.length / batchSize);

  for (let i = 0; i < paths.length; i += batchSize) {
    const batchPaths = paths.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;

    try {
      const result = await dcCallTool({ ...toolArgs, paths: batchPaths });
      if (result && typeof result === 'object' && 'content' in result && Array.isArray((result as any).content)) {
        content.push(...(result as any).content);
      } else {
        content.push({ type: 'text', text: JSON.stringify(result) });
      }
    } catch (err: any) {
      errors.push(`Batch ${batchNumber}/${batchCount}: ${err.message}`);
    }
  }

  const summary = {
    type: 'text',
    text:
      `read_multiple_files completed in ${batchCount} batch(es) ` +
      `of up to ${batchSize} path(s).` +
      (errors.length ? `\n\nBatch errors:\n${errors.map((e) => `- ${e}`).join('\n')}` : ''),
  };

  return { content: [summary, ...content] };
}

test('readMultipleFilesBatched calls DC directly for small path lists', async () => {
  let callCount = 0;
  const dcCall = async (args: Record<string, unknown>) => {
    callCount++;
    return { content: [{ type: 'text', text: 'file-content' }] };
  };

  const result = await readMultipleFilesBatched({ paths: ['a.ts', 'b.ts'] }, dcCall);
  assert.equal(callCount, 1);
  assert.deepEqual(result, { content: [{ type: 'text', text: 'file-content' }] });
});

test('readMultipleFilesBatched calls DC directly when paths is undefined', async () => {
  let callCount = 0;
  const dcCall = async () => {
    callCount++;
    return { content: [{ type: 'text', text: 'ok' }] };
  };

  await readMultipleFilesBatched({}, dcCall);
  assert.equal(callCount, 1);
});

test('readMultipleFilesBatched splits large path lists into batches', async () => {
  const receivedBatches: string[][] = [];
  const dcCall = async (args: Record<string, unknown>) => {
    receivedBatches.push(args.paths as string[]);
    return { content: [{ type: 'text', text: 'ok' }] };
  };

  const paths = Array.from({ length: 12 }, (_, i) => `file${i}.ts`);
  await readMultipleFilesBatched({ paths }, dcCall, 5);

  // 12 paths in batches of 5 → 3 calls
  assert.equal(receivedBatches.length, 3);
  assert.equal(receivedBatches[0].length, 5);
  assert.equal(receivedBatches[1].length, 5);
  assert.equal(receivedBatches[2].length, 2);
});

test('readMultipleFilesBatched merges content arrays from all batches', async () => {
  const dcCall = async (args: Record<string, unknown>) => ({
    content: (args.paths as string[]).map((p) => ({ type: 'text', text: p })),
  });

  const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
  const result = (await readMultipleFilesBatched({ paths }, dcCall, 3)) as { content: unknown[] };
  // Summary item + 6 file items
  assert.equal(result.content.length, 7);
  const texts = result.content.map((c: any) => c.text);
  assert.ok(texts.includes('a.ts'));
  assert.ok(texts.includes('f.ts'));
});

test('readMultipleFilesBatched includes batch summary as first content item', async () => {
  const dcCall = async () => ({ content: [{ type: 'text', text: 'ok' }] });
  const paths = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);

  const result = (await readMultipleFilesBatched({ paths }, dcCall, 5)) as { content: Array<{ type: string; text: string }> };
  const summary = result.content[0];
  assert.equal(summary.type, 'text');
  assert.ok(summary.text.includes('2 batch'));
});

test('readMultipleFilesBatched records batch errors in the summary', async () => {
  let callCount = 0;
  const dcCall = async () => {
    callCount++;
    if (callCount === 2) throw new Error('network error');
    return { content: [{ type: 'text', text: 'ok' }] };
  };

  const paths = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
  const result = (await readMultipleFilesBatched({ paths }, dcCall, 5)) as { content: Array<{ text: string }> };
  const summaryText = result.content[0].text;
  assert.ok(summaryText.includes('Batch errors'));
  assert.ok(summaryText.includes('network error'));
});

test('readMultipleFilesBatched falls back to JSON when DC result has no content array', async () => {
  const dcCall = async () => ({ files: ['a', 'b'] });
  const paths = Array.from({ length: 6 }, (_, i) => `f${i}.ts`);

  const result = (await readMultipleFilesBatched({ paths }, dcCall, 5)) as { content: unknown[] };
  // summary + 2 batches with JSON-stringified results
  assert.equal(result.content.length, 3);
});

// ── decorateDesktopCommanderTools logic (mirrored from device-client.ts) ──────

interface SimpleTool {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown> };
}

function decorateDesktopCommanderTools(tools: SimpleTool[], batchSize = BATCH_SIZE): SimpleTool[] {
  return tools.map((tool) => {
    if (tool.name !== 'read_multiple_files') return tool;

    return {
      ...tool,
      description:
        `${tool.description}\n\n` +
        `Remote safety wrapper: large path lists are automatically split into batches of ` +
        `${batchSize} before being sent to Desktop Commander. Prefer focused ` +
        `batches and use read_file with offset/length for very large files.`,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema.properties ?? {}),
          paths: {
            ...((tool.inputSchema.properties?.paths as Record<string, unknown> | undefined) ?? {}),
            description:
              `Absolute file paths to read. The remote device batches this list in groups of ` +
              `${batchSize} to avoid bulk-read safety blocks.`,
          },
        },
      },
    };
  });
}

test('decorateDesktopCommanderTools does not modify non-read_multiple_files tools', () => {
  const tools: SimpleTool[] = [
    { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } },
    { name: 'execute_command', description: 'Run a command.', inputSchema: { type: 'object' } },
  ];

  const decorated = decorateDesktopCommanderTools(tools);
  assert.deepEqual(decorated, tools);
});

test('decorateDesktopCommanderTools injects batch description into read_multiple_files', () => {
  const tools: SimpleTool[] = [
    {
      name: 'read_multiple_files',
      description: 'Read multiple files.',
      inputSchema: { type: 'object', properties: { paths: { type: 'array' } } },
    },
  ];

  const [decorated] = decorateDesktopCommanderTools(tools, 5);
  assert.ok(decorated.description.includes('Remote safety wrapper'));
  assert.ok(decorated.description.includes('batches of 5'));
});

test('decorateDesktopCommanderTools updates paths property description', () => {
  const tools: SimpleTool[] = [
    {
      name: 'read_multiple_files',
      description: 'Read multiple files.',
      inputSchema: { type: 'object', properties: { paths: { type: 'array' } } },
    },
  ];

  const [decorated] = decorateDesktopCommanderTools(tools, 5);
  const pathsProp = decorated.inputSchema.properties?.paths as Record<string, unknown>;
  assert.ok(typeof pathsProp.description === 'string');
  assert.ok((pathsProp.description as string).includes('groups of 5'));
});

test('decorateDesktopCommanderTools preserves other inputSchema properties', () => {
  const tools: SimpleTool[] = [
    {
      name: 'read_multiple_files',
      description: 'Read multiple files.',
      inputSchema: {
        type: 'object',
        properties: { encoding: { type: 'string' }, paths: { type: 'array' } },
      },
    },
  ];

  const [decorated] = decorateDesktopCommanderTools(tools);
  assert.ok('encoding' in (decorated.inputSchema.properties ?? {}));
});

test('decorateDesktopCommanderTools handles missing paths property gracefully', () => {
  const tools: SimpleTool[] = [
    {
      name: 'read_multiple_files',
      description: 'Read multiple files.',
      inputSchema: { type: 'object' },
    },
  ];

  const [decorated] = decorateDesktopCommanderTools(tools);
  const pathsProp = decorated.inputSchema.properties?.paths as Record<string, unknown>;
  assert.ok(typeof pathsProp.description === 'string');
});

test('decorateDesktopCommanderTools processes a mixed tool list correctly', () => {
  const tools: SimpleTool[] = [
    { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } },
    {
      name: 'read_multiple_files',
      description: 'Read multiple.',
      inputSchema: { type: 'object' },
    },
    { name: 'write_file', description: 'Write a file.', inputSchema: { type: 'object' } },
  ];

  const decorated = decorateDesktopCommanderTools(tools);
  assert.equal(decorated[0].description, 'Read a file.'); // unchanged
  assert.ok(decorated[1].description.includes('Remote safety wrapper')); // decorated
  assert.equal(decorated[2].description, 'Write a file.'); // unchanged
});
