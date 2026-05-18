// createSemanticVerifyScheduler — step-boundary scheduler for the
// S11 LLM-judge semantic verifier (MEMORY.md §11.x / T11.8).
//
// The harness loop calls `scheduler.poll()` at each step boundary.
// Poll queries `memory_provenance` for exposures landed since the
// last poll, filters down to factual memories (type=project /
// reference) that:
//
//   - haven't crossed the per-session dispatch / cost caps,
//   - don't already have a pending governance proposal,
//   - don't have a recent attempt in the dedup cache,
//
// and dispatches AT MOST ONE verification per poll. Single-shot per
// step keeps the surface of "spawn a subagent between two model
// turns" bounded — a session with 10 freshly-exposed memories
// dispatches 10 verifies across 10 steps instead of 10 in one burst.
//
// Lifecycle:
//   - Created at session boot when `HarnessConfig.memorySemanticVerify
//     === true` AND the verify-semantic definition resolved.
//   - `poll()` is async; the harness can await OR fire-and-forget.
//     Errors stderr-log as `memory: verify_semantic_*` and never
//     throw — scheduler failures must not abort the turn.
//   - `shutdown()` flips an internal flag; subsequent polls no-op.

import type { HookSpec } from '../hooks/types.ts';
import type { PermissionEngine } from '../permissions/index.ts';
import type { Provider } from '../providers/index.ts';
import { sanitizeOneLineForDisplay } from '../sanitize/ansi.ts';

// G9: error-context surfaces (subagent crash dumps, transient SQLite
// failures) need more headroom than the default 200 chars so an
// operator chasing a regression doesn't lose the failure cause. Short
// labels (scope/name) keep the default. The 1024 cap is generous but
// still bounded — a runaway error string can't blow up the log line.
const ERR_MAX_CHARS = 1024;
const displayErr = (s: string): string => sanitizeOneLineForDisplay(s, ERR_MAX_CHARS);
import type { DB } from '../storage/db.ts';
import { listPendingProposalsForMemory } from '../storage/repos/memory-governance.ts';
import { listSessionExposuresSince } from '../storage/repos/memory-provenance.ts';
import type { SubagentDefinition } from '../subagents/types.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { MemoryRegistry } from './registry.ts';
import type { MemoryScope } from './types.ts';
import { dispatchSemanticVerify } from './verify-semantic-dispatcher.ts';
import {
  MEMORY_VERIFY_SEMANTIC_MAX_COST_USD,
  MEMORY_VERIFY_SEMANTIC_MAX_DISPATCHES_PER_SESSION,
  SEMANTIC_VERIFY_ELIGIBLE_TYPES,
  SEMANTIC_VERIFY_SUBAGENT_MAX_COST_USD,
} from './verify-semantic.ts';

// ─── shapes ───────────────────────────────────────────────────────────

export interface SemanticVerifySchedulerDeps {
  db: DB;
  registry: MemoryRegistry;
  // The verify-semantic SubagentDefinition. Caller resolves from
  // the loaded SubagentSet at boot. Scheduler accepts undefined to
  // turn into a no-op (allows the harness to wire unconditionally
  // even when the definition isn't loaded — built-in dir empty in
  // a stripped binary, user opted out by writing a name-collision
  // file, etc.).
  definition: SubagentDefinition | undefined;
  // S5 CRIT/H2 mirror — when the bootstrap's shared-corpus trust
  // probe returned a non-confirmed outcome, the eager-load and
  // retrieve_context surfaces exclude `project_shared`. The
  // scheduler MUST mirror this — otherwise it would peek + ship
  // project_shared bodies to the verify-semantic subagent even
  // though the operator marked the corpus untrusted. The
  // exclusion runs BEFORE peek so the registry never reveals the
  // body content path either.
  memoryExcludeScopes?: ReadonlyArray<MemoryScope>;
  // Parent session id under which dispatches run.
  parentSessionId: string;
  cwd: string;
  provider: Provider;
  parentToolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  // Parent-runtime context forwarded into each dispatch (F9). See
  // dispatcher.ts:DispatchSemanticVerifyInput for the rationale on
  // each field.
  softStopSignal?: AbortSignal;
  cwdTrusted?: boolean;
  hooksSnapshot?: readonly HookSpec[];
  effectiveCapabilities?: readonly string[];
  // Test seam — replaces runSubagent inside the dispatcher.
  spawnSubagentFn?: typeof import('../subagents/runtime.ts').runSubagent;
  // Test seam — clock override.
  now?: () => number;
  // Test seam — limit poll iteration so a degenerate exposure list
  // doesn't cap CPU. Production default 50.
  maxExposuresPerPoll?: number;
  // Test seam — override the per-session dispatch / cost caps.
  // Production callers omit; the module's exported constants apply.
  maxDispatchesPerSession?: number;
  maxCostUsd?: number;
  // Test seam — override the stderr writer for cap-exhaustion alerts.
  stderr?: (line: string) => void;
}

