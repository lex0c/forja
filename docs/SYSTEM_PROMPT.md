# Forja System Prompt Flow

This document describes how Forja assembles, hashes, and persists the system prompt at runtime. It is intended for contributors who need to add a new section, debug an unexpected layer ordering, change the cache strategy, or trace why a particular message landed under a particular `prompt_hash`.

The canonical specification lives in [`docs/spec/CONTEXT_TUNING.md §1`](./spec/CONTEXT_TUNING.md) (PT-BR) — section ordering, layer semantics, cache strategy, evolution rules. Storage contract for `prompt_versions` lives in [`docs/spec/AUDIT.md §1.3`](./spec/AUDIT.md). This document is the English-language **implementation** companion: which files do the assembly, in what order, and how the hash threads through the harness. When this doc and the spec diverge, the spec wins.

---

## 1. Mental model

There are **two distinct system-prompt assembly pipelines** in Forja, both rooted in `src/cli/`:

- **Principal path** — `bootstrap.ts` assembles the prompt for the top-level agent. Runs once per session at boot. The base `input.systemPrompt` is a small caller-provided string (typically empty in practice — the entire prompt comes from the composer chain).
- **Subagent / playbook path** — `subagent-child.ts` assembles the prompt for a spawned subagent. Runs once per `task()` invocation. The base is `audit.systemPrompt` — the playbook body captured at definition-load time (`PLAYBOOKS.md` §1.1) and persisted in the `subagent_runs` audit row.

Both pipelines:

- Use small **composers** (`composeWithX(downstream, …)` functions, one per layer). Most composers PREPEND their layer to the downstream chunk, so reading the chain top-to-bottom in code gives the **inside-out** order and the final prompt's top-down layer order is the reverse. The subagent's trailing-block composers (`reference`, `output-schema`, `reflection`) are the exception — they APPEND, putting the layer AFTER the downstream. The principal chain is purely prepending; the subagent chain mixes prepend (parallel hint) with append (the trailing blocks) and the resulting order is documented case-by-case in §3.2.
- End by hashing the assembled prompt and registering it in `prompt_versions` (AUDIT §1.3.3) — `kind='system'` for the principal, `kind='playbook'` for the subagent.
- Thread the hash into the harness's `HarnessConfig.systemPromptHash`, which the loop (`src/harness/loop.ts`) stamps on every `messages.prompt_hash` and `tool_calls.prompt_hash` row written during the run.

The two pipelines diverge because their CONSTRAINTS diverge: the principal must surface the entire workflow surface (skills, project pointer, environment, full constraints); the subagent only needs the playbook-specific surface (references, output schema, reflection mode) plus the parallelism affordance hint and an optional memory section.

---

## 2. Principal pipeline (`bootstrap.ts`)

### 2.1 The composer chain

Inside `bootstrap.ts`, the assembly runs as **two phases**:

**Phase 1 — prepend chain** (`src/cli/bootstrap.ts` ~lines 786–821). Each `composeWithX` prepends its layer; the leftmost variable (`baseDownstream`) is the innermost / appears LAST in the final prompt.

```text
input.systemPrompt                                  ← base (typically empty)
  ↑ composeWithPlaybookHint
  ↑ composeWithToolErgonomics
  ↑ composeWithParallelHint
  ↑ composeWithConstraints
  ↑ composeWithResponseFormat
  ↑ composeWithEnvironment
  ↑ composeWithIdentity                             ← outermost / appears FIRST
```

**Phase 2 — append / merge** (~lines 1101, 1192, 1200). `composeWithProjectPointer` appends a pointer block; `composeSystemPrompt` (a different helper in `memory-prompt.ts`) concatenates the memory section and then the skill catalog at the tail.

**Final assembled order**, top to bottom:

