import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SealEntry,
  type SealStore,
  createSealingScheduler,
  createSqliteSink,
  createWormFileSealer,
  ensureInstallId,
  verifySealAgainstChain,
} from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-seal-sched-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Synchronous in-memory SealStore so tests don't touch real fs.
const makeMemStore = () => {
  const entries: SealEntry[] = [];
  let shouldFail: string | null = null;
  const store: SealStore = {
    append: (entry) => {
      if (shouldFail !== null) return { ok: false, reason: shouldFail };
      entries.push(entry);
      return { ok: true };
    },
    list: () => entries.slice(),
    close: () => {},
  };
  return {
    store,
    entries,
    failNext: (reason: string) => {
      shouldFail = reason;
    },
    succeedNext: () => {
      shouldFail = null;
    },
  };
};

const setupChain = (rowCount: number) => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  const identity = ensureInstallId({
    env: { HOME: tmpRoot },
    now: () => 1,
    uuid: () => 'sched-uuid-aaaa-bbbb',
  });
  const sink = createSqliteSink({ db, identity });
  for (let i = 0; i < rowCount; i++) {
    sink.emit({
      session_id: `s${i}`,
      tool_name: 'bash',
      args: { i },
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 100 + i,
    });
  }
  return { db, identity, sink };
};

const noopTimerSeams = () => ({
  setTimer: (_cb: () => void, _ms: number) => null,
  clearTimer: (_h: unknown) => {},
});

describe('createSealingScheduler — tick', () => {
  test('counter reaches intervalDecisions → seal fires + counter resets', () => {
    const { db, identity } = setupChain(5);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 3,
      intervalSeconds: 0,
      now: () => 999,
      ...noopTimerSeams(),
    });
    // 2 ticks: no seal yet
    scheduler.tick();
    scheduler.tick();
    expect(mem.entries).toHaveLength(0);
    // 3rd tick: threshold hit, seal fires
    scheduler.tick();
    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0]?.ts).toBe(999);
    expect(mem.entries[0]?.seq).toBe(5); // latest row
    // Counter reset — 2 more ticks shouldn't fire
    scheduler.tick();
    scheduler.tick();
    expect(mem.entries).toHaveLength(1);
  });

  test('intervalDecisions=0 → tick never fires a decision-driven seal', () => {
    const { db, identity } = setupChain(3);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    for (let i = 0; i < 1000; i++) scheduler.tick();
    expect(mem.entries).toHaveLength(0);
  });

  test('tick on empty chain → no seal (noop)', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'sched-uuid-aaaa-bbbb',
    });
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    scheduler.tick(); // threshold=1 → would seal if chain non-empty
    expect(mem.entries).toHaveLength(0);
  });

  test('tick on unchanged chain (already-sealed seq) → no duplicate seal', () => {
    const { db, identity } = setupChain(2);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    scheduler.tick(); // seals seq=2
    expect(mem.entries).toHaveLength(1);
    scheduler.tick(); // chain unchanged → noop
    scheduler.tick();
    expect(mem.entries).toHaveLength(1);
  });

  test('store.append failure → onSealFailed invoked, counter still resets', () => {
    const { db, identity } = setupChain(2);
    const mem = makeMemStore();
    mem.failNext('chattr +a failed: permission denied');
    const failures: string[] = [];
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 2,
      intervalSeconds: 0,
      onSealFailed: (r) => failures.push(r),
      ...noopTimerSeams(),
    });
    scheduler.tick();
    scheduler.tick(); // threshold=2 → tries seal, fails
    expect(failures).toEqual(['chattr +a failed: permission denied']);
    expect(mem.entries).toHaveLength(0);
    // Counter reset — next 2 ticks would try again.
    mem.succeedNext();
    scheduler.tick();
    scheduler.tick();
    expect(mem.entries).toHaveLength(1);
  });
});

