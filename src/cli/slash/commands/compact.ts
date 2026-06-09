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
import { compactContextNow } from '../../compact-now.ts';
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
      // Delegate the mechanics (relevance pre-pass, LLM fold, cost accounting,
      // audit row, the bracketed "Compacting context…" chip) to the shared
      // helper — the same one the resume "from summary" path uses at boot.
      const budget = effectiveBudget(ctx.baseConfig.budget, ctx.baseConfig.effort);
      const result = await compactContextNow({
        ctx: live,
        provider: ctx.baseConfig.provider,
        budget,
        db: ctx.db,
        memoryRegistryPresent: ctx.baseConfig.memoryRegistry !== undefined,
        now: ctx.now,
        bus: ctx.bus,
        cumulative: ctx.cumulative,
        ...(signal !== undefined ? { signal } : {}),
        ...(ctx.refreshStats !== undefined ? { refreshStats: ctx.refreshStats } : {}),
      });
      if (result.kind === 'error') {
        return {
          kind: 'error',
          message: `compaction failed (context unchanged): ${result.message}`,
        };
      }
      if (result.kind === 'noop') {
        return {
          kind: 'ok',
          notes: ['Nothing to compact — the conversation is already small.'],
        };
      }
      const relevanceNote =
        result.relevanceElidedCount > 0
          ? ` Relevance pre-pass pointered ${result.relevanceElidedCount} tool_result(s) (${result.relevanceFreedBytes}B freed, recoverable via retrieve_context).`
          : '';
      return {
        kind: 'ok',
        notes: [
          `Compacted ${result.before} → ${result.after} messages (${result.foldedCount} folded).${relevanceNote} In-memory only — the DB log is unchanged; a fresh --resume re-derives it.`,
        ],
      };
    };

    // Run under the REPL busy lock so a follow-up turn (or a second
    // /compact) can't start during the summary call and race the in-place
    // rewrite. Absent in tests/headless (no concurrency) → run directly.
    return ctx.runExclusive ? ctx.runExclusive(run) : run();
  },
};
