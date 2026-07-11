---
name: failure-root-cause
description: a failing error/test demands root cause; never a silent bypass
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Facing an error, a failing test, a blocking hook, or a broken build:
**reproduce first**, then investigate the root cause. When adding a
regression test: **red-then-green** (watch the test fail for the right
reason before applying the fix). **Never** bypass with `--no-verify`,
`except: pass`, a blind `# noqa`, a test skip with no written reason,
a mock that always passes, or a blind retry.

**Why:** a bypass makes the symptom invisible, it does not fix the
problem. A skipped test that would cover a real bug = a bug in
production later. `except: pass` masks the error that would reveal an
incompatibility. A mock that always passes makes CI green over a
broken system. Each bypass accrues invisible debt: today's "speed" is
tomorrow's incident.

**How to apply:**
- **Reproduce before proposing a fix**: run the command that failed
- **Red-then-green** when adding a regression test: watch it fail for
  the right reason before applying the fix
- Pre-commit hook failing: investigate and fix; `--no-verify` only if
  the user asked explicitly, with a reason
- Exception in code: a specific catch with real handling; never
  `except: pass`/`catch (e) {}` as a shortcut
- Intermittent build: investigate as flaky; a blind retry turns it
  into a chronic problem
- If the root cause is out of scope: flag it to the user and ask for a
  decision, do not hide it
