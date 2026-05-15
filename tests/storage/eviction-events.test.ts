import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  type AppendEvictionEventInput,
  IllegalTransitionError,
  InvalidEvictionInputError,
  appendEvictionEvent,
  countEvictionEvents,
  detectTriggerThrashing,
  getLastAppliedEvictionForObject,
  getLastEvictionForObject,
  getLastQuarantineEvent,
  isLegalTransition,
  listEvictableInWindow,
  listEvictedDueForPurge,
} from '../../src/storage/repos/eviction-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

// Minimum evidence shape per motivo so validInput() produces rows
// that satisfy the §6.1 schema validation. Tests that need to
// exercise the validator directly override evidenceJson explicitly.
const MIN_EVIDENCE_FOR_MOTIVO: Record<string, string> = {
  irrelevant: JSON.stringify({ usage_count: 0, sample_size: 20 }),
  conflict: JSON.stringify({ failures: 3 }),
  shift: JSON.stringify({ shift_score: 0.5 }),
  low_roi: JSON.stringify({ tokens_consumed: 100, load_bearing_count: 0, ratio: 0 }),
  quota: JSON.stringify({ slot_budget: 100, item_cost: 200 }),
  expired: JSON.stringify({ expires: '2024-01-01' }),
  user_purge: JSON.stringify({}),
  security: JSON.stringify({ trigger_source: 'hook' }),
};

const validInput = (
  overrides: Partial<AppendEvictionEventInput> = {},
): AppendEvictionEventInput => {
  const motivo = overrides.motivo ?? 'irrelevant';
  return {
    substrate: 'memory',
    objectId: 'test-memory-1',
    objectScope: 'project_local',
    fromState: 'proposed',
    toState: 'active',
    trigger: 'admission_gate',
    motivo,
    evidenceJson: MIN_EVIDENCE_FOR_MOTIVO[motivo] ?? '{}',
    outcome: 'applied',
    actor: 'user',
    sessionId,
    ...overrides,
  };
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

// ── isLegalTransition (pure validator) ─────────────────────────────

describe('isLegalTransition: state machine', () => {
  test('same-state pseudo-transition requires motivo legal for some transition out of `from`', () => {
    // trigger_fired_no_action / blocked_by_* outcomes use
    // from === to. Motivo MUST still be valid for some real
    // transition out of `from`, otherwise a row records a
    // semantically impossible (substrate, trigger) combo.
    // Motivos that ARE valid out of 'active': shift, conflict,
    // low_roi, security, user_purge.
    for (const motivo of ['conflict', 'low_roi', 'security', 'user_purge', 'shift'] as const) {
      const r = isLegalTransition('active', 'active', motivo);
      expect(r.ok).toBe(true);
    }
    // Motivos NOT valid out of 'active' get refused.
    for (const motivo of ['irrelevant', 'expired', 'quota'] as const) {
      const r = isLegalTransition('active', 'active', motivo);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('same-state');
        expect(r.reason).toContain('active');
      }
    }
  });

  test('same-state with "any"-motivo branch admits every motivo', () => {
    // 'proposed' has 'active': 'any', so same-state 'proposed →
    // proposed' should accept any motivo via the early-return
    // path in the validator's same-state branch.
    for (const motivo of ['irrelevant', 'quota', 'expired'] as const) {
      const r = isLegalTransition('proposed', 'proposed', motivo);
      expect(r.ok).toBe(true);
    }
  });

  test('proposed → active is unrestricted (admission gate)', () => {
    // Any motivo passes since LEGAL_TRANSITIONS marks it 'any'.
    for (const motivo of ['irrelevant', 'shift', 'user_purge'] as const) {
      expect(isLegalTransition('proposed', 'active', motivo).ok).toBe(true);
    }
  });

  test('proposed → evicted gated to irrelevant or low_roi', () => {
    expect(isLegalTransition('proposed', 'evicted', 'irrelevant').ok).toBe(true);
    expect(isLegalTransition('proposed', 'evicted', 'low_roi').ok).toBe(true);
    expect(isLegalTransition('proposed', 'evicted', 'shift').ok).toBe(false);
  });

  test('active → shadow restricted to shift', () => {
    expect(isLegalTransition('active', 'shadow', 'shift').ok).toBe(true);
    const r = isLegalTransition('active', 'shadow', 'conflict');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("'conflict'");
      expect(r.reason).toContain('shift');
    }
  });

  test('active → quarantined restricted to conflict or low_roi', () => {
    expect(isLegalTransition('active', 'quarantined', 'conflict').ok).toBe(true);
    expect(isLegalTransition('active', 'quarantined', 'low_roi').ok).toBe(true);
    expect(isLegalTransition('active', 'quarantined', 'shift').ok).toBe(false);
  });

  test('evicted → active is unrestricted (restore)', () => {
    expect(isLegalTransition('evicted', 'active', 'irrelevant').ok).toBe(true);
  });

  test('evicted → purged restricted to expired / user_purge / security', () => {
    expect(isLegalTransition('evicted', 'purged', 'expired').ok).toBe(true);
    expect(isLegalTransition('evicted', 'purged', 'user_purge').ok).toBe(true);
    expect(isLegalTransition('evicted', 'purged', 'security').ok).toBe(true);
    expect(isLegalTransition('evicted', 'purged', 'low_roi').ok).toBe(false);
  });

  test('purged is terminal — every outgoing transition rejected', () => {
    for (const to of ['proposed', 'active', 'evicted'] as const) {
      const r = isLegalTransition('purged', to, 'user_purge');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('illegal transition');
        expect(r.reason).toContain('purged');
      }
    }
  });

  test('illegal transition (active → proposed) rejected', () => {
    const r = isLegalTransition('active', 'proposed', 'user_purge');
    expect(r.ok).toBe(false);
  });

  test('* → purged with user_purge / security from non-evicted states', () => {
    // EVICTION §4.1 last row: * → purged with user_purge or
    // security, from anywhere (operator decided / security
    // forces irreversibility immediately).
    for (const from of ['active', 'shadow', 'quarantined', 'invalidated'] as const) {
      expect(isLegalTransition(from, 'purged', 'user_purge').ok).toBe(true);
      expect(isLegalTransition(from, 'purged', 'security').ok).toBe(true);
      // But NOT with low_roi / shift / etc. — those require the
      // evicted-then-purged path.
      expect(isLegalTransition(from, 'purged', 'low_roi').ok).toBe(false);
    }
  });
});

