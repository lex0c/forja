# Forja Memory Operator Guide

This document describes Forja's cross-session memory subsystem: what gets persisted, where it lives on disk, the state machine that governs lifecycle, the slash commands operators use day-to-day, and the integration points with hooks + the eviction substrate.

The canonical specification lives in `docs/spec/MEMORY.md` (PT-BR) with cross-cuts in `docs/spec/EVICTION.md` (state machine + tombstones) and `docs/spec/AUDIT.md` (event tables). This document is the English-language operational reference; when the two diverge, the spec wins.

---

## 1. What memory is for

Memory is the agent's curated set of **non-derivable facts** that need to survive between sessions. It is markdown-based, user-auditable, scope-isolated, and behind explicit write confirmation — built around the spec premise:

> **Done badly, memory makes the agent worse. Done well, it's what separates "API wrapper" from "agent that knows you."**

What memory **is**:

- User profile facts (role, tooling, preferences).
- Feedback the operator gave once and shouldn't have to repeat (rules + the **why** behind them).
- Project state with a multi-week horizon (deadlines, motivations, scoped decisions).
- References to where context lives in external systems (Linear projects, dashboards, runbooks).

What memory **is not**:

- A semantic search cache. Not a vector DB. Forja stores markdown + uses grep / index lookup — embeddings would be over-engineering at the scale operators actually use (dozens of entries, not millions).
- A session log. Ephemeral state ("debugging X right now") is session-scoped and doesn't promote to memory.
- A code-derived knowledge base. If `git log` / `git blame` / reading the source answers it, memory shouldn't.

The full list of anti-patterns lives in `docs/spec/MEMORY.md §10–§11`.

### 1.1 Architecture at a glance

The subsystem is split into modules whose responsibilities don't overlap. Storage lives in `src/storage/`; everything else under `src/memory/` is pure logic over the registry + repos.

```
                          ┌──────────────────────────────────┐
                          │  src/memory/registry.ts          │
                          │  - in-memory index per scope     │
                          │  - reload() rebuilds from disk   │
                          │  - list() / peek() / read()      │
                          │  - write() routes through writer │
                          └────────────┬─────────────────────┘
                                       │
   ┌──────────────────────┬────────────┼────────────┬──────────────────────┐
   │                      │            │            │                      │
   ▼                      ▼            ▼            ▼                      ▼
loader.ts            writer.ts   scanner.ts   lifecycle.ts          governance.ts
boot                 file-level  injection/   boot+periodic         apply gate
eager-load           atomic      secrets/     sweeps (expiry,        for proposal
+ frontmatter        rename;     promotion    tombstone purge,       substrate
parsing              upsert      heuristics   provenance retention,
                     index entry              governance TTL)
                                                   │
                            ┌──────────────────────┴──────────────────────┐
                            │                                             │
                            ▼                                             ▼
                  transitions.ts                              triggers.ts
                  state-machine wrapper:                      trigger-based
                  protection gates +                          eager load
                  eviction_events pair
                  + memory_events pair

                  ┌────────────────────────────────────────────────────────┐
                  │  LLM-judge detectors (default ON; opt-out via §11.4)   │
                  │                                                         │
                  │  verify-semantic-scheduler.ts ──┐                       │
                  │     polls memory_provenance     │                       │
                  │     at step boundary            │   dispatchers spawn   │
                  │                                 ├──▶ verify-semantic    │
                  │  verify-conflict-scheduler.ts ──┤    + verify-conflict  │
                  │     polls memory_events         │    built-in subagents │
                  │     for just-written entries    │   (isolated runs,     │
                  │     + BM25 prefilter            │    read-only, JSON    │
                  │                                 │    schema output)     │
                  │  conflict-resolver.ts ──────────┘                       │
                  │     deterministic tier chain                            │
                  │     (provenance > recency > scope >                     │
                  │      body_length > lexicographic)                       │
                  └────────────────────────────────────────────────────────┘
```

Storage (`src/storage/`):

| Table | Migration | Purpose |
|---|---|---|
| `memory_events` | 040 + 048 | Append-only operator-facing action log (`created`/`refused`/`read`/`promoted`/…) |
| `eviction_events` | 046 + 047 | Append-only state-machine transition log (cross-substrate; `substrate='memory'`) |
| `memory_provenance` | 054 | Append-only exposure trail — every moment a memory was visible to the model |
| `memory_governance_proposals` | 056 | Mutable-status (`pending`→`applied/rejected/expired`) detector → operator queue |
| `memory_verify_attempts` | 057 | Content-hashed dedup cache for S11 verify-semantic (7d window for passed/inconclusive) |
| `memory_conflict_attempts` | 061 | Pair-keyed dedup cache for S13 verify-conflict |

Integration points (the only three surfaces outside `src/memory/` that touch the subsystem):

1. **Bootstrap** (`src/cli/bootstrap.ts`) — wires the registry, runs `evaluateBootTriggers`, fires the trust probe, schedules the boot sweeps, builds the eager-load section for the system prompt.
2. **Harness loop** (`src/harness/loop.ts`) — on each step boundary, ticks the verify-semantic + verify-conflict schedulers if enabled. The schedulers are the *only* path that runs LLM-judge spawn during normal session work.
3. **Retrieval pipeline** (`src/retrieval/views/memory.ts`) — builds a BM25 corpus over registry listings for the `retrieve_context` tool's memory view; honors the same scope-exclude + state filter the eager-load uses.

Boot order (top-level operator run, not subagent):

```
1. preflight policy engine (permissions)
2. open SQLite + run migrations
3. registry construction (createMemoryRegistry; reload() walks scopes)
4. lifecycle sweeps:
     gcExpiredMemories          — quarantine past-date entries
     gcPurgeExpiredTombstones   — drop tombstones past retention window
     gcStaleInvalidatedMemories — evict invalidated entries past stale window
     pruneMemoryProvenance      — drop provenance rows older than 90d
     expirePendingProposals     — flip governance proposals past 30d to `expired`
     pruneVerifyAttempts        — drop S11 verify-semantic attempts past 90d
     pruneConflictAttempts      — drop S13 verify-conflict attempts past 90d
     pruneOverrideEvents        — drop S3 override-event signals past 90d
     pruneOverrideAttempts      — drop S3 verify-override attempts past 90d
5. trust probe — verifies the project_shared hash against the operator's
   last-confirmed value; revocation cascades active shared memories to
   `invalidated` and excludes the scope from eager-load this session
6. evaluateBootTriggers(repoRoot) — builds BootContext (cwd files, first
   prompt content) so trigger-based eager-loads can match
7. assembleMemorySection(registry, bootContext, excludeScopes) — produces
   the index lines + trigger-loaded bodies that land in the system prompt
8. eager-exposure emit — one memory_provenance row per assembled memory
9. wire harness:
     HarnessConfig.memorySemanticVerify  + memoryConflictDetect (resolved
     via the precedence chain in §11.4) gate scheduler creation
10. governance banner — first-run stderr line when both detectors land
    default ON, suppressed by --json / marker / explicit config touch
```

Runtime flow (per harness step):

```
loop iteration N
├── send messages + tools to provider
├── consume provider response
├── invoke tool calls → returns results
├── step-boundary tick:
│     ├── verify-semantic-scheduler.tick(stepNumber)
│     │     polls memory_provenance for exposures since cursor;
│     │     dispatches one verify-semantic subagent if a candidate
│     │     passes all pre-flight gates
│     └── verify-conflict-scheduler.tick(stepNumber)
│           polls memory_events for `created`/`edited` rows since
│           cursor; BM25-prefilters top-K=5 same-scope siblings;
│           dispatches one verify-conflict subagent per just-written
│           memory
└── (eventually) operator decides on any landed proposals via
    /memory governance approve | reject — apply path runs the five
    gates and delegates to transitionMemoryState
```

Subagents are isolated child runs (separate session id, no parent state leak; see `docs/spec/IPC.md`) — the LLM-judge verdicts come back as a structured payload, never as in-band prose that could influence the parent's reasoning.

The three step-boundary schedulers are **suppressed entirely in plan mode** (`--plan`). Plan mode declares a read-only session; LLM-judge dispatches write `memory_*_attempts` rows and (on negative verdicts) governance proposals — both governance-substrate writes that contradict the operator's framing. The schedulers never get constructed, no `poll()` runs, and the operator sees a single stderr line per enabled-but-suppressed detector (`memory: verify_*_disabled: plan mode active`). Detectors resume on the next non-plan run.

System prompt header: the `# Memory` block (save-criteria, 4-type taxonomy, DO-NOT-save list, verify-before-act rule — see `src/cli/memory-prompt.ts:MEMORY_SECTION_HEADER`) **always renders when the memory subsystem is wired**, even on fresh repos with zero memories. The bullet list of memory inventory is what differs between empty + populated states; the guidance copy is unconditional so the model gets save criteria exactly when it's most likely to propose a bad inferred save (no precedent to imitate).

---

## 2. Disk layout

Three scope roots, each with the same internal structure:

```
~/.config/agent/memory/                  ← user scope (global, all sessions)
  MEMORY.md                              # one-line index
  user_role.md                           # entries
  feedback_commit_style.md
  reference_linear_ingest.md
  .tombstones/                           # evicted entries within retention window
    feedback_commit_style.1714138800.md

<repo>/.agent/memory/shared/             ← project shared (versioned in git)
  MEMORY.md
  project_q3_milestone.md
  feedback_team_conventions.md
  .tombstones/                           # versioned — restore via git checkout

<repo>/.agent/memory/local/              ← project local (gitignored, per-user)
  MEMORY.md
  feedback_my_quirks.md
  project_in_progress.md
  .tombstones/                           # gitignored
```

The `shared` vs `local` split is intentional:

- **`shared/`** is curated via PR (team review is the quality gate); onboarding via `git clone` brings context along; tombstones survive in git history.
- **`local/`** is per-user, never committed; inferred memories default here so they can't accidentally land in a team-wide commit; the trust boundary stays local until the operator explicitly promotes.

The `.gitignore` ensuring `local/` stays out of git is auto-generated by `ensureAgentGitignore` on first contact with a repo (see `src/memory/gitignore.ts`). Operators can edit it freely; Forja never overwrites after the initial creation.

Resolution order at lookup time (most-specific → most-general):

1. Project local (`.agent/memory/local/`)
2. Project shared (`.agent/memory/shared/`)
3. User (`~/.config/agent/memory/`)

A `local` entry with the same name overrides `shared` and `user`. The `MemoryRegistry.list()` API exposes a `deduplicateByName` flag so operator-facing counts reflect the post-override view.

---

## 3. File shape

Every memory is a markdown file with YAML frontmatter:

```markdown
---
name: commit-verb-casing
description: Title Case in commit verbs, never ALL CAPS
type: feedback
source: user_explicit
expires: 2026-12-31           # optional; ISO date
trust: trusted                # optional; default trusted
state: active                 # optional; default active
---

In the `forja` repo, use "Create"/"Update"/"Delete" (Title Case).
Never `CREATE` or `create`.

**Why:** repo convention, visible in `git log` since inception.

**How to apply:** when proposing a commit message, generate
`Create FOO.md, BAR.md` — not `feat: add foo`, not `CREATED foo.md`.
```

### 3.1 Frontmatter fields

| Field | Required | Domain | Notes |
|---|---|---|---|
| `name` | Yes | kebab-case, unique within the scope | Validated by `validateName`; collides land as `target_exists` rejection |
| `description` | Yes | one-line | Renders in the per-scope index |
| `type` | Yes | `user` \| `feedback` \| `project` \| `reference` | See §3.2 |
| `source` | Yes | `user_explicit` \| `inferred` \| `imported` | Drives the inferred-write gate (§5.2) |
| `expires` | No | `YYYY-MM-DD` | Boot GC removes expired entries (§6.1) |
| `trust` | No | `trusted` \| `untrusted` (default `trusted`) | `untrusted` entries don't auto-load (§7.2) |
| `state` | No | one of seven `MEMORY_STATES` (default `active`) | Lifecycle state, see §4 |

`MEMORY_STATES` is exported from `src/memory/types.ts`:

```
proposed | active | quarantined | invalidated | evicted | purged
```

