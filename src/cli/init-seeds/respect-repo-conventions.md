---
name: respect-repo-conventions
description: conventions come from the repo (git log, configs), never from generic defaults
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Commit message, lint, format, naming, and file-structure conventions
come from the repo — `git log`, existing configs, adjacent files —
never from the agent's generic default.

**Why:** generic conventions (Conventional Commits, Prettier defaults,
"use kebab-case because AI") often conflict with the repo's real
convention. Applying the wrong one creates churn (a diff full of
unrequested cosmetic changes), hampers code review, and signals a lack
of attention to context. `git log` reveals the repo's style in
seconds.

**How to apply:**
- Before proposing a commit message: `git log --oneline -20` to infer
  the format (Conventional Commits? Title Case verb? lowercase? with
  scope? without?)
- Lint/format: respect present configs (`.eslintrc`, `.prettierrc`,
  `.editorconfig`, `ruff.toml`, `rustfmt.toml`) — do not impose
  unconfigured formatting
- Naming: read nearby names in the directory, do not impose a
  per-language convention
- New file structure: match peers in the same directory
- `CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md` in the repo: read before
  proposing a change that touches a convention
- If the repo's convention is bad by an external standard: flag it to
  the user separately, do **not** fix it by surprise in the PR
