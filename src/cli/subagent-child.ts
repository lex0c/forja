import { type HarnessEvent, type HarnessResult, runAgent } from '../harness/index.ts';
import type { RunBudget } from '../harness/types.ts';
import { resolveHookConfig, resolveHookPaths } from '../hooks/index.ts';
import {
  createMemoryRegistry,
  evaluateBootTriggers,
  resolveRepoRoot,
  resolveScopeRoots,
} from '../memory/index.ts';
import { mergeTrustedHosts } from '../permissions/bootstrap-engine.ts';
import { parseCapability } from '../permissions/capabilities.ts';
import { createPermissionEngine, createSqliteSink, ensureInstallId } from '../permissions/index.ts';
import { type Provider, createDefaultRegistry } from '../providers/index.ts';
import type { SystemSegment } from '../providers/types.ts';
import {
  type DB,
  closeDb,
  completeSession,
  defaultDbPath,
  getMessage,
  getSession,
  getSubagentRun,
  insertSubagentOutput,
  migrate,
  openDb,
  reclassifySessionStatus,
  setSubagentPayload,
  updateSubagentHeartbeat,
} from '../storage/index.ts';
import {
  hashPromptContent,
  recordPromptVersion,
  resolveAuthor,
} from '../storage/repos/prompt-versions.ts';
import {
  loadSubagents,
  validateOutput,
  validateSubagentSet,
  wrapToolWithRestrictions,
} from '../subagents/index.ts';
import {
  IPC_PROTOCOL_VERSION,
  IPC_VERSION_MISMATCH_EXIT_CODE,
  type IpcChannel,
  type IpcTransport,
  createChannel,
  makeEvent,
  makeSessionFinished,
  makeSessionStart,
  processTransport,
} from '../subagents/ipc.ts';
import {
  type ChildPermissionBridge,
  createChildPermissionBridge,
} from '../subagents/permission-bridge.ts';
import { createRecordingTelemetrySink } from '../telemetry/index.ts';
import { createToolRegistry, registerBuiltinTools } from '../tools/index.ts';
import { assembleMemorySection, composeSystemPrompt } from './memory-prompt.ts';
import { composeWithOutputSchemaBlock } from './output-schema-block.ts';
import { composeWithParallelHint } from './parallel-prompt.ts';
import { composeWithReferenceBlock } from './reference-block.ts';
import { composeWithReflectionBlock } from './reflection-block.ts';

// Subagent-child entry path.
//
// The parent invokes the same binary with `--subagent-session-id
// <uuid>` to spawn an isolated child process. This module is that
// child's main: it reads the session row + audit row the parent
// pre-created, builds a HarnessConfig with `preassignedSessionId`,
// runs the harness loop, and publishes the terminal envelope to
// `subagent_outputs` via `setSubagentPayload`. The parent polls
// the table and converts the payload back into a
// `RunSubagentResult` for its own `task` tool.
//
// Why a separate file instead of branching inside `cli/run.ts`:
//   - The child's bootstrap is fundamentally different from the
//     parent's (no prompt → no instruction parsing, no
//     subagent registry → can't recursively spawn under the
//     same wiring, no plan-mode prompt composition, no
//     renderer / event observer — output flows through SQLite).
//   - Failures in the parent path must NOT touch this code;
//     same shape, the reverse.
//
// Failure handling philosophy:
//   - Every code path that can fail BEFORE the harness loop
//     publishes a `setSubagentPayload({ status: 'error',
//     reason: '<diagnostic>' })` if the row exists. The parent
//     reads the payload and converts it to a tool error; without
//     this, the parent would see "no payload yet" until its own
//     timeout fires.
//   - Failures AFTER the harness loop also publish — the loop's
//     own error result becomes the payload directly.
//   - If the row doesn't exist (caller bug, no FK target), we
//     can't publish; print to stderr and exit non-zero so the
//     parent's spawn.exited promise resolves with a meaningful
//     code.

export interface SubagentChildOptions {
  sessionId: string;
  // Test seam: skip provider registry lookup. Production callers
  // pass nothing — the registry resolves from sessions.model.
  providerOverride?: Provider;
  // Test seam: override the DB path. Production uses
  // defaultDbPath() so child + parent target the same file.
  dbPath?: string;
  // Test seam: drop a non-empty stderr write through this sink
  // instead of process.stderr. Tests collect the diagnostic
  // strings; production writes to the real stderr.
  errSink?: (s: string) => void;
  // Note: NO `enterprisePolicyPath` / `userPolicyPath` test
  // seams. Migration 015 moved policy resolution to the parent;
  // the child reads the snapshot off `subagent_runs`. Tests
  // that want a specific policy seed it via the parent's
  // `insertSubagentRun(..., policySnapshot: ...)` call.
  //
  // Test seams for subagent discovery — same shape as bootstrap.
  // `null` disables the layer entirely (useful for tests that
  // shouldn't touch the host's ~/.config/agent or repo .agent
  // directories).
  userAgentsDir?: string | null;
  projectAgentsDir?: string | null;
  // Recursion depth THIS child is running at. The parent's
  // `runSubagent` computes the depth before spawning and passes
  // it via `--subagent-depth <n>`. Without this, every
  // subprocess would reset depth to 0 and a chain of subprocess
  // subagents could nest beyond MAX_SUBAGENT_DEPTH (each child
  // sees its own task() invocations starting from 0). Threading
  // it through here closes the cross-process gap. Defaults to
  // 0 when omitted (top-level shape) — consistent with the
  // harness's own `subagentDepth ?? 0` semantics.
  depth?: number;
  // Sampling temperature for this child. Carried across via
  // `--subagent-temperature <n>`. Undefined means "use the
  // provider default" — same semantics as omitting temperature
  // on a top-level harness. Eval pipelines pin this to 0 for
  // determinism; without propagation, a subprocess child would
  // silently ignore the parent's temperature override and run
  // non-deterministically.
  temperature?: number;
  // Plan-mode flag from the parent. Carried across via
  // `--subagent-plan-mode` (presence-only). When true, the
  // child's harness loop refuses any tool whose metadata
  // declares `writes:true` (or `planSafe:false`) BEFORE
  // execution — defense in depth that doubles up with the
  // top-level task tool's planSafe:false gate. Without this
  // propagation, a programmatic caller invoking runSubagent
  // with planMode:true would see writing tools execute in the
  // child unchecked.
  planMode?: boolean;
  // Trust verdict carried across via `--subagent-cwd-trusted`
  // (presence-only). The parent resolved trust at bootstrap
  // against `~/.config/agent/trust.json`; the child can't
  // re-resolve correctly because (a) worktree-isolated
  // subagents have a cache-dir cwd that's never on the trust
  // list, and (b) re-reading mid-run could observe a different
  // verdict if the operator updated trust between spawn and
  // child startup. Same drift-window argument as the policy
  // and hook snapshots. Absent ⇒ child defaults
  // `isCwdTrusted=false` (fail-closed); tools gating on trust
  // (memory_write inferred-source refusal) deny accordingly.
  cwdTrusted?: boolean;
  // Parent's shared-corpus trust verdict forwarded via
  // `--subagent-shared-scope-offline` (S5 CRIT/H3). When true,
  // the child mirrors the parent's fail-closed posture by
  // excluding `project_shared` from BOTH the eager-load section
  // AND the `retrieve_context` tool surface. Without this, a
  // child's separate `assembleMemorySection` call would re-read
  // disk and surface shared bodies the parent specifically
  // gated. Absence = false (parent confirmed OR ran without a
  // probe). The flag is presence-only; the spawn factory emits
  // it only when the parent's outcome is non-confirmed.
  sharedScopeOffline?: boolean;
  // Per-subagent background-process log directory passed across
  // via `--subagent-bg-log-dir <path>`. The harness wires it
  // into the bg manager so `bash_background` / `bash_output` /
  // `bash_kill` / process-aware `wait_for` and `monitor` work
  // for subagent runs. The directory is namespaced under the
  // PARENT's `.agent/bg/<sessionId>/` (computed by the parent's
  // runSubagent), so concurrent children don't collide and the
  // operator's `bg list` view from the project root continues
  // to show only the parent's processes — a child's processes
  // live under their session's subdirectory and never leak
  // into the parent's bg state. Undefined when omitted (older
  // parents, tests that exercise the bg-disabled path).
  bgLogDir?: string;
  // Parent's cwd, used to anchor the child's MemoryRegistry roots.
  // Memory is per-repo logically, not per-worktree — without this
  // forwarding, a worktree-isolated subagent would build its
  // registry from the worktree path and lose access to
  // project_local (gitignored, not replicated). When set, the
  // child resolves `resolveScopeRoots(<this path>)` for the roots
  // but anchors the audit `cwd` field to its OWN session.cwd so
  // forensic queries can distinguish "where the read happened"
  // from "which project's memory tree". Undefined disables memory
  // wiring (memory_* tools surface registry_unavailable, system
  // prompt has no memory section).
  memoryCwd?: string;
  // IPC protocol version when the parent enabled the live
  // channel (spec docs/spec/IPC.md). Set by the parser from the
  // `--ipc=<n>` flag. Undefined ⇒ legacy mode: child does not
  // open the channel; communication stays SQLite-only.
  // Mismatched versions (child only knows version 1, parent
  // requested 2) abort the run with `ipc_version_mismatch`
  // before any harness work — spec §4.2 requires the refusal
  // before the first message.
  ipcVersion?: number;
  // Test seam: inject a custom transport so the IPC layer can
  // be exercised without owning real stdin/stdout. Production
  // omits and falls back to `processTransport()` over the
  // process's standard streams.
  ipcTransportFactory?: () => IpcTransport;
}

