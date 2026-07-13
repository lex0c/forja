# xAI (Grok) provider eval

The native xAI adapter (`src/providers/xai/`, family `xai`) reaches `api.x.ai`
directly — distinct from the OpenRouter route to Grok (`openrouter/x-ai/grok-4.5`).
It is OpenAI-compatible Chat Completions, so — like the Ollama/OpenRouter evals —
there are **no** xAI-specific eval cases: the point is to measure how each Grok
model does on the same suites the other tiers run, via `--model xai/<model>`.

Grok 4.5 is a **frontier-class** model — judge it against the Frontier tier in
`PROVIDERS.md §7.3`.

## Prerequisites

- `XAI_API_KEY` set — the **sole** key source (the adapter has no env fallback; the
  catalog maps it to a bearer header). Keys are `xai-…`.
- Credits on the key. grok-4.5 is $2/1M in, $6/1M out (see `PROVIDERS.md §5`); it
  always reasons, and reasoning tokens bill on top of the visible output, so a
  reasoning-heavy suite is not free.
- Note: the compiled binary does NOT read `.env`; export the key in the shell (a
  `bun run`/`bun test` invocation does load `.env`).

## Run

    bun run eval:smoke:xai                                 # smoke suite against grok-4.5
    # other suites:
    bun run src/evals/cli.ts evals/regression --model xai/grok-4.5

The id is a single slash (`xai/grok-4.5`) — unlike OpenRouter's two-slash ids.

## Thresholds (`PROVIDERS.md §7.3`)

grok-4.5 is Frontier class:

| Tier | smoke | regression | playbook (review/refactor) |
|---|---|---|---|
| Frontier | ≥85% | ≥75% | ≥80% |

A model below its tier threshold is marked `recommended: false` in the catalog
rather than removed (the matrix stays honest).

## Integration smoke (adapter ↔ real API)

A fast end-to-end check that the wire path actually works — streamed text + usage,
a tool-call round-trip **with `reasoning_effort:high`**, structured JSON, sampling
on the reasoning model, and that reasoning surfaces as `thinking_delta` with no
replay block — separate from the full eval suites:

    FORJA_XAI_INTEGRATION=1 XAI_API_KEY=xai-... \
      bun test tests/providers/xai-integration.test.ts

Override the model with `FORJA_XAI_INTEGRATION_MODEL` (default `grok-4.5`).
Hermetic CI skips it (the env var / key are unset there).

This suite is the standing gate for the two assumptions a manual run settled on
2026-07-13: xAI Chat Completions accepts `tools`+`reasoning_effort` together
(unlike OpenAI's reasoning models, which require `/v1/responses`), and grok-4.5
accepts `temperature`/`top_p` despite always reasoning.

## Publishing results

Save the eval CLI output to `results.json` in this directory per the
`PROVIDERS.md §6` add-a-provider checklist (item 7).
