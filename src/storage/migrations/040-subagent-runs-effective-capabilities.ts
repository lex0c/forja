export const migration040SubagentRunsEffectiveCapabilities = {
  id: 40,
  name: '040-subagent-runs-effective-capabilities',
  // PERMISSION_ENGINE.md §10.1 — slice 95 closes R11 P0-3 from the
  // post-slice-93 review: `effective_caps = parent_caps ∩ declared_caps`
  // is computed at spawn time (slice 94 wired declared end-to-end) but
  // the child engine still evaluated tool calls against the parent's
  // FULL capability set. A child whose declared = ['read-fs:src/**']
  // was permitted to read `/etc/passwd` because the parent's policy
  // allowed read-fs:** somewhere — the intersection's narrowing was
  // recorded but never enforced at evaluation.
  //
  // Slice 95 plumbs the intersection result through to the child engine
  // via `EngineOptions.effectiveCapabilities`. This column is the
  // serialization seam: the parent computes effective at spawn,
  // persists the formatted capability strings here, and the child
  // reads them at startup and configures the engine. Same drift-
  // collapse story as policy_snapshot (015), hooks_snapshot (020),
  // tool_restrictions (024): the child runs under the contract the
  // parent committed, regardless of what changes mid-run.
  //
  // Format: TEXT containing a JSON array of capability strings
  // (`read-fs:src/**`, `exec:shell`, etc.) — the same wire form
  // `parseCapability` round-trips. Sorted lex by `sortCapabilities`
  // for chain-hash determinism (matches the `capabilities_json` audit
  // row convention).
  //
  // States the column distinguishes:
  //   - NULL — legacy row OR root agent (no parent). Child engine
  //     runs WITHOUT an effective constraint (root behavior). The
  //     reader keys on `parent_session_id IS NOT NULL` together
  //     with NULL here to decide "legacy / pre-slice-95 spawn"
  //     vs. "real root".
  //   - `'[]'` — declared = [] at spawn. Pure-LLM subagent: no
  //     side-effect capabilities. Any non-misc tool call is denied
  //     by the child engine.
  //   - `'[...]'` — narrowed set. Child engine denies any tool call
  //     whose resolved capabilities aren't covered by some entry.
  //
  // The NULL vs '[]' distinction matters: omitting effective entirely
  // grants the parent's full set (root behavior), while declaring
  // an empty set is a tight bound (pure-LLM). The two MUST be
  // distinguishable on the wire — a future column-default-NULL
  // assumption that conflates them would broaden the pure-LLM case
  // back to inherited-from-parent, re-opening the very gap slice 95
  // closes.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN effective_capabilities TEXT;
  `,
} as const;
