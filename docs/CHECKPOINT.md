# Checkpoints & rollback

How Forja makes every filesystem write reversible: a git snapshot before each
step that writes, and `/undo` to restore it — without touching the user's own
git workflow.

> **Normative spec:** `docs/spec/CHECKPOINTS.md` (and `AGENTIC_CLI.md §12`). This
> file is the implementation companion (non-normative): it maps the spec onto
> the code and explains the *why*. When the two disagree, the spec wins for
> intent and the code wins for behavior — fix whichever is wrong.

> **Root idea — measure twice, cut once.** Every step that runs a `writes: true`
> tool gets a snapshot of the working tree *before* it executes. The snapshot is
> a real git commit on a private ref, so it survives `git gc` and is invisible to
> the user's `git log`/`git status`. `/undo` resets the working tree to that
> commit. Side effects outside the filesystem (DB, network, processes) and files
> outside the worktree are **not** reversed — a declared limit, surfaced as a
> warning, not a silent gap.

## Components

| File | Role |
|---|---|
| `src/checkpoints/detect.ts` | Startup probe: is cwd a git work-tree? Resolves the worktree root (`gitRoot`). |
| `src/checkpoints/git.ts` | Low-level git plumbing — `snapshot`, `restore`, `diff`, ref ops, retention rewrites. The only file that shells out to git. |
| `src/checkpoints/manager.ts` | `CheckpointManager` — orchestrates git + DB. The surface the harness and CLI consume. |
| `src/storage/repos/checkpoints.ts` | Audit/lookup table rows (`checkpoints`). |
| `src/storage/migrations/009-checkpoints.ts` | The `checkpoints` table schema. |
| `src/cli/checkpoints.ts` | `agent --checkpoints <verb>` and `agent --undo`. |
| `src/harness/loop.ts` | Wires the manager: snapshot before write-steps, lazy retention sweep at startup. |

## The write-step flow

```
model emits tool_uses
   │
   ▼
collect tool_uses ──▶ any tool with metadata.writes? ──no──▶ run tools (no snapshot)
   │                                │yes
   │                                ▼
   │                   PreCheckpoint hook (fire-and-forget)
   │                                ▼
   │                   manager.snapshot({ stepId, hadBash, stepN })
   │                       │
   │                       ├─ working tree == prior snapshot? ─▶ no-op (returns null)
   │                       └─ else: commit-tree on refs/agent/checkpoints/<session>,
   │                                insert a `checkpoints` row, emit checkpoint_created
   ▼
run tools (invokeTool)
```

The snapshot is `await`ed **before** the tools run, so the commit captures the
pre-step state. A snapshot failure is caught and swallowed — the step proceeds
without a checkpoint rather than dying (`/undo` then skips to the prior surviving
checkpoint, the conservative outcome). See the `checkpointManager.snapshot` call
site in `loop.ts`.

`hadBash` is `true` when any tool in the step has side effects that escape the
cwd: the source of truth is the tool's `metadata.escapesCwd`, with an explicit
`bash` / `bash_background` / `bash_kill` name fallback. It drives the `/undo`
warning (below) and is persisted as the `had_bash` column.

**Availability.** Checkpoints are wired only when `enableCheckpoints` is set
(true in `bootstrap.ts`, **false** for subagents in `subagent-child.ts` — the
parent owns the rollback boundary). When cwd isn't a git repo,
`detectCheckpointSupport` reports unavailable; tools still run, `/undo` just
isn't there, and the startup emits a one-line warning.

## Key invariants

**Per step, not per tool.** A logical operation (refactor 5 files) is one step
with several writes; one snapshot before the first write keeps the rollback unit
coherent. Reverting half a refactor would leave inconsistent state.

**Private ref, not stash.** Each session's chain head lives at
`refs/agent/checkpoints/<session_id>`, built with `git commit-tree` (not
`git stash`). Reasons: stash is a single global stack (`refs/stash`) we'd
pollute; and we chain each snapshot onto the prior one so the whole session
history stays reachable from one ref and survives `git gc`. Commit message:
`forja: pre-step <n> <iso>` for human grep.

**Worktree-root anchoring.** `snapshot` builds its tree with `git add -A` and
`restore` uses `git read-tree --reset -u` — the latter is *always* worktree-wide.
To keep them symmetric regardless of which subdirectory the agent runs from, the
manager anchors every git invocation at the worktree root
(`git rev-parse --show-toplevel`, resolved once in `detectCheckpointSupport` and
carried as `gitRoot`). `cwd` is kept separately, used **only** for DB retention
scoping (which joins `sessions.cwd`, the invocation directory). See
`CreateManagerInput.gitRoot`.

**Index isolation.** Staging never touches the user's `.git/index`. Every
`add`/`write-tree` runs with `GIT_INDEX_FILE` pointing at a throwaway temp index
seeded from HEAD's tree, so the user's staged changes are untouched and `/undo`
re-syncs the index to HEAD afterward.

**No-op skip.** Before committing, `snapshot` compares the new tree to the
parent commit's tree; identical → returns `sha: null`, no row, no ref move. Keeps
the audit log free of duplicate checkpoints and is cheaper than a full commit.

**Sensitive-path filter — untracked only.** `git add -A` would capture the
operator's untracked `.env`, `id_rsa`, `*.pem` sitting in cwd; these are dropped
from the checkpoint tree (`update-index --force-remove`) so secrets don't flow
into git objects (`SECURITY_GUIDELINE §8.4`). But a secret **already tracked at
HEAD** is *preserved* — it's already in git history (dropping it buys no leak
prevention) and stripping it would make `read-tree --reset -u` delete it from the
working tree on `/undo` (silent data loss). The filter subtracts the
tracked-at-HEAD set (captured via `ls-files` before `add -A`).

