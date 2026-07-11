// `forja purge` parser tests. Pin the subcommand shape so future
// arg additions to other verbs don't accidentally swallow purge
// tokens, and so the three flags (`--force`, `--json`, `--no-audit`)
// keep their parsed-to-config mapping stable.

import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../src/cli/args.ts';

describe('parseArgs — purge subcommand', () => {
  test('bare `purge` is dry-run with all flags false', () => {
    const r = parseArgs(['purge']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.purge).toEqual({ force: false, json: false, noAudit: false });
    // Mutually exclusive with other run modes: no prompt collected,
    // no help, no version.
    expect(r.args.prompt).toBe('');
    expect(r.args.help).toBe(false);
    expect(r.args.version).toBe(false);
  });

  test('--force sets force=true; other flags default false', () => {
    const r = parseArgs(['purge', '--force']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.purge).toEqual({ force: true, json: false, noAudit: false });
  });

  test('--json sets json on both args.json AND args.purge.json', () => {
    const r = parseArgs(['purge', '--json']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.purge?.json).toBe(true);
    expect(r.args.json).toBe(true);
  });

  test('--no-audit sets noAudit=true; force stays false in dry-run', () => {
    const r = parseArgs(['purge', '--no-audit']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.purge).toEqual({ force: false, json: false, noAudit: true });
  });

  test('all three flags combine', () => {
    const r = parseArgs(['purge', '--force', '--json', '--no-audit']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.purge).toEqual({ force: true, json: true, noAudit: true });
  });

  test('flag order is irrelevant', () => {
    const a = parseArgs(['purge', '--no-audit', '--force']);
    const b = parseArgs(['purge', '--force', '--no-audit']);
    expect(a.ok && b.ok && a.args.purge).toEqual({ force: true, json: false, noAudit: true });
    if (a.ok && b.ok) {
      expect(a.args.purge).toEqual(b.args.purge);
    }
  });

  test('unknown flag is a parse error with helpful message', () => {
    const r = parseArgs(['purge', '--all']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain("unknown flag '--all'");
    expect(r.message).toContain('--force, --json, --no-audit, --help');
  });

  test('--help on purge subcommand sets help true (top-level routes to usage)', () => {
    const r = parseArgs(['purge', '--help']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.help).toBe(true);
    // help short-circuits — no purge config emitted.
    expect(r.args.purge).toBeUndefined();
  });

  test('-h alias mirrors --help', () => {
    const r = parseArgs(['purge', '-h']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.help).toBe(true);
  });

  test("purge subcommand stops prompt collection (operator can't mix)", () => {
    // Subcommand parsers in args.ts dispatch BEFORE the prompt loop,
    // so trailing tokens that aren't recognized flags are parse
    // errors, not silent prompt fragments.
    const r = parseArgs(['purge', '--force', 'some-prompt-text']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain("unknown flag 'some-prompt-text'");
  });

  test('purge does not match a token that merely starts with "purge"', () => {
    // First token must be exactly 'purge' — this catches the parser
    // mistakenly using startsWith / fuzzy match. A near-miss
    // ('purgesomething') falls through to the prompt-collection
    // path and becomes regular prompt text.
    const r = parseArgs(['purgesomething']);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.args.purge).toBeUndefined();
    expect(r.args.prompt).toContain('purgesomething');
  });
});
