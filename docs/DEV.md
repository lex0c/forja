# Developing Forja

This guide gets a contributor from a fresh checkout to a running dev build,
the quality gates green, and a change ready for review. It documents the
project **as implemented** — where behavior and the spec diverge, the spec
(`docs/spec/`) wins; see [Contributing workflow](#contributing-workflow).

## The stack

Forja is a single self-contained binary. No Node, no bundler config, no ORM.

| Concern            | Choice                                                             |
| ------------------ | ------------------------------------------------------------------ |
| Language           | **TypeScript**, `strict` (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) |
| Runtime & toolchain| **Bun** — runner, test runner, bundler, and `bun build --compile` |
| Storage            | **SQLite** via `bun:sqlite` — raw typed SQL, no ORM               |
| TUI                | Internal (raw ANSI + raw stdin), no framework                     |
| Lint / format      | **Biome**                                                         |
| Tests              | **`bun test`** (built-in)                                         |

Bun *is* the toolchain: `bun install`, `bun test`, `bun run typecheck`
(`tsc --noEmit`), and `bun build --compile` all run through it. A Node install
on your machine is neither used nor required.

## System requirements

| Requirement          | Details                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Operating system     | Linux or macOS 12+. Windows 11 **via WSL2** (the sandbox needs a Linux/macOS kernel).     |
| Bun                  | **≥ 1.1.30** (`engines.bun`). CI pins **1.3.13** — match it locally to avoid lockfile drift. |
| ripgrep (`rg`)       | Backs the `grep` tool. Tests skip gracefully without it, but coverage shrinks — install it. |
| Sandbox              | Linux: `bwrap` (bubblewrap). macOS: `sandbox-exec` (ships built-in). Bash runs sandboxed;  without it those tests skip and runtime falls back to a degraded posture. |
| Git                  | 2.23+ recommended — checkpoints, worktree-isolated subagents, and the `git_*` tools use it. |
| RAM                  | 4 GB minimum, 8 GB recommended.                                                           |

Install Bun (if you don't have it):

```bash
curl -fsSL https://bun.sh/install | bash
```

Install the sandbox + ripgrep for your platform, e.g. on Debian/Ubuntu:

```bash
sudo apt-get install -y bubblewrap ripgrep
```

On macOS `sandbox-exec` is already present; `brew install ripgrep`. When in
doubt, `forja doctor` (below) tells you exactly what's missing and how to fix it.

## Build from source

```bash
# Clone and enter the repo.
git clone https://github.com/lex0c/forja.git
cd forja

# Install dependencies against the committed lockfile.
bun install --frozen-lockfile

# Sanity-check the checkout: these are the exact PR gates (see CI below).
bun run typecheck
bun run lint
bun test
```

`--frozen-lockfile` mirrors CI — it fails instead of silently editing
`bun.lock`. Use a plain `bun install` only when you're intentionally changing
dependencies.

## Provider keys

Forja needs an API key for at least one provider, **or** a local Ollama daemon
(no key, `$0`). For source runs, Bun auto-loads a `.env` in the repo root, so
the simplest path is a gitignored `.env`:

```bash
# .env — read by `bun run`, ignored by git. NOT read by the compiled binary.
ANTHROPIC_API_KEY=sk-ant-...     # default model (anthropic/claude-opus-4-8)
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=sk-or-...     # gateway → DeepSeek, GLM, Kimi, Qwen, Grok, ...
OLLAMA_API_KEY=...               # Ollama Cloud only; local Ollama needs no key
```

Exporting the vars in your shell works too and is equivalent. Note the
**compiled binary does not read `.env`** — it uses the ambient environment;
`.env` is a source-checkout convenience only.

No paid key? Run entirely local against Ollama:

```bash
bun run dev --model ollama/qwen2.5-coder:14b
```

## Running the dev build

`bun run dev` runs the CLI from source **in watch mode** under an isolated
`dev` profile, so nothing you do touches your real Forja state:

```bash
bun run dev                    # REPL, watch-reloads on save, `forja-dev` namespace
bun run dev "summarize the README"   # one-shot from source
bun run start                  # run from source against the REAL namespace (no watch)
```

`--profile dev` (which `bun run dev` sets via `FORJA_PROFILE=dev`) relocates
**every** state dir to a parallel namespace — `~/.config/forja-dev`,
`~/.local/share/forja-dev`, `~/.cache/forja-dev`, and `<repo>/.forja-dev/` — so a
dev build can never migrate, pollute, or read your real sessions, config,
memory, or trust list. The banner and footer flag a profiled run in yellow.

### First boot: bootstrap the catalog

Boot now **requires** an operator-owned model catalog; with none present, boot
stops and points you at `forja init`. Bootstrap the dev profile once:

```bash
FORJA_PROFILE=dev bun run src/cli/index.ts init
```

That writes the project bootstrap (`.forja-dev/` — permissions, playbooks,
skills) and the catalog `~/.config/forja-dev/model_providers.json`. After that,
`bun run dev` boots straight into the REPL. (For the real namespace, drop the
`FORJA_PROFILE=dev` prefix.)

The first time Forja sees a directory it asks you to attest the trust
boundary — accept it to load the project bootstrap.

## The dev loop

After a change, run the same three gates CI enforces on every PR. Prefer the
scoped forms while iterating; run the full suite before pushing.

```bash
bun run typecheck                 # tsc --noEmit — strict, whole tree
bun run lint                      # biome check .
bun run lint:fix                  # biome check --write .  (auto-fixable)
bun run format                    # biome format --write . (formatting only)

bun test                          # full suite (~150s)
bun test tests/harness            # scope to one area while iterating
bun test tests/tools/grep.test.ts # a single file
```

Biome config lives in `biome.json`: 2-space indent, 100-col lines, single
quotes, always-semicolons, trailing commas. Notable enforced rules — no
`any` (`error`), no non-null assertion (`!`), `import type` required. `docs/`,
`dist/`, `node_modules/`, `.forja*/`, and eval fixtures are excluded.

### Testing notes

- **ripgrep-gated** and **sandbox-gated** tests skip cleanly when `rg` /
  `bwrap` are absent, so a bare machine still passes — but coverage silently
  shrinks. CI installs both; match it locally.
- Full-suite runs share one Bun process, so global singletons (doctor cache,
  bash parser, seeded catalog) can leak between files. If a test passes in
  isolation but fails in the full suite — or passes locally but fails in CI —
  suspect global-state ordering or a fixture that reads your real `~/.config`
  instead of an isolated `XDG_*` dir, before you suspect the code.

## Evals

Evals are load-bearing (spec principle 4) but are **not** part of the PR gate —
they cost real tokens and need a provider key, so run them when you touch a
subsystem they cover. Regression evals run in their own scheduled workflow.

```bash
bun run eval:smoke                       # default provider from your keys
bun run eval:smoke:ollama                # local, free
bun run eval:regression                  # anthropic/claude-haiku-4-5
bun run eval:skills                      # and eval:edit-format, eval:verify-gate,
                                         # eval:tool-search, eval:fetch-url, eval:mcp, ...
```

See `docs/BENCHMARK.md` (capability axis) and `docs/RANKING.md` (in-harness
behavior) for how the numbers are read.

## Building the binary

```bash
bun run build            # linux-x64, unminified → dist/forja-<version>-linux-x64
bun run build:release    # every release target
bun run build:size       # size gate (fails a >20% blow-up — also a CI gate)
bun run build:verify     # regenerate + verify SHA256SUMS round-trip
```

`bun run build:release` + `build:size` + the checksum round-trip run on every
PR (see below), so a broken `--compile` target or a size regression fails the
PR rather than surprising us at release time. `install.sh` is the end-user
installer — it fetches a published release asset and verifies it against
`SHA256SUMS`; it is not used for local development.

## Observability & debugging

Forja has no verbose/`--debug` log-level flag — it leans on structured surfaces:

- **`--json`** emits one NDJSON event per line on **stdout** (banner, session
  lifecycle, tool calls, assistant messages, usage, failures); **stderr**
  carries free-form logs. stdout stays pure in JSON mode. Pipe it to `jq` to
  watch the loop: `bun run dev --json "..." | jq 'select(.type=="tool:end")'`.
- **`forja doctor`** — platform, sandbox availability, config/data dir
  writability, policy load per layer, audit hash-chain, git. Run it profiled:
  `FORJA_PROFILE=dev bun run src/cli/index.ts doctor`.
- **`forja sandbox setup`** — when doctor reports the sandbox missing, prints
  the exact install command for your distro (never auto-installs).
- **`--explain-permissions`** — the resolved permission policy with per-section
  attribution to its originating layer (enterprise / user / project).
- The **audit DB** (`~/.local/share/forja-dev/audit.db` under the dev profile)
  is an append-only log of every message, tool call, approval, hook, and
  checkpoint — the ground truth when a run misbehaves.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every PR. A green
CI is exactly the local commands above:

| Job                          | What it runs                                                              |
| ---------------------------- | ------------------------------------------------------------------------- |
| **typecheck · lint · test**  | `bun run typecheck`, `bun run lint`, `bun test` (ripgrep installed)       |
| **dependency audit**         | `bun audit --audit-level=high` — a new high-severity CVE blocks merge; bump the floor via `overrides` in `package.json` |
| **cross-platform build · size gate** | `bun run build:release`, `bun run build:size`, checksum round-trip |

Reproducibility and the full release pipeline live in `release.yml`, gated at
tag time, not on every PR.

## Contributing workflow

Forja's working rules live in `CLAUDE.md`; the essentials for a contributor:

1. **Read the spec first.** The architecture is specified in `docs/spec/`
   (PT-BR — the architect's authored material). Each subsystem has a doc, and
   `CLAUDE.md` maps *what you're building* → *what to read*. The spec is a
   protocol: **diverging from it needs a spec PR first, code after.** Never edit
   `docs/spec/` without an explicit request.
2. **New code is born with tests.** No tests means not done.
3. **Update `docs/BACKLOG.md`** — a new entry on top — before and after the work.
4. **Commits describe the *why*, in English.** No auto-commit: never commit
   without explicit per-commit approval. Fixes to a local commit go in a new
   commit, never `--amend`.
5. **Everything is in English** — source, identifiers, comments, error
   messages, docs, commits. The one exception is `docs/spec/` (PT-BR).

Hard rules worth internalizing before you propose a "cool feature" (full list
and rationale in `CLAUDE.md` and `docs/spec/ANTI_PATTERNS.md`): no ORM; no
regex in policy/permissions (glob + prefix only); no vector DB; stdout pure /
stderr for logs; every write reversible via a checkpoint; explicit trust for
new directories.

## Where things live

```
docs/
  spec/          # architectural spec — read-only without a spec PR (PT-BR)
  BACKLOG.md     # progress diary (newest on top)
  *.md           # English operator + reference docs (start at README.md)
src/             # one directory per subsystem (harness, permissions, tools, tui, ...)
tests/           # bun test, mirrors src/ layout
evals/           # smoke / regression / benchmark suites
scripts/         # build, checksums, SBOM, ranking, swe-bench tooling
```

For the operator's-eye view of what the binary does, read `README.md` and the
docs it links.
