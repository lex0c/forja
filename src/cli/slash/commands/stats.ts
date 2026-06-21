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

import { formatCostCell, isUnmetered } from '../../../providers/cost-format.ts';
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
    // Cache savings: the counterfactual cost with NO prompt cache. Sound
    // because caching changes the RATE, not the volume — the whole prefix is
    // re-sent every turn regardless; without a cache every input-side token
    // (non-cached input + cache read + cache write) bills at the full input
    // rate. So no-cache = (in+read+write) priced as input + the same output.
    // Compared against `bd.total` (the estimated actual) — both from the
    // current model's rates, so it's an apples-to-apples estimate. Output is
    // identical on both sides and cancels out of the delta.
    // `inputTotal` = every input-side token billed this session; shared with
    // the avgWindow calc below.
    const inputTotal = s.tokensIn + s.cacheRead + s.cacheCreation;
    const noCache = computeCostBreakdown(ctx.baseConfig.provider.capabilities, {
      input: inputTotal,
      output: s.tokensOut,
      cache_read: 0,
      cache_creation: 0,
    });
    const saved = noCache.total - bd.total;
    const savedPct = noCache.total > 0 ? Math.round((saved / noCache.total) * 100) : 0;
    // Per-turn economics. `turns` = billed provider calls (assistant rows); it
    // is the denominator that turns aggregate totals into the numbers an
    // operator can reason about and project. cache-read cost ≈ avg_window ×
    // turns, so without turns "cache read 67%" is unactionable.
    const turns = s.turns;
    // Average input prompt per turn: every turn re-sends the whole resident
    // window, billed as non-cached input + cache read + the freshly-written
    // prefix. (in + read + write) / turns ≈ avg window — the SAME denominator
    // as cacheHitRatio, so the two views stay consistent. This is the headline
    // diagnostic: near the compaction trigger ⇒ runs hot (trim); well below ⇒
    // the window cap is not the lever. Caveat: `inputTotal` folds in the
    // compaction calls' own tokens (the aggregator adds them) while `turns`
    // counts conversational turns only, so this errs slightly high when
    // compaction ran — negligible against the totals, and it never understates.
    const avgWindow = turns > 0 ? Math.round(inputTotal / turns) : 0;
    const ctxWindow = ctx.baseConfig.provider.capabilities.context_window;
    const windowPct = (tok: number): string =>
      ctxWindow > 0 ? ` (${Math.round((tok / ctxWindow) * 100)}% of ctx)` : '';
    // Reuse factor: cache reads per cache-write token. The intuitive companion
    // to write-amplification (its inverse-ish) — "each written token was read
    // back N times". 0 when nothing has been written yet.
    const reuse = s.cacheCreation > 0 ? s.cacheRead / s.cacheCreation : 0;
    // The current model may be unmetered (Ollama Cloud — billed by subscription, not
    // per token): its $0 is "untracked", not free. But computeUsageStats aggregates
    // EVERY repl session + subagent tree, so a current-unmetered provider does NOT mean
    // the whole scope is — earlier metered turns, a resumed session, or a metered
    // subagent persist real dollars in s.costUsd. Label only a PURE-unmetered scope; a
    // mixed one shows the tracked spend (a lower bound: the unmetered turns add untracked
    // cost on top) so real money is never hidden behind the label.
    const unmetered = isUnmetered(ctx.baseConfig.provider);
    const costStr =
      unmetered && s.costUsd > 0
        ? `${lb}${formatCost(s.costUsd)} + unmetered (current model untracked)`
        : formatCostCell(unmetered, s.usageComplete, formatCost, s.costUsd);
    const notes: string[] = [
      'session stats (this REPL, incl. subagents):',
      `  cost:   ${costStr}`,
      `  spend:  in ${formatCost(bd.inputCost)} (${pct(bd.inputCost)}%) · out ${formatCost(bd.outputCost)} (${pct(bd.outputCost)}%) · cache read ${formatCost(bd.cacheReadCost)} (${pct(bd.cacheReadCost)}%) · cache write ${formatCost(bd.cacheWriteCost)} (${pct(bd.cacheWriteCost)}%)`,
      // Cache savings vs the no-cache counterfactual (skipped for zero-rate
      // providers like local models, where there is nothing to save).
      ...(saved > 0
        ? [
            `  saved:  ${lb}${formatCost(saved)} (${savedPct}% vs no-cache est. ${formatCost(noCache.total)})`,
          ]
        : []),
      `  tokens: ${lb}${groupThousands(total)} (compute ${groupThousands(compute)} · cache ${groupThousands(cache)})`,
      `          in ${groupThousands(s.tokensIn)} · out ${groupThousands(s.tokensOut)} · cache read ${groupThousands(s.cacheRead)} · write ${groupThousands(s.cacheCreation)}`,
      `  cache:  ${hitPct}% hit · ${Math.round(cacheWriteAmplification(s) * 100)}% write amplification${reuse > 0 ? ` · ${reuse.toFixed(1)}x reuse` : ''}`,
      // Average resident window per turn, DB-derived from BILLED tokens — i.e.
      // what the provider actually received each turn, after the top-of-loop
      // compaction (loop.ts) caps it at the trigger. This is the trustworthy
      // "context pressure" gauge: it cannot exceed the window the way the raw
      // in-memory buffer can (e.g. a freshly-resumed session restores the full
      // history before the first turn compacts it). Expressed as a % of the
      // context window so it reads against the compaction trigger. `~` is
      // reserved project-wide for the lower-bound marker, so it rides only on
      // the `lb` prefix.
      ...(turns > 0
        ? [`  window: ${lb}${groupThousands(avgWindow)} tok/turn avg${windowPct(avgWindow)}`]
        : []),
      // Per-turn economics — the denominators that make the totals projectable.
      ...(turns > 0
        ? [
            `  turns:  ${groupThousands(turns)} · ${lb}${formatCost(s.costUsd / turns)}/turn · ${lb}${groupThousands(Math.round(s.tokensOut / turns))} tok out/turn`,
          ]
        : []),
      // Cache write split by source — find the culprit driving the expensive
      // axis. The parent bucket can't be sub-split by prompt section (the
      // provider doesn't attribute a write to a content block).
      `  writes: ${lb}${groupThousands(s.cacheCreation)} (parent ${groupThousands(s.cacheWriteParent)} · subagents ${groupThousands(s.cacheWriteSubagent)} · compaction ${groupThousands(s.cacheWriteCompaction)})`,
      // Compaction ROI: runs + context tokens freed. Pairs with the compaction
      // write cost above — reclaimed context is what that cost bought. `runs`
      // is exact (a row COUNT); `reclaimed` is a context ESTIMATE — it sums
      // `tokens_before - tokens_after`, both `estimatePromptTokens` (chars/4)
      // snapshots, NOT provider-billed counts — so it carries an `(est.)` mark
      // and a `ctx` qualifier to set it apart from the billed token lines.
      ...(s.compactionCount > 0
        ? [
            `  compact: ${groupThousands(s.compactionCount)} run${s.compactionCount === 1 ? '' : 's'} · reclaimed ${groupThousands(s.reclaimedTokens)} ctx tok (est.)`,
          ]
        : []),
      `  scope:  ${s.sessionCount} session${s.sessionCount === 1 ? '' : 's'}`,
      '  spend = est. from current model rates (tokens × rate); may differ from cost above',
    ];
    if (!s.usageComplete) {
      notes.push('  ~ = lower bound: some turns reported no token usage');
    }
    return { kind: 'ok', notes };
  },
};
