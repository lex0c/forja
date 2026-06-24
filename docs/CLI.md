# CLI

Command reference for the `forja` binary.

This is a derived reference — the source of truth is the argument parser in
`src/cli/args.ts` (dispatch in `src/cli/index.ts`) and the slash-command
registry in `src/cli/slash/index.ts`. `forja --help` prints a shorter subset;
this doc also covers the advanced subcommands (`gc`, `purge`, `permission`, …)
that the inline help omits. Architectural rationale lives in the spec
(`docs/spec/AGENTIC_CLI.md`); the cross-references at the bottom point at the
per-subsystem docs.

Two conventions hold across the surface:

- **stdout is pure, stderr is for logs.** With `--json`, stdout is NDJSON and
  nothing else; diagnostics and warnings always go to stderr.
- **Destructive subcommands are two-phase.** A bare invocation previews
  (dry-run, no mutation); `--force` executes. This holds for `gc`, `purge`,
  `cache clear`, and `--worktrees gc`.

---

## Invocation

```
forja [options] <prompt>
forja <subcommand> [args]
```

A bare prompt runs the agent. With no prompt and a TTY, `forja` opens the
interactive REPL (where the slash commands below apply). With `--json` it runs
headless and streams NDJSON events.

---

## Run options

These modify an agent run (or the session-management actions below).

| Flag | Effect |
|---|---|
| `--version`, `-v` | Print version and exit. |
| `--help`, `-h` | Print usage and exit. |
| `--json` | Emit NDJSON events to stdout (headless mode). |
| `--model <id>` | Model id, e.g. `anthropic/claude-opus-4-8`, `openai/gpt-4o`, `ollama/<model>` (default: `anthropic/claude-opus-4-8`). |
| `--profile <name>` | Run against an isolated on-disk namespace (`~/.config/forja-<name>`, `~/.local/share/forja-<name>`, `.forja-<name>/`) so a dev build never migrates or pollutes real state. Also via `FORJA_PROFILE`. Name: `[a-z0-9][a-z0-9-]*`. |
| `--autonomous` | Start in Autonomous mode: auto-approve routine confirms (Shift+Tab toggles in the REPL). |
| `--no-recap` | Disable recap for this run: no session-end/Alt+R auto-display, no resume rehydrate, deterministic `/recap` render. |
| `--max-steps <n>` | Override the harness step budget. |
| `--yes`, `-y` | Skip the bash-side-effect confirm on `--undo` / `--checkpoints restore`. |

---

## Session & history

These inspect or continue prior sessions. They run without a provider or API
key (DB + git only).

| Command | Effect |
|---|---|
| `--list-sessions` | Print known sessions (newest first) and exit. |
| `--include-subagents` | With `--list-sessions`, fan parents into their subagent children. |
| `--limit <n>` | With `--list-sessions`, cap rows (default 20). |
| `--resume <id\|last>` | Continue a prior session; the positional prompt is the follow-up. |
| `--resume-mode <full\|summary>` | With `--resume`: load all history, or compact it at boot. |
| `--undo <session>` | Restore the latest checkpoint of a session (thin alias for `--checkpoints restore <session> <latest>`). HEAD untouched. |
| `--memory <verb>` | Inspect cross-session memory: `list [scope]` \| `show <name> [scope]`. |
| `--explain-permissions` | Print the resolved permission policy + per-section layer attribution and exit (pair with `--json`). |

### `--checkpoints <cmd>`

Inspect / restore the git-backed checkpoint history (see `docs/CHECKPOINT.md`).
Checkpoints are git commits in the user's repo plus rows in the `checkpoints`
table; they are NOT loose file snapshots.

| Subcommand | Effect |
|---|---|
| `list <session>` | Newest-first table / NDJSON of checkpoints. |
| `diff <session> <ckpt>` | Diff between the current working tree and `<ckpt>`. |
| `restore <session> <ckpt>` | `read-tree --reset -u <ckpt>`; HEAD untouched. Confirm-gated unless `--yes`. |
| `purge <session>` | Delete every checkpoint row + the session ref for that session. |

### `--worktrees <verb>`

Inspect / garbage-collect subagent git worktrees under
`~/.cache/forja/worktrees/` (see "Maintenance" below).

| Subcommand | Effect |
|---|---|
| `list` | Table / NDJSON of every classified worktree entry. |
| `gc [--dry-run] [--force]` | Apply the gc plan. `--dry-run` renders the plan only; `--force` lifts the skip on dirty-preserved + orphan entries. |

