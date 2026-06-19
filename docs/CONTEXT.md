# Forja Context Architecture

This document describes how Forja shapes everything that goes into the model's window each turn — the **fixed prefix** (system prompt + tool schemas) and how it is assembled, made window-relative, hashed, and persisted. It is for contributors adding a prompt layer, tuning the window-relative allocator, debugging a layer ordering, tracing a `prompt_hash`, or changing the cache strategy.

The canonical specification is [`docs/spec/CONTEXT_TUNING.md`](./spec/CONTEXT_TUNING.md) (PT-BR) — section ordering, layer semantics, the window-relative allocator (§2.2), cache strategy, evolution rules. The `prompt_versions` storage contract is [`docs/spec/AUDIT.md §1.3`](./spec/AUDIT.md). **This document is the English-language implementation companion**: what actually runs today, which files do it, and in what order. When this doc and the spec diverge, the spec is the protocol — but the spec is largely aspirational, so this doc tracks the implemented subset.

---

## 1. Mental model

The request sent to the model each turn has two parts:

- **The fixed prefix** — the system prompt + the tool schemas. This is the **cached region** (Anthropic cache breakpoints #1–#3). It is meant to be byte-identical turn-to-turn so the provider charges cached-read rates (~0.1× write); cache is the dominant cost lever.
- **The conversation tail** — compacted history + recent turns + the current user/tool message. This changes every turn (breakpoint #4) by design.

This doc is about the **fixed prefix**. Measured size: ~10K tokens at a 200K window, leaning to ~7K at a 32K window (see §3). Tool schemas are ~half of it.

Two ideas drive the implementation:

- **Two assembly pipelines.** `bootstrap.ts` builds the prefix for the top-level agent (once per session). `subagent-child.ts` builds it for a spawned subagent (once per `task()`), from the playbook body. They diverge because their constraints diverge (§6).
- **Acquire vs shape.** The prefix is **acquired** once at boot (the expensive, effectful work) and **shaped** per turn from the live context window (a pure, cheap function). This is what makes the prefix window-relative and mid-session reactive without re-reading files every turn (§2).

---

## 2. The acquire/shape split

`CONTEXT_TUNING §2.2`. The system prompt used to be assembled once at boot and frozen, so it could not re-lean when the operator switched models mid-session (`/model`). It is now split:

### 2.1 Acquisition (bootstrap-once)

`bootstrap.ts` does the effectful, model-agnostic work and produces a window-INDEPENDENT `SystemInputs` (`src/cli/shape-system-prompt.ts`):

- `acquireProjectGuide(...)` (`project-context.ts`) — probe / trust-gate / read (bounded) / sanitize the project guide, clipped to the **absolute** cap (`PROJECT_GUIDE_MAX_BYTES` = 16 KB). Model-agnostic.
- `assembleMemorySection(...)` (`memory-prompt.ts`) — the memory index, capped at the **boot** window (`memoryMaxEntries`) with a condensed header when small (`leanHeader`); + the skill catalog (dropped when small). Boot-pinned (see §3.2).
- **Two directive prefixes** — a `withDirectiveTail` helper composes the shared tail (constraints → response/output format → environment → identity) over either the full base (`+ tool-ergonomics + parallel` hints) or the lean base (neither). Both are precomputed; `shape` picks one.

`SystemInputs = { stablePrefix (full), stablePrefixLean, acquiredGuide, memorySegmentText }`. It is captured on `BootstrapResult` and never mutated for the session.

### 2.2 Shaping (per-turn, pure)

`shapeSystemPrompt(inputs, contextWindow)` (`src/cli/shape-system-prompt.ts`) is a pure function of `(SystemInputs, window)`:

1. Pick the directive tier — `isSmallWindow(window)` → `stablePrefixLean`, else `stablePrefix`.
2. Re-clip the guide — `renderProjectContext(acquiredGuide, guideMaxBytes(window))`.
3. Compose: `stableSegment = prefix + guide`, `system = stableSegment + memorySegment`.
4. Emit `systemSegments` (cache breakpoints) + `systemPromptHash`.

The harness calls it at the **turn boundary**: the REPL's `startTurn` (`repl.ts`) computes `shapedSystemFields()` against `baseConfig.provider.capabilities.context_window` (the *live* window) and overrides `cfg.systemPrompt`/`systemSegments`/`systemPromptHash`. This is **pull-no-turno** — consumers derive from live state at the turn boundary, the same pattern `buildToolDefs` uses for the tool list; no event/listener. A mid-session `/model` swap changes the window → the next turn re-shapes (the guide re-clips, the directive tier flips). Headless `run.ts` is a single epoch and uses the boot shape as-is.

### 2.3 The cache-epoch invariant

Because `shape` is a pure function of `(frozen inputs, window)` and the window is constant within a model epoch, the shaped prefix is **byte-identical turn-to-turn within an epoch** — the cache prefix holds. The bytes change only on:

- **`/model`** — recomputes the prefix. Free cache-wise: Anthropic's cache is per-model, so a model switch already cold-starts it.
- **`tool_search` reveal** — a deferred tool joins the wire, growing `[tool_schemas]` once (sticky thereafter). Pre-existing deferred-tool behavior ("one cache invalidation per fetch, then stable").

After either, it reconverges to byte-identical. Deriving the budget from anything that varies *within* an epoch (history size, etc.) is forbidden — it would thrash the cache. Note: `memory_write` and guide edits mid-session do **not** change the prefix (the memory index and guide are boot-frozen in `SystemInputs`); they take effect on the next boot.

`recordPromptVersion` fires from `startTurn` only when the shaped hash actually changes (the narrow re-tier path), keeping the audit soft-FK intact without per-turn DB churn.

---

## 3. The window-relative allocator

`src/tools/context-budget.ts` is the single policy module (a dependency-free leaf at the tools layer). It keys everything off one tier boundary: `isSmallWindow(window)` = `0 < window < 64K` (`DEFER_BELOW_TOKENS_SMALL`).

### 3.1 The levers

| Lever | Rule | Section | Decides |
|---|---|---|---|
| Tool deferral | static `deferred` flag, or window-relative `deferBelowTokens` | `[tool_schemas]` | per turn |
| Guide clip | `guideMaxBytes(window) = min(16 KB, 0.4 × window)` | `[project_context]` | per turn (re-clips on `/model`) |
| Directive tiering | small window → lean prefix (drop `parallel` + `tool-ergonomics`; keep constraints/format) | `[system]` `stable` segment | per turn |
| Memory header condense | small window → short header (no save taxonomy) | `[memory_index]` | boot-pinned |
| Skill catalog drop | small window → empty section | `[memory_index]` | boot-pinned |
| Memory index cap | `memoryMaxEntries(window)` — guardrail < 64K, > 64 memories | `[memory_index]` | boot-pinned |

`constraints` (the safety block, ~842 tok) and `# Response surface` are never cut.

### 3.2 Per-turn vs boot-pinned — split by cache segment

- The **`stable` segment** (directives + guide) is shaped **per turn** → directive tiering and the guide clip react to a mid-session `/model`.
- The **`memory` segment** (memory index + skills) is **boot-pinned** — the header condense, skill drop, and index cap decide at the boot window. Justification: eager-exposure provenance is a boot concept (`MEMORY.md §11.2`); the memory toolset is off the base surface on a small window anyway, so the condensed header isn't teaching tools that are on the wire.

### 3.3 Measured savings (jun/2026)

Fixed prefix at a tight window vs the 200K full surface (which is byte-identical to before the allocator):

- Tool schemas: 5271 tok @200K → 3845 @32K.
- Directive tier (drop `parallel` + `tool-ergonomics`): −618 tok.
- Memory header condensed: 510 → 70 tok (−440).
- Skill catalog dropped + guide/memory guardrails (conditional).

Net: a 32K prefix sheds ~3k tokens. At ≥ 64K nothing leans — by design, there is room.

---

## 4. Tool surface

The tool list sent each turn is `buildToolDefs(config, revealed)` (`src/harness/loop.ts`). A tool is OFF the base surface when `isDeferred(meta, window)` (`context-budget.ts`): the static `deferred` flag (always) OR `deferBelowTokens` (below the tier). Deferred tools are advertised as one-line blurbs appended to `tool_search`'s description; `tool_search` reveals them on demand, sticky for the session. The predicate runs at **both** the wire-list site and the `tool_search` catalog/reveal-pool site (`availableDeferredTools`) so the two never diverge. Deferral is NOT a permission gate — a revealed tool runs under the same policy.

Of 38 registered builtins:

- **Always on the wire (15)** — `read_file`, `glob`, `bash`, `bash_background`, `bash_output`, `edit_file`, `write_file`, `tool_search`, `todo_list`/`get`/`create`/`update`, `working_state_update`, `clarify`, `skill_invoke`. The minimal action core + session state.
- **Window-tier (7, base ≥ 64K)** — `memory_read`, `memory_search`, `task`, `task_async`, `task_await`, `reminder`, `git_apply_patch` (`deferBelowTokens`).
- **Always deferred (16)** — `grep`, `git` (`bash` runs `rg`/`git` directly at every window, so the structured/hardened tools only earn the wire on demand), plus `memory_list`, `memory_write`, `retrieve_context`, `skill_list`, `skill_show`, `todo_clear`, `task_sync`, `task_cancel`, `task_list`, `bash_kill`, `bash_list`, `fetch_url`, `reminder_list`, `reminder_cancel`.

The exact membership is an operator/eval choice (a tool's metadata), not an invariant. Note: which family resolves depends on the runtime surface — operator-confirm tools (`memory_write`) and the reminder family are also hidden when their hooks/scheduler aren't wired (headless `run.ts`).

---

## 5. Principal pipeline (`bootstrap.ts`)

### 5.1 The composer chain

Small **composers** (`composeWithX(downstream, …)` in `src/cli/`) each own one layer's text. Most PREPEND, so source order is inside-out and the final prompt's top-down order is the reverse. The chain:

```text
withPlaybook   = composeWithPlaybookHint(input.systemPrompt, subagents)
envInput       = { cwd, platform, today: localIsoDate(), git: probeGitContext(cwd) }   // once
withDirectiveTail(base) =
  composeWithIdentity(
    composeWithEnvironment(
      composeWithOutputStyle(composeWithResponseFormat(composeWithConstraints(base))),
      envInput))
stablePrefixFull = withDirectiveTail(composeWithParallelHint(composeWithToolErgonomics(withPlaybook)))
stablePrefixLean = withDirectiveTail(withPlaybook)                       // lean: skips both hints
```

`shapeSystemPrompt` then appends the (re-clipped) project guide, and `composeSystemPrompt` (in `memory-prompt.ts`) appends the memory section + skill catalog.

**Final top-down order** (full / large window):

1. **Identity** — what Forja is + declarative policy + verify-before-acting (`§1.2`)
2. **Environment** (`# Environment`) — cwd, OS, current date; computed once at boot (`§1.3/§1.4`)
3. **Output style** (`# Output`) — output-density default (signal per token)
4. **Response surface** (`# Response surface`) — terminal output format (`§1.5`)
5. **Constraints** (`# Constraints`) — correctness + ask-don't-presume + build discipline + match-surrounding-code + persistence nudges + security posture + hard-to-reverse confirm + goal-contradictory cancellation (`§1.6` + `SECURITY §0.11`) — **never cut**
6. **Parallelism** (`# Parallelism`) — parallel-tool affordance — *dropped on a small window*
7. **Tool ergonomics** (`# Tool ergonomics`) — high-payoff tool patterns — *dropped on a small window*
8. **Playbook subagents** (`# Playbook subagents`) — discovery table + delegation criteria (`PLAYBOOKS §1.4`)
9. **Caller prompt** — `input.systemPrompt` (typically empty in production)
10. **Project context** (`# Project context`) — eager, trust-gated guide; re-clipped per window (`§2.0`)
11. **Memory** (`# Memory`) — auto-injected index; header condensed + cap on a small window (`MEMORY.md`)
12. **Skills** (`# Skills`) — eager skill surface; dropped on a small window (body lazy)

### 5.2 Cache segments

Bootstrap emits TWO segments via `systemSegments` (a channel parallel to the canonical `systemPrompt` string):

- **`stable` segment** — items 1–10 (identity … project context). Its own `cache_control` marker; persists when memory rotates.
- **`memory` segment** — items 11–12 (memory + skills). The high-churn region; its own marker so a change there doesn't drop the whole prefix.

Invariant: `flattenSystemSegments(segments) === systemPrompt`. The audit hash and non-segment adapters (OpenAI, Google) read the canonical string; Anthropic reads the array. The date sits in the environment block (boot-frozen → stable within a session). `shapeSystemPrompt` reproduces this composition byte-for-byte at the boot window.

### 5.3 Hash registration

```text
hashPromptContent(system) → recordPromptVersion(db, { kind: 'system', name: 'system.autonomous', … })
                          → systemPromptHash on BootstrapResult + HarnessConfig
```

`name: 'system.autonomous'` is hardcoded (the only profile this binary ships); the orchestrated profile (`CONTEXT_TUNING §1.8.2`) must branch here when it lands. The REPL re-records on a mid-session re-shape only when the hash changes (§2.3).

---

## 6. Subagent pipeline (`subagent-child.ts`)

A subagent's prompt is the **playbook body** (`audit.systemPrompt`, snapshotted at definition-load and read from `subagent_runs`) wrapped in a narrower affordance set — NOT the principal's full surface. Subagents run at a fixed model in a single epoch, so they do **not** do window-relative shaping; the chain is assembled once.

The trailing-block composers (`reference`, `output-schema`, `reflection`) APPEND, while `composeWithParallelHint` PREPENDS (the in-source comment block documents the resulting order verbatim). Source order:

```text
audit.systemPrompt                                   ← playbook body
  + composeWithReferenceBlock(audit.references)
  + composeWithOutputSchemaBlock(audit.outputSchema)
  + composeWithReflectionBlock(audit.contextRecipe?.stepReflection)
  ↑ composeWithParallelHint                          ← prepended (outermost)
```

Then, conditionally, if the whitelist contains a `memory_*` tool and `opts.memoryCwd` is set, `composeSystemPrompt(…, memorySection.text)` appends a memory section.

**Final order**: Parallel hint → Playbook body → Reference block → Output schema block → Reflection block → (Memory section). Hash registered with `kind='playbook'`, `name='playbook.${audit.name}'` (namespaced to avoid colliding with `system.*`). **Known gap**: the seed `messages` row the parent appends before the child computes its prompt carries `prompt_hash = NULL`; subsequent child turns are stamped correctly.

---

## 7. `prompt_versions` integration

Both pipelines end the same way; the hash is computed **inside** the boundary (bootstrap / subagent-child) and consumed **outside** it (harness):

```text
system (string) → hashPromptContent (SHA256 hex) → recordPromptVersion (INSERT OR IGNORE)
   → prompt_versions row (kind, name, content, author, created_at)
   → HarnessConfig.systemPromptHash
   → loop appendMessage(… promptHash) / invoke-tool createToolCall(… promptHash)
   → messages.prompt_hash + tool_calls.prompt_hash   (soft FK, nullable)
```

`prompt_versions` is append-only and content-addressed (hash is the PK), so a mid-session re-hash (`/model` re-tier) just needs an idempotent `recordPromptVersion` — no schema change, and a session can reference multiple hashes. The join surface (`AUDIT §1.3.5`) resolves "which prompt versions ran" / "this regression started under which prompt" against real data; same content → same hash → same row.

---

## 8. Composer catalog

Each composer lives in its own file under `src/cli/`, owning its function, layer text, and rationale comments.

### 8.1 Principal-only

| Composer | File | Layer |
|---|---|---|
| `composeWithIdentity` | `identity-prompt.ts` | role-as-tool marker (`§1.2`) |
| `composeWithEnvironment` | `environment-prompt.ts` | cwd / OS / date (`§1.3/§1.4`) — `envInput` built once, shared by both prefix variants |
| `composeWithOutputStyle` | `output-style-prompt.ts` | `# Output` density default |
| `composeWithResponseFormat` | `response-format.ts` | `# Response surface` (`§1.5`) |
| `composeWithConstraints` | `constraints-prompt.ts` | `# Constraints` (`§1.6`) — never cut |
| `composeWithToolErgonomics` | `tool-ergonomics-prompt.ts` | `# Tool ergonomics` — in the FULL prefix only |
| `composeWithPlaybookHint` | `playbook-prompt.ts` | `# Playbook subagents` (`PLAYBOOKS §1.4`) |
| `acquireProjectGuide` / `renderProjectContext` / `composeWithProjectContext` | `project-context.ts` | `# Project context` (`§2.0`) — acquire (boot) + render/clip (per turn) |
| `composeSystemPrompt` | `memory-prompt.ts` | generic tail-append (memory + skills) |

### 8.2 Subagent-only

| Composer | File | Layer |
|---|---|---|
| `composeWithReferenceBlock` | `reference-block.ts` | trailing reference paths (`PLAYBOOKS §1.1`) |
| `composeWithOutputSchemaBlock` | `output-schema-block.ts` | terminate-with-YAML (`PLAYBOOKS §1.2`) |
| `composeWithReflectionBlock` | `reflection-block.ts` | per-step reflection cadence |

### 8.3 Shared

| Composer | File | Used by |
|---|---|---|
| `composeWithParallelHint` | `parallel-prompt.ts` | both — parallel-tool affordance — in the FULL prefix only (principal) |
| `composeSystemPrompt` | `memory-prompt.ts` | both — tail-append helper |

### 8.4 The shaper

`shapeSystemPrompt` / `SystemInputs` (`shape-system-prompt.ts`) — the per-turn pure function that picks the directive tier, re-clips the guide, recomposes, and re-hashes (§2.2). `context-budget.ts` is the policy it consults.

---

## 9. Adding a layer or a lever

**A new prompt layer** (e.g. a new `CONTEXT_TUNING §1` section):

1. **Land the spec change first** (`CLAUDE.md` "spec is a protocol"). Update `CONTEXT_TUNING §1`.
2. Create `src/cli/<layer>-prompt.ts` — pattern after `identity-prompt.ts` (constant text, one `composeWith*`, header comment with the spec ref).
3. Insert into the chain in `bootstrap.ts`. Decide its **tier**: a core layer goes in `withDirectiveTail` (both variants); a droppable hint goes on the FULL base only (like `parallel`/`tool-ergonomics`). Subagent additions go in `subagent-child.ts` as trailing blocks.
4. Update the §8 catalog + the §5.1 order list.
5. **Decide cache segment** — a layer in the `stable` chain lands in the `stable` segment; one after the memory section lands in `memory`. A high-churn layer belongs in `memory`.
6. **Add order-asserting unit tests** (see `tests/cli/*-prompt.test.ts`). Bootstrap composition tests must boot with a ≥ 64K window to see the full prefix (`tests/cli/bootstrap.test.ts` uses a 200K mock; a small-window override exercises the lean path).
7. **Run the regression eval** (`bun run eval:regression`) — a previously-green case flipping is a real behavior signal.

**A new window-relative lever** (a new way the prefix leans on small windows): add the policy function to `context-budget.ts`, decide per-turn (shape, in the `stable` segment) vs boot-pinned (assembly, `memory` segment) per §3.2, and add a row to the `CONTEXT_TUNING §2.2` lever table + §3.1 here. Gate it on eval (small-window task completion).

---

## 10. Evolution policy

Changes to the assembled prefix are load-bearing (`CONTEXT_TUNING §1.8.5`):

1. Update the spec doc(s).
2. Land the impl change.
3. Run the regression eval against a real provider — the corpus is the safety net.
4. The new prompt's `prompt_hash` lands in `prompt_versions` automatically on next boot (or next re-shape).

The hash is not a separate version knob — it IS the prompt change, content-addressed. Same content → same hash → same row, forever.

---

## 11. See also

- `docs/spec/CONTEXT_TUNING.md` — canonical context spec (§1 system prompt architecture, §2.2 window-relative allocator, §3 cache breakpoints)
- `docs/spec/AUDIT.md §1.3` — `prompt_versions` contract, hash semantics, join surface
- `docs/spec/SECURITY_GUIDELINE.md §0` — principle 11, wired into `# Constraints`
- `docs/spec/PLAYBOOKS.md §1.1` — playbook frontmatter feeding the subagent chain
- `docs/MEMORY.md` — memory section content + provenance (the `memory` segment)
- `docs/SKILLS.md` — skill catalog content
- `docs/TOOLS.md` — the tool surface (deferral, the builtin set)
- `src/tools/context-budget.ts` — the window-relative policy module