// ── appendEvictionEvent ────────────────────────────────────────────

describe('appendEvictionEvent: insert + defaults', () => {
  test('persists a basic transition row and returns it', () => {
    const e = appendEvictionEvent(db, validInput());
    expect(e.id).toBeString();
    expect(e.substrate).toBe('memory');
    expect(e.objectId).toBe('test-memory-1');
    expect(e.fromState).toBe('proposed');
    expect(e.toState).toBe('active');
    expect(e.outcome).toBe('applied');
    expect(e.recordedAt).toBeGreaterThan(0);
    expect(e.parentId).toBeNull();
    expect(e.blockedBy).toBeNull();
    expect(e.dependentsJson).toBeNull();
    expect(e.purgeAt).toBeNull(); // toState !== 'evicted'
    expect(countEvictionEvents(db)).toBe(1);
  });

  test('records purgeAt when toState=evicted', () => {
    const purgeAt = 5_000_000;
    const e = appendEvictionEvent(
      db,
      validInput({
        fromState: 'quarantined',
        toState: 'evicted',
        motivo: 'low_roi',
        outcome: 'applied',
        purgeAt,
      }),
    );
    expect(e.purgeAt).toBe(purgeAt);
  });

  test('throws InvalidEvictionInputError when purgeAt set on non-evicted toState', () => {
    // The column only carries meaning for to_state=evicted; a
    // non-null purgeAt anywhere else is a caller-shape bug, so
    // we surface it loud rather than silently coerce (post-1.2
    // review fix M2 — silent coerce was hiding writer bugs that
    // tests would still pass).
    expect(() => appendEvictionEvent(db, validInput({ purgeAt: 999_999 }))).toThrow(
      InvalidEvictionInputError,
    );
  });

  test('purgeAt: null is allowed for any toState (default shape)', () => {
    const e = appendEvictionEvent(db, validInput({ purgeAt: null }));
    expect(e.purgeAt).toBeNull();
  });

  test('round-trips parent_id (audit-chain reference)', () => {
    const root = appendEvictionEvent(db, validInput({ id: 'root-event' }));
    const child = appendEvictionEvent(
      db,
      validInput({
        id: 'child-event',
        fromState: 'active',
        toState: 'quarantined',
        motivo: 'conflict',
        parentId: root.id,
      }),
    );
    expect(child.parentId).toBe('root-event');
  });

  test('round-trips dependents_json (cascade-detection field)', () => {
    const deps = JSON.stringify(['mem-other-1', 'mem-other-2']);
    const e = appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'quarantined',
        motivo: 'conflict',
        dependentsJson: deps,
      }),
    );
    expect(e.dependentsJson).toBe(deps);
  });

  test('explicit id round-trips (replay path)', () => {
    const e = appendEvictionEvent(db, validInput({ id: 'fixed-eviction-id' }));
    expect(e.id).toBe('fixed-eviction-id');
    expect(getLastEvictionForObject(db, 'memory', 'test-memory-1', 'project_local')?.id).toBe(
      'fixed-eviction-id',
    );
  });

  test('throws IllegalTransitionError for illegal state move', () => {
    expect(() =>
      appendEvictionEvent(
        db,
        validInput({ fromState: 'active', toState: 'proposed', motivo: 'irrelevant' }),
      ),
    ).toThrow(IllegalTransitionError);
  });

  test('throws IllegalTransitionError for wrong motivo on legal pair', () => {
    expect(() =>
      appendEvictionEvent(
        db,
        validInput({ fromState: 'active', toState: 'shadow', motivo: 'conflict' }),
      ),
    ).toThrow(IllegalTransitionError);
  });

  test('IllegalTransitionError carries diagnostic fields', () => {
    try {
      appendEvictionEvent(
        db,
        validInput({ fromState: 'active', toState: 'proposed', motivo: 'irrelevant' }),
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      const e = err as IllegalTransitionError;
      expect(e.from).toBe('active');
      expect(e.to).toBe('proposed');
      expect(e.motivo).toBe('irrelevant');
      expect(e.message).toContain('illegal transition');
    }
  });

  test('same-state non-action outcome persists (trigger_fired_no_action)', () => {
    const e = appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'active',
        outcome: 'trigger_fired_no_action',
        motivo: 'low_roi',
        trigger: 'roi_below_threshold',
        evidenceJson: JSON.stringify({ trigger_source: 'roi_probe' }),
      }),
    );
    expect(e.outcome).toBe('trigger_fired_no_action');
    expect(e.fromState).toBe('active');
    expect(e.toState).toBe('active');
  });

  test('blocked_by_protection records blocked_by guard name', () => {
    const e = appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'active', // protection blocked the would-be transition
        outcome: 'blocked_by_protection',
        blockedBy: 'pinned',
        motivo: 'low_roi',
        trigger: 'compaction',
      }),
    );
    expect(e.outcome).toBe('blocked_by_protection');
    expect(e.blockedBy).toBe('pinned');
  });
});

