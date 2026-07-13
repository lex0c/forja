// Terminal-path (session-end) logic extracted from the harness loop's `finish`
// closure (N1 — reduce the runAgent god-object). The session-end sequence used
// to be ~180 lines nested inside the ~4200-line runAgent closure, coupled to it
// through ~15 shared mutable `let`s. Moving it here — taking an EXPLICIT
// snapshot of run state + deps instead of closing over those locals — is the
// coupling reduction the refactor targets. Behavior is preserved verbatim; the
// harness tests (events / checkpoints / wire-session-aborted / the runAgent-
// driving suites) are the net.
import { runGc } from '../audit/gc.ts';
import type { HookChainResult, HookEventPayload } from '../hooks/index.ts';
import type { OutcomeSink } from '../outcomes/index.ts';
import { buildAutoTerse } from '../recap/auto-display.ts';
import type { DB } from '../storage/db.ts';
import { completeSession } from '../storage/index.ts';
import { listApprovalsLogBySessionRecent } from '../storage/repos/approvals-log.ts';
import { safeEmit } from './emit.ts';
import type { SessionContext } from './session-context.ts';
import {
  type ExitReason,
  type HarnessConfig,
  type HarnessResult,
  isRecapEnabled,
} from './types.ts';

// Terminal status persisted on the session row when a run ends.
export type TerminalSessionStatus = 'done' | 'interrupted' | 'exhausted' | 'error';

// Slice 131: how many of the session's most-recent approvals get a
// `session_aborted` outcome_signal when the run ends interrupted/error.
// Bounded (ORDER BY seq DESC LIMIT 5) so a long session (10k tool calls)
// doesn't materialize the full list on every abort. The problem is more
// likely in the recent few approvals than the session's very first.
const SESSION_ABORTED_TAIL_N = 5;

