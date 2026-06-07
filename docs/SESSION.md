# Session architecture

How a Forja session is represented, how its conversation flows through a run,
and how that conversation is compacted, persisted, reused, and recovered.

> **Root idea — a conversation has two representations.**
> The **DB log** is the full, append-only history (every turn, verbatim): the
> source of truth for audit, replay, recap, and crash recovery. The
> **`SessionContext`** is the live, in-memory, *compacted* projection: what the
> model actually sees on the wire. They are intentionally different views.
> Everything below follows from that split.

## The two representations

| | DB log (`messages` table) | `SessionContext` (in-memory) |
|---|---|---|
| Holds | every turn, original content | the compacted working set |
| Mutation | append-only (one row per turn) | append + compact-in-place |
| Lifetime | forever (until session purge) | one process; held across REPL turns |
| Read by | audit, recap, replay, retrieval, resume | the harness provider request, `/compact` |
| Source of truth for | history / reproducibility | the live context the model sees |

The log is always a **complete superset** of the live array: every append
writes a row; compaction writes *nothing*. So the live array can be thrown away
at any time and rebuilt from the log (that is exactly what `--resume` does).

## `SessionContext` — the single source of truth for live context

`src/harness/session-context.ts`. Owns the live `ProviderMessage[]` and the
`lastMessageId` DB-chain anchor, and is the **only** place that mutates them.

- `createFresh(db, sessionId)` — empty array, no anchor (first append is a root).
- `hydrateFromDb(db, sessionId, {limit})` — rebuild from the log: `listMessageTailBySession`
  (bounded to `MAX_RESUME_MESSAGES` = 500 + alignment margin) → `messagesToProviderMessages`
  (the repair walk). Returns `HydrateInfo` for the truncation events.
- `appendUser / appendAssistant / appendToolResults` — each does **array push +
  `appendMessage` row + anchor update together**, so the three never drift. The
  assistant append persists always but mirrors into the array only when content
  is non-empty, and writes NULL token columns when usage was unseen.
- `compact(provider, opts)` — rewrites the array in place via `compactMessages`;
  **persists nothing**. Returns the `CompactionResult` so the caller folds cost.
