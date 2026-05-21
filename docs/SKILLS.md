# Forja Skills Operator Guide

This document describes Forja's skills subsystem: what a skill is, where skill files live on disk, how the catalog resolves them, the tools the model uses to invoke them, the `/skill` command operators use day-to-day, the audit trail, and the seed catalog `agent init` installs.

The canonical specification lives in `docs/spec/SKILLS.md` (PT-BR), with cross-cuts in `docs/spec/RETRIEVAL.md §3.4` (gating) and `docs/spec/AUDIT.md` (event tables). This document is the English-language operational reference; when the two diverge, the spec wins.

---

## 1. What skills are

A **skill** is a gated, reusable **procedure** — a markdown file with YAML frontmatter and a prose body. The body is not code; it is a vetted set of steps the model follows when a goal matches the skill. Skills turn "the model reinvents a procedure every time" into "the model invokes a procedure that was written down once and reviewed."

What a skill **is**:

- A repeatable workflow worth not improvising — `git bisect` to pinpoint a regression, threat-modelling a component, triaging a flaky test.
- Progressive disclosure: the catalog (name + description + scope) sits in the system prompt eagerly; the **body loads only when the skill is invoked**. A project with 40 skills costs 40 one-line descriptions of context, not 40 full procedures.
- Scope-isolated and precedence-resolved, the same way memory is — a project skill overrides a personal one of the same name.

What a skill **is not**:

- A tool. Tools are code the harness executes; a skill body is prose the model reads and follows. A skill may *name* tools it expects to use (`tools:` frontmatter), but it does not execute anything itself.
- A memory. Memory is non-derivable *facts*; a skill is a *procedure*. They share the scope model and the audit posture, nothing else.
- System instruction. A skill body is **content** — injected behind a trust marker (§9). It cannot change how the agent operates or what it permits.

### 1.1 Architecture at a glance

Storage and pure logic live under `src/skills/`; the audit table lives in `src/storage/`; the model- and operator-facing surfaces live under `src/tools/` and `src/cli/`.

```
                        ┌─────────────────────────────────────┐
                        │  src/skills/catalog.ts              │
                        │  createSkillCatalog                 │
                        │  - scans every scope at construction│
                        │  - precedence-resolves name clashes │
                        │  - list / lookup / read / filtered  │
                        │  - recordEvent / recordSurface      │
                        └───────┬─────────────────────┬───────┘
                                │                     │
        ┌───────────────────────┤                     ├───────────────────────┐
        ▼                       ▼                     ▼                       ▼
  types.ts              loader.ts / paths.ts    lifecycle.ts          storage/repos/
  SkillScope            scanScope               createSkill           skill-events.ts
  SkillFrontmatter      readSkillByName         moveSkill             surfaced / invoked
  SkillFile             skillFilePath           deleteSkill           / filtered rows
  frontmatter.ts        (scope roots,           (create / promote
  parse / serialize     sandbox checks)          / demote / delete)
        │
        │  consumed by
        ▼
  ┌──────────────────────┬─────────────────────────┬──────────────────────────┐
  ▼                      ▼                         ▼                          ▼
src/tools/builtin/   src/cli/skills-prompt.ts   src/cli/slash/commands/   src/cli/init-skills/
skill-invoke         assembleSkillCatalog       skill.ts                  CANONICAL_SKILLS
skill-list           Section — the eager        /skill list/show/new      (15 seed skills,
skill-show           `# Skills` prompt block    /promote/demote/delete    installed by `agent init`)
```

One scan, two outputs: every scanned file becomes either a catalog **entry** (a resolved skill) or a **filtered** record (malformed, name-mismatched, or shadowed) — never silently dropped.

---

## 2. The skill file

A skill is a single markdown file: a YAML frontmatter block delimited by `---`, then a prose body.

```markdown
---
name: git-bisect-regression
description: Pinpoint the commit that introduced a bug with an automated binary search (git bisect run).
version: 1
trigger_keywords: [git, bisect, regression, when did this break, culprit commit]
tools: [bash]
source: project_shared
created_at: 2026-05-21
---

Use `git bisect run` to binary-search for the first bad commit.

1. Confirm a reliable reproduction — a command that exits non-zero on
   the bug and zero when it's absent.
