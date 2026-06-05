// Hard cap on how deep a chain of `task → task → task` can nest.
// 4 levels covers every plausible playbook composition; surfaces
// a clear error well before the budget caps would. Lives in
// types.ts (not runtime.ts) so tools that pre-flight depth at
// the call site (`task_async`) can import the const without
// pulling in the runtime module — runtime.ts depends on the
// tools registry for whitelist validation, and a tools/...→
// runtime → tools/... cycle would put `task_async` in a
// temporal dead zone at module load.
export const MAX_SUBAGENT_DEPTH = 4;

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

// Subagent definition scopes:
//   - 'builtin' — ships with the binary (`src/subagents/builtin/`).
//     Loaded last so user and project can shadow by name. Operators
//     can opt out of a builtin entirely by writing a same-name file
//     to their project or user scope (the loader's shadow surface
//     stays SILENT for builtin shadows — they're expected; surfacing
//     them on every boot would be noise for every install).
//   - 'user' — `~/.config/agent/agents/`. Shadows builtin.
//   - 'project' — `.agent/agents/` in the cwd. Shadows user + builtin.
export type SubagentScope = 'builtin' | 'user' | 'project';

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

// Outcome of a worktree-isolated subagent run. Mirrored verbatim by
// `RunSubagentResult.worktree`, `SpawnSubagentResult` (kind='ran')
// and `TaskOutput.worktree` so the model and operator see the same
// shape at every layer. Single source of truth here so the three
// surfaces can never drift.
//
// `dirty` is the post-run `git status --porcelain` verdict (true =
// any tracked or untracked diff). It drives the preserve/remove
// decision: clean → both worktree dir and agent branch dropped;
// dirty → both kept on disk for the parent to inspect via `path` /
// `branch`. `preserved` and `removed` are mutually exclusive
// booleans, NOT a discriminated union, because the model reads
// them positionally and an enum-tag plus a payload would force
// every consumer through an extra switch.
export interface WorktreeOutcome {
  path: string;
  branch: string;
  dirty: boolean;
  preserved: boolean;
  removed: boolean;
}

// Per-tool restriction rules declared by a playbook (`PLAYBOOKS.md`
// §1.1). The loader normalizes the YAML's permissive surface into
// this canonical shape so consumers (slice 5 enforcement) can match
// without a switch over input forms. Glob/prefix only — never regex
// (CLAUDE.md hard rule).
//
// Two key spaces coexist on the same record:
//
//   - `allow` / `deny` — pattern lists matched against the tool's
//     argv-shaped command string. Used by `bash` and friends.
//   - `allowPaths` / `denyPaths` — pattern lists matched against
//     filesystem paths. Used by `write_file` / `edit_file`.
//
// Both spaces can coexist on a single rule (`bash` could in
// principle restrict by both command and path), but the typical
// playbook uses just one. The slice-5 enforcer is the only consumer
// that decides which fields apply to which tool.
export interface ToolRestrictionRules {
  allow?: string[];
  deny?: string[];
  allowPaths?: string[];
  denyPaths?: string[];
}

// Map from tool name → restriction rules. Empty rule object means
// "no constraints declared for this tool" — distinct from absence
// of the entry which means "no entry at all". Slice 5 enforces;
// slice 1 only validates shape.
export type ToolRestrictions = Record<string, ToolRestrictionRules>;

// Sampling overrides per playbook (`PLAYBOOKS.md` §1.1, defaults in
// `TOKEN_TUNING.md` §9). Slice 6 wires these through the harness
// config; slice 1 only validates ranges. Field names are camelCase
// here (TS convention) but the YAML frontmatter keys are snake_case
// (`top_p`, `max_tokens`, `thinking_budget`, `seed_in_eval`).
export interface SamplingOverride {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  seedInEval?: boolean;
}

// `context_recipe.include_repo_map` enum from `PLAYBOOKS.md` §1.1.
// `eager` = inject at session start, `lazy` = only when the model
// asks, `off` = never. Slice 9 consumes; slice 1 validates.
export type IncludeRepoMap = 'eager' | 'lazy' | 'off';

// `context_recipe.step_reflection` enum from `CONTEXT_TUNING.md`
// §13.10. `terse` = one-line trace per step, `full` = paragraph,
// `off` = none.
export type StepReflection = 'off' | 'terse' | 'full';

