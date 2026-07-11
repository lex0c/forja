// createConflictDetectorScheduler — step-boundary scheduler for the
// S13 LLM-judge conflict detector (MEMORY.md §11.x / T13.2).
//
// Mirror of createSemanticVerifyScheduler in shape but with the
// pair-judge wiring on top:
//
//   1. Poll memory_events since last cursor for action IN
//      ('created','edited') — the "just-written" memos that need
//      to be compared against their same-scope siblings.
//   2. For the first eligible just-written: list siblings in same
//      scope, BM25-prefilter to top-K (CONFLICT_PREFILTER_K), and
//      dispatch the conflict verify against the first sibling whose
//      pair isn't a dedup hit.
//   3. AT-MOST-ONE-DISPATCH-PER-POLL. The cursor advances PAST the
//      event only when the just-written produced NO dispatch (every
//      candidate pair was dedup-hit or pre-filter returned empty);
//      otherwise the cursor stays so the next poll revisits the
//      same event, the conflict-attempts cache dedups the pair just
//      dispatched, and the next-best sibling fires. The cumulative
//      cap (per-session caps below) bounds total LLM cost.
//
// Lifecycle / error posture mirrors S11: scheduler errors stderr-
// log as `memory: verify_conflict_*` and never throw out.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { HookSpec } from '../hooks/types.ts';
import type { PermissionEngine } from '../permissions/index.ts';
import type { Provider } from '../providers/index.ts';
import { createBM25Index, tokenize } from '../retrieval/bm25.ts';
import { sanitizeOneLineForDisplay } from '../sanitize/ansi.ts';
import type { DB } from '../storage/db.ts';
import { canonicalizePair } from '../storage/repos/memory-conflict-attempts.ts';
import { listPendingProposalsForMemory } from '../storage/repos/memory-governance.ts';
import { hashMemoryContent } from '../storage/repos/memory-provenance.ts';
import type { SubagentDefinition } from '../subagents/types.ts';
import type { ToolRegistry } from '../tools/index.ts';
import { serializeMemoryFile } from './frontmatter.ts';
import type { MemoryRegistry } from './registry.ts';
import type { MemoryScope } from './types.ts';
import { dispatchConflictVerify } from './verify-conflict-dispatcher.ts';
import {
  CONFLICT_PREFILTER_K,
  MEMORY_VERIFY_CONFLICT_MAX_COST_USD,
  MEMORY_VERIFY_CONFLICT_MAX_DISPATCHES_PER_SESSION,
  SEMANTIC_CONFLICT_ELIGIBLE_TYPES,
  SEMANTIC_CONFLICT_SUBAGENT_MAX_COST_USD,
} from './verify-conflict.ts';

// ─── shapes ───────────────────────────────────────────────────────────

const ERR_MAX_CHARS = 1024;
const displayErr = (s: string): string => sanitizeOneLineForDisplay(s, ERR_MAX_CHARS);

export interface ConflictDetectorSchedulerDeps {
  db: DB;
  registry: MemoryRegistry;
  definition: SubagentDefinition | undefined;
  memoryExcludeScopes?: ReadonlyArray<MemoryScope>;
  parentSessionId: string;
  cwd: string;
  provider: Provider;
  parentToolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  // Parent-runtime envelope forwarded to each dispatch (mirrors
  // verify-semantic-scheduler). See dispatcher comments for
  // per-field rationale.
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
  // Test seam — limit poll iteration.
  maxEventsPerPoll?: number;
  // Test seam — override caps.
  maxDispatchesPerSession?: number;
  maxCostUsd?: number;
  // Test seam — override stderr writer.
  stderr?: (line: string) => void;
  // Test seam — override BM25 prefilter cap.
  prefilterK?: number;
}

export type ConflictSchedulerCapExhausted = 'dispatch' | 'cost' | null;

export interface ConflictSchedulerCounters {
  dispatched: number;
  costUsdSpent: number;
  capExhausted: ConflictSchedulerCapExhausted;
  lastPolledAt: number;
}

export interface ConflictDetectorScheduler {
  poll: () => Promise<void>;
  getCounters: () => ConflictSchedulerCounters;
  shutdown: () => void;
}