---

## Subcommands

### `init`

Scaffold the `.forja/` bootstrap bundle: `permissions.yaml`, `.gitignore`,
`config.toml`, `agents/*.md`, `skills/shared/*.md`, and the vendor memory seed
pack (`<user>/seeds/*.md`). Each step is idempotent — existing files are
skipped.

| Flag | Effect |
|---|---|
| `--mode <strict\|acceptEdits>` | `permissions.yaml` posture. |
| `--only=csv` | Subset to run: `permissions,gitignore,config,playbooks,skills,seeds`. |
| `--no-seeds` | Opt out of the vendor seed pack. |
| `--force` | Overwrite all force-eligible steps. |
| `--force=csv` | Overwrite a subset (`permissions,config,playbooks,skills`). `.gitignore` is operator-owned and never force-overwritten. |

### `doctor`

Health check: platform, sandbox tools, config + data dirs, git. Accepts
`--json`.

### `welcome`

First-boot walkthrough — composes `doctor` + `sandbox setup` + a next-steps
menu into a guided intro. Idempotent.

### `sandbox setup`

Print the recommended sandbox install command for this platform. Accepts
`--json`. (`sandbox` currently has the single verb `setup`.)

### `cache clear`

Reclaim the persistent sandbox build/dep cache under `~/.cache/forja/cache/`.
Two-phase: bare invocation reports size; `--force` removes. Never touches the
per-session `/tmp` binds under `~/.cache/forja/tmp/sessions/`. Accepts `--json`.

### `gc`

Garbage-collect aged rows from the audit/cache tables of the global DB
(`AGENTIC_CLI.md §2.1.3`, `AUDIT.md §1.2`). Two-phase: bare invocation is a
read-only dry-run (no mutation); `--force` deletes.

| Flag | Effect |
|---|---|
| `--force` | Execute the sweep (otherwise dry-run). |
| `--table=<name>` | Restrict to one table (repeatable). |
| `--json` | NDJSON report. |

Covered tables (11): `recap_cache`, `retrieval_trace`, `context_pins`,
`bg_processes`, `memory_events`, `hook_runs`, `failure_events`,
`eviction_events`, `outcomes`, `outcome_signals`, `purge_events`. Cutoffs are
age-based (`now − retention_days`) for most, TTL-based for `recap_cache` and
`outcome_signals`; `bg_processes` never deletes `running` rows. Retention is
configured under `[audit.retention]`. `gc` issues `DELETE`s only — it does NOT
`VACUUM` the SQLite file.

### `purge`

Filesystem-only project reset: remove everything under `<repoRoot>/.forja/`
(`AGENTIC_CLI.md §2.1.2`). Does NOT touch the global DB
(`~/.local/share/forja/sessions.db`), `~/.config/forja/**`, or the
`install_id` — so the project's historical sessions stay queryable. Two-phase:
bare invocation is a dry-run; `--force` writes an append-only `purge_events`
audit row to the global DB and THEN removes the tree.

| Flag | Effect |
|---|---|
| `--force` | Execute the removal (otherwise dry-run). |
| `--no-audit` | Skip the audit row (emergency escape hatch when the DB is unwritable). |
| `--json` | NDJSON report. |

Safeties: requires an init marker in `.forja/`, refuses to follow a symlinked
`.forja`, and defends against a mid-walk TOCTOU directory swap.

### `permission <verb>`

Audit-chain and permission-policy administration (`AUDIT.md`,
`SECURITY.md §7.3`). Accepts `--json` and `--reason <text>`. Verbs:

| Verb | Purpose |
|---|---|
| `verify` | Verify the `approvals_log` hash chain. |
| `rotate-chain` | Archive the current `approvals_log` segment and start a fresh chain. |
| `replay` | Replay decisions against the current/archived policy (`--without-classifier` to compare). |
| `diff` | Diff a decision against the resolved policy. |
| `inspect` | Inspect a recorded decision. |
| `grants` | List active grants. |
| `revoke` | Revoke a grant. |
| `policy-list` | List policy snapshots. |
| `policy-rollback` | Roll back to an archived policy snapshot. |
| `seal-now` / `seal-verify` | Seal the audit segment / verify a seal (e.g. S3 Object Lock). |
| `calibration-export` | Export the calibration dataset for outcome scoring. |

