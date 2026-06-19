# OpenRouter provider eval

OpenRouter is an OpenAI-compatible **gateway**, so — like the Ollama eval — there are
**no** OpenRouter-specific cases. The point is to measure how each gateway model does
on the same suites the other tiers run, via `--model openrouter/<vendor>/<model>`.

Because OpenRouter spans models of very different capability, the **tier is per-model**,
not per-provider: judge each model against the tier matching its class in
`PROVIDERS.md §7.3`, not a single OpenRouter threshold.

## Prerequisites

- `OPENROUTER_API_KEY` set — the **sole** key source (the adapter has no env fallback;
  the catalog maps it to a bearer header).
- Credits on the key. A healthy balance (~$10–20) avoids OpenRouter's low-balance credit
  checks, which add latency. Smoke is cheap; regression on a frontier-class model is not
  (see `PROVIDERS.md §7.5` cost estimates).
- Optional attribution: `FORJA_OPENROUTER_REFERER` / `FORJA_OPENROUTER_TITLE`.

## Run

    bun run eval:smoke:openrouter      # smoke suite against deepseek/deepseek-v3.2
    # other suites / models:
    bun run src/evals/cli.ts evals/smoke      --model openrouter/x-ai/grok-4.3
    bun run src/evals/cli.ts evals/regression --model openrouter/deepseek/deepseek-v3.2

Note the **two-slash** id (`openrouter/<vendor>/<model>`) — the OpenRouter model id is
itself `<vendor>/<model>`. Resolution keys off the whole id.

## Thresholds (`PROVIDERS.md §7.3`)

Pick the tier that matches the model's capability class:

| Tier | smoke | regression | playbook (review/refactor) |
|---|---|---|---|
| Frontier | ≥85% | ≥75% | ≥80% |
| Mid | ≥75% | ≥65% | ≥70% |
| Local | ≥60% | ≥45% | ≥50% |

Suggested mapping for the seeded catalog (confirm with results, don't assume):
- **Frontier/high-Mid class**: `deepseek/deepseek-r1`, `x-ai/grok-4.3`, `moonshotai/kimi-k2-thinking`.
- **Mid class**: `deepseek/deepseek-v3.2`, `qwen/qwen3-coder-plus`, `z-ai/glm-4.6`, `meta-llama/llama-3.3-70b-instruct`.

A model below its tier threshold is marked `recommended: false` in the catalog rather than
removed (the matrix stays honest).

## Integration smoke (adapter ↔ real API)

A fast end-to-end check that the wire path actually works — streamed text + usage, a
tool-call round-trip, structured JSON, and a reasoning trace — separate from the full eval
suites:

    FORJA_OPENROUTER_INTEGRATION=1 OPENROUTER_API_KEY=sk-or-... \
      bun test tests/providers/openrouter-integration.test.ts

Override the model with `FORJA_OPENROUTER_INTEGRATION_MODEL` (default
`deepseek/deepseek-v3.2`). Hermetic CI skips it (the env var / key are unset there).

## Publishing results

Save the eval CLI output to `results.json` in this directory per the `PROVIDERS.md §6`
add-a-provider checklist (item 7).
