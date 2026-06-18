# Forja Tools Reference

This document is the living reference for Forja's builtin tools: the catalog of
what ships today, the visible-vs-deferred surface model, and the end-to-end
checklist for adding a tool. It is the English operational companion to the
canonical spec in `docs/spec/AGENTIC_CLI.md §7` (tool system) and `§7.6`
(on-demand surface), PT-BR; when the two diverge, the spec wins. The spec's §7.1
"Tools v1" list is intentionally minimal and lags the registry — **this catalog
is the source of truth for what is actually registered.**

Root principle (§1.3): *10 well-designed tools beat 40 generic ones.* Every tool
here earns its place, or it is deferred (§7.6) / withdrawn from the surface.

---

## 1. The surface model (§7.6)

The set of registered tools (38) is larger than what the model sees on any given
turn. Two tiers:

- **Visible** (24) — the base surface, sent in the provider request every turn.
  Covers the common path.
- **Deferred** (14) — registered and fully callable, but kept *out* of the base
  surface to cut selection pressure (principle 3). The model reaches one via
  **`tool_search`**, which reveals it (sticky for the session). A catalog of the
  deferred set (name + one-line blurb) is generated into `tool_search`'s
  description, so the model knows what it can search for.

Deferral is **not** a permission gate — dispatch resolves a tool by name from the
registry regardless of the surface. It only governs what the model is *shown*.

Surface gates that also drop a tool (independent of deferral): a tool flagged
`requiresOperatorConfirm` (needs the REPL modal — e.g. `clarify`, `memory_write`)
or `requiresReminderScheduler` (needs the REPL clock — the `reminder` family) is
hidden in headless / one-shot / subagent runs where that surface isn't wired.

Subagents bypass deferral entirely: a subagent runs against a registry already
narrowed to its `tools:` whitelist (the curation), so every whitelisted tool is
directly visible.

---

## 2. Catalog

`V` = visible, `D` = deferred. `W` = declares `writes: true` (triggers a
checkpoint). Gate = an extra surface requirement.

### Filesystem — read & search (`fs.read`)
| Tool | | Purpose |
|---|---|---|
| `read_file` | V | Read a text file (offset/limit, line numbers). |
| `glob` | V | List files matching a glob pattern. |
| `grep` | V | Search file contents via ripgrep. |

### Filesystem — write (`fs.write`, all `W`)
| Tool | | Purpose |
|---|---|---|
| `write_file` | V | Create or fully overwrite a file. |
| `edit_file` | V | Apply substring `{old,new}` replacements (the default for localized edits). |
| `git_apply_patch` | V | Edit ONE file by applying a unified diff via `git apply` (niche; diff-shaped alternative to edit_file). |

### Git — read-only VCS (`fs.read`)
| Tool | | Purpose |
|---|---|---|
| `git` | V | Inspect history and working-tree state (status/diff/log/show/blame). Read-only; writes go through bash/git_apply_patch. |

### Shell / exec
`bash` / `bash_background` are category `bash` (full command analysis); the
background-management tools are category `misc` (they carry no `command` to
analyze — the process was already approved at spawn).
| Tool | | Purpose |
|---|---|---|
| `bash` | V `W` | Run a shell command (timeout, abort, sandboxed). |
| `bash_background` | V `W` | Run a long-running command in the background. |
| `bash_output` | V | Read new stdout/stderr from a background process. |
| `bash_kill` | D `W` | Terminate a background process. |
| `bash_list` | D | List the session's background processes. |

### Network (`web.fetch`)
| Tool | | Purpose |
|---|---|---|
| `fetch_url` | D | Fetch an http(s) page as markdown (HTML→md; large pages spill to a file). Host-gated by `FetchPolicy`; returned content is wrapped as untrusted data (SECURITY_GUIDELINE §9.1). |

### Subagents / tasks
| Tool | | Purpose |
|---|---|---|
| `task` | V | Spawn a named subagent (isolated context + toolset + budget). |
| `task_async` | V | Spawn a subagent without blocking; returns a handle. |
| `task_await` | V | Block until a `task_async` subagent finishes; return its envelope. |
| `task_sync` | D | Legacy alias of `task` (same dispatcher). |
| `task_cancel` | D | Abort a `task_async` subagent by handle. |
| `task_list` | D | List the session's subagent handles + status. |

### Memory & retrieval (cross-session — `MEMORY.md`)
| Tool | | Purpose |
|---|---|---|
| `memory_read` | V | Load one memory's body by name. |
| `memory_search` | V | Substring search over memory names/descriptions (bodies with `deep`). |
| `memory_list` | D | List the memory index without reading bodies. |
| `memory_write` | D `W`, op-confirm | Propose a memory write (operator modal confirms). |
| `retrieve_context` | D | Ranked, budget-constrained retrieval of context not in the live window. |

### Skills (`SKILLS.md`)
| Tool | | Purpose |
|---|---|---|
| `skill_invoke` | V | Invoke a skill — load its procedure and follow it. |
| `skill_list` | D | List available skills. |
| `skill_show` | D | Print a skill's body without invoking it. |

### Session state (in-memory, harness-internal)
| Tool | | Purpose |
|---|---|---|
| `todo_list` | V | List live todos (ids, statuses, counts). |
| `todo_get` | V | Fetch one todo by id. |
| `todo_create` | V | Append todos to the session list. |
| `todo_update` | V | Patch one todo by id. |
| `todo_clear` | D | Empty the todo list. |
| `working_state_update` | V | Update the operational panel (focus / next / log / hypotheses — `WORKING_STATE.md`). |

