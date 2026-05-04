import { createHash } from 'node:crypto';
import { type BgManager, createBgManager } from '../bg/index.ts';
import {
  type CheckpointManager,
  createCheckpointManager,
  detectCheckpointSupport,
} from '../checkpoints/index.ts';
import { type HookEventPayload, dispatchChain } from '../hooks/index.ts';
import { addUsage, computeCost, emptyUsage } from '../providers/cost.ts';
import type {
  GenerateRequest,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  ProviderToolResultBlock,
  ProviderToolUseBlock,
} from '../providers/index.ts';
import { estimatePromptTokens } from '../providers/tokens.ts';
import {
  appendMessage,
  completeSession,
  createSession,
  getSession,
  listMessageTailBySession,
  reopenSession,
} from '../storage/index.ts';
import { MAX_SUBAGENT_DEPTH, runSubagent } from '../subagents/runtime.ts';
import { type TodoStore, createTodoStore } from '../todo/index.ts';
import type { ToolContext } from '../tools/index.ts';
import type { SpawnSubagentArgs, SpawnSubagentResult } from '../tools/types.ts';
import { abortableIterable } from './abortable.ts';
import { CollectStepError, collectStep } from './collect.ts';
import { compactMessages } from './compaction.ts';
import { invokeTool } from './invoke-tool.ts';
import {
  ALIGNMENT_FETCH_MARGIN,
  MAX_RESUME_MESSAGES,
  STRANDED_TURN_PLACEHOLDER,
  messagesToProviderMessages,
} from './resume.ts';
import { DEFAULT_RETRY, generateWithRetry } from './retry.ts';
import {
  DEFAULT_BUDGET,
  type ExitReason,
  type HarnessConfig,
  type HarnessEvent,
  type HarnessResult,
  type RunBudget,
} from './types.ts';

type TerminalSessionStatus = 'done' | 'interrupted' | 'exhausted' | 'error';

const safeEmit = (onEvent: HarnessConfig['onEvent'], event: HarnessEvent): void => {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch {
    // Renderers throwing must not derail the loop.
  }
};

const stableStringify = (obj: unknown): string => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
};

const hashToolCall = (name: string, args: Record<string, unknown>): string =>
  createHash('sha256')
    .update(`${name}:${stableStringify(args)}`)
    .digest('hex');

const exitToStatus: Record<ExitReason, TerminalSessionStatus> = {
  done: 'done',
  maxSteps: 'exhausted',
  maxWallClockMs: 'interrupted',
  maxOutputTokens: 'exhausted',
  maxCostUsd: 'exhausted',
  maxToolErrors: 'error',
  degenerateLoop: 'error',
  aborted: 'interrupted',
  providerError: 'error',
  internalError: 'error',
  scriptExhausted: 'error',
};

const exitToHarnessStatus: Record<ExitReason, HarnessResult['status']> = {
  done: 'done',
  maxSteps: 'exhausted',
  maxWallClockMs: 'interrupted',
  maxOutputTokens: 'exhausted',
  maxCostUsd: 'exhausted',
  maxToolErrors: 'error',
  degenerateLoop: 'error',
  aborted: 'interrupted',
  providerError: 'error',
  internalError: 'error',
  scriptExhausted: 'error',
};

const buildToolDefs = (config: HarnessConfig): ProviderToolDef[] =>
  config.toolRegistry.list().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

// Strip `name` from the tool model so it stays inside our domain — providers
// expect their own format already constructed by the adapter.

