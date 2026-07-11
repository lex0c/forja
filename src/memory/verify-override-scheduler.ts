// createOverrideVerifyScheduler — step-boundary scheduler for the
// S3 LLM-judge override detector (MEMORY.md §11.x, spec §6.5.2 /
// S3.4).
//
// The harness loop calls `scheduler.poll()` at each step boundary.
// Poll queries `memory_override_events` for rows landed since the
// last poll, groups by (scope, name), and dispatches a verify-
// override subagent for memories that:
//
//   - haven't crossed the per-session dispatch / cost caps,
//   - have accumulated MEMORY_OVERRIDE_THRESHOLD_COUNT (=3)
//     events in MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS (=24h) — the
//     spec §6.5.2 deterministic gate that costs ONE LLM call when
//     crossed; below it, zero LLM cost,
//   - pass the factual / active / trusted filter (defense in
//     depth; the signal collector already filtered when emitting),
//   - don't already have a pending quarantine proposal,
//   - aren't already in the dispatcher's cooldown cache.
//
// Single dispatch per poll keeps the surface bounded — a session
// with several threshold-tripped memories dispatches across
// several steps instead of fan-out at one boundary.
//
// Lifecycle mirrors createSemanticVerifyScheduler (S11) — created
// at boot, async poll, fail-soft stderr, shutdown flag.

import type { HookSpec } from '../hooks/types.ts';
import type { PermissionEngine } from '../permissions/index.ts';
import type { Provider } from '../providers/index.ts';
import { sanitizeOneLineForDisplay } from '../sanitize/ansi.ts';
import type { DB } from '../storage/db.ts';
import { listPendingProposalsForMemory } from '../storage/repos/memory-governance.ts';
import {
  countOverridesInWindow,
  listOverrideEventsSince,
  listRecentOverridesForMemory,
  MEMORY_OVERRIDE_THRESHOLD_COUNT,
  MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS,
  type MemoryOverrideEventRow,
} from '../storage/repos/memory-override-events.ts';
import type { SubagentDefinition } from '../subagents/types.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { MemoryRegistry } from './registry.ts';
import type { MemoryScope } from './types.ts';
import {
  MEMORY_VERIFY_OVERRIDE_MAX_COST_USD,
  MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION,
  SEMANTIC_OVERRIDE_ELIGIBLE_TYPES,
  SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD,
} from './verify-override.ts';
import { dispatchOverrideVerify } from './verify-override-dispatcher.ts';

const ERR_MAX_CHARS = 1024;
const displayErr = (s: string): string => sanitizeOneLineForDisplay(s, ERR_MAX_CHARS);

// ─── shapes ───────────────────────────────────────────────────────────

export interface OverrideVerifySchedulerDeps {
  db: DB;
  registry: MemoryRegistry;
  definition: SubagentDefinition | undefined;
  // S5 mirror — same fail-closed posture as the verify-semantic
  // scheduler: when the bootstrap's shared-corpus trust probe
  // returned non-confirmed, the scheduler refuses to dispatch
  // against memories in those scopes AND forwards
  // `sharedScopeOffline: true` to the child.
  memoryExcludeScopes?: ReadonlyArray<MemoryScope>;
  parentSessionId: string;
  cwd: string;
  provider: Provider;
  parentToolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  // Parent operating envelope — same as verify-semantic.
  signal?: AbortSignal;
  softStopSignal?: AbortSignal;
  cwdTrusted?: boolean;
  hooksSnapshot?: readonly HookSpec[];
  effectiveCapabilities?: readonly string[];
  spawnChildProcess?: import('../subagents/runtime.ts').SpawnChildProcess;
  // Test seam — replaces runSubagent inside the dispatcher.
  spawnSubagentFn?: typeof import('../subagents/runtime.ts').runSubagent;
  // Test seam — clock override.
  now?: () => number;
  // Test seam — limit poll iteration. Production default 50.
  maxEventsPerPoll?: number;
  // Test seam — override per-session caps.
  maxDispatchesPerSession?: number;
  maxCostUsd?: number;
  // Test seam — override the threshold (default 3).
  thresholdCount?: number;
  // Test seam — override the threshold window (default 24h).
  thresholdWindowMs?: number;
  stderr?: (line: string) => void;
}

