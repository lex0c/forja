# Backlog

Forja progress diary. Entries in reverse chronological order (newest on top).

Format:

```
## [YYYY-MM-DD] <milestone>/<step> — <title>

**Done:** ...
**Decisions:** ...
**Pending:** ...
**Next:** ...
```

---

## [2026-04-27] M1 / Step 1 — Repository bootstrap

**Done:**
- Branch `feat/m1-foundation` created from `main`.
- `CLAUDE.md` at the root: root premise, Doc→Subsystem map, locked stack, hard rules, workflow.
- `docs/BACKLOG.md` (this file).
- `package.json` with scripts (`dev`, `test`, `lint`, `typecheck`, `build`) and bin `agent`.
- `tsconfig.json` strict (including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- `biome.json` (linter + formatter, 100 col, single quotes, semicolons).
- `.gitignore` covering runtime state per spec §2.7 (`.agent/sessions.db`, traces, checkpoints, local memory).
- `src/cli/index.ts` stub — responds to `--version` / `-v`; anything else exits 1 with a pointer to the spec.
- Project-wide language policy: English everywhere except `docs/spec/` (PT-BR).

**Decisions:**
- **Test runner:** `bun test` built-in, not Vitest from spec §16. Reason: aligns with principle 5 ("single runtime"); zero extra deps. Revisit if a critical Vitest feature is missing.
- **Linter:** Biome (single binary, Bun-friendly) instead of ESLint + Prettier — same single-runtime alignment.
- **`docs/BACKLOG.md` instead of `.txt`** — markdown renders on GitHub and matches the rest of the repo.
- **Branch per milestone** (`feat/mN-*`) until trunk-based stabilizes.
- **No empty subsystem folders** — they emerge in the step that needs them. `.gitkeep` in empty dirs is noise.
- **Stack matches spec §3** exactly: TS + Bun + bun:sqlite + Ink. No drift.
- **Project language is English**; only `docs/spec/` stays in PT-BR.

**Pending:** none for this step.

**Next:** Step 2 — Storage layer (SQLite) with the minimal schema from `AGENTIC_CLI §13`: tables `sessions`, `messages`, `tool_calls`, `approvals`, `checkpoints`, `traces`. Migrations infra. Thin repository pattern over `bun:sqlite`. Schema + basic CRUD tests.