// ── DB-level CHECK defense-in-depth ────────────────────────────────

describe('eviction_events: DB CHECK constraints', () => {
  // The TS layer validates first; these test that a raw INSERT
  // bypassing the repo still can't land a typo enum.
  const rawInsert = (overrides: Record<string, string | number | null>) => {
    const row = {
      id: 'raw-id',
      parent_id: null,
      substrate: 'memory',
      object_id: 'x',
      object_scope: 'session',
      from_state: 'proposed',
      to_state: 'active',
      trigger: 'admission',
      motivo: 'irrelevant',
      evidence_json: '{}',
      outcome: 'applied',
      blocked_by: null,
      actor: 'user',
      session_id: sessionId,
      dependents_json: null,
      recorded_at: Date.now(),
      purge_at: null,
      ...overrides,
    };
    const cols = Object.keys(row).join(', ');
    const placeholders = Object.keys(row)
      .map(() => '?')
      .join(', ');
    return db
      .query(`INSERT INTO eviction_events (${cols}) VALUES (${placeholders})`)
      .run(...(Object.values(row) as (string | number | null)[]));
  };

  test('rejects unknown substrate', () => {
    expect(() => rawInsert({ substrate: 'bogus' })).toThrow();
  });

  test('rejects unknown state on from_state or to_state', () => {
    expect(() => rawInsert({ from_state: 'banana' })).toThrow();
    expect(() => rawInsert({ to_state: 'banana' })).toThrow();
  });

  test('rejects unknown motivo', () => {
    expect(() => rawInsert({ motivo: 'because' })).toThrow();
  });

  test('rejects unknown outcome', () => {
    expect(() => rawInsert({ outcome: 'maybe' })).toThrow();
  });

  test('rejects unknown actor', () => {
    expect(() => rawInsert({ actor: 'cron' })).toThrow();
  });
});