// ─── helpers ──────────────────────────────────────────────────────────

interface MemoryEventCursor {
  id: string;
  scope: MemoryScope;
  memoryName: string;
  createdAt: number;
}

// Inline query: same posture as listSessionExposuresSince but for
// memory_events filtered by action set. Done inline (rather than
// adding to memory-events.ts) because this is the only S13-internal
// caller and the repo already has 5 list-by-something variants.
const listSessionWriteEventsSince = (
  db: DB,
  sessionId: string,
  sinceMs: number,
  sinceId: string,
  limit: number,
): MemoryEventCursor[] => {
  const rows = db
    .query<
      { id: string; scope: MemoryScope; memory_name: string; created_at: number },
      [string, number, number, string, number]
    >(
      `SELECT id, scope, memory_name, created_at
         FROM memory_events
        WHERE session_id = ?
          AND action IN ('created', 'edited')
          AND (created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(sessionId, sinceMs, sinceMs, sinceId, limit);
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    memoryName: r.memory_name,
    createdAt: r.created_at,
  }));
};

// Compute the mtime of a memory file. Best-effort: a fs error
// (file vanished between peek and stat) collapses to 0 — the
// resolver's recency tier treats 0 as "no real mtime" and the
// candidate loses recency but stays in the chain via scope /
// length / lexicographic tiebreaks.
const mtimeForMemory = (registry: MemoryRegistry, scope: MemoryScope, name: string): number => {
  const dir =
    scope === 'user'
      ? registry.roots.user
      : scope === 'project_shared'
        ? registry.roots.projectShared
        : registry.roots.projectLocal;
  try {
    return statSync(join(dir, `${name}.md`)).mtimeMs;
  } catch {
    return 0;
  }
};

// ─── factory ──────────────────────────────────────────────────────────

export const createConflictDetectorScheduler = (
  deps: ConflictDetectorSchedulerDeps,
): ConflictDetectorScheduler => {
  const nowFn = deps.now ?? (() => Date.now());
  const maxEvents = deps.maxEventsPerPoll ?? 50;
  const maxDispatches =
    deps.maxDispatchesPerSession ?? MEMORY_VERIFY_CONFLICT_MAX_DISPATCHES_PER_SESSION;
  const maxCost = deps.maxCostUsd ?? MEMORY_VERIFY_CONFLICT_MAX_COST_USD;
  const prefilterK = deps.prefilterK ?? CONFLICT_PREFILTER_K;
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(line));

  let stopped = false;
  // Cursor tuple — same (createdAt, id) tiebreaker pattern S11 uses,
  // so same-millisecond bursts don't drop events.
  let cursorAt = 0;
  let cursorId = '';
  const counters: ConflictSchedulerCounters = {
    dispatched: 0,
    costUsdSpent: 0,
    capExhausted: null,
    lastPolledAt: 0,
  };

  const isEligibleType: ReadonlySet<string> = new Set(SEMANTIC_CONFLICT_ELIGIBLE_TYPES);
  const excludedScopes: ReadonlySet<MemoryScope> = new Set(deps.memoryExcludeScopes ?? []);
  const sharedScopeOffline = excludedScopes.has('project_shared');

  const checkCaps = (): ConflictSchedulerCapExhausted => {
    if (counters.dispatched >= maxDispatches) return 'dispatch';
    if (counters.costUsdSpent >= maxCost) return 'cost';
    if (counters.costUsdSpent + SEMANTIC_CONFLICT_SUBAGENT_MAX_COST_USD > maxCost) return 'cost';
    return null;
  };

  // Pairs whose dispatch failed before reaching recordConflictAttempt
  // (malformed / spawn_failed paths in the dispatcher). The dedup
  // cache (memory_conflict_attempts) is NOT populated for those
  // outcomes, so the default "next poll re-considers the event and
  // dedup-skips the just-dispatched pair" logic would re-emit the
  // same failing pair on every poll until the session cap latches.
  // We track them in-memory + skip in the sibling loop to keep the
  // event live (so OTHER siblings can fire) without retrying the
  // known-bad pair. Bounded by maxDispatches (10 entries max);
  // resets on session end (in-process state only).
  const failedPairsThisSession = new Set<string>();
  const canonicalPairKey = (
    a: { scope: string; name: string },
    b: { scope: string; name: string },
  ): string => {
    const keyA = `${a.scope}/${a.name}`;
    const keyB = `${b.scope}/${b.name}`;
    return keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
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

    let events: MemoryEventCursor[];
    try {
      events = listSessionWriteEventsSince(
        deps.db,
        deps.parentSessionId,
        cursorAt,
        cursorId,
        maxEvents,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`memory: verify_conflict_poll_failed: ${displayErr(msg)}\n`);
      return;
    }

    // Dedupe events by (scope, name): if the same memo was written
    // multiple times in the window, evaluate it once (first sight).
    // Later sightings re-emit via the next poll if/when the cursor
    // advances past the first.
    const seen = new Set<string>();
    const candidates: MemoryEventCursor[] = [];
    for (const ev of events) {
      if (excludedScopes.has(ev.scope)) {
        advanceTo(ev.createdAt, ev.id);
        continue;
      }
      const key = `${ev.scope}/${ev.memoryName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(ev);
    }

    for (const cand of candidates) {
      if (stopped) return;
      const advanceAt = cand.createdAt;
      const advanceId = cand.id;

      const cap = checkCaps();
      if (cap !== null) {
        counters.capExhausted = cap;
        stderr(
          `memory: verify_conflict_budget_exhausted: ${cap === 'dispatch' ? `dispatch cap reached (${counters.dispatched}/${maxDispatches})` : `cost cap reached ($${counters.costUsdSpent.toFixed(4)} / $${maxCost.toFixed(2)})`}\n`,
        );
        return;
      }

      // Peek the just-written memo. Type / trust / state gates
      // mirror verify-semantic-scheduler.
      const peek = deps.registry.peek(cand.memoryName, { scope: cand.scope });
      if (peek.kind !== 'present') {
        if (peek.kind === 'malformed') {
          stderr(
            `memory: verify_conflict_peek_malformed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.memoryName)}: ${displayErr(peek.error)}\n`,
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
      const writtenState = peek.file.frontmatter.state ?? 'active';
      if (writtenState !== 'active') {
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // List siblings IN THE SAME SCOPE. Intra-scope only — pairing
      // across scopes would conflate "user-global preference" with
      // "project-local fact" which the resolver's scope-specificity
      // tier explicitly handles by ranking; the detector stays
      // within one scope to keep the pair-judge prompt bounded.
      // deduplicateByName=false so a name that shadows across scopes
      // doesn't hide siblings in the OTHER scopes from THIS scope's
      // listing (it doesn't, since list-by-scope returns one scope,
      // but the flag is explicit).
      // states: ['active'] (NOT quarantined) — a quarantined sibling
      // is already flagged for operator review, pairing it as a
      // "winner" candidate would produce a quarantine proposal
      // against an active memory based on a quarantined memo's
      // higher-tier provenance. The semantic is incoherent: the
      // quarantined sibling is the one whose evidence is suspect.
      // Active-only keeps the resolver's tier chain semantically
      // sound. (S13 review MED-2.)
      const siblings = deps.registry.list({
        deduplicateByName: false,
        states: ['active'],
        includeExpired: false,
      });
      const sameScopeOtherSiblings = siblings.filter(
        (s) =>
          s.scope === cand.scope &&
          s.name !== cand.memoryName &&
          s.file !== undefined &&
          isEligibleType.has(s.file.frontmatter.type) &&
          s.file.frontmatter.trust !== 'untrusted',
      );
      if (sameScopeOtherSiblings.length === 0) {
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // Pre-dispatch pending-proposal gate (mirror S11 verify-
      // semantic-scheduler:341-358). If a quarantine proposal is
      // already pending for the just-written memo, skip the entire
      // event — every pair-judge run against it would either dedup
      // via fingerprint (silent collapse) or, worse, re-pay LLM
      // cost on every step boundary because `conflicting` verdicts
      // bypass the dedup cache. Without this gate the cost cap was
      // the only floor on the loop.
      let pendingForWritten: ReturnType<typeof listPendingProposalsForMemory>;
      try {
        pendingForWritten = listPendingProposalsForMemory(deps.db, cand.scope, cand.memoryName, 5);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr(`memory: verify_conflict_pending_check_failed: ${displayErr(msg)}\n`);
        // Don't advance — next poll retries. Lookup failure is
        // transient; advancing would lose the candidate permanently.
        continue;
      }
      if (pendingForWritten.some((p) => p.kind === 'quarantine')) {
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // BM25 prefilter. Build the corpus from sibling bodies, score
      // against the just-written body, take topK. Bodies are already
      // loaded (list() with `states` filter peeks them for state
      // resolution and surfaces the file on listing.file).
      const writtenTokens = tokenize(peek.file.body);
      const corpus = sameScopeOtherSiblings
        .filter((s) => s.file !== undefined)
        .map((s) => ({
          id: s.name,
          // Body presence enforced by the filter above; assert narrowing
          // for TS without the noNonNullAssertion lint trip.
          tokens: tokenize((s.file as { body: string }).body),
        }));
      const bm25 = createBM25Index(corpus);
      const hits = bm25.topK(peek.file.body, prefilterK);
      if (hits.length === 0 && writtenTokens.length > 0) {
        // Zero overlap with any sibling — implausibly rare for the
        // pair-judge to find a conflict here. Advance cursor.
        advanceTo(advanceAt, advanceId);
        continue;
      }

      // For each topK sibling, dispatch the FIRST one whose pair
      // isn't a dedup-hit. The dispatcher itself does the
      // lookupRecentConflictAttempt check; we just iterate and bail
      // on the first 'completed' / 'malformed' / 'spawn_failed' /
      // injection_detected / stale_snapshot outcome. dedup_hit
      // moves on to the next sibling.
      let dispatchedThisPoll = false;
      // Mirror G5 from S11: if any sibling dispatch returns
      // stale_snapshot, the just-written body drifted between the
      // scheduler peek and the dispatcher re-peek. Advancing the
      // cursor past this event would lose the fresh body forever
      // (next poll wouldn't see this event again, so the operator's
      // edit never reaches the pair-judge). Track + skip advance.
      let staleSeen = false;
      for (const hit of hits) {
        if (stopped) return;
        const sibling = sameScopeOtherSiblings.find((s) => s.name === hit.id);
        if (sibling === undefined || sibling.file === undefined) continue;
        // Per-sibling pending-proposal gate. If a pending
        // quarantine already targets the sibling (from another
        // pair-judge run, OR from the verify-semantic detector,
        // OR from operator-driven path), skip THIS sibling — its
        // outcome is already in the operator's queue. Move on
        // to the next top-K hit.
        let pendingForSibling: ReturnType<typeof listPendingProposalsForMemory>;
        try {
          pendingForSibling = listPendingProposalsForMemory(
            deps.db,
            sibling.scope,
            sibling.name,
            5,
          );
        } catch {
          // Skip this sibling defensively; the overall poll proceeds.
          continue;
        }
        if (pendingForSibling.some((p) => p.kind === 'quarantine')) continue;
        // In-session blacklist: skip pairs whose dispatch already
        // failed pre-attempt-row (malformed / spawn_failed). Pre-
        // fix, those pairs re-emitted every poll until cap latched.
        const pairKey = canonicalPairKey(
          { scope: cand.scope, name: cand.memoryName },
          { scope: sibling.scope, name: sibling.name },
        );
        if (failedPairsThisSession.has(pairKey)) continue;
        const writtenMtime = mtimeForMemory(deps.registry, cand.scope, cand.memoryName);
        const siblingMtime = mtimeForMemory(deps.registry, sibling.scope, sibling.name);
        let outcome: Awaited<ReturnType<typeof dispatchConflictVerify>>;
        try {
          outcome = await dispatchConflictVerify({
            db: deps.db,
            definition: deps.definition,
            parentSessionId: deps.parentSessionId,
            cwd: deps.cwd,
            provider: deps.provider,
            parentToolRegistry: deps.parentToolRegistry,
            permissionEngine: deps.permissionEngine,
            pair: {
              a: {
                scope: cand.scope,
                name: cand.memoryName,
                file: peek.file,
                source: peek.file.frontmatter.source,
                mtimeMs: writtenMtime,
              },
              b: {
                scope: sibling.scope,
                name: sibling.name,
                file: sibling.file,
                source: sibling.file.frontmatter.source,
                mtimeMs: siblingMtime,
              },
            },
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
            ...(deps.spawnSubagentFn !== undefined
              ? { spawnSubagentFn: deps.spawnSubagentFn }
              : {}),
            now: nowFn,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          stderr(
            `memory: verify_conflict_dispatch_failed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.memoryName)} vs ${sanitizeOneLineForDisplay(sibling.name)}: ${displayErr(msg)}\n`,
          );
          continue; // try next sibling
        }

        // Post-await guard against shutdown (mirror G6 from S11).
        if (stopped) return;

        if (outcome.kind === 'skipped') {
          if (outcome.reason === 'dedup_hit') continue; // try next sibling
          if (
            outcome.reason === 'injection_detected' ||
            outcome.reason === 'stale_snapshot' ||
            outcome.reason === 'target_gone'
          ) {
            stderr(
              `memory: verify_conflict_skipped: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.memoryName)} vs ${sanitizeOneLineForDisplay(sibling.name)}: ${outcome.reason}\n`,
            );
            if (outcome.reason === 'stale_snapshot') {
              // Just-written drifted; the next poll re-evaluates
              // against the fresh body. Don't advance cursor past
              // this event below.
              staleSeen = true;
            }
            // Injection / stale_snapshot / target_gone for this
            // pair shouldn't block dispatch against OTHER siblings
            // — those are independent bodies. Continue to the next
            // sibling. (target_gone implies one of the pair members
            // disappeared between scheduler peek and dispatch; the
            // upstream sibling gate on subsequent polls will exclude
            // the absent memo before re-invocation.)
            continue;
          }
          continue;
        }

        if (outcome.kind === 'spawn_failed') {
          stderr(
            `memory: verify_conflict_spawn_failed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.memoryName)} vs ${sanitizeOneLineForDisplay(sibling.name)}: ${displayErr(outcome.reason)}\n`,
          );
          counters.costUsdSpent += outcome.costUsd;
          counters.dispatched += 1;
          dispatchedThisPoll = true;
          // No memory_conflict_attempts row was written (dispatcher
          // returns spawn_failed before recordConflictAttempt).
          // Blacklist the pair in-session so next poll skips it
          // instead of looping into the same failing dispatch.
          failedPairsThisSession.add(pairKey);
          break;
        }

        if (outcome.kind === 'malformed') {
          stderr(
            `memory: verify_conflict_malformed: ${sanitizeOneLineForDisplay(cand.scope)}/${sanitizeOneLineForDisplay(cand.memoryName)} vs ${sanitizeOneLineForDisplay(sibling.name)}: ${displayErr(outcome.reason)}\n`,
          );
          counters.costUsdSpent += outcome.costUsd;
          counters.dispatched += 1;
          dispatchedThisPoll = true;
          // Same posture as spawn_failed above — dispatcher returns
          // before recordConflictAttempt, so no dedup row exists.
          failedPairsThisSession.add(pairKey);
          break;
        }

        // completed
        counters.costUsdSpent += outcome.costUsd;
        counters.dispatched += 1;
        dispatchedThisPoll = true;
        break;
      }

      if (!dispatchedThisPoll) {
        // Every topK sibling pair was a dedup-hit (or filtered out).
        // G5 guard: if any pair came back stale_snapshot, the
        // just-written body drifted — do NOT advance cursor, the
        // next poll re-evaluates against the fresh body. Otherwise
        // advance.
        if (!staleSeen) {
          advanceTo(advanceAt, advanceId);
        }
        continue;
      }

      // We dispatched a pair for this event. Keep cursor stationary
      // so the next poll re-considers this event; the dedup cache
      // skips the just-dispatched pair, and the next-best sibling
      // fires. Bail from the poll — one dispatch per poll bound.
      return;
    }
  };

  return {
    poll,
    getCounters: () => ({ ...counters }),
    shutdown: () => {
      stopped = true;
    },
  };
};

// Re-export for callers that want the canonical form helper without
// reaching into the storage repo.
export { canonicalizePair, hashMemoryContent, serializeMemoryFile };
