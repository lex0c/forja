# `forja init` eval

End-to-end pin for the init → bootstrap handshake. Per
[`CLAUDE.md`](../../CLAUDE.md) principle 4 + spec
[`AGENTIC_CLI.md §16`](../../docs/spec/AGENTIC_CLI.md):

> Eval is load-bearing. A subsystem without eval doesn't ship.

`tests/cli/init*.test.ts` and `tests/cli/bootstrap*.test.ts` each
cover their side in isolation. This eval is different: it pins the
**cross-subsystem invariant** — `forja init` scaffolds exactly the
files `forja` boot reads, with exactly the values the bootstrap
loaders expect. A refactor in either side that silently breaks the
handshake fails here before the operator's first invocation does.

## What this eval catches

- **Schema drift between renderer and parser.** `init-config-template`
  emits a key (`max_steps`) that the loader's `BUDGET_INT_KEYS`
  doesn't recognize — bootstrap silently ignores it and the
  operator's pinned value never takes effect.
- **Path drift.** `projectPolicyPath` / `projectAgentsDir` change
  shape; init still writes "the old" location while bootstrap reads
  "the new" — fresh install boots in default-deny without anyone
  noticing.
- **Value drift between scaffold + code defaults.** Scaffold writes
  `model = "<old>"`; bootstrap's `DEFAULT_MODEL` is `<new>`; init
  fixed the value at scaffold time but the resolution chain doesn't
  flag the discrepancy (it shouldn't — scaffold wins per spec).
  Pinned via `[providers].model === DEFAULT_MODEL` after a default
  init.
- **Partial-scaffold compatibility.** `--only=permissions,config`
  scaffolds two of four artifacts; bootstrap still walks to ready
  (no missing-file refusal). This is the "operator who only wants
  policy + config, not playbooks" path.
- **Re-run idempotency at the boot level.** Second init touches
  nothing; bootstrap still reads the SAME files with the SAME
  values. Catches a refactor that makes init's no-op write
  semantically different from "file untouched".

## What this eval does NOT catch

- **LLM behavior under the scaffolded model.** The eval uses a
  `providerOverride` mock — no actual API calls. Verifying that
  `anthropic/claude-opus-4-7` (or whatever DEFAULT_MODEL is) is
  resolvable against the registry is covered by
  `tests/providers/*` and `bootstrap.test.ts`.
- **Multi-operator concurrency.** Two `forja init` running
  simultaneously could TOCTOU; the atomic-write fix shipped
  alongside this eval reduces but does not eliminate the window.
- **Compiled-binary path** (`bun build --compile`). Asset bundling
  via `with { type: 'text' }` is tested by other suites; this
  eval runs against the dev/source path.

## Runner

`tests/cli/init-eval.test.ts` — fixtures inlined for now (the
scenario surface is small enough that per-fixture TS files would be
overhead). Extract when the matrix grows past ~6 cases.
