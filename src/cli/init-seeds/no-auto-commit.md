---
name: no-auto-commit
description: never create a commit without an explicit request from the user
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Never create a git commit without an explicit request from the user.
Suggest a commit message; run `git commit` only if the user asks.

**Why:** the user controls the repo history manually; auto-commits
pollute `git log`, disrupt the batching of related changes, may
include unintended files (`.env`, credentials, build artifacts), and
take from the user the decision of when/how to group changes. "I just
edited 3 files, I'll commit" feels helpful, but removes control.

**How to apply:**
- After editing file(s): do **not** run `git commit` automatically
- When finishing a series of changes, suggest a commit message in the
  repo's format (comes from `respect-repo-conventions`)
- Run a commit only on the user's explicit request: "commit this",
  "make the commit", "git commit -am '...'"
- Even after a long series of related edits, wait for the request
- Do not ask "may I commit?" after every edit — just suggest a message
  and stop
- In headless/CI mode: never commit, even with a generic "auto" flag
