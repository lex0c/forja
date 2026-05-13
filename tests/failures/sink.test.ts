import { describe, expect, test } from 'bun:test';
import {
  BOOTSTRAP_SESSION_ID,
  countFailureEvents,
  countFailuresByCodeSince,
  createNoopFailureSink,
  createSqliteFailureSink,
} from '../../src/failures/index.ts';
import { sha256Hex } from '../../src/permissions/canonical.ts';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import {
  listFailureEventsByCode,
  listFailureEventsBySession,
} from '../../src/storage/repos/failure-events.ts';

const freshDb = () => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

describe('createNoopFailureSink', () => {
  test('emit returns sentinel + verifyChain ok', () => {
    const sink = createNoopFailureSink();
    expect(
      sink.emit({
        code: 'sandbox.tool_unavailable',
        classe: 'sandbox',
        recovery_action: 'fatal',
        user_visible: true,
      }),
    ).toEqual({ id: '', this_chain_hash: '' });
    expect(sink.verifyChain('any')).toEqual({ ok: true, rows: 0 });
  });
});

describe('createSqliteFailureSink — validation', () => {
  test('rejects unregistered code', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    expect(() =>
      sink.emit({
        code: 'provider.timeout.streaming', // format-valid, not in vocabulary
        classe: 'provider',
        recovery_action: 'fatal',
        user_visible: true,
      }),
    ).toThrow(/CODE_VOCABULARY/);
  });

  test('rejects unknown recovery_action', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    expect(() =>
      sink.emit({
        code: 'sandbox.tool_unavailable',
        classe: 'sandbox',
        recovery_action: 'retired_3x', // typo
        user_visible: true,
      }),
    ).toThrow(/recovery_action/);
  });

  test('rejects negative / NaN / non-integer created_at', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    const base = {
      code: 'sandbox.tool_unavailable' as const,
      classe: 'sandbox' as const,
      recovery_action: 'fatal',
      user_visible: true,
    };
    expect(() => sink.emit({ ...base, created_at: -1 })).toThrow(/non-negative/);
    expect(() => sink.emit({ ...base, created_at: Number.NaN })).toThrow(/non-negative/);
    expect(() => sink.emit({ ...base, created_at: 1.5 })).toThrow(/non-negative/);
  });

  test('rejects created_at > now + 1h (forgery)', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    expect(() =>
      sink.emit({
        code: 'sandbox.tool_unavailable',
        classe: 'sandbox',
        recovery_action: 'fatal',
        user_visible: true,
        created_at: Date.now() + 2 * 60 * 60 * 1000,
      }),
    ).toThrow(/forgery/);
  });
});

describe('createSqliteFailureSink — chain', () => {
  test('first row in a session uses SHA256(session_id) genesis', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    const result = sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-1',
    });
    const rows = listFailureEventsBySession(db, 'sess-1');
    expect(rows.length).toBe(1);
    expect(rows[0]?.prev_chain_hash).toBe(sha256Hex('sess-1'));
    expect(rows[0]?.this_chain_hash).toBe(result.this_chain_hash);
  });

  test('subsequent rows chain from previous this_chain_hash', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    const r1 = sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-1',
    });
    const r2 = sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 'sess-1',
    });
    const rows = listFailureEventsBySession(db, 'sess-1');
    expect(rows.length).toBe(2);
    expect(rows[1]?.prev_chain_hash).toBe(r1.this_chain_hash);
    expect(rows[1]?.this_chain_hash).toBe(r2.this_chain_hash);
  });

  test('session-scoped isolation: sessions A and B have independent chains', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-A',
    });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-B',
    });
    const a = listFailureEventsBySession(db, 'sess-A');
    const b = listFailureEventsBySession(db, 'sess-B');
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]?.prev_chain_hash).toBe(sha256Hex('sess-A'));
    expect(b[0]?.prev_chain_hash).toBe(sha256Hex('sess-B'));
    expect(a[0]?.this_chain_hash).not.toBe(b[0]?.this_chain_hash);
  });

  test('verifyChain ok on a fresh session chain', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-1',
    });
    sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 'sess-1',
    });
    const r = sink.verifyChain('sess-1');
    expect(r).toEqual({ ok: true, rows: 2 });
  });

  test('verifyChain detects tampering of this_chain_hash', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-1',
    });
    // Tamper: mutate the row directly via SQL.
    db.query(
      "UPDATE failure_events SET this_chain_hash = 'tampered' WHERE session_id = 'sess-1'",
    ).run();
    const r = sink.verifyChain('sess-1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('this_chain_hash_mismatch');
      expect(r.actual).toBe('tampered');
    }
  });

  test('verifyChain detects tampering of prev_chain_hash', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-1',
    });
    db.query(
      "UPDATE failure_events SET prev_chain_hash = 'tampered' WHERE session_id = 'sess-1'",
    ).run();
    const r = sink.verifyChain('sess-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('prev_chain_hash_mismatch');
  });
});

