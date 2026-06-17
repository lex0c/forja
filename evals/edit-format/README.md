# edit-format eval — edit_file vs git_apply_patch

Measures which **edit format** a target model lands more reliably on the same
tasks: `edit_file` (exact `{old_string,new_string}` pairs) vs `git_apply_patch`
(a unified diff). Drives the primary-vs-niche decision for the two edit tools
(see `docs/spec/CONTRACTS.md §2.6.8.A` deferral and `docs/BACKLOG.md`).

## Design

Each task ships as a **pair** of cases with an identical edit but a different
steered tool:

- `NN-<task>-edit.yaml`  → instructs `edit_file`
- `NN-<task>-patch.yaml` → instructs `git_apply_patch`

Both assert the SAME post-edit `file_contains` + `status: done` + the intended
`tool_called`. So a case passes only if the model produced a working call in
that format. The only variable is the format.

Tasks are chosen to stress the formats' distinct failure modes:

1. **single-line** — baseline (both should pass).
2. **multi-hunk** — two separate changes in one file (edit_file's N-edits array
   vs patch's two hunks).
3. **repeated-lines** — change one of several near-identical lines (edit_file
   needs a unique `old_string` with context; patch uses hunk context).
4. **nested-indent** — change a deeply-indented line (whitespace must be exact
   in both).

## Reading the result

Run the directory and compare the pass-rate of the `*-patch` cases against the
`*-edit` cases. Because model runs are non-deterministic, run a few times (or
extend with `--repeat`) and aggregate. The higher-passing format is the
candidate **primary** edit tool; the other stays the niche/fallback.

## Run

```
bun run src/evals/cli.ts evals/edit-format --model anthropic/claude-opus-4-8
bun run src/evals/cli.ts evals/edit-format --model openai/gpt-5.4
```

Not part of `eval:smoke` (model-in-the-loop, costs tokens). Run deliberately.
