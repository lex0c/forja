// Conformance suite — concurrency category (PERMISSION_ENGINE.md §16,
// row "Concurrency | 5"). These cases are programmatic, not YAML,
// because the YAML harness can't express the operations the spec
// flags ("parallel calls within session, policy reload mid-decision"):
//   - Multi-engine chain isolation needs two `createSqliteSink`s
//     pointing at the same DB.
//   - `engine.reloadPolicy()` mid-sequence requires programmatic
//     control of the call order.
//   - Cross-row assertions span the chain hash linkage, which the
//     YAML `expect:` block doesn't currently model.
//
// JS is single-threaded, so "concurrency" here pins the INVARIANTS
// that survive an asynchronous future (when callbacks or worker
// threads land) rather than racing the current synchronous engine:
//   1. Sequential checks within one install_id chain correctly.
//   2. Separate install_ids keep separate chains in one shared DB.
//   3. `reloadPolicy` is atomic at the check boundary — no in-flight
//      decision straddles two policies.
//   4. `policy()` snapshots are independent objects (no shared
//      mutable reference between caller and engine).
//   5. Interleaved emits + reloads leave the audit chain verifiable.
//
// Closes the §16 conformance suite at 134/136 cases (the table-of-
// minimums for "Concurrency" is 5; this slice ships exactly those
// 5). The remaining slack (2 cases against the spec's GA bar of
// 136) lives in categories that already exceed their minimums.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { canonicalHash } from '../../src/permissions/canonical.ts';
import {
  createPermissionEngine,
  createSqliteSink,
  ensureInstallId,
} from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/types.ts';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { listApprovalsLogByInstall } from '../../src/storage/repos/approvals-log.ts';

const strictPolicy = (): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
});

const bypassPolicy = (): Policy => ({
  defaults: { mode: 'bypass' },
  tools: {},
});

beforeAll(async () => {
  await initBashParser();
});

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-conc-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const setupEngine = (policy: Policy) => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  const identity = ensureInstallId({
    env: { HOME: tmpRoot },
    now: () => 1,
    uuid: () => 'conc-uuid-aaaa-bbbb',
  });
  const sink = createSqliteSink({ db, identity });
  const engine = createPermissionEngine(policy, {
    cwd: '/work/proj',
    home: tmpRoot,
    audit: sink,
    sessionId: 'sess-conc',
  });
  return { db, identity, sink, engine };
};