## Restore semantics (`/undo`)

`restore(commitSha)` resets the index + working tree to the checkpoint's tree.
**HEAD never moves** — the user's branch pointer and any commits they made stay
intact; only file contents revert. The sequence, in order, with each guard
firing *before* any side effect:

1. **Refuse mid-operation.** If a merge / rebase / cherry-pick / revert / bisect
   is in progress (`getInProgressOperation`), refuse with a hint at the right
   abort/continue command — `read-tree --reset -u` would clobber the resolution
   state.
2. **Validate the commit exists** (`rev-parse --verify <sha>^{commit}`) before
   stashing, so a GC'd commit doesn't strand the user's work in a stash tied to a
   failed restore.
3. **Preserve pending changes.** If the working tree is dirty (or an ignored file
   collides with a checkpoint path), save it first:
   - normal case → `git stash push -u` (recover with `git stash pop`);
   - unborn HEAD, or ignored↔checkpoint collision → a preservation commit under
     `refs/agent/restore-saved/<ts>-<uuid>` (recover with `git read-tree --reset
     -u <ref>`). The two shapes are reported distinctly so the CLI prints the
     right recovery hint.
4. **Apply** `read-tree --reset -u <sha>`, then re-sync the index to HEAD so
   `git status` reads naturally.

### What `/undo` cannot reverse

The `had_bash` warning (CLI, gated behind `--yes`) states it plainly:

```
WARNING: this step ran bash. --undo / --checkpoints restore reverts
  filesystem changes within the git worktree, but cannot reverse:
    - Database / HTTP / network state changes
    - Filesystem changes outside the worktree (/tmp, $HOME, other repos)
    - Process spawns
```

## CLI surface

DB + git only — no provider, no API key, no session start.

```
agent --checkpoints list <session>            # newest-first table / NDJSON
agent --checkpoints diff <session> <ckpt>     # working tree vs checkpoint
agent --checkpoints restore <session> <ckpt>  # reset to a specific checkpoint
agent --checkpoints purge <session>           # drop all rows + the session ref
agent --undo <session>                        # restore the latest checkpoint
```

Every verb validates the session belongs to the **current cwd**
(`ensureSessionForCwd`) — a checkpoint commit from another project doesn't exist
in this repo, so acting on it would error confusingly or clobber unrelated state.
`restore`/`undo` refuse a `had_bash` checkpoint unless `--yes` is passed, and a
GC'd commit gets a friendly "run `--checkpoints purge`" hint instead of raw git
output.

## Storage

Migration `009` — the table is the lookup/audit layer; the git commit is the
content.

```sql
checkpoints(
  id          TEXT PRIMARY KEY,         -- public checkpoint id (decoupled from git sha)
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_id     TEXT NOT NULL,            -- assistant message id that triggered it
  git_ref     TEXT NOT NULL,            -- commit SHA
  created_at  INTEGER NOT NULL,
  had_bash    INTEGER NOT NULL DEFAULT 0 CHECK (had_bash IN (0,1))
)
```

`id` is decoupled from `git_ref` so a future non-git backend can reuse the id
space. `had_bash` is captured at write time so `/undo` need not re-scan
`tool_calls`. `ON DELETE CASCADE` (with `PRAGMA foreign_keys = ON`) means
deleting a session drops its audit trail.

## Retention

- Refs live until **30 days** after the session ends
  (`agent.checkpoints.retentionDays`, default `DEFAULT_RETENTION_DAYS`).
- Cleanup runs **lazy** at startup (`purge`), fire-and-forget — it never blocks
  the run and never bubbles errors. Scoped to the current cwd so it won't wipe
  audit history for sessions in other projects.
- `agent --checkpoints purge <session>` forces it.

The non-trivial part: when *some* checkpoints in a session age out but others
survive, the survivors still parent the aged commits, so `git gc` can never
reclaim them — retention would only *hide* history, not enforce it. So `purge`
**rewrites** the surviving chain (re-parents the oldest survivor onto current
HEAD, severing the aged ancestry) and a **self-heal sweep** reconciles two
divergence shapes: orphan refs (ref with no DB rows) and drift (ref sha ≠ latest
survivor's `git_ref`, from a `setSessionRef` that failed after the DB update
landed). Aged rows are deleted only *after* the git rewrite + DB update succeed
atomically, so a transient failure leaves them for the next pass to retry.

## Performance

`snapshot` runs `git add -A` + `write-tree` + `commit-tree` (≈5 git invocations),
`await`ed on the write-step hot path. SLO: p95 < 500ms on repos < 10k files
(`PERFORMANCE.md`). The no-op skip (`git diff` of trees) cuts the common case.
Every git subprocess has a 30s timeout so a wedged ref lock can't hang a session.
**Known limit:** very large monorepos can exceed the SLO — the snapshot is
synchronous (it must finish before the writes), so this can't be parallelized
away (`CHECKPOINTS §2.8`).

## Security posture

- **Index isolation** + **git binary pinning** (`getGitBinary` + `safeGitEnv`):
  a mid-session `~/bin/git` shim can't hijack a checkpoint commit.
- **Sensitive-path filter** keeps untracked secrets out of git objects (above).
- Snapshots use a fixed identity (`forja <forja@local>`) so `git log --author`
  can isolate them and a config-less repo doesn't fail the run.

## Tests

`tests/checkpoints/git.test.ts` (plumbing, sensitive filter, worktree-root
anchoring), `tests/checkpoints/manager.test.ts` (orchestration, retention rewrite,
subdir anchoring), `tests/checkpoints/detect.test.ts` (probe + `gitRoot`),
`tests/cli/checkpoints.test.ts` (verbs, cwd guard, bash warning),
`tests/harness/checkpoints.test.ts` (write-step wiring).