1. **Identity** — what Forja is, the declarative policy it runs under, verify-before-acting (`CONTEXT_TUNING §1.2`)
2. **Environment** — cwd, profile, git branch, current date (`§1.3`, `§1.4`)
3. **Response format** — output surface fixed (`§1.5`)
4. **Constraints** — the `# Constraints` block: correctness rules + build discipline + security posture + hard-to-reverse confirm + goal-contradictory cancellation (`§1.6` + `SECURITY_GUIDELINE §0.11`)
5. **Parallel hint** — surfaces the harness's parallel-tool affordance
6. **Tool ergonomics** — highest-payoff tool-usage patterns distilled from `TOOL_ERGONOMICS.md`
7. **Playbook hint** — discovery table + delegation criteria for subagent routing (`PLAYBOOKS §1.4`)
8. **Base systemPrompt** — caller-provided string (typically empty in production)
9. **Project pointer** — `[project_context]` block (`CONTEXT_TUNING §2.0`)
10. **Memory section** — auto-injected memories per `MEMORY.md`
11. **Skill catalog** — eager-load surface of available skills (body lazy)

### 2.2 Why this order

The order is **not arbitrary** — it interacts with three things:

- **Cache breakpoints** (`CONTEXT_TUNING §3`). Bootstrap emits TWO segments via `HarnessConfig.systemSegments` (a `string | SystemSegment[]` channel parallel to the canonical `systemPrompt` string):
  - **`stable` segment** — identity + environment + response format + constraints + tool ergonomics + base systemPrompt + project pointer. This is the most stable region across the REPL session; gets its own `cache_control` marker so it persists when memory rotates.
  - **`memory` segment** — memory section + skill catalog. The high-churn region (invalidates on `memory_write` and skill palette changes); gets its own `cache_control` marker so a memory write doesn't drop the entire prefix.
  
  `flattenSystemSegments(segments) === systemPrompt` is the invariant — audit hash + non-segment-aware adapters (OpenAI, Google) read the canonical string; Anthropic reads the array. Date stays in the environment block; the per-bootstrap re-evaluation means resume on day N+1 sees `today: N+1` correctly (semantic continuity wins over the marginal cache cost of one extra `cache_creation` per cross-day resume).
- **Reader attention.** The model reads top to bottom; the load-bearing role marker + correctness rules go first so a long memory section or skill catalog at the tail does not push the policy posture out of attention.
- **Dynamic-content tail.** Project pointer, memory section, and skill catalog are the most session-variant pieces. Putting them last + segmenting them with cache breakpoints localizes cache invalidation to the tail when a new memory file lands or a skill is added.

### 2.3 Hash registration

After Phase 2 completes (`bootstrap.ts` ~lines 1214–1232):

```text
hashPromptContent(resolvedSystemPrompt)
  → recordPromptVersion(db, { kind: 'system', name: 'system.autonomous', ... })
  → systemPromptHash exposed on BootstrapResult and HarnessConfig
```

The `name: 'system.autonomous'` is hardcoded because the autonomous profile is the only profile this binary ships. When the orchestrated profile (`CONTEXT_TUNING §1.8.2`) lands, the registration must branch on the active profile — otherwise both profiles register under the same `name` and the `§1.3.5` history-by-name query collapses two distinct logical prompts into one bucket. The TODO sits at the registration site.

---

## 3. Subagent / playbook pipeline (`subagent-child.ts`)

### 3.1 Why subagents need their own chain

A subagent's system prompt is the **playbook body** (`audit.systemPrompt`) wrapped in a narrower set of affordances. It is NOT the principal's full surface — playbooks declare their own tool whitelist, their own references, their own optional output schema, and their own reflection mode. Including the principal's full chain (identity, environment, response format, constraints, tool ergonomics, project pointer, skill catalog) would (a) override the playbook author's intent, (b) blow the per-call token budget on content unrelated to the playbook's narrow job, and (c) defeat the purpose of having a playbook in the first place.

### 3.2 The composer chain

Inside `subagent-child.ts` (~lines 858–873), the chain is shorter. **Importantly, the three trailing-block composers (`reference`, `output-schema`, `reflection`) APPEND their layer after the downstream, while `composeWithParallelHint` PREPENDS** — the direction is asymmetric and the in-code comment block at lines 840–872 documents the resulting top-down order verbatim. The chain in source order:

