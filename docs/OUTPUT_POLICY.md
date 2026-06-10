# Tool output reduction

How Forja keeps verbose tool output from bloating the context window — what
gets compressed, where, and why none of it breaks the prompt cache.

> **Normative spec:** `docs/spec/OUTPUT_POLICY.md`. This file is the
> implementation companion (non-normative): it maps the spec onto the code and
> explains the *why*. When the two disagree, the spec wins for intent and the
> code wins for behavior — fix whichever is wrong.

> **Root idea — the model reads a digest, the audit log keeps the raw.**
> Every reduction layer below writes the full, unmodified tool output to the
> audit log *first*, then hands the model a shrunk copy. Nothing is lost: replay,
> forensics, and `retrieve_context` see the original; only the on-the-wire
> `tool_result` carries the digest. This mirrors the session split in
> [`SESSION.md`](./SESSION.md) (DB log = full history; `SessionContext` = the
> compacted projection the model sees). "Measure twice, cut once": every cut has
> a recoverable original behind it.

## The three layers

Reduction happens at three points in a turn's lifecycle, each cache-safe:

```
tool runs ──▶ [1] summarize hook ──▶ tool_result enters history (cached tail)
              hosts [2] per-tool          │
              compressors                  │ accumulates across turns
                                           ▼
                          [3] relevance pre-pass ──▶ [LLM compaction fold]
                          (free BM25 elision)         (billed summary)
```

| Layer | Where | When | Cost | Acts on |
|---|---|---|---|---|
| **1. Summarize hook** | `invoke-tool.ts` | at tool-result production | free (pure) | the new tool_result, per tool |
| **2. Per-tool compressors** | `output-summarizer.ts` + each tool | inside layer 1 | free (deterministic) | one tool's output |
| **3. Relevance pre-pass** | `compaction-relevance.ts` | at compaction time | free (no provider call) | the accumulated middle span |

Layers 1–2 act on the **tail** (new content) before it is appended; layer 3
acts on the **middle** at compaction. None rewrites the cached prefix
(`tools` → `system` → prior messages), so the Anthropic prompt cache stays warm
across all of them (see the cache breakpoint strategy in
`src/providers/anthropic/cache.ts`).

## Layer 1 — the summarize hook

`src/harness/invoke-tool.ts` (the success path, ~line 937). The single chokepoint
every tool result flows through. Order is load-bearing:

1. **Persist raw first** — `finishToolCall(..., output: result)` writes the
   unmodified result to `tool_calls.output` *before* any reduction. The audit row
   is always complete.
2. **Then reduce for the model** — if the tool declares `metadata.summarize`, run
   it and, when it reports `reduced`, swap in the digest and stamp a marker:
   `[forja:output_summarized policy=<p> original_bytes=<n>]`.

```ts
finishToolCall(deps.db, { id, status: 'done', output: result, ... }); // raw → audit
if (tool.metadata.summarize !== undefined) {
  const summary = tool.metadata.summarize(result, effectiveArgs);
  if (summary.reduced) {
    resultForModel = summary.result;
    summaryMarker = `[forja:output_summarized policy=${summary.policy} original_bytes=${summary.originalBytes}]`;
  }
}
```

Properties that matter:

- **Dual visibility.** Raw in the DB, digest on the wire. The marker tells the
  model it is reading a summary and gives it the policy + original byte count, so
  it can re-invoke with narrower args if a cut lost load-bearing signal. The cut
  is never silent.
- **Error path is never summarized.** `ToolError` results return earlier
  (~line 909), before the hook. Error shapes are small and the exact text is
  load-bearing; only success results are reduced.
- **A throwing summarizer is non-fatal.** A throw is a tool-implementation bug,
  not an operator failure: it is logged to stderr and the raw result flows
  through unchanged. Worst case is a larger `tool_result`, never a crash.
- **Replay-safe ⇒ pure.** The replay path re-runs summarizers against the raw
  audit row, so they must be deterministic — no clock, no I/O, no randomness.
  This is why reduction is deterministic rather than an LLM round-trip.
- **Marker composition.** When an output is both summarized *and* flagged by the
  prompt-injection scan, both markers render, in a fixed order: summarize marker
  (describes the body's shape) → `[forja:injection_suspect …]` (warns about
  content) → `[forja:hook-context …]` blocks (PreToolUse then PostToolUse) last.

`metadata.summarize` is the contract; the hook is agnostic and just hosts it.

## Layer 2 — per-tool compressors

`src/tools/output-summarizer.ts` holds the shared policies; each noisy tool
composes one. Deterministic by design (`output-summarizer.ts:6-12`): head-tail
and group-by-file capture >90% of the bytes a verbose LLM summary would also
drop, with no provider call. A Tier-2 (Haiku summarizer) is left as future room
for cases where deterministic cuts lose load-bearing signal.

### Coverage

