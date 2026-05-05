import type { HookSpec } from '../../hooks/types.ts';
import type { Policy } from '../../permissions/index.ts';
import type { DB } from '../db.ts';

export type SubagentScope = 'user' | 'project';

export interface SubagentRun {
  sessionId: string;
  name: string;
  scope: SubagentScope;
  sourcePath: string;
  sourceSha256: string;
  systemPrompt: string;
  // Parsed JSON array. Stored as TEXT in SQLite per the schema in
  // migration 012; the repo handles serialization on insert and
  // parsing on read.
  toolsWhitelist: string[];
  budgetMaxSteps: number;
  budgetMaxCostUsd: number;
  // Mirrors the optional field in SubagentBudget. Null when the
  // definition didn't declare a wall-clock cap.
  budgetMaxWallMs: number | null;
  // Snapshot of the parent's resolved Policy at spawn time
  // (migration 015). The subprocess child reads this and builds
  // its permission engine from it directly — never re-resolves
  // the policy yaml from disk. Closes the drift window where
  // a human edit between parent spawn and child startup could
  // have run the child under different rules than the parent
  // validated. Null only on rows from BEFORE migration 015 (the
  // ALTER TABLE seeded `'{}'` for those, which parses to an
  // empty Policy → strict-mode defaults: maximally safe
  // interpretation of "unknown policy").
  policySnapshot: Policy;
  // Snapshot of the parent's resolved hook chain at spawn time
  // (migration 020). The subprocess child reads this and uses it
  // INSTEAD of re-resolving `hooks.toml` from disk. Closes the
  // drift window where a human edit between parent spawn and
  // child startup could have run the child under a different
  // hook chain than the parent had locked in. Empty array on
  // pre-migration rows (the ALTER TABLE seeded `'[]'`) — child
  // falls through to disk re-resolve on that path, preserving
  // the legacy behavior.
  hooksSnapshot: readonly HookSpec[];
  capturedAt: number;
}

interface SubagentRunRow {
  session_id: string;
  name: string;
  scope: SubagentScope;
  source_path: string;
  source_sha256: string;
  system_prompt: string;
  tools_whitelist: string;
  budget_max_steps: number;
  budget_max_cost_usd: number;
  budget_max_wall_ms: number | null;
  policy_snapshot: string;
  hooks_snapshot: string;
  captured_at: number;
}

const fromRow = (row: SubagentRunRow): SubagentRun => {
  // Defensive parse on tools_whitelist. Storage corruption is
  // unlikely (the column is INSERT-once and TEXT is opaque to
  // SQLite), but a malformed JSON would crash audit queries
  // mid-listing — surface as an empty array with a deterministic
  // shape instead. Audit consumers who want to detect corruption
  // can compare with the parsed value's length against the
  // definition's tool count.
  let tools: string[];
  try {
    const parsed = JSON.parse(row.tools_whitelist) as unknown;
    tools = Array.isArray(parsed) && parsed.every((e) => typeof e === 'string') ? parsed : [];
  } catch {
    tools = [];
  }
  // Defensive parse on policy_snapshot. A corrupted or
  // structurally-incomplete snapshot must NOT crash audit
  // listings or — worse — let the child run under unrestricted
  // permissions. The pre-migration `'{}'` default parses as
  // an empty object that LACKS `defaults.mode` and `tools`,
  // which would crash the engine on first check; we fill those
  // missing required fields with strict-mode defaults.
  // "Strict" is the safest interpretation of "snapshot
  // structurally incomplete": deny everything by default.
  let policySnapshot: Policy;
  try {
    const parsed = JSON.parse(row.policy_snapshot) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const defaults =
        obj.defaults !== undefined &&
        obj.defaults !== null &&
        typeof obj.defaults === 'object' &&
        !Array.isArray(obj.defaults)
          ? (obj.defaults as Policy['defaults'])
          : { mode: 'strict' as const };
      const tools =
        obj.tools !== undefined &&
        obj.tools !== null &&
        typeof obj.tools === 'object' &&
        !Array.isArray(obj.tools)
          ? (obj.tools as Policy['tools'])
          : {};
      policySnapshot = { ...obj, defaults, tools } as Policy;
    } else {
      policySnapshot = { defaults: { mode: 'strict' }, tools: {} };
    }
  } catch {
    policySnapshot = { defaults: { mode: 'strict' }, tools: {} };
  }
  // Defensive parse on hooks_snapshot. Same shape as
  // tools_whitelist: TEXT column, JSON-array, fall back to []
  // on parse failure or wrong shape. Empty array means "no
  // snapshot" — caller falls through to disk re-resolve. We do
  // NOT validate inner HookSpec field shapes here; the
  // dispatcher tolerates field-level absences (clamps timeouts,
  // etc.) and a corrupt entry would surface there with the
  // same diagnostic path as a corrupt hooks.toml.
  let hooksSnapshot: HookSpec[];
  try {
    const parsed = JSON.parse(row.hooks_snapshot) as unknown;
    hooksSnapshot =
      Array.isArray(parsed) && parsed.every((e) => e !== null && typeof e === 'object')
        ? (parsed as HookSpec[])
        : [];
  } catch {
    hooksSnapshot = [];
  }
  return {
    sessionId: row.session_id,
    name: row.name,
    scope: row.scope,
    sourcePath: row.source_path,
    sourceSha256: row.source_sha256,
    systemPrompt: row.system_prompt,
    toolsWhitelist: tools,
    budgetMaxSteps: row.budget_max_steps,
    budgetMaxCostUsd: row.budget_max_cost_usd,
    budgetMaxWallMs: row.budget_max_wall_ms,
    policySnapshot,
    hooksSnapshot,
    capturedAt: row.captured_at,
  };
};