// ── FK SET NULL on session purge ───────────────────────────────────

describe('eviction_events: FK semantics', () => {
  test('session purge preserves audit row with session_id NULL', () => {
    const e = appendEvictionEvent(db, validInput());
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    const after = getLastEvictionForObject(db, e.substrate, e.objectId, e.objectScope);
    expect(after).not.toBeNull();
    expect(after?.sessionId).toBeNull();
  });

  test('null sessionId allowed for cross-session events (startup probe)', () => {
    const e = appendEvictionEvent(db, validInput({ sessionId: null, actor: 'startup_probe' }));
    expect(e.sessionId).toBeNull();
  });
});

// ── queries ────────────────────────────────────────────────────────

describe('getLastEvictionForObject', () => {
  test('returns the most-recent event for (substrate, objectId, objectScope)', () => {
    appendEvictionEvent(db, validInput({ recordedAt: 100 }));
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'quarantined',
        motivo: 'conflict',
        recordedAt: 200,
      }),
    );
    const last = getLastEvictionForObject(db, 'memory', 'test-memory-1', 'project_local');
    expect(last?.toState).toBe('quarantined');
    expect(last?.recordedAt).toBe(200);
  });

  test('returns null for unknown object', () => {
    expect(getLastEvictionForObject(db, 'memory', 'never-existed', 'project_local')).toBeNull();
  });

  test('scopes to the requested substrate', () => {
    appendEvictionEvent(db, validInput({ substrate: 'memory' }));
    appendEvictionEvent(db, validInput({ substrate: 'policy', objectId: 'test-memory-1' }));
    const m = getLastEvictionForObject(db, 'memory', 'test-memory-1', 'project_local');
    const p = getLastEvictionForObject(db, 'policy', 'test-memory-1', 'project_local');
    expect(m?.substrate).toBe('memory');
    expect(p?.substrate).toBe('policy');
  });

  test('isolates by objectScope — same memory name in different scopes is independent', () => {
    // Defense in depth: even though no production caller relies on
    // getLastEvictionForObject for lifecycle decisions today, the
    // signature now requires scope so future call sites can't
    // accidentally inherit the old bug.
    appendEvictionEvent(
      db,
      validInput({
        objectId: 'rule-x',
        objectScope: 'project_local',
        recordedAt: 100,
      }),
    );
    appendEvictionEvent(
      db,
      validInput({
        objectId: 'rule-x',
        objectScope: 'user',
        recordedAt: 500,
      }),
    );
    const projLocal = getLastEvictionForObject(db, 'memory', 'rule-x', 'project_local');
    expect(projLocal?.recordedAt).toBe(100);
    expect(projLocal?.objectScope).toBe('project_local');
    const userScope = getLastEvictionForObject(db, 'memory', 'rule-x', 'user');
    expect(userScope?.recordedAt).toBe(500);
    expect(userScope?.objectScope).toBe('user');
  });
});