2. `git bisect start`, mark a known-good and known-bad commit.
3. `git bisect run <your-command>` — git drives the search.
4. Report the culprit commit; `git bisect reset` to restore.
```

### 2.1 Frontmatter

| Field | Required | Type | Meaning |
|---|---|---|---|
| `name` | yes | string | Canonical id. Kebab-case; **must match the filename** (`<name>.md`). |
| `description` | yes | string | One line, trigger-shaped, **≤ 120 characters**. This is what the catalog surfaces. |
| `version` | no | integer | Bumped when the body changes semantically. Audit / changelog only. |
| `trigger_keywords` | no | string[] | Hints for *when* the skill applies. Declarative in v1 — `skill_show` displays them; the catalog does not gate on them. |
| `tools` | no | string[] | Tools the skill body expects to use. Declarative — see §6.1. |
| `requires` | no | string[] | Subsystem capabilities the skill assumes. Declarative — see §6.1. |
| `source` | no | enum | Provenance: `user` / `project_shared` / `project_local` / `imported`. |
| `created_at` / `updated_at` | no | `YYYY-MM-DD` | Authoring dates. |
| `expires` | no | `YYYY-MM-DD` | Review-by date. An expired skill is still invoked, but with a warning — see §6.1. |

`name` and `description` are the only required fields. A file that fails validation (missing a required field, an over-long description, a non-kebab-case name) is **filtered**, not loaded — see §4.

### 2.2 Body

Everything after the closing `---` is the body — the procedure. It is plain prose or a numbered list, written for the model to follow. There is no schema; a skill is prose-driven, not a function call. Keep bodies short and concrete: the body is what lands in the model's context window on invocation.

---

## 3. Scopes & disk layout

A skill lives in one of three scopes. Discovery is a **directory glob** — there is no index file (unlike memory's `MEMORY.md`); the catalog *is* the index.

| Scope | Location | Git |
|---|---|---|
| `user` | `~/.config/agent/skills/<name>.md` (XDG; `%APPDATA%` on Windows) | personal, not in any repo |
| `project_shared` | `<repo>/.agent/skills/shared/<name>.md` | committed — the team's skills |
| `project_local` | `<repo>/.agent/skills/local/<name>.md` | gitignored — your private project skills |

**Precedence: `project_local` > `project_shared` > `user`.** When the same `name` exists in more than one scope, the highest-precedence file wins; the others are recorded as `shadowed` (§4). `agent init` writes `skills/local/` into `.agent/.gitignore`, mirroring `memory/local/`.

A fourth scope, `imported` (`.agent/skills/imported/<source>/<name>.md`), is reserved for v1's successor — see §11.

---

## 4. The catalog

`createSkillCatalog` scans every scope at construction and holds the result as an in-memory snapshot. The bootstrap builds one catalog per session.

**Resolution** is two passes:

1. Scan each scope. Each file is parsed; a file that fails to parse, is a symlink, or whose `frontmatter.name` differs from its filename is set aside as a **filtered** record with the reason.
2. Resolve precedence. The first candidate seen for a name (scanning `project_local` → `project_shared` → `user`) wins; later same-name candidates become `filtered: shadowed`.

The catalog exposes:

- `list(scope?)` — the resolved skills (winners), sorted by name.
- `lookup(name)` — the resolved entry for a name, or null.
- `read(name, scope?)` — load a body. Without `scope`, resolves by precedence; with `scope`, reads that scope strictly (so a *shadowed* skill is still reachable). The body is **re-read from disk every call** — the catalog caches frontmatter, never bodies, so an operator hand-edit between boot and invocation is reflected.
- `filtered()` — every dropped file with its reason (`malformed` / `name_mismatch` / `shadowed`). §3.5 of the spec mandates that resolution is explicit and auditable, never silent — this list is that record.
- `reload()` — re-scan from disk (used by `/skill` after a mutation).

**Surface eager, body lazy** (spec §4.1): the catalog's name + description + scope go into the system prompt at boot; a body is loaded only when the model invokes the skill.

---

## 5. The system-prompt surface

`assembleSkillCatalogSection` (`src/cli/skills-prompt.ts`) renders the resolved catalog as a `# Skills` block, composed onto the system prompt by the bootstrap:

```
# Skills

Reusable, vetted procedures you can invoke when a goal matches one. …

- [project_shared] git-bisect-regression — Pinpoint the commit that introduced a bug …
- [project_shared] triage-flaky-test — Diagnose a non-deterministic test failure …
- [user] my-commit-style — …
```

An empty catalog yields no section at all. The block is `catalog.list()` verbatim — which keeps it identical to what the `surfaced` audit records (§8).

---

## 6. The tools

Three builtin tools, registered in `BUILTIN_TOOLS`, gated on a wired skill catalog. They mirror the memory tools (`memory_read` / `memory_list`).

### 6.1 `skill_invoke`

Loads a skill and injects its procedure into the turn. The body comes back wrapped in the `<skill>` trust marker (§9), and an `invoked` audit row is recorded.

- Resolves by precedence, or by a pinned `scope`.
- Surfaces the frontmatter `version` / `tools` / `requires` / `expires` in the result. **`tools` and `requires` are declarative, not gated** — `tools:` is advisory (the permission engine still authorizes every real tool call), and a `requires:` pre-flight needs a subsystem-capability registry that does not exist in v1.
- An **expired** skill (`expires` before today) is invoked anyway, but the operator gets a warning and the audit row's `details` carries `expired: true` (spec §5.4).
- An optional `args` object is opaque context, echoed back; it is not schema-validated — the skill body decides what to do with it.
- A body containing a literal `</skill>` is refused as malformed: it could break out of the trust marker.

### 6.2 `skill_list`

Returns the resolved catalog — name + description + scope per skill, the same set the system prompt surfaces. Loads no bodies. Optional `scope` filter.

### 6.3 `skill_show`

Prints a skill's body for inspection **without invoking it** — read-only, records no `invoked` event, applies no trust marker. The catalog's `read()` is deliberately pure (no auto-audit) precisely so `skill_show` can read a body without it counting as an invocation.