```text
audit.systemPrompt                                  ← playbook body (input)
  + composeWithReferenceBlock(audit.references)     (appends references after body)
  + composeWithOutputSchemaBlock(audit.outputSchema) (appends schema after refs)
  + composeWithReflectionBlock(audit.contextRecipe?.stepReflection) (appends reflection at tail)
  ↑ composeWithParallelHint                         ← prepends parallel hint (outermost)
```

Then, conditionally (~lines 882–933), if the playbook's tool whitelist contains any `memory_*` tool and `opts.memoryCwd !== undefined`, an append:

```text
... + composeSystemPrompt(resolvedSystemPrompt, memorySection.text)
```

**Final assembled order**, top to bottom:

1. **Parallel hint** — same affordance the principal gets (prepended)
2. **Playbook body** — `audit.systemPrompt` verbatim
3. **Reference block** — trailing list of paths the model may consult (`PLAYBOOKS §1.1 references`); sits next to the body because it is metadata about the body's resources
4. **Output schema block** — terminate-with-YAML instruction matching the declared schema (`PLAYBOOKS §1.2`); after refs so the model reads role → resources → termination contract
5. **Reflection block** — per-step reasoning trace cadence (`PLAYBOOKS §1.1 context_recipe.step_reflection`); tail position because the cadence applies to every step the model takes
6. **(Memory section)** — only when the playbook wants memory tools AND `memoryCwd` is forwarded

The audit snapshot was captured at definition-load time by the parent; the child reads it from `subagent_runs` rather than re-resolving from disk. This snapshot pattern (mirrored for `policySnapshot` and `hooksSnapshot`) prevents drift between parent spawn and child startup.

### 3.3 Hash registration

After composition (`subagent-child.ts` ~lines 947–955):

```text
hashPromptContent(resolvedSystemPrompt)
  → recordPromptVersion(db, { kind: 'playbook', name: `playbook.${audit.name}`, ... })
  → systemPromptHash set on the child's HarnessConfig
```

The `name` is namespaced under `playbook.` to prevent any collision with the principal's `system.*` registrations. The same `INSERT OR IGNORE` idempotency applies: two identical playbook runs (same audit snapshot → same composed prompt → same hash) collapse to a single row, preserving the first recorder's metadata.

**Known gap** (documented at the registration site): the seed `messages` row appended by the parent in `subagents/runtime.ts` BEFORE the child computes its prompt carries `prompt_hash = NULL`. The parent doesn't know the child's prompt yet and stamping the seed retroactively would require either the parent duplicating the child's prompt assembly or the child UPDATEing the seed row — both costlier than the value of one missing join row. Subsequent turns within the child are stamped correctly.

---

## 4. `prompt_versions` integration

### 4.1 The hash → record → stamp flow

For both pipelines, the assembly ends the same way:

```text
   resolvedSystemPrompt (string)
        ↓ hashPromptContent (SHA256 hex)
   systemPromptHash
        ↓ recordPromptVersion (INSERT OR IGNORE)
   prompt_versions row (kind, name, content, author, created_at)
        ↓ HarnessConfig.systemPromptHash
   harness loop
        ↓ appendMessage(... promptHash: config.systemPromptHash ?? null)
        ↓ createToolCall(... promptHash: deps.systemPromptHash ?? null)
   messages.prompt_hash + tool_calls.prompt_hash
```

The hash is computed at the **inside** of the boundary (in `bootstrap.ts` / `subagent-child.ts`) and consumed at the **outside** of the boundary (in `harness/loop.ts` and `harness/invoke-tool.ts`). Anything in between is plumbing.

### 4.2 Where the hash threads through the harness

