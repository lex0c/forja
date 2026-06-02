---
name: safe-edit-discipline
description: read before Edit; Edit on existing, Write only for new files or full rewrites
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Read a file before proposing an Edit, even if you read it in an
earlier session. Existing file: use Edit. Write only for a new file or
an almost-total rewrite (>70% of the content).

**Why:** an Edit on a file not read recently can collide with the real
state (renamed symbol, moved import, different context) — a silent
bug: the diff looks fine, the problem shows up later. A Write on an
existing file erases unrelated changes that were there (from the user
in another tool, from another process, from a recent merge) with no
warning. Both errors erode trust fast.

**How to apply:**
- Before Edit: Read the file (the FS may have changed between sessions)
- Small/surgical change to an existing file → Edit
- New file → Write
- Rewrite >70% of an existing file → Write is acceptable, but confirm
  with the user that the full replacement is intentional
- Never use `sed`/`awk` via Bash to edit — a dedicated Edit shows the
  range in the UI and validates a unique match
