// Subagent definition (spec §11). Loaded from `.md` files with YAML
// frontmatter; the body is the system prompt the child harness will
// run with. Only the runtime-load-bearing fields are typed strongly
// here — playbook-specific metadata (output_schema, references,
// sampling, context_recipe) ship in later slices and stay as
// untyped extras on `meta`.

export interface SubagentBudget {
  // Hard caps. If both are absent the loader rejects — no
  // subagent without a budget; spec §11 makes that explicit
  // (smaller-than-parent budget is the only enforcement against
  // runaway children).
  maxSteps: number;
  maxCostUsd: number;
  // Optional wall-clock cap per playbook frontmatter
  // (PLAYBOOKS.md §1.1). Unenforced today by the harness — the
  // existing wall-clock budget covers it via parent — but stored
  // so renderers / future enforcement can consult it.
  maxWallClockMs?: number;
}

export type SubagentScope = 'user' | 'project';

// Isolation strategy declared by the subagent author. Spec §11.2:
// `none` (default) runs the child in the parent's working tree with
// no write access — the loader / validator refuse `metadata.writes:true`
// tools in `tools[]`, because the parent's `--undo` cannot reverse a
// child's writes when checkpoints are off. `worktree` opts the child
// into a dedicated git worktree under `~/.cache/agent/worktrees/<id>/`;
// the writes-true gate is lifted there because the child's mutations
// land on a separate branch the parent can inspect, merge, or discard
// without touching the principal tree.
export type SubagentIsolation = 'none' | 'worktree';

export interface SubagentDefinition {
  // Kebab-case unique identifier. Project scope shadows user
  // scope; cross-scope name collision is reported as a precedence
  // shadow, not an error.
  name: string;
  description: string;
  // Tools whitelist. Runtime filters the parent's registry to
  // exactly these names; tools outside the list are unavailable
  // to the child. Empty array = read-only thinking subagent
  // (rare; spec example uses [read_file, grep, glob]).
  tools: string[];
  budget: SubagentBudget;
  // System prompt — the markdown body BELOW the frontmatter,
  // trimmed. Empty body is rejected (the body IS the prompt; an
  // empty subagent has nothing to say).
  systemPrompt: string;
  // Where this definition was loaded from. Diagnostics only —
  // surfaces in error messages and `--list-subagents` (later).
  scope: SubagentScope;
  // Isolation strategy. Defaults to `none` when the frontmatter
  // omits the `isolation` field — preserves the Step 4.1 contract
  // for every existing definition.
  isolation: SubagentIsolation;
  sourcePath: string;
  // SHA-256 of the raw `.md` content (frontmatter + body) at load
  // time. Lets the audit table fingerprint the exact version a
  // subagent ran under, independent of what the file looks like
  // now. Hex-encoded lowercase for readability in JSON output.
  sourceSha256: string;
  // Untyped frontmatter overflow. Anything the loader didn't
  // map into a strongly-typed field lives here so future slices
  // (playbooks, sampling, context_recipe) can read frontmatter
  // without a loader bump. Validation of these fields lives in
  // the consumer, not in the loader.
  meta: Record<string, unknown>;
}
