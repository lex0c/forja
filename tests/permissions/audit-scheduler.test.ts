import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSealingScheduler,
  createSqliteSink,
  createWormFileSealer,
  ensureInstallId,
  type SealEntry,
  type SealStore,
  verifySealAgainstChain,
} from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-audit-sched-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const setupBase = () => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  const identity = ensureInstallId({
    env: { HOME: tmpRoot },
    now: () => 1,
    uuid: () => 'audit-sched-uuid',
  });
  return { db, identity };
};

// Slice 143 (API-3): the 7 load-bearing fields below are now
// required on AuditEmitInput; this fixture covers the scheduler
// integration so the field values themselves are irrelevant —
// default to "no signal" values.
const emitArgs = {
  capabilities: [] as readonly string[],
  score: 0,
  score_components: {},
  classifier_hash: 'none' as string | null,
  classifier_adjust: null as number | null,
  sandbox_profile: null as string | null,
  ttl_expires_at: null as number | null,
  session_id: 's',
  tool_name: 'bash',
  args: {},
  decision: 'allow' as const,
  policy_hash: 'sha256:p',
  reason_chain: [],
};

describe('createSqliteSink — §7.3 scheduler integration', () => {
  test('no scheduler → emit behaves exactly as before slice 56', () => {
    const { db, identity } = setupBase();
    const sink = createSqliteSink({ db, identity });
    const r = sink.emit({ ...emitArgs, ts: 100 });
    expect(r.seq).toBe(1);
    expect(r.this_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('scheduler.tick is invoked once per successful emit', () => {
    const { db, identity } = setupBase();
    let tickCount = 0;
    const sink = createSqliteSink({
      db,
      identity,
      scheduler: {
        tick: () => {
          tickCount++;
        },
      },
    });
    sink.emit({ ...emitArgs, ts: 100 });
    sink.emit({ ...emitArgs, ts: 101 });
    sink.emit({ ...emitArgs, ts: 102 });
    expect(tickCount).toBe(3);
  });

  test('tick fires AFTER the row is persisted — scheduler sees the new chain head', () => {
    // The contract: when scheduler.tick runs, the just-emitted row
    // is already in approvals_log. We verify by having the
    // scheduler-stub query the DB inside tick() and confirm the row
    // is visible.
    const { db, identity } = setupBase();
    const observedHeadSeqs: number[] = [];
    const sink = createSqliteSink({
      db,
      identity,
      scheduler: {
        tick: () => {
          const row = db
            .query('SELECT seq FROM approvals_log WHERE install_id = ? ORDER BY seq DESC LIMIT 1')
            .get(identity.install_id) as { seq: number } | null;
          observedHeadSeqs.push(row?.seq ?? -1);
        },
      },
    });
    sink.emit({ ...emitArgs, ts: 100 });
    sink.emit({ ...emitArgs, ts: 101 });
    expect(observedHeadSeqs).toEqual([1, 2]);
  });

  test('scheduler.tick throwing does NOT break emit (best-effort sealing)', () => {
    const { db, identity } = setupBase();
    const sink = createSqliteSink({
      db,
      identity,
      scheduler: {
        tick: () => {
          throw new Error('scheduler internals exploded');
        },
      },
    });
    // emit must still succeed + return a valid EmittedRow.
    const r = sink.emit({ ...emitArgs, ts: 100 });
    expect(r.seq).toBe(1);
    expect(r.this_hash).toMatch(/^[a-f0-9]{64}$/);
    // The row landed.
    const row = db
      .query('SELECT seq FROM approvals_log WHERE install_id = ?')
      .get(identity.install_id) as { seq: number } | null;
    expect(row?.seq).toBe(1);
  });

  test('full integration — real scheduler + worm-file sealer fires at decision threshold', () => {
    // End-to-end: createSqliteSink + createSealingScheduler +
    // createWormFileSealer. Pin that the audit path drives sealing
    // through real components (no mocks beyond fs seams), then
    // verifySealAgainstChain confirms the seal entries match.
    const { db, identity } = setupBase();
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
      intervalDecisions: 4,
      intervalSeconds: 0,
      setTimer: () => null,
      clearTimer: () => {},
    });
    const sink = createSqliteSink({ db, identity, scheduler });
    // 10 emits — expect seals at decisions 4 and 8 (seq=4 and seq=8).
    for (let i = 0; i < 10; i++) {
      sink.emit({ ...emitArgs, session_id: `s${i}`, ts: 100 + i });
    }
    const sealedRows = sealer.list();
    expect(sealedRows).toHaveLength(2);
    expect(sealedRows[0]?.seq).toBe(4);
    expect(sealedRows[1]?.seq).toBe(8);
    const v = verifySealAgainstChain(sealer, db, identity.install_id);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.entriesChecked).toBe(2);
    scheduler.close();
  });

  test('scheduler stub matches the structural-typed contract', () => {
    // Sanity: the sink's scheduler option is structurally typed as
    // `{ tick(): void }`. Anything implementing that shape works,
    // including a hand-rolled stub or the full SealingScheduler.
    const { db, identity } = setupBase();
    const captured: { entries: SealEntry[] } = { entries: [] };
    const memStore: SealStore = {
      append: (e) => {
        captured.entries.push(e);
        return { ok: true };
      },
      list: () => captured.entries.slice(),
      close: () => {},
    };
    const scheduler = createSealingScheduler({
      store: memStore,
      db,
      installId: identity.install_id,
      intervalDecisions: 1,
      intervalSeconds: 0,
      setTimer: () => null,
      clearTimer: () => {},
    });
    const sink = createSqliteSink({ db, identity, scheduler });
    sink.emit({ ...emitArgs, ts: 100 });
    sink.emit({ ...emitArgs, ts: 101 });
    expect(captured.entries).toHaveLength(2);
    scheduler.close();
  });
});
