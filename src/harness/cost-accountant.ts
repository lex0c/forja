// Cost/budget accountant extracted from the harness loop's runAgent (N2 —
// reduce the god-object). The run's cost accounting used to be ~8 shared mutable
// `let`s (per-run totals, prior-run cumulative, child cost, the soft-cap latch)
// plus two closures (`emitCostUpdate`, `costCapDetailIfExceeded`) threaded
// through the ~4400-line closure. This class OWNS that state and exposes the
// write seam the loop already used — `recordUsage` / `markUsageIncomplete` /
// `emitCostUpdate` / `costCapDetail` were the exact callbacks runAgent already
// injected into `synthesizeOnExhaustion`, so this formalizes an implicit seam
// rather than inventing one. Behavior is preserved verbatim; the harness /
// outcomes suites that exercise cost (usage_persisted, cost_update, maxCostUsd,
// resume cost seeding, subagent child cost) are the net, plus this module's own
// unit tests.
import { addUsage, emptyUsage } from '../providers/cost.ts';
import type { UsageInfo } from '../providers/types.ts';
import type { DB } from '../storage/db.ts';
import { updateSessionCost } from '../storage/repos/sessions.ts';
import { safeEmit } from './emit.ts';
import type { HarnessConfig } from './types.ts';

// Deps the accountant needs but which runAgent resolves lazily: `sessionId` is
// assigned during init (AFTER the accountant is constructed, so the resume seed
// can land on it) and the subagent handle store is built later still. Passing
// getters keeps the accountant constructible up front while the live values
// arrive later.
export interface CostAccountantDeps {
  db: DB;
  onEvent: HarnessConfig['onEvent'];
  // Live session id ('' before createSession lands). Read at emit time so the
  // persist writeback targets the right row.
  getSessionId: () => string;
  // Hard cost cap (spec ORCHESTRATION.md §3.5); undefined = uncapped.
  maxCostUsd: number | undefined;
  // Soft warn threshold (§3.5.0); undefined / non-positive = no warn.
  softCostUsd: number | undefined;
  // In-flight async child reservations from the handle store, optionally
  // excluding one handle when the store is mid-dispatch of it. Returns 0 before
  // the store exists.
  getReservedChildCostUsd: (excludeHandleId?: string) => number;
}

export class CostAccountant {
  // Per-run totals (THIS run only). HarnessResult.usage / costUsd report these,
  // so they must stay self-consistent (zero usage ⇒ zero cost).
  #runUsage: UsageInfo = emptyUsage();
  #runCostUsd = 0;
  // Stays true until a provider turn produces output without an accompanying
  // usage event — then the aggregate is a lower bound, not a measurement.
  #runUsageComplete = true;
  // Cumulative-from-prior-runs (parent self only), round-tripped through
  // sessions.totalCostUsd. Held SEPARATELY from the per-run totals so the result
  // stays per-run while the persisted column stays cumulative.
  #priorCostUsd = 0;
  #priorUsageComplete = true;
  // Settled child cost inherited from prior runs of a resumed session. Summed
  // into the budget gate but NEVER persisted (each child already persisted its
  // own row) — folding it into priorCostUsd would double-persist per resume,
  // inflating sessions.totalCostUsd by the settled-children sum each cycle.
  #rehydratedChildCostUsd = 0;
  // Cumulative child cost accrued THIS run (sync `task` + async `task_async`).
  #cumulativeChildCostUsd = 0;
  // Sticky: set once when the soft cap is first crossed, never reset — so the
  // warn fires at most once per run instead of on every subsequent cost_update.
  #softCapWarned = false;

  readonly #deps: CostAccountantDeps;

  constructor(deps: CostAccountantDeps) {
    this.#deps = deps;
  }

  // --- reads (for the finish snapshot, the subagent gate, the child-inclusive
  // cost_update, and telemetry) ---
  get runUsage(): UsageInfo {
    return this.#runUsage;
  }
  get runCostUsd(): number {
    return this.#runCostUsd;
  }
  get runUsageComplete(): boolean {
    return this.#runUsageComplete;
  }
  get priorCostUsd(): number {
    return this.#priorCostUsd;
  }
  get priorUsageComplete(): boolean {
    return this.#priorUsageComplete;
  }
  get cumulativeChildCostUsd(): number {
    return this.#cumulativeChildCostUsd;
  }
  get rehydratedChildCostUsd(): number {
    return this.#rehydratedChildCostUsd;
  }

