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
import {
  buildSpawnEnv,
  createStdioMcpClient,
  extractMeta,
  flattenContent,
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
});