describe('createSealingScheduler — wall-clock timer', () => {
  test('timer fires → seals latest + reschedules', () => {
    const { db, identity } = setupChain(3);
    const mem = makeMemStore();
    const capturedTimers: Array<{ cb: () => void; ms: number }> = [];
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0, // disable decision-driven
      intervalSeconds: 10,
      now: () => 12345,
      setTimer: (cb, ms) => {
        capturedTimers.push({ cb, ms });
        return capturedTimers.length;
      },
      clearTimer: () => {},
    });
    // One timer scheduled on creation.
    expect(capturedTimers).toHaveLength(1);
    expect(capturedTimers[0]?.ms).toBe(10_000);
    // Fire it.
    capturedTimers[0]?.cb();
    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0]?.seq).toBe(3);
    expect(mem.entries[0]?.ts).toBe(12345);
    // Timer rescheduled.
    expect(capturedTimers).toHaveLength(2);
    expect(capturedTimers[1]?.ms).toBe(10_000);
    scheduler.close();
  });

  test('intervalSeconds=0 → no timer ever scheduled', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    const capturedTimers: Array<{ cb: () => void; ms: number }> = [];
    createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      setTimer: (cb, ms) => {
        capturedTimers.push({ cb, ms });
        return capturedTimers.length;
      },
      clearTimer: () => {},
    });
    expect(capturedTimers).toHaveLength(0);
  });

  test('timer-driven seal resets decisionCounter', () => {
    const { db, identity } = setupChain(2);
    const mem = makeMemStore();
    const capturedTimers: Array<{ cb: () => void; ms: number }> = [];
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 5, // decision-driven also on
      intervalSeconds: 10,
      setTimer: (cb, ms) => {
        capturedTimers.push({ cb, ms });
        return capturedTimers.length;
      },
      clearTimer: () => {},
    });
    // 3 ticks (below decision threshold of 5).
    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    expect(mem.entries).toHaveLength(0);
    // Timer fires — seals + resets counter.
    capturedTimers[0]?.cb();
    expect(mem.entries).toHaveLength(1);
    // After reset, 4 more ticks (would have been threshold without
    // the reset) should NOT seal — but wait, the chain hasn't
    // changed, so the next attempt is a noop anyway. Add a new row
    // to test the counter behavior cleanly.
    const sink = createSqliteSink({
      db,
      identity: { install_id: identity.install_id, created_at_ms: identity.created_at_ms },
    });
    sink.emit({
      session_id: 'extra',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 999,
    });
    // 4 ticks — counter goes from 0 to 4, no seal yet.
    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    expect(mem.entries).toHaveLength(1);
    // 5th tick — threshold, seal fires.
    scheduler.tick();
    expect(mem.entries).toHaveLength(2);
    scheduler.close();
  });

  test('timer-driven seal failure routes through onSealFailed', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    mem.failNext('disk full');
    const failures: string[] = [];
    const capturedTimers: Array<{ cb: () => void; ms: number }> = [];
    createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 10,
      onSealFailed: (r) => failures.push(r),
      setTimer: (cb, ms) => {
        capturedTimers.push({ cb, ms });
        return capturedTimers.length;
      },
      clearTimer: () => {},
    });
    capturedTimers[0]?.cb();
    expect(failures).toEqual(['disk full']);
    // Timer rescheduled despite failure — operator may fix the
    // issue and the next tick should keep working.
    expect(capturedTimers).toHaveLength(2);
  });
});

describe('createSealingScheduler — sealNow', () => {
  test('sealNow on healthy chain → { ok: true, sealed: entry }', () => {
    const { db, identity } = setupChain(3);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      now: () => 7777,
      ...noopTimerSeams(),
    });
    const r = scheduler.sealNow();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sealed).not.toBeNull();
      expect(r.sealed?.seq).toBe(3);
      expect(r.sealed?.ts).toBe(7777);
    }
    expect(mem.entries).toHaveLength(1);
  });

  test('sealNow on empty chain → { ok: true, sealed: null }', () => {
    const db = openMemoryDb();
    migrate(db, MIGRATIONS);
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'sched-uuid-aaaa-bbbb',
    });
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    const r = scheduler.sealNow();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sealed).toBeNull();
  });

  test('sealNow when chain is already at lastSealedSeq → sealed: null', () => {
    const { db, identity } = setupChain(2);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    const r1 = scheduler.sealNow();
    expect(r1.ok && r1.sealed?.seq).toBe(2);
    const r2 = scheduler.sealNow(); // chain unchanged
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.sealed).toBeNull();
  });

  test('sealNow with store failure → ok:false + onSealFailed invoked', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    mem.failNext('chattr blocked');
    const failures: string[] = [];
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      onSealFailed: (r) => failures.push(r),
      ...noopTimerSeams(),
    });
    const r = scheduler.sealNow();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('chattr blocked');
    expect(failures).toEqual(['chattr blocked']);
  });

  test('sealNow after close → ok:false', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    scheduler.close();
    const r = scheduler.sealNow();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('closed');
  });

  test('sealNow resets decisionCounter', () => {
    const { db, identity } = setupChain(2);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 3,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    scheduler.tick();
    scheduler.tick(); // counter=2, no seal
    scheduler.sealNow(); // seals + resets
    expect(mem.entries).toHaveLength(1);
    // 2 more ticks — counter goes 0→1→2; no seal because counter
    // was reset by sealNow.
    scheduler.tick();
    scheduler.tick();
    expect(mem.entries).toHaveLength(1);
  });
});

