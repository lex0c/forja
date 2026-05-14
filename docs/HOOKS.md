# Forja Hooks Operator Guide

This document describes Forja's hook system: lifecycle events the harness fires, how operators wire shell commands to those events, the JSON contract on stdin / stdout, audit semantics, and the security model that frames it all. It is intended for operators authoring hook scripts and contributors extending the dispatcher.

The canonical specification lives in `docs/spec/AGENTIC_CLI.md §10` (PT-BR). This document is the English-language operational reference; when the two diverge, the spec wins.

---

## 1. What hooks are for

Hooks let operators extend agent behavior at lifecycle points **without forking the codebase**. A hook is a shell command Forja runs in response to an event — a tool about to execute, a user prompt about to enter the model context, a session ending, a tool failure. The hook receives the event payload as JSON on stdin and signals back via exit code, stdout, or both.

The mental model is "git hooks for an agent." Each event has a defined payload shape, a documented blocking posture (can the hook stop the operation, or is it log-only?), and a wall-clock budget the dispatcher enforces.

Typical uses:

- Auto-format files after a write (`prettier`, `black`, `gofmt`).
- Audit / log decisions to external systems (Slack, Datadog, syslog).
- Inject repo state into the LLM's context before a turn (`UserPromptSubmit` + `additionalContext`).
- Normalize a tool's args before execution (`PreToolUse` + `updatedInput`).
- Org-policy blocks the engine vocabulary doesn't cover ("no `npm install` of unscoped packages on Fridays").
- React specifically to tool failures (`PostToolUseFailure` for paging, retry logic).

---

## 2. Events

Ten events. The dispatcher fires each one at a specific point in the harness lifecycle; the **Blocking** column says whether the originating operation waits on the hook's verdict (blockable events) or fires-and-continues alongside the chain (non-blocking events).

| Event | When it fires | Blocking? | Payload `data` shape |
|---|---|---|---|
| `SessionStart` | Session boot, before the loop starts | No | `{ cwd, model, profile }` |
| `UserPromptSubmit` | User prompt about to enter context | **Yes** (rejects prompt) | `{ prompt }` |
| `PreToolUse` | Tool resolved + permission-allowed, before execution | **Yes** (denies tool) | `{ tool: { name, input } }` |
| `PostToolUse` | After tool execution (success OR error) | No | `{ tool: { name, input, output, failed } }` |
| `PostToolUseFailure` | After tool execution **only when failed** | No | `{ tool: { name, input, error }, durationMs }` |
| `PreCompact` | Before context compaction | **Yes** (cancels) | `{ promptTokens, threshold }` |
| `Notification` | Permission prompt about to display | No | `{ kind, message }` |
| `PreCheckpoint` | Before checkpoint snapshot | No | `{ stepN }` |
| `MemoryWrite` | Before persisting a new memory | **Yes** (blocks write) | `{ scope, name, source, body }` |
| `Stop` | Session end | No | `{ durationMs, costUsd, steps }` |

The full payload envelope is `{ schema: "v1", event, sessionId, data: {...} }`. The `schema` field is reserved for future shape evolution — hooks parsing JSON should match on `event` first.

`PostToolUse` and `PostToolUseFailure` are intentional parallels. `PostToolUse` always fires (carrying `failed: bool`) for symmetric logging; `PostToolUseFailure` fires *additionally* on failures so operators who only care about errors don't need to inspect a boolean in every handler. On a failed tool call, the two chains run sequentially: `PostToolUse` first, then `PostToolUseFailure`.

---

## 3. Configuration

Hooks are declared in TOML files. Three layers, looked up at boot in execution order (enterprise → user → project):

| Layer | Path (POSIX) | Path (Windows) |
|---|---|---|
| Enterprise | `/etc/agent/hooks.toml` | `%PROGRAMDATA%\agent\hooks.toml` |
| User | `$XDG_CONFIG_HOME/agent/hooks.toml` (fallback: `~/.config/agent/hooks.toml`) | `~/.config/agent/hooks.toml` |
| Project | `<repo>/.agent/hooks.toml` | `<repo>\.agent\hooks.toml` |

