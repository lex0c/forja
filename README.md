# Forja

> Agentic CLI — terminal-first, multi-provider, self-hostable.
>
> **Measure twice, cut once.**

Forja is an autonomous coding agent that runs in your terminal. It reads your
code, runs commands, edits files, and reasons about a project — like other
agent CLIs you may have used. The difference is in what it does between those
actions: every decision is checkpointed, every tool call is audited, every
inference declares what was **not** measured.

---

## Why another agent CLI

Most agent runtimes optimize for **autonomy**: give the model more tools, more
context, more freedom, hope the answer is right. Forja's bet is different:

- **Disciplined transparency over raw autonomy.** Every action with a
  persistent side effect goes through prior verification. Every cut decision
  has a fallback. Inferences declare confidence, not just conclusions.
- **Audit-first, not audit-as-afterthought.** Every tool call, permission
  decision, memory mutation, and provider request is content-addressed and
  persisted. Replay reconstructs the exact prompt the model saw.
- **Reversible by design.** Every write creates a checkpoint. `--undo`
  restores the working tree to a known state, with the bash side-effects
  caveat surfaced explicitly when it applies.
- **Explicit trust.** A new directory is untrusted until proven. Shared
  memory corpora need attestation. Permissions are layered (enterprise →
  user → project → session) with attribution on every grant.
- **Honest about token cost.** A per-tool summarization layer reduces output
  before it enters context, the system prompt is split across cache
  breakpoints to minimize re-cache cost, and the footer surfaces cache
  hit-rate so optimizations are measurable instead of asserted.

---

## Install