describe('getLastAppliedEvictionForObject', () => {
  test('returns the most-recent applied event for (substrate, objectId, objectScope)', () => {
    appendEvictionEvent(db, validInput({ recordedAt: 100 })); // applied
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'active', // same-state probe
        motivo: 'low_roi',
        outcome: 'trigger_fired_no_action',
        evidenceJson: JSON.stringify({ trigger_source: 'roi_probe' }),
        recordedAt: 200,
      }),
    );
    const last = getLastAppliedEvictionForObject(db, 'memory', 'test-memory-1', 'project_local');
    expect(last?.outcome).toBe('applied');
    expect(last?.recordedAt).toBe(100);
  });

  test('returns null when no applied event exists in the scope', () => {
    expect(getLastAppliedEvictionForObject(db, 'memory', 'never-existed', 'user')).toBeNull();
  });

  test('isolates by objectScope — same memory name in different scopes is independent', () => {
    // Same object_id 'user-role' exists in user-scope and project_local
    // as TWO independent memories. Without scope filtering, the lookup
    // would return whichever event landed latest globally and the GC
    // sweep would think the project_local tombstone is stale.
    appendEvictionEvent(
      db,
      validInput({
        objectId: 'user-role',
        objectScope: 'project_local',
        recordedAt: 100,
      }),
    );
    appendEvictionEvent(
      db,
      validInput({
        objectId: 'user-role',
        objectScope: 'user',
        recordedAt: 500, // newer applied event in the OTHER scope
      }),
    );
    const projLocal = getLastAppliedEvictionForObject(db, 'memory', 'user-role', 'project_local');
    expect(projLocal?.recordedAt).toBe(100);
    expect(projLocal?.objectScope).toBe('project_local');
    const userScope = getLastAppliedEvictionForObject(db, 'memory', 'user-role', 'user');
    expect(userScope?.recordedAt).toBe(500);
    expect(userScope?.objectScope).toBe('user');
  });

  test('scopes to the requested substrate', () => {
    appendEvictionEvent(db, validInput({ substrate: 'memory' }));
    appendEvictionEvent(db, validInput({ substrate: 'policy', objectId: 'test-memory-1' }));
    const m = getLastAppliedEvictionForObject(db, 'memory', 'test-memory-1', 'project_local');
    const p = getLastAppliedEvictionForObject(db, 'policy', 'test-memory-1', 'project_local');
    expect(m?.substrate).toBe('memory');
    expect(p?.substrate).toBe('policy');
  });
});

describe('getLastQuarantineEvent', () => {
  test('returns the most-recent applied quarantine transition', () => {
    appendEvictionEvent(db, validInput({ recordedAt: 100 })); // active (admission)
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'quarantined',
        motivo: 'conflict',
        recordedAt: 200,
      }),
    );
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'active', // probe — not a quarantine
        motivo: 'conflict',
        outcome: 'trigger_fired_no_action',
        evidenceJson: JSON.stringify({ trigger_source: 'verify_probe' }),
        recordedAt: 300,
      }),
    );
    const q = getLastQuarantineEvent(db, 'memory', 'test-memory-1', 'project_local');
    expect(q?.toState).toBe('quarantined');
    expect(q?.recordedAt).toBe(200);
  });

  test('returns null when no applied quarantine exists in the scope', () => {
    appendEvictionEvent(db, validInput()); // applied to active, not quarantined
    expect(getLastQuarantineEvent(db, 'memory', 'test-memory-1', 'project_local')).toBeNull();
  });

  test('isolates by objectScope — quarantine in another scope does NOT leak', () => {
    // user-scope quarantine of 'auth-rule' should not gate a
    // project_local 'auth-rule' transition. Without scope filtering,
    // the TTL gate in transitionMemoryState would read the wrong
    // quarantine timestamp and block a legitimate eviction.
    appendEvictionEvent(
      db,
      validInput({
        objectId: 'auth-rule',
        objectScope: 'user',
        fromState: 'active',
        toState: 'quarantined',
        motivo: 'conflict',
        recordedAt: 200,
      }),
    );
    const projLocal = getLastQuarantineEvent(db, 'memory', 'auth-rule', 'project_local');
    expect(projLocal).toBeNull();
    const userScope = getLastQuarantineEvent(db, 'memory', 'auth-rule', 'user');
    expect(userScope?.recordedAt).toBe(200);
  });

  test('ignores blocked_by_protection and trigger_fired_no_action rows', () => {
    // Strictness check: only `applied` rows start a dwell period.
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'quarantined',
        motivo: 'conflict',
        outcome: 'blocked_by_protection',
        blockedBy: 'user_explicit_cooldown',
        recordedAt: 100,
      }),
    );
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'active',
        motivo: 'conflict',
        outcome: 'trigger_fired_no_action',
        evidenceJson: JSON.stringify({ trigger_source: 'verify_probe' }),
        recordedAt: 200,
      }),
    );
    expect(getLastQuarantineEvent(db, 'memory', 'test-memory-1', 'project_local')).toBeNull();
  });
});