Five `appendMessage` sites in `loop.ts` (user / assistant / partial / result / etc.) and two `createToolCall` sites in `invoke-tool.ts` all consume `config.systemPromptHash` and pass it via `promptHash:`. The repo layer (`storage/repos/messages.ts`, `storage/repos/tool-calls.ts`) accepts it as an optional field and persists `null` when omitted — forward-compat for paths not yet wired and pre-migration-068 rows.

### 4.3 The §1.3.5 join surface

The whole point of the hash plumbing is to let `AUDIT §1.3.5` queries resolve against real data:

```sql
-- "Which prompt versions ran in the last 30 days"
SELECT DISTINCT pv.hash, pv.kind, pv.name, MIN(m.created_at) AS first_seen
FROM messages m
JOIN prompt_versions pv ON m.prompt_hash = pv.hash
WHERE m.created_at > strftime('%s', 'now', '-30 days') * 1000
GROUP BY pv.hash;

-- "This regression started in which prompt version"
SELECT m.id, m.session_id, pv.hash, pv.name, pv.created_at
FROM messages m
JOIN prompt_versions pv ON m.prompt_hash = pv.hash
WHERE <regression filter>
ORDER BY m.seq;
```

Without the soft FK on `messages.prompt_hash` / `tool_calls.prompt_hash`, every regression triage devolves to "grep audit logs and hope you can pin the prompt content from a session id." With it, the prompt content is content-addressed and every message is traceable to its emitting prompt.

---

## 5. Composer catalog

Each composer lives in its own file under `src/cli/`. The file owns the composer function, its layer text, and any inline rationale comments.

### 5.1 Principal-only composers

| Composer | File | Layer purpose |
|---|---|---|
| `composeWithIdentity` | `identity-prompt.ts` | Role-as-tool marker; what Forja is + declarative policy + verify-before-acting (`§1.2`) |
| `composeWithEnvironment` | `environment-prompt.ts` | Situational anchor: cwd, profile, git branch, current date (`§1.3`, `§1.4`) |
| `composeWithResponseFormat` | `response-format.ts` | Output surface (`§1.5`, `ANTI_PATTERNS §1.3`) — no "be concise" tuning |
| `composeWithConstraints` | `constraints-prompt.ts` | `# Constraints` block (`§1.6`) — correctness + build discipline + security + hard-to-reverse + goal-contradictory cancellation |
| `composeWithToolErgonomics` | `tool-ergonomics-prompt.ts` | High-payoff tool patterns distilled from `TOOL_ERGONOMICS.md` |
| `composeWithPlaybookHint` | `playbook-prompt.ts` | Subagent discovery table + delegation criteria (`PLAYBOOKS §1.4`) |
| `composeWithProjectPointer` | `project-pointer.ts` | `[project_context]` pointer (`§2.0`) — pointer eager, body lazy |
| `composeSystemPrompt` | `memory-prompt.ts` | Generic tail-append helper (used for memory section + skill catalog) |

### 5.2 Subagent-only composers

| Composer | File | Layer purpose |
|---|---|---|
| `composeWithReferenceBlock` | `reference-block.ts` | Trailing list of paths the playbook author declared (`PLAYBOOKS §1.1`) — model reads them lazily via `read_file` |
| `composeWithOutputSchemaBlock` | `output-schema-block.ts` | Terminate-with-YAML instruction matching the declared schema (`PLAYBOOKS §1.2`) — runtime validates post-hoc |
| `composeWithReflectionBlock` | `reflection-block.ts` | Per-step reasoning trace cadence — `terse` / `full` / `off` (`PLAYBOOKS §1.1 context_recipe.step_reflection`) |

### 5.3 Shared composers

| Composer | File | Used by |
|---|---|---|
| `composeWithParallelHint` | `parallel-prompt.ts` | Both — surfaces the harness's parallel-tool affordance (`AGENTIC_CLI §11`) |
| `composeSystemPrompt` | `memory-prompt.ts` | Both — tail-append helper for memory section (and skill catalog on principal) |

---

## 6. Adding a new composer

When a new layer is needed (e.g., a new spec section in `CONTEXT_TUNING §1`):