Forja runs on [Bun](https://bun.sh) (single binary via `bun build --compile`).
The current build target is Linux x64; macOS and Windows binaries are tracked
on the roadmap.

```bash
git clone <repo-url> forja && cd forja
bun install
bun run build              # produces dist/agent-linux-x64
ln -s "$PWD/dist/agent-linux-x64" ~/.local/bin/agent
```

Verify the install:

```bash
agent --version
agent doctor               # platform, sandbox tools, config + data dirs, git
```

For a guided first-boot walkthrough (doctor + sandbox setup + next steps):

```bash
agent welcome
```

---

## First run

Forja needs an API key for at least one provider. Pick one:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic (default model)
export OPENAI_API_KEY=sk-...            # OpenAI
export GOOGLE_API_KEY=...               # Google
```

Open the interactive REPL inside a project you want to work on:

```bash
cd ~/projects/my-repo
agent
```

The first time Forja sees a directory, it asks you to attest the trust
boundary — once accepted, your `.agent/` bootstrap (`permissions.yaml`,
playbooks, skills, project-local memory) is loaded.

Or run a one-shot prompt:

```bash
agent "summarize the README"
agent --model openai/gpt-4o "list the public functions in src/api/"
```

Run it as a headless tool (emits NDJSON events to stdout):

```bash
agent --json "what changed in the last commit?" > events.ndjson
```

---

## What's in the box

| Subsystem | What it does | Surfaces |
|---|---|---|
| **Harness loop** | The agent runtime: step budget, max-cost cap, compaction at 70% context, retries with classified failure modes | `agent <prompt>`, `agent --plan` |
| **Permissions** | Layered allow/deny policy with glob + prefix matching (no regex). Sandbox profiles per tool category. Per-session approval posture (supervised / autonomous) | `agent --explain-permissions`, `--autonomous`, Shift+Tab, `.agent/permissions.yaml` |
| **Memory** | Cross-session knowledge with three scopes (user / project_shared / project_local), explicit trust, lifecycle states (active / quarantined / invalidated), provenance tracking | `agent --memory list`, `agent --memory show <name>`, `/memory` slash |
| **Skills** | Eager-loaded catalog of operator-authored procedures, body lazy | Skills auto-surface in system prompt; `/skill` slash |
| **Subagents** | Worktree-isolated child runs (`task`), async handles (`task_async`), parallel dispatch with caps | `agents/*.md` playbooks |
| **Checkpoints** | Auto-snapshot of the working tree before any write tool. `--undo` restores | `agent --undo <session>`, `agent --checkpoints list <session>` |
| **Audit** | Append-only event log across messages, tool calls, approvals, hooks, failures, memory events, checkpoints. Optional hash chain (tamper-evident) | `audit_timeline` view, `.local/share/forja/audit.db` |
| **Hooks** | Operator-provided shell hooks at lifecycle events (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, etc.) with `additionalContext` injection | `.agent/hooks/` |
| **Recap** | Session-end terse summary; structured PR / Slack / mini formats via the recap pipeline | `/recap`, session-end output |
| **Resume** | Continue a prior session by id (or `last`) — replays scrollback and rebuilds context with auto-rehydrate | `agent --resume <id> "follow-up prompt"` |
| **Token efficiency** | Cache breakpoints split across stable / memory segments; per-tool output summarization (bash / grep / glob); footer chip surfaces session-wide cache hit-rate | Footer chip, `[forja:output_summarized ...]` markers |

---

## Modes

**Interactive REPL** (default). Persistent TUI with inline rendering, slash
commands (`/memory`, `/budget`, `/plan`, `/history`, …), reverse search,
ctrl-c double-tap-to-exit gate.

**One-shot.** Pass the prompt as a positional arg; Forja runs to completion
and exits. Useful in scripts:

```bash
agent "regenerate the openapi.yaml from the route handlers and run npm test"
```

**Headless / NDJSON.** `--json` emits one event per line on stdout (banner,
session lifecycle, tool calls, assistant messages, usage, failures). Stderr
carries logs. Consumable by external tooling:

```bash
agent --json "lint the src/ tree" | jq 'select(.type=="tool:end")'
```

**Plan mode.** `--plan` runs the agent in read-only mode — no writes, no
mutating bash. Useful to preview what the agent would do before letting it
loose:

```bash
agent --plan "what would you change to add pagination to /orders?"
```

---

## Provider support

| Provider | Models | Cache | Streaming | Notes |
|---|---|---|---|---|
| Anthropic | claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5 | 5min ephemeral (1h opt-in planned) | ✓ | Default. Multi-block cache breakpoints (stable + memory + tools + tail). |
| OpenAI | gpt-4o, gpt-4o-mini, gpt-5.x (selected) | — | ✓ | Reads the canonical system prompt; ignores per-segment cache markers. |
| Google | gemini-2.x families | — | ✓ | Same compat path as OpenAI. |
| Local models | Planned (`ollama`, `llama.cpp`) | varies | varies | Specs in `docs/spec/LOCAL_MODELS.md`; not yet shipped. |

Switch with `--model <id>`. Cost is computed per-turn from declared per-1M
pricing in `src/providers/<family>/capabilities.ts`.

---

## Configuration

Forja layers configuration from three sources, each optional:

- **Enterprise** — system-wide (`/etc/forja/permissions.yaml`)
- **User** — `~/.config/forja/`
- **Project** — `.agent/` in the repo root (created by `agent init`)

`agent --explain-permissions` shows the resolved policy with per-section
attribution to its originating layer.

Bootstrap a new project:

```bash
cd ~/projects/my-repo
agent init                  # creates .agent/permissions.yaml + playbooks + skills
agent init --mode strict    # locked-down default (no auto-allow on bash)
```

---

## Safety model

- **Trust gate.** First time you `cd` into a project, Forja asks you to
  attest the directory. Untrusted directories don't load project
  configuration.
- **Sandbox.** On Linux, Forja runs bash inside `bwrap` with `hide_paths`
  for sensitive directories (`~/.ssh`, `~/.config/agent`, the audit DB).
  On macOS, the same defense via `sandbox-exec` SBPL.
- **Permission engine.** Tool calls pass through a layered policy with
  decision attribution. By default, confirms route through an interactive
  modal in REPL mode; in headless mode, deny-by-default unless explicitly
  allowed.
- **Operation mode.** Approval posture, per session. **Supervised** (default)
  sends every `confirm` to the modal; **Autonomous** (`--autonomous` at boot,
  or Shift+Tab in the REPL) auto-approves only routine low-risk policy
  confirms — compound / high-risk confirms still prompt, a degraded engine
  re-arms the modal, and hard denies stay unreachable. Not `bypass`: every
  engine floor holds, and each auto-approval is audited.
- **No auto-commit.** Forja never creates git commits without explicit
  operator action.

---

## Status

**Active development, pre-1.0.** Breaking changes between minor versions
are expected. The architectural spec under `docs/spec/` describes the
target shape; `docs/BACKLOG.md` tracks shipped work in reverse-chronological
order, and `docs/TODO.md` lists deferred work with pull-in signals.

---

## License

Apache-2.0. See `LICENSE`.
