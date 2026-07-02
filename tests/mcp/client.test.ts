// Unit coverage for the SDK boundary's PURE, defensive parsers — the
// untrusted-input narrowing that the happy-path real-subprocess test can't
// exercise. The SDK-touching `createStdioMcpClient` is covered end-to-end by
// tests/mcp/real-subprocess.test.ts; here we pin the degradation + env-
// isolation properties directly.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  MAX_MCP_TOOLS,
  MAX_TOOL_RESULT_CHARS,
  abortableConnect,
  boundStructuredContent,
  buildSpawnEnv,
  callErrorToResult,
  createStdioMcpClient,
  extractMeta,
  flattenContent,
  isInvalidOutput,
  narrowManifestTools,
  normalizeInputSchema,
  teeStderr,
} from '../../src/mcp/client.ts';
import type { McpStdioConfig } from '../../src/mcp/types.ts';

describe('buildSpawnEnv — env isolation (no secret / cross-server leak)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  test('forwards base + declared ONLY — no agent secret, no blanket MCP_*', () => {
    process.env.FORJA_SECRET_TOKEN = 'sk-should-not-leak';
    process.env.MCP_GITHUB_TOKEN = 'ghp-should-not-leak';
    const env = buildSpawnEnv({ PGHOST: 'db.local' });
    // The agent's environment does NOT bleed into an untrusted server.
    expect(env.FORJA_SECRET_TOKEN).toBeUndefined();
    // Regression guard for the fixed cross-server leak: a one-server MCP_* token
    // must NOT be blanket-forwarded to every server.
    expect(env.MCP_GITHUB_TOKEN).toBeUndefined();
    // The server's OWN declared env is forwarded.
    expect(env.PGHOST).toBe('db.local');
    if (saved.PATH !== undefined) expect(env.PATH).toBe(saved.PATH);
  });

  test('declared env can override a base var', () => {
    expect(buildSpawnEnv({ PATH: '/custom/bin' }).PATH).toBe('/custom/bin');
  });

  test('no declared env → only the PATH/HOME/USER base', () => {
    const env = buildSpawnEnv(undefined);
    expect(Object.keys(env).every((k) => k === 'PATH' || k === 'HOME' || k === 'USER')).toBe(true);
  });
});

describe('normalizeInputSchema', () => {
  test('an absent / mis-shaped schema degrades to an empty object schema', () => {
    expect(normalizeInputSchema(undefined)).toEqual({ type: 'object' });
    expect(normalizeInputSchema(null)).toEqual({ type: 'object' });
    expect(normalizeInputSchema('string')).toEqual({ type: 'object' });
    expect(normalizeInputSchema([1, 2])).toEqual({ type: 'object' });
    expect(normalizeInputSchema({ type: 'array' })).toEqual({ type: 'object' }); // wrong root type
  });

  test('a well-formed object schema passes through verbatim', () => {
    const s = { type: 'object' as const, properties: { x: { type: 'string' } }, required: ['x'] };
    expect(normalizeInputSchema(s)).toEqual(s);
  });
});

describe('extractMeta', () => {
  test('non-object _meta or a missing agentic_cli namespace → empty', () => {
    expect(extractMeta(undefined)).toEqual({});
    expect(extractMeta(null)).toEqual({});
    expect(extractMeta('x')).toEqual({});
    expect(extractMeta({ other: 1 })).toEqual({});
    expect(extractMeta({ agentic_cli: 'nope' })).toEqual({});
  });

  test('keeps only well-typed agentic_cli fields; drops ill-typed ones', () => {
    const m = extractMeta({
      agentic_cli: {
        category: 'fs.read',
        writes: false,
        network: 'yes', // not a boolean → dropped
        parallel_safe: true,
        deferred: 1, // not a boolean → dropped
        idempotent: true,
      },
    });
    expect(m).toEqual({
      category: 'fs.read',
      writes: false,
      parallel_safe: true,
      idempotent: true,
    });
  });
});