Each layer is optional. Missing files mean "zero hooks at this layer" — no warning. A whole-file parse failure drops the layer with one warning; an individual malformed `[[hooks]]` entry is dropped with a warning while other entries in the file continue to load. Warnings surface in the `/hooks` command output.

### 3.1 Entry shape

```toml
# ~/.config/agent/hooks.toml

# Top-level — applies to this layer's whole file.
disable_all_hooks = false   # optional; default false (see §9)

[[hooks]]
event = "PostToolUse"
matcher = { tool = "write_file" }     # optional; absent = match all
command = "prettier --write {{tool.input.path}}"
timeout_ms = 5000                      # optional; default 5000, clamped [100, 30000]
fail_closed = false                    # optional; default false
locked = false                         # optional; enterprise-only (see §3.3)
if = "Write(*.ts)"                     # optional; per-handler filter (see §6)
```

All fields except `event` and `command` are optional with sensible defaults.

### 3.2 Matcher

The `matcher` block today honors one field: `tool` (string). Glob-suffix wildcard supported:

```toml
matcher = { tool = "bash" }     # exact match
matcher = { tool = "bash*" }    # bash AND any future bash variant
matcher = { }                    # match every tool (default when matcher omitted)
```

Matchers only apply to tool-shaped events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`). Other events ignore the matcher.

### 3.3 Hierarchy + locking

Hooks execute in layer order: enterprise hooks fire first (in declaration order within the file), then user, then project. Within a single event chain, all matching hooks across all layers run sequentially.

`locked = true` is honored **only** in the enterprise layer. User or project hooks declaring `locked` get a warning (`lock_ignored`) and the flag is dropped. Locking prevents lower layers from removing or shadowing the rule (a future spec slice extends this to per-event `disable_event` flags; today the simplest expression of the kill-switch lives at `disable_all_hooks`, §9).

---

## 4. The contract

Every hook process gets:

| Channel | Content |
|---|---|
| **stdin** | One line of JSON: the full event payload (`{ schema, event, sessionId, data }`) + a trailing newline. Hooks may ignore stdin if they don't need the payload. |
| **stdout** | Captured by the dispatcher. Truncated to 4 KB before logging or JSON parsing. Plain text or single-object JSON (see §7). |
| **stderr** | Captured and stored in `hook_runs.stderr`, truncated to 4 KB. Operator-visible via `/hooks audit`. |
| **exit code** | The decision signal — see §4.1. |
| **env vars** | `PATH`, `HOME`, `AGENT_CWD` (current session cwd), `AGENT_SESSION_ID` (UUID, empty string when fired before the session row exists, e.g. `SessionStart`). Nothing else is inherited — hook scripts that need extra env must `source` it themselves. |
| **cwd** | The session's working directory. |

### 4.1 Exit codes

| Code | Meaning | Effect on blocking events | Effect on non-blocking events |
|---|---|---|---|
| `0` | Allow / continue | Operation proceeds; stdout may carry JSON enrichment | Stdout logged, chain continues |
| `1` | Block silent | Operation refused; no message to the model | (no effect — non-blocking) |
| `2` | Block with message | Operation refused; stdout becomes the model-facing reason | (no effect — non-blocking) |
| `3..123` | Hook error | Logged; blocks IFF `fail_closed = true` on the spec | Logged, chain continues |
| `124` | Reserved — synthesized by the dispatcher when a hook times out (POSIX `timeout(1)` convention). Hooks should never emit this themselves. |
| `127` | Command not found (synthesized by the shell). Same handling as `3..123`. |

For blockable events, the **first** hook in the chain that returns a blocking decision (`block_silent`, `block_message`, or `error`+`fail_closed`) interrupts the chain — remaining hooks don't run. The chain's audit rows still record the runs that did happen.

### 4.2 Timeouts

Per-hook timeout: `timeout_ms`, default 5000 ms, clamped to `[100, 30000]`. Values outside the range are silently clamped with a `/hooks` warning.

Whole-chain timeout: 15 s wall-clock (`MAX_HOOK_CHAIN_MS`). A chain that hasn't finished by then has its remaining hooks skipped with a stderr warning. The per-hook timeout is additionally clamped against the remaining chain budget so a hook configured with `timeout_ms = 30000` can never push a chain past 15 s.

On timeout, the dispatcher sends `SIGTERM`, waits 1 s, then `SIGKILL`. The audit row records `outcome=timeout` and `exit_code=124` regardless of the killed process's signal-derived exit code.

### 4.3 fail_closed

Default `false`: a hook that times out or exits with a non-decision code (`3..123`, `127`) is logged but **does not** block the operation. The model proceeds as if the hook returned allow.

`fail_closed = true`: timeouts and non-decision errors on blockable events are treated as `block_silent` — the operation is refused. Use this for hooks that gate sensitive operations where "hook died" should mean "deny," not "let it through."

Audit rows always carry the full exit code and stderr; the `fail_closed` choice only affects whether the failure also blocks the originating operation. The model-facing block reason is sanitized to `null` (silent) — leaking a hook's crash reason into the model's context is both a UX problem and a leak surface.

### 4.4 Template expansion

Hook `command` strings support `{{path.to.field}}` placeholders. At dispatch time, each placeholder is looked up in the event payload (see §2 for shapes) and substituted, **quoted** for shell safety:

```toml
[[hooks]]
event = "PostToolUse"
matcher = { tool = "write_file" }
command = "prettier --write {{tool.input.path}}"
# expands to:  prettier --write '/repo/src/main.ts'
```

Quoting is POSIX single-quote-and-escape — the substituted value is always a single shell argument regardless of content. A payload field containing `'; rm -rf /` cannot escape its argument.