describe('listEvictableInWindow / listEvictedDueForPurge', () => {
  test('lists evicted rows with purge_at in the future', () => {
    const now = 1_000_000;
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'quarantined',
        toState: 'evicted',
        motivo: 'low_roi',
        purgeAt: now + 30 * 86_400_000,
      }),
    );
    expect(listEvictableInWindow(db, now)).toHaveLength(1);
    expect(listEvictedDueForPurge(db, now)).toHaveLength(0);
  });

  test('moves to due-for-purge when window expires', () => {
    const now = 1_000_000;
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'quarantined',
        toState: 'evicted',
        motivo: 'low_roi',
        purgeAt: now - 1,
      }),
    );
    expect(listEvictableInWindow(db, now)).toHaveLength(0);
    expect(listEvictedDueForPurge(db, now)).toHaveLength(1);
  });

  test('ignores non-evicted rows', () => {
    const now = 1_000_000;
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'active',
        toState: 'quarantined',
        motivo: 'conflict',
      }),
    );
    expect(listEvictableInWindow(db, now)).toHaveLength(0);
    expect(listEvictedDueForPurge(db, now)).toHaveLength(0);
  });

  test('purge_at === now boundary lands in due-for-purge (predicate is <=)', () => {
    // The listEvictedDueForPurge predicate is `purge_at <= ?`
    // so a row whose retention window ends exactly at the
    // probe instant should be eligible for GC. Pinning the
    // boundary stops a future refactor that flips to strict <
    // from silently leaving rows in evictable forever.
    const now = 1_000_000;
    appendEvictionEvent(
      db,
      validInput({
        fromState: 'quarantined',
        toState: 'evicted',
        motivo: 'low_roi',
        purgeAt: now,
      }),
    );
    expect(listEvictableInWindow(db, now)).toHaveLength(0);
    expect(listEvictedDueForPurge(db, now)).toHaveLength(1);
  });
});

describe('appendEvictionEvent: evidence_json redaction (AUDIT.md §1 sensitivity=medium)', () => {
  test('scrubs secret patterns inside the evidence payload', () => {
    // Caller forwards an evidence payload that happens to carry a
    // credential-shaped string (the trigger source dumped a log
    // line). Repo must apply telemetry-grade redaction before
    // INSERT so the row doesn't keep the secret for 365d.
    // Use motivo='user_purge' (admits any shape) so the test
    // focuses on redaction, not §6.1 schema validation.
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'user_purge',
        evidenceJson: JSON.stringify({
          detail: 'log: sk-ant-aaaaaaaaaaaaaaaaaaaa expired',
        }),
      }),
    );
    expect(e.evidenceJson).not.toContain('sk-ant-aaaaaaaaaaaaaaaaaaaa');
  });

  test('scrubs strings nested in arrays + sub-objects', () => {
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'user_purge',
        evidenceJson: JSON.stringify({
          paths: ['/home/operator/secrets/key.pem'],
          inner: { ref: '/Users/operator/.aws/credentials' },
        }),
      }),
    );
    // Paths with /home/<user>/ or /Users/<user>/ are operator-PII
    // per the telemetry scrub vocabulary; both should be
    // collapsed. We don't assert the exact replacement shape
    // because the canonical scrub rules live in
    // telemetry/scrubbing.ts; we assert only that the original
    // value did not survive.
    expect(e.evidenceJson).not.toContain('/home/operator');
    expect(e.evidenceJson).not.toContain('/Users/operator');
  });

  test('malformed JSON is preserved as scrubbed marker', () => {
    // A future writer might pass raw text by mistake. The repo
    // shouldn't reject (the transition is still legitimate); it
    // should replace the payload with a marker so the audit row
    // still persists and the un-parseable content is recorded.
    // The validator skips schema validation when JSON.parse
    // fails — malformed payload is the scrub layer's concern.
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'user_purge',
        evidenceJson: 'not-actually-json sk-ant-secretsecretsecretsecret',
      }),
    );
    expect(e.evidenceJson).toContain('_scrubbed_invalid_json');
    expect(e.evidenceJson).not.toContain('sk-ant-secretsecretsecretsecret');
  });
});

