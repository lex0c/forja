// Canonical `.forja/config.toml` writer (src/config/writer.ts).
//
// Covers the two responsibilities:
//   - emitTomlDoc: parse → mutate → emit round-trip, including the
//     nested-table preservation that the flat-only predecessor (lived in
//     memory.ts) silently dropped (`[audit.retention]`).
//   - persistModelPin: write `[providers].model`, preserve every other
//     section verbatim, and — crucially — DON'T rewrite when the pin is
//     already the requested id (compare-before-write, no churn).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitTomlDoc, persistModelPin } from '../../src/config/writer.ts';

let workdir: string;
let configPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-writer-'));
  configPath = join(workdir, '.forja', 'config.toml');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('emitTomlDoc', () => {
  test('empty doc emits empty string', () => {
    expect(emitTomlDoc({})).toBe('');
  });

  test('flat sections round-trip through Bun.TOML.parse identically', () => {
    const doc = {
      providers: { model: 'anthropic/claude-opus-4-8' },
      budget: { max_steps: 200, compaction_relevance: true },
    };
    const reparsed = Bun.TOML.parse(emitTomlDoc(doc));
    expect(reparsed).toEqual(doc);
  });

  test('root-level scalar keys are emitted BEFORE any table header', () => {
    // TOML requires bare top-level keys to precede table headers;
    // otherwise they'd parse as belonging to the last table.
    const out = emitTomlDoc({ top: 'v', section: { k: 1 } });
    expect(out.indexOf('top =')).toBeLessThan(out.indexOf('[section]'));
    expect(Bun.TOML.parse(out)).toEqual({ top: 'v', section: { k: 1 } });
  });

  test('nested tables ([audit.retention]) survive the round-trip (regression)', () => {
    // The flat-only predecessor dropped any non-scalar sub-table — an
    // operator's hand-added [audit.retention] vanished on every rewrite.
    const doc = {
      providers: { model: 'anthropic/claude-haiku-4-5' },
      audit: { run_gc_on_stop: true, retention: { recap_cache: 30, context_pins: 90 } },
    };
    const out = emitTomlDoc(doc);
    expect(out).toContain('[audit.retention]');
    expect(Bun.TOML.parse(out)).toEqual(doc);
  });

  test('string values with quotes / newlines are escaped', () => {
    const doc = { s: { v: 'a"b\nc' } };
    expect(Bun.TOML.parse(emitTomlDoc(doc))).toEqual(doc);
  });
});

describe('persistModelPin', () => {
  test('fresh repo: creates .forja/config.toml with [providers].model, returns written', () => {
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-opus-4-8' });
    expect(r.kind).toBe('written');
    expect(existsSync(configPath)).toBe(true);
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as {
      providers: { model: string };
    };
    expect(parsed.providers.model).toBe('anthropic/claude-opus-4-8');
  });

  test('preserves unrelated sections (incl. nested [audit.retention]) when pinning', () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      configPath,
      `[budget]
max_steps = 200

[audit.retention]
recap_cache = 30
`,
    );
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-haiku-4-5' });
    expect(r.kind).toBe('written');
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as {
      providers: { model: string };
      budget: { max_steps: number };
      audit: { retention: { recap_cache: number } };
    };
    expect(parsed.providers.model).toBe('anthropic/claude-haiku-4-5');
    expect(parsed.budget.max_steps).toBe(200);
    // The regression guard: the nested table is NOT dropped on the pin.
    expect(parsed.audit.retention.recap_cache).toBe(30);
  });

  test('replaces a different existing model in place (no duplicate [providers])', () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(configPath, '[providers]\nmodel = "anthropic/claude-opus-4-8"\n');
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-haiku-4-5' });
    expect(r.kind).toBe('written');
    const raw = readFileSync(configPath, 'utf8');
    expect((raw.match(/^\[providers\]$/gm) ?? []).length).toBe(1);
    expect(raw).toContain('model = "anthropic/claude-haiku-4-5"');
    expect(raw).not.toContain('claude-opus-4-8');
  });

  test('already-pinned id is a no-op: returns unchanged WITHOUT rewriting', () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    // A comment is the canary — the round-trip would strip it, so its
    // survival proves no rewrite happened.
    const original = `# operator comment
[providers]
model = "anthropic/claude-opus-4-8"
`;
    writeFileSync(configPath, original);
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-opus-4-8' });
    expect(r.kind).toBe('unchanged');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  test('malformed TOML refuses to write and leaves the file untouched', () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    const broken = '[providers\nmodel = "x"\n';
    writeFileSync(configPath, broken);
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-haiku-4-5' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.reason).toContain('malformed');
    expect(readFileSync(configPath, 'utf8')).toBe(broken);
  });

  test('BOM-prefixed config does NOT lose its other sections on a pin (regression)', () => {
    // Bun.TOML.parse returns {} for a BOM-prefixed doc; without the BOM
    // strip in readTomlDoc, the pin would read an empty doc and clobber
    // every section. The strip makes the existing content survive.
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    writeFileSync(
      configPath,
      `﻿[providers]
model = "anthropic/claude-opus-4-8"

[audit]
run_gc_on_stop = true
`,
    );
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-haiku-4-5' });
    expect(r.kind).toBe('written');
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as {
      providers: { model: string };
      audit: { run_gc_on_stop: boolean };
    };
    expect(parsed.providers.model).toBe('anthropic/claude-haiku-4-5');
    expect(parsed.audit.run_gc_on_stop).toBe(true);
  });

  test('array-of-tables elsewhere in the doc → failed, file left untouched', () => {
    // emitTomlDoc can't represent `[[…]]`; rather than silently emit
    // `servers = ["",""]` and destroy the data, the write fails and the
    // caller keeps the file as-is.
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    const original = `[providers]
model = "anthropic/claude-opus-4-8"

[[servers]]
name = "a"

[[servers]]
name = "b"
`;
    writeFileSync(configPath, original);
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-haiku-4-5' });
    expect(r.kind).toBe('failed');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });

  test('[providers] that is not a table is refused, not overwritten', () => {
    mkdirSync(join(workdir, '.forja'), { recursive: true });
    const original = '[[providers]]\nmodel = "anthropic/claude-opus-4-8"\n';
    writeFileSync(configPath, original);
    const r = persistModelPin({ filePath: configPath, modelId: 'anthropic/claude-haiku-4-5' });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.reason).toContain('not a table');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });
});

describe('emitTomlDoc: unsupported shapes throw (caught upstream → failed write)', () => {
  test('array-of-tables value throws rather than corrupting to empty strings', () => {
    expect(() => emitTomlDoc({ servers: [{ name: 'a' }, { name: 'b' }] })).toThrow(
      /array-of-tables|inline table/,
    );
  });

  test('plain string arrays still serialize fine (no false positive)', () => {
    const doc = { sandbox: { writable_cache_dirs: ['.cache', '.npm'] } };
    expect(Bun.TOML.parse(emitTomlDoc(doc))).toEqual(doc);
  });
});
