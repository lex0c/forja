// `agent gc` parser tests. Pins the subcommand shape so future arg
// additions to other verbs don't swallow gc tokens, and the three
// flags (`--force`, `--json`, `--table=X`) keep their parsed-to-config
// mapping stable.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';

describe('parseArgs — gc subcommand', () => {
  test('bare `gc` is dry-run with all flags false / no table filter', () => {
    const r = parseArgs(['gc']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc).toEqual({ force: false, json: false, tables: [] });
    expect(r.args.prompt).toBe('');
    expect(r.args.help).toBe(false);
    expect(r.args.version).toBe(false);
  });

  test('--force sets force=true', () => {
    const r = parseArgs(['gc', '--force']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc?.force).toBe(true);
    expect(r.args.gc?.json).toBe(false);
    expect(r.args.gc?.tables).toEqual([]);
  });

  test('--json sets json on both args.json AND args.gc.json', () => {
    const r = parseArgs(['gc', '--json']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc?.json).toBe(true);
    expect(r.args.json).toBe(true);
  });

  test('--table=recap_cache adds to tables array', () => {
    const r = parseArgs(['gc', '--table=recap_cache']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc?.tables).toEqual(['recap_cache']);
  });

  test('--table is repeatable; order preserved', () => {
    const r = parseArgs([
      'gc',
      '--table=context_pins',
      '--table=recap_cache',
      '--table=bg_processes',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc?.tables).toEqual(['context_pins', 'recap_cache', 'bg_processes']);
  });

  test('--table dedupes (same name twice → once)', () => {
    const r = parseArgs(['gc', '--table=recap_cache', '--table=recap_cache']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc?.tables).toEqual(['recap_cache']);
  });

  test('all four Phase 1 table names are accepted', () => {
    const r = parseArgs([
      'gc',
      '--table=recap_cache',
      '--table=retrieval_trace',
      '--table=context_pins',
      '--table=bg_processes',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc?.tables.length).toBe(4);
  });

  test('--table=<unknown> rejects with helpful message', () => {
    const r = parseArgs(['gc', '--table=approvals_log']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain("--table='approvals_log' is not a recognized gc table");
    expect(r.message).toContain('recap_cache');
  });

  test('--table= (empty value) rejects', () => {
    const r = parseArgs(['gc', '--table=']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('--table= requires a value');
  });

  test('combinations: --force + --json + --table', () => {
    const r = parseArgs(['gc', '--force', '--json', '--table=bg_processes']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc).toEqual({
      force: true,
      json: true,
      tables: ['bg_processes'],
    });
  });

  test('unknown flag is a parse error', () => {
    const r = parseArgs(['gc', '--all']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain("unknown flag '--all'");
  });

  test('--help on gc subcommand sets help true', () => {
    const r = parseArgs(['gc', '--help']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.help).toBe(true);
    expect(r.args.gc).toBeUndefined();
  });

  test('gc does not match prefix-only tokens', () => {
    const r = parseArgs(['gcsomething']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.gc).toBeUndefined();
    expect(r.args.prompt).toContain('gcsomething');
  });
});

describe('parseArgs — independence from gc runtime', () => {
  // Operator-reported bug: parseArgs statically imported GC_TABLES
  // from audit/gc.ts, which pulled the full storage/memory graph
  // (eviction-events → memory/scanner, all repos, etc.) at module
  // load time. Lightweight commands (--help, --version, plain
  // prompt) would fail whenever any deep storage dep was
  // unavailable — broken native binding, partial install, missing
  // peer dep — because args.ts is loaded by every entrypoint.
  //
  // Fix: extract the table constants into audit/gc-tables.ts (a
  // zero-imports module) and import them from there in args.ts.
  // The orchestrator + CLI handler keep using audit/gc.ts (which
  // re-exports the table symbols for backward compat).
  //
  // This pin is a STATIC source check — there's no easy way to
  // simulate "storage dep missing" at runtime in a unit test, but
  // we can guarantee the import graph stays narrow by inspecting
  // the file content.

  const argsSource = readFileSync(resolve('src/cli/args.ts'), 'utf-8');

  test('args.ts does NOT statically import from audit/gc.ts (heavy graph)', () => {
    // Negative polarity: the runtime module pulls storage repos +
    // memory chain. parseArgs must NOT depend on those at module
    // load time — `agent --help` / `--version` rely on it.
    expect(argsSource).not.toMatch(/from\s+['"]\.\.\/audit\/gc\.ts['"]/);
  });

  test('args.ts DOES import from audit/gc-tables.ts (zero-imports module)', () => {
    // Positive polarity: the table list is the single source of
    // truth. Importing from gc-tables.ts (instead of inlining a
    // copy here) preserves the drift-guard property — adding a
    // table to GC_TABLES automatically widens the parser's
    // --table=X accept-set.
    expect(argsSource).toMatch(/from\s+['"]\.\.\/audit\/gc-tables\.ts['"]/);
  });

  test('gc-tables.ts has ZERO imports (load-bearing for args.ts independence)', () => {
    // If anyone adds an import here, args.ts inherits the coupling
    // and lightweight commands become fragile again. This test
    // catches that regression at the source-content level.
    const tablesSource = readFileSync(resolve('src/audit/gc-tables.ts'), 'utf-8');
    expect(tablesSource).not.toMatch(/^import\s+/m);
  });
});