- `relevanceElide(opts)` — cheap, **no provider call**: pointer-elides
  low-goal-relevance `tool_result` bodies in the middle (goal + tail kept),
  rewriting the array in place. The auto path runs it BEFORE `compact` and
  re-checks tokens (see [Compaction](#compaction)). Returns the elision stats
  (`elidedCount` / `freedBytes` / `elidedIds`) or null.
- `ensureAlternation(willAppendUser)` — heals the array before a turn reuses it:
  runs `repairAlternation` (answer orphaned `tool_use`, close `user→user` gaps —
  in-memory only) then the stranded-turn placeholder. This is what makes the
  **reuse** path safe after a mid-tool abort (see [A turn](#a-turn-the-runagent-loop)).
- `snapshot()` / `restore(snap)` — cheap clone + rollback (used by `/compact`).

**Invariant:** `append* ⇒ exactly one row`; `compact ⇒ zero rows`. The DB stays
the log; the array is the compacted view.

## Session lifecycle

A `runAgent` call resolves a context in the session-decision block (`loop.ts`).
The four entry paths are mutually exclusive (a guard throws on more than one):

| Path | Trigger | What it does |
|---|---|---|
| **fresh** | no resume/preassigned/context | `createSession` → `createFresh` |
| **resume** | `resumeFromSessionId` | `reopenSession` + `hydrateFromDb`; carries `priorCostUsd` |
| **preassigned** | `preassignedSessionId` | subagent first boot; verify row + `hydrateFromDb` |
| **reuse** | `sessionContext` | REPL multi-turn; `reopenSession` + carry cost, **no hydrate** — the caller already holds the live context |

Status flow of the row: `createSession` → `running`; `finish` → `completeSession`
(`done`/`error`/`exhausted`/`interrupted`); a later resume/reuse → `reopenSession`
back to `running`. `total_cost_usd` is cumulative across the session's lifetime;
each run reports its per-run delta.

## A turn (the `runAgent` loop)

```
runAgent(config)
  ├─ resolve ctx  (fresh | hydrate | reuse)         ← session-decision block
  ├─ ctx.ensureAlternation(willAppendUser)          ← heal orphan tool_use / stranded tail
  ├─ [resume only] prepend [resume_context] block
  ├─ ctx.appendUser(prompt)                          ← row + push + anchor
  └─ while (true):
        maybeCompact()                              ← TOP of loop, before every call
          └─ if promptTokens > 0.7×window  →  ctx.compact(...)   (see Compaction)
        req = { messages: [...ctx.getMessages()], system, tools }
        collected = await provider.generate(req)     ← the model turn
        ctx.appendAssistant(blocks, usage)           ← row + push + anchor
        if no tool_use  →  finish('done')
        for each tool_use:  invoke  →  collect results
        ctx.appendToolResults(results)               ← row + push + anchor
        (loop)
  finish(reason)
    ├─ completeSession(priorCost + runCost)
    └─ result = { sessionId, lastMessageId: ctx.getLastMessageId(),
                  sessionContext: ctx, usage, costUsd, ... }
```

`maybeCompact` runs at the **top** of every iteration, so every provider call —
including the first call of a resumed session — is preceded by a compaction
check. Abort/error paths exit via `finish` and still hand `ctx` back on the
result; `ensureAlternation` on the next turn repairs any tool_use the abort
left unanswered.

## Compaction

Two triggers — automatic (`promptTokens > threshold` at loop top) and manual
(`/compact`) — feed a **two-stage** pipeline: a cheap relevance pre-pass, then
the billed LLM fold run only when the pre-pass isn't enough.

| | automatic | `/compact` (manual) |
|---|---|---|
| Trigger | `promptTokens > threshold` at loop top | operator types `/compact` |
| Exclusion | already inside the turn | `runExclusive` busy flag (refuses a concurrent turn) |
| Cost | folded into the run's `totalCostUsd` | folded into the session row + REPL cumulative |
| Surface | `compaction_started` / `_finished` events | a scrollback note (+ relevance line) |

**Stage 1 — relevance pre-pass** (`ctx.relevanceElide` → `compaction-relevance.ts`;
default-ON via `budget.compactionRelevance`). No provider call: score the
middle's `tool_result` bodies by BM25 relevance to the goal + position-recency,
keep the highest verbatim within a byte budget derived from the trigger, and
replace the rest with `[tool_result elided: …]` pointers. The elided raw stays
in the SQLite log and is reachable via `retrieve_context` (session view) — the
elision is reversible. **Token-driven** (in the loop): pre-pass → re-estimate
`promptTokens` → if back under threshold, **done, no LLM call**; else fall
through to stage 2. No spin (a re-trigger finds the pointered bodies
ineligible). Replay-safe (recency is by message position, not wall-clock, so
the partition is pure); errors are never elided (`OUTPUT_POLICY §0.4`).
Auditable: `compaction_finished` carries `relevance: { elidedCount, keptCount,
freedBytes, elidedIds }`. `/compact` runs the same pre-pass (then always folds —
the operator forced it) and reports the elision in its note.

**Stage 2 — LLM fold** (`ctx.compact` → `compactMessages`, `compaction.ts`).
Keeps `messages[0]` (the goal) and the last `preserveTail` messages — walked
back to an `assistant` boundary so tool pairs stay intact, via the
`alignTailStartToAssistant` helper the pre-pass shares — and folds the
**middle**:

- **LLM path** — one billed summary call (`max_tokens` 1024, `temperature` 0)
  over a rendered transcript of the middle; the summary is merged into the goal
  as a `[compacted_history]` block (pins re-injected via `formatPinnedBlock`).
  An empty / markers-only summary is **rejected** → fallback.
- **Fallback path** — deterministic elision: `tool_result` bodies and long text
  become pointers (`[… elided — original in audit log]`). Never throws, so the
  run always survives a flaky summary call.
- **skipped** — history too short / no foldable middle: returns the same array.

The `compaction_finished.strategy` is exactly which path ran: `relevance`
(stage 1 sufficed), or `llm` / `fallback` / `skipped` (stage 2). Compaction is
**in-memory only** — the original bodies stay in the SQLite log. Each
compaction (except a no-op `skipped`) writes a `compaction_events` audit row —
strategy, freed bytes, before/after context hash, and the LLM summary (the
non-deterministic bit otherwise lost on replay); see `AUDIT.md`. Canonical
what/why is `CONTEXT_TUNING §12` (spec, PT-BR); this section is the EN
implementation companion (which files, what order).

## Multi-turn in the REPL (compact-once-reuse)

The REPL holds the live context across turns so the conversation is compacted
**once** and reused, instead of re-derived + re-compacted every turn.

```
turn 1:  startTurn → runAgent(config, /* no sessionContext */)
                        └─ fresh / first-resume → builds ctx, may compact
         session_finished → repl captures liveContext = result.sessionContext

turn 2:  startTurn → runAgent({ ...config, sessionContext: liveContext })
                        └─ REUSE: appends onto the same compacted ctx, no re-derive
```

`startTurn` passes `sessionContext: liveContext` when present, falling back to
`resumeFromSessionId` only when a turn errored before resolving a context (then
the next turn re-derives from the log). This is what removed the per-turn
billed summary call a long session used to pay.

## Subagents

A subagent gets its **own** session: the parent `createSession`s the child row
+ seeds one message, then the child runs `runAgent` with `preassignedSessionId`
in a separate process. The parent's `liveContext` never crosses the IPC — only
a prompt string does. So a child always builds a fresh context from its own
seed; parent and child histories never mix.

## Crash recovery & audit

Because the log is complete and compaction never deletes a row:

- **Crash mid-session** → the in-memory context is lost, but `--resume` in a new
  process rebuilds it via `hydrateFromDb` → `messagesToProviderMessages` (which
  re-runs the orphan/alternation repair). The session continues; a `/compact`
  that ran live is simply re-derived from the full log.
- **Audit / recap / replay / retrieval** read the **log**, not the live array —
  they want the full history, not the compacted view. That is why "single source
  of truth" means the live *context*; the log is a separate, complete record.