  // Cumulative spend the budget gate compares against maxCostUsd: parent self
  // (prior + this run) + children (this run's settled + prior runs' settled) +
  // the caller-supplied in-flight reservation. Single projection so the
  // turn-end cap check and the pre-spawn gate stay coherent.
  cumulativeSpend(reserved: number): number {
    return (
      this.#priorCostUsd +
      this.#runCostUsd +
      this.#cumulativeChildCostUsd +
      this.#rehydratedChildCostUsd +
      reserved
    );
  }

  // --- writes ---
  // Seed prior-run cumulative totals from the resumed session row. Called once
  // during resume init, before any turn is charged.
  seedFromResume(priorCostUsd: number, priorUsageComplete: boolean): void {
    this.#priorCostUsd = priorCostUsd;
    this.#priorUsageComplete = priorUsageComplete;
  }

  // Set the settled-child cost inherited from prior runs (read from the handle
  // store once, after it rehydrates on resume).
  setRehydratedChildCost(costUsd: number): void {
    this.#rehydratedChildCostUsd = costUsd;
  }

  // Accrue a settled child's cost against this run. NaN-guarded: a misbehaving
  // child that emits a non-finite costUsd must not poison the counter and trip
  // every later budget gate.
  addChildCost(costUsd: number): void {
    if (Number.isFinite(costUsd)) this.#cumulativeChildCostUsd += costUsd;
  }

  // Accumulate one measured provider turn: its usage and its computed cost.
  // `usageSeen === false` marks the aggregate as a lower bound (a turn the
  // provider accepted but never emitted a usage event for). Does NOT emit —
  // callers emit `cost_update` explicitly at the post-persist ordering point.
  recordUsage(usage: UsageInfo, costUsd: number, usageSeen: boolean): void {
    this.#runUsage = addUsage(this.#runUsage, usage);
    this.#runCostUsd += costUsd;
    if (!usageSeen) this.#runUsageComplete = false;
  }

  // Mark the run's aggregate usage incomplete without accruing a charge (a turn
  // that threw after the provider was already billed for input tokens).
  markUsageIncomplete(): void {
    this.#runUsageComplete = false;
  }

  // Per-turn cost-delta wire (spec ORCHESTRATION.md §3.5 shared-budget
  // contract). Persist the lifetime cost rollup FIRST — so a consumer that
  // reads the DB on this event already sees the charge — then emit `cost_update`
  // (cumulative = this session's self-cost), then the one-shot soft-cap warn.
  // Skips non-positive / non-finite deltas so an all-zero usage event generates
  // no billing noise (which is why `cost_update` is the BILLING signal, not the
  // display cue — callers pair it with an unconditional `usage_persisted`). The
  // persist is best-effort: a DB hiccup must not turn a billed step into a run
  // failure; finish() re-writes the canonical final figure.
  emitCostUpdate(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    const sessionId = this.#deps.getSessionId();
    if (sessionId.length > 0) {
      try {
        updateSessionCost(this.#deps.db, sessionId, this.#priorCostUsd + this.#runCostUsd);
      } catch {
        // Display-cadence bookkeeping only; finish() re-writes it.
      }
    }
    safeEmit(this.#deps.onEvent, {
      type: 'cost_update',
      delta,
      cumulative: this.#runCostUsd,
    });
    // Soft cap (§3.5.0): fires ONCE when self-cost first crosses the threshold.
    // Per-session, not cumulative-across-resumes (uses run cost, not
    // prior+run) — matches the "you crossed your estimate THIS session"
    // framing. Run does NOT terminate here; only the hard cap does.
    if (
      !this.#softCapWarned &&
      this.#deps.softCostUsd !== undefined &&
      this.#deps.softCostUsd > 0 &&
      this.#runCostUsd > this.#deps.softCostUsd
    ) {
      this.#softCapWarned = true;
      safeEmit(this.#deps.onEvent, {
        type: 'cost_soft_cap_warn',
        threshold: this.#deps.softCostUsd,
        cumulative: this.#runCostUsd,
      });
    }
  }

  // Cumulative-cost cap check (§3.5). Returns a detail string when the hard cap
  // is exceeded (for the caller to build a `maxCostUsd` finish), null otherwise.
  // Strict `>` so a `maxCostUsd: 0` config trips on the first paid turn, not
  // before any work runs.
  costCapDetail(): string | null {
    const cap = this.#deps.maxCostUsd;
    if (cap === undefined) return null;
    const cumulative = this.cumulativeSpend(this.#deps.getReservedChildCostUsd());
    if (cumulative <= cap) return null;
    return `cumulative cost $${cumulative.toFixed(6)} exceeded cap $${cap.toFixed(6)}`;
  }
}
