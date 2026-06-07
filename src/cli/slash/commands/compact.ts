// /compact — compact the live session context now (CONTEXT_TUNING.md §12.4,
// project_message_single_source). The harness compacts automatically when
// the prompt crosses the threshold; /compact lets the operator trigger it
// early to free context. In-memory ONLY: the DB keeps the full log, so a
// `--resume` in a new process re-derives the full history and re-compacts.
//
// Operator-typed only — there is no model-facing equivalent. The model
// never decides to compact; the harness does it automatically and the
// operator can force it here.

import type { RelevanceElideResult } from '../../../harness/compaction-relevance.ts';
import {
  accountCompaction,
  compactionTriggerTokens,
  hashContext,
  recordCompactionEvent,
  relevanceVerbatimBudgetBytes,
} from '../../../harness/compaction.ts';
import { effectiveBudget } from '../../../harness/types.ts';
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

    const run = async (signal?: AbortSignal): Promise<SlashResult> => {
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
      // Bound the summary call. Without this a stalled provider / hung network
      // hangs `await live.compact` forever while runExclusive holds the REPL
      // busy — no timeout, no interrupt. Time out at the step-stall budget, and
      // compose the operator's interrupt signal (from runExclusive) so Ctrl+C
      // aborts it too. compactMessages turns either abort into its deterministic
      // fallback, so the run survives and the REPL frees.
      const timeout = AbortSignal.timeout(budget.maxStepStallMs);
      const compactSignal = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        // Bracket the live "Compacting context…" chip around the summary call —
        // the same chip the auto path shows. Paired with the :end in `finally`.
        ctx.bus.emit({ type: 'compacting:start', ts: ctx.now() });
        // Pre-compaction context hash for the audit row (computed before the
        // relevance pre-pass mutates the array).
        const beforeHash = hashContext(live.getMessages());
        // Relevance pre-pass for parity with the auto path: when enabled,
        // pointer-elide low-goal-relevance tool_result bodies first so the
        // forced LLM fold below summarizes a lighter, gated history. Unlike
        // the loop, /compact always proceeds to the fold — the operator
        // forced it; there is no token threshold to short-circuit on. The
        // snapshot above predates this, so a failure rewinds both.
        let relevanceElided: RelevanceElideResult | null = null;
        if (budget.compactionRelevance === true) {
          const triggerAt = compactionTriggerTokens(
            budget.compactionThreshold,
            ctx.baseConfig.provider.capabilities.context_window,
          );
          relevanceElided = live.relevanceElide({
            verbatimBudgetBytes: relevanceVerbatimBudgetBytes(triggerAt),
            preserveTail: budget.compactionPreserveTail,
          });
        }
        const result = await live.compact(ctx.baseConfig.provider, {
          preserveTail: budget.compactionPreserveTail,
          signal: compactSignal,
          ...(pinnedBlock !== undefined ? { pinnedBlock } : {}),
        });
        // Apply the compaction's accounting — the SHARED decision (cost +
        // whether usage is a lower bound) that the loop's maybeCompact
        // applies too. Fold cost into the session row + the REPL cumulative
        // (else the spend escapes /cost, audit, and the maxCostUsd cap), and
        // downgrade usage_complete when it billed without reporting usage
        // (independent of cost — even a zero-usage fallback flips it).
        const acct = accountCompaction(result, ctx.baseConfig.provider.capabilities);
        if (acct.costUsd > 0) {
          ctx.cumulative.costUsd += acct.costUsd;
          const session = getSession(ctx.db, live.sessionId);
          if (session !== null) {
            updateSessionCost(ctx.db, live.sessionId, session.totalCostUsd + acct.costUsd);
          }
        }
        if (acct.usageIncomplete) {
          markSessionUsageIncomplete(ctx.db, live.sessionId);
        }
        // Audit row (compaction_events) for parity with the auto path. tokens
        // omitted — a forced /compact has no trigger count. The shared recorder
        // hashes afterHash, skips a no-op 'skipped', and logs (not swallows) a
        // persist failure.
        recordCompactionEvent(ctx.db, {
          sessionId: live.sessionId,
          beforeHash,
          messagesAfter: live.getMessages(),
          strategy: result.strategy,
          foldedCount: result.foldedCount,
          ...(relevanceElided !== null && relevanceElided.elidedCount > 0
            ? { freedBytes: relevanceElided.freedBytes, elidedIds: relevanceElided.elidedIds }
            : {}),
          ...(result.summary !== undefined ? { summary: result.summary } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          recordedAt: ctx.now(),
        });
        const relevanceNote =
          relevanceElided !== null && relevanceElided.elidedCount > 0
            ? ` Relevance pre-pass pointered ${relevanceElided.elidedCount} tool_result(s) (${relevanceElided.freedBytes}B freed, recoverable via retrieve_context).`
            : '';
        if (result.strategy === 'skipped' && relevanceNote === '') {
          return {
            kind: 'ok',
            notes: ['Nothing to compact — the conversation is already small.'],
          };
        }
        return {
          kind: 'ok',
          notes: [
            `Compacted ${before} → ${live.length} messages (${result.foldedCount} folded).${relevanceNote} In-memory only — the DB log is unchanged; a fresh --resume re-derives it.`,
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