// Emit a weak (weight 0.20) `session_aborted` outcome_signal for the last N
// approvals of a session that terminated interrupted/error. Weak because
// sessions abort for many reasons that aren't "the decision was wrong"
// (Ctrl+C, timeout, cost cap, provider crash). Per-emit try/catch so a
// transient SQLITE_BUSY on one signal doesn't drop the rest of the cohort;
// a failure stderrs but never blocks session end.
//
// The caller gates on `outcomeSink !== undefined`, a non-empty sessionId, and
// an interrupted/error terminal status — this helper assumes those hold.
const emitSessionAbortedSignals = (args: {
  db: DB;
  sessionId: string;
  reason: ExitReason;
  abortCause?: 'soft' | 'hard';
  outcomeSink: OutcomeSink;
}): void => {
  const { db, sessionId, reason, abortCause, outcomeSink } = args;
  const recent = listApprovalsLogBySessionRecent(db, sessionId, SESSION_ABORTED_TAIL_N);
  for (const a of recent) {
    try {
      outcomeSink.emit({
        approval_seq: a.seq,
        signal_kind: 'session_aborted',
        payload: {
          exit_reason: reason,
          ...(abortCause !== undefined ? { abort_cause: abortCause } : {}),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `forja outcome_signals: session_aborted emit failed for approval_seq=${a.seq} (${msg})\n`,
      );
    }
  }
};

// The session-end sequence, moved verbatim out of runAgent's `finish` closure:
// mark the session row complete, build the per-run HarnessResult, emit the
// session_aborted outcome signals, fire Stop hooks, run gc-on-Stop, drain any
// in-flight hook chains, and project the auto-recap. Returns the result.
//
// The two pieces of state that MUST stay in runAgent are handled by the thin
// caller: it clears the wall-clock timer BEFORE calling this, and does the
// guarded (once-only) `session_finished` emit AFTER — that flag is the terminal
// FSM's remaining bit of persistent state, kept next to the closure that owns
// the run's lifetime.
export const finalizeSession = async (args: {
  config: HarnessConfig;
  reason: ExitReason;
  status: TerminalSessionStatus;
  harnessStatus: HarnessResult['status'];
  detail?: string;
  abortCause?: 'soft' | 'hard';
  sessionId: string;
  priorCostUsd: number;
  totalCostUsd: number;
  priorUsageComplete: boolean;
  usageComplete: boolean;
  totalUsage: HarnessResult['usage'];
  steps: number;
  startMs: number;
  ctx: SessionContext | undefined;
  dispatchHooks: (payload: HookEventPayload) => Promise<HookChainResult | null>;
  pendingHookChains: Set<Promise<unknown>>;
}): Promise<HarnessResult> => {
  const {
    config,
    reason,
    status,
    harnessStatus,
    detail,
    abortCause,
    sessionId,
    priorCostUsd,
    totalCostUsd,
    priorUsageComplete,
    usageComplete,
    totalUsage,
    steps,
    startMs,
    ctx,
    dispatchHooks,
    pendingHookChains,
  } = args;

  // Skip completeSession when init failed before createSession — there's
  // no row to mark and SQLite would just throw a foreign-key error.
  if (sessionId.length > 0) {
    try {
      // Persist CUMULATIVE totals (prior + this run) so the row reflects the
      // session's lifetime cost. The result returned below stays per-run
      // (caller telemetry). abortCause is threaded through so audit / replay
      // tools can recover the discriminator after the process exits.
      completeSession(
        config.db,
        sessionId,
        status,
        priorCostUsd + totalCostUsd,
        priorUsageComplete && usageComplete,
        undefined,
        abortCause,
      );
    } catch {
      // Storage already broken; nothing useful to do beyond return the
      // result so the caller knows the run is over.
    }
  }
  const result: HarnessResult = {
    status: harnessStatus,
    reason,
    sessionId,
    steps,
    durationMs: Date.now() - startMs,
    usage: totalUsage,
    costUsd: totalCostUsd,
    usageComplete,
    unmetered: config.provider.capabilities.unmetered === true,
    // ctx is undefined only if init failed before the session-decision block
    // resolved it (early internalError) — keep the pre-ctx '' so that path's
    // result shape is unchanged.
    lastMessageId: ctx !== undefined ? ctx.getLastMessageId() : '',
  };
  // Hand the live context back so a multi-turn caller (REPL) reuses it next
  // turn instead of re-deriving from the DB log.
  if (ctx !== undefined) result.sessionContext = ctx;
  if (detail !== undefined) result.detail = detail;
  if (reason === 'aborted' && abortCause !== undefined) {
    result.abortCause = abortCause;
  }

  // Slice 131 wire: when the session terminates interrupted/error, emit a
  // `session_aborted` outcome_signal for the last N approvals. Best-effort:
  // signal emit failure stderrs but never blocks the result.
  if (
    config.outcomeSink !== undefined &&
    sessionId.length > 0 &&
    (status === 'interrupted' || status === 'error')
  ) {
    emitSessionAbortedSignals({
      db: config.db,
      sessionId,
      reason,
      outcomeSink: config.outcomeSink,
      ...(abortCause !== undefined ? { abortCause } : {}),
    });
  }
  // Stop hooks (spec AGENTIC_CLI.md §10.1). Fired AFTER the session row is
  // marked complete and the result struct is built — so the operator's hook
  // reads the final row/status as authoritative — but BEFORE the renderer
  // sees session_finished. Skipped on init-fail paths where createSession
  // never landed (`sessionId === ''`).
  if (sessionId.length > 0) {
    await dispatchHooks({
      schema: 'v1',
      event: 'Stop',
      sessionId,
      data: {
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        steps: result.steps,
      },
    });
  }
  // Built-in gc-on-Stop trigger (AGENTIC_CLI.md §2.1.3). Operator opted in via
  // `[audit] run_gc_on_stop = true`. Synchronous so "when the agent command
  // returns, hygiene is done" holds. Errors stderr but never propagate — gc
  // drift is not a task failure. Runs AFTER operator Stop hooks so a hook that
  // needed the pre-gc state (e.g. backup) sees the DB untouched.
  if (config.auditRetention?.runGcOnStop === true) {
    try {
      const report = runGc({
        db: config.db,
        config: config.auditRetention,
        nowMs: Date.now(),
        dryRun: false,
      });
      for (const e of report.errors) {
        process.stderr.write(`forja gc-on-Stop: ${e.table}: ${e.reason}\n`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`forja gc-on-Stop: unexpected error: ${msg}\n`);
    }
  }
  // Drain fire-and-forget chains still in flight (PostToolUse from the last
  // tool, Notification from a mid-step confirm, PreCheckpoint from the last
  // writes-true step) so a chain that hadn't reached its `createHookRun` by
  // the time runAgent returns doesn't race `db.close()` in the CLI driver.
  // allSettled so a rogue chain that throws doesn't crash the exit path.
  if (pendingHookChains.size > 0) {
    await Promise.allSettled([...pendingHookChains]);
  }

  // Auto-display terse line (RECAP §3.3). Project the recap deterministically,
  // cache it (so the operator's next `/recap` is a hit), and emit the markdown
  // for the TUI. Best-effort: any failure is swallowed (the harness contract is
  // "always emit session_finished"; recap is a side surface). Suppressed when
  // the recap master switch is off, and skipped on init-fail (`sessionId ===
  // ''`) paths.
  if (isRecapEnabled(config) && sessionId.length > 0) {
    const auto = buildAutoTerse({ db: config.db, sessionId, now: Date.now() });
    if (auto.ok) {
      safeEmit(config.onEvent, {
        type: 'recap_terse_ready',
        sessionId,
        markdown: auto.markdown,
        cacheHit: auto.cacheHit,
      });
    }
  }
  return result;
};
