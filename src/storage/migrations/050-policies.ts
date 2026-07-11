// policies — adaptation policies proposed/committed by the loop frio
// (FEEDBACK_ADAPTATION §3.2 + §6). Each row carries an `action_signature`
// + scope + state + Bayesian confidence + diff. The loop frio inserts
// rows with `state='proposed'`; humans promote to `state='active'` via
// `/agent policy promote` (3.4). Tool-dispatch consults this table at
// decision time via the scope resolver (3.5).
//
// Coexistence with `policy_archive` table (PERMISSION_ENGINE §6.2):
// distinct. `policy_archive` stores the operator's permission policy
// snapshots (YAML hashes); THIS table stores ADAPTATION policies
// (action_signature → action diffs). Different audit dimensions,
// different write paths, different consumers.
//
// State machine (FEEDBACK_ADAPTATION §7.1 + AGENTIC_CLI §11):
//
//   proposed → active     (operator promotion via /agent policy promote)
//   proposed → invalidated (loop frio re-evaluated; evidence reversed)
//   active   → shadow      (distribution shift detected; §7.3)
//   active   → quarantined (failure burst / user override 3× / §7.1)
//   active   → invalidated (stack change, tool removed, etc; §7.1)
//   shadow   → active      (scope estabilizou + posterior reconfirmado)
//   shadow   → quarantined (shadow divergiu de default em N runs)
//   quarantined → active     (evidência nova restaura confiança)
//   quarantined → invalidated (shift confirmado durante quarentena)
//
// Schema rationale (per-column):
//
// - `id` (TEXT PRIMARY KEY UUID v4). Mirrors every other audit-shaped
//   repo. Globally-unique IDs survive cross-install copies.
//
// - `parent_id` (TEXT, nullable, no FK). The policy this one was
//   promoted from (or invalidated, etc.). NULL for root policies (cold
//   start defaults + first proposed rows from accumulation triggers).
//   No FK constraint: parent may live in a different `scope_kind` (a
//   user-scope policy promoted from a repo-scope policy refs the repo
//   row's id), and a single FK can't enforce cross-scope semantics.
//
// - `scope_kind` (TEXT NOT NULL CHECK). 'global'|'language'|'repo'|
//   'user'|'session'. Mirrors outcomes.scope_kind.
//
// - `scope_id` (TEXT NOT NULL). Identifier in the scope's namespace
//   (same shape as outcomes.scope_id: 'global' for global; language
//   id; repo hash; user id; session id).
//
// - `action_signature` (TEXT NOT NULL). L1-L4 per §4.2. Same parser
//   as outcomes.action_signature.
//
// - `action_json` (TEXT NOT NULL). What the policy DOES. Per-level
//   shape: L1 {target: '<binary>'}, L2 {flag: '<name>', value: '<v>'},
//   L3 {recipe_id: '<id>'}, L4 {strategy_id: '<id>'}. Stored as JSON
//   for query flexibility; tool dispatch parses on read.
//
// - `state` (TEXT NOT NULL CHECK). 5-state enum per AGENTIC_CLI §11.
//   Closed enum; ALTER required to add states.
//
// - `ci_low`, `ci_high` (REAL, both nullable). Beta posterior 95%
//   credibility interval bounds. NULL for cold-start defaults +
//   manually-curated policies. Populated by the Bayesian aggregator
//   (3.4) once N >= threshold.
//
// - `n` (INTEGER NOT NULL DEFAULT 0). Outcome sample size aggregated
//   into this posterior. 0 for cold-start defaults. Loop frio uses
//   this + ci_low for the promotion gate (§5.3: ci_low > 0.7 AND
//   n >= 10).
//
// - `motivo` (TEXT). Why this state was reached. For 'proposed':
//   trigger name ('accumulation'/'incident'/etc.). For 'active':
//   promoter ('manual'/'auto'/'loop_frio'). For 'invalidated':
//   invalidation cause ('stack_change'/'tool_removed'/etc.). Free
//   TEXT (different states emit different vocabularies).
//
// - `diff_json` (TEXT, nullable). JSON-encoded diff vs `parent_id`.
//   For root policies: NULL. For derived policies: shows what
//   changed (action target, scope shift, state transition). Operator-
//   facing `/agent policy diff <id>` reads this.
//
// - `recorded_at` (INTEGER NOT NULL). Epoch ms.
//
// Indices:
//
// - `(action_signature, scope_kind, scope_id, state)` — primary read
//   path for the scope resolver: "is there an active policy for
//   action_signature X in scope Y?".
// - `(state, recorded_at)` — "what proposed policies need operator
//   review?" + "what was promoted recently?".
// - `(parent_id)` — chain traversal for `/agent policy history`.

export const migration050Policies = {
  id: 50,
  name: '050-policies',
  sql: `
    CREATE TABLE policies (
      id              TEXT PRIMARY KEY,
      parent_id       TEXT,
      scope_kind      TEXT NOT NULL
                        CHECK (scope_kind IN ('global', 'language', 'repo', 'user', 'session')),
      scope_id        TEXT NOT NULL,
      action_signature TEXT NOT NULL,
      action_json     TEXT NOT NULL,
      state           TEXT NOT NULL
                        CHECK (state IN ('proposed', 'active', 'shadow', 'quarantined', 'invalidated')),
      ci_low          REAL,
      ci_high         REAL,
      n               INTEGER NOT NULL DEFAULT 0,
      motivo          TEXT,
      diff_json       TEXT,
      recorded_at     INTEGER NOT NULL
    );

    CREATE INDEX idx_policies_action_scope_state
      ON policies(action_signature, scope_kind, scope_id, state);

    CREATE INDEX idx_policies_state_recorded
      ON policies(state, recorded_at);

    CREATE INDEX idx_policies_parent
      ON policies(parent_id);
  `,
} as const;