export const runAgent = async (config: HarnessConfig): Promise<HarnessResult> => {
  const budget: RunBudget = { ...DEFAULT_BUDGET, ...(config.budget ?? {}) };
  const startMs = Date.now();

  // Combine the caller's abort signal with a wall-clock timer so the cap
  // fires even when a provider call hangs mid-step (between-step checks
  // miss this case). AbortSignal.any composes them; either firing aborts
  // downstream provider/tool work via the canonical signal.
  const wallClockController = new AbortController();
  const wallClockTimer = setTimeout(() => wallClockController.abort(), budget.maxWallClockMs);
  const callerSignal = config.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([callerSignal, wallClockController.signal]);

  const messages: ProviderMessage[] = [];
  const tools = buildToolDefs(config);
  const recentToolHashes: string[] = [];
  const HASH_WINDOW = 5;

  let steps = 0;
  let consecutiveErrors = 0;
  let sessionId = '';
  let lastMessageId = '';
  // Session-scoped bg manager. Created lazily after createSession
  // so the manager can record the right session_id on every spawn.
  // Stays undefined when no bgLogDir is configured — bg tools will
  // surface `bg.manager_unavailable` if invoked. Captured via
  // closure so the outer-finally cleanup hook can find it whether
  // we exited normally or through guardedFinish.
  let bgManager: BgManager | undefined;
  // Per-session CheckpointManager. Lifecycle parallels bgManager:
  // created after sessionId is resolved (the manager carries it),
  // used inline before tool execution, and otherwise just lives on
  // the stack. No teardown — checkpoint refs are durable artifacts
  // intentionally; the lazy-purge sweep at startup of the NEXT run
  // is what reclaims them.
  let checkpointManager: CheckpointManager | undefined;
  // Tracks the in-flight retention sweep (if any). Captured in the
  // outer scope so the outer finally can await it before the caller
  // closes the DB. Without the await, the purge would race against
  // db.close() in cli/run.ts and hit a closed sqlite handle.
  let checkpointsPurgeInFlight: Promise<unknown> | undefined;
  // Per-session TodoList store. Created once per session here so the
  // todo_write tool sees a fresh list, and torn down in the outer
  // finally so accumulated state from a long-lived process doesn't
  // leak across sessions. Spec §7.4: not persisted, work-state only.
  //
  // The bare store is a pure data structure; observability is layered
  // on at the harness boundary by wrapping `set` to emit a
  // `todo_updated` HarnessEvent after the write lands. Wrapping rather
  // than mutating the store keeps test contexts that build a store
  // directly free of the emit dependency. `clear` is NOT wrapped —
  // session-end cleanup is not a planning event (D132).
  const baseTodoStore = createTodoStore();
  // Wrap each method through a fresh closure rather than aliasing the
  // method reference. Today `createTodoStore` returns plain arrows
  // bound by closure (no `this`), so direct aliasing would work — but
  // a future refactor to a class with `this`-bound methods would
  // silently break get/clear at runtime without TS catching it. The
  // extra layer costs nothing and keeps the contract explicit.
  const todoStore: TodoStore = {
    get: (sid) => baseTodoStore.get(sid),
    set: (sid, items) => {
      baseTodoStore.set(sid, items);
      // Read back through the store so the event carries the same
      // deep-cloned snapshot a fresh `get` would return — observers
      // can't poison stored state, and the items they see are
      // structurally identical to what the next call to get() yields.
      safeEmit(config.onEvent, {
        type: 'todo_updated',
        sessionId: sid,
        items: baseTodoStore.get(sid),
      });
    },
    clear: (sid) => baseTodoStore.clear(sid),
  };
  // Per-run totals. Each completed provider turn adds its usage and
  // its computed cost; HarnessResult.usage / costUsd report THIS
  // RUN's numbers — caller telemetry that has to stay self-
  // consistent (zero usage means zero cost, etc.).
  let totalUsage = emptyUsage();
  let totalCostUsd = 0;
  // Stays true until an assistant turn produces output without an
  // accompanying usage event. The aggregate `usage`/`costUsd` only
  // sums measured turns; this flag tells the caller whether those
  // numbers are complete or a lower-bound estimate.
  let usageComplete = true;
  // Cumulative state from prior runs of the same session id (zero
  // for new sessions). Held SEPARATELY from the per-run totals so
  // HarnessResult stays per-run while the persisted column stays
  // cumulative — fixing the contract mismatch where seeding
  // totalCostUsd from the existing row made costUsd report
  // "current run + prior" while usage was still "current only".
  // Persistence at finish() writes (priorCostUsd + totalCostUsd);
  // the result reports just totalCostUsd.
  let priorCostUsd = 0;
  let priorUsageComplete = true;

  // Distinguish wall-clock from user abort — both use `signal.aborted` but
  // the user wants different exit reasons.
  const isWallClockTimeout = (): boolean =>
    wallClockController.signal.aborted && !callerSignal.aborted;

  // Cumulative-cost cap check. Returns a detail string when the cap
  // is exceeded so callers can build the finish() call inline; null
  // otherwise. The comparison uses CUMULATIVE cost (priorCostUsd +
  // totalCostUsd) so that a resumed run honors the same cap that
  // applied to its predecessor — matching the persistence contract
  // where the session row stores cumulative spend. Strict `>` so a
  // `maxCostUsd: 0` config trips the gate on the first paid turn,
  // not before any work runs.
  const costCapDetailIfExceeded = (): string | null => {
    if (budget.maxCostUsd === undefined) return null;
    const cumulative = priorCostUsd + totalCostUsd;
    if (cumulative <= budget.maxCostUsd) return null;
    return `cumulative cost $${cumulative.toFixed(6)} exceeded cap $${budget.maxCostUsd.toFixed(6)}`;
  };

  // Hook chain dispatch (spec AGENTIC_CLI.md §10). All sites
  // funnel through this helper so the dispatcher's deps (db,
  // sessionId, cwd) are bound consistently and stray exceptions
  // never leak past the harness boundary. Spec §10.3 line 1041:
  // non-blocking events run fire-and-forget WRT decisions, but
  // we still await here so the audit row lands before the
  // session row is closed at finish() — without that, a
  // legitimate hook execution can disappear from `hook_runs`
  // because the DB closes underneath it. The wall-clock cap
  // (15s) inside the dispatcher protects against runaway hooks
  // adding latency to session boot or shutdown.
  const fireHookChain = async (payload: HookEventPayload): Promise<void> => {
    if (config.hooks === undefined || config.hooks.length === 0) return;
    try {
      await dispatchChain(config.hooks, payload, config.cwd, {
        db: config.db,
        sessionId: sessionId.length > 0 ? sessionId : null,
      });
    } catch (err) {
      // Defense-in-depth: dispatchChain wraps each hook's error
      // already, but a programming bug in the dispatcher itself
      // (or a synchronous throw before the per-hook try/catch
      // started) shouldn't crash the harness. Log to stderr so
      // the operator notices.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`hooks: chain dispatch failed for ${payload.event}: ${msg}\n`);
    }
  };

  // `abortCause` is only meaningful when reason === 'aborted'; ignored
  // otherwise. Callers thread it from the abort site that knew which
  // signal fired (hard signal.aborted vs softStopSignal.aborted) so
  // the result carries the discriminator audit / telemetry needs.
  const finish = async (
    reason: ExitReason,
    detail?: string,
    abortCause?: 'soft' | 'hard',
  ): Promise<HarnessResult> => {
    clearTimeout(wallClockTimer);
    // Skip completeSession when init failed before createSession — there's
    // no row to mark and SQLite would just throw a foreign-key error.
    if (sessionId.length > 0) {
      try {
        // Persist CUMULATIVE totals (prior + this run) so the row
        // reflects the session's lifetime cost. The result returned
        // below stays per-run (caller telemetry). abortCause is
        // threaded through so audit / replay tools can recover the
        // discriminator after the process exits — without this, the
        // in-memory HarnessResult.abortCause died at the boundary.
        completeSession(
          config.db,
          sessionId,
          exitToStatus[reason],
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
      status: exitToHarnessStatus[reason],
      reason,
      sessionId,
      steps,
      durationMs: Date.now() - startMs,
      usage: totalUsage,
      costUsd: totalCostUsd,
      usageComplete,
      lastMessageId,
    };
    if (detail !== undefined) result.detail = detail;
    if (reason === 'aborted' && abortCause !== undefined) {
      result.abortCause = abortCause;
    }
    // Stop hooks (spec AGENTIC_CLI.md §10.1). Fired AFTER the
    // session row is marked complete and the result struct is
    // built — so the operator's hook can read the final row /
    // status as authoritative — but BEFORE the renderer sees
    // session_finished, so any "session ended at $cost"
    // notification from a Stop hook lands while the UI is still
    // around. Audit is awaited; latency is bounded by the
    // dispatcher's MAX_HOOK_CHAIN_MS.
    //
    // Skipped on init-fail paths where createSession never
    // landed (`sessionId === ''`) — the spec contract on
    // HookEventPayload promises a non-empty sessionId, and
    // there's no real session for the operator's Stop hook to
    // act on. Mirrors the symmetric guard around SessionStart
    // (which only fires after the session_start emit, by which
    // point sessionId is guaranteed set).
    if (sessionId.length > 0) {
      await fireHookChain({
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
    safeEmit(config.onEvent, { type: 'session_finished', result });
    return result;
  };

  // Convert any uncaught exception (typically SQLite errors from append
  // operations) into a clean error exit instead of letting it crash the
  // caller. Tool exceptions are already wrapped by invokeTool; this catch
  // is for the persistence path that surrounds it. We don't know what
  // turns were measured at the throw site, so the safe call is to mark
  // aggregate totals as incomplete.
  //
  // Special case: if `signal.aborted` at throw time, the underlying
  // exception is most likely AbortError (SQLite write interrupted by
  // the abort signal, async iteration cancelled, etc.). Map to
  // `aborted` with `cause='hard'` instead of burying it as
  // `internalError` — operator-initiated termination shouldn't look
  // like a harness bug in audit. Wall-clock timeout takes precedence
  // (matches the in-loop check).
  const guardedFinish = async (e: unknown): Promise<HarnessResult> => {
    usageComplete = false;
    const detail = e instanceof Error ? e.message || e.name || String(e) : String(e);
    if (signal.aborted) {
      return isWallClockTimeout()
        ? await finish('maxWallClockMs', detail)
        : await finish('aborted', detail, 'hard');
    }
    return await finish('internalError', detail);
  };

  // Init writes (createSession + initial appendMessage) live INSIDE the
  // try so a SQLite failure here routes through guardedFinish — that
  // clears the wall-clock timer instead of leaking it for the full
  // maxWallClockMs window (default 10 min).
  //
  // The outer try/finally is the session-end cleanup hook for any bg
  // processes (`bash_background` & co, M3 §7.3). Spawned processes
  // outlive a single turn, so when the loop exits — naturally, on
  // budget, on abort, or on internalError — we send SIGTERM to every
  // still-running child. Best-effort: cleanup errors are swallowed
  // so they don't mask the run's HarnessResult, and the DB is
  // converged via markRunningAsKilled inside cleanup() regardless of
  // whether the OS kill landed.
  try {
    try {
      // Resume vs new session. In resume mode, the prior session id
      // is reused and its persisted messages are loaded back into
      // the in-memory array so the model sees the full conversation
      // before the new userPrompt. The session is flipped back to
      // 'running' so completeSession at run-end doesn't trip its
      // 'must be running' WHERE guard. We validate the id BEFORE
      // any side effects so a typo'd session id doesn't leave a
      // half-initialized state.
      // Resume budget semantics: `steps`, `consecutiveErrors`,
      // `totalUsage`, `totalCostUsd`, and `usageComplete` are
      // PER-RUN accumulators that start at zero/true — they drive
      // HarnessResult, which is per-run telemetry that has to
      // stay self-consistent (zero usage means zero cost, etc.).
      // The CUMULATIVE state (prior + this run) is held separately
      // in `priorCostUsd` / `priorUsageComplete` and only used at
      // completeSession time so the persisted column reflects the
      // session's lifetime cost. This separation closes the bug
      // where seeding totalCostUsd from the row made costUsd
      // report cumulative while usage stayed per-run.
      // The CLI's run.ts also calls getSession before constructing
      // the config (`resolveResumeId`) so a typo'd id fails fast on
      // stderr. The duplicate check here is intentional defense in
      // depth: programmatic callers (evals, future tests) may build
      // a HarnessConfig directly without going through the CLI, and
      // getSession returning null inside the loop would otherwise
      // surface as a confusing 'getSession on null result' downstream
      // when we read totalCostUsd. The cost of one extra SELECT per
      // resume call is negligible.
      const resumeId = config.resumeFromSessionId;
      const preassignedId = config.preassignedSessionId;
      if (resumeId !== undefined && preassignedId !== undefined) {
        // Defense in depth: the two paths are mutually exclusive —
        // resume reopens an existing finalized session, preassigned
        // uses a freshly-created row the caller built. Setting both
        // is a programmer bug, fail loud rather than guess intent.
        throw new Error(
          'HarnessConfig: resumeFromSessionId and preassignedSessionId are mutually exclusive',
        );
      }
      if (resumeId !== undefined) {
        const existing = getSession(config.db, resumeId);
        if (existing === null) {
          throw new Error(`session ${resumeId} not found`);
        }
        // cwd divergence between the original session and the
        // resume context is silently broken: messages reference
        // files / paths from the original cwd, but bash calls in
        // the resumed run land in the new cwd. Refuse rather than
        // let the model think it's in a filesystem that doesn't
        // match its conversation. Operators who legitimately want
        // to resume in a different directory can `cd` to the
        // original first or start a fresh session — both are
        // clearer than silent divergence.
        if (existing.cwd !== config.cwd) {
          throw new Error(
            `cannot resume session ${resumeId}: original cwd was '${existing.cwd}', current cwd is '${config.cwd}'. cd to the original directory or start a new session.`,
          );
        }
        priorCostUsd = existing.totalCostUsd;
        priorUsageComplete = existing.usageComplete;
        reopenSession(config.db, resumeId);
        sessionId = resumeId;
      } else if (preassignedId !== undefined) {
        // Caller-created row. Verify it exists and matches the
        // expected shape (cwd, status='running'). The cwd check
        // mirrors resume's — relative paths in messages must
        // resolve consistently between the row's recorded cwd
        // and the runtime cwd. The status check guards against
        // accidentally rerunning over a finalized session, which
        // would silently overwrite messages.
        const existing = getSession(config.db, preassignedId);
        if (existing === null) {
          throw new Error(
            `preassignedSessionId ${preassignedId} not found; the caller must createSession before constructing the config`,
          );
        }
        if (existing.cwd !== config.cwd) {
          throw new Error(
            `preassignedSessionId ${preassignedId}: row cwd is '${existing.cwd}', config cwd is '${config.cwd}' — must match`,
          );
        }
        if (existing.status !== 'running') {
          throw new Error(
            `preassignedSessionId ${preassignedId}: row status is '${existing.status}', expected 'running' (only fresh, unfinalized rows are usable)`,
          );
        }
        sessionId = preassignedId;
      } else {
        const session = createSession(config.db, {
          model: config.provider.id,
          cwd: config.cwd,
          ...(config.parentSessionId !== undefined
            ? { parentSessionId: config.parentSessionId }
            : {}),
        });
        sessionId = session.id;
      }

      // bg manager creation MUST happen here, after sessionId is
      // resolved — every row insertBgProcess writes carries the
      // session_id FK, so a manager built before createSession would
      // crash on first spawn. The manager is short-lived: lives
      // until the outer finally cleans it up.
      //
      // Note: bg processes from the prior run of a resumed session
      // are NOT carried over. The previous run's harness terminated
      // them in its outer finally; this fresh manager starts empty.
      // Documented as an explicit boundary — resume restores
      // conversational context, not running children.
      if (config.bgLogDir !== undefined) {
        bgManager = createBgManager({
          db: config.db,
          sessionId,
          logDir: config.bgLogDir,
          // Propagate the harness's combined signal (caller abort +
          // wall-clock). A Ctrl+C mid-stream kills bg processes
          // immediately instead of waiting for runAgent's outer
          // finally to fire — matters when the loop is mid-provider-
          // request, where finally can be seconds away.
          abortSignal: signal,
          // Lifecycle observer: translate bg manager events into
          // HarnessEvents so the renderer can update its `bg N`
          // footer counter (spec UI.md §4.10.6) and audit captures
          // the same lifecycle the user sees. Event shape mirrors
          // BgManagerEvent's `kind` discriminant onto distinct
          // HarnessEvent types so the adapter's switch stays flat.
          onEvent: (event) => {
            if (event.kind === 'started') {
              safeEmit(config.onEvent, {
                type: 'bg_started',
                processId: event.processId,
                command: event.command,
                label: event.label,
              });
            } else {
              safeEmit(config.onEvent, {
                type: 'bg_ended',
                processId: event.processId,
                status: event.status,
                exitCode: event.exitCode,
              });
            }
          },
        });
      }

      // Checkpoint manager. Only built when the caller opted in —
      // unit tests and programmatic callers usually don't, so we
      // skip the git probe entirely in that case. The probe itself
      // is best-effort: a non-git cwd yields available=false and
      // every snapshot becomes a no-op, which keeps the loop's
      // call sites uniform.
      //
      // The `checkpoints_unavailable` event (when the probe finds
      // no git) is emitted AFTER `session_start` so the bracketing
      // contract holds — every observer sees session_start as the
      // first event of a run. Captured to a local and replayed
      // below.
      let checkpointsUnavailableReason: string | null = null;
      if (config.enableCheckpoints === true) {
        const support = await detectCheckpointSupport(config.cwd);
        checkpointManager = createCheckpointManager({
          db: config.db,
          cwd: config.cwd,
          sessionId,
          available: support.available,
        });
        if (!support.available && support.reason !== null) {
          checkpointsUnavailableReason = support.reason;
        } else if (support.available) {
          // Lazy retention sweep. Fire-and-forget per CHECKPOINTS §2.5:
          // it must not block the harness from making progress (a
          // monorepo with thousands of refs could spend seconds in
          // ref deletion) AND it must not bubble its errors anywhere
          // the run depends on (purge throwing on a corrupt ref store
          // would otherwise bring down a session for a side-effect-
          // less cleanup).
          //
          // Safe under concurrent snapshots in the same session
          // because purge's age-cutoff (default 30d) is far beyond
          // any in-flight session's created_at; the current
          // session's rows are excluded by construction.
          const retentionDays = config.checkpointsRetentionDays;
          checkpointsPurgeInFlight = checkpointManager
            .purge(retentionDays !== undefined ? { olderThanDays: retentionDays } : {})
            .catch(() => {
              // Swallowed — see rationale above.
            });
        }
      }

      // Hydrate persisted messages BEFORE appending the new user
      // prompt. Two paths converge here:
      //   - Resume: the prior run's full transcript is on disk;
      //     load it so the model sees [old turns, new prompt].
      //   - Preassigned: the caller (subprocess parent) created
      //     the row and inserted the seed user message before
      //     spawning. We need to load that seed too — otherwise
      //     the child sees an empty conversation and appends a
      //     fresh prompt-from-config that would silently NOT match
      //     what the parent committed.
      // Both paths share the same fetch + alignment walk; only
      // the trigger condition differs.
      //
      // Bounded fetch: SQL returns at most (MAX + alignment
      // margin) rows, so a 50k-message session never materializes
      // in JS memory. The earlier implementation read the full
      // log into memory and sliced — defeating the cap and OOM-ing
      // on long-running sessions.
      //
      // droppedFromHead reported on the resume_truncated event
      // accounts for BOTH the rows that never left SQL (totalCount
      // - fetchedCount) and the rows the alignment walk skipped
      // inside the fetched slice. Kept count is what the model
      // actually sees in context.
      //
      // Carry forward the parent_id chain across resume /
      // preassigned. Without seeding lastMessageId from the prior
      // tail, the new user turn appends with parent_id=null and
      // starts a NEW root in the same session — the parent_id
      // graph forks at the boundary, breaking traversal/replay/
      // audit logic that walks parent links to reconstruct the
      // conversation tree. The persisted tail is already ordered
      // by seq (migration 007), so the tail is just the last
      // element of what we fetched (which IS the absolute tail
      // since the bounded fetch picks newest rows).
      let priorTailId: string | null = null;
      const preexistingId = resumeId ?? preassignedId;
      if (preexistingId !== undefined) {
        const tail = listMessageTailBySession(
          config.db,
          preexistingId,
          MAX_RESUME_MESSAGES + ALIGNMENT_FETCH_MARGIN,
        );
        const restored = messagesToProviderMessages(tail.messages);
        messages.push(...restored.messages);
        const fetchedCount = tail.messages.length;
        const droppedBeyondFetch = tail.totalCount - fetchedCount;
        const totalDropped = droppedBeyondFetch + restored.droppedFromHead;
        if (totalDropped > 0 && resumeId !== undefined) {
          // resume_truncated emits only on the resume path. The
          // preassigned path's seed is freshly inserted by the
          // parent (typically a single user message) and
          // truncation there would indicate something is off
          // with the parent's flow — but it's not a "user
          // resumed and lost context" event the renderer needs
          // to surface.
          safeEmit(config.onEvent, {
            type: 'resume_truncated',
            sessionId,
            kept: restored.messages.length,
            dropped: totalDropped,
          });
        }
        // Stranded-turn handling. If the last restored message is
        // `user` (either the original prompt that never got an
        // assistant response, or a tool_result whose follow-up
        // assistant turn never landed because the run aborted),
        // appending the resume's new user prompt would create
        // user→user on the wire — every provider 400s on that.
        // Insert an in-memory-only synthetic assistant placeholder
        // to satisfy alternation. Not persisted: each resume
        // re-derives it on demand from whatever shape the log is
        // in at that moment.
        //
        // The placeholder is ONLY needed when we're about to
        // append a new user prompt. On the preassigned path with
        // an empty userPrompt (the parent already seeded the
        // user turn), the seed itself IS the conversation and
        // we don't append again — so a trailing-user tail is
        // correct, not stranded.
        const inMemoryTail = messages[messages.length - 1];
        const willAppendUserPrompt = config.userPrompt.length > 0;
        if (willAppendUserPrompt && inMemoryTail !== undefined && inMemoryTail.role === 'user') {
          messages.push({ role: 'assistant', content: STRANDED_TURN_PLACEHOLDER });
        }
        const lastFetched = tail.messages[tail.messages.length - 1];
        if (lastFetched !== undefined) priorTailId = lastFetched.id;
      }

      // Skip appending when userPrompt is empty. The preassigned
      // path with parent-seeded conversation passes '' here; the
      // hydration above already loaded the seed, so a second
      // append with empty content would produce a zero-byte user
      // message that providers either reject or take literally.
      // The fresh-session path always supplies a non-empty
      // userPrompt (CLI guards against missing prompt before
      // bootstrap).
      if (config.userPrompt.length > 0) {
        const userMsg = appendMessage(config.db, {
          sessionId,
          role: 'user',
          content: config.userPrompt,
          // null on first turn (new session); tail id on resume
          // / preassigned so the chain stays connected.
          // appendMessage validates the parent belongs to the
          // same session.
          ...(priorTailId !== null ? { parentId: priorTailId } : {}),
        });
        lastMessageId = userMsg.id;
        messages.push({ role: 'user', content: config.userPrompt });
      } else if (priorTailId !== null) {
        // No new user message to append; the prior tail id
        // becomes the lastMessageId we report on the result and
        // the chain anchor for the assistant turn that follows.
        lastMessageId = priorTailId;
      }

      safeEmit(config.onEvent, { type: 'session_start', sessionId });
      // Emit the checkpoints-unavailable warning AFTER session_start
      // so observers can rely on session_start being the first
      // lifecycle event of a run. Without the order guarantee,
      // renderers that buffer until session_start as the bracket
      // signal would miss the warning entirely.
      if (checkpointsUnavailableReason !== null) {
        safeEmit(config.onEvent, {
          type: 'checkpoints_unavailable',
          reason: checkpointsUnavailableReason,
        });
      }
      // SessionStart hooks (spec AGENTIC_CLI.md §10.1). Fired
      // AFTER the renderer sees session_start so the operator's
      // hook is bracketed inside the visible session — a hook
      // that prints to stdout doesn't land before the UI's
      // session header. Awaited so audit lands; latency capped
      // by the dispatcher's chain timeout.
      await fireHookChain({
        schema: 'v1',
        event: 'SessionStart',
        sessionId,
        data: {
          cwd: config.cwd,
          model: config.provider.id,
          profile: config.planMode === true ? 'plan' : 'default',
        },
      });

      while (true) {
        if (signal.aborted) {
          return isWallClockTimeout()
            ? await finish('maxWallClockMs')
            : await finish('aborted', undefined, 'hard');
        }
        // Cooperative stop: spec UI.md §3 soft interrupt. The check
        // sits at the top of the loop so the just-completed step's
        // tool calls + their results are persisted before exiting.
        // This gives the operator the "model finishes the step then
        // stops" semantic without burning tokens on a re-prompt the
        // operator already cancelled. Distinct from the hard signal
        // above — soft never preempts in-flight work.
        if (config.softStopSignal?.aborted) {
          return await finish('aborted', undefined, 'soft');
        }
        if (steps >= budget.maxSteps) return await finish('maxSteps');
        // Cost cap pre-check. Critical on resume: a session whose
        // priorCostUsd already crossed budget.maxCostUsd would
        // otherwise issue one billed provider call before the
        // post-turn check fires. Documented as cumulative; this
        // closes the gap so the cap blocks IMMEDIATELY at run
        // start rather than after one wasted turn. Steady-state
        // (non-resume) runs land in the post-turn check first
        // and never reach this branch on a subsequent iteration.
        {
          const overage = costCapDetailIfExceeded();
          if (overage !== null) return await finish('maxCostUsd', overage);
        }

        steps += 1;
        safeEmit(config.onEvent, { type: 'step_start', stepN: steps });

        const req: GenerateRequest = {
          model: config.provider.id,
          // Snapshot the running message list so post-call mutations (the next
          // iteration appends assistant + tool_results) don't retroactively
          // change what the provider observed.
          messages: [...messages],
          max_tokens: budget.maxOutputTokensPerCall,
          ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        };

        let collected: Awaited<ReturnType<typeof collectStep>>;
        try {
          // Wrap the provider stream so the combined abort signal (user +
          // wall-clock) actually reaches the for-await inside collectStep.
          // The Provider interface doesn't propagate signals to the SDK,
          // so without this a hung HTTP request blocks indefinitely and
          // neither Ctrl+C nor maxWallClockMs can interrupt it.
          collected = await collectStep(
            abortableIterable(generateWithRetry(config.provider, req, DEFAULT_RETRY), signal),
            (ev) => safeEmit(config.onEvent, { type: 'provider_event', event: ev }),
          );
        } catch (e) {
          // The provider request was sent (and likely billed for input
          // tokens) before the throw. Always flip the aggregate flag —
          // even if we recover partial usage, totals are by definition
          // a lower bound when the turn ended in error.
          usageComplete = false;

          // Recover whatever the stream emitted before the throw.
          // Adapters yield `usage` from their `finally` block precisely
          // for this case, so a failed turn that already received
          // input/cache numbers from the provider can still be charged.
          // CollectStepError carries the partial CollectedStep; non-
          // wrapped errors (extreme: collectStep itself crashed before
          // catching) have no recoverable state.
          if (e instanceof CollectStepError) {
            const partial = e.partial;
            if (partial.usageSeen) {
              const partialCost = computeCost(config.provider.capabilities, partial.usage);
              totalUsage = addUsage(totalUsage, partial.usage);
              totalCostUsd += partialCost;
              // Note: we deliberately do NOT check budget.maxCostUsd here.
              // The provider error path is about to call finish('providerError')
              // unconditionally — surfacing maxCostUsd instead when the partial
              // cost crossed the cap would mask the underlying failure (the
              // provider crash IS the actionable signal). The cumulative cost
              // is still persisted via priorCostUsd + totalCostUsd at finish(),
              // so the next resume sees the correct starting point and the
              // cap will fire there if the run continues.
            }
          }

          // SDK throws when the abort signal fires mid-call (Ctrl+C or
          // wall-clock timeout). Reroute to the matching ExitReason so the
          // user sees `interrupted` exit code 130 instead of a generic
          // `error` from `providerError`. Hard signal by definition —
          // soft can't preempt a provider call (it only fires at the
          // next step boundary).
          if (signal.aborted) {
            return isWallClockTimeout()
              ? await finish('maxWallClockMs')
              : await finish('aborted', undefined, 'hard');
          }
          const cause = e instanceof CollectStepError ? e.cause : e;
          const detail =
            cause instanceof Error ? cause.message || cause.name || String(cause) : String(cause);
          return await finish('providerError', detail);
        }

        // Build assistant content blocks: text first, then tool_uses, mirroring
        // the order the model produced them. Empty text is omitted.
        const assistantContent: ProviderContentBlock[] = [];
        if (collected.text.length > 0) {
          assistantContent.push({ type: 'text', text: collected.text });
        }
        for (const tu of collected.tool_uses) {
          const block: ProviderToolUseBlock = {
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: tu.input,
          };
          assistantContent.push(block);
        }

        const turnCostUsd = computeCost(config.provider.capabilities, collected.usage);
        totalUsage = addUsage(totalUsage, collected.usage);
        totalCostUsd += turnCostUsd;
        // ANY assistant turn that completes without a usage event is
        // unmeasured — every successful provider call bills input tokens
        // for the prompt, even when the model emits no text, no
        // tool_use, and no thinking. Stream errors and aborts don't
        // reach here (they exit via providerError/aborted finish paths),
        // so we're only counting turns that the provider actually
        // accepted and processed. Flipping the flag tells the renderer
        // to mark aggregate cost as a lower bound.
        if (!collected.usageSeen) usageComplete = false;

        // When the adapter never emitted a `usage` event, persist NULL on
        // the token/cost columns instead of zeroes. Future analytics can
        // then distinguish "no measurement" from "measured zero" — both
        // are legal but mean different things (e.g., a stream that aborted
        // before message_stop vs. a turn that genuinely produced nothing).
        const assistantMsg = appendMessage(config.db, {
          sessionId,
          role: 'assistant',
          parentId: lastMessageId,
          content: assistantContent.length > 0 ? assistantContent : '',
          tokensIn: collected.usageSeen ? collected.usage.input : null,
          tokensOut: collected.usageSeen ? collected.usage.output : null,
          cachedTokens: collected.usageSeen ? collected.usage.cache_read : null,
          cacheCreationTokens: collected.usageSeen ? collected.usage.cache_creation : null,
          costUsd: collected.usageSeen ? turnCostUsd : null,
        });
        lastMessageId = assistantMsg.id;
        if (assistantContent.length > 0) {
          messages.push({ role: 'assistant', content: assistantContent });
        }

        // Stream errors (normalizer-level: malformed tool_use args, orphan
        // tool_use_stop, etc.) mean the provider produced output we couldn't
        // structure correctly. The most common case is a malformed JSON
        // arguments stream — `tool_use_stop` is dropped and the call vanishes
        // from `tool_uses`. If we then exited as `done` because the array
        // is empty, the run reports success while silently losing the
        // model's intent. Surface this as a step-level failure instead.
        // The assistant message is already persisted above so the audit
        // trail keeps whatever text did come through.
        if (collected.errors.length > 0) {
          const detail = collected.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
          return await finish('providerError', `stream errors: ${detail}`);
        }

        // Cost cap check after the assistant turn lands and is persisted.
        // We exit AFTER the audit row is written so the user can see the
        // turn that pushed them over the cap when they query the session
        // log. Provider/stream errors above take precedence — the cap is
        // for clean spend, not for surfacing already-broken turns.
        {
          const overage = costCapDetailIfExceeded();
          if (overage !== null) return await finish('maxCostUsd', overage);
        }

        // No tool uses → check the stop_reason before declaring success.
        // `end_turn`, `stop_sequence`, and `refusal` are all "model finished
        // speaking" (the refusal IS the response, even if it's a no). But
        // `max_tokens` means the per-call output cap truncated the answer
        // mid-stream; reporting `done` here would silently hand the user
        // an incomplete response with exit code 0. Surface it as an
        // `exhausted` exit so callers know to retry with a higher cap or
        // route to compaction (M2).
        if (collected.tool_uses.length === 0) {
          if (collected.stop_reason === 'max_tokens') {
            return await finish(
              'maxOutputTokens',
              `provider truncated at max_tokens (cap=${budget.maxOutputTokensPerCall})`,
            );
          }
          return await finish('done');
        }

        // Snapshot before any of this step's tool_uses run. Spec §12 +
        // CHECKPOINTS.md §2.1: granularity is per-step, not per-tool —
        // a refactor of 5 files = 5 edits in the same step ⇒ 1
        // checkpoint that captures the pre-refactor tree, so `/undo`
        // returns the user atomically to the state before the step.
        //
        // Triggers iff at least one declared tool_use's tool has
        // `metadata.writes === true`. We inspect the registry here —
        // not the policy — because the question is "could this step
        // mutate the working tree", and policy denials happen later
        // (in invokeTool). A tool that's about to be policy-denied
        // still doesn't move files, so we'd take a snapshot for nothing
        // — but the no-op skip in CheckpointManager catches it (the
        // working tree didn't change, write-tree matches the prior
        // checkpoint, no row written). Cheap defense in depth.
        //
        // had_bash: true iff at least one tool in this step has side
        // effects that escape cwd (DB writes, network calls, process
        // spawns) — these are NOT reversed by checkpoint restore. The
        // tool's own `metadata.escapesCwd` is the source of truth;
        // the explicit name list (`bash`, `bash_background`,
        // `bash_kill`) is a defense-in-depth fallback for external
        // tool definitions that haven't set the flag yet. Variable
        // name kept as `hadBash` to match the persisted column;
        // `escapesCwd` is the conceptual rename for a future cleanup.
        if (checkpointManager !== undefined) {
          let hasWrites = false;
          let hadBash = false;
          for (const tu of collected.tool_uses) {
            const tool = config.toolRegistry.get(tu.name);
            if (tool === null) continue;
            if (tool.metadata.writes) hasWrites = true;
            if (
              tool.metadata.escapesCwd === true ||
              tu.name === 'bash' ||
              tu.name === 'bash_background' ||
              tu.name === 'bash_kill'
            ) {
              hadBash = true;
            }
          }
          if (hasWrites) {
            // PreCheckpoint hooks (spec AGENTIC_CLI.md §10.1).
            // Fired BEFORE the snapshot so an operator hook can
            // record context (e.g., dump tree of dirty paths,
            // tag the working tree with a marker). Fire-and-
            // forget per spec line 1041 — non-blocking events
            // don't gate the snapshot. The snapshot's git ops
            // (add/commit on the shadow ref) are already
            // optimized; bound any operator latency to their
            // own hook timeout.
            void fireHookChain({
              schema: 'v1',
              event: 'PreCheckpoint',
              sessionId,
              data: { stepN: steps },
            });
            try {
              const outcome = await checkpointManager.snapshot({
                stepId: assistantMsg.id,
                hadBash,
                stepN: steps,
              });
              if (outcome.checkpointId !== null && outcome.gitRef !== null) {
                safeEmit(config.onEvent, {
                  type: 'checkpoint_created',
                  checkpointId: outcome.checkpointId,
                  gitRef: outcome.gitRef,
                  stepId: assistantMsg.id,
                  hadBash,
                });
              }
            } catch {
              // Snapshot failures must not break the step. The most
              // likely cause is a transient git issue (locked refs
              // mid-`git gc`, stale lock file, fs error). The harness
              // proceeds without a checkpoint for this step — `/undo`
              // would skip past it to the prior surviving checkpoint,
              // which is the conservative outcome. The DB row would
              // not have been written (insertCheckpoint is the last
              // step inside snapshot()), so audit stays consistent.
            }
          }
        }

        // Execute every tool_use in this step, collecting results.
        const toolResults: ProviderToolResultBlock[] = [];
        for (const tu of collected.tool_uses) {
          // Same wall-clock-vs-user-abort distinction as the top-of-loop
          // check; otherwise a wall-clock timeout that lands between tool
          // invocations gets misreported as a user abort.
          if (signal.aborted) {
            return isWallClockTimeout()
              ? await finish('maxWallClockMs')
              : await finish('aborted', undefined, 'hard');
          }
          // Cooperative-stop also honored mid-step (1.g.1, D158): if
          // the model returned multiple tool_uses and soft fired
          // after the first one ran, don't keep executing the rest.
          // Already-executed tools' results were appended to the
          // message log via the prior iterations; the loop exits
          // before the next provider call (which would have asked
          // the model to react to a partial set, but the operator
          // already cancelled the conversation). Symmetry with the
          // top-of-loop soft check.
          // Re-check via local assignment forces TS to re-narrow on
          // every iteration — without this, the outer top-of-loop
          // check would have narrowed `aborted` to false at this
          // scope. The Set/get is on a live AbortSignal so the value
          // genuinely changes between iterations.
          const softAborted = config.softStopSignal?.aborted;
          if (softAborted) {
            return await finish('aborted', undefined, 'soft');
          }

          // Degenerate-loop detection: hash this call and check the sliding
          // window. We do this BEFORE invocation so we can refuse cheaply.
          const h = hashToolCall(tu.name, tu.input);
          recentToolHashes.push(h);
          if (recentToolHashes.length > HASH_WINDOW) recentToolHashes.shift();
          const repeats = recentToolHashes.filter((x) => x === h).length;
          if (repeats >= budget.maxRepeatedToolHash) {
            return await finish(
              'degenerateLoop',
              `tool ${tu.name} called ${repeats} times with identical args in last ${HASH_WINDOW} calls`,
            );
          }

          // spawnSubagent closure: only wired when the caller supplied
          // a subagent registry. The closure binds the *current*
          // sessionId as the parent id at call time so a child knows
          // exactly which session spawned it. Each `task` invocation
          // produces a fresh child session row; recursion is allowed
          // (a child can task() further children) because the child
          // harness propagates the same registry down.
          const spawnSubagentClosure:
            | ((args: SpawnSubagentArgs) => Promise<SpawnSubagentResult>)
            | undefined =
            config.subagentRegistry === undefined
              ? undefined
              : async (args: SpawnSubagentArgs): Promise<SpawnSubagentResult> => {
                  const registry = config.subagentRegistry;
                  if (registry === undefined) {
                    return {
                      kind: 'unknown_subagent',
                      requested: args.name,
                      available: [],
                    };
                  }
                  const def = registry.byName.get(args.name);
                  if (def === undefined) {
                    return {
                      kind: 'unknown_subagent',
                      requested: args.name,
                      available: Array.from(registry.byName.keys()).sort(),
                    };
                  }
                  // Depth check happens here (before runSubagent's
                  // own throw) so the model gets a recoverable tool
                  // error instead of a wrapped exception. The tool
                  // surface distinguishes "you passed a bad name"
                  // (unknown_subagent) from "you nested too deep"
                  // (depth_exceeded) — both are model-fixable.
                  const childDepth = (config.subagentDepth ?? 0) + 1;
                  if (childDepth > MAX_SUBAGENT_DEPTH) {
                    return {
                      kind: 'depth_exceeded',
                      requested: args.name,
                      depth: childDepth,
                      maxDepth: MAX_SUBAGENT_DEPTH,
                    };
                  }
                  // Validate child's whitelist against the ROOT
                  // registry (full toolset), NOT against this
                  // harness's `toolRegistry` (which is narrowed to
                  // OUR own whitelist when we're a subagent). A
                  // coordinator subagent with `tools: [task]` must
                  // still be able to spawn a worker with
                  // `tools: [read_file]` even though it doesn't have
                  // `read_file` itself.
                  const rootRegistry = config.rootToolRegistry ?? config.toolRegistry;
                  const child = await runSubagent({
                    definition: def,
                    prompt: args.prompt,
                    parentSessionId: sessionId,
                    provider: config.provider,
                    parentToolRegistry: rootRegistry,
                    permissionEngine: config.permissionEngine,
                    db: config.db,
                    cwd: config.cwd,
                    // Propagate combined parent signal: a Ctrl+C or
                    // wall-clock timeout on the parent must abort
                    // the child run too. The child builds its own
                    // wall-clock on top of this.
                    signal,
                    // Forward the cooperative-stop signal — wired
                    // here so that when the in-process subagent path
                    // lands (IPC slice unblocks 1.f.2), Esc-during-
                    // task already routes correctly. Today the
                    // subprocess path can't act on a soft signal (no
                    // IPC); the parent blocks on `await runSubagent`
                    // until the child finishes its full budget, then
                    // the parent's top-of-loop soft check exits.
                    // Documented gap (D159).
                    ...(config.softStopSignal !== undefined
                      ? { softStopSignal: config.softStopSignal }
                      : {}),
                    // Forward the registry so the child can task()
                    // further children. Same set, same names.
                    subagentRegistry: registry,
                    // Plan mode is a global property of the run; the
                    // child inherits it so a write tool in its
                    // whitelist still trips the harness gate inside
                    // the child loop. Defense in depth — the parent's
                    // gate already refused `task` itself in plan mode,
                    // but a future bypass would still be contained.
                    ...(config.planMode === true ? { planMode: true } : {}),
                    // Sampling temperature is also a run-wide property.
                    // The harness uses it for its own provider calls
                    // (line ~594); subagent runs MUST inherit so that
                    // eval / automation pipelines pinning
                    // temperature=0 see deterministic behavior across
                    // the entire chain. Without this forward, the
                    // subprocess child would silently fall back to
                    // the provider default and break reproducibility.
                    ...(config.temperature !== undefined
                      ? { temperature: config.temperature }
                      : {}),
                    // Increment depth: the child being spawned is one
                    // level deeper than this run.
                    depth: childDepth,
                  });
                  return {
                    kind: 'ran',
                    output: child.output,
                    sessionId: child.sessionId,
                    status: child.status,
                    reason: child.reason,
                    costUsd: child.costUsd,
                    steps: child.steps,
                    durationMs: child.durationMs,
                    ...(child.auditFailure !== undefined
                      ? { auditFailure: child.auditFailure }
                      : {}),
                    ...(child.worktree !== undefined ? { worktree: child.worktree } : {}),
                    ...(child.worktreeError !== undefined
                      ? { worktreeError: child.worktreeError }
                      : {}),
                  };
                };

          const ctx: ToolContext = {
            signal,
            cwd: config.cwd,
            sessionId,
            stepId: assistantMsg.id,
            permissions: config.permissionEngine.view(),
            permissionCheck: (toolName, category, args) =>
              config.permissionEngine.check(toolName, category, args),
            todoStore,
            ...(bgManager !== undefined ? { bgManager } : {}),
            ...(spawnSubagentClosure !== undefined ? { spawnSubagent: spawnSubagentClosure } : {}),
            ...(config.memoryRegistry !== undefined
              ? { memoryRegistry: config.memoryRegistry }
              : {}),
            ...(config.confirmMemoryWrite !== undefined
              ? { confirmMemoryWrite: config.confirmMemoryWrite }
              : {}),
            ...(config.confirmMemoryUserScope !== undefined
              ? { confirmMemoryUserScope: config.confirmMemoryUserScope }
              : {}),
            // Trust state — required on ToolContext, optional on
            // HarnessConfig. Default-false at the harness layer is
            // the fail-closed answer when bootstrap (or a test
            // harness) didn't supply one.
            isCwdTrusted: config.isCwdTrusted ?? false,
            // Operator-facing warn channel. Closure captures the
            // current tool call's id + name so the adapter can
            // attribute the warning to the right invocation.
            // Always wired — tools that don't use it just don't
            // call it. Optional in ToolContext for headless / SDK
            // contexts that don't construct via the harness; here
            // we always set it because we know the onEvent sink.
            emitWarn: (message: string) =>
              safeEmit(config.onEvent, {
                type: 'tool_warning',
                toolUseId: tu.id,
                toolName: tu.name,
                message,
              }),
          };

          safeEmit(config.onEvent, {
            type: 'tool_invoking',
            toolUseId: tu.id,
            toolName: tu.name,
            args: tu.input,
          });

          const inv = await invokeTool(
            {
              toolUseId: tu.id,
              toolName: tu.name,
              args: tu.input,
              messageId: assistantMsg.id,
            },
            {
              db: config.db,
              registry: config.toolRegistry,
              engine: config.permissionEngine,
              ctx,
              ...(config.planMode === true ? { planMode: true } : {}),
              ...(config.confirmPermission !== undefined
                ? { confirmPermission: config.confirmPermission }
                : {}),
              fireHook: fireHookChain,
              signal,
            },
          );

          if (inv.decision !== null) {
            safeEmit(config.onEvent, {
              type: 'tool_decided',
              toolUseId: tu.id,
              decision: inv.decision,
            });
          }
          safeEmit(config.onEvent, {
            type: 'tool_finished',
            toolUseId: tu.id,
            toolName: tu.name,
            failed: inv.failed,
            durationMs: inv.durationMs,
            ...(inv.denied === true ? { denied: true } : {}),
          });

          toolResults.push(inv.toolResult);
          if (inv.failed) {
            consecutiveErrors += 1;
          } else {
            consecutiveErrors = 0;
          }

          if (consecutiveErrors >= budget.maxToolErrors) {
            // Persist the partial tool_result message before bailing so the
            // session history reflects what actually happened. Mirror it in
            // the in-memory `messages` array for symmetry with the normal
            // path; nothing reads it post-bail today, but a future refactor
            // that does (resume, replay) gets a consistent view.
            const partialMsg = appendMessage(config.db, {
              sessionId,
              role: 'user',
              parentId: lastMessageId,
              content: toolResults,
            });
            lastMessageId = partialMsg.id;
            messages.push({ role: 'user', content: toolResults });
            return await finish('maxToolErrors', `${consecutiveErrors} consecutive tool errors`);
          }
        }

        // Persist tool_results back as a user message; mirror them in the
        // running provider message list for the next turn.
        const resultMsg = appendMessage(config.db, {
          sessionId,
          role: 'user',
          parentId: lastMessageId,
          content: toolResults,
        });
        lastMessageId = resultMsg.id;
        messages.push({ role: 'user', content: toolResults });

        // Compaction trigger check. Estimate the FULL outbound prompt
        // — messages + system + tool schemas — against the threshold.
        // Tool schemas alone run 2-4k tokens each per CONTEXT_TUNING.md
        // §2.1; a long system prompt adds another 0.5-3k. Counting only
        // `messages` undercounts the trigger and lets the next request
        // sail over the cap when the surrounding overhead is what's
        // pushing it close.
        //
        // estimatePromptTokens is the local chars/4 heuristic: free
        // (no HTTP), conservative (overestimates by ~10-25% vs real
        // tokenizers), good enough for a 70%-of-window threshold that
        // already includes a buffer.
        //
        // DB messages stay untouched; only the in-memory `messages`
        // array sent to the provider gets rewritten. Audit + replay can
        // re-derive from the full history if they ever need a different
        // compaction policy.
        // Skip when the budget is exhausted: compaction would issue a
        // billed summary call right before the loop's top-of-iteration
        // check exits with `maxSteps` anyway. Same logic as the
        // signal.aborted guard — don't burn tokens on work whose
        // result will never be used.
        if (
          !signal.aborted &&
          steps < budget.maxSteps &&
          config.provider.capabilities.context_window > 0
        ) {
          const promptTokens = estimatePromptTokens(messages, {
            ...(config.systemPrompt !== undefined ? { system: config.systemPrompt } : {}),
            ...(tools.length > 0 ? { tools } : {}),
          });
          const contextWindow = config.provider.capabilities.context_window;
          const triggerAt = budget.compactionThreshold * contextWindow;
          // Guard: requires at least goal + something-to-fold + an
          // assistant boundary for the tail. compactMessages will skip
          // (and emit a noisy started/finished pair) for shorter
          // histories; check here so we don't fire the events at all.
          // `+ 2` accounts for the assistant-boundary alignment the
          // module performs — naive `1 + tail` could pass even when
          // the alignment shift collapses the middle to empty.
          if (promptTokens > triggerAt && messages.length >= budget.compactionPreserveTail + 3) {
            safeEmit(config.onEvent, {
              type: 'compaction_started',
              promptTokens,
              threshold: triggerAt,
              contextWindow,
            });
            const compactStart = Date.now();
            const compaction = await compactMessages(config.provider, messages, {
              preserveTail: budget.compactionPreserveTail,
              signal,
            });
            // In-place replace so the caller's reference (none today,
            // but defensive) sees the new history without reassignment.
            messages.length = 0;
            messages.push(...compaction.messages);

            // Compaction's LLM call (when it ran) is a billed provider
            // request — fold its usage into session totals. Skipping
            // this would systematically underreport spend on every
            // compacting session, defeating the whole point of the
            // per-session cost tracking. The 'skipped' strategy never
            // made a call so contributes zero (emptyUsage); 'fallback'
            // contributes whatever partial usage arrived before the
            // failure (some providers emit usage on stream errors).
            const compactionCost = computeCost(config.provider.capabilities, compaction.usage);
            totalUsage = addUsage(totalUsage, compaction.usage);
            totalCostUsd += compactionCost;
            // If the compaction call MADE a provider request (llm or
            // fallback strategy) but didn't see usage telemetry, the
            // session total is now a lower bound — same conservative
            // logic as the per-turn check.
            if (compaction.strategy !== 'skipped' && !compaction.usageSeen) {
              usageComplete = false;
            }

            const finishedEvent: HarnessEvent = {
              type: 'compaction_finished',
              strategy: compaction.strategy,
              foldedCount: compaction.foldedCount,
              durationMs: Date.now() - compactStart,
              usage: compaction.usage,
              costUsd: compactionCost,
              ...(compaction.reason !== undefined ? { reason: compaction.reason } : {}),
            };
            safeEmit(config.onEvent, finishedEvent);

            // Compaction's billed call can push the cumulative
            // total past the cap on its own. Check after the
            // event is emitted (renderers should still see the
            // compaction_finished event) but before the next
            // top-of-loop iteration would issue a provider call.
            const overage = costCapDetailIfExceeded();
            if (overage !== null) return await finish('maxCostUsd', overage);
          }
        }
      }
    } catch (e) {
      return await guardedFinish(e);
    }
  } finally {
    // Drain the lazy retention sweep BEFORE anything else in the
    // finally fires. The caller (cli/run.ts) is allowed to close the
    // DB right after runAgent returns; without this drain the purge
    // would race against db.close() and hit a closed sqlite handle.
    // The .catch() chain at construction already absorbed errors, so
    // the await here is purely a synchronization point.
    if (checkpointsPurgeInFlight !== undefined) {
      try {
        await checkpointsPurgeInFlight;
      } catch {
        // Already swallowed at construction; defensive.
      }
    }
    if (bgManager !== undefined) {
      try {
        await bgManager.cleanup();
      } catch {
        // Best-effort; cleanup failures must not mask the run result
        // or escape the harness boundary. Any zombies left behind
        // are visible via the background_processes audit table.
      }
    }
    // Defensive: drop the in-memory TodoList for this session.
    // The store is currently a function-local Map (created on
    // line ~125) so GC reclaims it when runAgent returns — the
    // clear is redundant in today's ownership model. Kept for
    // forward compatibility: if the store is ever hoisted to a
    // process-level singleton (e.g., daemon mode running multiple
    // sessions in one process), this hook is what prevents
    // accumulation. Idempotent on unknown / empty sessionId.
    todoStore.clear(sessionId);
  }
};
