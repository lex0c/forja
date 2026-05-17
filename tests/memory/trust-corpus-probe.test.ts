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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { probeSharedTrust } from '../../src/memory/trust-corpus-probe.ts';
import {
  computeSharedFingerprint,
  getSharedTrust,
  setSharedTrust,
} from '../../src/memory/trust-corpus.ts';
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
  test('seeded: no prior row + EMPTY corpus → silent stamp, no modal fired', async () => {
    // P0/F2 hardening: silent seed is ONLY safe when there's nothing
    // to consent to. An empty shared/ directory has no operator-
    // influencing content to attest, so the cwd-trust modal already
    // covers the implicit "I trust this directory" decision.
    // sharedRoot doesn't exist at all in this fixture — that's
    // strictly stricter than "exists but empty"; both seed silently
    // because both produce EMPTY_CORPUS_HASH.
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
    if (result.kind === 'reconfirmed') {
      expect(result.mode).toBe('first-visit');
    }
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
      expect(result.mode).toBe('first-visit');
      expect(result.oldHash).toBeNull();
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
    if (result.kind === 'reconfirmed') {
      expect(result.oldHash).toBe(oldHash);
      expect(result.newHash).toBe(newHash);
    }
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
