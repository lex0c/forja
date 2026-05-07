export const migration028SubagentRunsContextRecipe = {
  id: 28,
  name: '028-subagent-runs-context-recipe',
  // Per-playbook context_recipe (`PLAYBOOKS.md` §1.1, canonical
  // recipes in `CONTEXT_TUNING.md` §13). The loader normalizes
  // the YAML block into the typed `ContextRecipe` (slice 1);
  // `runSubagent` snapshots it into this column at spawn so the
  // subprocess child applies the recipe to its memory section
  // and prompt composition.
  //
  // Slice 9 wires the live fields:
  //   - `memory_filter` — filters the memory index by type / tag.
  //   - `step_reflection` — adds a per-step trace instruction
  //     to the system prompt.
  //
  // Other recipe fields (include_repo_map, include_diff,
  // include_callers, fewshot_count, goal_reinjection_every_n_steps,
  // clarify_mode) are persisted but stay no-op at runtime until
  // their consumer subsystems land (CODE_INDEX for repo-map /
  // callers / diff; STATE_MACHINE goal stack for reinjection /
  // clarify). Persistence at this slice means the operator can
  // declare the intent today; the consumer slices will pick it up
  // automatically.
  //
  // Storage as TEXT (JSON-serialized ContextRecipe). NULL ⇒ no
  // snapshot taken (legacy row, definition without
  // context_recipe block) ⇒ child uses the default behavior on
  // every recipe-affected surface.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN context_recipe TEXT;
  `,
} as const;