Operators who need to splice in pre-quoted shell-safe data (rare) can use `{{!path}}` (raw, unquoted). The `!` prefix is the explicit-danger marker.

Missing keys resolve to empty string (`''`). Objects and arrays as final values are treated as missing — Forja refuses to splice `[object Object]` into a shell command.

Prototype-pollution defense: each segment of the dotted path must be an **own** property of its parent. `{{constructor.name}}` resolves to nothing, not `'Object'`.

---

## 5. Discovery — the `/hooks` command

The REPL exposes a read-only inspector. Mutations always go through the on-disk TOML files (no runtime mutation path — single source of truth).

```
/hooks                  # summary: hook count by event + layer
/hooks list             # every loaded hook in resolution order
  [--layer <l>]         # filter: enterprise | user | project
  [--event <e>]         # filter by event name
/hooks audit            # recent hook_runs rows
  [--session]           # only this REPL session
  [--event <e>]         # filter by event
  [--limit N]           # cap output (default 20, max 200)
```

The `summary` view is the fastest way to verify a config edit took effect. After editing `hooks.toml`, hot-reload picks up changes; if the count for the event you edited didn't change, the parser dropped the entry (look at `/hooks list` for warnings).

---

## 6. Per-handler `if` filter

`matcher.tool` filters by tool **name** but can't filter by *what the tool is doing*. The `if` field on each `[[hooks]]` adds a finer filter using permission-rule syntax:

```toml
[[hooks]]
event = "PreToolUse"
matcher = { tool = "bash" }
if = "Bash(rm *)"
command = "./check-rm.sh"
```

This hook only fires when:
- the tool is bash (matcher), AND
- the bash command (or any of its `;` / `&&` / `||` -separated subcommands) matches `rm *`.

Supported patterns:

| Pattern | Matches against | Notes |
|---|---|---|
| `Bash(<glob>)` | `args.command`, subcommand-aware | Synonym: `bash`, case-insensitive |
| `Edit(<glob>)` | `args.file_path` / `args.path` | Synonym: `edit_file` |
| `Write(<glob>)` | `args.file_path` / `args.path` | Synonym: `write_file` |
| `Read(<glob>)` | `args.file_path` / `args.path` | Synonym: `read_file` |

For fs-shaped patterns, matching is two-shot: first against the full path, then against the basename when the pattern has no `/`. So `Edit(*.ts)` matches `src/main.ts` via basename `main.ts`; `Edit(src/**/*.ts)` matches the full path verbatim.