describe('createSqliteFailureSink — bootstrap-tier (pre-session)', () => {
  test('session_id defaults to BOOTSTRAP_SESSION_ID when omitted', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
    });
    const rows = listFailureEventsBySession(db, BOOTSTRAP_SESSION_ID);
    expect(rows.length).toBe(1);
    expect(rows[0]?.session_id).toBe(BOOTSTRAP_SESSION_ID);
  });

  test('bootstrap chain extends across calls', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    const r1 = sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'degraded',
      user_visible: true,
    });
    const r2 = sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'degraded',
      user_visible: true,
    });
    const rows = listFailureEventsBySession(db, BOOTSTRAP_SESSION_ID);
    expect(rows.length).toBe(2);
    expect(rows[1]?.prev_chain_hash).toBe(r1.this_chain_hash);
    expect(r2.this_chain_hash).not.toBe(r1.this_chain_hash);
  });
});

describe('createSqliteFailureSink — read primitives', () => {
  test('listFailureEventsByCode returns matching rows sorted DESC', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    const now = Date.now();
    sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      created_at: now - 10,
    });
    sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      created_at: now - 1,
    });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 's',
      created_at: now,
    });
    const r = listFailureEventsByCode(db, 'storage.lock_contention', now - 20, 100);
    expect(r.length).toBe(2);
    expect(r[0]?.created_at).toBe(now - 1); // newest first
    expect(r[1]?.created_at).toBe(now - 10);
  });
});

describe('createSqliteFailureSink — payload scrub', () => {
  test('payload is scrubbed before persist (paths redacted)', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      payload: { trace: 'failed at /home/lex/.config/agent/secrets' },
    });
    const rows = listFailureEventsBySession(db, 's');
    const payload = JSON.parse(rows[0]?.payload_json as string);
    expect(payload.trace).not.toContain('/home/lex/');
  });
});