### Reminders (clock-driven — REPL only, `reminder`-gated)
| Tool | | Purpose |
|---|---|---|
| `reminder` | V | Schedule a one-shot reminder after a delay. |
| `reminder_list` | D | List pending reminders. |
| `reminder_cancel` | D | Cancel a pending reminder by id. |

### Interaction & meta
| Tool | | Purpose |
|---|---|---|
| `clarify` | V, op-confirm | Ask the operator instead of presuming (anti-presumption core tool). |
| `tool_search` | V | Reveal a deferred tool so it can be called (§7.6). |

**Withdrawn from the model surface** (registered/usable internally, never shown):
`wait_for`, `monitor` (the model must not call them), `pin_context` (a confusion
magnet for weaker models; the `/pin` operator command stays). See
`src/tools/builtin/index.ts` for the authoritative `BUILTIN_TOOLS` list.

---

## 3. Anatomy of a tool

A tool is a typed object (`src/tools/types.ts#Tool`):

```ts
interface Tool<I, O> {
  name: string;            // snake_case; the model calls this
  description: string;     // the model reads this — invest in it
  inputSchema: JSONSchema; // validated at runtime
  metadata: ToolMetadata;
  execute(args: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
```

`ToolMetadata` fields that govern the surface and gating:

| Field | Effect |
|---|---|
| `category` | `fs.read` / `fs.write` / `bash` / `net` / `misc` — drives permission routing. `misc` default-allows (no resolver). |
| `writes` | `true` ⇒ a checkpoint is taken before the call (reversibility, principle 10). Pessimistic: declare it for any side effect. |
| `idempotent` | safe to retry without duplicate effect. |
| `deferred` | `true` ⇒ off the base surface, reached via `tool_search` (§7.6). |
| `requiresOperatorConfirm` | needs the REPL modal; hidden where it isn't wired (and refused in subagent whitelists). |
| `requiresReminderScheduler` | needs the REPL clock; hidden in one-shot/subagent runs. |
| `display` | `'diff'` / `'raw'` — how the TUI renders the call. |

Result: return the `O` value on success, or `toolError(ERROR_CODES.x, msg, {...})`
on failure (`ToolResult<O> = O | ToolError`). Tools return errors as *data* — they
do not throw for expected failures.

---

## 4. Adding a tool — the checklist

Adding a tool touches more than its own module; several cross-cutting surfaces
key off the tool name or category, and missing one is a silent gap (most of the
bugs found while building `git_apply_patch` and `tool_search` were exactly these).
Work the list:

1. **Module** — `src/tools/builtin/<name>.ts`: the `Tool` object + `Input`/`Output`
   interfaces. New failure modes → add codes to `ERROR_CODES` in
   `src/tools/types.ts`.

2. **Register** — `src/tools/builtin/index.ts`: import, re-export, and add to
   `BUILTIN_TOOLS` (order: read-only → writes → exec). This is the single source
   the subprocess subagent rebuilds from, so the tool MUST be here to be callable
   anywhere.

3. **Permissions** — `src/permissions/`:
   - fs / exec / net tool → register a capability resolver in
     `resolvers/{fs,bash,fetch}.ts`. A `misc` tool with no real side effect needs
     none (it default-allows).
   - fs tool → add it to `FS_TOOL_TRAITS` in `engine.ts` (the one-path gate
     section the engine extracts the gated path from).

4. **Subagent whitelisting** — `src/subagents/restrictions.ts`: if the tool takes
   a path, add it to the right extractor (`FILE_PATH_EXTRACTOR` / `PATH_EXTRACTOR`)
   and `TOOL_RESTRICTION_SHAPE`, so subagent `tools:` restrictions can gate it. A
   tool with no extractor is unrestrictable (allowed by default in a whitelist).

5. **Hooks** — `src/hooks/dispatcher-matching.ts`: if the tool has a path arg, add
   it to the fs-path extraction list so `if:` path-glob filters apply (else the
   filter fails open).

6. **Recap** — `src/recap/projection.ts` AND `src/recap/mini/deterministic.ts`
   (mirrored sets): if the tool reads or writes a known path, add it to
   `READ_TOOLS` / `FILE_WRITER_TOOLS`, or its activity vanishes from `/recap`.

7. **TUI** — `src/tui/tool-vocab.ts`: add a `TOOL_VOCAB` entry (active/final verb +
   subject) and, if batched, a `TOOL_NOUN`. Without it the chip shows a deliberately
   awkward fallback verb.

8. **Tests** — the tool's own test (new code is born with tests, principle:
   "no tests means not done") AND update the exact registered-tool list in
   `tests/cli/bootstrap.test.ts` (it asserts the full set, including deferred
   tools, which stay registered).

9. **Eval** — if the tool is load-bearing (a capability the agent's success
   depends on), add a model-in-the-loop eval under `evals/` (principle 4). A
   subsystem without an eval that exercises it doesn't ship.

10. **Surface decision (§7.6)** — visible or deferred? Visible if it's on the
    common path or is a mandatory follow-up of a visible primary (no orphans —
    e.g. `bash_background` keeps `bash_output` visible). Deferred if it's a niche
    alternative or rare self-contained management. Deferring is just
    `deferred: true` in metadata; the `tool_search` catalog is generated from the
    registry, so nothing else needs editing. Gate this with the eval — high
    fetch-rate or a completion drop means promote it back.

A `misc`, read-only, path-less tool (like the todo family) skips most of 3–6; an
fs-write tool with a path (like `git_apply_patch`) touches all of them.
