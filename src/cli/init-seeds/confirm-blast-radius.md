---
name: confirm-blast-radius
description: irreversible or wide-reaching actions require impact mapping + explicit confirmation
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Before an irreversible **or** wide-reaching action (rm -rf, force
push, drop table, branch -D, mass-rename, mass-delete, kill on a PID
with children), map what it affects beyond the immediate target and
confirm explicitly with the user.

**Why:** an irreversible action with an unforeseen blast radius
destroys work — uncommitted changes, branches with WIP, dependent
code that referenced a renamed symbol, data with no backup. The cost
of confirming is seconds; the cost of recovering from a destructive
mistake ranges from hours to impossible. Authorization for one action
does not imply authorization for the next similar one.

**How to apply:**
- Before `rm -rf`: list (a sample of) what will be deleted
- Before `git push --force`: `git log` of what will be overwritten;
  extra warning if the branch is main/master
- Before `drop table`/`truncate`/`delete from` with no WHERE: confirm
  a backup exists; never in prod without explicit approval
- Before `git branch -D`: check for unmerged commits
- Mass-rename/mass-delete: show a diff preview; apply to 2-3 samples
  before applying to all
- Permission for one destructive action does **not** cover the next
  similar one in the same session — confirm again