describe('appendEvictionEvent: evidence_json schema validation (EVICTION §6.1)', () => {
  test('rejects evidence missing required fields for low_roi', () => {
    expect(() =>
      appendEvictionEvent(
        db,
        validInput({
          motivo: 'low_roi',
          fromState: 'quarantined',
          toState: 'evicted',
          evidenceJson: '{}',
        }),
      ),
    ).toThrow(/evidence shape doesn't satisfy schema for motivo 'low_roi'/);
  });

  test('rejects evidence with wrong field types for shift', () => {
    expect(() =>
      appendEvictionEvent(
        db,
        validInput({
          motivo: 'shift',
          fromState: 'active',
          toState: 'invalidated',
          evidenceJson: JSON.stringify({ shift_score: 'not-a-number' }),
        }),
      ),
    ).toThrow(/evidence shape doesn't satisfy schema for motivo 'shift'/);
  });

  test('accepts conflict with the failure-burst shape', () => {
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'conflict',
        fromState: 'active',
        toState: 'quarantined',
        evidenceJson: JSON.stringify({ failures: 3 }),
      }),
    );
    expect(e.motivo).toBe('conflict');
  });

  test('accepts conflict with the pair-detected shape', () => {
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'conflict',
        fromState: 'active',
        toState: 'quarantined',
        evidenceJson: JSON.stringify({
          winner_id: 'mem-1',
          loser_id: 'mem-2',
          conflict_kind: 'contradiction',
        }),
      }),
    );
    expect(e.motivo).toBe('conflict');
  });

  test('operator-driven marker bypasses required-field check', () => {
    // /memory delete + gcExpiredMemories use closest-fit motivos
    // with this marker — the operator command IS the evidence;
    // the structural fields would be degenerate noise.
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'low_roi',
        fromState: 'quarantined',
        toState: 'evicted',
        evidenceJson: JSON.stringify({ _operator_driven: true, source: 'slash_delete' }),
      }),
    );
    expect(e.motivo).toBe('low_roi');
  });

  test('non-object evidence (string, number, null, array) refused', () => {
    for (const bad of ['"string-value"', '42', 'null', '[1, 2]']) {
      expect(() =>
        appendEvictionEvent(
          db,
          validInput({
            motivo: 'irrelevant',
            evidenceJson: bad,
          }),
        ),
      ).toThrow(/evidence shape doesn't satisfy/);
    }
  });

  test('shape validation skipped for non-applied outcomes (but marker still required)', () => {
    // blocked_by_hook / blocked_by_protection / trigger_fired_no_action
    // record an attempted gate, not the substrate's evidence —
    // motivo-canonical structural fields don't apply. They MUST
    // carry a structural marker (`trigger_source` or
    // `_operator_driven`) so forensics can identify the source.
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'low_roi',
        fromState: 'active',
        toState: 'active', // same-state pseudo
        outcome: 'trigger_fired_no_action',
        evidenceJson: JSON.stringify({ trigger_source: 'roi_probe' }),
      }),
    );
    expect(e.outcome).toBe('trigger_fired_no_action');
  });

  test('trigger_fired_no_action without marker is refused', () => {
    // The marker gate refuses an empty evidence payload — without
    // `trigger_source` or `_operator_driven`, the audit row would
    // land semantic garbage.
    expect(() =>
      appendEvictionEvent(
        db,
        validInput({
          motivo: 'low_roi',
          fromState: 'active',
          toState: 'active',
          outcome: 'trigger_fired_no_action',
          evidenceJson: '{}',
        }),
      ),
    ).toThrow(/trigger_source.*_operator_driven/);
  });

  test('trigger_fired_no_action with _operator_driven marker passes', () => {
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'low_roi',
        fromState: 'active',
        toState: 'active',
        outcome: 'trigger_fired_no_action',
        evidenceJson: JSON.stringify({ _operator_driven: true }),
      }),
    );
    expect(e.outcome).toBe('trigger_fired_no_action');
  });

  test('blocked_by_protection without blocked_by column is refused', () => {
    expect(() =>
      appendEvictionEvent(
        db,
        validInput({
          motivo: 'low_roi',
          fromState: 'active',
          toState: 'active',
          outcome: 'blocked_by_protection',
          evidenceJson: '{}',
          // blockedBy: deliberately omitted
        }),
      ),
    ).toThrow(/blocked_by/);
  });

  test('blocked_by_hook with non-empty blocked_by column passes', () => {
    const e = appendEvictionEvent(
      db,
      validInput({
        motivo: 'low_roi',
        fromState: 'active',
        toState: 'active',
        outcome: 'blocked_by_hook',
        evidenceJson: '{}',
        blockedBy: 'project:hooks/foo.yaml#0',
      }),
    );
    expect(e.outcome).toBe('blocked_by_hook');
    expect(e.blockedBy).toBe('project:hooks/foo.yaml#0');
  });
});

