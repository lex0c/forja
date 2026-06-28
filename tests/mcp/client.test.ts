// Unit coverage for the SDK boundary's PURE, defensive parsers — the
// untrusted-input narrowing that the happy-path real-subprocess test can't
// exercise. The SDK-touching `createStdioMcpClient` is covered end-to-end by
// tests/mcp/real-subprocess.test.ts; here we pin the degradation + env-
// isolation properties directly.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildSpawnEnv,
  extractMeta,
  flattenContent,
  normalizeInputSchema,
} from '../../src/mcp/client.ts';

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
