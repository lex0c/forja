import type { HookSpec } from '../../hooks/types.ts';
import type { Policy } from '../../permissions/index.ts';
import type { ContextRecipe, SamplingOverride, ToolRestrictions } from '../../subagents/types.ts';
import type { DB } from '../db.ts';

// Mirrors src/subagents/types.ts SubagentScope. Widened in migration
// 058 to include 'builtin' so the audit row records true provenance
// (was mapped to 'user' pre-058 via a runtime hack).
export type SubagentScope = 'user' | 'project' | 'builtin';

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
  // hook chain than the parent had locked in.
  //
  // Discriminator:
  //   - `null` — no snapshot was taken at spawn (legacy pre-
  //     migration row, or a programmatic caller that didn't
  //     supply a chain). Child falls through to disk re-resolve;
  //     spec §10 unbypassable-corp-policy still binds via the
  //     filesystem.
  //   - `[]` — parent resolved its chain and got zero hooks;
  //     authoritatively no hooks. Child runs WITHOUT hooks. This
  //     is distinct from the legacy fallback: a disk re-resolve
  //     here would let an edit to hooks.toml between spawn and
  //     child read add policy the parent never validated, the
  //     exact drift this migration exists to close.
  //   - `[hook, ...]` — parent's resolved chain, used verbatim.
  hooksSnapshot: readonly HookSpec[] | null;
  // Per-playbook tool_restrictions snapshot (migration 024,
  // `PLAYBOOKS.md` §1.1). Mirrors the same drift-prevention
  // pattern as policy_snapshot / hooks_snapshot: the parent
  // committed the rule shape from the .md, the child runs against
  // exactly that contract.
  //
  // Discriminator:
  //   - `null` — no snapshot taken (legacy pre-migration row, or
  //     a definition without a `tool_restrictions` block at load
  //     time). Child applies no restriction gate; the playbook's
  //     `tools[]` whitelist remains the floor.
  //   - `{}` — snapshot exists but is empty. Same runtime effect
  //     as `null` (passthrough), but distinguishable in audit:
  //     the operator sees the author meant "no restrictions" vs
  //     "no snapshot was taken".
  //   - `{ <tool>: { allow|deny|allowPaths|denyPaths }, ... }` —
  //     authoritative rule map. Child consults each entry on
  //     dispatch.
  toolRestrictions: ToolRestrictions | null;
  // Per-playbook sampling override (migration 025,
  // `PLAYBOOKS.md` §1.1). Same drift-prevention contract as the
  // other snapshots. Tri-state mirrors hooks_snapshot:
  //   - `null` — no snapshot. Child uses provider defaults.
  //   - `{}` — snapshot exists but no overrides. Same runtime
  //     effect as null but distinguishable in audit.
  //   - non-empty `SamplingOverride` — field-by-field override
  //     map applied to the child's harness config.
  sampling: SamplingOverride | null;
  // Per-playbook reference paths (migration 026,
  // `PLAYBOOKS.md` §1.1). Same drift-prevention contract as the
  // other snapshots. Tri-state:
  //   - `null` — no snapshot. Child appends no reference block;
  //     the system prompt is the playbook body alone.
  //   - `[]` — empty list, snapshot exists. Same runtime effect
  //     as null at composition (no block rendered) but
  //     distinguishable in audit.
  //   - non-empty `string[]` — paths the child surfaces in a
  //     "References (read on demand)" block appended to the
  //     system prompt.
  references: string[] | null;
  // Per-playbook output_schema snapshot (migration 027,
  // `PLAYBOOKS.md` §1.2). Two-state — schemas are either
  // present (an arbitrary mapping the child renders + validates
  // against) or absent (no enforcement). Empty `{}` collapses
  // to absent at runtime because validateOutput against an
  // empty object is a no-op; we don't bother distinguishing it
  // here since the audit value rounds back through the same
  // null-check.
  outputSchema: Record<string, unknown> | null;
  // Per-playbook context_recipe snapshot (migration 028,
  // `PLAYBOOKS.md` §1.1). Two-state — recipe present or absent.
  // Empty `{}` collapses to absent at runtime since every recipe
  // field is optional and an empty recipe is functionally
  // identical to no recipe.
  contextRecipe: ContextRecipe | null;
  // PERMISSION_ENGINE.md §10.1 — effective capability envelope
  // (migration 040, slice 95). Result of `parent_caps ∩
  // declared_caps` at spawn time, persisted as the formatted
  // capability strings (`['read-fs:src/**', 'exec:shell']`). The
  // child engine reads this and configures `EngineOptions
  // .effectiveCapabilities` so every tool call is gated against
  // the declared envelope BEFORE the policy pipeline runs.
  //
  // Tri-state mirrors `hooksSnapshot` / `toolRestrictions`:
  //   - `null` — no snapshot. Legacy pre-migration-040 row, OR a
  //     root agent (no parent ⇒ no envelope). Child engine
  //     skips the §10.1 stage entirely.
  //   - `[]` — pure-LLM subagent (declared = []). Child denies
  //     ANY non-empty resolved capability at evaluation time.
  //   - `['cap', ...]` — narrowed envelope. Each resolved cap
  //     must align with some entry via cwd-aware coverage
  //     (`capabilityCoversCwdAware`).
  effectiveCapabilities: string[] | null;
  // Migration 058 — back-pointer to the approval row that authorized
  // the spawn (PERMISSION_ENGINE.md §10.2). Tri-state:
  //   - `null` — no approval lineage. Legacy pre-058 rows, fixtures,
  //     and the verify-semantic synthetic-approval bypass when
  //     disabled. The synthetic-approval emission path (round-2 R3)
  //     populates this for verify-scheduler dispatches so the audit
  //     chain stays one-hop instead of broken.
  //   - non-empty string — UUID of the `approvals` row that admitted
  //     this spawn. JOIN against `approvals(id)` lets forensic
  //     queries answer "which decision authorized this run?" in one
  //     hop. ON DELETE SET NULL keeps the run row when the approval
  //     itself is retention-swept.
  parentApprovalId: string | null;
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
  hooks_snapshot: string | null;
  tool_restrictions: string | null;
  sampling: string | null;
  reference_paths: string | null;
  output_schema: string | null;
  context_recipe: string | null;
  effective_capabilities: string | null;
  parent_approval_id: string | null;
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
  // Defensive parse on hooks_snapshot. Three states:
  //   - `null` (column NULL) → no snapshot was taken. Caller
  //     falls through to disk re-resolve.
  //   - valid JSON array → use as-is (even when empty:
  //     authoritative "parent had no hooks").
  //   - corrupt JSON / wrong shape → fall back to `null` so the
  //     caller's legacy disk-re-resolve path engages. We do NOT
  //     fall back to `[]` here: an authoritative empty would
  //     skip disk re-resolve, and a corrupt row should NOT
  //     silently disable hook enforcement.
  let hooksSnapshot: HookSpec[] | null;
  if (row.hooks_snapshot === null) {
    hooksSnapshot = null;
  } else {
    try {
      const parsed = JSON.parse(row.hooks_snapshot) as unknown;
      if (Array.isArray(parsed) && parsed.every((e) => e !== null && typeof e === 'object')) {
        hooksSnapshot = parsed as HookSpec[];
      } else {
        hooksSnapshot = null;
      }
    } catch {
      hooksSnapshot = null;
    }
  }
  // Defensive parse on tool_restrictions. Same tri-state shape as
  // hooks_snapshot:
  //   - `null` (column NULL) → no snapshot. Child runs with no
  //     restriction gate.
  //   - valid JSON object → use as-is (even when empty `{}`:
  //     authoritative "author declared no restrictions").
  //   - corrupt JSON / wrong shape → fall back to `null` so the
  //     child path treats the row as "no snapshot". We do NOT
  //     fall back to `{}`: a corrupt row should not silently
  //     disable restrictions when the author authored them, and
  //     an empty map at runtime is functionally identical to
  //     null anyway.
  let toolRestrictions: ToolRestrictions | null;
  if (row.tool_restrictions === null) {
    toolRestrictions = null;
  } else {
    try {
      const parsed = JSON.parse(row.tool_restrictions) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        toolRestrictions = parsed as ToolRestrictions;
      } else {
        toolRestrictions = null;
      }
    } catch {
      toolRestrictions = null;
    }
  }
  // Defensive parse on sampling. Same shape rules as
  // tool_restrictions (a map of override fields, not an array,
  // not a primitive). Corrupt or wrong-shape rows fall back to
  // null — child runs with provider defaults rather than picking
  // up a half-applied override.
  let sampling: SamplingOverride | null;
  if (row.sampling === null) {
    sampling = null;
  } else {
    try {
      const parsed = JSON.parse(row.sampling) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        sampling = parsed as SamplingOverride;
      } else {
        sampling = null;
      }
    } catch {
      sampling = null;
    }
  }
  // Defensive parse on reference_paths. Shape: string[]. Same
  // tri-state convention. Wrong shape (object, mixed types,
  // etc.) collapses to null; the child renders no reference
  // block in that case rather than a malformed list.
  let references: string[] | null;
  if (row.reference_paths === null) {
    references = null;
  } else {
    try {
      const parsed = JSON.parse(row.reference_paths) as unknown;
      if (Array.isArray(parsed) && parsed.every((e) => typeof e === 'string')) {
        references = parsed;
      } else {
        references = null;
      }
    } catch {
      references = null;
    }
  }
  // Defensive parse on output_schema. Shape: object mapping.
  // Wrong shape (array, primitive) collapses to null → child
  // runs with no schema enforcement, preserving the legacy
  // free-form output behavior. Refusing the row would punish
  // a corrupt audit instead of degrading gracefully.
  let outputSchema: Record<string, unknown> | null;
  if (row.output_schema === null) {
    outputSchema = null;
  } else {
    try {
      const parsed = JSON.parse(row.output_schema) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        outputSchema = parsed as Record<string, unknown>;
      } else {
        outputSchema = null;
      }
    } catch {
      outputSchema = null;
    }
  }
  // Defensive parse on context_recipe. Same shape rules as
  // sampling — a corrupt or wrong-shape row collapses to null
  // (recipe disabled rather than partially applied).
  let contextRecipe: ContextRecipe | null;
  if (row.context_recipe === null) {
    contextRecipe = null;
  } else {
    try {
      const parsed = JSON.parse(row.context_recipe) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        contextRecipe = parsed as ContextRecipe;
      } else {
        contextRecipe = null;
      }
    } catch {
      contextRecipe = null;
    }
  }
  // Defensive parse on effective_capabilities (migration 040, slice
  // 95). Shape: string[]. Corrupt or wrong-type rows collapse to
  // null so the child engine treats them as legacy / root — the
  // alternative ('[]' fallback) would silently flip a corrupt row
  // from "no constraint" to "pure-LLM deny-all", which is a
  // worse failure mode than re-opening the §10.1 gap on a row
  // we couldn't read. The DB row was authored by the parent at
  // spawn (synchronous trusted write); corruption is genuinely
  // unexpected and operator should see it in audit.
  let effectiveCapabilities: string[] | null;
  if (row.effective_capabilities === null) {
    effectiveCapabilities = null;
  } else {
    try {
      const parsed = JSON.parse(row.effective_capabilities) as unknown;
      if (Array.isArray(parsed) && parsed.every((e) => typeof e === 'string')) {
        effectiveCapabilities = parsed;
      } else {
        effectiveCapabilities = null;
      }
    } catch {
      effectiveCapabilities = null;
    }
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
    toolRestrictions,
    sampling,
    references,
    outputSchema,
    contextRecipe,
    effectiveCapabilities,
    parentApprovalId: row.parent_approval_id,
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
  // Parent's resolved hook chain at spawn time. Tri-state:
  //   - undefined / omitted → row's `hooks_snapshot` column
  //     stays NULL; child treats this as "no snapshot, re-
  //     resolve from disk" (legacy fallback). Programmatic
  //     callers that don't model hooks land here.
  //   - empty array `[]` → authoritatively "parent had no
  //     hooks". Child uses [] verbatim, no disk re-resolve.
  //   - non-empty `HookSpec[]` → parent's resolved chain.
  //     Child uses verbatim.
  // The previous shape conflated undefined and `[]` into a
  // single "fall back to disk" sentinel — defeating the
  // migration's drift-prevention guarantee for hookless
  // parents. The discriminator now lives on the wire.
  hooksSnapshot?: readonly HookSpec[];
  // Per-playbook tool_restrictions snapshot (migration 024).
  // Tri-state mirrors `hooksSnapshot`:
  //   - undefined / omitted → row's `tool_restrictions` column
  //     stays NULL; child treats this as "no snapshot, no gate".
  //   - empty object `{}` → authoritative "author declared no
  //     restrictions". Functionally identical to undefined at
  //     runtime, but distinguishable in audit.
  //   - non-empty `ToolRestrictions` → rule map per tool.
  toolRestrictions?: ToolRestrictions;
  // Per-playbook sampling override (migration 025). Tri-state
  // mirrors `toolRestrictions`:
  //   - undefined / omitted → column NULL ⇒ child uses provider
  //     defaults. Programmatic callers without a sampling block
  //     land here.
  //   - empty object `{}` → authoritative "author declared no
  //     overrides". Functionally identical to undefined at
  //     runtime, but distinguishable in audit.
  //   - non-empty `SamplingOverride` → override map per field.
  sampling?: SamplingOverride;
  // Per-playbook reference paths (migration 026). Tri-state:
  //   - undefined / omitted → column NULL ⇒ child appends no
  //     reference block.
  //   - `[]` → empty list snapshot. Same runtime as undefined
  //     but distinguishable in audit ("author declared no refs"
  //     vs "no snapshot taken").
  //   - non-empty `string[]` → paths rendered in the prompt's
  //     trailing reference block.
  references?: readonly string[];
  // Per-playbook output_schema snapshot (migration 027). Two-
  // state: undefined ⇒ column NULL ⇒ child runs without schema
  // enforcement; non-empty object ⇒ JSON-serialized into the
  // column. The runtime collapses an empty object to "no
  // enforcement" because the validator can't fail on it anyway.
  outputSchema?: Record<string, unknown>;
  // Per-playbook context_recipe snapshot (migration 028).
  // Two-state: undefined ⇒ column NULL ⇒ child uses default
  // behavior on memory + prompt composition; non-empty
  // `ContextRecipe` ⇒ JSON-serialized into the column.
  contextRecipe?: ContextRecipe;
  // PERMISSION_ENGINE.md §10.1 effective envelope (migration 040,
  // slice 95). Tri-state:
  //   - undefined / omitted → column NULL ⇒ child engine runs
  //     WITHOUT a §10.1 bound (root behavior). Programmatic
  //     callers that don't model the spawn-time intersection
  //     land here.
  //   - empty array `[]` → column `'[]'` ⇒ pure-LLM child. Child
  //     engine denies any non-empty resolved capability at
  //     evaluation time.
  //   - non-empty `string[]` → column with the JSON-serialized
  //     capability list. Child engine gates every resolved cap.
  //
  // The undefined-vs-`[]` distinction MUST survive to the child:
  // conflating them would let a corrupt or absent snapshot
  // silently grant the parent's full capability set, re-opening
  // the R11 P0-3 gap slice 95 closes.
  effectiveCapabilities?: readonly string[];
  // Migration 058 — approval row that authorized the spawn
  // (PERMISSION_ENGINE.md §10.2). Optional for backwards
  // compatibility with fixtures and the synthetic-approval bypass.
  // Production callers (task tool spawn path) MUST supply when an
  // approval row exists; the verify-semantic scheduler supplies a
  // synthetic approval id (decided_by='system:semantic_verify').
  parentApprovalId?: string;
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
  // hooks_snapshot is nullable (migration 020): undefined OR null
  // both mean "no snapshot taken, child falls back to disk"; only
  // an explicit array (even []) is authoritative. The TS type is
  // `?: readonly HookSpec[]` so null isn't valid statically, but
  // a JS caller could pass null and `JSON.stringify(null)` would
  // produce the literal string "null" — a third on-disk state
  // that would round-trip back as JS null and fall into the
  // legacy disk-fallback path "by accident". Collapse to SQL
  // NULL explicitly so the column has exactly two states:
  // `NULL` (absent) and a JSON array (authoritative).
  const hooksJson =
    input.hooksSnapshot !== undefined && input.hooksSnapshot !== null
      ? JSON.stringify(input.hooksSnapshot)
      : null;
  // Same NULL-vs-array convention for tool_restrictions: undefined
  // ⇒ column NULL (no snapshot taken); explicit object ⇒ JSON
  // serialization. The runtime collapses both NULL and `'{}'` to
  // passthrough, but the column distinction survives in audit.
  const restrictionsJson =
    input.toolRestrictions !== undefined && input.toolRestrictions !== null
      ? JSON.stringify(input.toolRestrictions)
      : null;
  // Same NULL-vs-object convention for sampling: undefined ⇒
  // column NULL (no snapshot taken); explicit object ⇒ JSON.
  const samplingJson =
    input.sampling !== undefined && input.sampling !== null ? JSON.stringify(input.sampling) : null;
  // Same NULL-vs-array convention for reference_paths.
  const referencesJson =
    input.references !== undefined && input.references !== null
      ? JSON.stringify(input.references)
      : null;
  // Same NULL-vs-object convention for output_schema.
  const outputSchemaJson =
    input.outputSchema !== undefined && input.outputSchema !== null
      ? JSON.stringify(input.outputSchema)
      : null;
  // Same NULL-vs-object convention for context_recipe.
  const contextRecipeJson =
    input.contextRecipe !== undefined && input.contextRecipe !== null
      ? JSON.stringify(input.contextRecipe)
      : null;
  // Same NULL-vs-array convention for effective_capabilities. Note
  // that `[]` is an AUTHORITATIVE state here (pure-LLM child),
  // distinct from `null` (no snapshot / root). The conditional
  // preserves that distinction — `JSON.stringify([])` ⇒ `'[]'`
  // (authoritative), `undefined` ⇒ null (absent).
  const effectiveCapsJson =
    input.effectiveCapabilities !== undefined && input.effectiveCapabilities !== null
      ? JSON.stringify(input.effectiveCapabilities)
      : null;
  const parentApprovalId = input.parentApprovalId ?? null;
  db.query(
    `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt,
        tools_whitelist, budget_max_steps, budget_max_cost_usd,
        budget_max_wall_ms, policy_snapshot, hooks_snapshot,
        tool_restrictions, sampling, reference_paths, output_schema,
        context_recipe, effective_capabilities, parent_approval_id,
        captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    restrictionsJson,
    samplingJson,
    referencesJson,
    outputSchemaJson,
    contextRecipeJson,
    effectiveCapsJson,
    parentApprovalId,
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
    hooksSnapshot: input.hooksSnapshot ?? null,
    toolRestrictions: input.toolRestrictions ?? null,
    sampling: input.sampling ?? null,
    references: input.references === undefined ? null : [...input.references],
    outputSchema: input.outputSchema ?? null,
    contextRecipe: input.contextRecipe ?? null,
    effectiveCapabilities:
      input.effectiveCapabilities === undefined ? null : [...input.effectiveCapabilities],
    parentApprovalId,
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
              budget_max_wall_ms, policy_snapshot, hooks_snapshot,
              tool_restrictions, sampling, reference_paths, output_schema,
              context_recipe, effective_capabilities, parent_approval_id,
              captured_at
         FROM subagent_runs
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return row !== null ? fromRow(row) : null;
};
