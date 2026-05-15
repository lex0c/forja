// Dispatch rewrite tests (FEEDBACK_ADAPTATION §9.1, slice 3.5b).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rewriteCommandBinary } from '../../src/feedback/bash-parser.ts';
import { maybeRewriteBashCommand } from '../../src/feedback/dispatch-rewrite.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createPolicy } from '../../src/storage/repos/policies.ts';

let db: DB;

const CHAIN = {
  session: 'sess-1',
  repo: '/repo/path',
  user: 'global',
  language: 'unknown',
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe('rewriteCommandBinary', () => {
  test('replaces leading binary preserving args', () => {
    expect(rewriteCommandBinary('grep -r foo src/', 'ripgrep')).toBe('ripgrep -r foo src/');
  });

  test('preserves env prefix', () => {
    expect(rewriteCommandBinary('FOO=1 grep -r foo', 'ripgrep')).toBe('FOO=1 ripgrep -r foo');
  });

  test('preserves cd && prefix', () => {
    expect(rewriteCommandBinary('cd /tmp && grep foo', 'ripgrep')).toBe('cd /tmp && ripgrep foo');
  });

  test('preserves leading whitespace', () => {
    expect(rewriteCommandBinary('  grep -r foo', 'ripgrep')).toBe('  ripgrep -r foo');
  });

  test('absolute path binary replaced with bare new binary', () => {
    expect(rewriteCommandBinary('/usr/bin/grep -r foo', 'ripgrep')).toBe('ripgrep -r foo');
  });

  test('relative path binary replaced with bare new binary', () => {
    expect(rewriteCommandBinary('./grep -r foo', 'ripgrep')).toBe('ripgrep -r foo');
  });

  test('null on quoted command (bail like extractLeadingBinary)', () => {
    expect(rewriteCommandBinary('cd "/tmp" && grep foo', 'ripgrep')).toBeNull();
  });

  test('null on empty input', () => {
    expect(rewriteCommandBinary('', 'ripgrep')).toBeNull();
  });

  test('null on degenerate command (just a dot)', () => {
    expect(rewriteCommandBinary('.', 'ripgrep')).toBeNull();
  });

  test('multi-cd chain preserved', () => {
    expect(rewriteCommandBinary('cd /a && cd /b && grep foo', 'ripgrep')).toBe(
      'cd /a && cd /b && ripgrep foo',
    );
  });

  test('multi-env prefix preserved', () => {
    expect(rewriteCommandBinary('FOO=1 BAR=2 grep foo', 'ripgrep')).toBe('FOO=1 BAR=2 ripgrep foo');
  });

  test('args containing the same binary name not rewritten', () => {
    // Splice only the LEADING token. `grep grep foo` rewrites
    // the first `grep` (the binary), leaving the args alone.
    expect(rewriteCommandBinary('grep grep foo', 'ripgrep')).toBe('ripgrep grep foo');
  });

  test('parens-wrapped command bails uniformly (no offset corruption)', () => {
    // Previous implementation tried to handle parens and produced
    // garbage on whitespace inside. Refactor bails on parens —
    // safer than risking corrupted output.
    expect(rewriteCommandBinary('( cd /tmp && grep foo )', 'ripgrep')).toBeNull();
    expect(rewriteCommandBinary('(cd /tmp && grep foo)', 'ripgrep')).toBeNull();
  });

  test('SECURITY: newBinary with shell metas refused', () => {
    expect(rewriteCommandBinary('grep foo', '; rm -rf /')).toBeNull();
    expect(rewriteCommandBinary('grep foo', 'rg foo')).toBeNull();
    expect(rewriteCommandBinary('grep foo', '/usr/bin/rg')).toBeNull();
    expect(rewriteCommandBinary('grep foo', 'rg|sh')).toBeNull();
  });
});

describe('maybeRewriteBashCommand — happy path', () => {
  test('rewrites grep → ripgrep when active policy exists', () => {
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'active',
    });
    const r = maybeRewriteBashCommand(db, 'grep -r foo src/', CHAIN);
    expect(r.rewritten).toBe(true);
    expect(r.command).toBe('ripgrep -r foo src/');
    expect(r.appliedSignature).toBe('alias:grep:ripgrep');
    expect(r.matchedScope).toBe('session');
    expect(r.appliedPolicyId).toBeTruthy();
  });

  test('does not rewrite when policy is proposed (not active)', () => {
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'proposed',
    });
    const r = maybeRewriteBashCommand(db, 'grep -r foo', CHAIN);
    expect(r.rewritten).toBe(false);
    expect(r.command).toBe('grep -r foo');
  });

  test('does not rewrite when no policy exists at any scope', () => {
    const r = maybeRewriteBashCommand(db, 'grep -r foo', CHAIN);
    expect(r.rewritten).toBe(false);
  });

  test('does not rewrite when leading binary is not in the alias table', () => {
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'active',
    });
    // `ls` isn't in KNOWN_BASH_ALIASES — no rewrite even if a
    // grep policy exists.
    const r = maybeRewriteBashCommand(db, 'ls -la', CHAIN);
    expect(r.rewritten).toBe(false);
  });

  test('self-alias policy does NOT rewrite (no-op skipped)', () => {
    // Loop frio might propose alias:sed:sed (self-alias) for
    // pure tally; operator-promoted self-aliases shouldn't
    // mutate the dispatch.
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:sed:sed',
      actionJson: JSON.stringify({ target: 'sed' }),
      state: 'active',
    });
    const r = maybeRewriteBashCommand(db, 'sed -i s/foo/bar/ x', CHAIN);
    expect(r.rewritten).toBe(false);
  });

  test('global-scope policy still applies', () => {
    createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'active',
    });
    const r = maybeRewriteBashCommand(db, 'grep -r foo', CHAIN);
    expect(r.rewritten).toBe(true);
    expect(r.matchedScope).toBe('global');
  });

  test('more-specific scope wins over global', () => {
    createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-global' }),
      state: 'active',
    });
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-session' }),
      state: 'active',
    });
    const r = maybeRewriteBashCommand(db, 'grep -r foo', CHAIN);
    expect(r.rewritten).toBe(true);
    expect(r.matchedScope).toBe('session');
    expect(r.command).toBe('rg-session -r foo');
  });
});

