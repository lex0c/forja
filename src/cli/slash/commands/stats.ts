// /stats — cost + token/cache totals for this REPL session.
//
// Unlike /cost (which reads the REPL's in-memory `cumulative` running
// total), /stats derives everything from the DB via `computeUsageStats`.
// That makes it:
//   - subagent-complete: the tree walk includes `task_*` child sessions
//     that the in-memory total drops (it sums parent-self cost only);
//   - resume-correct: a resumed REPL reopens the same session row, so
//     the lifetime cost/tokens are already on disk — no seeding.
//
// Scope is `replSessionIds()`: the growing session row plus any
// playbook-dispatch sessions, each walked down its subagent tree.
//
// `usage_complete = 0` anywhere in scope means the provider skipped a
// usage report on some turn, so the totals are a lower bound — marked
// with a leading `~` and an explanatory footnote.

import { computeCostBreakdown } from '../../../providers/cost.ts';
import {
  cacheHitRatio,
  cacheWriteAmplification,
  computeUsageStats,
} from '../../../storage/index.ts';
import { formatCost } from '../format.ts';
import type { SlashCommand } from '../types.ts';

// Group an integer with thousands separators, locale-independently so
// the output is deterministic across environments (and in tests).
const groupThousands = (n: number): string => {
  const sign = n < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(n)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

export const statsCommand: SlashCommand = {
  name: 'stats',
  description: 'show cost + token/cache totals for this REPL session (incl. subagents)',
  exec: async (args, ctx) => {
    if (args.length > 0) {
      return { kind: 'error', message: '/stats: takes no arguments' };
    }
    const ids = ctx.replSessionIds();
    if (ids.length === 0) {
      return { kind: 'ok', notes: ['no sessions yet — run a turn first'] };
    }
    const s = computeUsageStats(ctx.db, ids);
    // The footer splits tokens the same way: compute = input + output,
    // cache = read + creation. Keep the split here so the two surfaces
    // read consistently.
    const compute = s.tokensIn + s.tokensOut;
    const cache = s.cacheRead + s.cacheCreation;
    const total = compute + cache;
    // Lower-bound marker when any turn in scope reported no usage.
    const lb = s.usageComplete ? '' : '~';
    // Cache effectiveness: cache reads over all input tokens (see
    // cacheHitRatio). A higher % = more of the prompt prefix is being served
    // from cache instead of reprocessed at full input cost.
    const hitPct = Math.round(cacheHitRatio(s) * 100);
    // Cost by axis — WHERE the money went. Cache write is the expensive axis,
    // so a session with a high token hit-ratio can still be cache-write-cost-
    // dominated; this surfaces that. Estimated from the CURRENT model's rates
    // applied to the aggregated tokens, so it may diverge from the persisted
    // total above (rate snapshot drift, or subagents on a different model).
    const bd = computeCostBreakdown(ctx.baseConfig.provider.capabilities, {
      input: s.tokensIn,
      output: s.tokensOut,
      cache_read: s.cacheRead,
      cache_creation: s.cacheCreation,
    });
    const pct = (part: number): number =>
      bd.total === 0 ? 0 : Math.round((part / bd.total) * 100);
    const notes: string[] = [
      'session stats (this REPL, incl. subagents):',
      `  cost:   ${lb}${formatCost(s.costUsd)}`,
      `  spend:  in ${formatCost(bd.inputCost)} (${pct(bd.inputCost)}%) · out ${formatCost(bd.outputCost)} (${pct(bd.outputCost)}%) · cache read ${formatCost(bd.cacheReadCost)} (${pct(bd.cacheReadCost)}%) · cache write ${formatCost(bd.cacheWriteCost)} (${pct(bd.cacheWriteCost)}%)`,
      `  tokens: ${lb}${groupThousands(total)} (compute ${groupThousands(compute)} · cache ${groupThousands(cache)})`,
      `          in ${groupThousands(s.tokensIn)} · out ${groupThousands(s.tokensOut)} · cache read ${groupThousands(s.cacheRead)} · write ${groupThousands(s.cacheCreation)}`,
      `  cache:  ${hitPct}% hit · ${Math.round(cacheWriteAmplification(s) * 100)}% write amplification`,
      // Cache write split by source — find the culprit driving the expensive
      // axis. The parent bucket can't be sub-split by prompt section (the
      // provider doesn't attribute a write to a content block).
      `  writes: ${lb}${groupThousands(s.cacheCreation)} (parent ${groupThousands(s.cacheWriteParent)} · subagents ${groupThousands(s.cacheWriteSubagent)} · compaction ${groupThousands(s.cacheWriteCompaction)})`,
      `  scope:  ${s.sessionCount} session${s.sessionCount === 1 ? '' : 's'}`,
      '  spend = est. from current model rates (tokens × rate); may differ from cost above',
    ];
    if (!s.usageComplete) {
      notes.push('  ~ = lower bound: some turns reported no token usage');
    }
    return { kind: 'ok', notes };
  },
};
