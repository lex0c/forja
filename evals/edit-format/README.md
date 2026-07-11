# edit-format eval — `edit_file` reliability

`edit_file` (exact `{old_string, new_string}` pairs) is the **primary** edit tool
for a coding agent, so this suite stresses a model's ability to produce correct,
surgical edits with it.

> Previously this directory ran a forced `edit_file` vs `git_apply_patch` A/B (one
> `-edit` + one `-patch` case per task). That decision is settled: `git_apply_patch`
> (the unified-diff fallback) is deferred behind `tool_search` per
> `docs/spec/CONTRACTS.md §2.6.8.A`, so production steers away from it. The forced
> `-patch` cases were removed — testing a tool we deliberately hide just penalized
> models for not finding it.

## What each case stresses

**Format-stress (the exact-match contract):**

1. **single-line** — baseline replace.
2. **multi-hunk** — two changes in one `edit_file` call (the N-edits array).
3. **repeated-lines** — change one of several near-identical lines (needs unique context).
4. **nested-indent** — change a deeply-indented line (whitespace must be exact).

**Realistic coding edits:**

5. **rename-symbol** — rename a local across all its uses; `file_not_contains` proves
   no stale name lingers (a rename that adds the new name but leaves the old fails).
6. **locate-then-edit** — the prompt withholds the exact key/value, so the model must
   read the file to ground the edit (measure twice, cut once).
7. **add-parameter** — two coordinated changes (signature + body) in one function.

Each case asserts the post-edit file content (`file_contains` / `file_not_contains`),
that `edit_file` was used and `write_file` was **not** (a surgical edit, not a rewrite),
and `status: done`.

## Run

```
bun run src/evals/cli.ts evals/edit-format --model anthropic/claude-opus-4-8
```

Model-in-the-loop (costs tokens) — not part of `eval:smoke`. Also one of the
ranking suites (`scripts/model-ranking.ts`); run deliberately.