### `recap`

Render a deterministic recap of a session (see `docs/spec/RECAP.md`).

---

## REPL slash commands

Available inside the interactive REPL (`forja` with no prompt). Type `/help` to
list them live.

| Command | Effect |
|---|---|
| `/help` | Show all slash commands. |
| `/quit` | Exit the REPL cleanly. |
| `/clear` | Clear the visible scrollback (preserves the session). |
| `/compact` | Compact the live conversation now to free context (in-memory only). |
| `/cost` | Show cumulative cost / steps / turns for this REPL session. |
| `/stats` | Show cost + token/cache totals for this session (incl. subagents). |
| `/sessions` | List recent sessions in this directory. |
| `/recap` | Projected view over this session (or another by id). |
| `/model` | Show or switch the active model. |
| `/budget` | Show or set budget caps. |
| `/effort` | Show or set the reasoning + operational effort level. |
| `/perms` | Show the active permission policy (or `/perms why <tool> [args]` for a dry-check). |
| `/memory` | Manage cross-session memories — list, show, audit, governance, delete/quarantine/restore, promote/demote, trust, seeds. |
| `/history` | Manage REPL input history (list / clear / off / on). |
| `/hooks` | Inspect loaded hooks and recent runs. |
| `/subagents` | List async subagent handles in this session. |
| `/skill` | Manage skills — list, show, new, promote, demote, delete. |
| `/agent` | Manage adaptation policies + inspect retrieval (subnamespaces: `policy`, `retrieval`). |

---

## Playbooks

Playbooks are pre-defined subagents — a name, a system prompt, a narrowed tool
whitelist, a budget, and a structured output schema. `forja init` writes the
bundled set into `<cwd>/.forja/playbooks/` (each a Markdown file with YAML
frontmatter), alongside any user-authored ones. They run as subagents: the model
spawns one via the task tools (`subagent: <name>`), or the operator invokes the
slash alias in the REPL.

| Playbook | Slash | Tools | Isolation | Budget |
|---|---|---|---|---|
| `code-review` | `/review` | `read_file`, `grep`, `glob`, `git` | none | 45 steps / $2.50 |
| `general-purpose` | `/explore` | `read_file`, `grep`, `glob`, `git`, `retrieve_context`, `memory_read` | none | 40 steps / $1.50 |
| `perf-investigate` | `/perf` | `read_file`, `grep`, `glob`, `bash`, `bash_background`, `bash_output`, `bash_kill` | worktree | 30 steps / $2.00 |
| `security-audit` | `/audit` | `read_file`, `grep`, `glob`, `git` | none | 40 steps / $2.50 |

- `code-review` and `security-audit` are read-only (a quality / threat gate that
  reports findings, never edits); `git` is for the diff and history.
- `general-purpose` is the read-only explorer; it adds `retrieve_context` +
  `memory_read` to pull context but has no write tools.
- `perf-investigate` is the only one with `bash`, and even there it is restricted
  to a profiler/benchmark allowlist (`time`, `hyperfine`, `node --prof`,
  `py-spy`, `perf`, `flamegraph`, `*bench*`, plus read-only inspectors like `ps`,
  `free -h`, `cat /proc/*`) and runs in an isolated worktree.

The bundled files are editable after `init` — tune tools/budget or add your own
(see `docs/spec/PLAYBOOKS.md`).

### Running a playbook on a specific model

By default a playbook's subagent runs on the **session model** (whatever the
parent run uses). To pin a playbook to a different model, add a `model` line to
its frontmatter — a catalog id, the same form `--model` accepts:

```yaml
---
name: code-review
description: Reviews changes and reports findings.
model: anthropic/claude-opus-4-8   # omit to inherit the session model
tools: [read_file, grep, glob, git]
budget:
  max_steps: 45
  max_cost_usd: 2.50
---
```

- The id must exist in your model catalog (`forja init` seeds it; `--model`
  reads the same list). Cross-provider is fine — e.g. an Anthropic session can
  route `code-review` to `openai/gpt-4o`, as long as that provider's credential
  (its `api_key_env`) is set.
- Resolution is **fail-soft**: an unknown id or an uninstantiable provider
  (missing credential) refuses the spawn with a clear
  `subagent.playbook_model_unavailable` error before any work runs — it never
  silently falls back to another model.