// Context shaping per playbook (`PLAYBOOKS.md` §1.1, canonical
// recipes in `CONTEXT_TUNING.md` §13). Slice 9 consumes the fields
// that have downstream subsystems wired (memory_filter,
// step_reflection, goal_reinjection); the repo-map / diff / callers
// fields stay frozen until CODE_INDEX lands. Slice 1 validates shape so
// authors can declare the intent today and the definition is
// forward-compatible.
export interface ContextRecipe {
  includeRepoMap?: IncludeRepoMap;
  includeDiff?: boolean;
  includeCallers?: boolean;
  goalReinjectionEveryNSteps?: number;
  fewshotCount?: number;
  memoryFilter?: string[];
  stepReflection?: StepReflection;
}

// Single phase declaration (`PLAYBOOKS.md` §1.1, lifecycle in
// `STATE_MACHINE.md` §2.3). `onEnter` / `onComplete` are opaque
// strings here — the runtime that consumes them (deferred until
// goal_stack lands) parses the call shape. Slice 1 only enforces
// presence of `name` and string typing on the hooks.
export interface PhaseDef {
  name: string;
  onEnter?: string;
  onComplete?: string;
}

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
  // omits the `isolation` field — preserves the contract for
  // every existing definition.
  isolation: SubagentIsolation;
  sourcePath: string;
  // SHA-256 of the raw `.md` content (frontmatter + body) at load
  // time. Lets the audit table fingerprint the exact version a
  // subagent ran under, independent of what the file looks like
  // now. Hex-encoded lowercase for readability in JSON output.
  sourceSha256: string;
  // Playbook surfaces (`PLAYBOOKS.md` §1.1). All optional — a
  // legacy subagent without any of these stays valid, behaves
  // exactly as before, and the consumer slices treat absence as
  // "no override". Each field is validated for shape at load time
  // so authors get a source-aware error instead of a deferred
  // runtime exception. Consumers land in later slices:
  //
  //   - `outputSchema` (slice 8)        — schema rendered into the
  //                                       child's system prompt and
  //                                       used post-hoc to validate
  //                                       the terminal assistant turn.
  //   - `references` (slice 7)          — list injected into the
  //                                       child's system prompt
  //                                       under a "References" block.
  //   - `toolRestrictions` (slice 5)    — argv-shape / path-shape
  //                                       glob/prefix gates run as a
  //                                       middleware before invoke.
  //   - `slash` (slice 3)               — auto-registered as a
  //                                       slash command dispatching
  //                                       `task_sync(playbook=name)`.
  //   - `whenToUse` (slice 2)           — emitted in the discovery
  //                                       table the principal agent
  //                                       reads at session start.
  //   - `sampling` (slice 6)            — passed to the child harness
  //                                       config; provider applies.
  //   - `contextRecipe` (slice 9, partial) — applied to the child's
  //                                       memory filter / step
  //                                       reflection / goal
  //                                       reinjection cadence.
  //   - `promptVersion` /
  //     `contextRecipeVersion` (slice 10) — surfaced in eval audit
  //                                       so a regression can be
  //                                       traced to a prompt edit.
  //   - `phases` (deferred, runtime needs goal_stack) — validated
  //                                       at load so authors can
  //                                       declare the intent today.
  outputSchema?: Record<string, unknown>;
  references?: string[];
  toolRestrictions?: ToolRestrictions;
  slash?: string;
  whenToUse?: string;
  sampling?: SamplingOverride;
  contextRecipe?: ContextRecipe;
  promptVersion?: number;
  contextRecipeVersion?: number;
  phases?: PhaseDef[];
  // Declared capabilities (PERMISSION_ENGINE.md §10.1). Strings in
  // the canonical capability format (e.g. `read-fs:src/**`,
  // `exec:shell`, `net-egress:*`). The runtime intersects this
  // list against the parent's effective envelope and seals the
  // result into `subagent_runs.effective_capabilities`. Absence
  // ⇒ "not declared"; the runtime falls back to the parent's
  // envelope verbatim (legacy behavior, preserved for
  // unannotated playbooks). An empty array `[]` is meaningful:
  // pure-LLM run (no capabilities granted) — spec-prescribed
  // shape for read-only fact-checkers like verify-semantic.
  capabilities?: string[];
  // Untyped frontmatter overflow. Anything the loader didn't
  // map into a strongly-typed field lives here so future slices
  // can read frontmatter without a loader bump. Validation of
  // these fields lives in the consumer, not in the loader. Today
  // this is rarely populated — the typed surface above covers
  // every field `PLAYBOOKS.md` §1.1 declares.
  meta: Record<string, unknown>;
}
