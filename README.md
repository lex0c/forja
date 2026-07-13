# Forja

Forja is an autonomous programming agent that runs on your terminal. It understands your codebase, reads and edits files, executes commands, coordinates tools, and analyzes various files to build features, fix bugs, and automate development work.

What sets Forja apart is the structure surrounding the model. Every action with an effect is logged, every tool call is audited, and every inference makes its uncertainties and unmeasurable assumptions explicit. The model is not the system. Forja was designed to make autonomous programming observable, reversible, and reliable.

> **Measure twice, cut once.**

**demo**
![Forja demo](docs/demo.gif)

## Get started

<!-- npm-ignore-start -->
Install the latest release — the script detects your OS/arch, downloads the
matching binary from GitHub Releases, verifies it against the published
`SHA256SUMS`, and installs into `$HOME/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/lex0c/forja/main/install.sh | sh
```

Pin a version or change where it lands:

```bash
# a specific release
curl -fsSL https://raw.githubusercontent.com/lex0c/forja/main/install.sh | sh -s -- v1.0.1

# custom install dir (default: $HOME/.local/bin)
curl -fsSL https://raw.githubusercontent.com/lex0c/forja/main/install.sh | sh -s -- --prefix "$HOME/bin"
```

The installer is fail-closed: if the binary's hash doesn't match the
`SHA256SUMS` shipped with the release, nothing is written to disk. Prefer to
do it by hand? Every release also carries the binaries, `SHA256SUMS`, a
CycloneDX SBOM, and SLSA build provenance on the
[Releases](https://github.com/lex0c/forja/releases) page — download the
binary, verify its hash against `SHA256SUMS`, and drop it on your `PATH`.

**Prefer a package manager?**
<!-- npm-ignore-end -->

```bash
npm install -g @lex0c/forja
```

Verify the install:

```bash
forja --version
forja doctor               # platform, sandbox tools, config + data dirs, git
```

---

## First run

Forja needs an API key for at least one provider. Pick one:

```bash
export OLLAMA_API_KEY=...               # Ollama Cloud
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic (default model)
export OPENAI_API_KEY=sk-...            # OpenAI
export GOOGLE_API_KEY=...               # Google
export OPENROUTER_API_KEY=sk-or-...     # OpenRouter (gateway → DeepSeek, GLM, Kimi, Qwen, Grok, ...)
export XAI_API_KEY=xai-...              # xAI (Grok, native api.x.ai)
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
| OpenRouter (gateway) | deepseek-v4 flash/pro, minimax-m3, glm-5.2, kimi-k2.6, qwen3.6-plus, grok-4.5, tencent/hy3:free | 5min server (auto; qwen explicit) | ✓ | One `OPENROUTER_API_KEY` reaches many vendors. Own adapter: reasoning-effort/replay, `cache_control`, in-band-error handling, middle-out off. `--model openrouter/<vendor>/<model>` (two slashes). |
| xAI (Grok) | grok-4.5 | 5min server (auto) | ✓ | Native `api.x.ai` (not the OpenRouter route). Own adapter: flat `reasoning_effort` (low/medium/high, default high, non-disableable), `reasoning_content` streamed as thinking, `stop` withheld from reasoning models. `--model xai/grok-4.5`. |

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
  or Shift+Tab in the REPL) auto-approves the **dev loop** by EFFECT — run the
  language toolchain, create/edit/delete project files, execute scripts, fetch
  the web, and use non-destructive git. Anything OUTSIDE that loop still
  prompts: paths outside the repo, protected/sensitive files, **destructive
  git** (gated by verb — publishes / rewrites history / discards work /
  deletes-or-forces a ref / plants `.git/config` authority), an **upload**
  (egress paired with a repo-file read), secret/env mutation, and commands the
  resolver can't fully model (loops / dynamic `$vars`, where the capabilities
  are best-effort). A degraded engine re-arms the modal; hard denies stay
  unreachable. Not `bypass`: every engine floor holds, and each auto-approval
  is audited.
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

Contributing to Forja itself? Start with [`docs/DEV.md`](docs/DEV.md) — the
setup, dev loop, and quality gates for working on the codebase.

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