- It is a **static, per-playbook** choice, not orchestration: no dynamic model
  selection or routing. The child records its own model on its session, so
  `--list-sessions --include-subagents` shows which model actually ran.

### Built-in subagents

Internal to the memory-governance substrate — not operator-invocable; they run
automatically when memories are written/verified. Tool surface is kept minimal so
a `tools[]` regression fails loud at permission preflight:

| Subagent | Tools | Role |
|---|---|---|
| `verify-semantic` | `read_file`, `grep`, `glob`, `memory_read` | Fact-check a memory against the current repo. |
| `verify-conflict` | `memory_read` | Judge whether two memories contradict. |
| `verify-override` | *(none)* | Judge whether a memory drove operator overrides. |

---

## Maintenance & cleanup summary

What each surface reclaims, and what cleans up on its own.

| Surface | Removes | Trigger |
|---|---|---|
| `forja gc` | Aged rows in 11 audit/cache tables | Manual (two-phase) |
| `forja purge` | The whole project `.forja/` dir | Manual (two-phase) |
| `forja cache clear` | `~/.cache/forja/cache/` build/dep caches | Manual (two-phase) |
| `forja --worktrees gc` | Orphan/clean subagent worktrees + `agent/*` branches | Manual (two-phase) |
| `forja --checkpoints purge` | Checkpoint rows + session refs | Manual |
| Checkpoint retention | Checkpoints older than `agent.checkpoints.retentionDays` (default 30d) | Auto — lazy at run start |
| Audit gc-on-stop | Same tables as `forja gc` | Auto — only when `[audit.retention].runGcOnStop = true` |
| `recap_cache` TTL | Expired cache rows (default 1h) | Auto — on read |
| Background log cap | Head of a bg log past 50 MB/stream (tail kept) | Auto — during execution |
| Session sandbox `/tmp` | `~/.cache/forja/tmp/sessions/<id>` | Auto — on process exit |
| Subagent bg dir / worktree | Per-subagent logs + clean worktrees | Auto — at subagent run end |

Notes:

- There is **no `VACUUM`/compact of SQLite** anywhere — `gc`/`purge`/checkpoint
  purge only `DELETE`/`rm`; freed space stays as free pages in the DB/WAL.
- Some tables have **no sweep** and grow unbounded: `sessions`, `messages`,
  `tool_calls`, `subagent_runs`, and `approvals_log` (hash-chained — it needs a
  rotation-aware sweep before it can enter `gc`; use `permission rotate-chain`).

---

## On-disk state

Where the binary keeps state (all paths shift to `forja-<name>` under
`--profile <name>`):

| Path | Contents |
|---|---|
| `~/.local/share/forja/sessions.db` (+ `-wal`, `-shm`) | Global DB: sessions, messages, audit, checkpoints, subagents, memory. `chmod 0600`. |
| `~/.config/forja/**` | User-layer config + memory. |
| `~/.local/share/forja/install_id` | Install identity; audit-chain genesis. |
| `<repo>/.forja/` | Project bundle from `init`: `permissions.yaml`, `config.toml`, `agents/`, `skills/`, plus `bg/` background logs. |
| `~/.cache/forja/worktrees/` | Subagent git worktrees (isolation mode). |
| `~/.cache/forja/cache/` | Persistent sandbox build/dep caches. |
| `~/.cache/forja/tmp/sessions/<id>` | Per-session sandbox `/tmp` bind (removed on exit). |

---

## Environment

| Variable | Effect |
|---|---|
| `FORJA_PROFILE` | Same as `--profile` (the flag wins if both are set). |
| `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` | Relocate the data / config / cache roots above. |

Provider credentials are read from the provider's conventional env var (e.g.
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_API_KEY`); the binary does not
read a `.env` file.

---

## See also

- `docs/spec/AGENTIC_CLI.md` — architectural spec (operator surface in §2.1).
- `docs/CHECKPOINT.md` — checkpoint / undo model.
- `docs/AUDIT.md` — audit chain, retention, sealing.
- `docs/SECURITY.md` — trust, sandbox, permission policy.
- `docs/MEMORY.md` — cross-session memory and seed pack.
- `docs/spec/PLAYBOOKS.md` — playbook (subagent) definitions and distribution.
- `docs/spec/RECAP.md` — recap rendering.
- `docs/TOOLS.md` — the in-session tool surface (distinct from these CLI commands).
