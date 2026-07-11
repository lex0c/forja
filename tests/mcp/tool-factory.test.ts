import { describe, expect, test } from 'bun:test';
import { buildMcpTool, mcpWireName, sanitizeMcpName } from '../../src/mcp/tool-factory.ts';
import { McpCallError, type McpCallResult, type McpManifestTool } from '../../src/mcp/types.ts';
import { isToolError, type ToolContext } from '../../src/tools/types.ts';

const ctx = { signal: new AbortController().signal } as unknown as ToolContext;

const tool = (over: Partial<McpManifestTool> = {}): McpManifestTool => ({
  name: 'query',
  description: 'run a query',
  inputSchema: { type: 'object' },
  meta: {},
  ...over,
});

const build = (over: Partial<Parameters<typeof buildMcpTool>[0]> = {}) =>
  buildMcpTool({
    name: 'mcp__db__query',
    server: 'db',
    tool: tool(),
    serverSurface: 'deferred',
    call: async () => ({ isError: false, content: 'ok' }),
    ...over,
  });

describe('sanitizeMcpName / mcpWireName', () => {
  test('replaces out-of-charset chars with underscore', () => {
    expect(sanitizeMcpName('foo.bar:baz')).toBe('foo_bar_baz');
  });

  test('empty after cleaning falls back to "tool"', () => {
    expect(sanitizeMcpName('')).toBe('tool');
  });

  test('builds mcp__server__tool', () => {
    expect(mcpWireName('postgres', 'query')).toBe('mcp__postgres__query');
  });

  test('bounds the wire name to 64 chars (untrusted long tool name)', () => {
    const wire = mcpWireName('srv', 'x'.repeat(100));
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(wire.startsWith('mcp__srv__')).toBe(true);
  });

  test('sanitizes the server half too', () => {
    expect(mcpWireName('my.srv', 'q')).toBe('mcp__my_srv__q');
  });
});

describe('buildMcpTool: metadata mapping', () => {
  test('defaults are conservative (writes=true → checkpoint + escapesCwd, category mcp)', () => {
    const t = build();
    expect(t.name).toBe('mcp__db__query');
    expect(t.metadata.category).toBe('mcp');
    expect(t.metadata.writes).toBe(true);
    expect(t.metadata.escapesCwd).toBe(true);
    expect(t.metadata.parallel_safe).toBe(false);
    expect(t.metadata.deferred).toBe(true); // serverSurface 'deferred'
  });

  test('a read-only declaration flips writes + escapesCwd off', () => {
    const t = build({ tool: tool({ meta: { writes: false } }) });
    expect(t.metadata.writes).toBe(false);
    expect(t.metadata.escapesCwd).toBe(false);
  });

  test('server surface "base" → not deferred unless the tool overrides', () => {
    expect(build({ serverSurface: 'base' }).metadata.deferred).toBe(false);
    expect(
      build({ serverSurface: 'base', tool: tool({ meta: { deferred: true } }) }).metadata.deferred,
    ).toBe(true);
  });
});

describe('buildMcpTool: execute', () => {
  test('success returns the flattened content', async () => {
    const t = build({ call: async () => ({ isError: false, content: 'hello' }) });
    const out = await t.execute({}, ctx);
    expect(out).toEqual({ content: 'hello' });
  });

  test('passes structured content through when present', async () => {
    const t = build({
      call: async (): Promise<McpCallResult> => ({
        isError: false,
        content: 'x',
        structured: { a: 1 },
      }),
    });
    expect(await t.execute({}, ctx)).toEqual({ content: 'x', structured: { a: 1 } });
  });

  test('isError result → non-retryable mcp.tool_error by default', async () => {
    const t = build({ call: async () => ({ isError: true, content: 'boom' }) });
    const out = await t.execute({}, ctx);
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('mcp.tool_error');
      expect(out.retryable).toBe(false); // a genuine server error is not auto-retryable
    }
  });

  test('an isError result flagged retryable (output-invalid degrade) is retryable', async () => {
    const t = build({
      call: async (): Promise<McpCallResult> => ({
        isError: true,
        content: 'malformed; retry or fall back',
        retryable: true,
      }),
    });
    const out = await t.execute({}, ctx);
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) expect(out.retryable).toBe(true); // flag agrees with the "retry" advice
  });

  test('an unframed thrown fault → retryable mcp.server_unreachable', async () => {
    const t = build({
      call: async () => {
        throw new Error('pipe broke');
      },
    });
    const out = await t.execute({}, ctx);
    expect(isToolError(out)).toBe(true);
    if (isToolError(out)) {
      expect(out.error_code).toBe('mcp.server_unreachable');
      expect(out.retryable).toBe(true);
      expect(out.error_message).toContain("MCP server 'db' is unreachable"); // framed, not bare SDK
      expect(out.error_message).toContain('pipe broke'); // cause preserved
    }
  });

  test('a framed McpCallError passes its code + retryability through', async () => {
    // A pinned drift / exhausted budget / terminal state is permanent-this-session
    // — the model must NOT be told to retry.
    const permanent = build({
      call: async () => {
        throw new McpCallError('mcp.manifest_drift', 'drifted — run /mcp reconnect', false);
      },
    });
    const p = await permanent.execute({}, ctx);
    expect(isToolError(p)).toBe(true);
    if (isToolError(p)) {
      expect(p.error_code).toBe('mcp.manifest_drift');
      expect(p.retryable).toBe(false);
    }

    // A timeout is transient — retryable stays true.
    const timeout = build({
      call: async () => {
        throw new McpCallError('mcp.timeout', 'exceeded 30000ms', true);
      },
    });
    const to = await timeout.execute({}, ctx);
    if (isToolError(to)) {
      expect(to.error_code).toBe('mcp.timeout');
      expect(to.retryable).toBe(true);
    }
  });
});
