// Auto-display helper for the recap surfaces declared in
// RECAP.md §3.3: session-end terse line and the Alt+R keybind.
// Both surfaces share the same shape — project the recap of a
// single session, render `terse` deterministically, write the
// result to `recap_cache` (pre-warm for any subsequent /recap),
// and record the run in `recap_runs` for audit.
//
// Intentional shape:
//   - **Pure deterministic.** No LLM. The keybind/end-of-session
//     surfaces fire frequently; spec §3.3 mandates determinism so
//     they're free, instant, and byte-stable. LLM render stays
//     reachable only via explicit `/recap terse` (no
//     `--no-llm-render`).
//   - **Failure-tolerant.** Operator MUST get their session-end
//     footer / their next prompt regardless of recap state. Any
//     thrown exception (DB lock, malformed message rows, brand-
//     new session with zero turns) yields `{ ok: false, reason }`
//     so the caller can choose to log a diagnostic without
//     blocking the path.
//   - **Cache-aware.** A hit returns the cached output verbatim
//     and records `cacheHit: true` in audit. A miss renders fresh
//     and writes the result.
//   - **Side effects bounded.** This module reads + writes
//     `recap_cache` and INSERTs into `recap_runs`. It does NOT
//     emit bus events or harness events — that's the caller's
//     job (the harness emits `recap_terse_ready`; the REPL
//     emits `info` on the bus). Keeps this helper testable with
//     a bare DB.

import type { DB } from '../storage/db.ts';
import {
  canonicalScopeHash,
  readRecapCache,
  writeRecapCache,
} from '../storage/repos/recap-cache.ts';
import { recordRecapRun } from '../storage/repos/recap-runs.ts';
import type { RenderOptions } from './format.ts';
import { projectRecap } from './projection.ts';
import { renderTerseDeterministic } from './terse/index.ts';

// Stable identifier for the deterministic terse path. Never
// collides with the LLM `terse-v1` prompt id (terse/llm.ts uses
// `TERSE_PROMPT_VERSION` for that). The cache lookup keys on
// (scopeKind, sessionIds, renderer, promptVersion, intermediate)
// — using a distinct version here means a deterministic-rendered
// row never gets served to an LLM-render request and vice versa.
export const TERSE_DETERMINISTIC_VERSION = 'terse-deterministic-v1' as const;

export interface BuildAutoTerseInput {
  db: DB;
  sessionId: string;
  // Wall-clock injected so tests can pin generatedAt / created_at
  // and `recap_runs.created_at` is reproducible.
  now: number;
  // Forwarded to the renderer for $HOME anonymization. Caller
  // typically passes nothing in TUI (defaults are fine);
  // headless callers can pin a fixture-relative home for tests.
  renderOptions?: RenderOptions;
}

export type BuildAutoTerseResult =
  | {
      ok: true;
      markdown: string;
      cacheHit: boolean;
    }
  | {
      ok: false;
      // String reason for diagnostic surfacing — caller decides
      // whether to log it (harness loop swallows; REPL surfaces
      // as a `warn`). Bound to be non-empty.
      reason: string;
    };

// Builds the terse markdown for `sessionId`, hitting the cache
// when fresh and writing through on miss. Records a `recap_runs`
// row regardless of cache hit/miss (audit trails the surface,
// not just the work). All failures collapse to
// `{ ok: false, reason }`.
export const buildAutoTerse = (input: BuildAutoTerseInput): BuildAutoTerseResult => {
  const { db, sessionId, now } = input;
  try {
    const intermediate = projectRecap(db, {
      scope: { kind: 'session_specific', sessionId },
      now,
    });
    const scopeHash = canonicalScopeHash({
      scopeKind: intermediate.scope.kind,
      sessionIds: intermediate.scope.sessionIds,
      renderer: 'terse',
      promptVersion: TERSE_DETERMINISTIC_VERSION,
      intermediate,
    });

    const cached = readRecapCache(db, { scopeHash, now });
    if (cached !== null) {
      // Cache hit: skip render entirely. Audit row distinguishes
      // hit from miss so observability tooling (`recap_runs`)
      // can compute the hit ratio per surface over time.
      try {
        recordRecapRun(db, {
          scopeKind: intermediate.scope.kind,
          sessionIds: intermediate.scope.sessionIds,
          renderer: 'terse',
          usedLlm: false,
          createdAt: now,
          promptVersion: null,
          cacheHit: true,
        });
      } catch {
        // Audit-write failure must not break the surface; the
        // operator still gets their terse line. Swallow.
      }
      return { ok: true, markdown: cached.output, cacheHit: true };
    }

    // Miss: render fresh, write through to cache, then audit.
    const markdown = renderTerseDeterministic(intermediate, input.renderOptions ?? {});

    try {
      writeRecapCache(db, {
        scopeHash,
        renderer: 'terse',
        output: markdown,
        promptVersion: TERSE_DETERMINISTIC_VERSION,
        generatedAt: now,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      });
    } catch {
      // Same posture as audit: a cache write fail must not steal
      // the markdown from the operator. Skip the write; the next
      // call will re-render fresh.
    }

    try {
      recordRecapRun(db, {
        scopeKind: intermediate.scope.kind,
        sessionIds: intermediate.scope.sessionIds,
        renderer: 'terse',
        usedLlm: false,
        createdAt: now,
        promptVersion: null,
        cacheHit: false,
      });
    } catch {
      // ignore — see above.
    }

    return { ok: true, markdown, cacheHit: false };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, reason };
  }
};
