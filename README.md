# Forja

Forja is an autonomous programming agent that runs on your terminal. It understands your codebase, reads and edits files, executes commands, coordinates tools, and analyzes various files to build features, fix bugs, and automate development work.

What sets Forja apart is the structure surrounding the model. Every action with an effect is logged, every tool call is audited, and every inference makes its uncertainties and unmeasurable assumptions explicit. The model is not the system. Forja was designed to make autonomous programming observable, reversible, and reliable.

> **Measure twice, cut once.**

## Get started

...

Verify the install:

```bash
forja --version
forja doctor               # platform, sandbox tools, config + data dirs, git
```

For a guided first-boot walkthrough (doctor + sandbox setup + next steps):

```bash
forja welcome
```

---

## First run

Forja needs an API key for at least one provider. Pick one:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic (default model)
export OPENAI_API_KEY=sk-...            # OpenAI
export GOOGLE_API_KEY=...               # Google
```

Scaffold the bootstrap on first use — this writes the per-project `.forja/`
(permissions, playbooks, skills) and the operator-owned model catalog
`~/.config/forja/model_providers.json`, which boot now requires:

```bash
cd ~/projects/my-repo
forja init
```

Then open the interactive REPL:

```bash
forja
```

The first time Forja sees a directory, it asks you to attest the trust
boundary — once accepted, your `.forja/` bootstrap (`permissions.yaml`,
playbooks, skills, project-local memory) is loaded.

Or run a one-shot prompt:

```bash
forja "summarize the README"
forja --model openai/gpt-4o "list the public functions in src/api/"
```

Run it as a headless tool (emits NDJSON events to stdout):

```bash
forja --json "what changed in the last commit?" > events.ndjson
```

---

## What's in the box

| Subsystem | What it does | Surfaces |
|---|---|---|
| **Harness loop** | The agent runtime: step budget, max-cost cap, compaction at 70% context, retries with classified failure modes | `forja <prompt>` |
| **Permissions** | Layered allow/deny policy with glob + prefix matching (no regex). Sandbox profiles per tool category. Per-session approval posture (supervised / autonomous) | `forja --explain-permissions`, `--autonomous`, Shift+Tab, `.forja/permissions.yaml` |
| **Memory** | Cross-session knowledge with three scopes (user / project_shared / project_local), explicit trust, lifecycle states (active / quarantined / invalidated), provenance tracking | `forja --memory list`, `forja --memory show <name>`, `/memory` slash |
| **Skills** | Eager-loaded catalog of operator-authored procedures, body lazy | Skills auto-surface in system prompt; `/skill` slash |
| **Subagents** | Worktree-isolated child runs (`task`), async handles (`task_async`), parallel dispatch with caps | `.forja/playbooks/*.md` |
| **Mesh (relay)** | Local Forja instances (same user, different repos) exchange plain-text messages to coordinate a cross-repo change. A peer's message is untrusted *intent, never authority* — every effect stays gated by the local operator's own posture | `/relay on`, `mesh_peers` / `mesh_send`, `[mesh]` in `.forja/config.toml` |
| **Checkpoints** | Auto-snapshot of the working tree before any write tool. `--undo` restores | `forja --undo <session>`, `forja --checkpoints list <session>` |
| **Audit** | Append-only event log across messages, tool calls, approvals, hooks, failures, memory events, checkpoints. Optional hash chain (tamper-evident) | `audit_timeline` view, `.local/share/forja/audit.db` |
| **Hooks** | Operator-provided shell hooks at lifecycle events (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, etc.) with `additionalContext` injection | `.forja/hooks/` |
| **Recap** | Session-end terse summary; structured PR / Slack / mini formats via the recap pipeline | `/recap`, session-end output |
| **Resume** | Continue a prior session by id (or `last`) — replays scrollback and rebuilds context with auto-rehydrate | `forja --resume <id> "follow-up prompt"` |
| **Token efficiency** | Cache breakpoints split across stable / memory segments; per-tool output summarization (bash / grep / glob) | `[forja:output_summarized ...]` markers |

---

## Modes

**Interactive REPL** (default). Persistent TUI with inline rendering, slash
commands (`/model`, `/effort`, `/memory`, `/budget`, `/history`, …), reverse
search, ctrl-c double-tap-to-exit gate.

**One-shot.** Pass the prompt as a positional arg; Forja runs to completion
and exits. Useful in scripts:

```bash
forja "regenerate the openapi.yaml from the route handlers and run npm test"
```

**Headless / NDJSON.** `--json` emits one event per line on stdout (banner,
session lifecycle, tool calls, assistant messages, usage, failures). Stderr
carries logs. Consumable by external tooling:

```bash
forja --json "lint the src/ tree" | jq 'select(.type=="tool:end")'
```

---

## Provider support

| Provider | Models | Cache | Streaming | Notes |
|---|---|---|---|---|
| Anthropic | claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 | 5min ephemeral (1h opt-in planned) | ✓ | Default. Multi-block cache breakpoints (stable + memory + tools + tail). |
| OpenAI | gpt-4o, gpt-4o-mini, gpt-5.x (selected) | — | ✓ | Reads the canonical system prompt; ignores per-segment cache markers. Also covers OpenAI-compatible endpoints via a catalog `base_url`. |
| Google | gemini-2.5 / 3.x families | — | ✓ | Same compat path as OpenAI. |
| Ollama (local) | qwen2.5-coder, qwen3, qwen3-coder, llama3.1, mistral-nemo, gpt-oss, devstral | — | ✓ | Native tool calling, `$0`. `--model ollama/<name>`; `llama.cpp` planned. |

Cost is computed per-turn from declared per-1M pricing in
`src/providers/<family>/capabilities.ts`. The exact installed set is the
operator-owned catalog (see **Model** below) — this table is the seeded default.

---

## Model & effort

Two independent knobs control how a run thinks. Both can be set at boot
(flag or config) and changed in-session (slash command, effective next turn).

### Model

Which provider/model answers. Resolution order (first wins):

1. `--model <id>` flag — `forja --model openai/gpt-4o "..."`
2. Project config — `.forja/config.toml` → `[providers].model`
3. User config — `~/.config/forja/config.toml` → `[providers].model`
4. Built-in default — `anthropic/claude-opus-4-8`

In the REPL, `/model` shows the active model and its capabilities (context
window, max output); `/model <id>` switches it from the next turn. The swap is
session-scoped and in memory — it is not written to config or the session row.

```toml
# .forja/config.toml
[providers]
model = "anthropic/claude-opus-4-8"
```

Which models **exist** — and how to register your own (a local model you pulled,
an OpenAI-/Anthropic-compatible endpoint, a price tweak) — is the operator-owned
catalog `~/.config/forja/model_providers.json`, written by `forja init`
(mandatory: with no catalog, boot stops and points you at it). Each entry names
its `api_key_env` (which env var holds the key) and an optional `base_url` for
custom endpoints. See [`docs/PROVIDERS.md` §2.1](docs/PROVIDERS.md) for the full
how-to.

Run `forja --list-models` to print the installed catalog — each model's context
window, price per-1M, and whether it's ready to use (its API key is set). Add
`--json` for NDJSON.

### Effort

One knob, two axes: it sets the provider's **reasoning depth** *and* a set of
**operational budget caps** (max steps, parallel subagents, tolerated tool
errors). Levels: `low | medium | high | max` (default `high`).

Resolution order (first wins):

1. Project config — `.forja/config.toml` → `[effort].level`
2. User config — `~/.config/forja/config.toml` → `[effort].level`
3. Built-in default — `high`

In the REPL, `/effort` shows the active level with its resolved caps and the
per-provider mapping; `/effort <level>` sets it from the next turn (in memory,
not persisted). Subagents inherit the operator's level. An explicit `/budget`
override always wins over the level's preset caps.

```toml
# .forja/config.toml
[effort]
level = "high"
```

---

## Configuration

Forja layers configuration from three sources, each optional:

- **Enterprise** — system-wide (`/etc/forja/permissions.yaml`)
- **User** — `~/.config/forja/`
- **Project** — `.forja/` in the repo root (created by `forja init`)

`forja --explain-permissions` shows the resolved policy with per-section
attribution to its originating layer.

Bootstrap a new project:

```bash
cd ~/projects/my-repo
forja init                  # creates .forja/permissions.yaml + playbooks + skills
forja init --mode strict    # locked-down default (no auto-allow on bash)
```

### Isolated profiles (dev mode)

By default Forja uses the canonical namespace — `~/.config/forja`,
`~/.local/share/forja` (sessions + audit DB), `~/.cache/forja`, and `.forja/`
in the repo. **That default IS your real state; there is no separate "prod"
profile** — absence of a profile is the real namespace.

`--profile <name>` (or the `FORJA_PROFILE` env var) selects a fully isolated
parallel namespace, so a dev build can't migrate, pollute, or read your real
sessions, config, memory, or trust list:

```bash
forja --profile dev "iterate on Forja without touching my real state"
FORJA_PROFILE=dev forja doctor        # env form — equivalent
```

A profile relocates **both** levels at once:

| Default          | Under `--profile dev`   |
|------------------|-------------------------|
| `~/.config/forja`        | `~/.config/forja-dev`        |
| `~/.local/share/forja`   | `~/.local/share/forja-dev`   |
| `~/.cache/forja`         | `~/.cache/forja-dev`         |
| `<cwd>/.forja/`          | `<cwd>/.forja-dev/`          |

- The profile name must match `[a-z0-9][a-z0-9-]*`; an invalid value fails
  fast rather than silently falling back to your real state.
- `forja doctor` reports the active profile and the resolved dirs; the boot
  banner and the always-visible footer flag it in yellow so a dev run is never
  mistaken for your real one.
- When developing Forja from a source checkout, `bun run dev` already sets
  `FORJA_PROFILE=dev` for you (use `bun run start` to run against the real
  namespace).
- Add `.forja-*/` to your project's `.gitignore` so per-profile dirs stay out
  of version control.

---

## Safety model

- **Trust gate.** First time you `cd` into a project, Forja asks you to
  attest the directory. Untrusted directories don't load project
  configuration.
- **Sandbox.** On Linux, Forja runs bash inside `bwrap` with `hide_paths`
  for sensitive directories (`~/.ssh`, `~/.config/forja`, the audit DB).
  On macOS, the same defense via `sandbox-exec` SBPL.
- **Permission engine.** Tool calls pass through a layered policy with
  decision attribution. By default, confirms route through an interactive
  modal in REPL mode; in headless mode, deny-by-default unless explicitly
  allowed.
- **Operation mode.** Approval posture, per session. **Supervised** (default)
  sends every `confirm` to the modal; **Autonomous** (`--autonomous` at boot,
  or Shift+Tab in the REPL) auto-approves by EFFECT — routine low-risk
  `policy` confirms, plus **fully-modeled** bash whose every resolved
  capability is repo-confined (reads/writes/deletes under cwd, local git).
  Anything dangerous still prompts: network, outside-repo, unknown binary,
  protected/sensitive paths, and anything the resolver can't fully model
  (loops / dynamic `$vars`, where the capabilities are best-effort); a
  degraded engine re-arms the modal; hard denies stay unreachable. Not
  `bypass`: every engine floor holds, and each auto-approval is audited.
- **No auto-commit.** Forja never creates git commits without explicit
  operator action.

To report a security issue, see the [security policy](SECURITY.md). For
the full threat model, permission-engine internals, and sandbox design,
see [`docs/SECURITY.md`](docs/SECURITY.md).

---

## Documentation

The English operator and reference docs live under `docs/`. (The authored
architectural spec is separate — `docs/spec/`, in PT-BR; when a doc and the
spec diverge, the spec wins.)

### Operator guides

| Doc | What it covers |
|---|---|
| [`AUDIT.md`](docs/AUDIT.md) | Audit subsystem in production: the append-only event log, post-incident review, and compliance integration. |
| [`BUDGET.md`](docs/BUDGET.md) | Run-budget subsystem: the caps that bound an autonomous run, how they resolve, and how cost is gated. |
| [`HOOKS.md`](docs/HOOKS.md) | Hook system: lifecycle events, wiring shell commands, the stdin/stdout JSON contract, and the security model. |
| [`MCP.md`](docs/MCP.md) | Model Context Protocol integration: declaring servers, trust, tool exposure, and connection lifecycle. |
| [`MEMORY.md`](docs/MEMORY.md) | Cross-session memory: what's persisted, the lifecycle state machine, and the day-to-day slash commands. |
| [`RELAY.md`](docs/RELAY.md) | Forja Mesh: how local instances discover each other and exchange messages, the trust model (intent, never authority), and the `/relay` + `mesh_*` surfaces. |
| [`SKILLS.md`](docs/SKILLS.md) | Authoring and invoking reusable, vetted procedures that surface when a goal matches. |
| [`VERIFY.md`](docs/VERIFY.md) | Claim-time verify gate: the opt-in check that a run actually ran the project's tests before declaring done. |

### Architecture & internals

| Doc | What it covers |
|---|---|
| [`CONTEXT.md`](docs/CONTEXT.md) | How the fixed prefix (system prompt + tool schemas) is assembled, made window-relative, hashed, and cached. |
| [`SESSION.md`](docs/SESSION.md) | How a session is represented and how its conversation flows through a run. |
| [`TUI.md`](docs/TUI.md) | Terminal UI architecture: data flow, event bus, and inline render. |
| [`SECURITY.md`](docs/SECURITY.md) | Security architecture: the permission engine, sandbox, and threat model. |
| [`CHECKPOINT.md`](docs/CHECKPOINT.md) | Checkpoints & rollback: the git snapshot before each write that makes filesystem changes reversible. |
| [`PROVIDERS.md`](docs/PROVIDERS.md) | The provider layer as implemented: model catalog, adapters, and per-provider capabilities. |
| [`OUTPUT_POLICY.md`](docs/OUTPUT_POLICY.md) | Tool output reduction: keeping verbose tool output from bloating the context window. |

### Reference

| Doc | What it covers |
|---|---|
| [`CLI.md`](docs/CLI.md) | Command reference for the `forja` binary: flags, subcommands, and modes. |
| [`TOOLS.md`](docs/TOOLS.md) | Living reference for the builtin tools available to the agent. |
| [`CODER_PLAYBOOK.md`](docs/CODER_PLAYBOOK.md) | Patterns and anti-patterns the agent applies when writing code. |

### Evaluation

| Doc | What it covers |
|---|---|
| [`BENCHMARK.md`](docs/BENCHMARK.md) | Self-SWE-bench (capability axis): can a model driving Forja fix a real bug, verified by the project's own tests. |
| [`RANKING.md`](docs/RANKING.md) | How models perform *inside the Forja harness* — measured on real loop behavior, not a general benchmark. |

---

## License

Apache-2.0. See `LICENSE`.