describe('createSealingScheduler — close', () => {
  test('close cancels the pending timer', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    const capturedTimers: Array<unknown> = [];
    const cleared: unknown[] = [];
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 10,
      setTimer: (_cb, _ms) => {
        const h = capturedTimers.length + 1;
        capturedTimers.push(h);
        return h;
      },
      clearTimer: (h) => cleared.push(h),
    });
    expect(capturedTimers).toHaveLength(1);
    scheduler.close();
    expect(cleared).toEqual([1]);
  });

  test('tick after close is a no-op', () => {
    const { db, identity } = setupChain(2);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    scheduler.close();
    scheduler.tick();
    expect(mem.entries).toHaveLength(0);
  });

  test('close is idempotent', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      ...noopTimerSeams(),
    });
    expect(() => {
      scheduler.close();
      scheduler.close();
      scheduler.close();
    }).not.toThrow();
  });
});

describe('createSealingScheduler — integration with real worm-file + verifySealAgainstChain', () => {
  // End-to-end: scheduler drives a real worm-file SealStore, then
  // verifySealAgainstChain confirms every seal entry matches the
  // chain. This catches integration drift between the scheduler's
  // SealEntry construction and the sealer's expected format.
  test('decision-driven seals are verifiable against the chain', () => {
    const { db, identity, sink } = setupChain(0);
    const contents = new Map<string, string>();
    const sealer = createWormFileSealer({
      path: join(tmpRoot, 'seal.log'),
      exists: (p) => contents.has(p),
      read: (p) => contents.get(p) ?? '',
      append: (p, c) => {
        contents.set(p, (contents.get(p) ?? '') + c);
      },
      ensureDir: () => {},
    });
    const scheduler = createSealingScheduler({
      store: sealer,
      db,
      installId: identity.install_id,
      intervalDecisions: 5,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    // Emit 12 rows, tick after each. Should fire 2 seals
    // (at decisions 5 and 10).
    for (let i = 0; i < 12; i++) {
      sink.emit({
        session_id: `s${i}`,
        tool_name: 'bash',
        args: { i },
        decision: 'allow',
        policy_hash: 'sha256:p',
        reason_chain: [],
        capabilities: [],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 200 + i,
      });
      scheduler.tick();
    }
    const sealedRows = sealer.list();
    expect(sealedRows).toHaveLength(2);
    expect(sealedRows[0]?.seq).toBe(5);
    expect(sealedRows[1]?.seq).toBe(10);
    // verify ok
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(2);
    scheduler.close();
  });
});

// Slice 135 P0-4: pin the multi-process seed behavior introduced
// in slice 128 (R4 P0-Race-1). Two `forja` processes on the same
// install share `approvals_log` (DB) AND the seal store on disk.
// Without seeding `lastSealedSeq` from `store.list()`, both
// processes start at seq=0 and both append `seq=N` lines at the
// same chain head → duplicate seal entries. The seed reads the
// max seq already in the store; the second process now noops on
// the head it would have re-sealed.
describe('createSealingScheduler — multi-process seed (slice 128 R4 P0-Race-1)', () => {
  test("second scheduler over same store sees first scheduler's seal as the seed", () => {
    const { db, identity } = setupChain(5);
    const mem = makeMemStore();
    // Process A: tick threshold=1, seals seq=5.
    const schedA = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      now: () => 1000,
      ...noopTimerSeams(),
    });
    schedA.tick();
    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0]?.seq).toBe(5);
    schedA.close();
    // Process B: fresh scheduler, SAME store. Construction should
    // seed lastSealedSeq=5 from store.list(). A sealNow() on the
    // unchanged chain head must report `sealed: null` — NOT a
    // duplicate entry.
    const schedB = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      now: () => 2000,
      ...noopTimerSeams(),
    });
    const r = schedB.sealNow();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sealed).toBeNull();
    expect(mem.entries).toHaveLength(1); // still only A's entry
    // And tick-driven path also noops at the seeded seq.
    schedB.tick();
    expect(mem.entries).toHaveLength(1);
    schedB.close();
  });

  test('seed picks the MAX seq when store entries are out of order', () => {
    const { db, identity } = setupChain(7);
    // Hand-craft an out-of-order entries list — the worm file may
    // legitimately be ordered, but TSA / git-anchored backends can
    // return entries in non-monotonic order during operator splices.
    const entries: SealEntry[] = [
      { seq: 3, ts: 1, hash: 'h3' },
      { seq: 7, ts: 2, hash: 'h7' },
      { seq: 5, ts: 3, hash: 'h5' },
      { seq: 4, ts: 4, hash: 'h4' },
    ];
    const store: SealStore = {
      append: (e) => {
        entries.push(e);
        return { ok: true };
      },
      list: () => entries.slice(),
      close: () => {},
    };
    const scheduler = createSealingScheduler({
      store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    // Chain head is seq=7. Seed is max(3,7,5,4)=7 → noop on tick.
    scheduler.tick();
    expect(entries).toHaveLength(4); // no new entry
    scheduler.close();
  });

  test('seed correctly distinguishes head>seed (seals) vs head=seed (noop)', () => {
    const { db, identity, sink } = setupChain(3);
    const mem = makeMemStore();
    // Pre-populate the store with a stale seal at seq=2 (as if a
    // prior process sealed an earlier point of the chain).
    mem.entries.push({ seq: 2, ts: 50, hash: 'old-hash' });
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      now: () => 500,
      ...noopTimerSeams(),
    });
    // Chain head is seq=3, seed is seq=2 → first tick seals the
    // gap (the new head).
    scheduler.tick();
    expect(mem.entries).toHaveLength(2);
    expect(mem.entries[1]?.seq).toBe(3);
    // Next tick on the same head → noop (lastSealedSeq now = 3).
    scheduler.tick();
    expect(mem.entries).toHaveLength(2);
    // Add a new row, tick → seal the new head.
    sink.emit({
      session_id: 'extra',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:p',
      reason_chain: [],
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 999,
    });
    scheduler.tick();
    expect(mem.entries).toHaveLength(3);
    expect(mem.entries[2]?.seq).toBe(4);
    scheduler.close();
  });

  test('store.list() throwing at construction → falls back to seed=0 (defensive)', () => {
    const { db, identity } = setupChain(2);
    // Store whose list() always throws — simulates a corrupted
    // worm file the operator hasn't repaired yet.
    const appended: SealEntry[] = [];
    const store: SealStore = {
      append: (e) => {
        appended.push(e);
        return { ok: true };
      },
      list: () => {
        throw new Error('seal log corrupted: bad magic at offset 0');
      },
      close: () => {},
    };
    // Construction must NOT throw (defensive fallback in the
    // scheduler swallows the error).
    const scheduler = createSealingScheduler({
      store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      now: () => 1234,
      ...noopTimerSeams(),
    });
    // With seed=0, first tick should seal the chain head (seq=2).
    scheduler.tick();
    expect(appended).toHaveLength(1);
    expect(appended[0]?.seq).toBe(2);
    expect(appended[0]?.ts).toBe(1234);
    scheduler.close();
  });

  test('two sequential schedulers over an evolving chain produce monotonic seals', () => {
    // End-to-end multi-process simulation: two scheduler lifecycles
    // sharing one DB + one store. After process A seals up to seq=N,
    // process B should pick up from seq=N+1 (never re-emit N).
    const { db, identity, sink } = setupChain(0);
    const mem = makeMemStore();
    // Process A: emit 5 rows, tick after each, threshold=5 → 1 seal at seq=5.
    const schedA = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 5,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    for (let i = 0; i < 5; i++) {
      sink.emit({
        session_id: `a-${i}`,
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:p',
        reason_chain: [],
        capabilities: [],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 100 + i,
      });
      schedA.tick();
    }
    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0]?.seq).toBe(5);
    schedA.close();
    // Process B: 5 more rows, threshold=5 → seal at seq=10.
    // CRITICAL: seq=5 must NOT be sealed again — that would be
    // the duplicate the seed fix prevents.
    const schedB = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 5,
      intervalSeconds: 0,
      ...noopTimerSeams(),
    });
    for (let i = 0; i < 5; i++) {
      sink.emit({
        session_id: `b-${i}`,
        tool_name: 'bash',
        args: {},
        decision: 'allow',
        policy_hash: 'sha256:p',
        reason_chain: [],
        capabilities: [],
        score: 0,
        score_components: {},
        classifier_hash: 'none',
        classifier_adjust: null,
        sandbox_profile: null,
        ttl_expires_at: null,
        ts: 200 + i,
      });
      schedB.tick();
    }
    expect(mem.entries).toHaveLength(2);
    expect(mem.entries[0]?.seq).toBe(5);
    expect(mem.entries[1]?.seq).toBe(10);
    // Seqs are strictly monotonic — no duplicates.
    const seqs = mem.entries.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    schedB.close();
  });
});

