# Forja Budget Operator Guide

This document describes Forja's run-budget subsystem: the caps that bound an autonomous run, how they're resolved and enforced, the surfaces operators use to set them, and how cost in particular is gated. It is for operators tuning a run and contributors extending the harness.

The canonical specification lives in `docs/spec/AGENTIC_CLI.md §5` (budget / profiles), with concurrency caps in `docs/spec/ORCHESTRATION.md §11` and the soft-cost signal in `docs/spec/ORCHESTRATION.md §3.5.0` (PT-BR). This document is the English-language operational reference; when the two diverge, the spec wins.

---

## 1. What budgets are for

A **budget** bounds a single autonomous run so the agent can't loop, hang, or spend without limit. Every cap lives in one struct — `RunBudget` (`src/harness/types.ts`) — resolved **once per turn** and enforced at defined points in the harness loop (`src/harness/loop.ts`). Each terminating cap maps to a distinct `ExitReason`, so audit and the UI can attribute exactly why a run stopped.

The root stance (`AGENTIC_CLI.md §5`):

> **Cost is the engagement gate; step count is the runaway-loop backstop.**

So `maxCostUsd` (default **$5**) is the knob that says "how much work is this run worth"; `maxSteps` (default **200**) and the degenerate-loop / stall / wall-clock guards exist to stop pathology, not to size the task.

---

## 2. The caps

All defaults are in `DEFAULT_BUDGET` (`src/harness/types.ts`).

### Engagement gate

| Cap | Default | Trigger → exit |
|---|---|---|
| `maxCostUsd` | `$5` | cumulative cost crosses the cap (checked per cost-increasing event: provider turn + compaction) → `maxCostUsd`. Compared with `>`, so `0` = no spend allowed. Cumulative **across resumes** (counts prior session cost). Three states — see §6. |
| `softCostUsd` | unset | cumulative cost crosses it → emits `cost_soft_cap_warn` **once**; does **not** terminate. Mainly a subagent regression signal (§7). |

### Runaway backstops

| Cap | Default | Trigger → exit |
|---|---|---|
| `maxSteps` | `200` | `steps >= maxSteps` → `maxSteps`. Backstop, not a task sizer. |
| `maxRepeatedToolHash` | `3` | N identical tool-call hashes within the last-5 sliding window → `degenerateLoop`. |
| `maxToolErrors` | `5` | that many **consecutive** tool errors → `maxToolErrors`. |
| `maxWallClockMs` | `600000` (10 min) | session-wide timer (`setTimeout` → abort) → `maxWallClockMs`. |
| `maxStepStallMs` | `90000` (90 s) | a single step's provider stream is silent (no text/thinking/tool/stop delta) for this long → `stepStalled`. `0` disables the watchdog. |

### Concurrency (throttle, not exit)

| Cap | Default | Hard cap | Effect |
|---|---|---|---|
| `maxConcurrentToolCalls` | `5` | `16` | parallel tool dispatch per step; only active when **every** `tool_use` in the step is `parallel_safe` (mixed batches run serial). |
| `maxConcurrentSubagents` | `3` | `8` | in-flight `task_async` spawns; excess queue. `1` = serial-but-with-handles. |

### Per-call shaping (not a cumulative tally)

| Cap | Default | Effect |
|---|---|---|
| `maxOutputTokensPerCall` | unset | clamps each request's `max_tokens` to `min(override, provider.output_max_tokens)`. Unset → use the provider capability ceiling (no silent 4096 truncation). A provider truncation at `max_tokens` surfaces as the `maxOutputTokens` exit. |
| `compactionThreshold` | `0.7` | fraction of the context window at which compaction triggers. `1.0` ≈ disable. |
| `compactionPreserveTail` | `3` | minimum trailing turns kept verbatim during compaction. |
| `compactionRelevance` | `true` | run the BM25 relevance pre-pass before the LLM summary — cheaply pointer-elide low-goal-relevance `tool_result` bodies (recoverable via `retrieve_context`). `false` keeps every `tool_result` verbatim until the fold. |

---

## 3. Resolution & precedence

The effective budget for a turn is computed by `effectiveBudget(partial, effort)` (`src/harness/types.ts`), which layers three sources lowest-to-highest:

```
DEFAULT_BUDGET  <  /effort profile preset  <  explicit override
```

- **Defaults** — `DEFAULT_BUDGET`.
- **Effort preset** — the `/effort` level's profile (`EFFORT_PROFILES`, `src/harness/effort.ts`) projects onto `maxSteps`, `maxConcurrentSubagents`, and `maxToolErrors` (see `docs/spec/TOKEN_TUNING.md §4`). The default session effort is `high`.
- **Explicit override** — anything the operator set via `config.toml`, the CLI, or `/budget`.

Because the effort preset sits in the **middle**, an explicit `/budget` value always wins over it regardless of the order the two were set — precedence is order-independent and inspectable (`/budget` show routes through `effectiveBudget`, so it displays the effective value, preset included). The loop resolves the budget once at run start (`loop.ts`), so mid-turn changes apply next turn.

---

## 4. Control surfaces

Where each cap can be set:

| Surface | Caps it can set | Scope |
|---|---|---|
| `DEFAULT_BUDGET` (code) | all | fallback |
| `.agent/config.toml` `[budget]` | `max_steps`, `max_wall_clock_ms`, `max_step_stall_ms`, `compaction_preserve_tail`, `max_cost_usd`, `compaction_threshold`, `compaction_relevance` | persistent (project layer overrides user) |
| CLI | `--max-steps` only | per-run |
| `/effort <level>` preset | `maxSteps`, `maxConcurrentSubagents`, `maxToolErrors` | session (in memory, next turn) |
| `/budget <sub> <val>` | `steps`, `cost`, `parallel-tools`, `subagents`, `relevance` | session (in memory, next turn) |
| playbook frontmatter | `sampling.max_tokens` → `maxOutputTokensPerCall`; the subagent's own `budget` | per-subagent |

