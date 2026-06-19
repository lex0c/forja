// subagent_runs gains `model_entry_snapshot` so a SPAWNED subagent
// rebuilds its provider from the catalog entry the PARENT resolved at
// spawn time, instead of re-reading model_providers.json inside the
// child. The model catalog is an operator-owned, MUTABLE file: a
// mid-session edit or `forja init --force=model_providers` between
// parent spawn and child startup could otherwise make the child reject
// the already-recorded session.model, or instantiate the same id with a
// different base_url/capabilities — diverging subagent behavior and cost
// accounting from the parent session. This mirrors the policy / hooks /
// approval-posture snapshot drift-prevention pattern (the child reads
// this row at startup instead of re-deriving).
//
// Holds the JSON-serialized ModelProviderEntry. NULL on legacy rows and
// on spawns whose provider carried no catalog entry (test mocks /
// providerOverride); the child falls back to re-reading the file then.
//
// A plain ADD COLUMN suffices — additive, no table rebuild.
export const migration076SubagentRunsModelEntry = {
  id: 76,
  name: '076-subagent-runs-model-entry',
  sql: `
    ALTER TABLE subagent_runs ADD COLUMN model_entry_snapshot TEXT;
  `,
} as const;
