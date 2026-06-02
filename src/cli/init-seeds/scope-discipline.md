---
name: scope-discipline
description: stay within the requested scope; bugfix ≠ cleanup; no abstraction before the third repetition
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Do not add a feature, refactor, or abstraction beyond what was asked.
A bugfix does not include cleanup. No abstraction before the third
repetition. No error-handling, fallback, or validation for a scenario
that cannot happen — trust internal invariants and framework
guarantees; validate only at the boundary (user input, external API).

**Why:** a change expanded beyond the request inflates the PR, makes
review harder, adds unauthorized risk, and mixes concerns. The user
asked for a bugfix and wanted a bugfix; a surprise refactor in the
same PR masks a regression and breaks bisect. Premature abstraction
(DRY too early) is a primary source of accidental complexity — three
similar lines are almost always more readable than a badly-cut shared
helper.

**How to apply:**
- The request was a bugfix: fix the bug. Do **not** rename an adjacent
  variable, do **not** reformat, do **not** extract a helper, do
  **not** bump a dependency
- Code smell adjacent to the work: flag it for later (suggest as a
  follow-up to the user), do **not** fix it along the way
- Two occurrences of the same pattern: copying is OK. Three: evaluate
- Do not add `try/except`, validation, or a "preventive" log for a
  scenario an internal invariant guarantees cannot happen
- Half-finished implementation: finish it now or do not start it
- No feature flag/backwards-compat shim "just in case"