1. **Land the spec change first.** New composers without a spec entry violate the "spec is a protocol" rule in `CLAUDE.md`. Update `docs/spec/CONTEXT_TUNING.md §1` (and any cross-cuts in `SECURITY_GUIDELINE` / `PLAYBOOKS` / etc.) with the layer's purpose, position, and rationale before writing code.
2. **Create a new file** under `src/cli/<layer-name>-prompt.ts` (or `<layer-name>-block.ts` for subagent-trailing layers). Pattern after the smallest existing composer (`identity-prompt.ts` is a good template) — module-level constant for the text, single `composeWith*` function, header comment with the spec ref.
3. **Insert into the chain.**
   - Principal: edit `bootstrap.ts` around the existing chain (~lines 786–821 for the prepend chain; ~lines 1192–1203 for tail appends). Position by spec layer order (`§1.1`).
   - Subagent: edit `subagent-child.ts` (~lines 858–873). Most subagent additions belong as trailing blocks before the parallel hint.
4. **Update the catalog table** in §5 of this document with one row for the new composer.
5. **Decide cache breakpoint impact.** A new outer (prepended) layer pushes everything below it later in the prompt. Bootstrap currently splits the prompt into a `stable` segment (everything up to and including the project pointer) and a `memory` segment (memory section + skill catalog). A layer prepended in the chain lands inside `stable`; a layer appended after the memory section ends up inside `memory`. Document the impact in `CONTEXT_TUNING §3.1` if non-trivial (e.g., a new high-churn block landing in `stable` would force more `cache_creation` writes than necessary — move it to `memory` instead).
6. **Add unit tests** that assert the layer appears at the correct position relative to other layers (pattern: see `tests/cli/identity-prompt.test.ts` / `tests/cli/constraints-prompt.test.ts`). Composer tests should be order-asserting, not just content-asserting — a layer at the wrong position is as broken as missing content.
7. **Run the regression eval** (`bun run eval:regression`) against the new prompt and verify the gate stays green. If a previously-green case now fails, the new layer changed model behavior in a way the corpus catches — a real signal, not noise. See `docs/spec/CONTEXT_TUNING §1.8.5` for the evolution protocol.

The `prompt_versions` hash will change automatically — that is the point. Operators tracking baselines via `§1.3.7` will see the new hash; the §1.3.5 join surface will correctly attribute messages written under the new prompt to the new hash.

---

## 7. Evolution policy

Changes to the assembled system prompt are **load-bearing** and follow `docs/spec/CONTEXT_TUNING.md §1.8.5`:

1. Update the spec doc(s) describing the layer change.
2. Land the impl change (new composer or edit to existing).
3. Run the regression eval against a real provider — the corpus is the safety net.
4. The new prompt's `prompt_hash` lands in `prompt_versions` automatically on next boot.
5. Reference the new hash in any baseline tracking (`§1.3.7`).

The hash is not a separate concern from the prompt change — it IS the prompt change, content-addressed. There is no "version bump" knob; the bytes of the assembled prompt drive the hash, and the hash drives the audit join surface. Same content → same hash → same row, forever.

---

## 8. See also

- `docs/spec/CONTEXT_TUNING.md §1` — canonical system prompt architecture (sections, ordering, cache strategy, reference prompts for `autonomous` / `orchestrated` profiles)
- `docs/spec/AUDIT.md §1.3` — `prompt_versions` table contract, hash semantics, join surface
- `docs/spec/SECURITY_GUIDELINE.md §0` — principle 11 (request-handling posture) wired into the `# Constraints` block
- `docs/spec/PLAYBOOKS.md §1.1` — playbook frontmatter (references, output schema, context recipe) that feeds the subagent composer chain
- `docs/MEMORY.md` — memory section content and provenance (consumed by `composeSystemPrompt` in both pipelines)
- `docs/SKILLS.md` — skill catalog content (consumed by `composeSystemPrompt` on the principal path)
