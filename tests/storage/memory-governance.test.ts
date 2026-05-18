// memory_governance_proposals repo tests (migration 056, S8).
//
// Pin the substrate contracts so the slash command + apply path can
// build on stable behavior:
//   - Insert validates kinds, scopes, snapshot bijection, confidence
//     range.
//   - Fingerprint is deterministic across key ordering.
//   - UNIQUE partial index dedups pending; applied/rejected can
//     coexist.
//   - List helpers respect status / session filters.
//   - decideProposal is idempotent and gated on status='pending'.
//   - expirePendingProposals honors the cutoff and only touches
//     pending rows.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb, withTransaction } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  GOVERNANCE_PROPOSAL_TTL_MS,
  MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS,
  MAX_GOVERNANCE_PROPOSAL_DEFER_HORIZON_MS,
  type MemoryKey,
  type MemorySnapshot,
  type RecordProposalInput,
  computeProposalFingerprint,
  decideProposal,
  deferProposal,
  expirePendingProposals,
  getProposalById,
  listPendingProposals,
  listPendingProposalsForMemory,
  listProposals,
  listProposalsForMemory,
  recordProposal,
} from '../../src/storage/repos/memory-governance.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

const SNAP_HASH_A = 'a'.repeat(64);
const SNAP_HASH_B = 'b'.repeat(64);

const baseProposal = (overrides: Partial<RecordProposalInput> = {}): RecordProposalInput => {
  const keys: MemoryKey[] = overrides.sourceMemoryKeys ?? [{ scope: 'project_local', name: 'foo' }];
  const snapshots: MemorySnapshot[] =
    overrides.sourceMemorySnapshots ??
    keys.map((k) => ({
      scope: k.scope,
      name: k.name,
      contentHash: SNAP_HASH_A,
    }));
  return {
    sessionId,
    kind: 'quarantine',
    sourceMemoryKeys: keys,
    sourceMemorySnapshots: snapshots,
    evidence: { claim: 'memory contradicts code' },
    proposedBy: 'subagent:verify-semantic',
    confidence: 0.85,
    ...overrides,
  };
};

