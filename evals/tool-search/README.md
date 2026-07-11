# tool-search eval

Gate for the deferred-tool surface (`AGENTIC_CLI §7.6`). The base tool surface is
curated; niche tools are deferred and reached via `tool_search`. These cases
prove a model can DISCOVER a deferred tool from the catalog and use it — the
property that makes deferral safe (principle 4: a feature without an eval that
exercises it doesn't ship).

What each case measures:

- **01-keyword-discovery** — the prompt never names the tool; the model must read
  the `tool_search` catalog, search by keyword, then call the revealed deferred
  tool (`todo_clear`) to finish the task. Asserts `tool_search` AND the deferred
  tool were both called, and the run completed.
- **02-select-by-name** — the prompt names the deferred tool; the model should
  `select:` it exactly, then use it. Tests the cheaper direct-fetch path.

Gate reading (per §7.6): if a model can't discover a tool it needs, or burns many
steps searching, the deferral hurt — promote the tool back to the visible surface
(or tighten the catalog blurb). Run:

    bun run eval:tool-search                       # opus
    bun run src/evals/cli.ts evals/tool-search --model openai/gpt-5.4

Costs real tokens (model-in-the-loop). The deterministic mechanics
(filtering, ranking, sticky reveal, catalog generation) are covered for free by
`tests/tools/tool-search.test.ts` + `tests/harness/tool-surface.test.ts`.