// Slice 130 fixup #7 — review-driven gaps.
describe('createSqliteFailureSink — slice 130 fixup tests', () => {
  test('verifyChain on a session with zero rows returns ok+rows=0', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    expect(sink.verifyChain('never-existed')).toEqual({ ok: true, rows: 0 });
  });

  test('verifyChain detects a DELETED middle row (chain break in the prev links)', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'sess-mid',
    });
    const r2 = sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 'sess-mid',
    });
    sink.emit({
      code: 'sandbox.mid_session_loss',
      classe: 'sandbox',
      recovery_action: 'degraded',
      user_visible: true,
      session_id: 'sess-mid',
    });
    // Delete the middle row by id.
    db.query('DELETE FROM failure_events WHERE id = ?').run(r2.id);
    const v = sink.verifyChain('sess-mid');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('prev_chain_hash_mismatch');
  });

  test('two installs sharing BOOTSTRAP_SESSION_ID interleave on one chain (design tradeoff pinned)', () => {
    // Slice 130 intentionally chose NOT to add an install_id
    // column. The 'bootstrap' sentinel is shared across installs
    // on a shared DB volume. This test pins the documented
    // behavior so a future divergence is a CONSCIOUS change.
    const db = freshDb();
    const sinkA = createSqliteFailureSink({ db });
    const sinkB = createSqliteFailureSink({ db });
    sinkA.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'degraded',
      user_visible: true,
    });
    sinkB.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'degraded',
      user_visible: true,
    });
    const rows = listFailureEventsBySession(db, BOOTSTRAP_SESSION_ID);
    expect(rows.length).toBe(2);
    // Chain still verifies because emit B chained from emit A's
    // this_chain_hash via the same DB read.
    expect(sinkA.verifyChain(BOOTSTRAP_SESSION_ID)).toEqual({ ok: true, rows: 2 });
  });

  test('countFailureEvents exercises the barrel re-export', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    expect(countFailureEvents(db)).toBe(0);
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 's',
    });
    sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
    });
    expect(countFailureEvents(db)).toBe(2);
  });

  test('countFailuresByCodeSince groups by code with counts DESC', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    const now = Date.now();
    sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      created_at: now - 5,
    });
    sink.emit({
      code: 'storage.lock_contention',
      classe: 'storage',
      recovery_action: 'ignored',
      user_visible: false,
      session_id: 's',
      created_at: now - 3,
    });
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 's',
      created_at: now - 1,
    });
    const r = countFailuresByCodeSince(db, now - 100);
    expect(r).toEqual([
      { code: 'storage.lock_contention', count: 2 },
      { code: 'sandbox.tool_unavailable', count: 1 },
    ]);
  });

  // Slice 130 fixup #2: concurrent emits in the same session
  // serialize cleanly via BEGIN IMMEDIATE. Pre-fixup two
  // parallel emits could race for prev_chain_hash and one would
  // throw UNIQUE constraint silently. After the fixup both
  // persist with a valid chain.
  test('parallel emits in same session all persist with intact chain', async () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() =>
          sink.emit({
            code: 'storage.lock_contention',
            classe: 'storage',
            recovery_action: 'ignored',
            user_visible: false,
            session_id: 'race',
          }),
        ),
      ),
    );
    expect(results.length).toBe(N);
    const rows = listFailureEventsBySession(db, 'race');
    expect(rows.length).toBe(N);
    expect(sink.verifyChain('race')).toEqual({ ok: true, rows: N });
  });

  // Slice 130 fixup #4: bumped created_at must respect the same
  // future-skew tolerance the input check enforces. A caller
  // can plant a near-skew-cap created_at, then the NEXT emit's
  // bumped (last.created_at + 1) value must not silently exceed
  // the cap. Refuse to surface the drift.
  test('refuses emit when bumped created_at exceeds future-skew tolerance', () => {
    const db = freshDb();
    // Pin `now` so the test's chain-drift arithmetic is
    // deterministic. Without this, real Date.now() advances
    // between emits and the bumped-vs-skew comparison becomes
    // timing-dependent (fails under suite-load).
    const FIXED_NOW = 1_700_000_000_000;
    const sink = createSqliteFailureSink({ db, now: () => FIXED_NOW });
    const skewCap = 60 * 60 * 1000;
    // Plant a row right at the cap.
    sink.emit({
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 'drift',
      created_at: FIXED_NOW + skewCap,
    });
    // Chain head is at FIXED_NOW + skewCap. Next emit with no
    // input bumps to FIXED_NOW + skewCap + 1, which exceeds the
    // ceiling (FIXED_NOW + skewCap) by exactly 1 ms. Refuse.
    expect(() =>
      sink.emit({
        code: 'sandbox.tool_unavailable',
        classe: 'sandbox',
        recovery_action: 'fatal',
        user_visible: true,
        session_id: 'drift',
      }),
    ).toThrow(/chain timestamp drift/);
  });

  // Slice 130 fixup #3: `id` is no longer exposed on the public
  // emit input. Calling with an extra `id` property at runtime
  // (TS would catch it at compile, but runtime-typed callers
  // can still try) is ignored — the sink always generates the
  // ULID server-side.
  test('caller-supplied id (runtime-only) is ignored — sink always generates ULID', () => {
    const db = freshDb();
    const sink = createSqliteFailureSink({ db });
    // Bypass the TypeScript public surface (which forbids `id`)
    // by routing through Record<string, unknown> — simulates a
    // runtime-typed caller (untyped JS, broker IPC, malicious
    // import) that tries to plant an attacker-chosen ULID. The
    // sink must ignore the extra property and generate its own.
    const runtimeInput = {
      code: 'sandbox.tool_unavailable',
      classe: 'sandbox',
      recovery_action: 'fatal',
      user_visible: true,
      session_id: 's',
      id: 'ATTACKER-CHOSEN-ULID-26CHARS',
    } as unknown as Parameters<typeof sink.emit>[0];
    const result = sink.emit(runtimeInput);
    expect(result.id).not.toBe('ATTACKER-CHOSEN-ULID-26CHARS');
    expect(result.id.length).toBeGreaterThanOrEqual(20); // real ULID
  });
});