describe('computeProposalFingerprint', () => {
  test('deterministic across key ordering (canonical sort)', () => {
    const a = computeProposalFingerprint({
      kind: 'quarantine',
      sourceMemoryKeys: [
        { scope: 'project_local', name: 'b' },
        { scope: 'project_local', name: 'a' },
      ],
      evidenceEssence: 'shared',
    });
    const b = computeProposalFingerprint({
      kind: 'quarantine',
      sourceMemoryKeys: [
        { scope: 'project_local', name: 'a' },
        { scope: 'project_local', name: 'b' },
      ],
      evidenceEssence: 'shared',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different kinds produce different fingerprints', () => {
    const keys: MemoryKey[] = [{ scope: 'project_local', name: 'a' }];
    expect(
      computeProposalFingerprint({
        kind: 'quarantine',
        sourceMemoryKeys: keys,
        evidenceEssence: 'e',
      }),
    ).not.toBe(
      computeProposalFingerprint({ kind: 'restore', sourceMemoryKeys: keys, evidenceEssence: 'e' }),
    );
  });

  test('different evidence essence produces different fingerprints', () => {
    const keys: MemoryKey[] = [{ scope: 'project_local', name: 'a' }];
    expect(
      computeProposalFingerprint({
        kind: 'quarantine',
        sourceMemoryKeys: keys,
        evidenceEssence: 'x',
      }),
    ).not.toBe(
      computeProposalFingerprint({
        kind: 'quarantine',
        sourceMemoryKeys: keys,
        evidenceEssence: 'y',
      }),
    );
  });
});

describe('recordProposal — validation', () => {
  test('persists a well-formed proposal with all fields round-tripped', () => {
    const r = recordProposal(db, baseProposal({ targetPayload: { motivo: 'conflict' } }));
    expect(r.deduped).toBe(false);
    const row = getProposalById(db, r.id);
    expect(row).not.toBeNull();
    if (row === null) return;
    expect(row.kind).toBe('quarantine');
    expect(row.status).toBe('pending');
    expect(row.confidence).toBeCloseTo(0.85);
    expect(row.proposedBy).toBe('subagent:verify-semantic');
    expect(row.sourceMemoryKeys).toEqual([{ scope: 'project_local', name: 'foo' }]);
    expect(row.sourceMemorySnapshots[0]?.contentHash).toBe(SNAP_HASH_A);
    expect(row.targetPayload).toEqual({ motivo: 'conflict' });
    expect(row.evidence).toEqual({ claim: 'memory contradicts code' });
    expect(row.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects invalid kind', () => {
    expect(() => recordProposal(db, baseProposal({ kind: 'invalid' as never }))).toThrow(
      /invalid kind/,
    );
  });

  test('rejects empty sourceMemoryKeys', () => {
    expect(() =>
      recordProposal(db, baseProposal({ sourceMemoryKeys: [], sourceMemorySnapshots: [] })),
    ).toThrow(/must be non-empty/);
  });

  test('rejects snapshot/key length mismatch', () => {
    expect(() =>
      recordProposal(
        db,
        baseProposal({
          sourceMemoryKeys: [{ scope: 'user', name: 'a' }],
          sourceMemorySnapshots: [
            { scope: 'user', name: 'a', contentHash: SNAP_HASH_A },
            { scope: 'user', name: 'b', contentHash: SNAP_HASH_B },
          ],
        }),
      ),
    ).toThrow(/length .* must match/);
  });

  test('rejects snapshot bijection mismatch (different scope/name set)', () => {
    expect(() =>
      recordProposal(
        db,
        baseProposal({
          sourceMemoryKeys: [{ scope: 'user', name: 'a' }],
          sourceMemorySnapshots: [{ scope: 'user', name: 'mismatch', contentHash: SNAP_HASH_A }],
        }),
      ),
    ).toThrow(/missing snapshot/);
  });

  test('rejects confidence out of [0, 1]', () => {
    expect(() => recordProposal(db, baseProposal({ confidence: 1.5 }))).toThrow(
      /confidence must be in/,
    );
    expect(() => recordProposal(db, baseProposal({ confidence: -0.1 }))).toThrow(
      /confidence must be in/,
    );
  });

  test('null confidence persists (operator/deterministic-detector bypass)', () => {
    const r = recordProposal(db, baseProposal({ confidence: null }));
    const row = getProposalById(db, r.id);
    expect(row?.confidence).toBeNull();
  });
});

describe('recordProposal — fingerprint dedup', () => {
  test('second pending INSERT with same fingerprint returns existing id with deduped=true', () => {
    const first = recordProposal(db, baseProposal());
    const second = recordProposal(db, baseProposal());
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    const all = listProposals(db);
    expect(all).toHaveLength(1);
  });

  test('different evidence-essence creates a separate pending proposal', () => {
    const first = recordProposal(db, baseProposal({ evidenceEssence: 'e1' }));
    const second = recordProposal(db, baseProposal({ evidenceEssence: 'e2' }));
    expect(second.deduped).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(listProposals(db)).toHaveLength(2);
  });

  test('applied row + new pending row share fingerprint without conflict', () => {
    const first = recordProposal(db, baseProposal());
    decideProposal(db, first.id, { status: 'applied', decidedBy: 'operator:test', decidedAt: 100 });
    const second = recordProposal(db, baseProposal());
    expect(second.deduped).toBe(false);
    expect(second.id).not.toBe(first.id);
    expect(listProposals(db, { status: 'pending' })).toHaveLength(1);
    expect(listProposals(db, { status: 'applied' })).toHaveLength(1);
  });
});

describe('list helpers', () => {
  test('listPendingProposals returns only pending, most-recent first', () => {
    const a = recordProposal(db, baseProposal({ createdAt: 1000 }));
    const b = recordProposal(db, baseProposal({ createdAt: 2000, evidenceEssence: 'e2' }));
    decideProposal(db, a.id, { status: 'applied', decidedBy: 'operator:test', decidedAt: 3000 });
    const pending = listPendingProposals(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(b.id);
  });

  test('listProposals filters by status', () => {
    const a = recordProposal(db, baseProposal({ createdAt: 1000 }));
    recordProposal(db, baseProposal({ createdAt: 2000, evidenceEssence: 'e2' }));
    decideProposal(db, a.id, { status: 'rejected', decidedBy: 'operator:test', decidedAt: 3000 });
    expect(listProposals(db, { status: 'rejected' })).toHaveLength(1);
    expect(listProposals(db, { status: 'pending' })).toHaveLength(1);
    expect(listProposals(db, { status: 'applied' })).toHaveLength(0);
  });

  test('listProposals filters by sessionId', () => {
    const other = createSession(db, { model: 'm', cwd: '/p2' }).id;
    recordProposal(db, baseProposal({ createdAt: 1000 }));
    recordProposal(db, baseProposal({ createdAt: 2000, sessionId: other, evidenceEssence: 'e2' }));
    expect(listProposals(db, { sessionId })).toHaveLength(1);
    expect(listProposals(db, { sessionId: other })).toHaveLength(1);
    expect(listProposals(db, { sessionId: null })).toHaveLength(0);
  });

  test('listProposalsForMemory traverses auxiliary key table for multi-memory proposals', () => {
    // Memory `foo` referenced as winner; memory `bar` as loser. Single
    // proposal spans both — the JOIN through memory_governance_proposal_keys
    // should surface the same proposal from either lookup.
    const r = recordProposal(
      db,
      baseProposal({
        kind: 'merge',
        sourceMemoryKeys: [
          { scope: 'project_local', name: 'foo' },
          { scope: 'project_local', name: 'bar' },
        ],
        sourceMemorySnapshots: [
          { scope: 'project_local', name: 'foo', contentHash: SNAP_HASH_A },
          { scope: 'project_local', name: 'bar', contentHash: SNAP_HASH_B },
        ],
      }),
    );
    const fooHits = listProposalsForMemory(db, 'project_local', 'foo');
    const barHits = listProposalsForMemory(db, 'project_local', 'bar');
    expect(fooHits).toHaveLength(1);
    expect(barHits).toHaveLength(1);
    expect(fooHits[0]?.id).toBe(r.id);
    expect(barHits[0]?.id).toBe(r.id);
  });

  test('listPendingProposalsForMemory filters out non-pending proposals', () => {
    const r = recordProposal(db, baseProposal());
    expect(listPendingProposalsForMemory(db, 'project_local', 'foo')).toHaveLength(1);
    decideProposal(db, r.id, { status: 'applied', decidedBy: 'operator:test', decidedAt: 100 });
    expect(listPendingProposalsForMemory(db, 'project_local', 'foo')).toHaveLength(0);
    expect(listProposalsForMemory(db, 'project_local', 'foo')).toHaveLength(1);
  });

  test('memory-scoped queries SELECT deferred_until + defer_count (regression)', () => {
    // Pre-fix, both `listProposalsForMemory` and
    // `listPendingProposalsForMemory` omitted `p.deferred_until` and
    // `p.defer_count` from the SELECT list — `fromRow` then read
    // `undefined` instead of the persisted values. Consumers doing
    // `deferredUntil !== null` (e.g.,
    // `cli/slash/commands/memory.ts:2507`) treated `undefined` as
    // "deferred" and rendered "deferred_until: undefined" in the
    // governance show output.
    //
    // This pin catches the regression at the repo boundary: fresh
    // proposals expose `null` / `0`, deferred proposals expose the
    // real values — `undefined` is never a legal observation.
    const r = recordProposal(db, baseProposal());

    const freshList = listProposalsForMemory(db, 'project_local', 'foo');
    expect(freshList).toHaveLength(1);
    expect(freshList[0]?.deferredUntil).toBeNull();
    expect(freshList[0]?.deferCount).toBe(0);

    const freshPending = listPendingProposalsForMemory(db, 'project_local', 'foo');
    expect(freshPending).toHaveLength(1);
    expect(freshPending[0]?.deferredUntil).toBeNull();
    expect(freshPending[0]?.deferCount).toBe(0);

    const deferResult = deferProposal(db, r.id, { additionalDays: 7, nowMs: Date.now() });
    expect(deferResult.ok).toBe(true);
    if (!deferResult.ok) return;

    const deferredList = listProposalsForMemory(db, 'project_local', 'foo');
    expect(deferredList[0]?.deferredUntil).toBe(deferResult.deferredUntil);
    expect(deferredList[0]?.deferCount).toBe(1);

    const deferredPending = listPendingProposalsForMemory(db, 'project_local', 'foo');
    expect(deferredPending[0]?.deferredUntil).toBe(deferResult.deferredUntil);
    expect(deferredPending[0]?.deferCount).toBe(1);
  });
});

describe('decideProposal', () => {
  test('transitions pending → applied with metadata', () => {
    const r = recordProposal(db, baseProposal());
    const changed = decideProposal(db, r.id, {
      status: 'applied',
      decidedBy: 'operator:slash',
      decidedReason: 'manually approved',
      decidedAt: 5000,
    });
    expect(changed).toBe(true);
    const row = getProposalById(db, r.id);
    expect(row?.status).toBe('applied');
    expect(row?.decidedBy).toBe('operator:slash');
    expect(row?.decidedReason).toBe('manually approved');
    expect(row?.decidedAt).toBe(5000);
  });

  test('returns false on a row already decided (idempotency)', () => {
    const r = recordProposal(db, baseProposal());
    decideProposal(db, r.id, { status: 'applied', decidedBy: 'operator:slash', decidedAt: 5000 });
    const second = decideProposal(db, r.id, {
      status: 'rejected',
      decidedBy: 'operator:slash',
      decidedAt: 5001,
    });
    expect(second).toBe(false);
    expect(getProposalById(db, r.id)?.status).toBe('applied');
  });

  test('returns false on unknown id', () => {
    const changed = decideProposal(db, 'nonexistent', {
      status: 'applied',
      decidedBy: 'operator:slash',
      decidedAt: 5000,
    });
    expect(changed).toBe(false);
  });

  test('rejects non-positive decidedAt', () => {
    const r = recordProposal(db, baseProposal());
    expect(() =>
      decideProposal(db, r.id, { status: 'applied', decidedBy: 'op', decidedAt: 0 }),
    ).toThrow(/decidedAt must be > 0/);
  });
});

describe('expirePendingProposals', () => {
  test('expires pending rows older than cutoff and leaves newer/non-pending alone', () => {
    // Realistic timestamp so `now - TTL` stays positive (the schema
    // CHECK enforces created_at > 0; using a small `now` made the
    // pre-cutoff insert go negative).
    const now = 2_000_000_000_000; // ~2033 in epoch ms
    // Created at now-TTL-1 — should expire.
    const old = recordProposal(
      db,
      baseProposal({ createdAt: now - GOVERNANCE_PROPOSAL_TTL_MS - 1 }),
    );
    // Created at exactly cutoff — KEPT (exclusive boundary).
    const onBoundary = recordProposal(
      db,
      baseProposal({
        createdAt: now - GOVERNANCE_PROPOSAL_TTL_MS,
        evidenceEssence: 'e2',
      }),
    );
    // Fresh — KEPT.
    const fresh = recordProposal(db, baseProposal({ createdAt: now, evidenceEssence: 'e3' }));
    // Already applied row stays untouched (status filter).
    const decided = recordProposal(
      db,
      baseProposal({ createdAt: now - GOVERNANCE_PROPOSAL_TTL_MS - 100, evidenceEssence: 'e4' }),
    );
    decideProposal(db, decided.id, {
      status: 'applied',
      decidedBy: 'operator:test',
      decidedAt: now - 1000,
    });

    const expired = expirePendingProposals(db, now - GOVERNANCE_PROPOSAL_TTL_MS, now);
    expect(expired).toBe(1);
    expect(getProposalById(db, old.id)?.status).toBe('expired');
    expect(getProposalById(db, old.id)?.decidedBy).toBe('system:ttl');
    expect(getProposalById(db, onBoundary.id)?.status).toBe('pending');
    expect(getProposalById(db, fresh.id)?.status).toBe('pending');
    expect(getProposalById(db, decided.id)?.status).toBe('applied');
  });

  test('returns 0 when no pending rows exist', () => {
    expect(expirePendingProposals(db, Date.now(), Date.now())).toBe(0);
  });

  test('new options-object signature handles ttlMs + nowMs', () => {
    const now = 2_000_000_000_000;
    const old = recordProposal(
      db,
      baseProposal({ createdAt: now - GOVERNANCE_PROPOSAL_TTL_MS - 1 }),
    );
    const fresh = recordProposal(db, baseProposal({ createdAt: now, evidenceEssence: 'e2' }));
    const expired = expirePendingProposals(db, {
      ttlMs: GOVERNANCE_PROPOSAL_TTL_MS,
      nowMs: now,
    });
    expect(expired).toBe(1);
    expect(getProposalById(db, old.id)?.status).toBe('expired');
    expect(getProposalById(db, fresh.id)?.status).toBe('pending');
  });

  test('deferred_until overrides created_at + ttlMs when set', () => {
    const now = 2_000_000_000_000;
    // Old enough that the default TTL would expire it…
    const r = recordProposal(db, baseProposal({ createdAt: now - GOVERNANCE_PROPOSAL_TTL_MS - 1 }));
    // …but operator defers 30 more days, pushing effective expiry
    // past `now` (the proposal stays pending past the original cutoff).
    const result = deferProposal(db, r.id, { additionalDays: 30, nowMs: now });
    expect(result.ok).toBe(true);
    const expired = expirePendingProposals(db, {
      ttlMs: GOVERNANCE_PROPOSAL_TTL_MS,
      nowMs: now,
    });
    expect(expired).toBe(0);
    expect(getProposalById(db, r.id)?.status).toBe('pending');
  });

  test('deferred row whose deferred_until has passed expires normally', () => {
    const now = 2_000_000_000_000;
    const r = recordProposal(db, baseProposal({ createdAt: now - 1000 }));
    // Defer puts deferred_until at `Math.max(now, createdAt+TTL) +
    // 1d`. After the cutoff sweep at now + 1d + 1, the row expires.
    deferProposal(db, r.id, { additionalDays: 1, nowMs: now });
    const cutoffNow = now + GOVERNANCE_PROPOSAL_TTL_MS + 24 * 60 * 60 * 1000 + 1;
    const expired = expirePendingProposals(db, {
      ttlMs: GOVERNANCE_PROPOSAL_TTL_MS,
      nowMs: cutoffNow,
    });
    expect(expired).toBe(1);
    expect(getProposalById(db, r.id)?.status).toBe('expired');
  });
});

describe('deferProposal', () => {
  test('happy path: bumps deferred_until and increments defer_count', () => {
    const now = 2_000_000_000_000;
    const r = recordProposal(db, baseProposal({ createdAt: now }));
    const result = deferProposal(db, r.id, { additionalDays: 7, nowMs: now });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Anchor = max(now, createdAt + 30d) = createdAt + 30d; +7d on top.
    expect(result.deferredUntil).toBe(now + GOVERNANCE_PROPOSAL_TTL_MS + 7 * 24 * 60 * 60 * 1000);
    expect(result.deferCount).toBe(1);
    const reread = getProposalById(db, r.id);
    expect(reread?.deferredUntil).toBe(result.deferredUntil);
    expect(reread?.deferCount).toBe(1);
  });

  test('successive defers stack on the prior expiry, not on wall-clock now', () => {
    const now = 2_000_000_000_000;
    const r = recordProposal(db, baseProposal({ createdAt: now }));
    const first = deferProposal(db, r.id, { additionalDays: 10, nowMs: now });
    expect(first.ok).toBe(true);
    const second = deferProposal(db, r.id, { additionalDays: 5, nowMs: now });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.deferredUntil).toBe(first.deferredUntil + 5 * 24 * 60 * 60 * 1000);
    expect(second.deferCount).toBe(2);
  });

  test('defer past the 90d horizon from created_at rejects', () => {
    const now = 2_000_000_000_000;
    const r = recordProposal(db, baseProposal({ createdAt: now }));
    // 90d total ceiling = createdAt + 90d. 30d default expiry +
    // 90d defer would land at createdAt + 120d, past the ceiling.
    const result = deferProposal(db, r.id, {
      additionalDays: MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS,
      nowMs: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('horizon_exceeded');
    // Row stays untouched.
    const reread = getProposalById(db, r.id);
    expect(reread?.deferredUntil).toBeNull();
    expect(reread?.deferCount).toBe(0);
  });

  test('horizon ceiling exactly: 60d (TTL + 60 = 90d) succeeds, 61d fails', () => {
    const now = 2_000_000_000_000;
    const sixtyDays = 60;
    const a = recordProposal(db, baseProposal({ createdAt: now }));
    const okResult = deferProposal(db, a.id, { additionalDays: sixtyDays, nowMs: now });
    expect(okResult.ok).toBe(true);
    if (!okResult.ok) throw new Error('unreachable');
    expect(okResult.deferredUntil).toBe(now + MAX_GOVERNANCE_PROPOSAL_DEFER_HORIZON_MS);
    const b = recordProposal(db, baseProposal({ createdAt: now, evidenceEssence: 'e2' }));
    const failResult = deferProposal(db, b.id, { additionalDays: sixtyDays + 1, nowMs: now });
    expect(failResult.ok).toBe(false);
    if (failResult.ok) throw new Error('unreachable');
    expect(failResult.reason).toBe('horizon_exceeded');
  });

  test('rejects on non-pending status', () => {
    const r = recordProposal(db, baseProposal());
    decideProposal(db, r.id, { status: 'applied', decidedBy: 'op' });
    const result = deferProposal(db, r.id, { additionalDays: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_pending');
  });

  test('rejects unknown id with not_pending', () => {
    const result = deferProposal(db, '00000000-0000-0000-0000-000000000000', {
      additionalDays: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_pending');
  });

  test('rejects zero / negative / non-integer days as invalid_days', () => {
    const r = recordProposal(db, baseProposal());
    for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = deferProposal(db, r.id, { additionalDays: days });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('invalid_days');
    }
  });

  test('rejects days > MAX as invalid_days (before consulting horizon)', () => {
    const r = recordProposal(db, baseProposal());
    const result = deferProposal(db, r.id, {
      additionalDays: MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_days');
  });

  test('serialization: result fields match post-update DB state after each defer', () => {
    // Pins the IMMEDIATE-transaction contract: even when defers
    // stack against the same row, each call's returned
    // `deferredUntil` + `deferCount` must equal what a fresh read
    // would observe right after. JS single-threading means the two
    // calls below execute serially (not truly concurrent), but the
    // assertion shape catches regressions where the result is
    // computed off a stale read instead of inside the lock.
    const now = 2_000_000_000_000;
    const r = recordProposal(db, baseProposal({ createdAt: now }));
    const first = deferProposal(db, r.id, { additionalDays: 3, nowMs: now });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    const afterFirst = getProposalById(db, r.id);
    expect(afterFirst?.deferredUntil).toBe(first.deferredUntil);
    expect(afterFirst?.deferCount).toBe(first.deferCount);

    const second = deferProposal(db, r.id, { additionalDays: 4, nowMs: now });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    const afterSecond = getProposalById(db, r.id);
    expect(afterSecond?.deferredUntil).toBe(second.deferredUntil);
    expect(afterSecond?.deferCount).toBe(second.deferCount);
    // Second's deferredUntil anchors on first's (not on `now`):
    expect(second.deferredUntil).toBe(first.deferredUntil + 4 * 24 * 60 * 60 * 1000);
    expect(second.deferCount).toBe(2);
  });
});

describe('schema gates', () => {
  test('confidence CHECK rejects values outside [0, 1] at the DB level', () => {
    // Bypass repo validation by hitting the raw SQL — the CHECK is
    // defense-in-depth against a future caller that skips the repo.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_governance_proposals
             (id, kind, source_memory_keys, evidence, status, proposed_by,
              proposal_fingerprint, source_memory_snapshots, created_at, confidence)
           VALUES (?, 'quarantine', '[]', '{}', 'pending', 'op',
                   'fp', '[]', 1000, 5.0)`,
        )
        .run('id-1'),
    ).toThrow(/CHECK constraint/);
  });

  test('created_at CHECK rejects 0 or negative', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_governance_proposals
             (id, kind, source_memory_keys, evidence, status, proposed_by,
              proposal_fingerprint, source_memory_snapshots, created_at)
           VALUES (?, 'quarantine', '[]', '{}', 'pending', 'op', 'fp', '[]', 0)`,
        )
        .run('id-2'),
    ).toThrow(/CHECK constraint/);
  });

  test('FK CASCADE drops auxiliary key rows when parent is deleted', () => {
    const r = recordProposal(
      db,
      baseProposal({
        kind: 'merge',
        sourceMemoryKeys: [
          { scope: 'project_local', name: 'foo' },
          { scope: 'project_shared', name: 'bar' },
        ],
        sourceMemorySnapshots: [
          { scope: 'project_local', name: 'foo', contentHash: SNAP_HASH_A },
          { scope: 'project_shared', name: 'bar', contentHash: SNAP_HASH_B },
        ],
      }),
    );
    const before = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM memory_governance_proposal_keys WHERE proposal_id = '${r.id}'`,
      )
      .get();
    expect(before?.n).toBe(2);
    db.query('DELETE FROM memory_governance_proposals WHERE id = ?').run(r.id);
    const after = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM memory_governance_proposal_keys WHERE proposal_id = '${r.id}'`,
      )
      .get();
    expect(after?.n).toBe(0);
  });

  // ── post-review hardening (F1/F2/F6/T1/T2/T3/T4/T5) ────────────────

  test('DB-level CHECK rejects invalid `kind` (raw bypass)', () => {
    // Bypass repo validation — pin that the DB's CHECK is the last
    // line of defense if a future caller skips the repo.
    expect(() =>
      db
        .query(
          `INSERT INTO memory_governance_proposals
             (id, kind, source_memory_keys, evidence, status, proposed_by,
              proposal_fingerprint, source_memory_snapshots, created_at)
           VALUES (?, 'bogus_kind', '[]', '{}', 'pending', 'op', 'fp', '[]', 1000)`,
        )
        .run('id-bad-kind'),
    ).toThrow(/CHECK constraint/);
  });

  test('DB-level CHECK rejects invalid `status` (raw bypass)', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO memory_governance_proposals
             (id, kind, source_memory_keys, evidence, status, proposed_by,
              proposal_fingerprint, source_memory_snapshots, created_at)
           VALUES (?, 'quarantine', '[]', '{}', 'nuked', 'op', 'fp', '[]', 1000)`,
        )
        .run('id-bad-status'),
    ).toThrow(/CHECK constraint/);
  });

  test('DB-level CHECK rejects non-positive `decided_at` (raw bypass)', () => {
    db.query(
      `INSERT INTO memory_governance_proposals
           (id, kind, source_memory_keys, evidence, status, proposed_by,
            proposal_fingerprint, source_memory_snapshots, created_at)
         VALUES ('id-decided', 'quarantine', '[]', '{}', 'pending', 'op', 'fp', '[]', 1000)`,
    ).run();
    expect(() =>
      db
        .query('UPDATE memory_governance_proposals SET decided_at = ? WHERE id = ?')
        .run(-1, 'id-decided'),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db
        .query('UPDATE memory_governance_proposals SET decided_at = ? WHERE id = ?')
        .run(0, 'id-decided'),
    ).toThrow(/CHECK constraint/);
  });

  test('FK session_id ON DELETE SET NULL (proposal survives session purge)', () => {
    const r = recordProposal(db, baseProposal());
    expect(getProposalById(db, r.id)?.sessionId).toBe(sessionId);
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    const after = getProposalById(db, r.id);
    expect(after).not.toBeNull();
    expect(after?.sessionId).toBeNull();
  });

  test('recordProposal rejects empty proposedBy', () => {
    expect(() => recordProposal(db, baseProposal({ proposedBy: '' }))).toThrow(
      /proposedBy must be non-empty/,
    );
  });

  test('recordProposal rejects createdAt <= 0', () => {
    expect(() => recordProposal(db, baseProposal({ createdAt: 0 }))).toThrow(
      /createdAt must be > 0/,
    );
    expect(() => recordProposal(db, baseProposal({ createdAt: -1 }))).toThrow(
      /createdAt must be > 0/,
    );
  });

  test('recordProposal rejects invalid memory scope in keys', () => {
    // 'shared' is the slash-arg form; the canonical scope is
    // 'project_shared'. A typo at the repo boundary must throw.
    expect(() =>
      recordProposal(
        db,
        baseProposal({
          sourceMemoryKeys: [{ scope: 'shared' as never, name: 'foo' }],
          sourceMemorySnapshots: [
            { scope: 'shared' as never, name: 'foo', contentHash: SNAP_HASH_A },
          ],
        }),
      ),
    ).toThrow(/invalid memory scope/);
  });

  test('duplicate (scope, name) in keys → UNIQUE constraint on the keys table', () => {
    // The bijection check uses Set semantics which silently dedups
    // identical key entries; the auxiliary table's PRIMARY KEY
    // (proposal_id, scope, name) is the load-bearing gate against
    // duplicate keys reaching the index. Pinning the DB-level
    // protection matters because callers passing duplicate keys
    // would otherwise silently land partial index rows.
    expect(() =>
      recordProposal(
        db,
        baseProposal({
          sourceMemoryKeys: [
            { scope: 'project_local', name: 'foo' },
            { scope: 'project_local', name: 'foo' },
          ],
          sourceMemorySnapshots: [
            { scope: 'project_local', name: 'foo', contentHash: SNAP_HASH_A },
            { scope: 'project_local', name: 'foo', contentHash: SNAP_HASH_B },
          ],
        }),
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  test('PRIMARY KEY collision on caller-supplied id with different fingerprint re-throws', () => {
    // First INSERT pins the id with a specific evidence essence.
    recordProposal(db, baseProposal({ id: 'pinned-id', evidenceEssence: 'first' }));
    // Second INSERT with same id but different essence → the
    // fingerprint differs, the partial UNIQUE doesn't match, so the
    // PRIMARY KEY CHECK fires and the catch path's existing-row
    // lookup returns null → re-throws.
    expect(() =>
      recordProposal(db, baseProposal({ id: 'pinned-id', evidenceEssence: 'second' })),
    ).toThrow();
  });

  test('listProposals(sessionId: null) surfaces null-session rows', () => {
    recordProposal(db, baseProposal({ sessionId: null }));
    recordProposal(db, baseProposal({ evidenceEssence: 'other' })); // sessionId set
    const nullRows = listProposals(db, { sessionId: null });
    expect(nullRows).toHaveLength(1);
    expect(nullRows[0]?.sessionId).toBeNull();
  });

  test('listPendingProposalsForMemory isolates scope', () => {
    // Same name in two scopes; lookup by (scope, name) returns only
    // the matching scope. Regression: a JOIN that ignored memory_scope
    // would return both.
    recordProposal(
      db,
      baseProposal({
        sourceMemoryKeys: [{ scope: 'user', name: 'foo' }],
        sourceMemorySnapshots: [{ scope: 'user', name: 'foo', contentHash: SNAP_HASH_A }],
      }),
    );
    recordProposal(
      db,
      baseProposal({
        sourceMemoryKeys: [{ scope: 'project_local', name: 'foo' }],
        sourceMemorySnapshots: [{ scope: 'project_local', name: 'foo', contentHash: SNAP_HASH_B }],
        evidenceEssence: 'other',
      }),
    );
    expect(listPendingProposalsForMemory(db, 'user', 'foo')).toHaveLength(1);
    expect(listPendingProposalsForMemory(db, 'project_local', 'foo')).toHaveLength(1);
    expect(listPendingProposalsForMemory(db, 'user', 'foo')[0]?.sourceMemoryKeys[0]?.scope).toBe(
      'user',
    );
  });

  test('recordProposal inside withTransaction does NOT roll back the outer txn (F1)', () => {
    // Pre-fix this would throw "cannot start a transaction within a
    // transaction" and / or roll back the outer transaction.
    const markerSession = createSession(db, { model: 'marker', cwd: '/marker' });
    const proposalId = withTransaction(db, () => {
      const r = recordProposal(db, baseProposal());
      // Mutate something else in the outer txn — if the inner
      // recordProposal had rolled back the outer, this UPDATE would
      // be invisible after COMMIT.
      db.query("UPDATE sessions SET model = 'rotated' WHERE id = ?").run(markerSession.id);
      return r.id;
    });
    expect(getProposalById(db, proposalId)).not.toBeNull();
    const row = db
      .query<{ model: string }, [string]>('SELECT model FROM sessions WHERE id = ?')
      .get(markerSession.id);
    expect(row?.model).toBe('rotated');
  });

  test('default evidenceEssence is key-order stable (F2)', () => {
    // Two proposals with the same evidence fields in different
    // insertion orders MUST collapse to one pending row via the
    // canonical default essence.
    const first = recordProposal(
      db,
      baseProposal({
        evidence: { a: 1, b: 2, nested: { x: 10, y: 20 } },
      }),
    );
    const second = recordProposal(
      db,
      baseProposal({
        evidence: { b: 2, nested: { y: 20, x: 10 }, a: 1 },
      }),
    );
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test('computeProposalFingerprint pins canonical hex for a known input (T11)', () => {
    // Pin a SPECIFIC value so a future change to the canonical JSON
    // shape breaks loudly. The exact hex below was captured against
    // the current canonicalization; if you change the shape, update
    // this AND the deployed dedup will need re-bootstrapping.
    const fp = computeProposalFingerprint({
      kind: 'quarantine',
      sourceMemoryKeys: [{ scope: 'project_local', name: 'foo' }],
      evidenceEssence: 'fixed-essence',
    });
    expect(fp).toBe('40586b68943ec211d9a909e064432b60705c84519dc44a0689ea33ebed0ee0ef');
  });
});