export interface InsertSubagentRunInput {
  sessionId: string;
  name: string;
  scope: SubagentScope;
  sourcePath: string;
  sourceSha256: string;
  systemPrompt: string;
  toolsWhitelist: string[];
  budgetMaxSteps: number;
  budgetMaxCostUsd: number;
  budgetMaxWallMs?: number;
  // Optional only for backwards compatibility with older test
  // fixtures and the rare programmatic caller. Production
  // callers (the subagent runtime) MUST supply the parent's
  // resolved Policy so the child runs under sealed rules.
  // Omitting it persists `'{}'` which the read path falls back
  // to strict-mode defaults — safe but maximally restrictive.
  policySnapshot?: Policy;
  // Parent's resolved hook chain at spawn time. Production
  // callers (subagent runtime) supply it; programmatic callers
  // omitting it land an empty array, which the child treats as
  // "no snapshot, re-resolve from disk" — preserving legacy
  // behavior for fixtures that don't model the snapshot.
  hooksSnapshot?: readonly HookSpec[];
  capturedAt?: number;
}

export const insertSubagentRun = (db: DB, input: InsertSubagentRunInput): SubagentRun => {
  const capturedAt = input.capturedAt ?? Date.now();
  const wallMs = input.budgetMaxWallMs ?? null;
  // Serialize the whitelist + policy as JSON. Same convention the
  // messages table uses for its `content` column — keep the
  // schema dumb, parse on read.
  const toolsJson = JSON.stringify(input.toolsWhitelist);
  const policyJson = JSON.stringify(input.policySnapshot ?? {});
  const hooksJson = JSON.stringify(input.hooksSnapshot ?? []);
  db.query(
    `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt,
        tools_whitelist, budget_max_steps, budget_max_cost_usd,
        budget_max_wall_ms, policy_snapshot, hooks_snapshot, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.name,
    input.scope,
    input.sourcePath,
    input.sourceSha256,
    input.systemPrompt,
    toolsJson,
    input.budgetMaxSteps,
    input.budgetMaxCostUsd,
    wallMs,
    policyJson,
    hooksJson,
    capturedAt,
  );
  // Resolve the snapshot for the return value with the same
  // strict fallback the read path uses, so callers get a
  // consistent shape regardless of whether they supplied it.
  const policySnapshot: Policy = input.policySnapshot ?? {
    defaults: { mode: 'strict' },
    tools: {},
  };
  return {
    sessionId: input.sessionId,
    name: input.name,
    scope: input.scope,
    sourcePath: input.sourcePath,
    sourceSha256: input.sourceSha256,
    systemPrompt: input.systemPrompt,
    toolsWhitelist: input.toolsWhitelist,
    budgetMaxSteps: input.budgetMaxSteps,
    budgetMaxCostUsd: input.budgetMaxCostUsd,
    budgetMaxWallMs: wallMs,
    policySnapshot,
    hooksSnapshot: input.hooksSnapshot ?? [],
    capturedAt,
  };
};

// Returns null when no subagent_runs row exists for `sessionId`.
// Two distinct cases produce null and the caller must treat them
// the same way: (a) the session was never a subagent (no row was
// ever inserted), or (b) the session IS a subagent but its
// snapshot insert failed at runtime (see RunSubagentResult.
// auditFailure for the in-memory signal). The CLI listing surface
// uses sessions.is_subagent to disambiguate (a) from (b); audit
// queries that need to detect "missing snapshot" should always
// pair this lookup with the session row's `isSubagent` flag.
export const getSubagentRun = (db: DB, sessionId: string): SubagentRun | null => {
  const row = db
    .query<SubagentRunRow, [string]>(
      `SELECT session_id, name, scope, source_path, source_sha256, system_prompt,
              tools_whitelist, budget_max_steps, budget_max_cost_usd,
              budget_max_wall_ms, policy_snapshot, hooks_snapshot, captured_at
         FROM subagent_runs
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return row !== null ? fromRow(row) : null;
};
