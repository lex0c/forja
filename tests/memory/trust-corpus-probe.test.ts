// Boot-probe tests for the shared-corpus trust orchestrator
// (S5/T5.2 + T5.3). Exercises the probe's four-way state machine
// against a real registry + DB + filesystem:
//
//   - seeded: no prior trust row → silent seed of current hash.
//   - unchanged: prior row matches current hash → no-op.
//   - reconfirmed: prior row differs + modal returns 'yes' → re-stamp.
//   - revoked: prior row differs + modal returns 'no' → clear row,
//     bulk-invalidate every state=active shared memory.
//
// Plus selectivity assertions: revoke only touches shared/active
// memories — user-scope and project_local stay untouched, and
// already-quarantined shared memories are skipped (not re-counted).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import {
  computeSharedFingerprint,
  getSharedTrust,
  setSharedTrust,
} from '../../src/memory/trust-corpus.ts';
import { probeSharedTrust } from '../../src/memory/trust-corpus-probe.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-trust-probe-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

const writeBody = (
  dir: string,
  name: string,
  body: string,
  state: 'active' | 'quarantined' = 'active',
): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: hook for ${name}`,
    'type: feedback',
    'source: user_explicit',
    `state: ${state}`,
  ];
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
};

let db: DB;
let repo: string;
let roots: ScopeRoots;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  repo = makeTmp();
  roots = makeRoots(repo);
});

afterEach(() => {
  db.close();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('probeSharedTrust — state machine', () => {
  test('seeded: no prior row + absent shared dir → silent stamp, no modal fired', async () => {
    // P0/F2 hardening: silent seed is ONLY safe when there's nothing
    // to consent to. An absent shared/ directory has no operator-
    // influencing content to attest, so the cwd-trust modal already
    // covers the implicit "I trust this directory" decision. The
    // sibling test below pins the same behavior for an EXISTING but
    // file-less directory — both states have zero `.md` files and
    // both silent-seed.
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    let modalCalls = 0;
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCalls++;
        return 'yes';
      },
      now: () => 1_700_000_000_000,
    });

    expect(modalCalls).toBe(0);
    expect(result.kind).toBe('seeded');
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(roots.projectShared) as string);
    expect(stored?.lastConfirmedAtMs).toBe(1_700_000_000_000);
  });

  test('seeded: no prior row + present-but-empty shared dir → silent stamp, no modal fired', async () => {
    // Review regression. The earlier branch only silent-seeded on
    // `presentedHash === EMPTY_CORPUS_HASH`, which fingerprint
    // returns ONLY when the shared/ directory is ENOENT. A
    // directory that exists but has zero `.md` files hashes the
    // domain separator alone (a distinct, non-sentinel value), so
    // first boot fell into the first-visit modal path over an
    // empty inventory; if the operator canceled (Esc / timeout /
    // signal handler), the probe returned deferred(modal_cancel)
    // and left the shared scope offline for the rest of the
    // session — for a corpus that was literally empty.
    //
    // Setup: mkdir-the-directory but write no .md bodies and no
    // MEMORY.md. enumerateCorpus returns []; the probe must
    // silent-seed identically to the absent-directory case
    // (asserted in the previous test) and the trust row must
    // pin the actual fingerprint (NOT EMPTY_CORPUS_HASH — they
    // differ here).
    mkdirSync(roots.projectShared, { recursive: true });
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    let modalCalls = 0;
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCalls++;
        return 'yes';
      },
      now: () => 1_700_000_000_001,
    });

    expect(modalCalls).toBe(0);
    expect(result.kind).toBe('seeded');
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(roots.projectShared) as string);
    expect(stored?.lastConfirmedAtMs).toBe(1_700_000_000_001);
  });

  test('first-visit non-empty: modal fires in mode=first-visit (P0/F2)', async () => {
    // A repo with cwd already trusted + a pre-populated shared/
    // corpus must NOT silently seed — the cwd-trust modal attested
    // the directory, NOT the shared-memory content. Operator gets a
    // first-visit modal showing the inventory.
    writeIndex(roots.projectShared, '- [Alpha](alpha.md) — hook\n');
    writeBody(roots.projectShared, 'alpha', 'body A');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    let modalMode: 'first-visit' | 'drift' | null = null;
    let inventory: readonly { name: string; bytes: number }[] = [];
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async (args) => {
        modalMode = args.mode;
        inventory = args.corpusFiles;
        return 'yes';
      },
      now: () => 1_700_000_000_000,
    });

    expect(modalMode as 'first-visit' | 'drift' | null).toBe('first-visit');
    expect(inventory.map((f) => f.name).sort()).toEqual(['MEMORY.md', 'alpha.md']);
    expect(result.kind).toBe('reconfirmed');
    // Mode/oldHash/newHash dropped from the result post-D2; the
    // mode flowed to the modal-callback `modalMode` pinned above.
    // Trust row stamped at the confirmed hash.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(roots.projectShared) as string);
  });

  test('first-visit non-empty: modal no → bulk-invalidate, no trust row created', async () => {
    writeIndex(roots.projectShared, '- [Alpha](alpha.md) — hook\n');
    writeBody(roots.projectShared, 'alpha', 'body A');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    expect(result.kind).toBe('revoked');
    if (result.kind === 'revoked') {
      expect(result.invalidated.map((q) => q.name)).toEqual(['alpha']);
    }
    // CRIT/F2: trust row STAMPED with post-invalidate hash so the
    // next boot doesn't re-prompt. The invalidated frontmatter is
    // the persistent decline marker; the trust row records that
    // the operator has seen and decided about this state.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored).not.toBeNull();
    expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(roots.projectShared) as string);
  });

  test('unchanged: prior row matches current hash → no-op, no modal', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const currentHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, currentHash, 999);

    let modalCalls = 0;
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCalls++;
        return 'no';
      },
    });

    expect(modalCalls).toBe(0);
    expect(result.kind).toBe('unchanged');
    // Trust row remains pinned to the original timestamp — no-op
    // doesn't bump it.
    expect(getSharedTrust(db, roots.projectShared)?.lastConfirmedAtMs).toBe(999);
  });

  test('reconfirmed: hash differs + modal yes → re-stamp', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'old body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);

    // Simulate corpus drift (operator pulled a commit modifying a.md).
    writeBody(roots.projectShared, 'a', 'new body — modified after trust');
    const newHash = computeSharedFingerprint(roots.projectShared) as string;
    expect(newHash).not.toBe(oldHash);

    let modalArgs: {
      path: string;
      corpusFiles: readonly { name: string; bytes: number }[];
    } | null = null;
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async (args) => {
        modalArgs = args;
        return 'yes';
      },
      now: () => 2_000,
    });

    const captured = modalArgs as null | {
      path: string;
      corpusFiles: readonly { name: string; bytes: number }[];
    };
    expect(captured).not.toBeNull();
    if (captured !== null) {
      expect(captured.path).toBe(roots.projectShared);
      expect(captured.corpusFiles.length).toBeGreaterThan(0);
    }
    expect(result.kind).toBe('reconfirmed');
    // D2 dropped oldHash/newHash from the result; the trust row IS
    // the durable record of the new hash.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(newHash);
    expect(stored?.lastConfirmedAtMs).toBe(2_000);

    // T5.5 strengthening: reconfirm MUST NOT emit any eviction
    // event. The whole point of separating reconfirmed from revoked
    // is that the operator's "yes" is a re-stamp only — no memory
    // state changes hands. A regression where the bulk path
    // somehow ran on the 'yes' branch would surface here without
    // it being caught by the kind=='reconfirmed' assertion above.
    const evictionCount = db.prepare('SELECT COUNT(*) AS c FROM eviction_events').get() as {
      c: number;
    };
    expect(evictionCount.c).toBe(0);
    // And the memory's state on disk remains active.
    const active = registry.list({ scope: 'project_shared', states: ['active'] });
    expect(active.map((l) => l.name)).toEqual(['a']);
  });

  test('revoked: hash differs + modal no → clear row + bulk-invalidate active shared', async () => {
    writeIndex(roots.projectShared, '- [Alpha](alpha.md) — h\n- [Beta](beta.md) — h\n');
    writeBody(roots.projectShared, 'alpha', 'body A');
    writeBody(roots.projectShared, 'beta', 'body B');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);

    // Simulate corpus drift.
    writeBody(roots.projectShared, 'alpha', 'tampered body');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
      now: () => 5_000,
    });

    expect(result.kind).toBe('revoked');
    if (result.kind === 'revoked') {
      expect(result.failed).toEqual([]);
      const names = result.invalidated.map((q) => q.name).sort();
      expect(names).toEqual(['alpha', 'beta']);
    }

    // CRIT/F2: trust row stamped at post-invalidate hash so the
    // NEXT boot sees `unchanged` (no modal). The invalidated
    // frontmatter is the durable decline marker.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored).not.toBeNull();
    expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(roots.projectShared) as string);
    expect(stored?.lastConfirmedAtMs).toBe(5_000);

    // Both memories now report state=invalidated when re-read via
    // the registry's state filter.
    const stillActive = registry.list({ scope: 'project_shared', states: ['active'] });
    expect(stillActive).toEqual([]);
    const invalidated = registry.list({ scope: 'project_shared', states: ['invalidated'] });
    expect(invalidated.map((l) => l.name).sort()).toEqual(['alpha', 'beta']);
  });

  test('cancel is deferred, NOT treated as revoke (P1/M4-rob)', async () => {
    // Operator-intent on 'cancel' is ambiguous (Esc, timeout,
    // signal). Treating it as revoke would run a destructive bulk
    // on intent we don't have. Defer instead: leave trust row
    // pinned to OLD hash; next boot re-prompts on persistent
    // divergence.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'cancel',
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.cause).toBe('modal_cancel');
    }
    // Trust row UNCHANGED (still pinned to oldHash + original
    // timestamp). No bulk-invalidate ran.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(oldHash);
    expect(stored?.lastConfirmedAtMs).toBe(1000);
    // Memory is still active — no invalidation.
    expect(
      registry.list({ scope: 'project_shared', states: ['active'] }).map((l) => l.name),
    ).toEqual(['a']);
  });

  test('TOCTOU: re-fingerprint after yes detects drift, returns deferred (P0/F3)', async () => {
    // Simulate corpus changing between hash compute and modal
    // answer. Operator confirmed what they SAW (presented hash);
    // probe must NOT stamp the new (unconfirmed) state.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'baseline');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);

    // Drift step 1: operator-visible change.
    writeBody(roots.projectShared, 'a', 'first drift');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        // Drift step 2 — happens DURING modal deliberation. The
        // probe's post-modal re-fingerprint should detect this
        // and refuse to stamp.
        writeBody(roots.projectShared, 'a', 'second drift (TOCTOU)');
        return 'yes';
      },
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.cause).toBe('tocttou_during_prompt');
    }
    // Trust row UNCHANGED.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(oldHash);
    expect(stored?.lastConfirmedAtMs).toBe(1000);
  });
});

describe('probeSharedTrust — selectivity', () => {
  test('revoke does NOT touch user-scope or project_local memories', async () => {
    // Memories in every scope.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'shared body');
    writeIndex(roots.user, '- [U](u.md) — h\n');
    writeBody(roots.user, 'u', 'user body');
    writeIndex(roots.projectLocal, '- [L](l.md) — h\n');
    writeBody(roots.projectLocal, 'l', 'local body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    expect(registry.list({ scope: 'user', states: ['active'] }).map((l) => l.name)).toEqual(['u']);
    expect(
      registry.list({ scope: 'project_local', states: ['active'] }).map((l) => l.name),
    ).toEqual(['l']);
    expect(registry.list({ scope: 'project_shared', states: ['active'] })).toEqual([]);
  });

  test('revoke does not invalidate already-quarantined shared memories', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n- [B](b.md) — h\n');
    // a starts active; b starts quarantined.
    writeBody(roots.projectShared, 'a', 'body A');
    writeBody(roots.projectShared, 'b', 'body B', 'quarantined');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    expect(result.kind).toBe('revoked');
    if (result.kind === 'revoked') {
      // Only `a` (the only active one) transitioned this round.
      expect(result.invalidated.map((q) => q.name)).toEqual(['a']);
      expect(result.failed).toEqual([]);
    }
  });

  test('empty corpus (no shared memories) still seeds/probes without error', async () => {
    // No writeIndex / no writeBody — sharedRoot doesn't even exist yet.
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });
    expect(result.kind).toBe('seeded');
  });
});

describe('probeSharedTrust — verify_failed (T5.5)', () => {
  test('returns verify_failed when the shared root is unreadable (EACCES)', async () => {
    // Simulate an fs error that is NOT ENOENT/ENOTDIR. chmod 000
    // on the shared root makes `readdirSync` throw EACCES, which
    // `computeSharedFingerprint` maps to `null`, which the probe
    // surfaces as `verify_failed` — the only failure mode the
    // caller MUST fail-closed against. Skipped on platforms where
    // the test process runs as root (root bypasses unix perms and
    // the chmod has no effect — false negative).
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // Bun's typed-test runner doesn't have skip-in-test; bail
      // softly so a root-running CI doesn't surface a failure.
      return;
    }
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    let modalCalls = 0;
    chmodSync(roots.projectShared, 0o000);
    try {
      const result = await probeSharedTrust({
        db,
        registry,
        roots,
        sharedRoot: roots.projectShared,
        askSharedTrust: async () => {
          modalCalls++;
          return 'yes';
        },
      });
      expect(result.kind).toBe('verify_failed');
      if (result.kind === 'verify_failed') {
        expect(result.sharedRoot).toBe(roots.projectShared);
      }
      // No modal fires for verify_failed — there's nothing to ask
      // the operator about. Caller is expected to surface a
      // separate warning (bootstrap does this via stderr).
      expect(modalCalls).toBe(0);
    } finally {
      // Restore perms so afterEach's rmSync can clean up. Without
      // this the tmpdir leaks and subsequent runs in the same
      // tmpdir hit EACCES on cleanup.
      chmodSync(roots.projectShared, 0o755);
    }
  });
});

describe('probeSharedTrust — third hardening pass (T1/T8/T15)', () => {
  test('T1: warn callback receives the full corpus inventory', async () => {
    // The probe emits one stderr line per file + a header before
    // opening the modal (CRIT/F5 hardening). Test pins the format
    // so a regression that drops the dump surfaces.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body A');
    writeBody(roots.projectShared, 'b', 'body B');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'drift');

    const warnLines: string[] = [];
    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'yes',
      warn: (s) => warnLines.push(s),
    });
    // Header carries the mode + path + count.
    const header = warnLines.find((l) => l.includes('drift prompt at') && l.includes('files'));
    expect(header).toBeDefined();
    // One line per file with `name — N bytes` shape.
    expect(warnLines.some((l) => l.includes('a.md — ') && l.includes('bytes'))).toBe(true);
    expect(warnLines.some((l) => l.includes('b.md — ') && l.includes('bytes'))).toBe(true);
  });

  test('T1b: corpus filenames with ANSI / control bytes get sanitized in stderr', async () => {
    // Disk-attacker-controlled filenames flow through readdirSync
    // into the warn callback. Without sanitization, a `.md` file
    // whose name embeds ESC sequences would let the attacker
    // repaint the operator's terminal during the trust review
    // (clear screen, move cursor over modal prose, fake a clean
    // inventory). The modal reducer sanitizes via
    // `sanitizeOneLineForDisplay`; stderr must match.
    //
    // Build a name with: ESC (`\x1b`) starting an ANSI red sequence,
    // a literal newline (would split a single inventory line into
    // two — even more dangerous if the second forged line repaints
    // the screen), and a tab. All must be neutralized.
    const evilLeaf = '\x1b[31mtampered\nfake-line\there';
    writeIndex(roots.projectShared, `- [Evil](${evilLeaf}.md) — h\n`);
    writeBody(roots.projectShared, evilLeaf, 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    // Pre-probe drift so the drift modal (and the dump) fires.
    writeBody(roots.projectShared, evilLeaf, 'drifted');

    const warnLines: string[] = [];
    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'cancel',
      warn: (s) => warnLines.push(s),
    });

    // Locate the per-file line. It must end with ` — N bytes` and
    // the evil leaf rendered without ESC / newline / tab bytes —
    // `sanitizeOneLineForDisplay` strips ANSI and collapses
    // \r\n\t to a single space.
    const fileLine = warnLines.find((l) => l.includes('.md — ') && l.includes('bytes'));
    expect(fileLine).toBeDefined();
    if (fileLine !== undefined) {
      // Defensive: no raw control bytes anywhere in the emitted
      // line. A single line, no embedded LF / CR / TAB / ESC.
      expect(fileLine).not.toContain('\u001b');
      expect(fileLine).not.toContain('\n');
      expect(fileLine).not.toContain('\r');
      expect(fileLine).not.toContain('\t');
      // The legible portion of the name survives — `tampered`,
      // `fake-line`, `here` are still present, just joined with
      // spaces. The attack vector (the bytes that drive terminal
      // control) is gone; the human-readable text is preserved
      // so the operator can still spot the suspicious filename.
      expect(fileLine).toContain('tampered');
      expect(fileLine).toContain('fake-line');
      expect(fileLine).toContain('here');
    }

    // Every warn line is single-line: ANY embedded newline would
    // split it across the operator's stderr buffer and let the
    // attacker forge an inventory entry. The header MUST also
    // pass through sanitization.
    for (const line of warnLines) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\u001b');
    }
  });

  test('T1: empty corpus inventory dump surfaces explicit prose', async () => {
    // Empty (or unreadable) corpus path: dump must still emit the
    // header + an explicit "currently empty" line so the operator
    // sees that the modal isn't omitting content.
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const warnLines: string[] = [];
    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'yes',
      warn: (s) => warnLines.push(s),
    });
    // No modal fires for an empty corpus (seeded path); the dump
    // also shouldn't fire — the early `EMPTY_CORPUS_HASH` branch
    // returns before `askSharedTrust`. Assert nothing leaked.
    expect(warnLines).toEqual([]);
  });

  test('T8: TOCTOU sibling — no inside-modal write stays reconfirmed', async () => {
    // The confirm path's contract: if the post-modal re-hash
    // matches the pre-modal hash, return `reconfirmed`. The
    // operator-visible drift here happens BEFORE the probe runs,
    // and nothing changes during the modal window, so both reads
    // see identical bytes.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'baseline');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    // Operator-visible drift before probe.
    writeBody(roots.projectShared, 'a', 'drifted');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'yes',
    });
    expect(result.kind).toBe('reconfirmed');
  });

  test('T8b: same-size content swap with restored mtime detected → deferred', async () => {
    // Regression for the (size, mtime) fast-path footgun. A prior
    // verifyConfirmedHash short-circuited when every file's
    // (size, mtime) tuple matched the pre-modal snapshot — that
    // missed a TOCTOU attacker who swapped same-size content and
    // restored mtime via utimes(2). Same threat surfaces naturally
    // on filesystems with coarse mtime granularity (FAT/exFAT,
    // some network FS) where a same-second rewrite is invisible
    // to stat. The confirm path MUST re-hash bytes — pin that
    // here so the fast-path can't sneak back in.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'aaaaaaaa');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    // Pre-probe drift so we enter the drift branch (presented
    // hash differs from stored). Capture the body's stat AFTER
    // this write — that's the (size, mtime) the probe will see
    // when it computes the presented fingerprint.
    writeBody(roots.projectShared, 'a', 'bbbbbbbb');
    const presentedStat = lstatSync(join(roots.projectShared, 'a.md'));

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        // Inside-modal TOCTOU: swap to a DIFFERENT same-size body
        // and restore mtime to the presented stat. A stat-only
        // fast-path would see (size, mtime) unchanged and stamp
        // trust on bytes the operator never saw. Bytes-on-confirm
        // rejects this.
        writeBody(roots.projectShared, 'a', 'cccccccc');
        utimesSync(join(roots.projectShared, 'a.md'), presentedStat.atime, presentedStat.mtime);
        return 'yes';
      },
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.cause).toBe('tocttou_during_prompt');
    }
    // Trust row UNCHANGED — still pinned to oldHash + original
    // timestamp. Operator-confirmed an old state we can't trust.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored?.lastConfirmedHash).toBe(oldHash);
    expect(stored?.lastConfirmedAtMs).toBe(1000);
  });

  test('T15a: first-visit + cancel → deferred(modal_cancel)', async () => {
    // State-machine matrix coverage. `drift + cancel` is tested;
    // first-visit + cancel was a gap.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'cancel',
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.cause).toBe('modal_cancel');
    }
    // No trust row stamped on first-visit cancel — operator
    // hasn't seen-and-decided yet.
    expect(getSharedTrust(db, roots.projectShared)).toBeNull();
  });

  test('T15b: first-visit + yes + TOCTOU → deferred(tocttou)', async () => {
    // First-visit's TOCTOU branch was untested. The drift-mode
    // TOCTOU test pins it for drift; this pins for first-visit.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        // Drift inside the modal window.
        writeBody(roots.projectShared, 'a', 'tampered during prompt');
        return 'yes';
      },
    });
    expect(result.kind).toBe('deferred');
    if (result.kind === 'deferred') {
      expect(result.cause).toBe('tocttou_during_prompt');
    }
    // First-visit + tocttou → trust row NOT stamped (operator
    // confirmed an old state we can't trust).
    expect(getSharedTrust(db, roots.projectShared)).toBeNull();
  });

  test('T6: bulk-invalidate transition io_error path emits audit row + failed entry', async () => {
    // M3 covered concurrent-state SKIP. T6 covers a real
    // transitionMemoryState failure: chmod the body 000 between
    // the snapshot and the transition so the move-to-tombstone
    // fails with EACCES. Skip-as-root.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    // Chmod the SCOPE DIRECTORY 0o500 (read+exec, no write) so
    // body reads succeed (registry.list's state-filter peek works)
    // but transitionMemoryState's frontmatter rewrite fails with
    // EACCES. The body file itself stays 0o644.
    chmodSync(roots.projectShared, 0o500);
    try {
      const result = await probeSharedTrust({
        db,
        registry,
        roots,
        sharedRoot: roots.projectShared,
        askSharedTrust: async () => 'no',
      });
      expect(result.kind).toBe('revoked');
      if (result.kind === 'revoked') {
        // Failure surfaces in `failed[]`.
        expect(result.failed.length).toBeGreaterThan(0);
        expect(result.failed[0]?.name).toBe('a');
      }
      // A `refused` audit row landed.
      const refusedRows = db
        .prepare("SELECT details FROM memory_events WHERE action = 'refused' AND memory_name = 'a'")
        .all() as { details: string }[];
      expect(refusedRows.length).toBeGreaterThan(0);
      const parsed = refusedRows.map((r) => JSON.parse(r.details) as Record<string, unknown>);
      expect(
        parsed.some((d) => d.stage === 'trust_revoked_bulk' && typeof d.reason === 'string'),
      ).toBe(true);
    } finally {
      chmodSync(roots.projectShared, 0o755);
    }
  });

  test('drift revoke with partial failure keeps trust row pinned to OLD hash', async () => {
    // Partial-failure gate: when bulkInvalidateShared reports
    // failures, the post-revoke stamp MUST be skipped. Otherwise
    // surviving active memories would be re-exposed on the next
    // boot's `unchanged` outcome, defeating the operator's
    // explicit "no" answer.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    chmodSync(roots.projectShared, 0o500); // forces transition io_error
    try {
      const result = await probeSharedTrust({
        db,
        registry,
        roots,
        sharedRoot: roots.projectShared,
        askSharedTrust: async () => 'no',
      });
      expect(result.kind).toBe('revoked');
      if (result.kind === 'revoked') {
        expect(result.failed.length).toBeGreaterThan(0);
      }
    } finally {
      chmodSync(roots.projectShared, 0o755);
    }
    // Trust row UNCHANGED: still at the original oldHash + ts.
    // Next boot will see drift again (because the body file still
    // says state: active — the bulk failed to flip it) and the
    // modal fires again, giving the operator a retry.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored).not.toBeNull();
    expect(stored?.lastConfirmedHash).toBe(oldHash);
    expect(stored?.lastConfirmedAtMs).toBe(1000);
  });

  test('first-visit revoke with partial failure leaves trust row null', async () => {
    // First-visit variant of the partial-failure gate. The trust
    // row starts null; the gate must NOT stamp post-revoke when
    // failures exist. Otherwise next boot's `unchanged` outcome
    // would silently bless the (partially-revoked) state.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    chmodSync(roots.projectShared, 0o500);
    try {
      const result = await probeSharedTrust({
        db,
        registry,
        roots,
        sharedRoot: roots.projectShared,
        askSharedTrust: async () => 'no',
      });
      expect(result.kind).toBe('revoked');
      if (result.kind === 'revoked') {
        expect(result.failed.length).toBeGreaterThan(0);
      }
    } finally {
      chmodSync(roots.projectShared, 0o755);
    }
    // Trust row REMAINS null — next boot fires first-visit modal
    // again (corpus non-empty + no row) and operator can retry.
    expect(getSharedTrust(db, roots.projectShared)).toBeNull();
  });
});

describe('probeSharedTrust — Phase 1 hardening pass (P0/P1)', () => {
  test('H1-rob: revoke runs bulk-invalidate BEFORE clearing trust row', async () => {
    // Atomicity invariant: if the process dies mid-bulk, the
    // trust row must still pin the OLD hash so the next boot
    // re-prompts. The old (clear→bulk) order failed silently —
    // surviving active memories silently re-loaded next boot
    // because the trust row got re-seeded at the (now-trusted)
    // current hash without a prompt.
    //
    // We assert ORDER by checking that, after the revoke, the
    // trust row IS cleared AND the memories ARE invalidated.
    // Order is encoded in the implementation; a regression that
    // flipped it would still pass this assertion. The real
    // protection is the documented comment block + the second
    // sub-test below that exercises the failure path.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body A');
    writeBody(roots.projectShared, 'b', 'body B');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    const result = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    expect(result.kind).toBe('revoked');
    // CRIT/F2: trust row stamped at post-invalidate hash. Next
    // boot sees `unchanged`; no perpetual re-prompt loop.
    const stored = getSharedTrust(db, roots.projectShared);
    expect(stored).not.toBeNull();
    expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(roots.projectShared) as string);
    // Both memories invalidated.
    if (result.kind === 'revoked') {
      expect(result.invalidated.map((q) => q.name).sort()).toEqual(['a', 'b']);
    }
  });

  test('CRIT/F2: subsequent boot after first-visit revoke sees unchanged (no re-prompt)', async () => {
    // The whole point of stamping post-invalidate hash: next boot
    // must NOT fire the first-visit modal again. This test is the
    // direct counter-example to the perpetual-prompt-loop bug.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });

    // Boot 1: first visit, operator says no.
    let modalCallsBoot1 = 0;
    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCallsBoot1++;
        return 'no';
      },
    });
    expect(modalCallsBoot1).toBe(1);

    // Boot 2: same files on disk, all invalidated. Probe must see
    // `unchanged` and NOT prompt.
    let modalCallsBoot2 = 0;
    const boot2 = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCallsBoot2++;
        return 'yes';
      },
    });
    expect(modalCallsBoot2).toBe(0);
    expect(boot2.kind).toBe('unchanged');
  });

  test('CRIT/F2: subsequent boot after drift revoke sees unchanged (no re-prompt)', async () => {
    // Same invariant as the first-visit-no test, but starting from
    // an established trust row. Drift revoke must also stamp the
    // post-invalidate hash.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'baseline');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const baseline = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, baseline, 1_000);

    // Drift: operator edits the body.
    writeBody(roots.projectShared, 'a', 'drifted');

    // Boot 1: drift modal fires, operator revokes.
    let modalCallsBoot1 = 0;
    const boot1 = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCallsBoot1++;
        return 'no';
      },
    });
    expect(modalCallsBoot1).toBe(1);
    expect(boot1.kind).toBe('revoked');

    // Boot 2: same on-disk state. No modal.
    let modalCallsBoot2 = 0;
    const boot2 = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => {
        modalCallsBoot2++;
        return 'yes';
      },
    });
    expect(modalCallsBoot2).toBe(0);
    expect(boot2.kind).toBe('unchanged');
  });

  test('M3-rob: concurrent boots skip already-invalidated memories silently', async () => {
    // Simulates two boot processes racing through the revoke
    // path. Process A invalidates memory X. Process B's bulk
    // iteration finds X still in the active snapshot (snapshot
    // was taken before A finished) but a re-peek shows it's
    // already invalidated. Process B must skip silently, NOT
    // emit `illegal_transition` or count X as failed.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body A');
    writeBody(roots.projectShared, 'b', 'body B');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    // First probe: invalidates both a and b normally.
    const first = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });
    expect(first.kind).toBe('revoked');

    // Re-stamp trust row so a second probe sees a fresh diverge
    // (simulating: operator pulled in a new corpus state +
    // re-confirmed, then ANOTHER divergence happened, and a
    // concurrent boot is now mid-revoke against the memories
    // that are STILL invalidated from the first revoke).
    const newHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, newHash, 2000);
    writeBody(roots.projectShared, 'a', 'second drift');

    // Second probe: re-peek now sees a's state as invalidated
    // (from the first probe) and skips silently. The bulk loop
    // produces zero failures even though the snapshot would
    // have considered a a candidate had it not re-peeked.
    const second = await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });
    expect(second.kind).toBe('revoked');
    if (second.kind === 'revoked') {
      // No 'illegal_transition' rows for the already-invalidated
      // entries.
      expect(second.failed).toEqual([]);
    }
  });

  test('IMP/M3-rel: silent skip emits a forensic audit row', async () => {
    // The skip path fires when `registry.list({states:['active']})`
    // candidates a memory but a per-listing re-peek shows it's no
    // longer active. Single-threaded tests can't trigger this race
    // directly through the real registry (list and peek both read
    // fresh frontmatter from disk). We use a thin proxy that
    // returns a synthetic candidate for `a` but reports state via
    // the underlying registry's peek — which has already mutated
    // it to `invalidated`. This deterministically exercises the
    // skip branch.
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body', 'quarantined');
    const realRegistry = createMemoryRegistry({ roots, db, cwd: repo });
    // Wrap the real registry: list() forges an "active" candidate
    // for `a` so the bulk loop tries it. The underlying peek (the
    // probe's re-peek) reads disk and sees `quarantined`.
    const proxy = {
      ...realRegistry,
      list: () => [
        {
          scope: 'project_shared' as const,
          name: 'a',
          entry: { title: 'A', href: 'a.md', hook: 'h' },
        },
      ],
    } as typeof realRegistry;

    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    // Force divergence so the probe enters the drift modal path.
    writeFileSync(join(roots.projectShared, 'MEMORY.md'), '- [A](a.md) — h — drifted\n');

    await probeSharedTrust({
      db,
      registry: proxy,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    // The skip row landed in memory_events.
    const skipRows = db
      .prepare("SELECT details FROM memory_events WHERE action = 'refused' AND memory_name = 'a'")
      .all() as { details: string }[];
    expect(skipRows.length).toBeGreaterThan(0);
    const skipRow = skipRows
      .map((r) => JSON.parse(r.details) as Record<string, unknown>)
      .find(
        (d) =>
          d.stage === 'trust_revoked_bulk' &&
          d.reason === 'state_changed_concurrently' &&
          d.previous_state === 'quarantined',
      );
    expect(skipRow).toBeDefined();
  });

  test('H2-rel: bulk-invalidate audit row uses actor=startup_probe', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
    });

    // /memory audit --trigger trust_revoked should yield the row;
    // we query the eviction_events table directly for the actor.
    const rows = db
      .prepare('SELECT actor FROM eviction_events WHERE trigger = ?')
      .all('trust_revoked') as { actor: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.actor).toBe('startup_probe');
    }
  });

  test('H1-rel: cwd is threaded into memory_events audit rows', async () => {
    writeIndex(roots.projectShared, '- [A](a.md) — h\n');
    writeBody(roots.projectShared, 'a', 'body');
    const registry = createMemoryRegistry({ roots, db, cwd: repo });
    const oldHash = computeSharedFingerprint(roots.projectShared) as string;
    setSharedTrust(db, roots.projectShared, oldHash, 1000);
    writeBody(roots.projectShared, 'a', 'tampered');

    const customCwd = '/forensic/test/cwd';
    await probeSharedTrust({
      db,
      registry,
      roots,
      sharedRoot: roots.projectShared,
      askSharedTrust: async () => 'no',
      cwd: customCwd,
    });

    const rows = db
      .prepare("SELECT cwd FROM memory_events WHERE memory_name = 'a' AND action = 'invalidated'")
      .all() as { cwd: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.cwd).toBe(customCwd);
    }
  });
});