Fail-open semantics:

- `if` on a non-tool event (e.g., `Stop`) → hook skipped (filter is unsatisfiable on that event shape).
- `if` referencing an unsupported tool (e.g., `Custom(...)`) → hook runs (operator intent was a filter, not a deny; a typo shouldn't silently drop the hook).
- Malformed pattern (`Bash(` with no closing paren) → hook runs (same reason).

The `if` filter spawns nothing when it fails — operator pays no subprocess cost for hooks that don't apply.

---

## 7. JSON output: structured enrichment

A hook that exits 0 and whose stdout (after trim) starts with `{` is parsed as JSON. Three fields are recognized:

| Field | Type | Effect |
|---|---|---|
| `additionalContext` | string | Injected into the LLM context. See §7.1. |
| `updatedInput` | object | `PreToolUse` only — replaces tool args before execution. See §7.2. |
| `suppressOutput` | boolean | Hides hook stdout from debug log. Audit row still records the full stdout. |

Malformed JSON, wrong field types, or non-object roots fall through to "plain stdout" handling (the hook still counts as allow; its text just isn't structured). Hooks emitting more than 4 KB of JSON have their stdout truncated *before* parsing, so the JSON becomes unparseable and the output is treated as plain text — operators wanting larger context must split across multiple hooks.

### 7.1 additionalContext

Hooks emit text the model should see on its next turn:

```bash
#!/bin/bash
# .agent/hooks/branch-state.sh — UserPromptSubmit hook
cat <<EOF
{"additionalContext": "Current branch: $(git branch --show-current)\nUncommitted files: $(git status --porcelain | wc -l)"}
EOF
```

The harness aggregates `additionalContext` across the chain in execution order (`\n\n`-joined) and injects the result into the model-facing payload:

- `PreToolUse` context → appended to the next `tool_result.content` under `[forja:hook-context event=PreToolUse]...[/forja:hook-context]` markers, so the model sees operator-side context alongside tool output.
- `PostToolUse` context → appended to the same `tool_result.content` under `event=PostToolUse` markers. On failures, `PostToolUseFailure` context appends after `PostToolUse`'s.
- `UserPromptSubmit` context → injected ahead of the user's prompt in the context window.

The markers are stable strings the model is trained to recognize as side-channel context rather than tool output.

### 7.2 updatedInput

`PreToolUse` hooks can replace the tool's args before execution:

```bash
#!/bin/bash
# Normalize npm test invocations to always include --quiet
INPUT=$(cat)  # event payload on stdin
COMMAND=$(echo "$INPUT" | jq -r '.data.tool.input.command')
if [[ "$COMMAND" == "npm test"* && "$COMMAND" != *"--quiet"* ]]; then
  NEW_COMMAND="${COMMAND/npm test/npm test -- --quiet}"
  jq -n --arg c "$NEW_COMMAND" '{"updatedInput": {"command": $c}}'
fi
```

Semantics:

- **Replaces verbatim**, not merge. The hook is responsible for including unchanged fields alongside the mutated ones.
- **Last-wins** when multiple hooks in the chain emit `updatedInput`.
- **Permission re-check.** After the chain produces a final `updatedInput`, Forja re-runs the permission engine on the mutated args. If the engine would now deny or require confirmation, the tool is refused with `denied: PreToolUse hook updatedInput would require ...` and a second approval row is recorded (decidedBy=hook, decision=deny). This closes the elevation path where a hook silently mutates `bash(ls)` into `bash(rm -rf /)`. Confirm-shaped results also refuse rather than re-prompt the user — hook-driven mutation must not retroactively ask the user for permission the model never requested.
- **Audit baseline preserved.** `tool_calls.input` still records the ORIGINAL args from the model. The mutation is recoverable forensically by joining with the `PreToolUse` chain's `hook_runs` rows for the same `tool_call_id` (the operator's hook stdout, captured in `hook_runs.stdout`, contains the JSON they emitted).

### 7.3 suppressOutput

Hides the hook's stdout from the operator-facing debug log (`/hooks audit` still records it). Use for hooks that emit large amounts of JSON enrichment the operator doesn't want repeated in their REPL output.

---

## 8. PostToolUseFailure

Dedicated event for failed tool calls. Fires sequentially after `PostToolUse` on failure (the latter sees `failed: true`; the former is *only* invoked on failure with a dedicated payload).

```toml
[[hooks]]
event = "PostToolUseFailure"
matcher = { tool = "bash" }
command = "./pager-alert.sh '{{tool.name}}' '{{tool.error}}' '{{durationMs}}'"
timeout_ms = 3000
```

Payload data:

```json
{
  "tool": {
    "name": "bash",
    "input": { "command": "..." },
    "error": "exit code 1: <error message>"
  },
  "durationMs": 1234
}
```

The `error` field is the tool's structured `error_message` when available, otherwise `"tool failed (no structured error_message)"`. Operators reacting to specific failure patterns (e.g., quota exhaustion, network timeout) can match on substrings in their hook script.

Like `PostToolUse`, this event is non-blocking — operators can't "unfail" a tool call from a hook. The latency cost is real, though: `PostToolUse` + `PostToolUseFailure` running sequentially adds up to `2 × MAX_HOOK_CHAIN_MS = 30 s` to the failure path in the worst case. Use per-hook `timeout_ms` to keep this in check.

---

## 9. `disable_all_hooks` kill switch

Top-level boolean per `hooks.toml`. When set on any layer, OR'd across all three. Once true, the dispatcher short-circuits — every event chain returns empty immediately, no spawn, no audit, no matcher evaluation:

```toml
# /etc/agent/hooks.toml — enterprise pins the kill switch
disable_all_hooks = true

# Hooks below would normally run, but the kill switch dominates.
[[hooks]]
event = "PreToolUse"
command = "..."
```

Resolution: enterprise-set `true` cannot be unset by user or project (lower layers can only add more `true`, never remove). User or project layers setting `true` disable hooks for their scope without enterprise involvement — useful for debug workflows where the operator wants to temporarily turn everything off without commenting out config blocks.

Verification: after toggling, `/hooks` summary should show the kill-switch warning at the top of its output.

---

## 10. Audit

Every hook execution writes a row to `hook_runs`:

| Column | Content |
|---|---|
| `id` | UUID |
| `session_id` | Session UUID (nullable when fired before session creation, e.g., early `SessionStart`) |
| `event` | HookEvent string |
| `layer` | enterprise / user / project |
| `source_path` | The hooks.toml path that contributed this hook |
| `hook_index` | 0-based position within the source file's `[[hooks]]` array |
| `command` | Raw operator-authored command (pre-template-expansion) |
| `expanded` | Template-expanded command actually passed to `sh -c` |
| `exit_code` | Process exit code, or 124 for timeout, or -1 for synchronous spawn failure |
| `outcome` | allow / block_silent / block_message / error / timeout |
| `duration_ms` | Wall-clock from spawn to exit |
| `stdout` | Truncated to 4 KB; null when empty |
| `stderr` | Truncated to 4 KB; null when empty |
| `matched_tool` | Tool name for tool-shaped events (PreToolUse, PostToolUse, PostToolUseFailure); null otherwise |
| `created_at` | Unix ms |

Indices: `(session_id, created_at DESC)` for "this session's runs" and `(event, created_at DESC)` for dashboards and forensic queries.

Reading audit:

```
/hooks audit --session
/hooks audit --event PreToolUse --limit 50
/hooks audit --event PostToolUseFailure
```

The audit table is NOT part of the hash-chained `approvals_log` — hooks are observability, not enforcement decisions. The hash chain covers permission engine verdicts; hook runs are operator-side bookkeeping that survives sessions without cryptographic anchoring.

### 10.1 Audit drift

If the audit writer fails (DB locked, disk full, schema mismatch), the dispatcher emits a `hooks: AUDIT DRIFT: ...` line on stderr and continues — the hook's runtime effects already happened, dropping the row is preferable to crashing the harness. Operators should grep stderr / journald for `AUDIT DRIFT` after suspected hook misbehavior. Secrets in the failure message are redacted before stderr emission.

---

## 11. Security model

Hooks are an **operator-trusted surface**. Forja's overall threat model assumes the operator authored every hook script and the LLM cannot install or modify them. Concretely:

1. **The LLM cannot install hooks.** Writing to `~/.config/agent/`, `/etc/agent/`, or `<repo>/.agent/` is HIDE_PATHS-masked inside the sandbox. A model attempting `write_file('~/.config/agent/hooks.toml')` cannot reach those paths from any default tool. The protected-paths list is enforced by the permission engine even when the sandbox is unavailable.

2. **Hooks run unsandboxed.** Each hook is spawned via `sh -c` with the host's `PATH` + `HOME`. This is intentional — hooks exist precisely to talk to the host (Slack, CI, package managers, secrets vaults). Sandboxing them would defeat their purpose. The trust boundary is the on-disk hook file, not the hook process.

3. **Operator authorship is the trust anchor.** Whoever wrote the script committed to its behavior. Forja makes no attempt to introspect what a hook does — it can do anything the operator's shell can do. Vet your hooks like you'd vet any shell script you `chmod +x`.

4. **Hook output is hostile-by-default.** A hook can emit anything to stdout. The dispatcher's JSON parser is defensive (malformed input falls back to plain text, no exceptions thrown), but the `additionalContext` markers the hook can inject into LLM context are still operator-side data — operators auditing for prompt injection in tool outputs should also audit their own hooks' `additionalContext` emissions for the same patterns.

5. **`updatedInput` is operator-only elevation.** The PreToolUse hook can rewrite a tool's args to anything, BUT the rewritten args are re-checked through the permission engine (see §7.2). An operator hook cannot accidentally turn a benign `bash(ls)` into an unaudited `bash(rm -rf /)` — the re-check will refuse the mutated args if they don't pass policy.

6. **`fail_closed` is your gate.** Hooks gating sensitive operations should set `fail_closed = true` so a crashed / hung / misconfigured hook denies rather than allows. The default `false` exists for log-only hooks where unavailability shouldn't break the flow.

7. **Locking via enterprise layer.** Operators in managed environments can pin critical hooks at `/etc/agent/hooks.toml` with `locked = true`; lower layers can't shadow them. Same applies to `disable_all_hooks = true` at enterprise scope — once pinned, user and project can't re-enable.

### 11.1 What hooks are NOT

- Hooks are not a substitute for the permission engine. The engine gates **what the model can attempt**; hooks add **what the operator can override**.
- Hooks cannot undo a tool call. `PostToolUse` and `PostToolUseFailure` are observability surfaces, not rollback points. Reversibility belongs to checkpoints (`docs/spec/AGENTIC_CLI.md §12`).
- Hooks cannot register new tools. The tool registry is compiled into the binary. Operators wanting to expose new capabilities use MCP servers, not hooks.
- Hooks cannot persist state across runs. Each invocation is a fresh subprocess. Operators needing shared state across hook runs must use the filesystem or an external store.

---

## 12. Worked examples

### 12.1 Auto-format TypeScript after writes

```toml
# .agent/hooks.toml
[[hooks]]
event = "PostToolUse"
matcher = { tool = "write_file" }
if = "Write(*.ts)"
command = "prettier --write {{tool.input.path}}"
timeout_ms = 10000
```

The `if` filter avoids spawning prettier for non-TypeScript writes; the 10s timeout accommodates a cold prettier startup.

### 12.2 Inject CI status into every prompt

```bash
#!/usr/bin/env bash
# ~/.config/agent/hooks/ci-status.sh
LATEST=$(gh run list --limit 1 --json status,conclusion --jq '.[0]')
jq -n --argjson r "$LATEST" '{
  "additionalContext": ("Latest CI run: " + ($r | tostring))
}'
```

```toml
# ~/.config/agent/hooks.toml
[[hooks]]
event = "UserPromptSubmit"
command = "~/.config/agent/hooks/ci-status.sh"
timeout_ms = 3000
```

If `gh` is slow or unavailable, the hook exits non-zero and the prompt proceeds without enrichment (default `fail_closed = false`).

### 12.3 Block `rm -rf` outside the workspace

```bash
#!/usr/bin/env bash
# .agent/hooks/check-rm.sh — PreToolUse hook
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.data.tool.input.command')
if echo "$COMMAND" | grep -qE 'rm[[:space:]]+-rf[[:space:]]+[^./]'; then
  echo "rm -rf with non-relative target requires manual review" >&2
  exit 2  # block with message
fi
```

```toml
[[hooks]]
event = "PreToolUse"
matcher = { tool = "bash" }
if = "Bash(rm *)"
command = ".agent/hooks/check-rm.sh"
fail_closed = true
```

`fail_closed = true` ensures a syntax error or missing jq doesn't silently let dangerous `rm` through.

### 12.4 Page on tool failure

```toml
# /etc/agent/hooks.toml — enterprise layer
[[hooks]]
event = "PostToolUseFailure"
command = "curl -s -X POST $PAGER_WEBHOOK -d 'tool={{tool.name}}&error={{tool.error}}&session={{sessionId}}'"
timeout_ms = 2000
locked = true
```

Locked at enterprise so user/project layers can't disable the alerting.

### 12.5 Normalize bash invocations

```bash
#!/usr/bin/env bash
# Inject --color=never into git commands so the model gets clean output
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.data.tool.input.command')
case "$CMD" in
  git\ *)
    NEW="${CMD/git /git --no-pager -c color.ui=never }"
    jq -n --arg c "$NEW" '{"updatedInput": {"command": $c}}'
    ;;
esac
```

```toml
[[hooks]]
event = "PreToolUse"
matcher = { tool = "bash" }
if = "Bash(git *)"
command = ".agent/hooks/git-no-color.sh"
```

The rewritten command is re-checked against the permission engine before execution (§7.2) — if `git --no-pager -c color.ui=never status` doesn't pass policy for this session, the tool is refused. Operators get a clear deny message and the audit trail shows the elevation attempt.

---

## 13. Limits + honest gaps

Documented here so operators don't trip over them:

- **`PostToolUse` is now awaited.** Pre-slice-181 the chain ran fire-and-forget; today it's awaited so the harness can capture `additionalContext`. Wall-clock cost up to `MAX_HOOK_CHAIN_MS = 15 s` per tool call on success, doubled to 30 s on failure (PostToolUse + PostToolUseFailure run sequentially). Tune per-hook `timeout_ms` if this latency matters to your workflow.
- **JSON output cap is implicit in stdout truncation.** A hook emitting 8 KB of JSON has its stdout cut at 4 KB and the JSON becomes unparseable. Plan around the cap; split context across multiple hooks if needed.
- **No mid-session hook reload yet.** Editing `hooks.toml` requires restarting the session for the new config to take effect. (`disable_all_hooks` is also boot-time-resolved today.)
- **No per-event `disable` flag.** The only kill switch is the global `disable_all_hooks`. Operators wanting to disable a specific event must comment out or remove its `[[hooks]]` entries.
- **Shell-only commands.** The dispatcher invokes `sh -c "<command>"`. Operators on Windows hosts without `sh` or `bash` in PATH but with `cmd.exe` are supported via fallback; otherwise the chain emits a `shell_unavailable` warning at boot and runs zero hooks.
- **No structured way to react to permission denials.** `Notification` fires only for *confirm* prompts (the engine asking the user). A flat deny (engine refused outright) is observable via `approvals_log` but not as a hook event today. A `PermissionDenied` event is on the backlog.
- **PostToolUse hook sees mutated args.** When a `PreToolUse` hook returned `updatedInput`, the `PostToolUse` payload's `tool.input` is the **post-mutation** args (what actually ran), not the model's original. Operators inspecting "what the model asked for" should read `PreToolUse` instead; `PostToolUse` is "what actually ran" — symmetric with `PostToolUseFailure`.

For all of the above, the spec (`docs/spec/AGENTIC_CLI.md §10`) is the authoritative record of the design intent. This document is the operational shape today.