// Slice 158 (review): defense-in-depth wrapper around the caller-
// supplied `onSealFailed` callback. Pre-slice, a throwing callback
// would propagate through the timer body (setTimer's callback ran
// it without try/catch) and surface as uncaughtException → process
// exit. With `safeOnSealFailed` the callback throw is caught and
// the scheduler keeps running. The tick path was already shielded
// by audit.ts's try-around-tick, but symmetric coverage in the
// scheduler itself makes the contract explicit.
describe('createSealingScheduler — onSealFailed throwing (slice 158)', () => {
  test('timer path: throwing onSealFailed does NOT crash the timer body', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    mem.failNext('disk full');
    let callbackInvoked = 0;
    const capturedTimers: Array<{ cb: () => void; ms: number }> = [];
    createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 10,
      onSealFailed: () => {
        callbackInvoked += 1;
        throw new Error('hostile callback');
      },
      setTimer: (cb, ms) => {
        capturedTimers.push({ cb, ms });
        return capturedTimers.length;
      },
      clearTimer: () => {},
    });
    // Pre-slice this would have thrown out of the timer callback;
    // post-slice it returns cleanly and reschedules.
    expect(() => capturedTimers[0]?.cb()).not.toThrow();
    expect(callbackInvoked).toBe(1);
    // Timer rescheduled despite the throw — the scheduler is still
    // alive and will fire again next interval.
    expect(capturedTimers).toHaveLength(2);
  });

  test('tick path: throwing onSealFailed does NOT crash tick()', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    mem.failNext('chattr +a dropped');
    let callbackInvoked = 0;
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      onSealFailed: () => {
        callbackInvoked += 1;
        throw new Error('hostile callback');
      },
      ...noopTimerSeams(),
    });
    expect(() => scheduler.tick()).not.toThrow();
    expect(callbackInvoked).toBe(1);
    scheduler.close();
  });

  test('sealNow path: throwing onSealFailed does NOT crash sealNow()', () => {
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    mem.failNext('EROFS');
    let callbackInvoked = 0;
    const scheduler = createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 0,
      onSealFailed: () => {
        callbackInvoked += 1;
        throw new Error('hostile callback');
      },
      ...noopTimerSeams(),
    });
    // sealNow returns ok:false with the underlying reason — the
    // throwing callback is best-effort observability and shouldn't
    // alter the structured result.
    let result: { ok: boolean; reason?: string };
    expect(() => {
      result = scheduler.sealNow();
    }).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: assigned in the not-throw block above
    expect(result!.ok).toBe(false);
    // biome-ignore lint/style/noNonNullAssertion: assigned in the not-throw block above
    expect(result!.reason).toBe('EROFS');
    expect(callbackInvoked).toBe(1);
    scheduler.close();
  });

  test('repeated consecutive failures: callback fires each time, scheduler stays alive', () => {
    // The bootstrap's onSealFailed used to call engine.degrade()
    // which throws on degraded→degraded. With slice 158's bootstrap
    // gate (only transition from ready), this is now a no-op past
    // the first failure; the scheduler must still invoke the
    // callback for telemetry / forensics. This test simulates the
    // pre-fix shape by raising on every call AND asserts the
    // scheduler keeps cycling.
    const { db, identity } = setupChain(1);
    const mem = makeMemStore();
    mem.failNext('disk full');
    const reasons: string[] = [];
    const capturedTimers: Array<{ cb: () => void; ms: number }> = [];
    createSealingScheduler({
      store: mem.store,
      db,
      installId: identity.install_id,
      intervalDecisions: 0,
      intervalSeconds: 10,
      onSealFailed: (r) => {
        reasons.push(r);
        throw new Error('always fail');
      },
      setTimer: (cb, ms) => {
        capturedTimers.push({ cb, ms });
        return capturedTimers.length;
      },
      clearTimer: () => {},
    });
    // Tick #1 (timer fires, seal fails, callback throws, swallowed,
    // timer reschedules).
    expect(() => capturedTimers[0]?.cb()).not.toThrow();
    // Tick #2 (timer #2 fires, same flow).
    expect(() => capturedTimers[1]?.cb()).not.toThrow();
    // Tick #3.
    expect(() => capturedTimers[2]?.cb()).not.toThrow();
    expect(reasons).toEqual(['disk full', 'disk full', 'disk full']);
    // After 3 failures, the scheduler has rescheduled 3 times +
    // the initial schedule = 4 timer slots.
    expect(capturedTimers).toHaveLength(4);
  });
});
