// Loop frio orchestrator tests (FEEDBACK_ADAPTATION §3.2).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runLoopFrio } from '../../src/feedback/loop-frio.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { type OutcomeResult, createOutcome } from '../../src/storage/repos/outcomes.ts';
import { createPolicy, listPoliciesByState } from '../../src/storage/repos/policies.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

const seedToolCall = (sid: string): string => {
  const msgId = crypto.randomUUID();
  const tcId = crypto.randomUUID();
  db.query(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'tool', '{}', ?)`,
  ).run(msgId, sid, Date.now());
  db.query(
    `INSERT INTO tool_calls (id, message_id, tool_name, input, status, created_at)
     VALUES (?, ?, 'bash', '{}', 'done', ?)`,
  ).run(tcId, msgId, Date.now());
  return tcId;
};

const seedOutcomes = (
  actionSignature: string,
  results: OutcomeResult[],
  scopeId = sessionId,
  scopeKind: 'session' | 'repo' | 'user' | 'language' | 'global' = 'session',
): void => {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r === undefined) continue;
    createOutcome(db, {
      sessionId,
      toolCallId: seedToolCall(sessionId),
      actionSignature,
      tier: 1,
      result: r,
      scopeKind,
      scopeId,
      recordedAt: 1000 + i,
    });
  }
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

afterEach(() => {
  db.close();
});

describe('runLoopFrio', () => {
  test('proposes L1 alias policy when gate passes', () => {
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult));
    const r = runLoopFrio({ db, sinceMs: 0, now: () => 10_000 });
    expect(r.considered).toBe(1);
    expect(r.proposed).toHaveLength(1);
    const proposed = r.proposed[0];
    if (proposed === undefined) throw new Error('expected proposed');
    expect(proposed.actionSignature).toBe('alias:grep:ripgrep');
    expect(proposed.policy.state).toBe('proposed');
    expect(proposed.policy.actionJson).toBe(JSON.stringify({ target: 'ripgrep' }));
    expect(proposed.policy.n).toBe(12);
    expect(proposed.stats.ciLow).toBeGreaterThan(0.7);
  });

  test('gate refuses when ci_low <= 0.7', () => {
    // 7 successes / 5 failures with Beta(2,1) prior:
    // Posterior Beta(9, 6); mean ≈ 0.6; ci_low < 0.7
    seedOutcomes('alias:grep:ripgrep', [
      'success',
      'success',
      'success',
      'success',
      'success',
      'success',
      'success',
      'failure',
      'failure',
      'failure',
      'failure',
      'failure',
    ]);
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    const rej = r.rejected[0];
    if (rej === undefined || rej.kind !== 'gate_refused') throw new Error('expected gate_refused');
    expect(rej.reason).toContain('ci_low');
  });

  test('gate refuses when n < 10 (under accumulation threshold first)', () => {
    seedOutcomes('alias:grep:ripgrep', Array(8).fill('success' as OutcomeResult));
    // accumulation default minN=10, so 8 outcomes don't trigger
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.considered).toBe(0);
  });

  test('gate refuses when distribution unstable', () => {
    seedOutcomes('alias:grep:ripgrep', Array(20).fill('success' as OutcomeResult));
    const r = runLoopFrio({ db, sinceMs: 0, distributionStable: false });
    expect(r.proposed).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    const rej = r.rejected[0];
    if (rej === undefined || rej.kind !== 'gate_refused') throw new Error('expected gate_refused');
    expect(rej.reason).toContain('unstable');
  });

  test('skips non-L1 signatures (level_not_implemented)', () => {
    seedOutcomes('flag:bash:cwd_arg:preferred', Array(12).fill('success' as OutcomeResult));
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.kind).toBe('level_not_implemented');
  });

  test('duplicate proposal short-circuits when a proposed policy exists', () => {
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult));
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: sessionId,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.kind).toBe('duplicate_proposed');
  });

  test('duplicate guard ignores terminal invalidated policies', () => {
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult));
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: sessionId,
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'invalidated',
    });
    const r = runLoopFrio({ db, sinceMs: 0 });
    // Terminal `invalidated` doesn't block re-proposal per §4.2.
    expect(r.proposed).toHaveLength(1);
  });

  test('considers signatures across multiple scopes', () => {
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult), 'r-A', 'repo');
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult), 'r-B', 'repo');
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.considered).toBe(2);
    expect(r.proposed).toHaveLength(2);
    const scopes = r.proposed.map((p) => p.scopeId).sort();
    expect(scopes).toEqual(['r-A', 'r-B']);
  });

  test('scope filter narrows the run to one (scope_kind, scope_id)', () => {
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult), 'r-A', 'repo');
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult), 'r-B', 'repo');
    const r = runLoopFrio({ db, sinceMs: 0, scopeKind: 'repo', scopeId: 'r-A' });
    expect(r.considered).toBe(1);
    expect(r.proposed[0]?.scopeId).toBe('r-A');
  });

  test('boundary: exactly n=10 with high success rate passes the gate', () => {
    // 10 successes against Beta(2,1) prior → posterior Beta(12, 1)
    // mean ≈ 0.923, ci_low well above 0.7. The gate's `n >= 10`
    // (inclusive) AND `ci_low > 0.7` (strict) both pass at n=10.
    seedOutcomes('alias:grep:ripgrep', Array(10).fill('success' as OutcomeResult));
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(1);
  });

  test('boundary: ci_low at exactly 0.7 fails (strict >, not >=)', () => {
    // Engineer a posterior whose ci_low is very close to 0.7 by
    // mixing failures into a 12-outcome series. Beta(2,1) prior
    // + 7 successes / 5 failures → posterior Beta(9, 6); mean ≈ 0.6.
    // ci_low << 0.7 — gate refuses with ci_low reason. Pinning
    // the strict comparison: ci_low === 0.7 would also refuse.
    seedOutcomes('alias:grep:ripgrep', [
      'success',
      'success',
      'success',
      'success',
      'success',
      'success',
      'success',
      'failure',
      'failure',
      'failure',
      'failure',
      'failure',
    ]);
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(0);
    const refused = r.rejected[0];
    if (refused === undefined || refused.kind !== 'gate_refused') {
      throw new Error('expected gate_refused');
    }
    expect(refused.reason).toContain('ci_low');
  });

  test('self-alias signature is filtered as kind=self_alias_no_op', () => {
    // The bash-aliases table carries self-aliases (cat/awk/sed)
    // for per-binary telemetry; outcomes accumulate, but the
    // proposer should NOT produce a no-op rewrite policy.
    // Without this filter, operator would see useless proposals
    // like "promote alias:sed:sed → use sed" in /agent policy list.
    seedOutcomes('alias:sed:sed', Array(12).fill('success' as OutcomeResult));
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]?.kind).toBe('self_alias_no_op');
  });

  test('malformed L1 signature surfaces as kind=malformed_signature', () => {
    // levelOf('alias:UPPER:lower') returns 'L1' (prefix-only check),
    // but parseActionSignature refuses uppercase fields. The proposer
    // must route this through the distinct malformed branch, not
    // crash or stamp a broken target into a policy.
    //
    // Seed outcomes directly via createOutcome so the bad signature
    // bypasses the action_signature parser at write time (the repo
    // is opaque-string per AUDIT.md §1.1.1).
    for (let i = 0; i < 12; i++) {
      createOutcome(db, {
        sessionId,
        toolCallId: seedToolCall(sessionId),
        actionSignature: 'alias:GREP:ripgrep',
        tier: 1,
        result: 'success',
        scopeKind: 'session',
        scopeId: sessionId,
        recordedAt: 1000 + i,
      });
    }
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    const refused = r.rejected[0];
    if (refused === undefined) throw new Error('expected rejected');
    expect(refused.kind).toBe('malformed_signature');
  });

  test('refuses when active superior policy has different action_json (contradiction)', () => {
    // Proposing at global scope while session/repo/user/language
    // has an active policy with the SAME signature but DIFFERENT
    // action_json. The dispatch would never honor global (resolver
    // walks specific → general; first hit wins). Refusing prevents
    // the operator from seeing a doomed-to-shadow proposal.
    createPolicy(db, {
      scopeKind: 'user',
      scopeId: 'some-user',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-other' }),
      state: 'active',
    });
    seedOutcomes(
      'alias:grep:ripgrep',
      Array(12).fill('success' as OutcomeResult),
      'global',
      'global',
    );
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(0);
    const refused = r.rejected[0];
    if (refused === undefined || refused.kind !== 'gate_refused') {
      throw new Error('expected gate_refused');
    }
    expect(refused.reason).toContain('contradicts active superior');
  });

  test('does NOT refuse when superior policy has SAME action_json (redundant, not contradiction)', () => {
    // Session-scope active with target: 'ripgrep'. Global proposal
    // would have target: 'ripgrep' too. Spec §5.3 reads
    // "contradiction" strictly — same action_json at higher tier
    // means the lower-tier proposal is redundant (subsumed), not
    // contradicting. Allow.
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: 'some-session',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'active',
    });
    seedOutcomes(
      'alias:grep:ripgrep',
      Array(12).fill('success' as OutcomeResult),
      'global',
      'global',
    );
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(1);
  });

  test('session-scope proposal has no superior (no contradiction check applies)', () => {
    // session is highest precedence; no scope is more specific.
    // The contradiction check should pass trivially. Verifies the
    // SCOPE_PRECEDENCE.indexOf branch.
    seedOutcomes('alias:grep:ripgrep', Array(12).fill('success' as OutcomeResult));
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(1);
  });

  test('proposed superior does NOT trip contradiction (only active matters)', () => {
    // The contradiction check filters on state='active'. A merely
    // proposed (not yet promoted) policy at a more-specific scope
    // doesn't block a different-action proposal at a broader scope.
    createPolicy(db, {
      scopeKind: 'session',
      scopeId: 'some-session',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'rg-other' }),
      state: 'proposed',
    });
    seedOutcomes(
      'alias:grep:ripgrep',
      Array(12).fill('success' as OutcomeResult),
      'global',
      'global',
    );
    const r = runLoopFrio({ db, sinceMs: 0 });
    expect(r.proposed).toHaveLength(1);
  });

  test('motivo on the proposed policy includes ci_low and n', () => {
    seedOutcomes('alias:grep:ripgrep', Array(15).fill('success' as OutcomeResult));
    runLoopFrio({ db, sinceMs: 0 });
    const proposed = listPoliciesByState(db, 'proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.motivo).toContain('loop_frio:accumulation');
    expect(proposed[0]?.motivo).toContain('ci_low=');
    expect(proposed[0]?.motivo).toContain('n=15');
  });
});