---

## 7. The `/skill` command

The operator surface for the skills lifecycle (spec §6). The disk mutations live in `src/skills/lifecycle.ts`; the command is a thin dispatch layer over them and the catalog. After any mutation it `reload()`s the catalog so the live `skill_list` / `skill_invoke` tools see the change within the session.

| Subcommand | Effect |
|---|---|
| `/skill list` | List the resolved catalog and any filtered files. |
| `/skill show <name>` | Print a skill's body. |
| `/skill new <name>` | Scaffold a template skill in `project_local`. |
| `/skill promote shared <name>` | Move `project_local` → `project_shared`. |
| `/skill promote user <name>` | Move a project skill → `user` scope. **Requires `--confirm`.** |
| `/skill demote local <name>` | Move `project_shared` → `project_local`. |
| `/skill delete <name>` | Remove a skill file. **Requires `--confirm`.** |

Destructive operations gate on an explicit `--confirm` token: `/skill delete foo` prints what it will do and asks for a re-run as `/skill delete foo --confirm`. `promote user` crosses into the host-global scope and is gated the same way. The within-project moves (`promote shared`, `demote local`) are reversible and report what they did without a confirm step. A `delete` that leaves a shadowed same-name skill resolvable says so in its output — never silent (spec §6.3).

---

## 8. Audit — `skill_events`

Every interaction with the catalog is recorded in the `skill_events` table (migration 067), with `action` one of:

- `surfaced` — the skill entered a session's prompt catalog. Emitted once per session at boot (`recordSurface`, right after the session row exists).
- `invoked` — `skill_invoke` loaded the body. Carries `version` (and `expired`) in `details`.
- `filtered` — a scanned file was dropped. Carries the reason (`malformed` / `name_mismatch` / `shadowed`) in `details`.

A row carries `scope`, `skill_name`, `session_id` (nullable FK, `ON DELETE SET NULL`), `cwd`, `created_at`, and a JSON `details`. The emit is **best-effort**: no DB ⇒ no-op; a DB failure is logged to stderr as `AUDIT DRIFT`, never thrown — an audit miss must not break the model's turn or the boot path.

Correlating `surfaced` against `invoked` per skill is the operator's signal for tuning a skill's `description`: a skill surfaced often but never invoked has a description that is not triggering. `recordSurface` is idempotent per session, so a resumed session does not double-count.

The audit table is retained indefinitely in v1; a `pruneSkillEvents` + `agent gc` retention pass is a noted follow-up.

---

## 9. Trust & injection

A skill body is **content the model follows**, not instruction about how the agent operates. `skill_invoke` returns the body delimited by a trust marker:

```
<skill name="git-bisect-regression" scope="project_shared">
…the procedure…
</skill>
```

The model is trained to treat text inside `<skill>…</skill>` as a procedure to carry out — never as a directive that changes its operating rules or permission posture. This is the same trust boundary memory uses for injected entries. A malicious skill in a shared scope therefore cannot smuggle in "approve everything" or "skip confirmations": such text, inside the marker, is read as a (bad) procedure, not obeyed as policy. The permission engine still gates every tool call a skill body leads the model to make.

`skill_invoke` refuses to wrap a body that itself contains a literal `</skill>` — that would let the body break out of the marker.

---

## 10. The seed catalog

`agent init` scaffolds a fifth artifact (after permissions, gitignore, config, playbooks): the seed skill catalog. The 15 canonical skills are bundled into the binary (`src/cli/init-skills/`, imported as text assets) and written into `<cwd>/.agent/skills/shared/` — the catalog scan picks them up at the next REPL boot.

The seed set spans git workflows (`git-bisect-regression`, `git-resolve-conflict`, `git-rewrite-history`, `git-recover-lost-work`), debugging and performance (`debug-failure`, `triage-flaky-test`, `profile-hotspot`, `add-regression-test`), security and forensics (`threat-model-component`, `investigate-suspicious-host`, `acquire-forensic-evidence`), databases (`pg-blocked-sessions`, `pg-heavy-queries`), and bulk file operations (`bulk-edit-files`, `safe-bulk-delete`).

`agent init --only=skills` re-runs just this step; `--force=skills` overwrites existing files. Each step is skip-if-exists, so a re-run after an operator's hand edits is safe.

---

## 11. Not in v1

The following are specified but deliberately deferred:

- **`/skill capture`** — turn the last N successful steps of a session into a skill candidate (spec §6.1). Needs a session-step-to-procedure synthesis path.
- **The `imported` scope** — skills pulled from an external source, carrying a lower trust tier (spec §3.4, §7.2). The scope value exists in the type; the discovery, lifecycle, and trust handling are v2.
- **The decay sweep** (spec §6.4) — a skill not invoked in 90 days becomes an archive candidate; a weekly hook surfaces the list. `expires` (the per-skill review date) is honored at invocation time in v1; the automatic decay sweep is v2.
- **`tools` / `requires` gating** — surfaced for the model's awareness in v1, enforced in v2 once a subsystem-capability registry exists.