// Cadence at which the child writes `last_heartbeat` to its
// `subagent_outputs` row. The parent's poller compares the
// most recent value against `Date.now()` and treats a gap >
// HEARTBEAT_STALE_THRESHOLD_MS (defined in subagents/wait-loop.ts) as
// evidence the child has hung — typically inside a wedged
// provider call or a long sync block — and escalates SIGTERM →
// grace → SIGKILL. The cadence must be substantially smaller
// than the threshold (so a single delayed write doesn't trip
// detection) and substantially larger than the cost of one
// SQLite UPDATE (~µs on indexed columns). 2000ms balances
// detection latency (a hung child surfaces in single-digit
// seconds) against overhead (~30 SQLite UPDATEs per minute
// per active subagent).
const HEARTBEAT_CADENCE_MS = 2000;

// Build the envelope shape the parent's `runSubagent` expects to
// reconstruct. Mirrors the field set of `RunSubagentResult` but
// flattened into a JSON-friendly object — the runtime parses it
// back into the discriminated result on the parent side.
const buildEnvelope = (result: HarnessResult, output: string): Record<string, unknown> => ({
  status: result.status,
  reason: result.reason,
  output,
  cost_usd: result.costUsd,
  steps: result.steps,
  duration_ms: result.durationMs,
  // last_message_id surfaced for payload-only diagnostics —
  // the output is already extracted on the child side, so the
  // parent doesn't strictly need the id, but it's useful when
  // inspecting the envelope post-hoc.
  ...(result.lastMessageId !== undefined ? { last_message_id: result.lastMessageId } : {}),
  // Abort discriminator. Populated only when
  // the harness's loop exited via `reason === 'aborted'`. Lets
  // the parent's `RunSubagentResult` carry the soft/hard
  // verdict the child itself observed — without this round-trip
  // the parent could only guess from "did the child exit before
  // grace expired?" which collapses honest cases (slow flush,
  // disk contention) into "hard".
  ...(result.abortCause !== undefined ? { abort_cause: result.abortCause } : {}),
  // Diagnostic detail forwarded from `HarnessResult.detail`. The
  // child's `finish('providerError', detail)` (loop.ts) sets
  // this to the actual error message; without forwarding it
  // across IPC the parent's `task` / `task_await` error string
  // could only show the categorical reason ("providerError"),
  // and the operator had to grep audit logs to learn the
  // specific cause. Absent for successful / detail-less paths.
  ...(typeof result.detail === 'string' && result.detail.length > 0
    ? { detail: result.detail }
    : {}),
});

// `content` is JSON-parsed at the row layer, so we receive the
// structured form directly: string, array of blocks, or
// unparseable falls through to ''.
const extractFinalOutput = (db: DB, lastMessageId: string | undefined): string => {
  if (lastMessageId === undefined || lastMessageId.length === 0) return '';
  const msg = getMessage(db, lastMessageId);
  if (msg === null || msg.role !== 'assistant') return '';
  const parsed = msg.content;
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) {
    const parts: string[] = [];
    for (const block of parsed) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join('').trim();
  }
  return '';
};

// The actual entry. Returns the exit code the runtime should hand
// to process.exit. Never throws — pre-loop failures route through
// the error envelope (when the outputs row exists) or stderr
// (when even that isn't possible).
// Compute the budget that REMAINS for an output_schema retry
// after the first runAgent pass exits cleanly with `done`.
// `maxCostUsd` stays untouched because the harness gates cost
// cumulatively across a resumed session (priorCostUsd loaded
// from the row at line ~640 of harness/loop.ts), but `maxSteps`
// and `maxWallClockMs` reset per runAgent call — the steps
// counter starts at 0 and the wall-clock timer is fresh — so
// passing the original budget verbatim would give the retry a
// SECOND full window and let a single playbook invocation
// exceed its declared step / time envelope.
//
// `skip: true` when any dimension is depleted (≤ 0 after
// subtraction): the first run already used the declared
// envelope, and a 0-step / 0-time retry would just trip its own
// cap immediately — better to surface playbook.output_invalid
// against the first output than to spend another provider call
// producing a maxSteps / maxWallClockMs result.
//
// Exported for unit-testing the arithmetic without standing up
// a real harness loop. Production callers use it from inline in
// `runSubagentChild` below.
// `Partial<RunBudget> & { maxSteps: number }` mirrors the shape
// subagent-child constructs at the runAgent call site (where
// the harness fills in any missing optional caps from
// DEFAULT_BUDGET). We require maxSteps so the arithmetic is
// well-defined.
type RetryBudgetInput = Partial<RunBudget> & { maxSteps: number };

export const computeSchemaRetryBudget = (
  budget: RetryBudgetInput,
  spent: { steps: number; durationMs: number },
): { skip: true } | { skip: false; budget: RetryBudgetInput } => {
  const remainingSteps = budget.maxSteps - spent.steps;
  const remainingWallMs =
    budget.maxWallClockMs !== undefined ? budget.maxWallClockMs - spent.durationMs : undefined;
  const wallExhausted = remainingWallMs !== undefined && remainingWallMs <= 0;
  if (remainingSteps <= 0 || wallExhausted) {
    return { skip: true };
  }
  return {
    skip: false,
    budget: {
      ...budget,
      maxSteps: remainingSteps,
      ...(remainingWallMs !== undefined ? { maxWallClockMs: remainingWallMs } : {}),
    },
  };
};