describe('detectTriggerThrashing', () => {
  // Shared evidence payload — non-applied marker gate requires
  // `trigger_source` for trigger_fired_no_action rows.
  const probeEvidence = JSON.stringify({ trigger_source: 'roi_probe' });

  test('returns rows where outcome=trigger_fired_no_action repeats', () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      appendEvictionEvent(
        db,
        validInput({
          fromState: 'active',
          toState: 'active', // no state change
          outcome: 'trigger_fired_no_action',
          trigger: 'roi_below_threshold',
          motivo: 'low_roi',
          evidenceJson: probeEvidence,
          recordedAt: now + i,
        }),
      );
    }
    const thrashing = detectTriggerThrashing(db, 0);
    expect(thrashing).toHaveLength(1);
    expect(thrashing[0]?.trigger).toBe('roi_below_threshold');
    expect(thrashing[0]?.count).toBe(5);
  });

  test('respects minCount threshold', () => {
    // Fixtures use recordedAt > 0 because the sinceMs filter is
    // strict (`recorded_at > ?`): with sinceMs=0, a row at
    // recordedAt=0 would be excluded. Bumping by *100 keeps the
    // test obvious-at-a-glance instead of relying on the implicit
    // boundary semantics.
    for (let i = 1; i <= 3; i++) {
      appendEvictionEvent(
        db,
        validInput({
          fromState: 'active',
          toState: 'active',
          outcome: 'trigger_fired_no_action',
          trigger: 'roi_below_threshold',
          motivo: 'low_roi',
          evidenceJson: probeEvidence,
          recordedAt: i * 100,
        }),
      );
    }
    expect(detectTriggerThrashing(db, 0, 5)).toHaveLength(0);
    expect(detectTriggerThrashing(db, 0, 3)).toHaveLength(1);
  });

  test('ignores applied outcomes (real action fired)', () => {
    appendEvictionEvent(db, validInput());
    expect(detectTriggerThrashing(db, 0, 1)).toHaveLength(0);
  });

  test('respects sinceMs window', () => {
    for (let i = 0; i < 5; i++) {
      appendEvictionEvent(
        db,
        validInput({
          fromState: 'active',
          toState: 'active',
          outcome: 'trigger_fired_no_action',
          trigger: 'roi_below_threshold',
          motivo: 'low_roi',
          evidenceJson: probeEvidence,
          recordedAt: i * 100,
        }),
      );
    }
    // sinceMs = 250 includes only recordedAt ∈ {300, 400} ⇒ 2 hits.
    expect(detectTriggerThrashing(db, 250, 1)[0]?.count).toBe(2);
  });
});
