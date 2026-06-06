// /compact — compact the live session context now (CONTEXT_TUNING.md §12.4,
// project_message_single_source). The harness compacts automatically when
// the prompt crosses the threshold; /compact lets the operator trigger it
// early to free context. In-memory ONLY: the DB keeps the full log, so a
// `--resume` in a new process re-derives the full history and re-compacts.
//
// Operator-typed only — there is no model-facing equivalent. The model
// never decides to compact; the harness does it automatically and the
// operator can force it here.

import { effectiveBudget } from '../../../harness/types.ts';
import { computeCost } from '../../../providers/cost.ts';
import { formatPinnedBlock, getActivePinsBySession } from '../../../storage/repos/context-pins.ts';
import {
  getSession,
  markSessionUsageIncomplete,
  updateSessionCost,
} from '../../../storage/repos/sessions.ts';
import type { SlashCommand, SlashContext, SlashResult } from '../types.ts';

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Compact the live conversation now to free context (in-memory only)',
  async exec(_args: string[], ctx: SlashContext): Promise<SlashResult> {
    // Compaction rewrites the message array in place — refuse while a turn
    // is in flight, whose provider request would be mid-read on it.
    if (ctx.isRunning()) {
      return {
        kind: 'error',
        message: 'cannot /compact while a turn is running — wait for it to finish',
      };
    }
    const live = ctx.liveContext?.() ?? null;
    if (live === null) {
      return { kind: 'error', message: 'no live session to compact yet — run a turn first' };
    }

    const run = async (): Promise<SlashResult> => {
      const before = live.length;
      const budget = effectiveBudget(ctx.baseConfig.budget, ctx.baseConfig.effort);
      // Same pin block the auto-compaction injects, so /compact preserves
      // the active constraints identically (formatPinnedBlock is shared).
      const pinnedBlock = formatPinnedBlock(getActivePinsBySession(ctx.db, live.sessionId));
      // Defensive snapshot: compactMessages absorbs provider/stream errors
      // into a deterministic fallback and does NOT rethrow, so this restore
      // only fires on an unexpected throw (a future regression) — a cheap
      // rewind vs a corrupted single source of truth.
      const snap = live.snapshot();
      try {
        // Bracket the live "Compacting context…" chip around the summary call — the
        // same chip the auto path shows. Paired with the :end in `finally`.
        ctx.bus.emit({ type: 'compacting:start', ts: ctx.now() });
        const result = await live.compact(ctx.baseConfig.provider, {
          preserveTail: budget.compactionPreserveTail,
          // No turn in flight to abort against; a fresh, never-aborted
          // signal satisfies compactMessages' contract.
          signal: new AbortController().signal,
          ...(pinnedBlock !== undefined ? { pinnedBlock } : {}),
        });
        // The summary call is a billed provider request — fold its usage
        // into the session row + the REPL cumulative, exactly as the loop's
        // maybeCompact does. Otherwise /compact spends tokens that appear in
        // no cost total / audit and escape the maxCostUsd cap.
        const cost = computeCost(ctx.baseConfig.provider.capabilities, result.usage);
        if (cost > 0) {
          ctx.cumulative.costUsd += cost;
          const session = getSession(ctx.db, live.sessionId);
          if (session !== null) {
            updateSessionCost(ctx.db, live.sessionId, session.totalCostUsd + cost);
          }
        }
        // The summary call billed but its usage event never arrived (provider
        // failed before reporting) → the recorded spend is a lower bound. Mark
        // the session's usage incomplete, exactly as the loop's maybeCompact
        // does. Independent of cost: even a zero-usage fallback flips it.
        if (result.strategy !== 'skipped' && !result.usageSeen) {
          markSessionUsageIncomplete(ctx.db, live.sessionId);
        }
        if (result.strategy === 'skipped') {
          return {
            kind: 'ok',
            notes: ['Nothing to compact — the conversation is already small.'],
          };
        }
        return {
          kind: 'ok',
          notes: [
            `Compacted ${before} → ${live.length} messages (${result.foldedCount} folded). In-memory only — the DB log is unchanged; a fresh --resume re-derives it.`,
          ],
        };
      } catch (e) {
        live.restore(snap);
        return {
          kind: 'error',
          message: `compaction failed (context unchanged): ${e instanceof Error ? e.message : String(e)}`,
        };
      } finally {
        ctx.bus.emit({ type: 'compacting:end', ts: ctx.now() });
      }
    };

    // Run under the REPL busy lock so a follow-up turn (or a second
    // /compact) can't start during the summary call and race the in-place
    // rewrite. Absent in tests/headless (no concurrency) → run directly.
    return ctx.runExclusive ? ctx.runExclusive(run) : run();
  },
};