export type SchedulerCapExhausted = 'dispatch' | 'cost' | null;

export interface SemanticVerifySchedulerCounters {
  // Total dispatches that fired (incl. malformed / spawn_failed —
  // they consumed budget). Skipped dispatches (injection / dedup)
  // don't count.
  dispatched: number;
  // Cumulative cost spent by all dispatches. Sum of result.costUsd
  // across every dispatch.
  costUsdSpent: number;
  // Set when either cap tripped during this session. Once set, all
  // subsequent polls no-op until shutdown.
  capExhausted: SchedulerCapExhausted;
  // Epoch ms of the last successful poll (independent of whether
  // any dispatch fired). 0 before the first poll.
  lastPolledAt: number;
}

export interface SemanticVerifyScheduler {
  poll: () => Promise<void>;
  getCounters: () => SemanticVerifySchedulerCounters;
  shutdown: () => void;
}

// ─── factory ──────────────────────────────────────────────────────────

export const createSemanticVerifyScheduler = (
  deps: SemanticVerifySchedulerDeps,
): SemanticVerifyScheduler => {
  const nowFn = deps.now ?? (() => Date.now());
  const maxExposures = deps.maxExposuresPerPoll ?? 50;
  const maxDispatches =
    deps.maxDispatchesPerSession ?? MEMORY_VERIFY_SEMANTIC_MAX_DISPATCHES_PER_SESSION;
  const maxCost = deps.maxCostUsd ?? MEMORY_VERIFY_SEMANTIC_MAX_COST_USD;
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));

  let stopped = false;
  // cursorAt is the listSessionExposuresSince cutoff. It advances
  // INCREMENTALLY per consumed candidate so a single-dispatch-per-poll
  // doesn't leak the unprocessed siblings out of the next poll's
  // window. Distinct from counters.lastPolledAt (which tracks
  // "last time poll was invoked" for the status surface).
  let cursorAt = 0;
  const counters: SemanticVerifySchedulerCounters = {
    dispatched: 0,
    costUsdSpent: 0,
    capExhausted: null,
    lastPolledAt: 0,
  };

  const isEligibleType: ReadonlySet<string> = new Set(SEMANTIC_VERIFY_ELIGIBLE_TYPES);
  const excludedScopes: ReadonlySet<MemoryScope> = new Set(deps.memoryExcludeScopes ?? []);

  const checkCapsBeforeDispatch = (): SchedulerCapExhausted => {
    if (counters.dispatched >= maxDispatches) return 'dispatch';
    if (counters.costUsdSpent >= maxCost) return 'cost';
    // Per-dispatch headroom: refuse a new dispatch when the
    // worst-case cost of the next call (the subagent's declared
    // max_cost_usd budget) would blow past the session cap. Without
    // this, a single dispatch can overrun the cap by an arbitrary
    // amount because the cost-add lands AFTER the dispatch resolves.
    // The check uses SEMANTIC_VERIFY_SUBAGENT_MAX_COST_USD (0.10)
    // — the value the verify-semantic.md frontmatter declares — so
    // a dispatch that respects its declared budget always fits;
    // anything past that signals provider / model misconfig.
    if (counters.costUsdSpent + SEMANTIC_VERIFY_SUBAGENT_MAX_COST_USD > maxCost) return 'cost';
    return null;
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (deps.definition === undefined) return;
    if (counters.capExhausted !== null) return;

    // Mark this poll attempt — independent of whether any candidate
    // gets processed. The status surface uses this to show "last
    // tick at ...".
    counters.lastPolledAt = nowFn();

    let exposures: ReturnType<typeof listSessionExposuresSince>;
    try {
      exposures = listSessionExposuresSince(deps.db, deps.parentSessionId, cursorAt, maxExposures);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`memory: verify_semantic_poll_failed: ${displayErr(msg)}\n`);
      return;
    }

    // Helper: advance the cursor to the candidate's createdAt so
    // the next poll's cutoff sits past it. Bumping incrementally
    // (per consumed candidate) instead of jumping to pollStart
    // preserves any candidates that REMAIN unprocessed when we
    // early-return for one-dispatch-per-poll — those still appear in
    // the next listSessionExposuresSince call.
    const advanceTo = (createdAt: number): void => {
      if (createdAt > cursorAt) {
        cursorAt = createdAt;
      }
    };

    // Dedupe by (scope, name) preserving the FIRST sighting's
    // createdAt — that's the value cursor advances past after
    // dispatch. Earlier shape tracked the LATEST createdAt per key
    // and advanced past it, which dropped intervening siblings:
    // exposures `(foo @1000, bar @2000, foo @3000)` consumed foo
    // (advancing cursor to 3000), and bar @2000 vanished forever
    // because the next poll's `created_at > 3000` filter never
    // returned it. Tracking first-sight and advancing cursor only
    // past the dispatched candidate's first createdAt re-emits the
    // later foo @3000 next poll (which dedup-hits cheaply in the
    // dispatcher) WITHOUT losing bar @2000 in between.
    //
    // Excluded-scope candidates are filtered at this stage (cheap
    // string check) so they neither contribute to peek/spawn nor
    // accidentally block siblings via the seen set. Cursor advances
    // past them so they're not re-considered on the next poll (the
    // trust verdict for this session is stable).
    const seen = new Set<string>();
    const candidates: { scope: MemoryScope; name: string; createdAt: number }[] = [];
    for (const e of exposures) {
      if (excludedScopes.has(e.memoryScope)) {
        advanceTo(e.createdAt);
        continue;
      }
      const key = `${e.memoryScope}/${e.memoryName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ scope: e.memoryScope, name: e.memoryName, createdAt: e.createdAt });
    }

    for (const cand of candidates) {
      if (stopped) return;
      // Advance only past the candidate's FIRST sighting createdAt
      // — see the dedup comment above for why latest-sighting
      // semantics would drop intervening siblings.
      const advanceAt = cand.createdAt;

      // Cap re-check INSIDE the loop — caps may have crossed during
      // an earlier candidate's dispatch on this same poll. DON'T
      // advance lastPolledAt here — the next poll re-considers this
      // candidate (cap may have been raised via policy reload).
      const cap = checkCapsBeforeDispatch();
      if (cap !== null) {
        counters.capExhausted = cap;
        stderr(
          `memory: verify_semantic_budget_exhausted: ${cap === 'dispatch' ? `dispatch cap reached (${counters.dispatched}/${maxDispatches})` : `cost cap reached ($${counters.costUsdSpent.toFixed(4)} / $${maxCost.toFixed(2)})`}\n`,
        );
        return;
      }

      // Type gate — only project / reference are factual.
      const peek = deps.registry.peek(cand.name, { scope: cand.scope });
      if (peek.kind !== 'present') {
        if (peek.kind === 'malformed') {
          // F13: surface corruption to the operator. Silent drop
          // would mask a memory file with broken frontmatter from
          // the verifier loop forever.
          stderr(
            `memory: verify_semantic_peek_malformed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(peek.error)}\n`,
          );
        }
        advanceTo(advanceAt);
        continue;
      }
      if (!isEligibleType.has(peek.file.frontmatter.type)) {
        advanceTo(advanceAt);
        continue;
      }
      // Trust filter (G3 — AGENTIC_CLI.md §1.1.5 canonical gate).
      // memory-prompt.ts:242 + memory-read.ts:199 both honor
      // `frontmatter.trust === 'untrusted'`; the scheduler MUST
      // mirror so an inferred write in an untrusted cwd doesn't
      // sneak a body into the verify-semantic subagent's window
      // via the provenance trail. Cursor advances past the
      // candidate — trust verdict on this body is stable for the
      // session.
      if (peek.file.frontmatter.trust === 'untrusted') {
        advanceTo(advanceAt);
        continue;
      }
      // F15: state filter. Already-quarantined / invalidated / evicted
      // memories don't need verification — their lifecycle status
      // already conveys "do not trust", any judge verdict is moot
      // and would waste budget. `state` defaults to 'active' when
      // absent (per MEMORY.md §3.1.1).
      const state = peek.file.frontmatter.state ?? 'active';
      if (state !== 'active') {
        advanceTo(advanceAt);
        continue;
      }

      // Pre-dispatch dedup against pending governance proposals.
      // If a quarantine proposal is already pending for this memory,
      // skip — the apply path's UNIQUE fingerprint index would
      // refuse the INSERT anyway, and the LLM cost would be wasted.
      let pending: ReturnType<typeof listPendingProposalsForMemory>;
      try {
        pending = listPendingProposalsForMemory(deps.db, cand.scope, cand.name, 5);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`memory: verify_semantic_pending_check_failed: ${displayErr(msg)}\n`);
        // Don't advance — next poll retries. Lookup failures are
        // transient; advancing would lose the candidate permanently.
        continue;
      }
      if (pending.some((p) => p.kind === 'quarantine')) {
        advanceTo(advanceAt);
        continue;
      }

      // Dispatch. The dispatcher does its own scanForInjection +
      // attempts-cache dedup; the scheduler's gates above are the
      // cheap pre-flight that avoids constructing the input at all
      // when the cap or pending row obviously refuses.
      let outcome: Awaited<ReturnType<typeof dispatchSemanticVerify>>;
      try {
        outcome = await dispatchSemanticVerify({
          db: deps.db,
          definition: deps.definition,
          parentSessionId: deps.parentSessionId,
          cwd: deps.cwd,
          provider: deps.provider,
          parentToolRegistry: deps.parentToolRegistry,
          permissionEngine: deps.permissionEngine,
          memory: { scope: cand.scope, name: cand.name, file: peek.file },
          // F11: dispatcher re-peeks via the registry to detect a
          // body edit between this poll and the spawn. Scope-
          // filtered registry honors the same memoryExcludeScopes
          // posture documented in F2 (excluded scopes never reach
          // this point anyway — the scheduler filtered upstream).
          registry: deps.registry,
          // Forward parent-runtime context (F9). The scheduler is
          // the place where these values are reachable; dispatcher
          // is per-call.
          ...(deps.softStopSignal !== undefined ? { softStopSignal: deps.softStopSignal } : {}),
          ...(deps.cwdTrusted !== undefined ? { cwdTrusted: deps.cwdTrusted } : {}),
          // sharedScopeOffline mirrors memoryExcludeScopes — the
          // dispatcher's field is a boolean. When the scope is in
          // the excluded list (F2), we mark the child's posture
          // accordingly.
          ...(excludedScopes.has(cand.scope) ? { sharedScopeOffline: true } : {}),
          ...(deps.hooksSnapshot !== undefined ? { hooksSnapshot: deps.hooksSnapshot } : {}),
          ...(deps.effectiveCapabilities !== undefined
            ? { effectiveCapabilities: deps.effectiveCapabilities }
            : {}),
          ...(deps.spawnSubagentFn !== undefined ? { spawnSubagentFn: deps.spawnSubagentFn } : {}),
          now: nowFn,
        });
      } catch (err) {
        // Programmer-error path (runSubagent throws on invalid
        // input). Surface to stderr and continue — the next
        // candidate may succeed. Advance: a thrown dispatch means
        // we tried; retrying the same candidate without an interim
        // change won't help.
        const msg = err instanceof Error ? err.message : String(err);
        stderr(
          `memory: verify_semantic_dispatch_failed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(msg)}\n`,
        );
        advanceTo(advanceAt);
        continue;
      }

      // G6: shutdown() may have fired during the awaited dispatch.
      // Post-await mutations (counter bumps, stderr, cursor advance)
      // would otherwise land after shutdown was requested — tests
      // asserting clean post-shutdown counter shape would see one
      // extra dispatch, and the verify-semantic-status surface would
      // count a dispatch the operator believes was cancelled. Bail
      // BEFORE the bookkeeping. The on-disk attempt + governance
      // proposal landed inside the dispatcher already — those are
      // not rolled back; recording the in-memory counter is the
      // only thing skipped here.
      if (stopped) return;

      if (outcome.kind === 'skipped') {
        // No LLM cost incurred — try next candidate without bumping
        // the dispatch counter. injection_detected / dedup_hit /
        // stale_snapshot are legitimate skips. F17: emit
        // verify_skipped on the injection / stale_snapshot paths so
        // the operator opted into --memory-verify-llm can see WHY
        // the judge never fires on a memory they expected to be
        // verified. dedup_hit is silent (expected, cached).
        if (outcome.reason === 'injection_detected' || outcome.reason === 'stale_snapshot') {
          stderr(
            `memory: verify_skipped: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${outcome.reason}\n`,
          );
        }
        // G5: stale_snapshot does NOT advance the cursor — the
        // operator's edit needs to land in a fresh poll's peek so
        // the dispatcher can run against the latest body. If we
        // advanced here, the candidate would only re-emit after a
        // new exposure landed (a memory_read / retrieve_context
        // tool call), which can be far in the future. Other skip
        // reasons (injection_detected gating definitively, dedup_hit
        // already cached) DO advance — the candidate was gated for
        // good. Loop-prevention: the next poll re-peeks via the
        // scheduler, gets the fresh body, passes it as the new
        // snapshot to the dispatcher, whose re-read inside matches
        // — proceeds. Only pathological "operator edits between
        // every poll" would loop, which the cost cap bounds.
        if (outcome.reason !== 'stale_snapshot') {
          advanceTo(advanceAt);
        }
        continue;
      }

      // 'completed' / 'malformed' / 'spawn_failed' all consumed
      // budget (full or partial). Increment + apply throttle.
      counters.dispatched += 1;
      counters.costUsdSpent += outcome.costUsd;

      if (outcome.kind === 'malformed') {
        stderr(
          `memory: verify_semantic_malformed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(outcome.reason)}\n`,
        );
      } else if (outcome.kind === 'spawn_failed') {
        stderr(
          `memory: verify_semantic_spawn_failed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(outcome.reason)}\n`,
        );
      }

      // One real dispatch per poll. Advance past this candidate so
      // it's not re-considered next poll (the attempts-cache would
      // dedup-skip it anyway, but advancing avoids the wasted
      // peek + lookup).
      advanceTo(advanceAt);
      return;
    }
  };

  const getCounters = (): SemanticVerifySchedulerCounters => ({
    dispatched: counters.dispatched,
    costUsdSpent: counters.costUsdSpent,
    capExhausted: counters.capExhausted,
    lastPolledAt: counters.lastPolledAt,
  });

  const shutdown = (): void => {
    stopped = true;
  };

  return { poll, getCounters, shutdown };
};