Notes:

- **Not every cap is configurable from every surface.** `maxToolErrors`, `maxRepeatedToolHash`, `maxConcurrentToolCalls`, and `maxConcurrentSubagents` are **not** in the config loader (`BUDGET_INT_KEYS` / `BUDGET_FLOAT_KEYS` in `src/config/loaders.ts`) or the CLI; they come from the default (or, for the three the effort preset touches, from the level). `--max-steps` is the only budget CLI flag.
- The `[budget]` loader is **fail-soft**: an out-of-range or wrong-type value warns on stderr and falls back to the next layer (`forja: budget config: …`), surfaced in both the one-shot (`run.ts`) and interactive (`repl.ts`) paths.
- `/budget` is the **explicit-override surface**: a mutation always records (pins) the value — so it survives later `/effort` changes — and reports "already (no change)" only when the raw override already equals it.

### `/budget` subcommands (`src/cli/slash/commands/budget.ts`)

```
/budget                          show every resolved cap (effort preset included)
/budget steps <N>                positive integer
/budget cost <USD|none|off>      positive number, or none/off to remove the cap
/budget parallel-tools <N>       1..16
/budget subagents <N>            1..8
/budget relevance <on|off>       toggle the compaction relevance pre-pass (default on)
```

All mutations take effect on the **next** turn (the in-flight turn already snapshot its config).

### `[budget]` config example

```toml
[budget]
max_steps = 400
max_cost_usd = 20
max_wall_clock_ms = 1800000   # 30 min
compaction_threshold = 0.8
compaction_relevance = false  # opt out of the relevance pre-pass (default on)
```

---

## 5. Enforcement & exit reasons

The full set of terminal reasons is `EXIT_REASONS` (`src/harness/types.ts`); `exitToStatus` maps each to a session status:

| Exit reason | Session status | Cause |
|---|---|---|
| `done` | `done` | model emitted text with no tool_use |
| `maxSteps` | `exhausted` | step backstop hit |
| `maxCostUsd` | `exhausted` | cumulative cost crossed the cap |
| `maxOutputTokens` | `exhausted` | provider truncated at `max_tokens` |
| `maxWallClockMs` | `interrupted` | session timer fired |
| `maxToolErrors` | `error` | consecutive tool errors hit the cap |
| `degenerateLoop` | `error` | repeated identical tool calls |
| `stepStalled` | `error` | provider stream silent past `maxStepStallMs` |
| `aborted` | `interrupted` | operator cancelled (signal) |
| `providerError` / `internalError` | `error` | unrecoverable provider / harness failure |

Concurrency caps (`maxConcurrentToolCalls`, `maxConcurrentSubagents`) and per-call shaping (`maxOutputTokensPerCall`, `compaction*`) **throttle or shape**; they are not exit reasons.

---

## 6. Cost, in depth

`maxCostUsd` has **three states**, distinguished so a partial override can carry an explicit opt-out through the spread merge:

- **absent** → merge picks up `DEFAULT_BUDGET.maxCostUsd` (`$5`).
- **`undefined`** → operator opted out (`/budget cost off`); the loop skips the cost gate entirely.
- **a number** → that exact cap (`0` means no spend permitted).

The cap is **cumulative and resume-aware**: the loop compares `priorCostUsd + totalCostUsd` (not just the per-run total) against the cap, so a resumed session honors spend already incurred. It is checked after each cost-increasing event (a provider turn and the compaction call), aborting on the first one whose running total crosses the cap.

`softCostUsd` is a non-terminating warning threshold: crossing it emits `cost_soft_cap_warn` once. It is primarily how a parent forwards a playbook's declared `max_cost_usd` as a regression signal while leaving the child's hard cap to the global budget.

---

## 7. Subagents

A subagent does **not** inherit the operator's effort operational-cap preset — its budget comes from the playbook's frontmatter (carried via the audit row), keeping operational caps per-playbook. (It does inherit the operator's provider reasoning-effort axis — `resolveProviderEffort` in `src/harness/effort.ts`.)

Cost gets double protection:

- **Pre-spawn projection** — before spawning, the loop projects the child's worst-case cost against the global `maxCostUsd` and refuses the spawn (`budget_exhausted`) if it would overshoot.
- **Mid-run watchdog** — the running child's cost is tracked against the global cap during execution.

Concurrency of subagents is bounded by `maxConcurrentSubagents` (in-flight `task_async`; the rest queue).

---

## 8. Quick reference

- **Make a run cheaper / shorter**: `/budget cost 2` (or `[budget] max_cost_usd = 2`); `/effort low` tightens steps/subagents/tool-errors together.
- **Let a long job run**: `/budget cost off` + `/budget steps 1000` (or raise both in `[budget]`).
- **Inspect what's actually in force**: `/budget` (shows the effective values, effort preset included).
- **Pin a value against effort changes**: `/budget <sub> <N>` records an explicit override that beats the preset.
- **Disable the stall watchdog** (long steady-streaming providers): `[budget] max_step_stall_ms = 0`.

Related: `/effort` and `src/harness/effort.ts` (the effort levels, the two axes, and the `EFFORT_PROFILES` that layer onto this budget), and `docs/HOOKS.md` (hooks have their own per-event wall-clock budget, separate from `RunBudget`).
