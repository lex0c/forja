# Proactive recall eval (Slice P5 · MEMORY.md §4.4)

Fixture suite for **proactive memory injection** — the §4.4 path that recalls
relevant memories into the turn tail instead of relying only on the fixed
system-prompt index. It is the default-ON gate: per `CLAUDE.md` principle 4,

> Eval is load-bearing. A subsystem without eval doesn't ship.

the `proactive_inject` flag stays **OFF** until the numbers justify flipping it.

Unlike the governance eval (a mocked subagent verdict driving a real
dispatcher), this suite needs **no model at all**: the proactive recall is BM25
(`src/retrieval/bm25.ts`) + the §4.4 I3 trust/active filter
(`src/retrieval/views/memory.ts`) + the producer's floor/top-K
(`src/memory/proactive-recall.ts`). All pure functions of the seeded corpus +
the turn inputs, so the whole thing runs in CI without cost.

## Scope

What this suite catches:

- **Useful-recall regression** — a clearly-relevant memory drops below top-K or
  the floor and stops surfacing (`01`).
- **Noise leakage** — an off-topic turn injects something it shouldn't, taxing
  the cache for nothing. The reactive baseline (§4.1–4.2) pays zero here; so
  must proactive (`02`).
- **I3 robustness under attack** — an untrusted (`03`) or quarantined (`04`)
  memory **keyword-stuffed to top the BM25 ranking** still never surfaces,
  because the trust/active gate runs *before* scoring. This is the load-bearing
  safety property: no amount of term-stuffing (or an imperative-injection
  payload in the body) buys an excluded memory a slot.
- **Top-K cap** — more relevant memories than the cap still inject only
  `PROACTIVE_RECALL_TOP_K` (3), so an all-on-topic corpus can't flood the turn
  (`05`).
- **Δcache cost** — the injected block is 0 chars on an irrelevant turn (`02`)
  and bounded to a few hundred chars in the worst case (top-K full, `05`).
- **§4.4 P3 prompt-mention trigger** — a `triggers:`-tagged memory surfaces when
  the prompt mentions the tag even with the term absent from its text (`06`).

What this suite does NOT catch:

- **Whether floor = 1.0 / topK = 3 are well-*tuned*** for a given target
  (local / weak) model — useful-recall rate vs injected-noise rate on real
  prompts. That is calibration against a real model: the separate default-ON
  follow-up, not a deterministic pin. This suite fixes the *mechanism*; the
  *values* are tuned later.
- **Real cache accounting** — the char-count ceiling is a deterministic proxy
  for the uncached-tail tokens, not a measured provider cache delta.

### A calibration note (why corpus size matters here)

The BM25 floor is an **absolute** score, and BM25 IDF is corpus-relative: a term
present in every document has IDF ≈ 0. So in a tiny synthetic corpus where the
relevant memories share their key terms, scores collapse *below* the floor even
though the memories are obviously relevant — `05` and `06` first failed exactly
this way (the trigger match in a two-doc corpus scored 0.96, just under 1.0).
The fixtures compensate the way a realistic corpus would: distinctive per-memory
terms (`05`) and enough documents to lift a rare term's IDF (`06`). This is
itself a finding the default-ON calibration must weigh — **the floor that's
right for a 200-memory store is too high for a 3-memory one.**

## Pattern

Each fixture is a TypeScript module exporting one `ProactiveRecallFixture` (see
`fixtures/types.ts`). The runner (`tests/memory/proactive-eval-fixtures.test.ts`)
iterates every fixture:

1. **Seed phase** — temp roots, in-memory SQLite, migrations, session; each
   memory written to disk + listed in its scope's `MEMORY.md`; registry built.
2. **Recall phase** — `createProactiveRecall({ registry })` with the **real
   production defaults** (floor 1.0, top-K 3 — no `minScore` override), run
   against the fixture's `goalText` (the working-state focus) + `prompt`.
3. **Assertion phase** — the recalled node-id set against `expected`:
   `recalls` (must surface), `excludes` (must not), `count` (exact size),
   `maxBlockChars` (the injected block's `formatProactiveRecallBlock` length).

The runner is a regular `bun test` file — no `--json`, no smoke-runner, no API
key.

## Layout

```
evals/memory/proactive/
  README.md
  fixtures/
    types.ts                              # ProactiveRecallFixture
    01-useful-recall-vs-noise.ts          # relevant in, unrelated out
    02-nothing-relevant-injects-nothing.ts# off-topic turn → 0 injected (Δcost 0)
    03-i3-untrusted-keyword-stuffing.ts   # untrusted never surfaces (trust gate)
    04-i3-quarantined-keyword-stuffing.ts # quarantined never surfaces (active-only)
    05-top-k-cap.ts                       # > cap relevant → only top-K injected
    06-trigger-prompt-mention.ts          # §4.4 P3 tag match
```

## Adding a fixture

1. Pick the property the fixture pins (a recall behavior, an I3 boundary, a cost
   bound).
2. Seed the smallest corpus that exhibits it. Mind the corpus-size note above:
   give relevant memories **distinctive** terms so their IDF clears the floor;
   don't let a shared term carry the match in a tiny corpus.
3. Set `expected` to the *minimum* assertions that fail if the property breaks.
   Prefer `recalls`/`excludes` (intent) over `count` (brittle to corpus edits)
   unless the cap/floor *is* the point.
4. Import the fixture in `tests/memory/proactive-eval-fixtures.test.ts` and add
   it to `FIXTURES`.