describe('flattenContent', () => {
  test('joins text blocks, drops non-text, non-array → empty', () => {
    expect(flattenContent('x')).toBe('');
    expect(flattenContent(undefined)).toBe('');
    expect(
      flattenContent([
        { type: 'text', text: 'a' },
        { type: 'image', data: '...' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  test('a text block whose text is non-string is skipped', () => {
    expect(flattenContent([{ type: 'text', text: 42 }])).toBe('');
  });

  test('bounds a single oversized result at MAX_TOOL_RESULT_CHARS + a marker', () => {
    const huge = 'a'.repeat(MAX_TOOL_RESULT_CHARS + 5000); // one pathological block
    const out = flattenContent([{ type: 'text', text: huge }]);
    expect(out.startsWith('a'.repeat(1000))).toBe(true);
    expect(out).toContain('truncated'); // marker appended
    expect(out.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100); // capped, not the full 1 MiB+5k
  });

  test('truncates ACROSS blocks once the running total crosses the cap', () => {
    const near = 'a'.repeat(MAX_TOOL_RESULT_CHARS - 10);
    const out = flattenContent([
      { type: 'text', text: near },
      { type: 'text', text: 'bbbbbbbbbbbbbbbbbbbb' }, // 20 chars, only ~10 fit
    ]);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100);
  });

  test('a result exactly at the cap is NOT marked truncated', () => {
    const exact = 'a'.repeat(MAX_TOOL_RESULT_CHARS);
    const out = flattenContent([{ type: 'text', text: exact }]);
    expect(out).toBe(exact); // no marker
  });
});

describe('boundStructuredContent — bounds the structured channel', () => {
  test('a small structured value passes through unchanged', () => {
    const v = { rows: [1, 2, 3], ok: true };
    expect(boundStructuredContent(v)).toEqual({ structured: v });
  });

  test('falsy JSON values (null / false / 0) are kept, not dropped', () => {
    expect(boundStructuredContent(null)).toEqual({ structured: null });
    expect(boundStructuredContent(false)).toEqual({ structured: false });
    expect(boundStructuredContent(0)).toEqual({ structured: 0 });
  });

  test('an over-cap structured blob is DROPPED with a marker (not truncated)', () => {
    // A small text + a colossal structured would otherwise bypass the text cap.
    const huge = { blob: 'a'.repeat(MAX_TOOL_RESULT_CHARS + 100) };
    const out = boundStructuredContent(huge);
    expect(out.structured).toBeUndefined();
    expect(out.note).toContain('structured content dropped');
    expect(out.note).toContain('exceeded');
  });

  test('an unserializable (circular) structured value is dropped defensively', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = boundStructuredContent(circular);
    expect(out.structured).toBeUndefined();
    expect(out.note).toContain('not serializable');
  });
});

describe('callErrorToResult — server error vs transport fault', () => {
  test('a server-reported JSON-RPC error (InvalidParams) becomes an isError RESULT', () => {
    // The server RESPONDED (connection alive) — the model made a bad call. Surface
    // it as a per-call error, NOT a transport fault that would disconnect + retry.
    const res = callErrorToResult(new McpError(ErrorCode.InvalidParams, 'missing arg'), false);
    expect(res).not.toBeNull();
    expect(res?.isError).toBe(true);
    expect(res?.content).toContain('missing arg');
  });

  test('MethodNotFound + a custom server code also become isError results', () => {
    expect(
      callErrorToResult(new McpError(ErrorCode.MethodNotFound, 'no tool'), false),
    ).not.toBeNull();
    // A custom server error code (not ConnectionClosed -32000 / RequestTimeout -32001).
    expect(callErrorToResult(new McpError(-32050, 'custom'), false)).not.toBeNull();
  });

  test('a transport-level McpError (ConnectionClosed / RequestTimeout) is RE-THROWN (null)', () => {
    // These mean the connection is gone / timed out — the manager must disconnect
    // or apply its timeout handling, so they propagate rather than look like a
    // per-call error.
    expect(callErrorToResult(new McpError(ErrorCode.ConnectionClosed, 'closed'), false)).toBeNull();
    expect(callErrorToResult(new McpError(ErrorCode.RequestTimeout, 'slow'), false)).toBeNull();
  });

  test('a NON-McpError (raw transport fault) is re-thrown (null)', () => {
    expect(callErrorToResult(new Error('ECONNREFUSED'), false)).toBeNull();
  });

  test('an aborted call is always re-thrown, even for an McpError', () => {
    // A timeout / session cancel fires the signal; propagate so the manager applies
    // its abort handling instead of swallowing it into a result.
    expect(callErrorToResult(new McpError(ErrorCode.InvalidParams, 'x'), true)).toBeNull();
  });
});

describe('narrowManifestTools — bounds an untrusted tools/list', () => {
  test('narrows well-formed tools (name/description/inputSchema/meta)', () => {
    const tools = narrowManifestTools([
      {
        name: 'query',
        description: 'run a query',
        inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
        _meta: { agentic_cli: { writes: false } },
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('query');
    expect(tools[0]?.description).toBe('run a query');
    expect(tools[0]?.meta).toEqual({ writes: false });
  });

  test('a non-array → [] and non-object / nameless entries are skipped', () => {
    expect(narrowManifestTools('nope')).toEqual([]);
    expect(narrowManifestTools(undefined)).toEqual([]);
    const tools = narrowManifestTools([null, 42, { description: 'no name' }, { name: 'ok' }]);
    expect(tools.map((t) => t.name)).toEqual(['ok']);
  });

  test('caps the tool COUNT at MAX_MCP_TOOLS', () => {
    const many = Array.from({ length: MAX_MCP_TOOLS + 50 }, (_, i) => ({ name: `t${i}` }));
    expect(narrowManifestTools(many)).toHaveLength(MAX_MCP_TOOLS);
  });

  test('truncates an over-long name and description', () => {
    const tools = narrowManifestTools([{ name: 'n'.repeat(500), description: 'd'.repeat(9000) }]);
    expect(tools[0]?.name.length).toBe(128);
    expect(tools[0]?.description.length).toBe(4096);
  });

  test('degrades an oversized inputSchema to the empty object schema', () => {
    const bloated = { type: 'object', properties: { x: { description: 'a'.repeat(70000) } } };
    const tools = narrowManifestTools([{ name: 'x', inputSchema: bloated }]);
    expect(tools[0]?.inputSchema).toEqual({ type: 'object' }); // schema over 64 KiB dropped
  });

  test('a well-formed (in-bounds) inputSchema passes through', () => {
    const schema = {
      type: 'object' as const,
      properties: { a: { type: 'number' } },
      required: ['a'],
    };
    const tools = narrowManifestTools([{ name: 'x', inputSchema: schema }]);
    expect(tools[0]?.inputSchema).toEqual(schema);
  });
});

describe('isInvalidOutput — conservative §15.5 detection', () => {
  test('flags non-array content (the MCP protocol requires an array)', () => {
    expect(isInvalidOutput('a string', false)).toBe(true);
    expect(isInvalidOutput(null, false)).toBe(true);
    expect(isInvalidOutput({ type: 'text' }, false)).toBe(true);
  });

  test('flags a text block whose text is non-string', () => {
    expect(isInvalidOutput([{ type: 'text', text: 42 }], false)).toBe(true);
  });

  test('flags a non-object block (bare null / primitive)', () => {
    expect(isInvalidOutput([null], false)).toBe(true);
    expect(isInvalidOutput([42], false)).toBe(true);
    expect(isInvalidOutput([{ type: 'text', text: 'ok' }, null], false)).toBe(true);
  });

  test('does NOT flag well-formed, empty, or all-image content (no false positives)', () => {
    expect(isInvalidOutput([{ type: 'text', text: 'ok' }], false)).toBe(false);
    expect(isInvalidOutput([], false)).toBe(false); // a legitimate void result
    expect(isInvalidOutput([{ type: 'image', data: '...' }], false)).toBe(false);
  });

  test('an explicit isError result is never flagged invalid', () => {
    expect(isInvalidOutput('garbage', true)).toBe(false);
    expect(isInvalidOutput([{ type: 'text', text: 42 }], true)).toBe(false);
  });
});

describe('createStdioMcpClient — sandbox wrap in connect()', () => {
  const cfg = (over: Partial<McpStdioConfig> = {}): McpStdioConfig => ({
    transport: 'stdio',
    command: 'bin',
    args: ['a'],
    rawArgv: ['bin', 'a'],
    ...over,
  });

  test('a fail-closed wrap throw propagates out of connect() BEFORE any spawn', async () => {
    let wrapCalled = false;
    const client = createStdioMcpClient(cfg(), {
      profile: 'cwd-rw',
      wrap: () => {
        wrapCalled = true;
        throw new Error('sandbox: tool unavailable mid-session — refusing to run unsandboxed');
      },
    });
    // The throw fires in the wrap before StdioClientTransport is constructed —
    // no child is spawned; the manager's connect try maps this to error/disconnected.
    await expect(client.connect()).rejects.toThrow('refusing to run unsandboxed');
    expect(wrapCalled).toBe(true);
  });

  test('connect() threads cwd, inner argv, and the declared env (passthroughEnv) to the wrap', async () => {
    let capturedCwd: string | undefined;
    let capturedArgv: readonly string[] | undefined;
    let capturedPass: Record<string, string> | undefined;
    const client = createStdioMcpClient(cfg({ cwd: '/srv', env: { PGHOST: 'db.local' } }), {
      profile: 'cwd-rw',
      wrap: (a) => {
        capturedCwd = a.cwd;
        capturedArgv = a.innerArgv;
        capturedPass = a.passthroughEnv;
        throw new Error('stop-before-spawn');
      },
    });
    await expect(client.connect()).rejects.toThrow('stop-before-spawn');
    expect(capturedCwd).toBe('/srv');
    expect(capturedArgv).toEqual(['bin', 'a']);
    expect(capturedPass).toEqual({ PGHOST: 'db.local' });
  });

  test("profile 'host' is never wrapped (the wrap is not called)", async () => {
    let wrapCalled = false;
    const client = createStdioMcpClient(cfg({ command: 'definitely-no-such-bin-xyz', args: [] }), {
      profile: 'host',
      wrap: () => {
        wrapCalled = true;
        return [];
      },
    });
    // host ⇒ no wrap ⇒ the spawn attempts the (missing) binary and connect rejects
    // on the spawn, not on the wrap.
    await expect(client.connect()).rejects.toThrow();
    expect(wrapCalled).toBe(false);
  });
});

describe('teeStderr — drain + tee the server stderr', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-tee-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('tees the stream to the log file (mkdir -p of the trace dir)', async () => {
    const path = join(dir, 'traces', 'mcp-db.log'); // dir does not exist yet
    await teeStderr(Readable.from([Buffer.from('boot\n'), Buffer.from('listening\n')]), path);
    expect(readFileSync(path, 'utf8')).toBe('boot\nlistening\n');
  });

  test('lazy: a silent stream creates no on-disk artifact', async () => {
    const path = join(dir, 'traces', 'mcp-quiet.log');
    await teeStderr(Readable.from([]), path);
    expect(existsSync(path)).toBe(false);
  });

  test('drain-to-discard: an undefined path still consumes the stream (no child block)', async () => {
    // The whole point of draining even without a sink: an unread pipe blocks the
    // child. With no path we must still read every chunk to EOF.
    let ended = false;
    const src = Readable.from([Buffer.from('x'), Buffer.from('y')]);
    src.on('end', () => {
      ended = true;
    });
    await teeStderr(src, undefined);
    expect(ended).toBe(true);
  });

  test('resolves on a stream error without throwing', async () => {
    const path = join(dir, 'mcp-err.log');
    const src = new Readable({
      read() {
        this.destroy(new Error('pipe broke'));
      },
    });
    await teeStderr(src, path); // must resolve, not reject
    expect(true).toBe(true);
  });

  test('APPENDS across reconnects — a second tee does not truncate the first', async () => {
    const path = join(dir, 'mcp-db.log');
    await teeStderr(Readable.from([Buffer.from('session-one crash\n')]), path);
    // A lazy reconnect reopens the SAME path; the prior session's stderr (the
    // crash reason) must survive, not be wiped by an offset-0 truncate.
    await teeStderr(Readable.from([Buffer.from('session-two\n')]), path);
    expect(readFileSync(path, 'utf8')).toBe('session-one crash\nsession-two\n');
  });

  test('creates the log operator-only (0600), not at the default umask', async () => {
    const path = join(dir, 'traces', 'mcp-db.log');
    await teeStderr(Readable.from([Buffer.from('secret-shaped: Bearer xyz\n')]), path);
    expect(statSync(path).mode & 0o777).toBe(0o600); // no world/group read
  });

  test('rotates at 10 MB, keeping one .1 generation + a fresh active log', async () => {
    const path = join(dir, 'mcp-db.log');
    const a = Buffer.alloc(6 * 1024 * 1024, 0x61); // 6 MB
    const b = Buffer.alloc(5 * 1024 * 1024, 0x62); // 5 MB → 11 MB total crosses the cap
    await teeStderr(Readable.from([a, b]), path);
    expect(existsSync(`${path}.1`)).toBe(true); // the first 6 MB rotated out
    expect(statSync(path).size).toBeLessThan(6 * 1024 * 1024); // active log holds only the post-rotation tail
  });

  test('seeds the rotation counter from an existing log so a reconnect honors the cap', async () => {
    const path = join(dir, 'mcp-db.log');
    // A prior session already left the log near the cap.
    await teeStderr(Readable.from([Buffer.alloc(9 * 1024 * 1024, 0x61)]), path); // 9 MB
    expect(existsSync(`${path}.1`)).toBe(false); // still under the cap → no rotation yet
    // A reconnect appends 2 MB → 11 MB total crosses the cap, so it MUST rotate.
    // The counter is seeded from the existing 9 MB (via fstat), not restarted at 0
    // — otherwise the file would grow to 11 MB, well past the advertised 10 MB cap.
    await teeStderr(Readable.from([Buffer.alloc(2 * 1024 * 1024, 0x62)]), path); // 2 MB
    expect(existsSync(`${path}.1`)).toBe(true); // rotated, not grown past the cap
    expect(statSync(path).size).toBeLessThan(10 * 1024 * 1024); // active log under the cap
  });
});

describe('abortableConnect — the handshake signal bounds transport start too', () => {
  type Args = Parameters<typeof abortableConnect>;
  const dummyTransport = {} as unknown as Args[1];
  // A Client whose connect() NEVER resolves — models an SSE transport.start()
  // that hangs waiting for an `endpoint` event the server never sends.
  const hangingClient = {
    connect: () => new Promise<void>(() => {}),
  } as unknown as Args[0];

  test('a hung connect rejects when the signal fires (does not wait for start)', async () => {
    const started = Date.now();
    await expect(
      abortableConnect(hangingClient, dummyTransport, AbortSignal.timeout(20)),
    ).rejects.toThrow(); // the timeout reason surfaces instead of hanging forever
    expect(Date.now() - started).toBeLessThan(2000); // bounded, not indefinite
  });

  test('an already-aborted signal rejects immediately', async () => {
    await expect(
      abortableConnect(hangingClient, dummyTransport, AbortSignal.abort()),
    ).rejects.toThrow();
  });

  test('resolves when connect completes before any abort', async () => {
    const okClient = { connect: async () => {} } as unknown as Args[0];
    await abortableConnect(okClient, dummyTransport, new AbortController().signal);
  });

  test('passes the signal through to the SDK connect (initialize stays abortable)', async () => {
    let receivedOpts: unknown;
    const spyClient = {
      connect: async (_t: unknown, opts: unknown) => {
        receivedOpts = opts;
      },
    } as unknown as Args[0];
    const ctrl = new AbortController();
    await abortableConnect(spyClient, dummyTransport, ctrl.signal);
    expect(receivedOpts).toEqual({ signal: ctrl.signal });
  });

  test('with no signal → a plain connect (no race)', async () => {
    let called = false;
    const okClient = {
      connect: async () => {
        called = true;
      },
    } as unknown as Args[0];
    await abortableConnect(okClient, dummyTransport, undefined);
    expect(called).toBe(true);
  });

  test('a connect rejection surfaces (not swallowed by the race)', async () => {
    const failClient = {
      connect: async () => {
        throw new Error('handshake boom');
      },
    } as unknown as Args[0];
    await expect(
      abortableConnect(failClient, dummyTransport, new AbortController().signal),
    ).rejects.toThrow('handshake boom');
  });
});
