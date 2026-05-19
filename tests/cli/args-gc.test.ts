// `agent gc` parser tests. Pins the subcommand shape so future arg
// additions to other verbs don't swallow gc tokens, and the three
// flags (`--force`, `--json`, `--table=X`) keep their parsed-to-config
// mapping stable.

import { describe, expect, test } from 'bun:test';
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
    expect(r.message).toContain("--table='approvals_log' is not a Phase 1 table");
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