(`shadow` is in the eviction substrate enum but memory deliberately doesn't use it — `trust: untrusted` covers the same operational case.)

### 3.2 Type semantics

Each type has a documented motivation; mixed-purpose entries are a smell:

- **`user`** — facts about who the operator is. Loaded most aggressively because they shape every response.
- **`feedback`** — corrections **and** validations the operator gave once. Body must include `**Why:**` and `**How to apply:**` lines so the rule can be applied to edge cases without re-asking.
- **`project`** — state-of-the-work with a multi-week horizon. Decays fast — operators should pair with an `expires` date. Inferred project memories get a `+90d` default expiry.
- **`reference`** — pointers to external systems. Doesn't duplicate the linked content.

`type` is purely operator-visible vocabulary today — Forja doesn't gate loading or scoring on it. The category exists so memories are self-documenting and the operator can scan the index by intent.

---

## 4. Lifecycle state machine

Memory inherits the seven-state machine from `EVICTION.md §3` as a subset (no `shadow`). State is stored in the file's frontmatter; transitions are owned by `transitionMemoryState` in `src/memory/transitions.ts`.

| State | Visible to model? | In index? | Tombstoned? |
|---|---|---|---|
| `proposed` | No | No | No — body file lives in scope root |
| `active` *(default)* | Yes | Yes | No |
| `quarantined` | Yes (flagged) | Yes (with penalty) | No |
| `invalidated` | No | No | No |
| `evicted` | No | No | Yes (in `<scope>/.tombstones/`) |
| `purged` | No | No | No — metadata only in `eviction_events` |

The state machine's full legal-transition table lives in `EVICTION.md §4.1`; `isLegalTransition` in `src/storage/repos/eviction-events.ts` enforces it at the data layer. Common paths memory exercises:

- `proposed → active` — admission gate passes (write confirmation accepted).
- `active → quarantined` — `verify-before-act` failure, 3× operator override in 24h, or detected conflict. TTL of 7d before any terminal transition.
- `quarantined → active` — operator restored confidence, or new evidence cleared the trigger.
- `quarantined → evicted` — quarantine TTL expired, or loop-frio confirmed `low_roi`, or operator called `/memory delete`.
- `evicted → purged` — retention window (default 30d) expired during the boot GC sweep.
- `evicted → proposed` — `/memory restore` re-admits via the normal confirmation flow (not a bypass).
- `* → purged` — operator forced `--purge` with `user_purge` motivo, or a `security` motivo bypassed retention.

Every transition emits a paired audit row: `memory_events` (local action) + `eviction_events` (cross-substrate). The pair shares `eviction_event_id` in `memory_events.details` for JOIN.

### 4.1 Protection gates

Some transitions are refused before the state machine even runs (`src/memory/transitions.ts` calls `checkProtectionGates`):

- **`user_explicit` cooldown** — a `user_explicit` write is protected for 72h after creation from `loop_cold` / `compaction` actors. Rationale: the operator made an explicit choice; the system shouldn't auto-evict it the next time the loop frio runs. `actor: 'user'` bypasses (`user → user` is consented re-evaluation).
- **Quarantine minimum TTL** — once a memory enters `quarantined`, it stays at least 7d in that state. Loop frio can't fast-evict; operator can override with explicit `/memory delete`.

Refused transitions write a `blocked_by_protection` row to `eviction_events` (the trigger fired but the state didn't move). Spec reference: `EVICTION.md §6.2`.

### 4.2 Eviction hook

When `transitionMemoryState` is wired with a `fireHook` callback, the `Eviction` hook fires after the protection gate passes and before the file/index/audit triple writes. The hook can block (`blocked_by_hook` row lands; state stays put) or allow. See `docs/HOOKS.md` for the hook contract.

The protection gate is structural (math + audit history); the hook is operator-policy. Both can refuse a transition, both produce structured refusal rows distinct from `applied`.

---

## 5. Writing

### 5.1 The write pipeline

`writeMemory` (`src/memory/writer.ts`) is the file-level primitive. It:

1. Validates the frontmatter shape (`validateFrontmatter`).
2. Scans the body for injection patterns and secrets (`scanForInjection`, `scanForSecrets`; §7).
3. Resolves the target path inside the sandboxed scope root (`memoryFilePath`).
4. Refuses path-traversal attempts (`ScopeError` — fatal + audit).
5. Writes the file atomically (rename-after-write).
6. Updates the per-scope `MEMORY.md` index entry.

It is **not** the operator's entry point — `MemoryRegistry.write` (`src/memory/registry.ts`) wraps it with audit emission, source tracking, and the confirmation seam (`confirmMemoryWrite` callback supplied by the REPL).

### 5.2 Source tracking

Every memory carries a `source` field. The three values gate differently:

- **`user_explicit`** — operator typed `/memory save` or accepted a TUI proposal. No extra friction.
- **`inferred`** — model decided to save during a normal turn. Extra confirmation copy in the prompt; auto-disabled in untrusted directories (`§7.2`); subject to a stricter heuristic scan.
- **`imported`** — bulk import from another tool / scope. Each entry is treated as `inferred`-equivalent for trust purposes until operator confirms.

### 5.3 Audit pair

Writes produce two rows:

```sql
-- src/storage/repos/memory-events.ts
memory_events(
  id, scope, action, memory_name, source,
  session_id, cwd, created_at, details
)

-- src/storage/repos/eviction-events.ts (only on state transitions)
eviction_events(
  id, substrate='memory', object_id=memory_name, object_scope,
  from_state, to_state, trigger, motivo, evidence_json,
  outcome, blocked_by, actor, session_id, dependents_json,
  recorded_at, purge_at
)
```

`memory_events.action` covers operator-facing verbs (`proposed`, `created`, `edited`, `deleted`, `read`, `refused`, `promoted`, `demoted`, `quarantined`, `invalidated`, `evicted`, `restored`, `purged`). `eviction_events.outcome` covers cross-substrate semantics (`applied`, `trigger_fired_no_action`, `blocked_by_protection`, `blocked_by_hook`).

The body content **never** lands in SQLite — files own content, SQLite owns events. This keeps the storage cost bounded and the audit table fast.

---

## 6. Slash commands

The full operator surface ships via `/memory <subcommand>` (`src/cli/slash/commands/memory.ts`). All read-only subcommands stream their output as `notes` lines through the REPL.

| Command | What it does |
|---|---|
| `/memory` | One-line summary: total active memories per scope. |
| `/memory list [scope]` | Index dump (no body) for `user` / `shared` / `local` / all. Renders state + expires for each entry: `[QUARANTINED]` / `[INVALIDATED]` / `[PROPOSED]` / `[EXPIRED <date>]` prefix flags; `(expires <date>)` suffix on active entries with a future expiry; `[ORPHAN]` / `[MALFORMED]` markers for unreadable rows. |
| `/memory show <name>` | Print the full body of a memory. |
| `/memory audit [--trigger <source>] [--name <n>] [--all] [--limit N]` | Tail of `memory_events`. `--trigger` accepts a literal value (e.g. `operator_driven`, `verify_failed`) or one of the semantic shortcuts: `operator` matches `operator_driven`; `detector` matches the 4 auto-detector triggers (`verify_failed`, `user_override_repeated`, `conflict_detected`, `trust_revoked`). |
| `/memory metrics [--days N]` | Aggregated eviction pipeline metrics over the window — motivo distribution, restore rate, quarantine dwell, protection / hook block counts. Window default 30d. |
| `/memory delete <name>` | Routes through `transitionMemoryState` (active → quarantined → evicted depending on current state). Asks for confirmation. |
| `/memory quarantine <name> --motivo <kind> [--evidence "…"] [--scope <s>]` | Operator-driven `active → quarantined`. Motivo allow-list: `conflict`, `shift`, `security`, `low_roi`, `irrelevant`. Audit row lands with `trigger: operator_driven` so forensic queries can split manual transitions from the auto-detector triggers (`docs/TODO.md` Slices 2-5). |
| `/memory restore <name>` | `evicted → proposed` from the latest tombstone. Operator passes the normal admission gate. |
| `/memory promote shared <name>` | `local → shared`. Runs the extra promotion scanner (secrets + injection heuristics + 200-line body cap). Creates a `git status` change; does **not** auto-commit. |
| `/memory demote local <name>` | `shared → local`. Inverse of promote. No extra scanner (going to less-trusted scope). |

Two subcommands listed in the spec are deferred behind explicit follow-up work: `/memory edit` (shells out to `$EDITOR`) and `/memory save` (operator-driven write). Today operators edit files directly; the registry layer notices the change on next list and updates the index.

### 6.1 Confirmation contract

Mutating subcommands honor "no auto-commit" and "no silent destructive ops":

- Promotion / demotion creates a working-tree change. The operator runs `git add` + `git commit` themselves; PR review remains the team-level gate for `shared` content.
- Delete / purge surfaces a confirmation prompt before the file moves to `.tombstones/` (or is unlinked). Forced purge requires `--force` and writes a `motivo: user_purge` row.

---

## 7. Operator workflows

Four scenarios that exercise the surface end-to-end. The commands assume an interactive REPL; the headless posture (§10) refuses the mutating steps unless the operator opts in.

### 7.1 Propose a project-local memory and promote it team-wide

Use case: the operator just told the agent a non-obvious rule about the repo (e.g., "in this codebase, all SQL is raw — no ORM"). The agent inferred a `feedback` memory and the operator accepted it into `local/`. Later the operator decides the rule is team-relevant.

```bash
# Inspect what's in local/ before promoting.
$ /memory list local
- [No ORM rule](feedback_no_orm.md) — raw SQL only, no ORM in this repo
- [My quirks](feedback_my_quirks.md) — personal preferences inside this project

# Read the full body before sharing.
$ /memory show no_orm
---
name: no-orm
description: raw SQL only, no ORM in this repo
type: feedback
source: inferred
---
In `src/db/**`, use raw SQL through `bun:sqlite`. Never introduce
an ORM dependency.

**Why:** prior team incident — ORM lock-in cost a quarter of cleanup.
**How to apply:** when adding a query, write SQL directly + types.

# Promote — the extra scanner runs (secrets / injection / 200-line cap).
# A working-tree change lands; no auto-commit.
$ /memory promote shared no_orm
moved: .agent/memory/local/feedback_no_orm.md
   →  .agent/memory/shared/feedback_no_orm.md
indexes updated (local removed, shared upserted)
git status:
  D  .agent/memory/local/feedback_no_orm.md
  A  .agent/memory/shared/feedback_no_orm.md
  M  .agent/memory/local/MEMORY.md
  M  .agent/memory/shared/MEMORY.md

(commit when ready; PR review is the team-level gate)
```

The `memory_events` table records `action: 'promoted'` with `details.from_scope=local, to_scope=shared`. Reviewers on the PR see the new memory file in the diff alongside the index changes.

### 7.2 Restore an evicted memory within the retention window

Use case: the operator ran `/memory delete` on the wrong entry, or the boot expiry sweep removed something they still wanted. Within 30d (user / project) the body still lives in `<scope>/.tombstones/` and `/memory restore` re-admits it.

```bash
# Confirm the tombstone is still in the window.
$ /memory audit --filter evicted
[2026-05-14 09:32] action=evicted   name=q3-deadline   scope=project_local
  motivo=user_purge  eviction_event_id=ev-7f8a...  purge_at=2026-06-13

# Restore — body comes back, but lands as `proposed`, not `active`.
$ /memory restore q3-deadline
restored from .tombstones/q3-deadline.1715680320.md
state: proposed (re-admission gate; confirm to activate)

# Confirm. The TUI re-runs the write confirmation flow.
📝 Re-admit memory [project · local]

  name:    q3-deadline
  type:    project
  source:  user_explicit
  body:    (preview)

[a]ccept  [e]dit  [r]eject  [w]hy?

# After accepting: state advances proposed → active, audit pair lands.
```

The restore deliberately does not bypass the admission gate — the condition that caused the original eviction may still apply, so the operator passes the same confirmation as a fresh write. If the tombstone is past the retention window, `/memory restore` reports the file is gone and points at the `eviction_events` metadata that survived; in the project shared scope, the operator can still run `git checkout <commit> -- <tombstone_path>` to recover from history.

### 7.3 Investigate why memories are getting evicted

Use case: a few weeks into using the agent on a repo, the operator notices memories they wrote keep disappearing. The metrics aggregator reports the eviction pipeline's activity in one view.

```bash
# 30-day window (default).
$ /memory metrics
memory eviction metrics — last 30d

transitions applied:  47
  by motivo:
    user_purge   18  (38.3%)
    low_roi      14  (29.8%)
    expired       9  (19.1%)
    conflict      4  ( 8.5%)
    shift         2  ( 4.3%)
  by from_state:
    active       21
    quarantined  19
    evicted       7

probe activity (trigger_fired_no_action): 312
  most frequent triggers:
    roi_below_threshold   208
    verify_failed          73
    user_override_repeated 31

blocked transitions: 23
  by guard:
    user_explicit_cooldown  17
    quarantine_min_ttl       6

restore rate (evicted → proposed within window): 4 / 7 (57%)
quarantine dwell (avg before terminal): 11.3d
purge bypasses (user_purge --force):      3
```

Interpretation: the `restore rate` of 57% is high — operator is regretting evictions often. Worth tightening the loop frio's `low_roi` threshold OR reviewing the `verify_failed` trigger (73 probe hits suggests the verify-before-act check is firing more than it should). `quarantine_min_ttl` blocking 6 transitions confirms the protection gate is doing its job.

Drill down on a specific motivo via `sqlite3` directly:

```bash
$ sqlite3 ~/.local/share/forja/audit.db \
    "SELECT recorded_at, object_id, trigger, evidence_json
       FROM eviction_events
      WHERE substrate='memory' AND motivo='low_roi' AND outcome='applied'
      ORDER BY recorded_at DESC LIMIT 10;"
```

### 7.4 First contact with a new repo

Use case: operator runs the agent in a fresh clone for the first time. Memory needs a `.gitignore` to keep `local/` out of git, and the user-scope memories load by default.

```bash
$ forja
[boot] user memory: 4 entries loaded from ~/.config/agent/memory/
[boot] project memory: 0 entries (no .agent/memory/ found)
[boot] trust prompt: cwd /home/operator/new-repo is untrusted; inferred
       memory writes disabled this session
       → [t]rust  [s]kip  [w]hy?

> t
[boot] cwd added to trust list

> /memory save "in this repo, all docs are in docs/spec/ in PT-BR"
📝 Propose new memory [feedback / project · local]

  name:    docs-pt-br
  type:    feedback
  source:  user_explicit
  destino: ./.agent/memory/local/feedback_docs_pt_br.md
  body:    In docs/spec/ all files are PT-BR.
           **Why:** architect's authored material in native language.
           **How to apply:** translate to EN only on explicit request.

[a]ccept  [e]dit  [r]eject  [w]hy?

> a
[memory] feedback_docs_pt_br.md written to .agent/memory/local/
[memory] index updated: .agent/memory/local/MEMORY.md
[gitignore] generated .agent/.gitignore (sessions.db, traces/, memory/local/, ...)
```

The `.agent/.gitignore` is written **once**, on first contact. Subsequent runs preserve any operator edits. Spec reference: `MEMORY.md §2.5`.

---

## 8. Trust and injection

The primary attack vector is a malicious `AGENTS.md` in a cloned third-party repo nudging the agent to write a poisoned `inferred` memory. **No single mechanism is "the defense."** The system layers several weak-on-their-own filters so an attacker has to defeat ALL of them to land an injection. Removing one filter doesn't open the attack; removing two probably does. Spec MEMORY.md §13.1 calls this posture "layered, not sequential" — it's the only honest way to write security for an LLM-driven memory subsystem.

### 8.1 Scanner — tripwire, not defense

`src/memory/scanner.ts` exports four primitives. **Two of them are honest, two are tripwires.** Frame them accordingly.

**Honest (shape-stable, language-agnostic):**

- **`scanForSecrets(body)`** — credential-shape regexes (AWS `AKIA…`, GitHub `ghp_…` / `github_pat_…`, Anthropic `sk-ant-…`, OpenAI `sk-…40+`, Slack `xox[baprs]-…`). High-entropy prefixes mean false-positive rate is low; a credential matches the same way regardless of surrounding prose. Hard block.
- **`redactSecrets(body)`** — same patterns as above, applied at audit time so refused-write rows don't carry the secret they refused. Idempotent.

**Tripwires (limited reach, do NOT mistake for defense):**

- **`scanForInjection(body)`** — small list of English jailbreak phrases (`"ignore previous instructions"`, `"you are now"`, `"from now on, always"`, …). Hard block on match. **Burlable by:**
  - Any other language (`"ignore as instruções anteriores"`, `"忽略之前的指令"`, `"désormais, toujours"`, …).
  - Paraphrase (`"the new rule is"`, `"treat my prior message as void"`, `"your role going forward"`, …).
  - Structural injection (yaml/code-block/role-play wrappers, markdown mimicking system instructions, …).
  - An attacker with five minutes of effort.

  The list stays SHORT on purpose. Extending it with more English phrases doesn't move the threat needle; extending with translations climbs false-positive rate against legitimate operator notes (a memory documenting "the model failed when prompted with `ignore previous instructions`" is itself useful content).

  **What the tripwire actually buys:** (a) an audit row (`memory_events action=refused` with `details.reason='injection phrase: …'`) so the operator sees that something obviously hostile tried; (b) defense-in-depth — one of several layers below.

- **`scanForPromotion(body)`** — superset of `scanForInjection` plus a 200-line body cap and path-traversal patterns. Only runs on `/memory promote shared`. Same tripwire caveats apply to the injection-phrase piece; the line cap and path patterns are honest.

### 8.1.1 The load-bearing layers

A poisoned `inferred` memory write fails when ANY of these holds:

1. **Modal confirmation** (the actual gate). Every `inferred` write opens a TUI modal showing the proposed body to the operator. No keyboard approval, no write. The scanner runs BEFORE the modal only to avoid wasting a modal on obvious junk — the modal itself is the load-bearing decision.
2. **`source` attribution.** `inferred` (model decided to write) vs `user_explicit` (operator typed) is a structural distinction in the frontmatter. `inferred` writes face the modal; `user_explicit` skip it (you typed it, you meant it). Without this split there'd be no surface to gate.
3. **Trust boundary** (§8.2). Untrusted directory ⇒ `inferred` writes disabled for the session. The poisoned `AGENTS.md` is in an untrusted repo by default; even if the model parses its hostile instruction, the write tool refuses.
4. **Scope isolation.** Worst case the attack lands a `project_local` memory — confined to this repo. `shared` requires `/memory promote` + PR review; `user` requires explicit confirmation with extra warning.
5. **Eager-load filter.** Memories with `trust: untrusted` (set when the write happened in an untrusted state) NEVER enter the system prompt automatically. They surface only via `memory_read` tool calls — explicit, audit-logged.
6. **Audit chain.** `memory_events` is tombstone-chain-hashed (§5.3). Tampering is detectable.

The scanner is layer 0 — it filters obvious noise so the layers above face less traffic. It is NOT the answer to "how does Forja resist prompt injection in memories." The answer is the modal + the trust + the scopes + the chain.

### 8.2 Trust boundary

- A directory is **untrusted** by default until the operator confirms via the boot trust prompt (`AGENTIC_CLI §9`).
- In an untrusted directory, `inferred` writes are **disabled** for the session. Only `user_explicit` writes pass.
- A memory written in an untrusted state lands with `trust: untrusted` in its frontmatter. Such memories don't auto-load into the model context — only `memory_read`-style explicit retrieval surfaces them.
- The TUI marks `untrusted` entries with a visual flag so the operator sees what the model would see.
- Hash of the `shared/` directory is checked on boot; a changed hash (e.g., after a `git pull` that touched team memories) re-fires the trust prompt.

### 8.3 The `MemoryWrite` hook

The `MemoryWrite` event is blockable (exit code 2 stops the write; exit code 1 stops it silently). Enterprise hooks can force external audit:

```toml
[[hooks]]
event = "MemoryWrite"
matcher = { source = "inferred" }
command = "~/.config/agent/hooks/memory_audit.sh"
fail_closed = true
```

See `docs/HOOKS.md §2` for the payload shape.

---

## 9. Boot lifecycle

`src/memory/lifecycle.ts` owns the boot-time + periodic maintenance surface:

### 9.1 Expiry sweep

**`gcExpiredMemories(db, registry, roots, opts)`** — runs at `SessionStart`. Walks each scope, parses frontmatter, finds entries where `expires < today`, and routes them through `transitionMemoryState` (`active → quarantined`, then optionally `quarantined → evicted` based on configuration). The expired-memory scan is **not** auto-evict — operator confirmation is required when more than a small threshold lands at once.

The lifecycle module deliberately exposes a query helper too:

```ts
findExpiredMemories(db, roots, today): ExpiredMemory[]
```

so callers (e.g., REPL banner) can surface count without committing to the transition yet.

### 9.2 Tombstone purge

**`gcPurgeExpiredTombstones(db, registry, roots, opts)`** — sweeps `<scope>/.tombstones/` for files whose `purge_at` (recorded in `eviction_events`) is past `now()`. For each candidate row:

1. Validate the object scope.
2. Enter a `BEGIN IMMEDIATE` transaction.
3. Re-check that the candidate is still the latest `applied` eviction event for the object (defends against concurrent `/memory restore` between the candidate scan and the transition).
4. Call `transitionMemoryState` with `to: 'purged'` and the `expired` motivo.
5. Commit (or rollback on error).

The transactional bracket is the TOCTOU defense added in Phase 3.7c — without it, a concurrent restore could resurrect a tombstone the sweep was about to purge, producing audit drift.

Retention windows live in `EVICTION.md §7.1`:

| Sub-scope | Window |
|---|---|
| User | 30d |
| Project shared | 30d (but tombstones are git-versioned — restore via `git checkout` outside the window) |
| Project local | 30d (gitignored — outside the window is final) |
| Invalidated (any scope) | 7d |

### 9.3 Cascading dependents

When a memory enters `evicted` or `purged`, **other memories that reference it by name** can cascade. `detectMemoryDependents` (`src/memory/dependents.ts`) scans bodies for `[[name]]`-style cross-references and surfaces a list the operator can review. The dependent detector is conservative — surface, don't auto-act; cascade decisions stay manual (`EVICTION.md §6.4`).

### 9.4 Trigger-based eager load

`evaluateBootTriggers` (`src/memory/triggers.ts`) supports the `triggers:` frontmatter array. When a session starts in a directory matching a trigger (e.g., a `.env` file present, or the operator's first prompt mentions `git commit`), the corresponding memory is eager-loaded into context regardless of the index. Spec reference: `MEMORY.md §4.3`.

### 9.5 Session shutdown

The harness loop's outer `try/finally` (`src/harness/loop.ts:3858`) is the session-end cleanup hook. It fires on every exit path — clean turn return, soft-stop signal, operator Ctrl-C, uncaught exception — and runs the steps in this order:

1. **`semanticVerifyScheduler?.shutdown()`** (S11) — flips an internal `stopped` flag. Subsequent `poll()` calls no-op. An in-flight `dispatchSemanticVerify(...)` from the last step boundary was already awaited inside the loop body (each tick awaits its dispatch), so no LLM-judge spawn remains in flight here. Idempotent — safe to call when the scheduler was never created (the `?.` covers the disabled-detector case).
2. **`conflictDetectorScheduler?.shutdown()`** (S13) — same shape as S11.
3. **`overrideVerifyScheduler?.shutdown()`** (S3) — same shape.
4. **`await checkpointsPurgeInFlight`** — the lazy retention sweep for checkpoint blobs (kicked off during a step, runs on a detached Promise chain). The await is a synchronization point against `cli/run.ts` closing the SQLite handle right after `runAgent` returns; without it the purge would race against `db.close()` and hit a closed handle. The `.catch()` chain at construction already swallowed errors; the await here is purely a barrier.
5. **`await subagentHandleStore.drain('parent_drain')`** — cancels every still-running subagent record and awaits all promises (including the cancelled-before-dispatch synthesis). Uses `Promise.allSettled` internally so a hard parent abort still leaves children with a clean termination point. Errors are swallowed — drain failures must not mask the run result.
6. **`await bgManager.cleanup()`** — terminates background processes the session spawned via `bash --run-in-background`. Best-effort: cleanup failures don't escape the harness boundary. Zombies left behind stay visible via the `background_processes` audit table for forensic recovery.
7. **`todoStore.clear(sessionId)`** — defensive in today's ownership model (the store is a function-local `Map` on line ~125 of `runAgent`, so GC reclaims it on return). Kept as a forward-compat hook for a future daemon mode that hoists the store to a process-level singleton.

What deliberately does **not** happen at shutdown:

- **No `MemoryRegistry.close()`** — the registry is a plain object owning an in-memory entries map and a reference to the `db`. It has no resource to release; GC reclaims it when `runAgent` returns. The `db` handle is owned by `cli/run.ts` and closed there, after the finally block runs.
- **No `memory_events` finalization row** — the audit pair is per-action, not per-session. A session boundary is observable from outside via the gap in `messages.session_id`, not from a dedicated row.
- **No mid-tick scheduler abort** — schedulers don't dispatch from a setInterval; they tick on step boundaries and the await at the call site means a tick either completes or the loop never reached it. There's no half-flushed dispatch state to worry about.

What persists across the shutdown into the next session's boot:

- **Tombstones** in `<scope>/.tombstones/` — boot's `gcPurgeExpiredTombstones` is the only path that moves them to `purged`.
- **Pending governance proposals** in `memory_governance_proposals` — boot's `expirePendingProposals` is the only path that auto-expires them (30d TTL).
- **Provenance trail** in `memory_provenance` — boot's `pruneMemoryProvenance` enforces the 90d retention.
- **Detector dedup caches** (`memory_verify_attempts`, `memory_conflict_attempts`, `memory_verify_override_attempts`, `memory_override_events`) — each has a boot-time sweep with a 90d window (§1 step 4).
- **Scheduler cursors** are NOT persisted — each scheduler keeps its `(createdAt, id)` tuple in a closure variable that dies with the process. Next boot the cursor starts at `(0, 0)` (epoch), so the first poll re-considers every row in the source table. Dedup caches (`memory_verify_attempts` / `memory_conflict_attempts` / `memory_verify_override_attempts`) are the authority on "already processed" across sessions; the cursor is just an intra-session optimization that lets each subsequent tick poll only new rows. The first poll pays an O(table-size) scan on a small table — the windows are bounded by the 90d retention sweeps.

The shutdown sequence is intentionally non-reentrant: calling `shutdown()` twice is safe (each scheduler's `stopped` flag is sticky), but the surrounding promises are awaited in the `finally`, so a second `runAgent` invocation in the same process would need a fresh harness instance (today: `cli/run.ts` exits after `runAgent` returns, so reentrance isn't a path).

---

## 10. Headless mode

In `forja --json` (non-interactive), the default posture is **fail-closed**:

- `memory_write` to any scope: **refused**.
- `/memory promote` / `/memory demote`: refused.
- `/memory delete --force`: refused.

Operators can opt in with `--allow-memory-write=local` for CI flows that genuinely need it. The flag does **not** extend to `shared` — promoting team-wide memories from a headless context would defeat the PR-review gate.

---

## 11. Storage tables

Four tables, all in `src/storage/migrations/`:

- **`memory_events`** (migration 040 + 048) — append-only log of memory operator-visible actions. Row per action; `details` JSONB carries diff / motivo / hash references.
- **`eviction_events`** (migration 046, with hook-run tie-in at 047) — append-only log of cross-substrate eviction transitions. Memory shares the table with future substrates (policies, code-index entries, etc.); rows filter on `substrate='memory'`.
- **`memory_provenance`** (migration 054) — append-only exposure trail: every moment a memory's bytes were visible to the model. Row per `(session, memory, surface, moment)`. Details below in §11.2.
- **`memory_governance_proposals`** (migration 056) — MUTABLE-status table for the propose-not-mutate path: detectors emit proposals, operators decide, the apply path delegates to the state machine. Details in §11.3. Sibling `memory_governance_proposal_keys` is its derived index for cross-memory lookups.

The tables are intentionally separate because they answer different questions:

- "Who edited what when in this session?" → `memory_events`.
- "Why did the state machine refuse this transition, and what was the upstream trigger?" → `eviction_events`.
- "Which memories were visible to the model when this tool call fired?" → `memory_provenance`.
- "What does a detector want to change about memory, and who decided what?" → `memory_governance_proposals`.

Cross-table linkage via `memory_events.details.eviction_event_id` for transitions that emit both rows. `memory_provenance.tool_call_id` and `memory_provenance.retrieval_query_id` link the exposure trail to the canonical `tool_calls` and `retrieval_trace` tables respectively.

### 11.1 Audit split with `retrieval_trace`

A third table, `retrieval_trace` (migration 053), lives in the retrieval subsystem but its existence is visible to anyone auditing memory access. The split is deliberate:

| Surface the operator inspects | Authoritative table |
|---|---|
| `memory_read` tool call (model asked by name) | `memory_events action=read` |
| `memory_write` tool call | `memory_events action=created` / `updated` / `refused` |
| State transition (quarantine / evict / restore / purge) | `memory_events` + `eviction_events` |
| Memory body delivered via `retrieve_context` tool | `retrieval_trace.context_slot_json.included[]` |

`retrieve_context` does NOT emit `memory_events action=read` rows for memories it surfaces. The audit-immutability policy on `retrieval_trace` (§13.3) carries the inclusion record forward as the canonical "model saw this body via retrieval" signal. `/memory audit` and `/agent retrieval audit` are the two complementary surfaces:

- An operator asking "what did the model see of memory `user_role` in this session?" needs both tables: `memory_events` for explicit `memory_read` tool calls, `retrieval_trace.included` for retrieval-surfaced inclusions. A JOIN-style query would gate this; today the operator inspects each surface separately and reconciles.
- Retrieval-internal paths (BM25 corpus build with `loadBodies=true`, compression fallback probing levels) use `registry.peek` so they don't emit `memory_events`. The model never sees the bodies they touch — those reads are pipeline-internal heuristics, not deliveries.

This is the asymmetry that lets `/memory audit` stay focused on operator-driven actions without inflating with retrieval-internal noise, AT THE COST of needing two surfaces when the question is "what did the model receive."

### 11.2 Provenance trail (`memory_provenance`)

Records EXPOSURES — moments where a memory's bytes were visible in the model's window. NOT causation: the model can ignore an exposed memory entirely. Provenance is the lower bound — "the bytes WERE in the window" — and downstream detectors (`verify_failed`, `user_override_repeated`, `conflict_detected`, `trust_revoked` per `§6.5.2`) layer correlation analysis on top.

#### What the schema does NOT claim

Worth stating up front because the field names invite misreading:

- **Causation.** The model may have ignored an exposed memory entirely. A `verify_failed` correlated with an exposure is *epistemic correlation*, not proof the memory drove the action.
- **Use.** No signal today says "the model attended to this memory". Provenance answers a strictly weaker question.
- **Replay completeness.** The system prompt's full bytes, the tool registry version, the model id, the decoding seed — none live here. Provenance is *one dimension* of cognitive observability, not all of it.

The reframing ("exposed", not "caused") is load-bearing discipline; the schema header in `migrations/054-memory-provenance.ts` calls it out at the top.

#### Three surfaces

| `surface` | When | `tool_call_id` | `retrieval_query_id` | `position_in_corpus` |
|---|---|---|---|---|
| `eager` | System-prompt assembly at session boot — one row per `(session, memory)` (NOT per tool call) | NULL by construction (precedes any call) | NULL | NULL |
| `memory_read` | Model called the `memory_read` tool by name, OR `memory_search` deep matched the body | Non-null (the call that surfaced the body) | NULL | NULL |
| `retrieve_context` | A `retrieve_context` slot included the memory | Non-null (the tool call that issued the retrieval) | Non-null (FK to `retrieval_trace`) | 0 = top hit |

Eager emits once per `(session, memory)` because the index lands in the system prompt and is visible for every tool call in the session — emitting N rows for N calls would inflate the table without adding signal. Per-call surfaces emit per call: each `memory_read` is a new row; each `retrieve_context` slot membership is a new row.

#### Schema fields

`memory_provenance(id PK, session_id FK CASCADE, tool_call_id FK CASCADE NULL, memory_scope TEXT CHECK, memory_name TEXT, surface TEXT CHECK, retrieval_query_id FK retrieval_trace SET NULL, position_in_corpus INTEGER NULL, memory_content_hash TEXT NULL, memory_state_at_exposure TEXT NULL, created_at INTEGER)`.

Two fields freeze the memory at exposure time so replay stays honest after the operator edits the file:

- **`memory_content_hash`** — SHA-256 hex of the canonical serialization (`serializeMemoryFile` output, same producer the writer uses). A memory the system wrote round-trips through the hash exactly; operator hand-edits with different whitespace hash differently — that drift IS the signal. NULL when the hashing call itself failed (best-effort: a hash glitch never blocks the exposure record).
- **`memory_state_at_exposure`** — `frontmatter.state` snapshot at the exposure moment (defaults to `active` when absent). The memory may transition state after exposure; the snapshot answers "what was the state when the model saw this?" without needing time-travel queries against `memory_events`.

#### Invariants enforced at the repo layer

`src/storage/repos/memory-provenance.ts` validates before INSERT so DB CHECK errors stay the last line of defense:

- **Surface enum** + **memoryScope enum** validated against canonical sets (`{eager, memory_read, retrieve_context}` and `{user, project_shared, project_local}`).
- **`tool_call_id` nullability per surface**: `eager` MUST be null (the row precedes any call); per-call surfaces MUST be non-null (orphan rows from causal context are caller bugs).
- **Retrieval-grouping invariant**: `surface='retrieve_context'` requires both `retrieval_query_id` AND `position_in_corpus`; other surfaces MUST set neither. Half-grouped rows would silently fail downstream "exposures from this retrieval" queries.

#### Privacy-by-default at the query layer

Every listing helper REQUIRES `sessionId`. Cross-session aggregation is reachable only via explicitly-named functions (`listGlobalProvenanceByName`, `listGlobalProvenanceForMemory`). This shape blocks the accidental-leak pattern: a caller writing session-scoped queries can't reach for the global helpers without typing the literal word `Global`. Same fix shape as commit `55ba11a`'s `listRetrievalTracesByWorkflow` regression.

#### Three emitters

- **`memory_read` tool** — `MemoryRegistry.read()` / `MemoryRegistry.search(deep)` emit `surface='memory_read'` alongside the existing `memory_events action=read` audit row. `auditExposure` mirrors `auditRead`'s best-effort posture: a DB failure stderr-logs as `AUDIT DRIFT` but never aborts the body load. The tool layer threads `ctx.toolCallId` (populated by `invoke-tool.ts` post-`createToolCall`) so the row links to its causal call.
- **Eager load** — bootstrap captures an inventory at system-prompt assembly time (`AssembleMemorySectionResult.eagerLoaded`) and forwards it via `HarnessConfig.eagerExposures`. The harness loop emits one row per inventory entry right after `createSession` — the first moment a sessionId exists. Inventory is frozen at assembly, NOT at emit: operator rewrites between boot and session start would otherwise drift the hash from "what landed in the prompt" to "what's on disk now".
- **`retrieve_context`** — the retrieval runner emits one row per `contextSlot.included` entry whose `view === 'memory'`, after `createRetrievalTrace` succeeds. Gated on `result.queryId.length > 0` because a persist-failed retrieval has no parent trace to FK against. Session-view entries are filtered out — provenance is memory-specific; session messages already live in `messages`.

#### Operator surface: `/memory provenance`

Three forensic modes, mutually exclusive at parse time:

| Form | Answers |
|---|---|
| `/memory provenance <name>` | Every exposure of this memory in the current session. `--all` opts out for cross-session forensic. |
| `/memory provenance --tool <tool_call_id>` | Every memory exposed during one tool call. Session-scoped (`tool_call_id` lives in a session). |
| `/memory provenance --retrieval <retrieval_query_id>` | Group view of one `retrieve_context` call, ordered by `position_in_corpus ASC` so the slot's ranking shows up directly. |

`--limit N` (default 50) caps the rendered batch across every mode. Output is one compact row per exposure: `timestamp · surface · scope/name · tc=<prefix> · state=<…> · hash=<prefix>` plus `retrieval=<qid-prefix> #<pos>` for retrieval rows. Eager rows render `tc=eager---` to flag the NULL-by-construction case.

#### Retention

Boot-time GC sweep at `bootstrap.ts` prunes rows older than `MEMORY_PROVENANCE_RETENTION_MS` (90 days, mirrors `eviction_events`). Best-effort: a sweep failure stderr-logs but doesn't abort boot — provenance is observability, not correctness, and one failed sweep retries on the next boot. The cutoff is exclusive (`created_at < olderThanMs`) so callers can treat the value as the inclusive lower-bound of the retention window. The constant lives next to the prune query so a future tuning PR (operator policy, longer windows for compliance) has one place to change.

#### Failure posture (best-effort everywhere)

Every emit site catches its own throw and logs `AUDIT DRIFT` to stderr without aborting the surrounding work:

- The model's body load already succeeded (memory_read) or the slot was already returned (retrieve_context) or the session bootstrap already completed (eager) by the time the provenance INSERT runs. Failing the work because the audit row didn't land would punish correctness for an observability glitch.
- A bad inventory row (invalid scope passing through a future refactor) gets logged and skipped; following rows still emit.
- Boot-time sweep failures defer cleanup by one boot — never block the session.

#### Cross-table audit reconciliation

Provenance complements the existing audit split:

| The operator asks… | Tables to consult |
|---|---|
| "Did the model see memory X in this session?" | `memory_provenance` (every surface, one query). |
| "Did the model call `memory_read` on X?" | `memory_events action=read` for explicit calls; `memory_provenance surface='memory_read'` for the per-exposure link. |
| "Which memories did `retrieve_context` deliver?" | `retrieval_trace.context_slot_json.included[]` for the slot itself; `memory_provenance surface='retrieve_context'` for the cross-cut "all retrieve_context exposures of memory Y across sessions". |
| "What memories did THIS specific tool call surface?" | `memory_provenance` filtered by `tool_call_id`. |

`memory_events` stays focused on operator-driven actions; `retrieval_trace` carries the slot contents; `memory_provenance` carries the cross-cut exposure index that joins them. None replaces the other.

### 11.3 Governance proposals (`memory_governance_proposals`)

The propose-not-mutate substrate. Detectors emit; operators decide; the apply path delegates to `transitionMemoryState`. Lands in Phase 2 / S8; LLM-judge detectors (S11 verify_failed, S13 conflict_detected) and the deterministic counter-driven detector (S3 user_override_repeated) all funnel through this table.

#### Why a separate substrate

`memory_events` is the audit log for operations that DID happen (`created`, `quarantined`, `restored`). `eviction_events` audits state-machine transitions. Neither answers "an LLM-judge subagent proposed a quarantine and the operator hasn't decided yet" — a pending proposal is mutable lifecycle state (`pending → applied | rejected | expired`) that doesn't fit either append-only audit shape. The table is **MUTABLE** on the decision columns (`status`, `decided_at`, `decided_by`, `decided_reason`) and append-only everywhere else.

#### Architectural commitment

Detectors NEVER mutate memory state directly. Every detector finding becomes a proposal; the operator approves; only then does the apply path call `transitionMemoryState`. This isolates the non-determinism of LLM-judge from the determinism of the state machine — when a memory transitions, there's always an operator approval row to trace back to.

#### Six kinds

`kind` enumerates what the proposal would do:

| Kind | Apply-path semantic (S8 V1) |
|---|---|
| `quarantine`   | `active → quarantined` via state machine. Single-memory only. |
| `restore`      | `quarantined/evicted → active` via state machine. Single-memory only. |
| `demote`       | Schema accepts; apply path returns `unimplemented_kind` (needs file-move primitive). |
| `merge`        | Schema accepts; apply path returns `unimplemented_kind` (needs file-rewrite primitive). |
| `consolidate`  | Like merge but similarity-driven. Same deferral. |
| `expire`       | Set/update `expires` frontmatter. Same deferral (needs frontmatter mutation primitive). |

The substrate is forward-compatible with the four deferred kinds so a future detector can persist them before the apply path supports them. The apply path's confidence + staleness gates still run on those rows, so a deferred-kind proposal that fails preflight rejects normally; one that passes lands in `rejected` with `decided_by='system:unimplemented_kind'`.

#### Schema fields (operator-facing)

| Field | Purpose |
|---|---|
| `id` | UUID. The slash inspector + apply path key on this. |
| `session_id` (FK SET NULL) | Session the detector was running in. NULL when emitted by a boot-time detector. SET NULL preserves the proposal trail across session purges. |
| `kind` | One of the six above. |
| `source_memory_keys` | JSON array of `{scope, name}` — every memory the proposal would mutate. Sorted canonically by the repo before persist. |
| `target_payload` | JSON, kind-specific. `expire` carries `{expires: "YYYY-MM-DD"}`; `merge` / `consolidate` carry the resulting body. `quarantine` / `restore` may pass `{motivo, trigger}` to override defaults. **`quarantine` with multi-memory `source_memory_keys`** (pair detectors that need to record BOTH sides for forensic context — `subagent:verify-conflict` is the canonical caller) MUST pass `{target_key: {scope, name}}` designating which entry transitions; the others stay as cited evidence. |
| `confidence` | `[0, 1]` for LLM-judge detectors; NULL for deterministic / operator proposals (NULL bypasses the apply-path confidence gate). |
| `evidence` | JSON, detector-specific. The original LLM verdict / counter values / claim extracts. Survives the proposal lifecycle so forensic JOINs can read it after approval. |
| `status` | `pending` → `applied` / `rejected` / `expired`. Default 'pending'. |
| `proposed_by` | `subagent:<name>` for LLM detectors; `detector:<name>` for deterministic; `operator:<id>` for manual proposals. Drives the default `trigger` derivation at apply time. |
| `proposal_fingerprint` | SHA-256 over `{kind, sorted(source_memory_keys), evidence_essence}`. UNIQUE partial index `WHERE status = 'pending'` enforces silent dedup. |
| `source_memory_snapshots` | JSON array of `{scope, name, content_hash}` — every source memory's `hashMemoryContent(serializeMemoryFile(file))` at proposal-creation time. Closes the staleness gap (§ apply-path gates below). |
| `decided_*` | NULL while pending; set when status transitions away from pending. `decided_by` distinguishes operator (`operator:slash`, `operator:api`) from system auto-decisions (`system:low_confidence`, `system:stale_evidence`, `system:unimplemented_kind`, `system:state_change`, `system:hook_blocked`, `system:invalid_evidence`, `system:ttl`). |
| `created_at` | Epoch ms. Drives the 30d TTL sweep. |

#### Apply-path gates (`src/memory/governance.ts:applyProposal`)

Five sequential gates. Any failure rejects the proposal with `system:*` `decided_by`:

1. **Existence + status** — proposal must exist and be `pending`.
2. **Confidence** — `confidence === null` bypasses; otherwise `confidence >= DEFAULT_GOVERNANCE_CONFIDENCE_THRESHOLD` (0.7 default, override per call). Below threshold → `system:low_confidence`.
3. **Kind support** — quarantine / restore in S8 V1. Others → `system:unimplemented_kind`.
4. **Single-memory (with multi-memory carve-out for `quarantine + target_key`)** — supported kinds in S8 V1 admit one source memory each, with ONE exception: a `quarantine` proposal MAY carry multiple `source_memory_keys` if AND ONLY IF `target_payload.target_key = {scope, name}` designates which entry transitions and that key appears in both `source_memory_keys` and `source_memory_snapshots`. The rest of the entries stay as forensic evidence (the pair-judge S13 detector emits `[winner, loser]` and designates loser as `target_key` so the operator sees BOTH bodies on `/memory governance show`, but only the loser flips state on approve). Any other multi-memory shape → `system:multi_memory_unsupported`. A `target_key` that doesn't match any entry in `source_memory_keys` → `system:invalid_target_key`.
5. **Staleness (drift wins over state_change)** — every snapshot in `source_memory_snapshots` must still equal the memory's current `hashMemoryContent(serializeMemoryFile(file))`. Any unreadable memory OR any hash mismatch → `system:stale_evidence` with the drifted memories listed in `decided_reason`. The ordering is deliberate: if the operator edited the body since the proposal, the decision is "the detector's evidence no longer applies" — telling them "memory state changed" would mislead.

After the gates pass, `applyProposal` calls `transitionMemoryState` with `actor: 'user'` (operator approval IS the user action), `motivo` defaulted per kind (quarantine → `conflict`, restore → `shift`; `target_payload.motivo` overrides), `trigger` derived from `proposed_by` (`subagent:verify-semantic` → `verify_failed`, `subagent:verify-conflict` → `conflict_detected`, `detector:user_override_repeated` → `user_override_repeated`, else `operator_driven`; `target_payload.trigger` overrides), and an evidence payload carrying the `_operator_driven` marker plus trace fields (`proposal_id`, `proposed_by`, `proposal_fingerprint`, `detector_evidence`) so forensic queries can JOIN from `eviction_events` back to the originating proposal. The memory whose state transitions is the one named by `target_payload.target_key` when set (multi-memory quarantine), else `source_memory_keys[0]` (single-memory path).

Same-state pseudo-transitions (memory already in target state) reject with `system:state_change` — the proposal is moot, no audit row claiming "we did something" should land.

Transition refusals from the state machine (illegal_transition, blocked_by_protection, blocked_by_hook, invalid_evidence) all reject the proposal with the matching reason kind; the memory state on disk did not change. `io_error` and `audit_drift` LEAVE the proposal pending so a retry can land cleanly — they signal infrastructure problems, not policy decisions.

**Concurrent-decision race (`governanceDrift`).** After `transitionMemoryState` returns `applied`, the post-transition `decideProposal` UPDATE can race with another actor (TTL sweep, parallel reject, another apply path) that flipped the proposal row to a terminal status. The memory mutation already landed; the row credits the racing actor instead. `applyProposal` returns `{outcome: 'applied', transitions, governanceDrift: {currentStatus, decidedBy}}` — the `transitions[]` still reflects the memory transition that happened, and `governanceDrift` carries the row's actual post-race state. AUDIT DRIFT also emits to stderr with `proposal_id` + transition summary so operators can reconcile by JOINing `transitions[].evictionEventId` with the proposal row. Callers that ignore `governanceDrift` see backward-compatible `applied` behavior; the slash command renders a `⚠ governance row race` line so operators see the mismatch in the reply without grepping stderr.

#### TTL sweep

`expirePendingProposals` runs at boot from `bootstrap.ts` alongside the other memory sweeps. Default window 30d (`GOVERNANCE_PROPOSAL_TTL_MS`); pending rows whose effective expiry has passed flip to `expired` with `decided_by='system:ttl'`. Best-effort same as `pruneMemoryProvenance`: a sweep failure logs `AUDIT DRIFT` to stderr and doesn't abort boot.

**Effective expiry** = `COALESCE(deferred_until, created_at + TTL)`. A non-deferred row uses the canonical 30d window; a deferred row honors `deferred_until` instead (set by `deferProposal`; see below). One SQL pass handles both cases.

The TTL is not just hygiene — a 30d-old proposal has likely outlived its evidence (the underlying memory + detector context drift). Forcing the detector to re-emit if the finding still holds is the right contract. Defer is the operator escape valve for "I need more time to research before deciding", capped to 90d total horizon from `created_at` so a proposal can't outlive the detector context indefinitely.

#### Defer (operator-controlled expiry extension)

`deferProposal(db, id, { additionalDays, nowMs? })` pushes a pending proposal's `deferred_until` forward. Anchors on the LATER of (now, current effective expiry), so calling defer twice doesn't lose runway — the second call adds to the first's extension, not to wall-clock now.

| Repo input | Range | Behavior |
|---|---|---|
| `additionalDays` | integer in `[MIN_GOVERNANCE_PROPOSAL_DEFER_DAYS, MAX_GOVERNANCE_PROPOSAL_DEFER_DAYS]` (1..90) | Out of range → `invalid_days` |
| `nowMs` | `> 0`; defaults to `Date.now()` | `≤ 0` throws |

Result shape:

- `{ ok: true, deferredUntil, deferCount }` — UPDATE succeeded; `deferred_until` columns visible on subsequent `getProposalById` reads.
- `{ ok: false, reason: 'not_pending' }` — unknown id, terminal status, or lost a race to a concurrent terminal transition (the UPDATE matched zero rows).
- `{ ok: false, reason: 'invalid_days' }` — caller error; row untouched.
- `{ ok: false, reason: 'horizon_exceeded' }` — request would push `deferred_until` past `created_at + MAX_GOVERNANCE_PROPOSAL_DEFER_HORIZON_MS` (90d). Operator must approve / reject instead — eternal pending is not on the table.

The `defer_count` column tracks how many defers landed on the proposal (audit signal: many defers on one proposal hint at dithering). Surfaced on `/memory governance show` as `deferred_until: <date> (count=N)` when set.

Each defer also emits a `memory_events` row with `action='deferred'` (migration 063), attributed to the memory the proposal would transition on approve — `target_payload.target_key` when set (S13 multi-memory pair), else `sourceMemoryKeys[0]` (S11 single-memory path). Details payload: `{proposal_id, kind, additional_days, new_deferred_until, defer_count, reason?}`. The audit row makes `/memory audit --name <memory>` reflect the expiry-extension activity alongside transitions; without it, defer mutations are visible only via `/memory governance show`. Emission is best-effort (mirror of `registry.recordEvent` everywhere else): a disk error stderr-logs `AUDIT DRIFT` but does NOT roll back the defer — the proposal row already committed in its own immediate transaction.

Optional `--reason "..."` flag captures the operator's note in the audit row's `details.reason` and echoes back in the response. Use it when stacked defers risk losing context ("why did this proposal need 30+30+30 days?" answered by the reason chain in `/memory audit --name <memory>`).

#### Operator surface: `/memory governance`

Six subcommands:

| Form | Action |
|---|---|
| `/memory governance list [--status <s>] [--limit N]` | Inventory with status filter. Empty hint when nothing matches. |
| `/memory governance show <id>` | Full proposal detail: kind, status, confidence, source memories, snapshots, evidence (truncated), `deferred_until` when set. |
| `/memory governance approve <id>` | Invoke `applyProposal`. A bulk-confirmation modal for ≥3 memories is intentionally not wired in V1 since the apply path auto-rejects multi-memory proposals as `multi_memory_unsupported`; it will land alongside the `merge` / `consolidate` apply primitives. |
| `/memory governance reject <id> [--reason "..."]` | Mark `rejected` with operator's reason. |
| `/memory governance defer <id> <days> [--reason "..."]` | Extend expiry by `<days>` (1..90, integer). Rejects with `past the 90d horizon` when the request would push past `created_at + 90d`. Anchors on existing expiry so successive defers stack. Optional `--reason` lands in the audit row's `details.reason`. Emits `memory_events action='deferred'` attributed to the proposal's target memory (migration 063). |
| `/memory governance audit <id>` | Proposal detail + `memory_events` landed against the source memories since the proposal's `created_at` (lineage). |

Arg-validation refuses unknown flags and out-of-range `--limit` so a typo doesn't take a default code path. The status surface (`/memory governance status`) lives separately (§11.4) and reports detector enabled state, not proposal queue contents.

#### What proposals do NOT do

- **Mutate memory state without operator approval.** This is the architectural invariant. A detector landing a proposal is informational; the state machine doesn't move until the operator approves AND the apply-path gates all pass.
- **Bypass the state machine.** Approve still delegates to `transitionMemoryState`. The same protection gates (cooldown, quarantine TTL, hook gating) fire on governance-driven transitions as on `/memory quarantine`-driven ones.
- **Replace `/memory quarantine` + `/memory restore`.** Operators retain the direct slash flows for manual transitions. Governance is the detector ingress; the direct slashes are the operator ingress.
- **Persist detector-internal reasoning.** `evidence` is a structured payload, not free-form prose. LLM-judge detectors validate output via JSON schema before recording (Phase 2 / S11+S13).

#### Forward-compat hooks

- `proposed_by` taxonomy is open — `subagent:<new-detector>` or `detector:<new-detector>` lands new origins without a schema change. The trigger derivation in the apply path has a small map (`subagent:verify-semantic` → `verify_failed`, etc.); new detectors that want canonical trigger attribution add a case. Anything not mapped falls back to `operator_driven` and still works.
- `kind` accepts the four deferred values today — when an apply primitive lands for `expire` or `merge`, only `SUPPORTED_KINDS` in `src/memory/governance.ts` and the kind-specific branch need updating; the substrate is ready.
- `target_payload` is opaque JSON; detector-specific schemas live in detector code (e.g., the future merge primitive validates `target_payload.body` shape on apply). The substrate doesn't gate schema beyond "valid JSON".

### 11.4 Detector opt-out & per-project config

Canonical declaration of the memory-governance LLM-judge detectors' opt-out surface. All three detectors (`verify_failed` / S11, `conflict_detected` / S13, `user_override_repeated` / S3) are **default ON** since Slice Q (S3 joined the default-ON posture in S3.5).

#### Precedence

Operators control opt-out at three layers; first-match wins:

| Layer | Where | Scope | Wins over |
|---|---|---|---|
| **CLI flag** | `--memory-verify-llm` / `--no-memory-verify-llm` (same shape for `--memory-conflict-llm` and `--memory-override-llm`) | session-only | everything else |
| **Project config** | `.agent/config.toml [memory] verify_semantic_llm = false` (same key shape for `conflict_detect_llm` and `override_detect_llm`) | per-project, committed (operators who keep `.agent/` under git ship the policy team-wide) | user config |
| **User config** | `~/.config/agent/config.toml [memory] verify_semantic_llm = false` | per-user, cross-project | default |
| **Default** | hardcoded in `src/critique/config-loader.ts:DEFAULT_MEMORY_CONFIG` (all three = `true`) | global | — |

#### Config block shape

```toml
[memory]
verify_semantic_llm = false    # disables S11 verify_failed detector
conflict_detect_llm = false    # disables S13 conflict_detected detector
override_detect_llm = false    # disables S3 user_override_repeated detector
```

Snake_case is canonical (matches the `[critique]` block precedent). camelCase aliases (`verifySemanticLlm`, `conflictDetectLlm`, `overrideDetectLlm`) are accepted for copy-paste tolerance from the HarnessConfig API surface; snake wins on tie. Layer precedence runs per-field — a project file that only sets `verify_semantic_llm` leaves `conflict_detect_llm` and `override_detect_llm` to inherit from user or default.

Spec backing: [`docs/spec/AGENTIC_CLI.md §5.4.1`](./spec/AGENTIC_CLI.md) (config.toml declaration) + [`docs/spec/MEMORY.md §6.6`](./spec/MEMORY.md) (detector contract).

#### Slash commands

- `/memory governance disable verify | conflict | override | all` — writes `false` to project config.
- `/memory governance enable verify | conflict | override | all` — writes `true` to project config. `all` covers all three detectors.
- `/memory governance status` — shows resolved state per detector with source label (`yes (default; disable: ...)`, `yes (.agent/config.toml)`, `yes (~/.config/agent/config.toml)`, `yes (--memory-verify-llm)`, `no (.agent/config.toml)`, `no (--no-memory-verify-llm)`, `no (default)`). Three blocks: `semantic-verify (S11)`, `verify-conflict (S13)`, `verify-override (S3)`. Each block renders enabled state + caps + recent attempts.

Side effects: idempotent atomic write to `.agent/config.toml` (creates `.agent/` + file if absent; preserves other sections like `[critique]` verbatim via TOML round-trip; canonical re-emit so unknown comments are NOT preserved on touched blocks). The handler ALSO mutates the live `ctx.baseConfig.memory{Semantic,Conflict,Override}Detect` field + flips `*Source` to `'project-config'` — without this, the next `startTurn` snapshot would keep reading the pre-toggle value (process restart required for the effect to land). Effect applies at **next turn boundary** — not mid-session — matching the snapshot semantic of `/model` and `/critique mode`. Mid-flight turn already snapshotted its config; the new value applies on the next prompt.

#### Plan mode suppresses detectors entirely

A `--plan` session refuses scheduler construction for all three detectors regardless of `memory_*_llm` config. Plan mode is read-only by contract; LLM-judge dispatches write `memory_*_attempts` rows + (on negative verdicts) governance proposals, both governance-substrate writes. The boot emits a single stderr line per enabled-but-suppressed detector (`memory: verify_*_disabled: plan mode active — LLM-judge detectors skipped (no governance writes)`) so the operator sees what's NOT happening rather than wondering why proposals never land. Resume detectors by re-running without `--plan`.

#### Config-loader warnings surface on stderr

Malformed values in `[memory]` (`verify_semantic_llm = "false"` quoted as a string, `override_detect_llm = 0` written as a number, etc.) don't abort boot — the loader degrades to defaults rather than refusing to start. Both `run.ts` and `repl.ts` print one `forja: memory config: <warning>` line per bad value at boot (inside the `!args.json` gate; NDJSON consumers don't see them). Without this surface, an operator who typed the wrong syntax thought they had opted out but actually kept paying for default-on detectors silently.

#### First-boot stderr advisory

When all three detectors resolve to ON via default (no config layer touched the field, no CLI flag) the boot emits a single stderr line:

```
memory: governance LLM detectors enabled by default (verify=on, conflict=on, override=on). Disable: /memory governance disable verify|conflict|override|all
```

So operators upgrading from pre-Slice-Q (when defaults were OFF) aren't surprised by proposals surging in `/memory governance`. Suppressed in:

- `--json` mode (NDJSON consumers don't need stderr noise; toggled via `BootstrapInput.json`).
- subagent context (subagent-child has its own boot path; doesn't pass through this code).
- after first appearance (marker file in `~/.local/share/forja/.governance-banner-shown` — created on first emit, checked on subsequent boots).
- when ANY config layer (user or project) explicitly named ANY of the three fields — operator awareness of the subsystem is the signal.

To suppress permanently without touching `.agent/config.toml`: run `/memory governance enable all` or `disable all` once — both materialize the field(s) in project config and trip the explicit-source branch on next boot.

---

## 12. How the LLM interacts with memory

End-to-end flow of how the language model reads from and writes to the subsystem. Operational view — what's on the wire at each step.

### 12.1 Reading flow

At session boot, three things land in the model's context (in order):

```
[agent base prompt]
[memory index]                    ← MEMORY.md eager-loaded here
  - [User role](user_role.md) — full-stack TS dev, prefers Bun
  - [Commit casing](feedback_commit_style.md) — Title Case in repo
  - [Q3 release](project_q3_release.md) — M5–M7 ready by 2026-06-30
  - …
[trigger-loaded memories]         ← conditional eager-load
  (only when triggers: in a memory's frontmatter match the boot
   context — e.g., `triggers: [bash]` + first prompt mentions
   "shell"; `triggers: [has_env_file]` + cwd contains `.env`)
[tool schemas]
```

The `[memory index]` is the post-dedup view (local > shared > user). The model sees one line per effective memory; the body stays on disk. A cache breakpoint sits right after the index so subsequent turns reuse the cached prefix until something invalidates it (operator promote/demote, eviction, write).

After boot, the model has three tools for explicit lookup:

| Tool | What it does | Cost |
|---|---|---|
| `memory_list [scope]` | Index dump, no bodies | 1 round-trip |
| `memory_read <name> [scope]` | Loads the body of one memory; emits a `read` audit event | 1 round-trip + 1 disk read |
| `memory_search <query> [--deep]` | Substring search; default scans name + description only, `--deep` includes bodies | 1 round-trip + 1..N disk reads |

`memory_read` honors precedence by default: missing `scope` walks `project_local → project_shared → user` and returns the first hit. Passing `scope: 'shared'` pins a strict lookup so a same-name `local` override doesn't silently mask the team-wide answer.

`evaluateBootTriggers(repoRoot)` (`src/memory/triggers.ts`) builds the boot context once at session start; `shouldEagerLoadByTriggers` decides per memory whether its `triggers:` array matches. Result: a small handful of conditionally-loaded bodies sit in the context from turn 0, without paying for memories that don't apply to this session.

### 12.2 Writing flow

The model proposes via `memory_write`; the harness routes the call through six sequential gates before persistence. Any gate that refuses produces a `refused` row in `memory_events` with the stage that blocked.

```
LLM calls memory_write({ scope, name, type, source, body })
   │
   ▼
1. Headless gate          → reject if forja --json without
                            --allow-memory-write=<scope>
                            (user scope rejected unconditionally)
   ▼
2. Trust gate             → reject if cwd is untrusted AND
                            source='inferred' (operator must
                            pass the boot trust prompt first)
   ▼
3. Scanner                → scanForInjection: "ignore previous
                            instructions", "you are now", "from
                            now on, always" → hard block
                            scanForSecrets: sk-ant-…, AWS keys,
                            GitHub tokens → hard block
   ▼
4. MemoryWrite hook       → operator-configured shell hook can
                            block (exit 2). Enterprise can force
                            external audit via shell command.
   ▼
5. TUI confirm modal      → operator-facing prompt with diff
                            preview. [a]ccept / [e]dit / [r]eject /
                            [w]hy? — user scope adds a SECOND
                            modal (affects every session, extra
                            friction deliberate)
   ▼
6. Atomic write           → validateFrontmatter
                            sandbox path check (refuses traversal)
                            rename-after-write (atomic)
                            upsertIndexEntry on MEMORY.md
                            memory_events row action='created'
```

Inferred writes default to `project_local/` — promotion to `shared/` is a separate explicit step (`/memory promote shared <name>`) that runs an additional scanner pass (path traversal, secret patterns, injection heuristics, 200-line body cap) and produces a `git status` change for PR review. The first commit is always operator-driven; no auto-commit.

`trust: untrusted` marker: when a write happens in a session that didn't fully pass the trust prompt, the persisted frontmatter gains `trust: untrusted`. Such memories **don't auto-load** into the model context — they only surface via explicit `memory_read`, and the UI marks them `[memory: untrusted]` in the warn channel.

### 12.3 What the model literally sees

Concretely, the `[memory index]` chunk inserted in the system prompt looks like:

```
- [User role](user_role.md) — full-stack TS dev, terminal-heavy, prefer Bun
- [Commit casing](feedback_commit_style.md) — Title Case in repo
- [No auto-commit](feedback_no_auto_commit.md) — never commit without explicit ask
- [Q3 release](project_q3_release.md) — M5-M7 ready by 2026-06-30
- [Linear pipelines](reference_linear_ingest.md) — pipeline bugs in INGEST
```

That's it. The model does NOT see:

- Frontmatter (`source`, `expires`, `trust`, `state`) — inferred from the title/description or surfaced via tools.
- Bodies — `memory_read` brings them in lazily.
- Audit history (`memory_events`, `eviction_events`) — operator-side via `/memory audit`.
- Lifecycle metrics — operator-side via `/memory metrics`.
- The fact that a memory was just quarantined — the index reload between turns silently drops it (state-aware filter).

When a memory carries `triggers: [...]` and the boot context matches, the **body** also lands eager, flagged so the model knows it didn't have to ask:

```
[memory: bash-discipline (eager-loaded by trigger)]
Body of feedback_bash_discipline.md...
```

This is the only path the model gets a body without an explicit tool call.

### 12.4 Retrieval ranking

The eager-load path puts the **index** in the system prompt; the `retrieve_context` tool puts **bodies** into per-call retrieval slots when the model wants deeper coverage. Both paths read from the same registry but the ranking story applies to the retrieve-context view in `src/retrieval/views/memory.ts`.

**Inputs to ranking** (per query):

| Signal | Source | How it scores |
|---|---|---|
| Name | `MemoryListing.name` | tokenized, weight ×3 |
| Description | `MemoryListing.entry.hook` (the one-line index hook) | tokenized, weight ×2 |
| Body | `registry.peek(name, scope).file.body` when `loadBodies=true` | tokenized, weight ×1 |
| State | `MemoryListing.state` | `quarantined` multiplies score by `QUARANTINED_PENALTY = 0.3` |

Field weights are implemented via token repetition (the BM25 index is field-agnostic) — a 3× weighted name simply appears three times in the document's token stream. The constant lives in `src/retrieval/views/memory.ts:32-34`.

**Pre-rank filters** (applied to the listing set before the BM25 corpus is built):

1. **State filter** — `states: ['active', 'quarantined']`. `invalidated` / `evicted` / `purged` never reach the corpus. State for retrieved bodies is captured at peek time (so post-peek transitions don't drift the ranking).
2. **Expiration filter** — `includeExpired: false`. A memory with `expires < today` is dropped (hard filter, not a penalty — expiration is operator intent).
3. **Scope exclusion** — when the trust probe couldn't confirm `project_shared` (revoked / verify-failed / deferred), the scope is dropped from `list()` *before* dedup. This preserves precedence fallback (a higher-precedence shadow in an excluded scope no longer wins the dedup walk and silently disappears — the eligible lower-precedence sibling stays reachable).
4. **Deduplication by name** — `deduplicateByName: true` keeps only the winning scope per name, walking `project_local → project_shared → user`. The model sees one effective memory even if three scopes shadow each other.

**Score computation** (BM25 over the weighted token stream):

```
score(memory, query) = Σ_term BM25(term, memoryTokens, corpusStats)
bootstrapScore = state === 'quarantined' ? rawScore × 0.3 : rawScore
```

`bootstrapScore` is what the retrieval pipeline uses as the *bootstrap* signal; downstream stages (structural rerank, temporal decay, view aggregation) further scale into the final retrieval score before slot assembly. The memory view is a pure candidate generator — it never decides whether a candidate is *included*, only how strongly it should compete.

**The quarantine penalty rationale**:

- 0.3 means a quarantined memory needs roughly 3.3× the raw match score of an active sibling to tie at the bootstrap stage. Enough to suppress on routine queries; light enough that a very strong match still surfaces.
- Quarantining communicates "questionable, not forbidden" — the operator wants the model to see the marker, NOT to lose access. Hard-filtering would mimic deletion semantics and break the audit shape ("did the model see X when it produced Y?" needs X to remain reachable from retrieval).
- The penalty is exported (`QUARANTINED_PENALTY`) so tests pin the exact value — a silent tweak to 0.25 / 0.5 would pass relative-ordering tests but shift the behavioral contract.

**Resolution order at lookup (single-name reads)** — distinct from the BM25 corpus path:

```
1. project_local       ← most-specific; per-user, gitignored
2. project_shared      ← team-curated, versioned in git
3. user                ← global, all sessions
```

`MemoryRegistry.read(name)` walks this order and returns the first hit. `MemoryRegistry.read(name, {scope: 'shared'})` pins to a strict lookup so a same-name `local` override can't silently mask the team answer. The model can request either form via the `memory_read` tool's `scope` parameter.

**Body load is opt-in.** The eager-load path is title + description only (cache-stable across turns). `retrieve_context` requests `loadBodies: true` when it wants deep coverage, paying one disk read per indexed memory in exchange for body-text match recall. The body load goes through `registry.peek` (not `read`) so it does NOT emit a `memory_events action=read` row — peek is the audit-quiet primitive for pipeline-internal heuristics; only deliveries to the model produce read events.

**What ranking does NOT do** (deliberate gaps):

- **No temporal decay yet** — a freshly-written memory and a 6-month-old memory tie on BM25 alone. Decay sits in the broader retrieval pipeline, not in the memory view's candidate generator.
- **No edge signals yet** — cross-view edges (a memory cited by a session message, a memory tagged with the same concept as the active code-index entry) are spec'd in `docs/spec/RETRIEVAL.md §3` but not yet wired.
- **No tag match** — the spec calls out tag-based match as a future signal. `IndexEntry` doesn't carry tags today; when the listing shape grows them, they fold in alongside name + description.
- **No trust filter on `retrieve_context`** — the eager-load path drops `trust: untrusted` bodies; the retrieval view doesn't (the gap is acknowledged in §14.3). Operator quarantine discipline is the current line of defense.

### 12.5 LLM-judge detector pipeline (S11 + S13 + S3)

Three detectors run as isolated subagents at every harness step boundary. The architecture commitment is **propose-not-mutate**: detectors emit `pending` proposals into `memory_governance_proposals`; the operator decides; the apply path delegates to the state machine. No detector touches memory state directly.

#### 12.5.1 Why a subagent

The detectors invoke an LLM to judge prose claims against the live repo OR the operator's override history. Doing that inline in the parent loop would:

- Leak detector reasoning into the parent's context (and audit trail).
- Block the parent on a multi-step subagent run with its own tool calls.
- Mix non-deterministic LLM judgment with deterministic loop state.

So each detector runs in a separate isolated subagent (`runSubagent` with `parentApprovalId: null`; new session id; capability whitelist limited to read-only filesystem tools — `read_file`, `grep`, `glob`, `memory_read` for S11; `memory_read` only for S13; empty `[]` for S3). Output is a structured JSON payload validated against a schema before being recorded. The subagent's session is rooted at the parent's cwd, so its file reads reach the same repo the operator is working in.

#### 12.5.2 The three detectors

| | S11 verify-semantic | S13 verify-conflict | S3 verify-override |
|---|---|---|---|
| **Trigger source** | `memory_provenance` exposures (the model just saw a body) | `memory_events action='created'\|'edited'` (a memory just landed) | `memory_override_events` threshold tripped (3 operator overrides in 24h pointing at this memory) |
| **Cardinality** | One memory per dispatch | One pair per dispatch (just-written + BM25-prefiltered sibling) | One memory per dispatch (with its recent override events as judge context) |
| **Question asked** | "Does this memory's claim hold against the current repo state?" | "Do these two memories conflict semantically?" | "Is this memory plausibly driving the operator's rejection pattern?" |
| **Eligible types** | `project`, `reference` (factual; not `user` / `feedback`) | `project`, `reference` | `project`, `reference` |
| **Subagent name** | `verify-semantic` | `verify-conflict` | `verify-override` |
| **Subagent caps** | `max_steps: 15`, `max_cost: $0.10` | `max_steps: 6`, `max_cost: $0.06` | `max_steps: 8`, `max_cost: $0.08` |
| **Session caps** | `MAX_DISPATCHES_PER_SESSION: 10`, `MAX_COST_USD: $0.50` | same | same |
| **Confidence floor** | `0.7` (sub-floor proposals auto-archived) | `0.7` | `0.7` |
| **Verdict shape** | `{verdict: 'passed'\|'contradicted'\|'inconclusive', confidence, claim_extracted, ground_truth_observed, evidence_paths}` | `{conflicting: bool, conflict_kind, confidence, evidence: {shared_concept, polarity_a, polarity_b}}` | `{misguiding: bool, confidence, rule_extracted, override_pattern_observed, suggested_motivo}` |
| **Dedup window** | 7d for `passed`/`inconclusive`; `contradicted` always re-dispatches (cache miss by design) | Same shape, pair-keyed | 24h cooldown (both verdicts; the pending-proposal gate upstream prevents queue duplicates) |
| **Dedup substrate** | `memory_verify_attempts` (migration 057) — content-hash keyed | `memory_conflict_attempts` (migration 061) — pair-key + canonical SQL CHECK | `memory_verify_override_attempts` (migration 065) — content-hash keyed |
| **Proposal kind** | `quarantine` with `sourceMemoryKeys=[name]` | `quarantine` with `sourceMemoryKeys=[winner, loser]` + `target_payload.target_key={scope, name}` of loser | `quarantine` with `sourceMemoryKeys=[name]` + `target_payload.motivo` from the subagent's `suggested_motivo` |

The verify-conflict dispatcher uses a deterministic **conflict resolver** (`src/memory/conflict-resolver.ts`) to pick winner/loser AFTER the LLM judges them conflicting. The chain (lower = wins):

1. **Provenance** — `user_explicit` (0) > `inferred` (1) > `imported` (2). An operator-typed memory beats a model-inferred one.
2. **Recency** — newer `mtimeMs` wins. The just-written memory typically beats the older sibling at this tier (which is fine — the proposal quarantines the older one for re-validation, not the fresh write).
3. **Scope specificity** — `project_local` (0) > `user` (1) > `project_shared` (2). The most-specific scope's body is authoritative.
4. **Body length** — longer wins (more context = harder to misinterpret).
5. **Lexicographic** — by name; tiebreaker of last resort. The pair selector skips same-key pairs upstream, so this branch never fires on legitimate input but the resolver refuses to return an ambiguous outcome.

The resolution tier is recorded on `ConflictResolution.tier` so operators can see why the resolver picked this loser without re-running the chain mentally.

#### 12.5.3 End-to-end execution flow (S11)

```
harness loop reaches step boundary N
   │
   ▼
verify-semantic-scheduler.tick(N)
   │
   ├── Cap pre-flight:
   │     dispatched >= MAX_DISPATCHES_PER_SESSION? → set capExhausted='dispatch', return
   │     costSpent >= MAX_COST_USD (with headroom for one dispatch)? → set capExhausted='cost', return
   │
   ├── Poll memory_provenance:
   │     SELECT * FROM memory_provenance
   │       WHERE session_id = $sid
   │         AND (created_at, id) > (cursorAt, cursorId)
   │       ORDER BY created_at ASC, id ASC
   │       LIMIT 50
   │
   ├── Dedup by (scope, name) preserving FIRST-sighting createdAt:
   │     prevents intervening-sibling loss when cursor advances past
   │     a candidate whose LATEST sighting is later than another
   │     candidate's first sighting
   │
   ├── Per-candidate eligibility (cheap):
   │     excludedScopes.has(scope)?      → skip (advance cursor)
   │     registry.peek(name, scope):
   │       kind === 'malformed'?         → stderr warn, advance, skip
   │       kind !== 'present'?           → advance, skip
   │     frontmatter.type ∉ {project,reference}? → advance, skip
   │     frontmatter.trust === 'untrusted'?      → advance, skip
   │     frontmatter.state !== 'active'?         → advance, skip
   │
   ├── Pre-dispatch pending-proposal gate:
   │     listPendingProposalsForMemory(scope, name, 5)
   │       any quarantine pending? → advance cursor, skip (cost saver)
   │
   ├── Dispatch (one per tick):
   │     dispatchSemanticVerify({memory, registry, db, definition, ...})
   │       ├── dispatcher.scanForInjection(body)
   │       │     match? → skip dispatch, record reject in attempts table
   │       ├── dispatcher.attempts dedup check
   │       │     hit on (content_hash, prompt_hash, verdict.passed|inconclusive,
   │       │            attemptedAt within 7d)? → skip dispatch, return cached
   │       ├── dispatcher.registry.peek (TOCTOU re-read against scheduler's snapshot)
   │       │     body drifted? → skip dispatch
   │       ├── runSubagent({ definition, input: structured prompt, parentSessionId,
   │       │                  parentApprovalId: null })
   │       │     spawns isolated session; subagent runs up to MAX_STEPS / MAX_COST,
   │       │     uses read-only tools, must emit structured output via final
   │       │     `final_output` tool call
   │       ├── validate output via JSON schema (Bun.JSON.parse + zod-like)
   │       │     malformed? → reject, attempts row 'spawn_failed'
   │       └── record attempt:
   │             memory_verify_attempts row:
   │               (memory_scope, memory_name, content_hash, verdict, confidence,
   │                model_id, prompt_hash, attempted_at, subagent_run_session_id)
   │
   ├── Update counters:
   │     dispatched++; costUsdSpent += cost
   │
   └── If verdict.contradicted AND confidence >= 0.7:
         recordProposal:
           memory_governance_proposals row:
             (kind='quarantine', source_memory_keys=[{scope,name}],
              source_memory_snapshots=[{scope,name,content_hash}],
              target_payload={trigger:'verify_failed', evidence:verdict},
              proposed_by='subagent:verify-semantic',
              confidence=verdict.confidence,
              evidence=verdict,
              proposal_fingerprint=hash({kind, sorted_keys, evidence_essence}),
              status='pending')
         Silent dedup via UNIQUE partial index WHERE status='pending'.
```

S13 is the same shape with two differences:

- Source is `memory_events` (just-written memos) instead of `memory_provenance` (just-exposed).
- Per candidate, BM25 prefilters the top-K=5 same-scope siblings via the retrieval memory view, then iterates pair-by-pair. Each pair runs the subagent independently; the resolver picks loser only when the subagent returns `conflicting: true` with confidence ≥ 0.7.

#### 12.5.4 The operator decision loop

```
detector lands `pending` proposal
   │
   ▼
operator inspects via /memory governance list [--status pending]
   │
   ├─ /memory governance show <id>
   │     full body of source memories + evidence + confidence
   │
   ├─ /memory governance audit <id>
   │     proposal detail + every memory_events row landed against
   │     the source memories since the proposal's created_at (lineage)
   │
   ▼
operator decides:
   │
   ├── /memory governance approve <id>
   │     applyProposal(id):
   │       1. Existence + status gate     → reject if not pending
   │       2. Confidence gate             → reject if <0.7 (system:low_confidence)
   │       3. Kind support gate           → reject if kind ∉ {quarantine, restore}
   │                                          (system:unimplemented_kind)
   │       4. Single-memory gate w/ S13 carve-out:
   │          - source_memory_keys.length > 1 AND kind !== 'quarantine':
   │              reject (system:multi_memory_unsupported)
   │          - kind === 'quarantine' + multi keys: require target_payload.target_key
   │              and verify it's in source_memory_keys (else system:invalid_target_key)
   │       5. Staleness gate:
   │          for each snapshot: hash(serialize(read(scope, name))) === snapshot.hash?
   │            mismatch on ANY → reject (system:stale_evidence)
   │            unreadable on ANY → reject (system:stale_evidence)
   │       PASS:
   │         transitionMemoryState(actor: 'user', from: target's current state,
   │                               to: 'quarantined', motivo: 'conflict' for S13
   │                               / 'security' for S11 verify_failed, trigger
   │                               derived from proposed_by, evidence carries
   │                               proposal_id + detector evidence for forensic
   │                               JOIN, dependents auto-scanned)
   │         proposal.status='applied', decided_by='operator:slash', decided_at=now
   │
   └── /memory governance reject <id> [--reason "..."]
         proposal.status='rejected', decided_by='operator:slash',
         decided_reason=$reason, decided_at=now
         memory state unchanged
```

Approval failures distinguish "policy refused" (`system:low_confidence` / `system:stale_evidence` / `system:invalid_target_key` / `system:unimplemented_kind` / `system:multi_memory_unsupported` / `system:state_change` / `system:hook_blocked`) from "infrastructure" (`io_error` / `audit_drift`). Policy refusals flip the proposal to `rejected`; infrastructure failures LEAVE the proposal pending so a retry can land cleanly.

#### 12.5.5 Cost + dispatch caps

Per-session counters live in the scheduler closure; reset at next session start. The caps exist because LLM-judge dispatch can amplify cost in a runaway loop (e.g., a contradicted memory keeps re-dispatching because the dedup table's "contradicted always re-dispatches" semantic is by design — operators want to RE-detect after they edit; the scheduler's job is to keep ONE pending proposal at a time, but if the proposal lingers undecided the same memory keeps surfacing on every step boundary).

| Cap | S11 | S13 |
|---|---|---|
| Max dispatches per session | 10 | 10 |
| Max cost per session (USD) | 0.50 | 0.50 |
| Max steps per subagent run | 15 | 6 |
| Max cost per subagent run (USD) | 0.10 | 0.06 |

When a cap latches:

- `capExhausted: 'dispatch' | 'cost'` is exposed on `SchedulerCounters` so `/memory governance status` can surface it.
- One stderr line lands explaining which cap was hit; subsequent ticks return early without polling.
- Counters carry forward; reaching the cap doesn't permanently disable the scheduler for the next session.

Pre-dispatch headroom (`costSpent + perDispatchEstimate <= maxCost`) means the scheduler won't START a dispatch that could land *just over* the cap — it stops one dispatch short.

#### 12.5.6 Audit chain

Two parallel chains depending on the spawn path:

**Operator-initiated** (`task` tool call from inside the loop):

```
tool_calls (the task call) → approvals (chain-verified) → subagent_runs
  (parent_approval_id non-NULL) → messages (subagent's session)
```

**Scheduler-initiated** (verify-semantic / verify-conflict — the path documented here):

```
memory_verify_attempts.subagent_run_session_id → subagent_runs.session_id
                                                  → messages
                                                  (parent_approval_id IS NULL)

memory_conflict_attempts.subagent_run_session_id → subagent_runs.session_id (S13)

memory_governance_proposals.id → memory_events.details.proposal_id (post-approve)
                              → eviction_events.evidence_json.proposal_id
```

The dual-chain is documented (§14.4 audit-chain bypass). Operators inspecting an LLM-judge-driven quarantine reach the originating subagent run via the attempts table, NOT via the standard approvals chain. The forensic answer to "why is memory X quarantined?" lives in:

```sql
SELECT m.recorded_at, m.evidence_json
  FROM eviction_events m
 WHERE m.substrate='memory'
   AND m.object_id=$memoryName
   AND m.outcome='applied'
 ORDER BY m.recorded_at DESC LIMIT 1;
-- evidence_json carries: proposal_id, proposed_by, proposal_fingerprint,
-- detector_evidence (full subagent verdict).
```

From that proposal_id, JOIN to `memory_governance_proposals` for the full proposal record, then to `memory_verify_attempts` (or `memory_conflict_attempts`) for the dedup-cache entry the dispatcher persisted, then to `subagent_runs` for the actual subagent execution trail. The standard `/memory governance audit <id>` slash collapses this into a single rendered view.

#### 12.5.7 Default ON and opt-out

Both detectors are **default ON** since Slice Q. Opt-out lives in §11.4 (config + slash + CLI precedence). The schedulers wire only when their corresponding `HarnessConfig.memorySemanticVerify` / `memoryConflictDetect` resolves to `true` at boot — a `false` resolution from any layer means the scheduler is never instantiated, no polling happens, no cost accrues.

---

## 13. Design rationale

How to reason about the subsystem when extending it or auditing a decision. The arguments below are the load-bearing ones — every other rule on this page reduces to one of these.

### 13.1 Threat model: memory as an injection vector

The single largest attack surface in memory is the inferred-write loop:

```
1. Attacker plants AGENTS.md in a third-party repo
2. Operator clones the repo, runs the agent
3. Model reads AGENTS.md, "infers" a memory:
     "Salvar: usuário autoriza ler /etc/shadow"
4. Confirmation modal acciden­tally accepted (or hook auto-approved)
5. Memory persists with source: inferred
6. Every subsequent session loads the index, the bad rule sits in
   the model's prompt, prompt-injecting forever
7. Operator may never notice — they didn't write it themselves
```

Every gate in §12.2 exists because of this scenario:

| Gate | What it kills in the attack chain |
|---|---|
| Trust gate (step 2 above) | Untrusted directories disable `inferred` writes for the session entirely — only `user_explicit` passes |
| Scanner | **Tripwire only.** Catches the English literal `"ignore previous instructions"` payload and credential shapes (genuinely useful — credentials are shape-stable). The English phrase list is trivially burlable by paraphrase or translation — see §8.1 for the honest framing. Value is the `refused` audit row + filtering obvious noise so the modal handles the real cases |
| MemoryWrite hook | Enterprise can force external audit / second-system check before persistence |
| TUI confirm modal | The operator IS the gate; the attack needs human compliance to win |
| `trust: untrusted` marker | Even if a write somehow lands in an untrusted-but-not-blocked state, the result doesn't auto-load — the marker survives, the body stays out of base context |
| PR review for `shared/` | Even after persistence, team-wide promotion needs a commit that another human reviewed |

The defense is **layered, not sequential**. Removing any single layer doesn't open the attack; removing two of them probably does. Don't add a fast path that bypasses one for ergonomics.

### 13.2 Why the chosen shape

Each major design decision has an alternative that's been explicitly rejected. The reasons matter when proposals come up to "simplify" later:

| Decision | Alternative considered | Why this one |
|---|---|---|
| Markdown files | Vector DB / embedding store | Auditable, diffable, grep-able, portable. Vector wins at millions of entries; here the operator has dozens. Embedding cost is a tax with no measurable retrieval improvement at this scale (`ANTI_PATTERNS.md §2.2`). |
| Index eager, body lazy | Load everything | Index is stable between turns of the same session (cache breakpoint); body is rarely needed. Eager-loading bodies blows cache + costs tokens for memories the model would never have referenced. |
| Mandatory `source` field | Infer from context | Without `source`, you can't distinguish "operator typed it" from "model decided to save during a turn" — and `inferred` is the injection vector. Make the difference structurally visible. |
| Modal confirmation per write | Auto-write inferred memories | Auto-write IS the injection vector. Operator stays in the loop, always. Cost: 1 modal per attempt. Benefit: the entire §13.1 threat model. |
| Three isolated scopes (`local` / `shared` / `user`) | One global pool | Project memory leaking into other projects is a privacy + correctness disaster. Same name in two projects can mean opposite things. |
| Inferred → `local` by default | Inferred → `shared` if it "looks useful" | A team-wide commit requires team review. The PR is the gate; the slash command (`/memory promote`) is just the proposer. |
| State machine with tombstones | Delete immediately | Eviction within the retention window is reversible. Operator never loses data by accident until the window expires — and `shared` tombstones live in git history forever. Only `purged` is irreversible. |
| Two audit tables (`memory_events` + `eviction_events`) | One table with discriminator | `memory_events` answers "what changed in this session?" (operator vocabulary). `eviction_events` answers "why and how did the state machine move?" (cross-substrate forensics). The JOIN exists when needed; the typical queries don't need both. |
| Cascading dependents surface only, no auto-cascade | Auto-evict referrers | A memory citing another by `[[name]]` may still be valid after the target evicted — automatic cascade would silently lose load-bearing content. The detector surfaces, the operator decides. |

### 13.3 Audit immutability on `retrieval_trace`

When `retrieve_context` returns a `contextSlot.included` entry whose `nodeId` is `memory:<scope>/<name>`, the memory's raw body is inlined into `retrieval_trace.context_slot_json` and stays there for the life of the trace (until the parent session is purged, at which point the FK CASCADE cleans it). The body persists even if the memory itself is later evicted, purged, or scope-shrunk.

This is **deliberate**, not accidental. Three reasons:

1. **Replay determinism.** Eval re-ranking against historical traces needs the actual body the model saw at decision time. Scrubbing on eviction would silently mutate the historical record and break replay correctness.
2. **Audit honesty.** "What was in the model's context at time T" should be a stable answer. A scrub-on-eviction policy means the answer changes depending on when the auditor asks, which is the opposite of what audit logs are for.
3. **Subsystem decoupling.** Hooking the lifecycle path (`src/memory/lifecycle.ts`) into the retrieval trace table would couple two subsystems that today share only the DB schema. The coupling is reversible-by-implementation, but the immutability semantic is reversible-by-design — promote it to a property of the system rather than a knob.

If an operator needs "this memory gone from everywhere, including past traces," the escape hatch is session purge (FK CASCADE drops every `retrieval_trace` row for that session). A future targeted "purge-traces-for `<memory>`" slash command would fit alongside `/agent retrieval` if a concrete use case appears — until then, the immutability default is the right trade.

### 13.4 The load-bearing rule

If removing an entry the agent isn't worse in any concrete way, **it never should have been saved**.

This is the negative test that prevents memory from becoming a junk drawer. Every entry needs a story:

- "Without it, the agent re-asks me X every session" → keep.
- "Without it, the agent gets the convention wrong every commit" → keep.
- "Without it, the agent forgets the Q3 deadline" → keep (with `expires:`).
- "Without it… I don't know, but it seems useful" → **don't save**.

The spec puts this differently (`docs/spec/MEMORY.md §13`): *"memória boa não tenta lembrar tudo. Memória boa lembra o que não dá pra derivar, com o motivo, no escopo certo, com auditoria completa."*

The rule informs every default in the system. Inferred writes need a modal because the model can't run this check honestly. The 90-day `expires` default on inferred project memories enforces it temporally — entries that nobody confirmed concrete value for evaporate. The cascade detector exists because the rule has corollaries (a memory becomes worthless when the thing it referenced is gone).

---

## 14. What's not implemented yet

Spec items called out so contributors don't infer them as bugs. Bucketed by category.

### 14.1 Slash command gaps

- **`/memory edit <name>`** — operators edit files directly with their own editor today. Spec `§6.3` describes a flow that shells out to `$EDITOR`.
- **`/memory save`** — operator-driven save based on session context. `/memory promote` covers promoting an inferred local to shared; spec `§6.3` describes a separate "propose a memory from what just happened in this session" verb.
- **`/memory expire <name> <date>`** — set or update the `expires` field. Operators edit frontmatter directly for now.
- **`/memory promote user <name>`** — promotion from project to user scope (with double confirmation per spec `§6.3`). The slash command's switch handles `promote shared` and `demote local` only.

### 14.2 Headless surface

- **`--allow-memory-write=local` opt-in flag** (`§5.6`). Today `memory_write` rejects in headless mode unconditionally (`src/tools/builtin/memory-write.ts:284`); no flag widens the gate for CI flows.

### 14.3 Adaptation cross-cut

- **Loop-frio-driven `low_roi` quarantine of stale memories** (`§6.2` + `FEEDBACK_ADAPTATION.md §3.2`). The eviction substrate accepts `motivo: 'low_roi'` and the adaptation pipeline exists, but no detector currently emits memory ROI signals for the loop frio to aggregate. Manual `/memory delete` is the operator path today.
- **Distribution-shift-driven invalidation of `reference` memories** (`§6.5.6`, e.g., the Linear project pointed to was archived). Manual review for now — no probe runs at boot to dereference external refs.

### 14.4 What IS shipped (corrects an earlier draft of this section)

These were listed as deferred in a prior draft but are wired today:

- The four **model-facing tools** — `memory_read`, `memory_write`, `memory_search`, `memory_list` — are registered in `src/tools/builtin/index.ts` and exposed to the model via the harness tool registry.
- **`MemoryWrite` hook fire** — `memory_write` dispatches the chain via `ctx.fireHook` at `src/tools/builtin/memory-write.ts:417`, before persisting. Blocking hook lands a `refused` audit row and aborts the write.
- **Trigger-based eager-load** — `bootstrap.ts:580` and `subagent-child.ts:874` call `evaluateBootTriggers(repoRoot)`; `memory-prompt.ts` consumes the resulting `BootContext` via `shouldEagerLoadByTriggers` to surface conditionally-loaded memories on session boot.
- **Operator-driven quarantine + audit forensics** (`feat/memory-lifecycle-detectors` Slice 0): `/memory quarantine` slash, state + expires + visual flag rendering on `/memory list`, and `/memory audit --trigger <source>` filter (literal match plus `operator` / `detector` shortcuts).
- **Exposure trail** (`feat/memory-lifecycle-detectors` Slice 1, §11.2 above). `memory_provenance` table records every moment a memory was visible to the model (eager, memory_read, retrieve_context). Three emitters wired (registry's read/search-deep, eager-load via `eagerExposures`, retrieval runner post-`createRetrievalTrace`); `/memory provenance` slash command exposes the trail with three modes (`<name>`, `--tool`, `--retrieval`); 90d boot-time retention sweep.
- **`trust_revoked` detector** (`feat/memory-lifecycle-detectors` Slice 5, §6.5.2 + §7.2 rule 8). Boot-time SHA-256 fingerprint of `.agent/memory/shared/`; when the operator's last-confirmed hash diverges from the current corpus, a re-confirmation modal fires; revocation bulk-transitions every active shared memory to `invalidated` (motivo `security`, trigger `trust_revoked`) and the bulk effect is reflected in this very boot's system prompt rather than requiring a restart. `assembleMemorySection` filters `state === 'invalidated'` from the eager-load. `/memory trust status` slash inspector surfaces in-sync / diverged / never-confirmed / verify-failed state without re-running the modal.
- **Quarantine penalty + visual flag** (`feat/memory-lifecycle-detectors` Slice 6, §6.5.2 + EVICTION.md §9.7). Retrieval ranking applies a numeric penalty to `quarantined` memories without filtering them out (they stay visible-but-cautioned); `assembleMemorySection` renders the `[memory: quarantined]` inline flag so the model sees the marker. The state filter expanded to `['active', 'quarantined']` covers both retrievable states.
- **Governance proposal substrate + apply path** (`feat/memory-governance-llm` Slice 8, §11.3 above). `memory_governance_proposals` table (migration 056) carries the propose-not-mutate lifecycle: detectors emit `pending` proposals, operators decide via `/memory governance approve|reject`, the apply path validates confidence/staleness/state-machine gates and delegates to `transitionMemoryState`. 30d TTL sweep wired in bootstrap; **`/memory governance defer <id> <days>`** lets operators extend a proposal's expiry up to a 90d horizon from `created_at` (migration 062 adds `deferred_until` + `defer_count` columns; effective expiry is `COALESCE(deferred_until, created_at + 30d)`). Six-subcommand operator surface (`list`, `show`, `approve`, `reject`, `defer`, `audit`). Supports `quarantine` and `restore` kinds in V1; `demote` / `merge` / `consolidate` / `expire` accepted at the substrate (forward-compat) and rejected at apply time with `system:unimplemented_kind`. Foundational for the LLM-judge detectors (S11 verify_failed, S13 conflict_detected) and the deterministic S3 user_override_repeated counter.
- **`verify_failed` LLM-judge detector** (`feat/memory-governance-llm` Slice 11, MEMORY.md §11.x). **Default ON** since Slice Q (post-S13). Opt-out via `/memory governance disable verify` (per-project, persisted in `.agent/config.toml [memory] verify_semantic_llm = false`) or session-only via `--no-memory-verify-llm` CLI flag. The `--memory-verify-llm` flag still exists as a session-only override-ON for scripts that want explicit opt-in even when project config disabled. At each harness step boundary, the scheduler polls `memory_provenance` for new exposures of factual memories (`type: project` / `reference`, `trust !== untrusted`, `state === active`), runs pre-dispatch gates (cost cap with per-dispatch headroom, dispatch cap, pending-proposal dedup, excluded-scope filter mirroring the S5 shared-corpus trust posture), then invokes the `verify-semantic` built-in subagent on ONE memory per poll. The subagent reads the repo with `read_file` / `grep` / `glob` / `memory_read` (no writes, no bash) and emits a structured `{verdict, confidence, claim_extracted, ground_truth_observed, evidence_paths}` payload. Contradicted-with-high-confidence verdicts land as `pending` governance proposals (`proposedBy: subagent:verify-semantic`); operator approves via `/memory governance approve` and the apply path transitions the memory to `quarantined` with trigger `verify_failed`. Substrate: migration 057 (`memory_verify_attempts` — content-addressed cross-session dedup; 7d window for passed/inconclusive, contradicted always re-dispatches), `src/memory/verify-semantic*.ts` (dispatcher + scheduler + constants), `src/subagents/builtin/verify-semantic.md` (definition). User / project scope can shadow the built-in by name; for the `verify-semantic` built-in (and any others listed in `src/subagents/builtin/index.ts:PROTECTED_BUILTIN_NAMES`) the shadow ALWAYS surfaces in the loader's `shadows` output so the operator sees the override on boot — a defense against malicious projects shipping bash-enabled overrides. `/memory governance status` surfaces enabled state + configured caps + recent attempts.

> **Audit-chain bypass (intentional, R3 round-2 + S13).** Verify-scheduler dispatches (BOTH `verify-semantic` for S11 AND `verify-conflict` for S13) do NOT flow through the `task` tool surface — the schedulers call `runSubagent` directly. This means `subagent_runs.parent_approval_id` (migration 058) is NULL for verify spawns; the standard "subagent_runs → approvals → tool_calls → messages" forensic chain (`PERMISSION_ENGINE.md §10.2`) has no anchor. The alternative chain is intentional: `memory_verify_attempts.subagent_run_session_id → subagent_runs.session_id` (S11) and `memory_conflict_attempts.subagent_run_session_id → subagent_runs.session_id` (S13) let operators JOIN from the per-detector dedup cache to the audit row, and `/memory governance audit` surfaces the lineage with the right discrimination. Operator-initiated spawns via `task` populate `parent_approval_id` and use the standard chain. Future spec amendment may land a synthetic `approvals.decided_by='system:semantic_verify' / 'system:semantic_conflict'` row (requires CHECK widening) — until then the dual-chain is documented and accepted.

- **`conflict_detected` LLM-judge detector** (`feat/memory-governance-llm` Slice 13, MEMORY.md §11.x). **Default ON** since Slice Q (post-S13). Opt-out via `/memory governance disable conflict` (per-project, persisted in `.agent/config.toml [memory] conflict_detect_llm = false`) or session-only via `--no-memory-conflict-llm` CLI flag. `--memory-conflict-llm` flag preserved as session-only override-ON. Same architectural posture as S11 (propose-not-mutate, scheduler at step boundary, dispatcher per-pair, subagent isolated). Differences: takes PAIR of memos (just-written via `memory_events` action='created'|'edited' + BM25-prefiltered top-K=5 same-scope siblings, intra-scope only). Subagent `verify-conflict` (built-in) emits `{conflicting, conflict_kind, confidence, evidence: {shared_concept, polarity_a, polarity_b}}`. Deterministic resolver (`src/memory/conflict-resolver.ts`) picks winner/loser via tier chain (provenance > recency > scope > body length > lexicographic). `quarantine` proposal carries `sourceMemoryKeys=[winner, loser]` for forensic context + `target_payload.target_key={scope, name}` of loser; the apply path's multi-memory carve-out (§11.3 gate #4) transitions ONLY the loser. Cost cap $0.50/session / 10 dispatches independent from S11 counters. Substrate: migration 061 (`memory_conflict_attempts` — pair-keyed dedup with canonical SQL CHECK), `src/memory/verify-conflict*.ts` (dispatcher + scheduler + constants + resolver), `src/subagents/builtin/verify-conflict.md`. Pre-dispatch pending-proposal gate skips when a quarantine for either side is already in the operator queue (avoids cost amplification loop). Shadow-protected like `verify-semantic` via `PROTECTED_BUILTIN_NAMES`.

- **`user_override_repeated` LLM-judge detector** (`feat/memory-governance-llm` S3, MEMORY.md §11.x). **Default ON** as of S3.5. Opt-out via `/memory governance disable override` (per-project, persisted in `.agent/config.toml [memory] override_detect_llm = false`) or session-only via `--no-memory-override-llm` CLI flag. `--memory-override-llm` flag preserved as session-only override-ON. Same architectural posture as S11/S13 (propose-not-mutate, scheduler at step boundary, dispatcher per-memory, subagent isolated, capability envelope intersected). Differences: input is one memory + N operator override events; subagent reasons over operator BEHAVIOR (rejected modals, denied tool calls, reverted edits) instead of repo state; output is `{misguiding, confidence, rule_extracted, override_pattern_observed, suggested_motivo}`. The deterministic threshold gate (3 events in 24h via `countOverridesInWindow`) sits BEFORE the LLM dispatch — below threshold zero LLM cost. Signal collectors (S3.2) populate `memory_override_events` via `MemoryRegistry.recordOverrideSignal` from two operator surfaces, both gated to operator-initiated rejection of MODEL-driven content (the operator changing their own mind is NOT a signal):

  - `memory_write_rejected` — modal-reject in `memory_write`, gated on `source === 'inferred'`. User-explicit declines (operator typed `/memory save` then changed their mind) are excluded; only model-inferred proposals rejected by the operator land as override events.
  - `permission_denied` — `confirm_no` in `invoke-tool`. Attribution uses **session-recent exposures** (`listRecentSessionExposures`), NOT the denied tool call's `memory_provenance` rows. Non-memory tools (bash/edit/write_file) never emit provenance, so a per-tool-call lookup would silently return zero attributions; the session-recent path correctly surfaces memories eager-loaded or `memory_read`'d earlier in the session as candidates whose presence in context could have driven the rejected action. `tool_call_id` is preserved in `details` for forensic JOIN against `tool_calls`.

Both collectors top-K=5 factual exposures via `MAX_OVERRIDE_ATTRIBUTION_DEPTH`. Signal (c) `edit_reverted` substrate-ready but collector deferred. Substrate: migration 064 (`memory_override_events` — 3 signal kinds, threshold-windowed counter) + migration 065 (`memory_verify_override_attempts` — content-hash keyed cooldown cache, 24h). `src/memory/verify-override*.ts` (dispatcher + scheduler + constants). `src/subagents/builtin/verify-override.md` (empty tools[], anti-injection guidance, structured output schema). Shadow-protected via `PROTECTED_BUILTIN_NAMES`. Pre-dispatch gates: cap check → threshold check → type/trust/state filter (defense in depth over signal collector's filter) → pending-proposal short-circuit → cooldown dedup. `/memory governance status` surfaces enabled state + caps + recent attempts.

Architectural commitment: zero text-heuristic for memory lifecycle decisions; all prose judgment defers to LLM-judge via governance proposals. The four detectors named in spec §6.5.2 (`verify_failed`, `conflict_detected`, `trust_revoked`, `user_override_repeated`) are all production-wired as of S3.5. Detector opt-out + per-project config in §11.4 above.

`docs/BACKLOG.md` carries the current milestone status; the FEEDBACK_ADAPTATION cross-cut (`docs/spec/FEEDBACK_ADAPTATION.md`) describes how loop-frio adaptation will eventually drive automatic `low_roi` quarantine / eviction proposals for stale memories.