export type OverrideSchedulerCapExhausted = 'dispatch' | 'cost' | null;

export interface OverrideVerifySchedulerCounters {
  // Total dispatches that fired (incl. malformed / spawn_failed).
  // Skipped dispatches (injection / cooldown dedup / stale_snapshot
  // / empty_events) don't count.
  dispatched: number;
  costUsdSpent: number;
  capExhausted: OverrideSchedulerCapExhausted;
  lastPolledAt: number;
}

export interface OverrideVerifyScheduler {
  poll: () => Promise<void>;
  getCounters: () => OverrideVerifySchedulerCounters;
  shutdown: () => void;
}

// ─── factory ──────────────────────────────────────────────────────────

export const createOverrideVerifyScheduler = (
  deps: OverrideVerifySchedulerDeps,
): OverrideVerifyScheduler => {
  const nowFn = deps.now ?? (() => Date.now());
  const maxEvents = deps.maxEventsPerPoll ?? 50;
  const maxDispatches =
    deps.maxDispatchesPerSession ?? MEMORY_VERIFY_OVERRIDE_MAX_DISPATCHES_PER_SESSION;
  const maxCost = deps.maxCostUsd ?? MEMORY_VERIFY_OVERRIDE_MAX_COST_USD;
  const thresholdCount = deps.thresholdCount ?? MEMORY_OVERRIDE_THRESHOLD_COUNT;
  const thresholdWindowMs = deps.thresholdWindowMs ?? MEMORY_OVERRIDE_THRESHOLD_WINDOW_MS;
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));

  let stopped = false;
  // Cursor tuple. Same shape as verify-semantic's cursor — protects
  // against same-ms inserts losing intervening siblings on next poll.
  //
  // Initial value `(0, '')` is a sentinel meaning "uninitialized";
  // first `poll()` rewrites to `(nowFn() - thresholdWindowMs, '')`
  // so the scheduler doesn't drain 90d-retained historical rows
  // before reaching anything that could trip the window-bounded
  // threshold. Events older than the window can't count via
  // `countOverridesInWindow` anyway — paying N peeks + N threshold
  // checks for them was pure waste. Pre-fix, short CLI sessions
  // could finish before the cursor drained enough old rows to
  // reach fresh threshold-tripping events. Lazy init (not
  // construction-time) keeps `now` honoring the test-seam clock.
  let cursorAt = 0;
  let cursorId = '';
  let cursorInitialized = false;
  const counters: OverrideVerifySchedulerCounters = {
    dispatched: 0,
    costUsdSpent: 0,
    capExhausted: null,
    lastPolledAt: 0,
  };

  const isEligibleType: ReadonlySet<string> = new Set(SEMANTIC_OVERRIDE_ELIGIBLE_TYPES);
  const excludedScopes: ReadonlySet<MemoryScope> = new Set(deps.memoryExcludeScopes ?? []);
  // S5 fail-closed: forward sharedScopeOffline to every dispatched
  // child regardless of the candidate's own scope (same rationale as
  // verify-semantic scheduler).
  const sharedScopeOffline = excludedScopes.has('project_shared');

  const checkCapsBeforeDispatch = (): OverrideSchedulerCapExhausted => {
    if (counters.dispatched >= maxDispatches) return 'dispatch';
    if (counters.costUsdSpent >= maxCost) return 'cost';
    // Per-dispatch headroom: refuse a new dispatch when the
    // worst-case spend of the next call would blow past the session
    // cap. Uses the subagent's declared max_cost_usd
    // (SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD = 0.08) so a dispatch
    // that respects its budget always fits; anything past that
    // signals provider misconfig.
    if (counters.costUsdSpent + SEMANTIC_OVERRIDE_SUBAGENT_MAX_COST_USD > maxCost) return 'cost';
    return null;
  };

  const advanceTo = (createdAt: number, id: string): void => {
    if (createdAt > cursorAt || (createdAt === cursorAt && id > cursorId)) {
      cursorAt = createdAt;
      cursorId = id;
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (deps.definition === undefined) return;
    if (counters.capExhausted !== null) return;

    counters.lastPolledAt = nowFn();

    // Lazy cursor init — anchor at the window cutoff so old retained
    // rows (90d) don't burn poll budget. See cursorAt declaration
    // comment for rationale.
    if (!cursorInitialized) {
      cursorAt = nowFn() - thresholdWindowMs;
      cursorInitialized = true;
    }

    let events: MemoryOverrideEventRow[];
    try {
      events = listOverrideEventsSince(deps.db, cursorAt, cursorId, maxEvents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`memory: verify_override_poll_failed: ${displayErr(msg)}\n`);
      return;
    }

    // Group events by (scope, name) preserving FIRST-sighting
    // createdAt + id — that's the value the cursor advances past
    // when we dispatch (mirrors verify-semantic). For the threshold
    // check we use `countOverridesInWindow` (window-based, NOT
    // batch-based) so events accumulated across multiple polls all
    // count toward the threshold even after the cursor moves past
    // their batch.
    const seen = new Set<string>();
    const candidates: {
      scope: MemoryScope;
      name: string;
      firstSightAt: number;
      firstSightId: string;
    }[] = [];
    for (const e of events) {
      if (excludedScopes.has(e.memoryScope)) {
        // S5 fail-closed: scope is offline this session. Advance
        // past the event so it's not re-considered.
        advanceTo(e.createdAt, e.id);
        continue;
      }
      const key = `${e.memoryScope}/${e.memoryName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        scope: e.memoryScope,
        name: e.memoryName,
        firstSightAt: e.createdAt,
        firstSightId: e.id,
      });
    }

    for (const cand of candidates) {
      if (stopped) return;
      const advanceAt = cand.firstSightAt;
      const advanceId = cand.firstSightId;

      // Cap re-check INSIDE the loop — caps may have crossed during
      // an earlier candidate's dispatch on this same poll.
      const cap = checkCapsBeforeDispatch();
      if (cap !== null) {
        counters.capExhausted = cap;
        stderr(
          `memory: verify_override_budget_exhausted: ${cap === 'dispatch' ? `dispatch cap reached (${counters.dispatched}/${maxDispatches})` : `cost cap reached ($${counters.costUsdSpent.toFixed(4)} / $${maxCost.toFixed(2)})`}\n`,
        );
        return;
      }

      // (1) Threshold gate — the spec §6.5.2 deterministic counter.
      // Below threshold → not enough operator-friction evidence to
      // justify the LLM cost. Advance cursor past this candidate's
      // first sighting (the new event was counted via countOverrides
      // InWindow; subsequent events accumulate in the window even
      // after the cursor moves).
      let overrideCount: number;
      try {
        overrideCount = countOverridesInWindow(
          deps.db,
          cand.scope,
          cand.name,
          thresholdWindowMs,
          nowFn(),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`memory: verify_override_threshold_check_failed: ${displayErr(msg)}\n`);
        // Transient failure — don't advance; next poll retries.
        continue;
      }
      if (overrideCount < thresholdCount) {
        // Under threshold. Advance past first sighting; the next
        // event for this memory re-emits in the next poll and the
        // threshold check re-runs against the (now potentially
        // larger) window count.
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // (2) Type / trust / state gate — defense in depth. The signal
      // collector already filtered when emitting the override event,
      // but the memory's state could have changed between signal-emit
      // and threshold-trip (e.g., operator manually quarantined the
      // memo). Re-check before paying LLM cost.
      const peek = deps.registry.peek(cand.name, { scope: cand.scope });
      if (peek.kind !== 'present') {
        if (peek.kind === 'malformed') {
          stderr(
            `memory: verify_override_peek_malformed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(peek.error)}\n`,
          );
        }
        advanceTo(advanceAt, advanceId);
        continue;
      }
      if (!isEligibleType.has(peek.file.frontmatter.type)) {
        advanceTo(advanceAt, advanceId);
        continue;
      }
      if (peek.file.frontmatter.trust === 'untrusted') {
        advanceTo(advanceAt, advanceId);
        continue;
      }
      const state = peek.file.frontmatter.state ?? 'active';
      if (state !== 'active') {
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // (3) Pending-proposal gate — skip when a quarantine proposal
      // is already in the operator queue for this memory. The apply
      // path's UNIQUE fingerprint index would dedup the new row, but
      // the LLM cost would be wasted. Same shape as verify-semantic.
      let pending: ReturnType<typeof listPendingProposalsForMemory>;
      try {
        pending = listPendingProposalsForMemory(deps.db, cand.scope, cand.name, 5);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`memory: verify_override_pending_check_failed: ${displayErr(msg)}\n`);
        // Transient — don't advance; next poll retries.
        continue;
      }
      if (pending.some((p) => p.kind === 'quarantine')) {
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // (4) Pull the override events the judge will see, bounded by
      // the SAME threshold window cutoff used by countOverridesInWindow
      // above. Pre-fix the fetch was unbounded ("10 most recent
      // regardless of age") and stale rows OUTSIDE the threshold
      // window leaked into the prompt + persisted proposal evidence,
      // letting the judge quarantine a memory based partly on
      // operator behavior the threshold gate had already discarded.
      // Symmetric cutoff = `nowFn() - thresholdWindowMs`.
      let overrideEvents: MemoryOverrideEventRow[];
      try {
        overrideEvents = listRecentOverridesForMemory(
          deps.db,
          cand.scope,
          cand.name,
          10,
          nowFn() - thresholdWindowMs,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`memory: verify_override_events_fetch_failed: ${displayErr(msg)}\n`);
        continue;
      }

      // (5) Dispatch.
      let outcome: Awaited<ReturnType<typeof dispatchOverrideVerify>>;
      try {
        outcome = await dispatchOverrideVerify({
          db: deps.db,
          definition: deps.definition,
          parentSessionId: deps.parentSessionId,
          cwd: deps.cwd,
          provider: deps.provider,
          parentToolRegistry: deps.parentToolRegistry,
          permissionEngine: deps.permissionEngine,
          memory: { scope: cand.scope, name: cand.name, file: peek.file },
          overrideEvents,
          registry: deps.registry,
          ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
          ...(deps.softStopSignal !== undefined ? { softStopSignal: deps.softStopSignal } : {}),
          ...(deps.cwdTrusted !== undefined ? { cwdTrusted: deps.cwdTrusted } : {}),
          ...(sharedScopeOffline ? { sharedScopeOffline: true } : {}),
          ...(deps.hooksSnapshot !== undefined ? { hooksSnapshot: deps.hooksSnapshot } : {}),
          ...(deps.effectiveCapabilities !== undefined
            ? { effectiveCapabilities: deps.effectiveCapabilities }
            : {}),
          ...(deps.spawnChildProcess !== undefined
            ? { spawnChildProcess: deps.spawnChildProcess }
            : {}),
          ...(deps.spawnSubagentFn !== undefined ? { spawnSubagentFn: deps.spawnSubagentFn } : {}),
          now: nowFn,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(
          `memory: verify_override_dispatch_failed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(msg)}\n`,
        );
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // Shutdown-during-await guard (mirror of S11 G6).
      if (stopped) return;

      if (outcome.kind === 'skipped') {
        // injection / dedup_hit / stale_snapshot / empty_events /
        // target_gone. Surface adversarial / drift / deletion paths
        // for operator visibility; dedup_hit + empty_events are
        // expected silent skips.
        if (
          outcome.reason === 'injection_detected' ||
          outcome.reason === 'stale_snapshot' ||
          outcome.reason === 'target_gone'
        ) {
          stderr(
            `memory: verify_override_skipped: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${outcome.reason}\n`,
          );
        }
        // G5 mirror: stale_snapshot does NOT advance — operator's
        // edit needs to land in a fresh poll's peek so the dispatcher
        // re-reads the latest body. target_gone DOES advance — the
        // memory file is gone, no future poll will recover it.
        if (outcome.reason !== 'stale_snapshot') {
          advanceTo(advanceAt, advanceId);
        }
        continue;
      }

      // completed / malformed / spawn_failed all consumed budget.
      counters.dispatched += 1;
      counters.costUsdSpent += outcome.costUsd;

      if (outcome.kind === 'malformed') {
        stderr(
          `memory: verify_override_malformed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(outcome.reason)}\n`,
        );
      } else if (outcome.kind === 'spawn_failed') {
        stderr(
          `memory: verify_override_spawn_failed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.name)}: ${displayErr(outcome.reason)}\n`,
        );
      }

      advanceTo(advanceAt, advanceId);
      // One real dispatch per poll. Subsequent candidates wait for
      // the next step boundary.
      return;
    }
  };

  const getCounters = (): OverrideVerifySchedulerCounters => ({
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