describe('conformance: concurrency (§16 — 5 cases)', () => {
  test('1/5: sequential checks chain correctly (seq increments + prev_hash chains)', () => {
    const { db, engine, identity } = setupEngine(strictPolicy());
    for (let i = 0; i < 5; i++) {
      engine.check('bash', 'bash', { command: 'ls' });
    }
    const rows = listApprovalsLogByInstall(db, identity.install_id);
    expect(rows).toHaveLength(5);
    // seq is strictly increasing; prev_hash chains link each row to
    // its predecessor. Both invariants together prove sequential
    // emits don't interleave or skip — the chain is a deterministic
    // linked list.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) throw new Error('row missing');
      expect(row.seq).toBe(i + 1);
      if (i > 0) {
        const prev = rows[i - 1];
        if (prev === undefined) throw new Error('prev missing');
        expect(row.prev_hash).toBe(prev.this_hash);
      }
    }
  });

  test('2/5: multiple install_ids keep separate chains in a shared DB', () => {
    // Two engines, two install_ids, ONE shared DB. Each engine's
    // sink filters by install_id on emit + verify, so interleaved
    // calls land in separate logical chains even though they share
    // the underlying `approvals_log` table.
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const idA = ensureInstallId({
      env: { HOME: join(tmpRoot, 'a') },
      now: () => 1,
      uuid: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const idB = ensureInstallId({
      env: { HOME: join(tmpRoot, 'b') },
      now: () => 2,
      uuid: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    const sinkA = createSqliteSink({ db, identity: idA });
    const sinkB = createSqliteSink({ db, identity: idB });
    const engineA = createPermissionEngine(strictPolicy(), {
      cwd: '/a',
      audit: sinkA,
      sessionId: 'sa',
    });
    const engineB = createPermissionEngine(strictPolicy(), {
      cwd: '/b',
      audit: sinkB,
      sessionId: 'sb',
    });
    // Interleave 3 emits each.
    // `ls` is a known command in the bash resolver registry — using
    // it lets us focus the test on chain mechanics, not resolver
    // refusal behavior (which is exercised in bash_adversarial.yaml).
    engineA.check('bash', 'bash', { command: 'ls' });
    engineB.check('bash', 'bash', { command: 'ls' });
    engineA.check('bash', 'bash', { command: 'ls' });
    engineB.check('bash', 'bash', { command: 'ls' });
    engineA.check('bash', 'bash', { command: 'ls' });
    engineB.check('bash', 'bash', { command: 'ls' });
    const rowsA = listApprovalsLogByInstall(db, idA.install_id);
    const rowsB = listApprovalsLogByInstall(db, idB.install_id);
    expect(rowsA).toHaveLength(3);
    expect(rowsB).toHaveLength(3);
    // Cross-install hashes don't appear in each other's chain — the
    // prev_hash for A's row 2 must be A's row 1, NEVER B's row 1
    // (which lies between them in global seq order).
    const hashesA = new Set(rowsA.map((r) => r.this_hash));
    const hashesB = new Set(rowsB.map((r) => r.this_hash));
    for (const h of hashesA) expect(hashesB.has(h)).toBe(false);
    // Per-chain integrity: each install's chain verifies clean
    // despite interleaved global seq.
    const vA = sinkA.verifyChain();
    const vB = sinkB.verifyChain();
    expect(vA.ok).toBe(true);
    expect(vB.ok).toBe(true);
    if (vA.ok) expect(vA.rows).toBe(3);
    if (vB.ok) expect(vB.rows).toBe(3);
  });

  test('3/5: reloadPolicy is atomic at check boundary', () => {
    // Pre-reload: strict + no rule → every bash check denies.
    // Post-reload: bypass → every bash check allows.
    // The boundary is absolute — no in-flight decision sees the
    // wrong policy, and the swap is observable at the very next
    // check.
    const { engine } = setupEngine(strictPolicy());
    const d1 = engine.check('bash', 'bash', { command: 'ls' });
    expect(d1.kind).toBe('deny');
    const reload = engine.reloadPolicy(bypassPolicy());
    expect(reload.ok).toBe(true);
    const d2 = engine.check('bash', 'bash', { command: 'ls' });
    expect(d2.kind).toBe('allow');
    // Reload back to strict — the engine returns to deny.
    const reload2 = engine.reloadPolicy(strictPolicy());
    expect(reload2.ok).toBe(true);
    const d3 = engine.check('bash', 'bash', { command: 'ls' });
    expect(d3.kind).toBe('deny');
  });

  test('4/5: policy() snapshots are independent clones (no shared reference)', () => {
    // The engine's `policy()` returns a deep clone via
    // `structuredClone`. Two back-to-back calls produce:
    //   (a) distinct object references (no aliasing of the engine's
    //       internal state), and
    //   (b) structurally equal data (the clone is a faithful copy).
    // Mutating the returned snapshot does NOT affect the engine's
    // enforcement — a caller can't smuggle a policy change through
    // a captured reference.
    const { engine } = setupEngine(strictPolicy());
    const p1 = engine.policy();
    const p2 = engine.policy();
    expect(p1).not.toBe(p2);
    expect(p1).toEqual(p2);
    // Same canonical hash — proves no field drift across snapshots.
    expect(canonicalHash(p1)).toBe(canonicalHash(p2));
    // Mutate the clone; the engine's mode is still strict on the
    // next snapshot.
    (p1.defaults as { mode: string }).mode = 'bypass';
    const p3 = engine.policy();
    expect(p3.defaults.mode).toBe('strict');
  });

  test('5/5: chain stays intact across interleaved reload + emit cycles', () => {
    // The most adversarial concurrency shape in single-threaded JS:
    // alternating emit + reload. Each emit records the current
    // policy_hash; the chain's `this_hash` covers that hash. If
    // reloadPolicy ever leaked across an emit boundary (the row
    // would carry the WRONG policy_hash for the policy active at
    // decision time), the recomputed this_hash on `verifyChain`
    // would mismatch. Conversely, if reload were NOT atomic, two
    // adjacent rows might carry the same policy_hash for different
    // intended policies — the test pins that strict/bypass rows
    // alternate as their checks fired.
    // Use `ls` — known to the bash resolver, so the decision reflects
    // mode (strict-deny vs bypass-allow), not resolver refusal.
    const { db, engine, sink, identity } = setupEngine(strictPolicy());
    engine.check('bash', 'bash', { command: 'ls' });
    engine.reloadPolicy(bypassPolicy());
    engine.check('bash', 'bash', { command: 'ls' });
    engine.reloadPolicy(strictPolicy());
    engine.check('bash', 'bash', { command: 'ls' });
    engine.reloadPolicy(bypassPolicy());
    engine.check('bash', 'bash', { command: 'ls' });

    const verify = sink.verifyChain();
    expect(verify.ok).toBe(true);
    if (verify.ok) expect(verify.rows).toBe(4);

    const rows = listApprovalsLogByInstall(db, identity.install_id);
    expect(rows).toHaveLength(4);
    const r0 = rows[0];
    const r1 = rows[1];
    const r2 = rows[2];
    const r3 = rows[3];
    if (r0 === undefined || r1 === undefined || r2 === undefined || r3 === undefined) {
      throw new Error('row missing');
    }
    // Strict hash differs from bypass hash; alternation is visible
    // in the policy_hash column.
    const strictHash = r0.policy_hash;
    const bypassHash = r1.policy_hash;
    expect(strictHash).not.toBe(bypassHash);
    expect(r2.policy_hash).toBe(strictHash);
    expect(r3.policy_hash).toBe(bypassHash);
    // Decisions reflect the active policy per row: strict denies,
    // bypass allows.
    expect(r0.decision).toBe('deny');
    expect(r1.decision).toBe('allow');
    expect(r2.decision).toBe('deny');
    expect(r3.decision).toBe('allow');
  });
});
