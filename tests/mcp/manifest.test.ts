import { describe, expect, test } from 'bun:test';
import {
  canonicalManifestJson,
  canonicalizeManifest,
  hashManifest,
} from '../../src/mcp/manifest.ts';
import type { CanonicalManifest, McpManifestTool } from '../../src/mcp/types.ts';

const tool = (name: string, over: Partial<McpManifestTool> = {}): McpManifestTool => ({
  name,
  description: `desc ${name}`,
  inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  meta: { writes: false, category: 'mcp' },
  ...over,
});

const manifest = (
  tools: McpManifestTool[],
  over: Partial<CanonicalManifest> = {},
): CanonicalManifest => ({
  server: 'postgres',
  protocolVersion: '2024-11-05',
  serverVersion: '1.0.0',
  tools,
  ...over,
});

describe('hashManifest: determinism', () => {
  test('same manifest → same hash', () => {
    expect(hashManifest(manifest([tool('a'), tool('b')]))).toBe(
      hashManifest(manifest([tool('a'), tool('b')])),
    );
  });

  test('tool order does not affect the hash', () => {
    expect(hashManifest(manifest([tool('a'), tool('b')]))).toBe(
      hashManifest(manifest([tool('b'), tool('a')])),
    );
  });

  test('hash is a 64-char lowercase hex sha256', () => {
    expect(hashManifest(manifest([tool('a')]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashManifest: coverage (any tool field change re-prompts)', () => {
  const base = hashManifest(manifest([tool('q')]));

  test('description change → different hash', () => {
    expect(hashManifest(manifest([tool('q', { description: 'other' })]))).not.toBe(base);
  });

  test('inputSchema change → different hash', () => {
    expect(
      hashManifest(manifest([tool('q', { inputSchema: { type: 'object', properties: {} } })])),
    ).not.toBe(base);
  });

  test('meta.writes flip → different hash (privilege-escalation guard)', () => {
    expect(
      hashManifest(manifest([tool('q', { meta: { writes: true, category: 'mcp' } })])),
    ).not.toBe(base);
  });

  test('meta.category change → different hash', () => {
    expect(
      hashManifest(manifest([tool('q', { meta: { writes: false, category: 'fs.read' } })])),
    ).not.toBe(base);
  });

  test('serverVersion change → different hash', () => {
    expect(hashManifest(manifest([tool('q')], { serverVersion: '2.0.0' }))).not.toBe(base);
  });

  test('adding a tool → different hash', () => {
    expect(hashManifest(manifest([tool('q'), tool('r')]))).not.toBe(base);
  });
});

describe('hashManifest: protocolVersion is NOT hashed', () => {
  test('a protocol bump alone keeps the same hash', () => {
    expect(hashManifest(manifest([tool('a')], { protocolVersion: '2025-06-18' }))).toBe(
      hashManifest(manifest([tool('a')], { protocolVersion: '2024-11-05' })),
    );
  });
});

describe('canonicalizeManifest', () => {
  test('sorts tools by name', () => {
    const c = canonicalizeManifest({
      server: 's',
      protocolVersion: 'p',
      serverVersion: null,
      tools: [tool('zulu'), tool('alpha'), tool('mike')],
    });
    expect(c.tools.map((t) => t.name)).toEqual(['alpha', 'mike', 'zulu']);
  });

  test('canonicalManifestJson is stable and is what the hash digests', () => {
    const m = manifest([tool('b'), tool('a')]);
    const json = canonicalManifestJson(m);
    expect(json).toBe(canonicalManifestJson(canonicalizeManifest(m)));
    // tools serialized in sorted order regardless of input order
    expect(json.indexOf('"name":"a"')).toBeLessThan(json.indexOf('"name":"b"'));
  });
});
