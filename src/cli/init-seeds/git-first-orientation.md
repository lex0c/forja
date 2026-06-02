---
name: git-first-orientation
description: a fresh session in a git repo starts with git status + git log -10
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

In a fresh session in a git repo, start with `git status` +
`git log --oneline -10` before exploring the FS. Treat git as a
primitive for temporal/causal navigation, not just versioning.

**Why:** `ls`/`glob` shows structure but not direction. `git status` +
`git log -10` reveal in ~200ms: what is in progress, what changed
recently, the current axis of work. Without that orientation, the
agent burns tokens exploring code that may have been refactored or
removed last week. Bugs often come from a recent change; `git log -S`,
`git bisect`, `git blame -L` cut the search space exponentially vs.
blind grep.

**How to apply:**
- Fresh session in a git repo: run `git status` + `git log --oneline -10`
  before any structural exploration
- "Where is X?" is often "X was touched recently —
  `git log -p --follow path/X`"
- Bug investigation: start with `git log --since=<range>` or
  `git log -S "fragment of the error message"`
- "Why does this line exist?" → `git blame -L start,end file`
- "Who knows this area?" → `git log --format=%an path/ | sort -u`
- Fallback: a repo with no meaningful history (heavy squash, fresh
  shallow clone) loses this primitive — fall back to spatial navigation
