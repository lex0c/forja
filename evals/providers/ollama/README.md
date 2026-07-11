# Ollama provider eval (local tier)

Canonical local tier per `PROVIDERS.md §7`. Reuses the existing case suites with
`--model ollama/<model>` — there are **no** Ollama-specific cases; the point is to
measure how the local model does on the same work the cloud tiers run.

## Prerequisites

- A running Ollama daemon (`ollama serve`) on a version recent enough for the F1
  features (native tool calling + `format` JSON Schema). Check with the adapter's
  probe (`probeOllama` / `ollamaReadiness`) — it reports unreachable / too-old /
  model-not-pulled with a remediation.
- A catalog model pulled, e.g. `ollama pull qwen2.5-coder:14b`.

## Run

    bun run eval:smoke:ollama        # smoke suite against qwen2.5-coder:14b
    # other suites / models:
    bun run src/evals/cli.ts evals/smoke      --model ollama/qwen3:8b
    bun run src/evals/cli.ts evals/regression --model ollama/qwen2.5-coder:14b

## Thresholds (`PROVIDERS.md §7.3`, local tier)

- smoke ≥ 60%
- regression ≥ 45%
- playbook (review/refactor) ≥ 50%

A model below its threshold is marked `recommended: false` in the catalog rather
than removed (the matrix stays honest).

## Integration smoke (adapter ↔ real daemon)

A fast end-to-end check that the native `/api/chat` path actually works (streamed
text + `format`-constrained JSON), separate from the full eval suites:

    FORJA_OLLAMA_INTEGRATION=1 bun test tests/providers/ollama-integration.test.ts

Override the model with `FORJA_OLLAMA_INTEGRATION_MODEL` and the host with
`FORJA_OLLAMA_BASE_URL`. Hermetic CI skips it (the env var is unset there).

## Publishing results

Save the eval CLI output to `results.json` in this directory per the
`PROVIDERS.md §6` add-a-provider checklist (item 7).