export const runSubagentChild = async (opts: SubagentChildOptions): Promise<number> => {
  const errSink = opts.errSink ?? ((s: string) => process.stderr.write(s));
  const dbPath = opts.dbPath ?? defaultDbPath();

  // IPC channel — opened only when the parent enabled the live
  // wire via `--ipc=<n>`. Spec §4.2: a child that doesn't
  // recognize the requested protocol version refuses BEFORE
  // emitting any message. We pin to IPC_PROTOCOL_VERSION; future
  // bumps land here as a switch on accepted versions.
  let ipcChannel: IpcChannel | undefined;
  if (opts.ipcVersion !== undefined) {
    if (opts.ipcVersion !== IPC_PROTOCOL_VERSION) {
      errSink(
        `forja: subagent-child: ipc_version_mismatch — parent requested ${opts.ipcVersion}, child only speaks ${IPC_PROTOCOL_VERSION}\n`,
      );
      // Belt-and-suspenders finalize: the parent's runSubagent
      // wait loop ALSO finalizes via completeSession near the
      // end of its outcome handler, so this is redundant on the
      // happy parent path. But if the parent itself crashes
      // between spawn and that handler (e.g., the operator's
      // SIGINT killed the parent process group while the child
      // was refusing version), the session row would otherwise
      // sit in 'running' indefinitely. Every other early-refusal
      // path in this function calls finalizeAsError for the
      // same reason; the version-mismatch path was the outlier.
      // Open + close DB just for this finalize since the regular
      // try/finally hasn't started yet.
      try {
        const db = openDb(dbPath);
        try {
          migrate(db);
          completeSession(db, opts.sessionId, 'error', 0, true);
        } finally {
          closeDb(db);
        }
      } catch {
        // Best-effort: if the DB is unhealthy or migration
        // fails, the parent's wait loop is the next safety
        // net.
      }
      // Exit with the dedicated `EX_USAGE` sentinel so the
      // parent's wait loop can distinguish a version-mismatch
      // refusal from a generic crash. Spec §4.2 mandates the
      // child refuses BEFORE emitting any IPC message, so the
      // exit code is the only signal channel; without this,
      // mixed-version deployments surface as `subprocess_crashed`
      // and the handshake's diagnostic value is lost exactly
      // for the startup-refusal case.
      return IPC_VERSION_MISMATCH_EXIT_CODE;
    }
    const transport = opts.ipcTransportFactory?.() ?? processTransport();
    ipcChannel = createChannel(transport);
    // Spec §4.2: the first message a child emits is session_start
    // (no explicit handshake). Sending it here — before any DB or
    // harness work — guarantees the parent sees the bracket open
    // even if the child immediately fails on a missing row, an
    // unknown model, etc. The corresponding session_finished
    // lands in the outer finally, regardless of which path exited.
    ipcChannel.send(makeSessionStart(opts.sessionId));
  }

  // Soft/hard abort controllers. Local to the child run and
  // wired into the harness's `signal` / `softStopSignal` config
  // fields. The IPC channel routes parent commands here:
  //   - `interrupt:soft` aborts `softStopController` → harness
  //     exits at next step boundary, no preempted in-flight tool.
  //   - `interrupt:hard` aborts `signalController` → harness
  //     preempts in-flight work via AbortSignal propagation
  //     through the provider call.
  //   - `shutdown` is a fast-path of hard followed by EOF; it
  //     also flips `signalController` so any in-flight provider
  //     call sees the abort.
  // Both controllers stay constructed even when IPC is off — the
  // channel just never aborts them. Cheap (constructor only) and
  // keeps the harness config branch simple.
  const signalController = new AbortController();
  const softStopController = new AbortController();
  // Permission proxy bridge — only constructed when IPC is on.
  // Without the channel there's no way to round-trip a confirm
  // verdict to an operator, so the harness config's
  // `confirmPermission` stays unset and `invoke-tool.ts:341`
  // collapses confirm verdicts to denials (the legacy headless
  // behavior). Spec docs/spec/IPC.md §7: every positive answer
  // must originate from a human at the parent's modal — the
  // bridge enforces that by being the ONLY producer of `true`
  // for a confirm verdict in a child.
  let permissionBridge: ChildPermissionBridge | undefined;
  if (ipcChannel !== undefined) {
    ipcChannel.onMessage((msg) => {
      if (msg.type === 'interrupt:soft') {
        // Idempotent — AbortController.abort() on an already-
        // aborted signal is a no-op. Spec §3.1: "Idempotente —
        // múltiplos `interrupt:soft` são no-op após o primeiro."
        softStopController.abort();
      } else if (msg.type === 'interrupt:hard') {
        signalController.abort();
      } else if (msg.type === 'shutdown') {
        // Spec §3.1: shutdown is "fast-path do interrupt:hard +
        // EOF no stdin". Aborting the hard signal is enough; the
        // channel close that follows the parent's send will close
        // our stdin reader and the outer finally will run.
        signalController.abort();
      }
      // permission:answer messages are routed by the bridge's
      // own onMessage subscription (constructed below); no work
      // for this listener.
    });
    permissionBridge = createChildPermissionBridge({
      channel: ipcChannel,
      signal: signalController.signal,
      errSink,
    });
  }

  const db = openDb(dbPath);
  let envelopePublished = false;
  // Track whether the outputs row was inserted so the catch path
  // can publish a final error envelope without a missing-row throw.
  let outputsRowInserted = false;
  // Background heartbeat writer. Set after the outputs row exists
  // (insertSubagentOutput is the precondition), cleared in the
  // outer finally so it never outlives the run. The handle stays
  // unref'd so it doesn't pin the event loop alive past the
  // child's exit (Bun timers are ref'd by default; same reason
  // we unref the SIGKILL escalation in waitForChild).
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // Finalize the child session as error before any pre-harness
  // exit path returns 1. Without this, the row stays in
  // 'running' and pollutes `--list-sessions` until something
  // else (parent polling, future stale-session sweeper) claims
  // it. If the parent ALSO crashed, the row would sit there
  // indefinitely. Best-effort: completeSession's
  // `WHERE status='running'` guard makes it idempotent (no-op
  // if already finalized) and the swallow handles missing rows
  // / closed DBs / schema drift — the diagnostic on stderr is
  // the authoritative signal.
  const finalizeAsError = (): void => {
    try {
      completeSession(db, opts.sessionId, 'error', 0, true);
    } catch {
      // ignore — row may be missing, already finalized, or
      // the DB handle may be unhealthy (the outer finally
      // closes it regardless).
    }
  };

  try {
    migrate(db);

    const session = getSession(db, opts.sessionId);
    if (session === null) {
      // Row doesn't exist — nothing to finalize. The parent
      // wired a stale or fictional id; that's the parent's
      // bug to surface.
      errSink(`forja: subagent-child: session ${opts.sessionId} not found in DB\n`);
      return 1;
    }
    if (!session.isSubagent) {
      // Session row exists but belongs to a top-level run, NOT
      // a subagent flow. Finalizing it as 'error' here would
      // corrupt a session the user cares about. Refuse without
      // touching the row.
      errSink(
        `forja: subagent-child: session ${opts.sessionId} is not a subagent (parent_session_id is null)\n`,
      );
      return 1;
    }
    if (session.status !== 'running') {
      // Already finalized — nothing to do. finalizeAsError's
      // status='running' guard would no-op anyway, but skipping
      // keeps the intent explicit.
      errSink(
        `forja: subagent-child: session ${opts.sessionId} is in status '${session.status}', expected 'running'\n`,
      );
      return 1;
    }

    const audit = getSubagentRun(db, opts.sessionId);
    if (audit === null) {
      errSink(
        `forja: subagent-child: no subagent_runs row for session ${opts.sessionId}; parent must insert audit before spawn\n`,
      );
      finalizeAsError();
      return 1;
    }

    // Insert the outputs row FIRST. From this point on, every
    // failure path can publish a payload — the parent gets
    // structured diagnostics instead of "no payload, timed out".
    insertSubagentOutput(db, { sessionId: opts.sessionId });
    outputsRowInserted = true;

    // Start the background heartbeat. Runs orthogonally to the
    // harness loop so a wedged provider call (event loop
    // proceeding, but tool execution blocking inside async I/O)
    // still produces pulses — UNLESS the wedge is in sync code
    // that blocks the loop itself, which is the failure mode
    // staleness detection is designed to catch. The first beat
    // fires after HEARTBEAT_CADENCE_MS, NOT immediately, because
    // `insertSubagentOutput` already stamped `created_at` and
    // the parent's poller treats `last_heartbeat IS NULL` as
    // "not yet pulsed" (not as "stale"). Errors from
    // updateSubagentHeartbeat are swallowed: a transient SQLite
    // hiccup must not crash the harness loop, and the parent's
    // wall-clock ceiling is the outer safety net for "heartbeat
    // somehow stops despite child being alive".
    heartbeatTimer = setInterval(() => {
      try {
        updateSubagentHeartbeat(db, opts.sessionId);
      } catch {
        // ignore — see comment above
      }
    }, HEARTBEAT_CADENCE_MS);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    // Resolve the provider. Use the model recorded on the
    // session row (the parent picked it at spawn time); this is
    // the only way we know which model the parent intended.
    //
    // No silent fallback to a default model. If the child's
    // registry doesn't recognize `session.model`, refuse loud:
    // running on a different provider than what's persisted
    // on the row corrupts cost attribution (pricing is per-
    // model) and breaks audit forensics ("which model was
    // this run actually using?" must match `sessions.model`).
    // Drift causes:
    //   - Parent uses a model id only registered in its own
    //     process (custom providerOverride during dev/eval)
    //     and forgets to register it in the child path.
    //   - Future model id rename where parent and child
    //     binaries are out of sync (e.g., during a phased
    //     rollout).
    // Either case, the right behavior is to fail the run with
    // a clear envelope and let the operator fix the
    // misconfiguration.
    let provider: Provider;
    if (opts.providerOverride !== undefined) {
      provider = opts.providerOverride;
    } else {
      const registry = createDefaultRegistry();
      const entry = registry.get(session.model);
      if (entry === null) {
        const envelope = {
          status: 'error',
          reason: 'unknown_model',
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
          message: `unknown model: ${session.model}`,
        };
        setSubagentPayload(db, opts.sessionId, envelope);
        envelopePublished = true;
        errSink(`forja: subagent-child: unknown model ${session.model}\n`);
        finalizeAsError();
        return 1;
      }
      provider = entry.factory();
    }

    // Build the permission engine from the SNAPSHOT the parent
    // persisted on subagent_runs (migration 015). We deliberately
    // do NOT call `resolvePolicy(...)` here — re-resolving the
    // .agent/permissions.yaml + enterprise + user layers would
    // open a drift window: a human edit between parent spawn
    // and child startup could run the child under different
    // rules than the parent had validated. The snapshot
    // collapses that window to zero — the rules are sealed at
    // spawn time. Locked sections, strict-mode defaults,
    // matched paths — all carry over byte-for-byte.
    //
    // §10.1 effective envelope (migration 040, slice 95). The
    // parent persisted the intersection result on the audit row;
    // we parse each string back into a Capability and configure
    // the engine. A malformed entry (shouldn't happen — parent
    // formatted via `formatCapability`) collapses the array to
    // empty (pure-LLM bound) rather than letting the child run
    // with an unparseable envelope; safer to over-restrict than
    // re-open the §10.1 gap on a corrupt row.
    let effectiveCapabilitiesParsed: ReturnType<typeof parseCapability>[] | undefined;
    if (audit.effectiveCapabilities !== null) {
      try {
        effectiveCapabilitiesParsed = audit.effectiveCapabilities.map(parseCapability);
      } catch {
        effectiveCapabilitiesParsed = [];
      }
    }
    // Slice 125 (R2 P0-9): wire the audit sink so child engine
    // decisions enter the `approvals_log` chain. Pre-slice the
    // child engine defaulted to createNoopSink(), so every child
    // decision vanished — §17 replay couldn't find them, §7.2
    // chain integrity coverage stopped at the parent's last seq.
    //
    // The child re-derives install_id via `ensureInstallId` (same
    // path the parent uses; idempotent). The same `db` handle the
    // child opened above feeds the sink — child + parent write
    // to the same physical chain, ordered by their own append.
    let childSink: ReturnType<typeof createSqliteSink> | undefined;
    try {
      const identity = ensureInstallId({ env: process.env });
      childSink = createSqliteSink({ db, identity });
    } catch (e) {
      // ensureInstallId can fail if HOME/$XDG_CONFIG_HOME aren't
      // writable. We fall through to a noop audit (preserves pre-
      // slice behavior); the child still runs but its decisions
      // won't enter the chain. The parent's spawn path would have
      // already caught the same fs issue, so this branch is
      // exceptionally rare in practice.
      //
      // Slice 127 (R3 P1): log the failure to errSink so operator
      // forensics has a signal. Pre-slice the catch was silent;
      // a stuck-in-this-branch child runs invisibly to the chain
      // with no operator-visible diagnostic.
      const msg = e instanceof Error ? e.message : String(e);
      errSink(
        `forja subagent-child: install_id discovery failed — child running with noop audit (decisions will NOT enter approvals_log chain): ${msg}\n`,
      );
      childSink = undefined;
    }

    // Slice 125 (R2 P0-10): wire a telemetry sink so child harness
    // events (sandbox.degraded_active, permission.decision,
    // classifier.unavailable, state.transition) don't silently
    // drop. The recording sink keeps events in memory; future
    // slices can teach the IPC layer to drain them back to the
    // parent's telemetry channel at session-finished time. Today
    // the events at least surface in the child process for any
    // local observer (e.g., process-level OTEL exporter wrapping
    // bun) instead of vanishing entirely.
    const childTelemetry = createRecordingTelemetrySink();

    // Mirror the parent's trusted-hosts merge so a subagent
    // fetching the same internal CDN as the parent run sees the
    // same risk-score posture. The audit.policySnapshot is the
    // parent's canonical policy committed at spawn and already
    // carries `tools.fetch_url.trusted_hosts`. Without this wire
    // the engine here would fall back to DEFAULT_TRUSTED_HOSTS
    // and surface `untrusted_egress` for the very same host the
    // parent treated as silent — operator-visible divergence
    // between parent and child decisions on identical URLs.
    const childTrustedHosts = mergeTrustedHosts(
      audit.policySnapshot.tools.fetch_url?.trusted_hosts ?? [],
    );

    // Build the full builtin registry BEFORE constructing the
    // engine so the side-effect oracle can consult it. Order
    // matters: the engine's envelope gate uses the oracle on
    // every check, and `effectiveCapabilities` IS populated in
    // child engines, so without the oracle a narrowed subagent
    // could invoke `bash_kill` / `bash_output` (resolver returns
    // caps=[]) outside the envelope. Parity with the bootstrap
    // wiring in `cli/bootstrap.ts`.
    const fullRegistry = createToolRegistry();
    registerBuiltinTools(fullRegistry);

    const permissionEngine = createPermissionEngine(audit.policySnapshot, {
      cwd: session.cwd,
      ...(effectiveCapabilitiesParsed !== undefined
        ? { effectiveCapabilities: effectiveCapabilitiesParsed }
        : {}),
      ...(childSink !== undefined ? { audit: childSink } : {}),
      telemetry: childTelemetry,
      sessionId: opts.sessionId,
      trustedHosts: childTrustedHosts,
      isToolSideEffect: (toolName) => {
        const tool = fullRegistry.get(toolName);
        if (tool === null) return false;
        // `requiresBgManager` rides along with writes/exec — touching
        // bg-process lifecycle (read stdout, send signal) IS a side
        // effect from the envelope's perspective even when the tool's
        // own metadata says writes:false (bash_output reads stdout of
        // a previously-spawned process; a narrowed subagent should
        // not freely consume that stream).
        return (
          tool.metadata.writes === true ||
          tool.metadata.exec === true ||
          tool.metadata.requiresBgManager === true
        );
      },
    });

    // The audit row carries the canonical toolset (`tools_whitelist`)
    // the parent pre-validated and committed. The child rebuilds
    // the registry from that list — NOT by re-loading the
    // definition .md from disk, which could have drifted between
    // spawn and child read.
    const childRegistry = createToolRegistry();
    // Per-playbook tool_restrictions snapshot (`PLAYBOOKS.md` §1.1,
    // migration 024). Wrap every tool in a pre-flight gate that
    // matches argv (or target path) against the playbook's
    // declared allow/deny patterns. Tools without a rule, or with
    // an unknown shape (no extractor) become passthroughs — the
    // wrapper costs one map lookup. Audit row carries the snapshot
    // taken at parent spawn time, so an edit to the .md between
    // spawn and child read can't relax the gates mid-run. Absent
    // (NULL in the column) ⇒ no restrictions; passthrough.
    const restrictions = audit.toolRestrictions ?? undefined;
    for (const toolName of audit.toolsWhitelist) {
      const tool = fullRegistry.get(toolName);
      if (tool === null) {
        const envelope = {
          status: 'error',
          reason: 'unknown_tool',
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
          message: `tool '${toolName}' from snapshot not registered in active builtin set`,
        };
        setSubagentPayload(db, opts.sessionId, envelope);
        envelopePublished = true;
        errSink(`forja: subagent-child: unknown tool '${toolName}' in snapshot\n`);
        finalizeAsError();
        return 1;
      }
      childRegistry.register(wrapToolWithRestrictions(tool, restrictions));
    }

    // Subagent discovery for nested task() calls. ONLY run when
    // the child's whitelist actually includes `task` — gating
    // the load avoids coupling ordinary runs to the health of
    // an unrelated registry. A malformed `.md` under
    // user/project agents would otherwise abort a child whose
    // job was just `read_file` with `subagent_load_failed`,
    // producing a confusing failure mode for runs that have
    // nothing to do with subagent definitions.
    //
    // When `task` IS in the whitelist, loading + validating is
    // load-bearing: without it, the harness's spawn closure
    // stays undefined and every `task()` invocation surfaces
    // `subagent.unavailable`. Validation runs against the full
    // registry built above so a malformed definition fails
    // fast with a structured envelope rather than deferring
    // to first-use. Loading uses the same path as bootstrap
    // (user + project scope, project wins on shadow).
    let subagents: ReturnType<typeof loadSubagents> | undefined;
    const wantsTask = audit.toolsWhitelist.includes('task');
    if (wantsTask) {
      try {
        subagents = loadSubagents({
          cwd: session.cwd,
          ...(opts.userAgentsDir !== undefined ? { userDir: opts.userAgentsDir } : {}),
          ...(opts.projectAgentsDir !== undefined ? { projectDir: opts.projectAgentsDir } : {}),
        });
        validateSubagentSet(subagents.byName.values(), fullRegistry);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSubagentPayload(db, opts.sessionId, {
          status: 'error',
          reason: 'subagent_load_failed',
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
          message: msg,
        });
        envelopePublished = true;
        errSink(`forja: subagent-child: subagent load failed: ${msg}\n`);
        finalizeAsError();
        return 1;
      }
    }

    // Reconstruct the user prompt. The parent persists the prompt
    // as the first user-role message on the child session row;
    // the harness loop normally appends `userPrompt` after init,
    // but with `preassignedSessionId` we must surface the prompt
    // through the same path. Cleanest: the parent leaves the row
    // empty, the child's harness loop builds the user message
    // from `config.userPrompt`. We pull it from the audit-adjacent
    // metadata: the parent stores the prompt in a sessions-extras
    // location… but we don't have one yet. For now, the
    // parent passes the prompt by inserting it as the first
    // message BEFORE spawn; the child's harness then does NOT
    // append a fresh user message (preassignedSessionId path).
    //
    // To keep the existing harness loop unchanged, we set
    // `userPrompt: ''` and rely on the pre-existing message row
    // to seed the conversation. The harness skips appending an
    // empty user message — same as the resume path.
    const userPrompt = '';

    // Memory subsystem wiring. Two preconditions:
    //
    //   1. The parent forwarded `memoryCwd` (older parents and
    //      tests that route around the parent runtime omit it).
    //   2. The subagent's whitelist includes at least one
    //      memory_* tool. A subagent with `tools: [read_file]`
    //      has no way to invoke memory_read/list/search — the
    //      tools aren't in its narrowed registry — so injecting
    //      the memory section would advertise tools the model
    //      can't call AND inflate the prompt with up to ~2k
    //      tokens of irrelevant index. Lean subagents stay lean.
    //
    // When wired, the registry's `roots` anchor at the PARENT's
    // cwd so worktree-isolated subagents see the parent's
    // project_local + project_shared trees (worktrees don't
    // replicate those — local is gitignored, shared is
    // operator-curated state at the project root). The
    // registry's `cwd` for audit emissions anchors at the
    // CHILD's session.cwd so forensic queries can distinguish
    // "where the read happened" (child's worktree) from "which
    // project the memory belongs to" (parent's repo).
    //
    // The injection appends the merged memory section to the
    // audit-snapshot system prompt. The audit snapshot was
    // captured at definition-load time and reflects the parent's
    // policy + the subagent's identity prompt; memory section is
    // dynamic per-run and goes after.
    const wantsMemory = audit.toolsWhitelist.some((t) => t.startsWith('memory_'));
    let memoryRegistry: ReturnType<typeof createMemoryRegistry> | undefined;
    // Three-layer composition mirrors bootstrap.ts (D227): the
    // parallelism hint sits BELOW the subagent's identity prompt
    // (the .md body captured in `audit.systemPrompt`) so the
    // child reads its own role first and the affordance hint
    // second. Without prepending here, exploration subagents
    // (`tools: [read_file, grep, glob]` — the typical case) get
    // the per-tool "Parallel-safe: ..." descriptions but never
    // the meta-rule preamble — exactly the pre-D227 capability-
    // dormant state, just one layer down. Memory section
    // (when applicable) is appended at the bottom by the
    // existing block below.
    // Reference block (`PLAYBOOKS.md` §1.1, migration 026). The
    // playbook author declared a list of paths the model may
    // consult; we render them as a trailing block AFTER the
    // playbook body but BEFORE the parallel hint wraps the whole
    // thing. Composition order ends up:
    //
    //   PARALLEL_HINT
    //   ---
    //   <playbook body>
    //   ---
    //   ## References (read on demand)
    //   <bullet list>
    //
    // ...and memory section (when applicable) gets folded in AFTER
    // by `composeSystemPrompt` below. Reference block sits next
    // to the body because it is metadata about the body's
    // resources; memory is a per-run dynamic and rightly lands
    // last.
    const promptWithReferences = composeWithReferenceBlock(audit.systemPrompt, audit.references);
    // Output-schema block (`PLAYBOOKS.md` §1.2). Sits AFTER the
    // reference block so the model reads role → resources →
    // termination contract in that order. The runtime validates
    // the terminal text against the same schema post-hoc; this
    // is the prompt-side surface only.
    const promptWithSchema = composeWithOutputSchemaBlock(promptWithReferences, audit.outputSchema);
    // Step-reflection block (slice 9, `CONTEXT_TUNING.md`
    // §13.10). Tail position because the cadence applies to
    // every step the model takes; placing it last keeps the
    // instruction proximate when the model decides what to
    // emit at step boundary. `off` / undefined collapses to a
    // passthrough.
    const reflectionMode = audit.contextRecipe?.stepReflection;
    const promptWithReflection = composeWithReflectionBlock(promptWithSchema, reflectionMode);
    let resolvedSystemPrompt = composeWithParallelHint(promptWithReflection);
    // Eager-load inventory captured at assembly so the harness
    // can emit `memory_provenance` rows once the child's session
    // is fully initialized (the loop fires after createSession;
    // for preassigned-session subagents that's a verification
    // step but the same emit-point). Empty array survives the
    // "no memory" / "wantsMemory=false" branch without special
    // casing on the consumer side.
    let eagerExposures: ReturnType<typeof assembleMemorySection>['eagerLoaded'] = [];
    // Snapshot the stable prefix (playbook + reference + schema +
    // reflection + parallel hint) before memory is appended. Same
    // shape as bootstrap.ts emits for the parent: an Anthropic
    // adapter sees two segments and places the breakpoint between
    // them, so a child's `memory_read` mid-run only invalidates the
    // memory segment, not the playbook prefix.
    const stableSegmentText = resolvedSystemPrompt;
    let memorySegmentText = '';
    if (opts.memoryCwd !== undefined && wantsMemory) {
      // Resolve repo root from the parent's cwd. Same fix as
      // bootstrap.ts: parent's invocation cwd may be a subdir
      // within its repo, so anchoring memory roots there would
      // miss every project memory. resolveRepoRoot calls git
      // rev-parse and falls back to the input path when not in
      // a git repo.
      const memoryRoots = resolveScopeRoots(resolveRepoRoot(opts.memoryCwd));
      memoryRegistry = createMemoryRegistry({
        roots: memoryRoots,
        db,
        sessionId: opts.sessionId,
        cwd: session.cwd,
      });
      // Boot triggers probe the subagent's REPO ROOT, not the
      // raw `session.cwd`. Same fix shape as bootstrap.ts: an
      // isolation:none subagent inherits the parent's invocation
      // cwd, which may be a repo subdir (`/repo/src/components/`),
      // so probing there misses root-level files (`.git`,
      // `package.json`, `tsconfig.json`) and silently filters out
      // any project memory tagged with those triggers — even
      // though those memories were loaded from the parent's repo
      // root above. `resolveRepoRoot(session.cwd)` finds the
      // canonical anchor for both isolation modes:
      //   - none:     subagent.cwd === parent's cwd; resolveRepoRoot
      //               walks up to the parent's repo top-level.
      //   - worktree: subagent.cwd === worktree path; rev-parse
      //               from inside a worktree returns the worktree
      //               itself (its own top-level), which carries
      //               the checked-out files like the original.
      const bootContext = evaluateBootTriggers(resolveRepoRoot(session.cwd));
      // Per-playbook memory filter (slice 9). Forwarded into
      // `assembleMemorySection` so the assembled block keeps
      // only entries whose type or trigger tag matches a
      // declared filter value. Absent filter ⇒ existing
      // (unfiltered, post-trust, post-trigger) behavior.
      const memoryFilter = audit.contextRecipe?.memoryFilter;
      const memorySection = assembleMemorySection({
        registry: memoryRegistry,
        bootContext,
        ...(memoryFilter !== undefined ? { memoryFilter } : {}),
        // S5 CRIT/H3: forward parent's fail-closed scope exclusion.
        // The IPC boundary collapsed parent's `excludeScopes:
        // MemoryScope[]` array to a single boolean (only
        // `project_shared` is gated today; cleaner CLI flag than
        // serializing a list). We rehydrate back to the array
        // shape `assembleMemorySection` expects.
        ...(opts.sharedScopeOffline === true ? { excludeScopes: ['project_shared'] as const } : {}),
      });
      resolvedSystemPrompt = composeSystemPrompt(resolvedSystemPrompt, memorySection.text) ?? '';
      eagerExposures = memorySection.eagerLoaded;
      memorySegmentText = memorySection.text;
    }
    // Build the segment list mirroring resolvedSystemPrompt. The
    // invariant `flattenSystemSegments(segments) === systemPrompt`
    // must hold — both adapters and audit see identical bytes.
    const resolvedSystemSegments: SystemSegment[] = [
      { id: 'stable', text: stableSegmentText, cacheBreakpoint: true },
      ...(memorySegmentText.length > 0
        ? [{ id: 'memory' as const, text: memorySegmentText, cacheBreakpoint: true }]
        : []),
    ];

    // Register the subagent's assembled prompt in `prompt_versions`
    // (AUDIT.md §1.3.3) as kind 'playbook'. Idempotent by hash so a
    // re-run of the same playbook with the same composed prompt
    // dedupes to the original row. The hash flows into
    // `HarnessConfig.systemPromptHash` below; the child's harness
    // loop then stamps it on every `messages.prompt_hash` and
    // `tool_calls.prompt_hash` row exactly as the principal does.
    // The seed `messages` row written by the parent in
    // `subagents/runtime.ts` keeps `prompt_hash = NULL` — a known
    // gap (parent doesn't know the child's prompt yet); subsequent
    // turns within the child are correctly stamped.
    let systemPromptHash: string | undefined;
    if (resolvedSystemPrompt.length > 0) {
      systemPromptHash = hashPromptContent(resolvedSystemPrompt);
      recordPromptVersion(db, {
        hash: systemPromptHash,
        kind: 'playbook',
        name: `playbook.${audit.name}`,
        content: resolvedSystemPrompt,
        author: resolveAuthor(),
      });
    } else {
      // Empty composed prompt should not happen in production —
      // `composeWithParallelHint` always returns at least the hint
      // string — but if a future refactor introduces a path that
      // yields an empty `resolvedSystemPrompt`, silently skipping
      // `recordPromptVersion` would make every message and
      // tool_call for this subagent run write `prompt_hash = NULL`,
      // dropping it from the §1.3.5 join. Surface the gap loudly
      // so an operator sees it on stderr rather than discovering it
      // later from the audit's missing rows.
      errSink(
        `forja: subagent-child: empty composed prompt for playbook '${audit.name}'; skipping prompt_versions registration (messages and tool_calls will write prompt_hash=NULL for this run)\n`,
      );
    }

    // Hooks subsystem (spec AGENTIC_CLI.md §10). Three paths,
    // discriminated by `audit.hooksSnapshot` (nullable per
    // migration 020):
    //
    //   1. Snapshot present, non-empty (`[hook, ...]`): parent
    //      forwarded its resolved chain. Use verbatim.
    //   2. Snapshot present, empty (`[]`): parent resolved to
    //      ZERO hooks authoritatively. Use [] — do NOT re-
    //      resolve from disk. A re-resolve here would let an
    //      edit to `hooks.toml` between spawn and this read add
    //      policy the parent never validated, defeating the
    //      drift-prevention this migration exists for in the
    //      hookless-parent case (where any disk hit is a NET
    //      ADDITION of policy).
    //   3. Snapshot absent (`null`): legacy pre-migration row OR
    //      a programmatic caller that didn't model hooks. Re-
    //      resolve from disk anchored at the PARENT's cwd via
    //      `memoryCwd` (when forwarded) or `session.cwd` as
    //      fallback. Surface config warnings on stderr —
    //      preserves spec §10 unbypassable-corp-policy claim
    //      for legacy rows where the disk IS the source of
    //      truth.
    let hookChain: readonly import('../hooks/types.ts').HookSpec[];
    if (audit.hooksSnapshot !== null) {
      hookChain = audit.hooksSnapshot;
    } else {
      const hookAnchor = opts.memoryCwd !== undefined ? opts.memoryCwd : session.cwd;
      const hookRepoRoot = resolveRepoRoot(hookAnchor);
      const resolvedHooks = resolveHookConfig(resolveHookPaths(hookRepoRoot));
      for (const w of resolvedHooks.warnings) {
        const layerFrag = w.layer !== null ? `${w.layer} ` : '';
        errSink(`forja: subagent-child: ${layerFrag}hook ${w.sourcePath}: ${w.message}\n`);
      }
      hookChain = resolvedHooks.hooks;
    }

    const config = {
      provider,
      toolRegistry: childRegistry,
      // The grandchild's whitelist (when this child task()s a
      // worker) validates against `rootToolRegistry`, NOT
      // `toolRegistry` — a coordinator subagent narrowed to
      // `[task]` would otherwise refuse a worker's `[read_file]`
      // because read_file isn't in the coordinator's narrowed
      // view. Mirrors the same plumbing the parent's
      // `runSubagent` does at the top level.
      rootToolRegistry: fullRegistry,
      permissionEngine,
      db,
      cwd: session.cwd,
      systemPrompt: resolvedSystemPrompt,
      systemSegments: resolvedSystemSegments,
      ...(systemPromptHash !== undefined ? { systemPromptHash } : {}),
      userPrompt,
      preassignedSessionId: opts.sessionId,
      // Carry through budget caps from the audit row. Sampling's
      // `max_tokens` (`PLAYBOOKS.md` §1.1) overrides the
      // harness's `maxOutputTokensPerCall` when the playbook
      // declared one — that field IS the per-call output cap the
      // provider receives as `max_tokens`. The harness fills
      // every other RunBudget field from `DEFAULT_BUDGET` when
      // we omit it here, so the spread stays minimal.
      //
      // Cost cap semantics (spec ORCHESTRATION.md §3.5.0): the
      // playbook's declared `max_cost_usd` is forwarded as
      // `softCostUsd` (regression signal — emits a warn event
      // when crossed, does NOT terminate the run), NOT as
      // `maxCostUsd` (hard kill). The child's own `maxCostUsd`
      // is explicitly undefined so the merge propagates
      // "no per-child hard cap"; the parent-side watchdog
      // (§3.5.2) is the single enforcement point for the
      // global cap and will cancelAll if cumulative crosses.
      // This was a deliberate change from earlier behavior
      // where the playbook cap was hard — false-positive kills
      // ("child died at $0.59 of $0.30 cap when parent had
      // $4 free") were discarding useful work.
      budget: {
        maxSteps: audit.budgetMaxSteps,
        maxCostUsd: undefined,
        ...(audit.budgetMaxCostUsd !== null && audit.budgetMaxCostUsd !== undefined
          ? { softCostUsd: audit.budgetMaxCostUsd }
          : {}),
        ...(audit.budgetMaxWallMs !== null ? { maxWallClockMs: audit.budgetMaxWallMs } : {}),
        ...(audit.sampling?.maxTokens !== undefined
          ? { maxOutputTokensPerCall: audit.sampling.maxTokens }
          : {}),
      },
      // Subagent registry forwarded so the child's `task` tool
      // can resolve grandchild names. Without this, the harness
      // loop's spawn closure stays undefined and every nested
      // task() invocation surfaces `subagent.unavailable` —
      // breaking coordinator-style chains.
      //
      // Conditional spread: when `task` isn't in the whitelist
      // we skipped the load above, so `subagents` is undefined.
      // Omitting the field here matches the harness's contract
      // (`subagentRegistry === undefined` ⇒ spawn closure stays
      // undefined ⇒ `task` surfaces `subagent.unavailable`).
      // The whitelist build already excluded `task` in that
      // case, so the ctx never reaches the closure regardless.
      ...(subagents !== undefined ? { subagentRegistry: subagents } : {}),
      // Recursion depth carried across the subprocess boundary
      // by the parent's `runSubagent` (via `--subagent-depth`
      // CLI flag, threaded into `opts.depth` here). Without
      // this, every subprocess child would reset to 0 and any
      // nested task() chain would compute depth from a fresh
      // baseline — bypassing the chain-wide MAX_SUBAGENT_DEPTH
      // guard and allowing runaway fan-out. The harness's
      // spawn closure increments this on the next hop, so a
      // grandchild correctly sees `parentDepth + 1`.
      subagentDepth: opts.depth ?? 0,
      // Sampling temperature precedence:
      //   1. `opts.temperature` (parent-forwarded via
      //      `--subagent-temperature`) — the eval / automation
      //      pipeline pinned the value session-wide; respecting
      //      it preserves determinism across the parent/child
      //      boundary.
      //   2. `audit.sampling.temperature` (`PLAYBOOKS.md` §1.1)
      //      — the playbook's declared override. Only applies
      //      when the parent did not explicitly pin.
      //   3. Provider default — fallback when neither was
      //      declared.
      // Without precedence (1) over (2), an eval rig that
      // hardcoded temperature=0 would see playbook overrides
      // silently break determinism.
      ...(opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : audit.sampling?.temperature !== undefined
          ? { temperature: audit.sampling.temperature }
          : {}),
      // Nucleus sampling and extended-thinking budget. No
      // parent-forwarded equivalent today — argv carries only
      // temperature. When the spec adds further parent-forwarded
      // overrides, this branch grows the same precedence ladder.
      ...(audit.sampling?.topP !== undefined ? { topP: audit.sampling.topP } : {}),
      ...(audit.sampling?.thinkingBudget !== undefined
        ? { thinkingBudget: audit.sampling.thinkingBudget }
        : {}),
      // Determinism intent flag (`PLAYBOOKS.md` §1.1
      // `sampling.seed_in_eval`). The loader parses + persists it
      // and the audit row carries it through every replay; without
      // forwarding here, the field landed in snapshots but had no
      // runtime effect. Adapter-side translation is per-provider
      // (Anthropic drops, OpenAI / Google use seed) — the harness
      // just expresses the intent.
      ...(audit.sampling?.seedInEval !== undefined
        ? { seedInEval: audit.sampling.seedInEval }
        : {}),
      // Plan mode propagation. When the parent invoked
      // runSubagent with planMode:true, the child's harness
      // loop must reject every writing tool BEFORE execution —
      // defense in depth that doubles up with the top-level
      // `task` tool gate (planSafe:false). The conditional
      // spread keeps the absent-by-default semantics: omitting
      // the flag on the parent side leaves the child running
      // with normal (non-plan) execution.
      ...(opts.planMode === true ? { planMode: true } : {}),
      // Trust verdict from the parent's bootstrap. Without this
      // forward, `harness/loop.ts` would default `isCwdTrusted`
      // to false (fail-closed) for every subagent — so a tool
      // that gates on trust (today: `memory_write`'s inferred-
      // source path; future tools may add more) silently denies
      // even when the operator trusted the parent's cwd.
      isCwdTrusted: opts.cwdTrusted === true,
      // S5 CRIT/H3: mirror parent's shared-scope fail-closed
      // posture on retrieval too. Eager-load already excludes
      // via `excludeScopes` above; this gate keeps
      // `retrieve_context` consistent — the model can't reach
      // around the eager-load gate by asking for shared bodies
      // via the tool surface.
      ...(opts.sharedScopeOffline === true
        ? { memoryExcludeScopes: ['project_shared'] as const }
        : {}),
      // Checkpoints stay off — the worktree path already provides
      // a separate branch for changes; a per-step checkpoint chain
      // inside the worktree is a future addition.
      enableCheckpoints: false,
      // Per-subagent bg log directory. When omitted (older
      // parents, tests that route around the spawn) the harness
      // runs without a bg manager and `requiresBgManager` tools
      // refuse at invocation time — same as a top-level run
      // without `bgLogDir`.
      ...(opts.bgLogDir !== undefined ? { bgLogDir: opts.bgLogDir } : {}),
      // Memory registry. When the parent forwarded `memoryCwd`
      // we constructed the registry above; thread it through so
      // memory_* tools can dispatch and the system prompt's
      // memory section matches what the model sees in the index.
      // Conditional spread: omitted ⇒ registry stays undefined
      // ⇒ memory tools surface `registry_unavailable`.
      ...(memoryRegistry !== undefined ? { memoryRegistry } : {}),
      // Eager-load provenance inventory (MEMORY.md §11.2). Always
      // passed — empty array survives the no-memory branch and
      // the loop's emit is a no-op then.
      eagerExposures,
      // Hook chain resolved above. Always passed (even when
      // empty) — the harness's dispatch sites short-circuit on
      // empty arrays. Locked enterprise hooks reach the
      // subagent through the same hooks.toml the parent loaded
      // (re-resolved here from the same repo root, so config
      // staleness across spawn isn't a concern).
      hooks: hookChain,
      // Route IPC interrupt commands into the harness's
      // abort plumbing. The harness honors `signal` for hard
      // preemption (in-flight provider call abort) and
      // `softStopSignal` for cooperative exit at the next step
      // boundary. Without these wires, an `interrupt:soft` from
      // the parent would dead-end at the channel listener and
      // the child would run to completion ignoring the operator.
      // When IPC is off the controllers stay quiescent — same
      // semantics as omitting the fields.
      signal: signalController.signal,
      softStopSignal: softStopController.signal,
      // IPC event forwarding (subagent observability,
      // spec docs/spec/IPC.md §3.2). When the parent enabled the
      // channel, every HarnessEvent the child fires also lands
      // on the wire as an `event` IPC message. The parent's
      // `runSubagent` decodes and re-fires them as
      // `subagent_progress` HarnessEvents on the parent's own
      // observer chain. Drops `session_finished` and
      // `subagent_*` variants: the bracket events are fielded by
      // the IPC layer's `session_start` / `session_finished`
      // markers, and forwarding nested subagent observability
      // would let an N-deep child blow up the parent's renderer
      // budget. Send errors are swallowed — the channel may be
      // half-closed mid-flush; SQLite remains the canonical
      // record.
      ...(ipcChannel !== undefined
        ? {
            onEvent: (he: HarnessEvent) => {
              if (
                he.type === 'session_finished' ||
                he.type === 'subagent_start' ||
                he.type === 'subagent_progress' ||
                he.type === 'subagent_finished'
              ) {
                return;
              }
              try {
                ipcChannel.send(makeEvent(he));
              } catch {
                // Channel may be torn down; ignore.
              }
            },
          }
        : {}),
      // Permission proxy. The bridge converts a confirm verdict
      // from this child's engine into a `permission:ask` IPC
      // message, blocks awaiting `permission:answer` from the
      // parent's operator, and resolves the resulting
      // `Promise<boolean>` back to invoke-tool's existing async
      // confirm branch. Without this wire, every confirm verdict
      // would fall back to denial (invoke-tool.ts:341).
      ...(permissionBridge !== undefined
        ? { confirmPermission: permissionBridge.confirmPermission }
        : {}),
      // Slice 125 (R2 P0-10): forward telemetry into the child
      // harness loop too. Without this, the slice-111
      // SandboxDegradedActiveEvent emit at loop.ts:901 short-
      // circuits on `config.telemetry === undefined` and the
      // event never fires. Same recording sink shared with the
      // engine above so all child events land in one stream.
      telemetry: childTelemetry,
    };

    let result = await runAgent(config);
    let output = extractFinalOutput(db, result.lastMessageId);
    // Cumulative bookkeeping across the (possibly-retried) run.
    // `HarnessResult` reports cost/steps/duration PER-RUN — the
    // resume call inside `runAgent` loads `priorCostUsd` from the
    // session row but the returned `result.costUsd` reports just
    // that resume's spend (`harness/loop.ts:271-276`). Without
    // accumulating manually, a retry pass would see the envelope
    // (and the parent's `subagent_handles.costUsd`,
    // `cumulativeChildCostUsd` accounting, `/cost` aggregation,
    // `subagent_finished` event) under-report the real spend by
    // exactly the first run's cost. Same shape applies to
    // `steps` and `durationMs`.
    let totalCostUsd = result.costUsd;
    let totalSteps = result.steps;
    let totalDurationMs = result.durationMs;

    // Output-schema enforcement (`PLAYBOOKS.md` §1.2). Only
    // engages when the playbook author declared a schema AND
    // the run terminated cleanly (`done`). Errored / aborted /
    // exhausted runs propagate verbatim — schema is a contract
    // about WHAT the model emits when it has the chance to
    // emit, not a clean-up gate on top of every failure.
    //
    // Soft enforcement: a first mismatch buys ONE retry pass.
    // We append a diagnostic user message and resume the same
    // session (preassigned id was consumed by the first call;
    // the second call uses `resumeFromSessionId`). If the
    // retry also fails validation, the run finalizes with
    // `playbook.output_invalid`.
    if (audit.outputSchema !== null && result.status === 'done') {
      const firstVerdict = validateOutput(output, audit.outputSchema);
      if (!firstVerdict.valid) {
        const retryBudgetVerdict = computeSchemaRetryBudget(config.budget, {
          steps: result.steps,
          durationMs: result.durationMs,
        });
        if (retryBudgetVerdict.skip) {
          // First run already consumed the declared envelope —
          // skip the retry. The final validation pass below
          // surfaces the playbook.output_invalid envelope using
          // the original result.
        } else {
          const diagnostic = `Your previous output did not match the declared output_schema: ${firstVerdict.reason}. Re-emit the YAML with all required keys and correct types. This is your last attempt before the run is failed with playbook.output_invalid.`;
          // Build the retry config: same surface, except we
          // switch the session-id discriminator from
          // `preassignedSessionId` (already consumed) to
          // `resumeFromSessionId` (reopens the row), hand the
          // diagnostic in as the new userPrompt, and rebase
          // the per-run budget so the retry shares the
          // original envelope rather than getting a fresh one.
          const { preassignedSessionId: _omit, userPrompt: _prevPrompt, ...rest } = config;
          const retryConfig = {
            ...rest,
            resumeFromSessionId: opts.sessionId,
            userPrompt: diagnostic,
            budget: retryBudgetVerdict.budget,
          };
          result = await runAgent(retryConfig);
          output = extractFinalOutput(db, result.lastMessageId);
          totalCostUsd += result.costUsd;
          totalSteps += result.steps;
          totalDurationMs += result.durationMs;
        }
      }
    }

    // Aggregated shape for envelope construction. Spread the
    // per-run `result` (so status / reason / lastMessageId /
    // abortCause come from the FINAL run, which is the right
    // semantic for those discriminators) and override the three
    // additive metrics with the cumulative totals from above.
    const aggregatedResult: HarnessResult = {
      ...result,
      costUsd: totalCostUsd,
      steps: totalSteps,
      durationMs: totalDurationMs,
    };

    // Final validation pass after the (possibly-retried) run.
    // The schema cuts BOTH ways: even a first-pass invalid
    // output that the retry fixed runs through this pass and
    // succeeds; a never-failing pass is a no-op.
    let envelope: Record<string, unknown>;
    if (audit.outputSchema !== null && result.status === 'done') {
      const verdict = validateOutput(output, audit.outputSchema);
      if (!verdict.valid) {
        envelope = {
          status: 'error',
          reason: 'playbook.output_invalid',
          output,
          cost_usd: totalCostUsd,
          steps: totalSteps,
          duration_ms: totalDurationMs,
          message: verdict.reason,
          missing_keys: verdict.missingKeys,
          type_mismatches: verdict.typeMismatches,
          ...(result.lastMessageId !== undefined ? { last_message_id: result.lastMessageId } : {}),
        };
        // Reclassify the session row so audit / telemetry queries
        // keyed on `sessions.status` see this run as failed.
        // runAgent already finalized the row to `done` (the
        // harness loop completed cleanly), but the post-finalize
        // schema validator has just rejected the output —
        // leaving status='done' alongside an envelope of
        // status='error' / reason='playbook.output_invalid' would
        // count schema-failed runs as successful in any
        // downstream aggregation. Reclassify is a strict
        // done→error transition; the helper throws if the row
        // is in any other state, catching a future regression
        // that races the finalize.
        reclassifySessionStatus(db, opts.sessionId, 'done', 'error');
      } else {
        envelope = buildEnvelope(aggregatedResult, output);
      }
    } else {
      envelope = buildEnvelope(aggregatedResult, output);
    }
    setSubagentPayload(db, opts.sessionId, envelope);
    envelopePublished = true;
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
    if (outputsRowInserted && !envelopePublished) {
      // Last-ditch envelope so the parent's poller sees an error
      // payload instead of timing out on missing-payload. We
      // catch any throw from setSubagentPayload itself silently —
      // if even the audit-publish path is broken, the stderr
      // write is the only signal we can offer.
      try {
        setSubagentPayload(db, opts.sessionId, {
          status: 'error',
          reason: 'internalError',
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
          message: msg,
        });
      } catch {
        // ignore
      }
    }
    // Finalize the session row. runAgent's contract is to call
    // completeSession from inside its lifecycle; if the throw
    // escaped past that path (rare — the harness top-level
    // catch is documented as exhaustive, but a regression
    // there would otherwise leak the row), the explicit
    // finalize here closes the gap. Idempotent: when runAgent
    // already finalized to 'done' / 'exhausted' / 'error', the
    // status='running' guard makes this a no-op.
    finalizeAsError();
    errSink(`forja: subagent-child: ${msg}\n`);
    return 1;
  } finally {
    // Stop the heartbeat BEFORE closing the DB. clearInterval
    // is idempotent on undefined; the unref'd timer wouldn't
    // pin the loop alive even if we forgot, but explicit clear
    // releases the FD-equivalent reference promptly. Closing
    // the DB while the interval is mid-write would queue a
    // throw on the next tick — swallowed inside the timer body
    // anyway, but the explicit ordering is cleaner.
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    // Drain the permission bridge BEFORE closing the channel.
    // dispose() resolves any in-flight ask as denied so a
    // confirmPermission caller blocked at child-shutdown time
    // exits its await — without this, the harness's invokeTool
    // could be holding the event loop alive past return. Order
    // matters: the bridge's onClose subscription would also
    // fire on channel.close() below, but disposing first keeps
    // the cleanup deterministic (one source of denial, not a
    // race between dispose's drain and the close handler's).
    if (permissionBridge !== undefined) permissionBridge.dispose();
    // Spec §4.3: emit session_finished as the LAST IPC message
    // before exit, regardless of which path led here (happy path,
    // pre-harness refusal, post-harness throw). The parent uses
    // this to distinguish a clean shutdown from `subprocess_crashed`
    // (pipe broken without the bracket close). After sending we
    // close the channel — flushes the writer and releases the
    // stdin/stdout listeners so the runtime can exit cleanly.
    if (ipcChannel !== undefined) {
      try {
        ipcChannel.send(makeSessionFinished());
      } catch {
        // Channel may already be torn down (parent died, pipe
        // broken). The session row + payload in SQLite remain
        // the canonical record of what happened — IPC is best-
        // effort visibility.
      }
      ipcChannel.close();
    }
    closeDb(db);
  }
};
