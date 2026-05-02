# CLAUDE.md

Instructions for AI assistants working on Forja — the agentic CLI specified in `docs/spec/`.

## Root premise

> **Measure twice, cut once.**

Every action with a persistent side effect goes through prior verification. Every cut decision has a fallback. Every inference declares what was **not** measured (`not_checked`, `assumptions`, `confidence`). The principles in `docs/spec/AGENTIC_CLI.md §1` derive from this root.

## Before implementing any subsystem, read the spec

The architectural spec lives in `docs/spec/AGENTIC_CLI.md`. Each subsystem has a dedicated doc:

| Implementing | Read |
|---|---|
| Harness, loop, budget, profiles | `AGENTIC_CLI` §5, `STATE_MACHINE`, `ORCHESTRATION` |
| Tools | `AGENTIC_CLI` §7, `CONTRACTS` §2.6 |
| Provider adapters | `PROVIDERS`, `LOCAL_MODELS`, `AGENTIC_CLI` §14 |
| Permissions | `AGENTIC_CLI` §8 |
| Trust / sandbox / threat model | `AGENTIC_CLI` §9, `SECURITY_GUIDELINE` |
| Hooks | `AGENTIC_CLI` §10, `CONTRACTS` |
| Subagents / playbooks | `AGENTIC_CLI` §11, `PLAYBOOKS` |
| Checkpoints / undo | `AGENTIC_CLI` §12 |
| Storage / schema / audit | `AGENTIC_CLI` §13, `AUDIT` |
| Context engine, compaction | `AGENTIC_CLI` §6, `CONTEXT_TUNING` |
| Sampling, output budgets | `TOKEN_TUNING` |
| TUI (inline render, event bus, microcopy, palette/glyphs) | `AGENTIC_CLI` §17, `UI` |
| Cross-session memory | `MEMORY` |
| Recap | `RECAP` |
| Code index (tree-sitter) | `CODE_INDEX` |
| Code generation pipeline | `CODE_GENERATION` |
| MCP | `MCP` |
| Failure handling, recovery | `FAILURE_MODES` |
| Performance budgets, SLOs | `PERFORMANCE` |
| Feature flags | `FEATURE_FLAGS` |
| **What NOT to do** | `ANTI_PATTERNS` (read before proposing any "cool feature") |

The spec is a protocol, not a suggestion. Diverging from the spec requires a PR against the spec **first**, code after. Never edit `docs/spec/` without an explicit user request.

## Locked stack

- Language: **TypeScript** strict
- Runtime: **Bun** (single binary via `bun build --compile`)
- Storage: **SQLite via `bun:sqlite`** — raw SQL with types, **no ORM**
- TUI: **Internal (raw ANSI + raw stdin), no framework** — inline render
- Lint/format: **Biome**
- Test: **`bun test`** (built-in)
- Provider SDKs: `@anthropic-ai/sdk` (M1), `@modelcontextprotocol/sdk` (M3+)

Stack changes require a PR against `docs/spec/AGENTIC_CLI.md §3`.

## Hard rules

- **No ORM.** Raw SQL with types.
- **No regex in policy/permissions.** Glob + prefix only.
- **No vector DB in v1.** No cargo cult (principle 12, `ANTI_PATTERNS` §2.2).
- **No auto-commit, no persona tuning, no prompt-as-IP, no undercover mode.** Read `ANTI_PATTERNS` first.
- **Eval is load-bearing.** A subsystem without eval doesn't ship (principle 4).
- **stdout is pure, stderr is for logs.** `--json` mode means NDJSON on stdout, nothing else.
- **Trace everything.** Without reproducibility, it doesn't exist (principle 7).
- **Reversible by design.** Every write has a checkpoint (principle 10).
- **Explicit trust.** New directory / unknown `AGENTS.md` is untrusted until proven.

## Required workflow

1. Identify the relevant spec doc(s) and read them before coding.
2. Update `docs/BACKLOG.md` (new entry on top) **before** and **after** the work.
3. New code is born with tests. No tests means not done.
4. Commit messages describe the **why**, not the what. Commits in English.
5. Branch per milestone (`feat/mN-*`) until trunk-based stabilizes.

## Commands

- `bun install` — install deps
- `bun test` — run tests
- `bun run dev` — entry point in watch mode
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — Biome check
- `bun run lint:fix` — Biome auto-fix
- `bun run build` — compile binary into `dist/agent`

## Layout

```
docs/
  spec/             # architectural spec (read-only without a spec PR; PT-BR)
  BACKLOG.md        # progress diary
src/                # subsystems emerge as each milestone demands
tests/
evals/              # smoke / regression / bench (spec §16)
```

Empty folders with `.gitkeep` are noise — subsystem directories (`src/harness`, `src/tools`, etc.) are born in the step that writes code into them.

## Language

The whole project is in **English**: source code, identifiers, comments, error messages, commit messages, `BACKLOG.md`, READMEs.

The single exception is `docs/spec/`, which stays in **PT-BR** — that is the architect's authored material. Do not translate the spec without an explicit request.