describe('maybeRewriteBashCommand — defensive', () => {
  test('malformed action_json skips rewrite', () => {
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: 'not-json',
      state: 'active',
    });
    const r = maybeRewriteBashCommand(db, 'grep foo', CHAIN);
    expect(r.rewritten).toBe(false);
  });

  test('action_json missing target field skips rewrite', () => {
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({}),
      state: 'active',
    });
    const r = maybeRewriteBashCommand(db, 'grep foo', CHAIN);
    expect(r.rewritten).toBe(false);
  });

  test('SECURITY: target with shell metacharacters refused (injection guard)', () => {
    // Probe: poisoned action_json carrying shell metas. Without
    // target validation, the rewrite would splice `; rm -rf /` into
    // the command and the permission engine (which sees the REWRITTEN
    // string) would evaluate the wrong allow-list against it.
    const targets = [
      '; rm -rf /',
      'ripgrep --extra',
      '/usr/bin/ripgrep',
      'rg foo',
      'rg;rm',
      'rg|sh',
      'rg\nrm',
      'rg`evil`',
      '$(rg)',
    ];
    for (const target of targets) {
      // Re-init DB per target since createPolicy persists.
      db.close();
      db = openMemoryDb();
      migrate(db);
      createPolicy(db, {
        scopeKind: 'session',
        scopeId: CHAIN.session,
        actionSignature: 'alias:grep:ripgrep',
        actionJson: JSON.stringify({ target }),
        state: 'active',
      });
      const r = maybeRewriteBashCommand(db, 'grep foo', CHAIN);
      expect(r.rewritten).toBe(false);
      expect(r.command).toBe('grep foo');
    }
  });

  test('SECURITY: target with path prefix refused (no path injection)', () => {
    // A path-prefixed target would override the operator's PATH
    // resolution. Refuse — bare binary names only; PATH wins.
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: './ripgrep' }),
      state: 'active',
    });
    const r = maybeRewriteBashCommand(db, 'grep foo', CHAIN);
    expect(r.rewritten).toBe(false);
  });

  test('unparseable command (quotes) returns un-rewritten', () => {
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: CHAIN.session,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'active',
    });
    // The leading-binary parser returns null when it can't safely
    // parse — no rewrite applied even though a policy matches.
    const r = maybeRewriteBashCommand(db, 'cd "/tmp" && grep foo', CHAIN);
    expect(r.rewritten).toBe(false);
  });
});