| Tool | Policy | Threshold | Behavior |
|---|---|---|---|
| `bash` | `head_tail` | 16 KB **per stream** | stdout and stderr each head-tailed; 80 head + 80 tail lines (`BASH_SUMMARIZE_THRESHOLD`, `HEAD_TAIL_DEFAULT_LINES`) |
| `grep` | `group_by_file` | ≥ 50 matches | collapse to one row per file `{file, count, firstLine, firstText}` (`GREP_GROUP_THRESHOLD`) |
| `glob` | `head_tail` | > 200 paths | head 50 + `[… N paths elided …]` + tail 50 (`GLOB_SUMMARIZE_THRESHOLD`) |
| `task` / `task_sync` / `task_await` | `head_tail` | 16 KB on child `output` | shared `summarizeChildEnvelope`; the child's full run stays recoverable in its own session |

The other ~28 builtin tools return raw — they are small by construction
(memory, todo, skill, edit, clarify, write_file …) or expose their payload via a
handle rather than the result (`bash_background`, `bash_output`). `read_file` is
not summarized because it self-limits via `offset`/`limit` args.

### `head_tail` mechanics (`headTailSummary`)

- At or below `maxBytes`: passthrough (`reduced: false`).
- Above: keep the first `headLines` and last `tailLines`, with
  `[... N lines elided (X.XKB dropped) ...]` between them.
- **UTF-8 safety.** When the input is huge in bytes but few in lines (a one-line
  base64/hex blob), line-based head/tail can't reduce, so it falls back to a
  **byte-window** over the UTF-8 `Buffer`, walking to a codepoint boundary
  (`utf8BoundaryAtOrBefore`/`AtOrAfter`). A naive UTF-16 `.slice()` would cut
  multi-byte sequences (CJK, emoji) mid-codepoint and could produce a "summary"
  the same size as (or larger than) the input with a negative `dropped` count.
- If the cuts overlap (input too small in real bytes), it returns passthrough
  rather than emit a larger fake summary.

### `group_by_file` (`grep.ts`)

Below 50 matches the array passes through so the model gets full per-line
context. At/above, hits collapse to one row per file: the model usually wants to
know *which* files contain the pattern far more than every line, and
"show me line 42 of foo.ts" can be re-asked with a narrower grep.

## Layer 3 — relevance pre-pass

`src/harness/compaction-relevance.ts` (`relevanceElideMiddle`), wired through
`SessionContext.relevanceElide` (`session-context.ts`). The implementation detail
lives in [`SESSION.md`](./SESSION.md) (the compaction pipeline); the summary here:

- **What.** Before the *billed* LLM compaction, cheaply pointer-elide
  low-goal-relevance `tool_result` bodies in the **middle** span (goal message
  and the preserved tail are kept verbatim).
- **Scoring.** BM25 of each body against the goal text, blended with
  position-based recency (`score = 0.75·relevance + 0.25·recency`; recency by
  *index among eligible*, not timestamp → clock-free → replay-safe). Greedy keep,
  highest score first, within `verbatimBudgetBytes`; the rest are pointered with
  `[tool_result elided: N bytes — low goal-relevance; recover via retrieve_context …]`.
- **Eligibility.** Only `tool_result` blocks, **non-error** (errors are
  load-bearing verbatim, spec §0.4), above a minimum size. The guards are
  re-applied on rewrite, not just keyed by `tool_use_id`, so a duplicated id can
  never let an error or sub-floor body be elided.
- **When.** `loop.ts` `maybeCompact`, gated on
  `budget.compactionRelevance === true && config.memoryRegistry !== undefined`.
  Runs *before* the LLM fold and re-checks tokens — often it frees enough that the
  billed fold is skipped entirely.
- **Cost.** No provider call. This is the highest-ROI layer short of per-tool
  reduction.
- **Cache-safe + recoverable.** Acts on the live in-memory array's middle, never
  the cached prefix, and persists nothing to the DB. Elided bodies are recoverable
  via the `retrieve_context` tool (a session view into the audit log).

## Why all three are cache-safe

The Anthropic prompt cache keys on the exact prefix `tools` → `system` →
prior messages. Layers 1–2 reduce a tool result *before* it is appended (it
enters history already small — nothing is rewritten). Layer 3 touches only the
middle of the live array, leaving the cached prefix byte-identical. So reduction
shrinks what is *written* to the cache without invalidating what is *read* from
it — the cost lever that matters, since cache writes are dominated by tool-result
volume entering history.

## Operator knobs & related docs

- Relevance pre-pass toggle: `compactionRelevance` (default on) —
  `/budget relevance <on|off>`, config `compaction_relevance`. See
  [`BUDGET.md`](./BUDGET.md).
- Forensic trail: `compaction_events` records the LLM summary and the pre-pass
  records `elided_ids`. See [`AUDIT.md`](./AUDIT.md).
- Session/compaction pipeline: [`SESSION.md`](./SESSION.md).
- Normative authority: `docs/spec/OUTPUT_POLICY.md`.
