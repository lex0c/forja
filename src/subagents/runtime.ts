import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '../harness/index.ts';
import type { HookSpec } from '../hooks/types.ts';
import type { PermissionEngine } from '../permissions/index.ts';
import type { Provider } from '../providers/index.ts';
import {
  type DB,
  appendMessage,
  completeSession,
  createSession,
  getSubagentOutput,
  insertSubagentRun,
  insertSubagentWorktree,
  listBgProcessesBySession,
} from '../storage/index.ts';
import { type ToolRegistry, createToolRegistry, registerBuiltinTools } from '../tools/index.ts';
import { reapChildBgProcesses } from './bg-reaper.ts';
import {
  IPC_PROTOCOL_VERSION,
  IPC_VERSION_MISMATCH_EXIT_CODE,
  type IpcMessage,
  makeInterruptHard,
  makeInterruptSoft,
} from './ipc.ts';
import type { SubagentSet } from './load.ts';
import { buildResultFromPayload } from './result-builder.ts';
import type { RunSubagentResult } from './result-builder.ts';
import {
  type ChildProcessHandle,
  type SpawnChildProcess,
  defaultSpawnChildProcess,
} from './spawn-factory.ts';
import type { SubagentDefinition } from './types.ts';
import {
  type CleanupResult,
  type WorktreeHandle,
  cleanupWorktree,
  createWorktree,
} from './worktree.ts';

export type { RunSubagentResult, SubagentEnvelope } from './result-builder.ts';
export { toEnvelope } from './result-builder.ts';
export type {
  ChildProcessHandle,
  SpawnChildProcessOptions,
  ResolveChildBinaryArgs,
  SpawnChildProcess,
} from './spawn-factory.ts';
export { resolveChildBinaryCmd, drainStderrToLogFile } from './spawn-factory.ts';

// Filter the parent's registry down to a child registry. The
// child runs in a SUBPROCESS (Step 4.2b.ii.a) and reads the
// definition from `subagent_runs` itself; the parent never
// passes the registry across the IPC boundary. This validation
// is defense in depth: bootstrap pre-validates via
// `validateSubagentSet`, but a programmatic caller building a
// `RunSubagentInput` without that step still gets refused on
// the same grounds. We throw on two conditions:
//   1. Tool name not registered with the parent's full toolset
//      (typo — model would never recover)
//   2. Tool declares writes:true but isolation is not worktree
//
// 4.2b.iv lifted the previous third condition (`requiresBgManager`)
// — every subagent now gets its own bg log dir threaded across
// via `--subagent-bg-log-dir`, so background-process tools are
// safe to expose.
//
// The validation runs only as a refusal gate — the returned
// registry is unused on the subprocess path because the child
// builds its own registry from `subagent_runs.tools_whitelist`.
// Kept here so the contract for programmatic callers stays
// uniform and any future in-process re-entry path inherits the
// same refusals.
const assertWhitelistValidForSubagent = (
  parent: ToolRegistry,
  whitelist: readonly string[],
  subagentName: string,
  allowWrites: boolean,
  // When true, the validator additionally checks that every
  // whitelisted tool exists in the BUILTIN set — the source of
  // truth the subprocess child uses to rebuild its own registry
  // at startup. Production callers (the harness's spawn closure)
  // hit a real subprocess, so this MUST be true: a programmatic
  // caller registering a custom tool in `parentToolRegistry`
  // would otherwise pass the parent-side check, snapshot the
  // tool name into `audit.toolsWhitelist`, and watch the child
  // refuse with `unknown_tool` at startup. False is the test
  // path: when `spawnChildProcess` is injected, the fake child
  // doesn't use the builtin registry, so the alignment check
  // is irrelevant.
  enforceBuiltin: boolean,
): void => {
  // Build the builtin registry once per call. Cheap (just
  // re-registers the static set) and stays decoupled from any
  // shared state the parent might have.
  const builtins = enforceBuiltin ? buildBuiltinRegistry() : null;
  const seen = new Set<string>();
  for (const toolName of whitelist) {
    if (seen.has(toolName)) {
      throw new Error(`subagent '${subagentName}': tool '${toolName}' listed twice in tools[]`);
    }
    seen.add(toolName);
    const tool = parent.get(toolName);
    if (tool === null) {
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' not registered with parent harness`,
      );
    }
    if (tool.metadata.writes === true && !allowWrites) {
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' declares metadata.writes=true and cannot appear in subagent.tools[] without 'isolation: worktree'. Bootstrap should have caught this; if you see it at runtime you're constructing the child registry without going through validateSubagentSet first.`,
      );
    }
    if (builtins !== null && builtins.get(toolName) === null) {
      // The parent's registry has this tool, but the builtin
      // set doesn't. Subagent (4.2b.ii.a) requires builtin
      // tools because the subprocess child rebuilds its
      // registry from `registerBuiltinTools()` — the only
      // tool source visible across the IPC boundary today.
      // Custom tools (programmatic callers, evals, future
      // MCP clients) need a transmission mechanism that
      // doesn't exist yet; refusing here surfaces the issue
      // at the parent's spawn time instead of letting the
      // child fail at startup with `unknown_tool`.
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' is registered with the parent but NOT in the builtin set — subagent subprocesses (4.2b.ii.a) can only run with builtin tools because the child rebuilds its registry from registerBuiltinTools(). Custom tools require a transmission mechanism that lands with MCP / plugin support in a later slice.`,
      );
    }
  }
};

// Cached builtin registry would be a tempting micro-opt but
// `registerBuiltinTools` is idempotent and cheap; keeping the
// build local also means tests that rebuild the registry
// (e.g., adding a new builtin in a future slice) see the new
// shape without coordinating cache invalidation.
const buildBuiltinRegistry = (): ToolRegistry => {
  const r = createToolRegistry();
  registerBuiltinTools(r);
  return r;
};

export interface RunSubagentInput {
  definition: SubagentDefinition;
  prompt: string;
  parentSessionId: string;
  provider: Provider;
  parentToolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  db: DB;
  cwd: string;
  signal?: AbortSignal;
  // Cooperative-stop signal (1.g.1). Parent forwards its own
  // softStopSignal here so the future in-process subagent path can
  // honor it directly. Today's subprocess path CANNOT — there's no
  // IPC channel between parent and child, only OS signals (which
  // are inherently preemptive). When a parent's soft fires while a
  // task() is in flight, the parent blocks until the child finishes
  // its full budget, then the parent's top-of-loop soft check
  // exits. Documented gap (BACKLOG D159); will close when IPC
  // lands (same slice that unblocks 1.f.2 subagent observability).
  softStopSignal?: AbortSignal;
  // Lifecycle observer. The subprocess child can't stream events
  // directly to the parent (no IPC channel for that); the parent
  // sees only the terminal payload. Reserved for parity with the
  // in-process API; today this hook is invoked only for spawn-
  // failure synthetic events.
  onEvent?: (event: unknown) => void;
  temperature?: number;
  subagentRegistry?: SubagentSet;
  planMode?: boolean;
  // Trust verdict from the parent's bootstrap (spec §9). Forwarded
  // via `--subagent-cwd-trusted` to the child process so the
  // child's harness honors the SAME trust decision the parent
  // resolved at startup. Without this, every subagent runs with
  // `isCwdTrusted: false` (fail-closed); tools that gate on trust
  // (memory_write inferred-source path; future tools that read
  // ~/.ssh, etc.) would silently deny even when the operator
  // explicitly trusted the cwd. Defaults absent ⇒ false; the
  // harness loop's spawnSubagent closure forwards
  // `config.isCwdTrusted` so the in-flight run propagates the
  // verdict it's already operating under.
  cwdTrusted?: boolean;
  depth?: number;
  worktreeRootDir?: string;
  // Test seam: inject a fake subprocess factory. Production
  // callers omit; the default uses `Bun.spawn` of the same
  // binary with `--subagent-session-id`. Tests inject a fake
  // that runs the harness in-process and writes the payload to
  // `subagent_outputs` synchronously.
  spawnChildProcess?: SpawnChildProcess;
  // Wall-clock cap for the parent's wait loop, in ms. When
  // exceeded, the parent SIGTERMs the child, waits
  // `WALL_CLOCK_GRACE_MS`, then SIGKILLs. Defaults to the
  // definition's `budget.maxWallClockMs` when present, else
  // `DEFAULT_WALL_CLOCK_MS`. Tests pass small values to
  // exercise the timeout path quickly.
  wallClockMs?: number;
  // Grace period between SIGTERM and SIGKILL, in ms. Defaults
  // to 5_000 per FAILURE_MODES §7.3. Tests override with small
  // values so the kill escalation path completes within the
  // test runner's per-test timeout (5s by default in `bun test`).
  graceMs?: number;
  // Heartbeat staleness threshold, in ms. Defaults to
  // `HEARTBEAT_STALE_THRESHOLD_MS` (10_000). When the child's
  // last heartbeat is older than this, the parent treats it as
  // wedged and escalates SIGTERM → grace → SIGKILL. Tests pass
  // small values to exercise the path without waiting 10s.
  heartbeatStaleMs?: number;
  // Open the live IPC channel (spec docs/spec/IPC.md). Forwards
  // to the spawn factory; default factory uses pipe shells +
  // `--ipc=<n>` argv. When omitted the child runs in legacy
  // SQLite-only mode and `onIpcMessage` / `onChildEvent` are
  // never invoked. Implied true when `onChildEvent` is set —
  // observability without a wire is meaningless.
  ipc?: boolean;
  // Raw IPC observer. Best-effort delivery — a malformed line is
  // dropped (with a stderr warning) and never reaches this
  // callback. Useful for tests and tooling that need access to
  // the wire (audit log replays, IPC contract tests). Production
  // consumers should prefer `onChildEvent` below.
  onIpcMessage?: (msg: IpcMessage) => void;
  // Typed child-event observer (S2 of subagent observability).
  // The runtime synthesizes three HarnessEvents around the
  // child's run:
  //   - `subagent_start` right after the child session row is
  //     created (BEFORE spawn) so the parent sees the bracket
  //     even if spawn fails.
  //   - `subagent_progress` for each child HarnessEvent received
  //     over IPC's `event` envelope. Inner events that are
  //     `session_finished` or `subagent_*` are dropped at the
  //     boundary (parent renders only its DIRECT children).
  //   - `subagent_finished` after `waitForChild` resolves; same
  //     shape regardless of outcome (done / error / interrupted /
  //     wall-clock / heartbeat-stale).
  // The harness loop's spawnSubagent closure pipes this into
  // `config.onEvent` so the parent's HarnessEvent → UIEvent
  // adapter sees the lifecycle automatically.
  onChildEvent?: (event: HarnessEvent) => void;
  // Parent's resolved hook chain to seal into the child's audit
  // row (migration 020). The child reads from the snapshot
  // instead of re-resolving `hooks.toml` from disk — collapses
  // the drift window where a human edit between parent spawn
  // and child startup could land the child running under a
  // different chain than the parent validated. The harness
  // loop's spawnSubagent closure forwards `config.hooks`;
  // programmatic callers that omit it land the child in the
  // legacy disk-re-resolve path (preserving pre-migration
  // behavior for fixtures that don't model the snapshot).
  hooksSnapshot?: readonly HookSpec[];
}

// Hard cap on how deep a chain of `task → task → task` can nest.
// 4 levels covers every plausible playbook composition; surfaces
// a clear error well before the budget caps would.
export const MAX_SUBAGENT_DEPTH = 4;

// Default wall-clock for a subagent run when the definition
// doesn't specify `budget.maxWallClockMs`. 10 minutes is enough
// for substantive work (refactor, audit, multi-file edit) while
// short enough that a hung child never burns more than that.
// Definitions that need longer override via budget.
const DEFAULT_WALL_CLOCK_MS = 10 * 60 * 1000;

// Time the parent waits between SIGTERM and SIGKILL on either a
// caller abort or wall-clock timeout. 5s matches FAILURE_MODES
// §7.3's "5s grace; SIGKILL" mandate. The child has this window
// to flush its terminal payload to `subagent_outputs` before the
// kernel drops it.
const WALL_CLOCK_GRACE_MS = 5_000;

// Polling cadence for `subagent_outputs.payload`. Backoff from
// 50ms up to 500ms; the geometric ramp keeps fast runs cheap
// (sub-second completion sees only one or two polls) while the
// cap bounds wakeups on long runs.
const POLL_INITIAL_MS = 50;
const POLL_MAX_MS = 500;
const POLL_GROWTH = 2;

// Heartbeat staleness threshold for the parent's poller. Catches
// the failure mode where a child is responding to signals (so
// SIGTERM would still work) but is wedged inside a tool call
// (provider request hung, sync block, infinite loop) and stops
// updating `subagent_outputs.last_heartbeat`. Wall-clock alone
// would catch this in DEFAULT_WALL_CLOCK_MS (10min) — the
// heartbeat path catches it in single-digit seconds.
//
// The child writes every HEARTBEAT_CADENCE_MS=2000ms (defined
// in cli/subagent-child.ts). 3 missed beats = 6s of silence.
// Floor at 10s to absorb transient SQLite contention / GC
// pauses without false-positive killing of healthy children.
const HEARTBEAT_STALE_THRESHOLD_MS = 10_000;

// Wait for the subprocess to publish its terminal payload, OR
// exit without one (child crashed), OR be killed by signal /
// wall-clock. Returns the resolved state; the runtime's caller
// converts it into `RunSubagentResult`.
type WaitOutcome =
  | { kind: 'payload'; payload: Record<string, unknown> }
  | { kind: 'crashed'; exitCode: number }
  | { kind: 'aborted'; cause: 'soft' | 'hard' }
  | { kind: 'wall_clock' }
  | { kind: 'heartbeat_stale' };

interface WaitForChildArgs {
  db: DB;
  sessionId: string;
  handle: ChildProcessHandle;
  signal: AbortSignal | undefined;
  // S3: parent's cooperative-stop signal. Triggers `interrupt:soft`
  // over IPC; the child's harness exits at the next step boundary.
  // Without IPC, no-op for the subprocess path (the OS has no
  // cooperative signal). Hard `signal` above remains the
  // preemptive escalation target.
  softStopSignal: AbortSignal | undefined;
  wallClockMs: number;
  graceMs: number;
  heartbeatStaleMs: number;
  startTs: number;
}

// Race `handle.exited` against a bounded timer. Returns
// 'exited' when the child terminates first, 'timeout' when the
// timer wins. The timer is `unref()`'d so it doesn't pin the
// event loop alive past the caller's return — Bun's setTimeout
// is ref'd by default (same as Node), and a non-unref'd timer
// holds the process open for up to graceMs even when nothing
// else needs it.
const raceExitAgainstTimeout = (
  handle: ChildProcessHandle,
  ms: number,
): Promise<'exited' | 'timeout'> => {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: 'exited' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle('timeout'), ms);
    if (typeof timer.unref === 'function') timer.unref();
    handle.exited.then(() => settle('exited'));
  });
};

// Drain a subprocess that has already published its payload.
// The polling loop returns on payload, but the OS-level exit
// may not have happened yet — Bun keeps the parent process
// alive while children run, so returning here without awaiting
// the exit would (a) leave a zombie/orphan child past
// runSubagent's resolution and (b) race the worktree cleanup
// against a child that's still touching the tree (shutdown
// flush, finalize, slow exit). Bound the wait at graceMs and
// SIGKILL if the child hangs past the grace; one more grace
// window for the kernel to reap before we give up.
//
// Errors during kill are swallowed (handle.kill swallows
// already-exited throws internally; nothing else to do here).
const drainChildAfterPayload = async (
  handle: ChildProcessHandle,
  graceMs: number,
): Promise<void> => {
  if ((await raceExitAgainstTimeout(handle, graceMs)) === 'exited') return;

  // Child published payload but is hanging on shutdown. Force
  // termination and wait one more grace window for the reap.
  // After that we give up — the kernel will eventually reclaim,
  // and runSubagent must not block its caller forever.
  handle.kill('SIGKILL');
  await raceExitAgainstTimeout(handle, graceMs);
};

const waitForChild = async (args: WaitForChildArgs): Promise<WaitOutcome> => {
  const {
    db,
    sessionId,
    handle,
    signal,
    softStopSignal,
    wallClockMs,
    graceMs,
    heartbeatStaleMs,
    startTs,
  } = args;

  let pollDelay = POLL_INITIAL_MS;
  // `killed` tracks non-abort kill verdicts (wall_clock,
  // heartbeat_stale). The abort path uses `interruptCause`
  // separately so its soft/hard discriminator survives into
  // the outcome.
  let killed: 'wall_clock' | 'heartbeat_stale' | undefined;
  let killedAt = 0;
  // S3: tri-state tracking the parent's cooperative-vs-preemptive
  // escalation against the child.
  //   - undefined: no abort signaled.
  //   - 'soft':    parent pressed Esc once; we sent `interrupt:soft`
  //     over IPC and are waiting `graceMs` for the child to publish
  //     its envelope cleanly. No SIGKILL scheduled.
  //   - 'hard':    parent escalated (Esc-Esc, soft grace expired,
  //     or `signal.aborted` directly). We sent `interrupt:hard`
  //     (when IPC is on) AND OS SIGTERM as belt-and-suspenders,
  //     plus scheduled the SIGKILL escalation.
  let interruptCause: 'soft' | 'hard' | undefined;
  let interruptAt = 0;
  let exitedResolved = false;
  // The pending SIGKILL escalation timer (set when killed
  // transitions to defined). Tracked in this scope so:
  //   1. The exit handler clears it as soon as the child dies
  //      naturally — no point firing a kill that no-ops on a
  //      dead child, and the un-cleared timer would otherwise
  //      hold the event loop alive for graceMs after
  //      waitForChild returns (Bun setTimeout is ref'd by
  //      default).
  //   2. Each return path can drop the reference; combined
  //      with `unref()` below, this guarantees post-run hangs
  //      can't accumulate from leftover timers.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  // Track exit so we can short-circuit the polling loop AND
  // clear any pending SIGKILL timer that's no longer needed.
  handle.exited.then(() => {
    exitedResolved = true;
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
  });

  // Schedule the SIGKILL escalation. The timer is `unref()`'d
  // so it doesn't pin the event loop alive past waitForChild's
  // return — when the child exited cleanly the body would
  // no-op anyway (the !exitedResolved guard), but the pending
  // callback would still hold the process open until graceMs
  // elapsed without unref. The exit handler above ALSO clears
  // the timer; unref is the belt-and-suspenders for the path
  // where waitForChild returns from the 2×grace bail-out
  // before exit ever resolves.
  const scheduleKill = () => {
    killTimer = setTimeout(() => {
      if (!exitedResolved) handle.kill('SIGKILL');
    }, graceMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  while (true) {
    // Check payload first — a child that exited cleanly may have
    // raced ahead of our polling cadence and already published.
    const out = getSubagentOutput(db, sessionId);
    if (out !== null && out.payload !== null) {
      // Wait for the OS-level exit before returning. A child
      // that publishes payload then hangs (shutdown flush,
      // finalize, slow signal handler) would otherwise leak
      // past runSubagent's resolution AND race against the
      // worktree cleanup that the caller fires next.
      if (!exitedResolved) {
        await drainChildAfterPayload(handle, graceMs);
      }
      return { kind: 'payload', payload: out.payload };
    }

    // Subprocess exited but no payload. Distinguish between:
    //   - Caller already aborted: SIGINT propagates to the
    //     whole process group, so the child can exit before our
    //     wait loop ever set `killed='aborted'`. Without the
    //     check below the result would report 'crashed' for
    //     what is plainly a user abort.
    //   - We killed it (signal abort or wall-clock timeout
    //     observed inside this loop) — report the kill verdict
    //     directly. The exit code from SIGKILL would otherwise
    //     look like a crash to the caller, which is misleading.
    //   - It exited on its own with no payload — genuine crash.
    if (exitedResolved) {
      const lastLook = getSubagentOutput(db, sessionId);
      if (lastLook !== null && lastLook.payload !== null) {
        return { kind: 'payload', payload: lastLook.payload };
      }
      // Verdict precedence on no-payload exit:
      //
      //   1. `killed` (wall_clock / heartbeat_stale): system
      //      constraint terminations win over operator intent.
      //      Both fired SIGTERM at the child, and the budget
      //      cap (or hung-tool detection) is what actually
      //      caused the death — the soft signal in flight
      //      didn't kill anything by itself, so reporting
      //      `aborted/soft` would misclassify a timeout-
      //      enforced termination as a user abort and skew
      //      operator diagnostics + retry/telemetry that
      //      branches on reason.
      //
      //   2. `interruptCause` ('hard' or 'soft'): the operator
      //      pressed Esc and `killed` didn't fire alongside.
      //      Hard SIGTERM'd; soft sent `interrupt:soft` and
      //      waited cooperatively. Either way the child died
      //      because the operator asked it to.
      //
      //   3. `signal.aborted` / `softStopSignal.aborted` with
      //      no `interruptCause` recorded: the OS signal raced
      //      ahead before our wait-loop's iteration could
      //      stamp `interruptCause`. Default to 'hard'
      //      conservatively — if the operator hit Esc-Esc and
      //      the child exited before our soft promotion ran,
      //      hard is the correct verdict.
      //
      //   4. Genuine crash (no payload, no kill, no signal).
      if (killed !== undefined) {
        return { kind: killed };
      }
      if (
        interruptCause !== undefined ||
        signal?.aborted === true ||
        softStopSignal?.aborted === true
      ) {
        return { kind: 'aborted', cause: interruptCause ?? 'hard' };
      }
      const { exitCode } = await handle.exited;
      return { kind: 'crashed', exitCode };
    }

    // Soft trigger (S3, BACKLOG D159). Parent's cooperative-stop
    // signal fired AND the hard signal hasn't (the latter takes
    // precedence: a same-tick double-Esc lands on hard directly).
    // We send `interrupt:soft` over IPC if available; subprocess
    // children without IPC have no cooperative path, so soft-only
    // calls degrade silently — the operator's hard escalation is
    // the only working channel in that mode.
    if (
      softStopSignal?.aborted === true &&
      interruptCause === undefined &&
      signal?.aborted !== true
    ) {
      interruptCause = 'soft';
      interruptAt = Date.now();
      if (handle.ipc !== undefined) {
        try {
          handle.ipc.send(makeInterruptSoft());
        } catch {
          // Channel may be torn down; the OS-level kill path
          // below picks up the slack on grace expiry.
        }
      }
      // No SIGKILL scheduled here: soft is patient by design.
      // The child's harness exits at its next step boundary,
      // publishes the envelope (with abort_cause: 'soft'), and
      // the payload-arrived branch above returns 'payload'.
    }

    // Hard trigger: caller's signal aborted directly, OR soft
    // grace expired without the child finishing its bracket.
    // We escalate via IPC `interrupt:hard` (cleaner — child can
    // still drain its message buffers) AND OS SIGTERM (the
    // ultimate fallback when the channel is half-closed),
    // scheduling SIGKILL after `graceMs`.
    const softExpired = interruptCause === 'soft' && Date.now() - interruptAt >= graceMs;
    if ((signal?.aborted === true || softExpired) && interruptCause !== 'hard') {
      interruptCause = 'hard';
      // Reset interruptAt regardless of whether we're promoting
      // from soft or starting fresh on hard. The 2×grace bail-out
      // below measures from `interruptAt`; if we kept the soft
      // moment as the anchor on promotion, the cushion would
      // shrink to ~1×grace from the SIGTERM (graceMs already
      // elapsed during the soft window). The intent of the
      // 2× cushion is "after SIGTERM fires, give SIGKILL its
      // grace AND a kernel reap window" — that's two graces
      // FROM the SIGTERM, not from the original interrupt.
      interruptAt = Date.now();
      if (handle.ipc !== undefined) {
        try {
          handle.ipc.send(makeInterruptHard());
        } catch {
          // ignore — SIGTERM below covers the channel-broken case
        }
      }
      handle.kill('SIGTERM');
      scheduleKill();
    }

    // Wall-clock budget exceeded — same escalation shape. We
    // honor wall-clock even when an interrupt is in flight: the
    // operator's two budgets are independent and both can fire
    // (e.g. soft was sent and the child stalled past its
    // wall-clock budget without acknowledging). Stamping
    // `killed = 'wall_clock'` over an in-flight `interruptCause`
    // gives the operator the more specific verdict — "we hit the
    // budget cap" beats "we sent an abort signal" when both are
    // true. The bail-out paths below already handle the case
    // where both states are set.
    const elapsed = Date.now() - startTs;
    if (elapsed >= wallClockMs && killed === undefined) {
      killed = 'wall_clock';
      killedAt = Date.now();
      handle.kill('SIGTERM');
      scheduleKill();
    }

    // Heartbeat staleness — catches "child responds to signals
    // but is wedged inside a tool call". The wall-clock check
    // above also catches it eventually, but on a 10-min timeline;
    // heartbeat staleness fires in ~10s, much closer to the
    // operator's expectation when something is actually hung.
    //
    // Conditions for declaring stale:
    //   1. Outputs row exists (out !== null) — child got far
    //      enough into its startup to insert.
    //   2. Heartbeat has fired at least once (lastHeartbeat !==
    //      null) — null means "child hasn't pulsed yet, could
    //      be slow startup but not yet wedged". The wall-clock
    //      eventually catches the slow-startup case.
    //   3. Gap > HEARTBEAT_STALE_THRESHOLD_MS — 10s of silence
    //      after a successful pulse is the wedge signal.
    //   4. Not already killed — avoids re-firing escalation.
    if (
      killed === undefined &&
      interruptCause === undefined &&
      out !== null &&
      out.lastHeartbeat !== null &&
      Date.now() - out.lastHeartbeat > heartbeatStaleMs
    ) {
      killed = 'heartbeat_stale';
      killedAt = Date.now();
      handle.kill('SIGTERM');
      scheduleKill();
    }

    // After signaling, wait briefly for the child to flush its
    // payload + exit. If we never observe a payload OR an exit
    // within (kill + 2×grace), bail with the kill verdict
    // anyway — the child is hung past SIGKILL, operator's
    // problem. The 2× cushion lets the SIGKILL setTimeout fire
    // and the kernel reap before we give up.
    if (killed !== undefined) {
      const sinceKill = Date.now() - killedAt;
      if (sinceKill >= graceMs * 2) {
        return { kind: killed };
      }
    }
    // Same bail-out for the abort path. `interruptCause === 'hard'`
    // already SIGTERMed and scheduled SIGKILL above; once the
    // 2×grace cushion expires without a payload or exit, surface
    // the hard verdict so the parent doesn't block forever on a
    // child that ignored every signal.
    if (interruptCause === 'hard') {
      const sinceHard = Date.now() - interruptAt;
      if (sinceHard >= graceMs * 2) {
        return { kind: 'aborted', cause: 'hard' };
      }
    }

    await sleep(pollDelay);
    pollDelay = Math.min(pollDelay * POLL_GROWTH, POLL_MAX_MS);
  }
};

// Spawn a subagent in a separate Bun subprocess (spec §11:1030).
// The parent creates the child session row + audit rows, spawns
// the binary, and waits for the child to publish its terminal
// envelope to `subagent_outputs`. On crash / timeout / abort,
// the parent synthesizes a result without a payload.
//
// Programmer errors throw (typo in whitelist, missing tools,
// recursion depth exceeded, parent_session_id missing) — those
// are caller bugs, not runtime states the model can recover
// from. Child-side failures (subprocess crash, wall-clock
// timeout, abort) resolve into `RunSubagentResult` with
// status='error'/'interrupted' so the caller's tool surfaces
// them as recoverable tool errors.
export const runSubagent = async (input: RunSubagentInput): Promise<RunSubagentResult> => {
  const { definition } = input;
  const depth = input.depth ?? 0;
  if (depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `subagent '${definition.name}': recursion depth ${depth} would exceed MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}`,
    );
  }
  const isolation = definition.isolation;
  // Defense in depth — bootstrap pre-validates, this catches
  // programmatic callers. The builtin-set alignment check fires
  // only when we're going to spawn a real subprocess (no
  // `spawnChildProcess` injection): the subprocess child
  // rebuilds its registry from `registerBuiltinTools()` and any
  // tool name that isn't in that set would surface as
  // `unknown_tool` mid-spawn. Tests that inject a fake spawn
  // simulate the child in-process and don't use the builtin
  // set, so the alignment check is moot for them.
  const willSpawnRealSubprocess = input.spawnChildProcess === undefined;
  assertWhitelistValidForSubagent(
    input.parentToolRegistry,
    definition.tools,
    definition.name,
    isolation === 'worktree',
    willSpawnRealSubprocess,
  );

  // 1. Worktree creation precedes session creation. We need the
  // child's cwd resolved before `createSession` records it on
  // the row.
  let worktreeHandle: WorktreeHandle | undefined;
  let worktreeError: { code: string; message: string } | undefined;
  if (isolation === 'worktree') {
    const worktreeId = crypto.randomUUID();
    try {
      worktreeHandle = await createWorktree({
        sessionId: worktreeId,
        prompt: input.prompt,
        parentCwd: input.cwd,
        ...(input.worktreeRootDir !== undefined ? { rootDir: input.worktreeRootDir } : {}),
      });
    } catch (e) {
      worktreeError = {
        code: 'worktree_create_failed',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  if (worktreeError !== undefined) {
    return {
      output: '',
      sessionId: '',
      status: 'error',
      reason: 'worktree_create_failed',
      costUsd: 0,
      steps: 0,
      durationMs: 0,
      worktreeError,
    };
  }

  const childCwd = worktreeHandle?.path ?? input.cwd;

  // 2. Create the child session row. is_subagent flag flips on
  // automatically because we set parent_session_id.
  //
  // Wrapped in try/catch BEFORE `cleanupOnFail` is defined
  // because that helper closes over `childSession.id`, which
  // doesn't exist yet. A throw here (FK violation if a concurrent
  // process deleted the parent, schema drift, disk full) would
  // otherwise leak the just-created worktree directory + agent
  // branch with no cleanup path. Worktree cleanup is the only
  // thing this catch handles — there's no session row to
  // finalize, no audit row to mark, no message to delete; just
  // the on-disk artifacts the prior step produced.
  let childSession: ReturnType<typeof createSession>;
  try {
    childSession = createSession(input.db, {
      model: input.provider.id,
      cwd: childCwd,
      parentSessionId: input.parentSessionId,
    });
  } catch (e) {
    if (worktreeHandle !== undefined) {
      await cleanupWorktree({ handle: worktreeHandle, parentCwd: input.cwd }).catch(
        () => undefined,
      );
    }
    throw e;
  }

  // Single guard around every pre-spawn write that can fail AND
  // the spawn itself. Any throw between session creation and the
  // child handle being live must:
  //   1. Reverse the worktree (if created) — leaving it on disk
  //      with no operator-visible audit is the worst outcome.
  //   2. Finalize the child session row to status='error' so it
  //      doesn't sit in 'running' forever. Without this,
  //      `--list-sessions` shows phantom active subagents and
  //      any operational logic that assumes only live runs are
  //      'running' (e.g., a future stale-session sweeper) gets
  //      misled. The harness normally finalizes via
  //      `completeSession` inside `runAgent`, but we never reach
  //      that path on a parent-side failure.
  // The session row + subagent_runs row are kept (they belong to
  // the audit trail even on a failed spawn) — only the
  // worktree is reversible, and the session's terminal status
  // is what the operator reads.
  const cleanupOnFail = async (): Promise<void> => {
    if (worktreeHandle !== undefined) {
      await cleanupWorktree({ handle: worktreeHandle, parentCwd: input.cwd }).catch(
        () => undefined,
      );
    }
    // Best-effort finalize. Swallow errors — the row may have
    // been finalized concurrently by an outer purge, or
    // `completeSession`'s status='running' guard may already
    // have flipped (it shouldn't, since we never ran the loop).
    // The audit value of leaving status='running' is far worse
    // than the noise of a swallow here.
    try {
      completeSession(input.db, childSession.id, 'error', 0, true);
    } catch {
      // ignore
    }
  };

  // 3. Insert the audit row (definition snapshot). MUST land
  // before spawn — the child reads from this row to build its
  // own harness config.
  try {
    insertSubagentRun(input.db, {
      sessionId: childSession.id,
      name: definition.name,
      scope: definition.scope,
      sourcePath: definition.sourcePath,
      sourceSha256: definition.sourceSha256,
      systemPrompt: definition.systemPrompt,
      toolsWhitelist: definition.tools,
      budgetMaxSteps: definition.budget.maxSteps,
      budgetMaxCostUsd: definition.budget.maxCostUsd,
      ...(definition.budget.maxWallClockMs !== undefined
        ? { budgetMaxWallMs: definition.budget.maxWallClockMs }
        : {}),
      // Snapshot the parent's resolved Policy so the subprocess
      // child runs under the same authorization rules the parent
      // validated. Without this, the child would re-resolve
      // `.agent/permissions.yaml` etc. on its own startup; an
      // edit between parent spawn and child read would diverge
      // the rules mid-run. The engine exposes its underlying
      // policy via `policy()`; that's the canonical source for
      // this snapshot.
      policySnapshot: input.permissionEngine.policy(),
      // Mirror snapshot for the hook chain (migration 020). Same
      // drift defense: child reads from this on startup instead
      // of re-resolving hooks.toml from disk, so an edit between
      // parent spawn and child read can't diverge the chain
      // mid-run. Falls through to disk re-resolve when the
      // caller didn't supply a chain (older test fixtures,
      // programmatic callers without a hook context).
      ...(input.hooksSnapshot !== undefined ? { hooksSnapshot: input.hooksSnapshot } : {}),
    });
  } catch (e) {
    await cleanupOnFail();
    throw e;
  }

  // 4. Append the user prompt as the seed message on the child
  // session row. The child's harness loads this via the
  // preassignedSessionId path and uses it as the conversation
  // start — the parent's prompt never crosses the IPC boundary
  // as a CLI arg (avoids quoting / size limits).
  try {
    appendMessage(input.db, {
      sessionId: childSession.id,
      role: 'user',
      content: input.prompt,
    });
  } catch (e) {
    await cleanupOnFail();
    throw e;
  }

  // 4b. Emit the lifecycle bracket open BEFORE spawn. A spawn
  // failure that returns early should still surface a
  // `subagent_start` followed by `subagent_finished` to the
  // parent's observer — symmetric brackets keep the renderer's
  // state machine clean (the alternative would be "start emitted
  // sometimes, depending on timing"). Wrapped in try/catch
  // because the observer is supplied by an outer caller and
  // should never break the run.
  const childEventObserver = input.onChildEvent;
  const fireChildEvent = (event: HarnessEvent): void => {
    if (childEventObserver === undefined) return;
    try {
      childEventObserver(event);
    } catch {
      // Observer bugs must not break the parent loop. Same
      // policy as `onIpcMessage`'s try-catch.
    }
  };
  fireChildEvent({
    type: 'subagent_start',
    subagentId: childSession.id,
    name: definition.name,
    prompt: input.prompt,
  });

  // Implicit IPC opt-in: an `onChildEvent` observer without the
  // wire is a contract bug. Channel-less mode delivers only
  // start/finished — no progress in between — which would silently
  // mislead consumers ("did the child do nothing?"). Force the
  // wire on so the events flow.
  const effectiveIpc = input.ipc === true || input.onChildEvent !== undefined;

  // 5. Spawn the subprocess. Production uses `Bun.spawn` of the
  // same binary; tests inject a fake that runs the harness
  // in-process and writes the payload synchronously. Spawn
  // throws synchronously on ENOENT / EACCES / out-of-fds — we
  // surface those as a clean run-failed result rather than
  // letting the exception escape, because the parent/model
  // should be able to recover (retry without the subagent, or
  // diagnose a deployment misconfiguration).
  const spawn = input.spawnChildProcess ?? defaultSpawnChildProcess;
  // Per-subagent bg log directory. Anchored to the PARENT's cwd
  // (not the child's, which may be a worktree path) so the
  // operator's `bg list` view from the project root continues to
  // work; segregated under a `subagents/` infix so the namespace
  // is self-documenting (parent's bg files live as
  // `.agent/bg/<bgId>.stdout.log` directly in the dir; subagent
  // bg files nest two more levels down at
  // `.agent/bg/subagents/<sessionId>/<bgId>.stdout.log`); per-
  // session subdirectory so concurrent subagents don't collide
  // and cleanup is a single recursive rm. The dir is created
  // lazily by the bg manager on first spawn — we only compute
  // the path here and forward it. For tests that inject a fake
  // spawn, the path is still computed (deterministic shape) but
  // unused by the fake.
  const bgLogDir = join(input.cwd, '.agent', 'bg', 'subagents', childSession.id);
  let handle: ChildProcessHandle;
  try {
    handle = spawn({
      sessionId: childSession.id,
      cwd: childCwd,
      depth,
      bgLogDir,
      // Memory anchor — parent's cwd, not childCwd. Worktree-
      // isolated subagents have a cache-directory cwd that
      // doesn't carry the parent's project_local subtree
      // (gitignored, never replicated to worktrees). Using the
      // parent's cwd keeps the child's view consistent with the
      // parent's: same shared, same local, same user scope.
      memoryCwd: input.cwd,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.planMode === true ? { planMode: true } : {}),
      ...(input.cwdTrusted === true ? { cwdTrusted: true } : {}),
      // Forward the IPC opt-in. The default spawn factory
      // converts this into pipe streams + the `--ipc=<n>` argv
      // flag; injected fakes can either build their own channel
      // (set handle.ipc) or ignore the flag (handle.ipc stays
      // undefined and the runtime degrades to payload-only).
      ...(effectiveIpc ? { ipc: true } : {}),
    });
  } catch (e) {
    await cleanupOnFail();
    // Bracket close on spawn failure too. The observer saw
    // `subagent_start` above; without a matching close the
    // parent's renderer would leak a live row indefinitely.
    fireChildEvent({
      type: 'subagent_finished',
      subagentId: childSession.id,
      status: 'error',
      summary: 'subprocess_spawn_failed',
      durationMs: 0,
      costUsd: 0,
    });
    return {
      output: '',
      sessionId: childSession.id,
      status: 'error',
      reason: 'subprocess_spawn_failed',
      costUsd: 0,
      steps: 0,
      durationMs: 0,
      worktreeError: {
        code: 'subprocess_spawn_failed',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  // 5b. Subscribe to the IPC channel (when present). Parent MUST
  // begin draining immediately on spawn — spec §2.3: if the
  // parent stops reading, the child blocks on its next stdout
  // write and the wedge masquerades as heartbeat staleness.
  // Subscribing before `waitForChild` runs guarantees the pump
  // loop is live for every message the child sends, including
  // an early `session_start` that may arrive before the child's
  // first SQLite write.
  //
  // Errors (malformed lines) are diagnostic-only; the channel
  // surface keeps them off the typed observer path. Drop on
  // stderr so an operator running with `--json` still sees the
  // signal (NDJSON contract: stdout pure, stderr admin).
  //
  // Protocol version handshake: spec §4.2 requires both sides
  // to refuse on mismatch BEFORE doing real work. The child
  // refuses pre-message when `--ipc=<n>` carries a version it
  // doesn't recognize; the parent's mirror-image check fires
  // on the child's first `session_start` (which carries the
  // version the child negotiated). On mismatch we kill the
  // child and stamp the result reason; the wait loop's
  // outcome handler downstream branches on this flag.
  let ipcVersionMismatch: number | undefined;
  // SIGKILL escalation timer for the mismatch path. Tracked at
  // this scope so the `handle.exited.then` handler below can
  // clear it the moment the child dies — without that, a child
  // that exits cleanly under SIGTERM would still leave the
  // unref'd timer pending until `gms` elapses, calling
  // `handle.kill('SIGKILL')` on a long-dead handle. The throw
  // is swallowed but the noise is preventable.
  let mismatchKillTimer: ReturnType<typeof setTimeout> | undefined;
  if (handle.ipc !== undefined) {
    // Idempotent on the FIRST mismatch only: the flag short-
    // circuits the body so a child that (regression-bug) sends
    // multiple session_starts won't re-execute the kill
    // cascade. The previous attempt at self-unsubscribe was
    // racy — `onMessage` synchronously replays the channel's
    // pre-subscribe buffer BEFORE returning, so the local
    // `unsubscribe` reference was still `undefined` when a
    // buffered mismatched session_start fired. The flag check
    // is the only correct gate.
    handle.ipc.onMessage((msg) => {
      if (ipcVersionMismatch !== undefined) return;
      if (msg.type !== 'session_start') return;
      if (msg.protocolVersion === IPC_PROTOCOL_VERSION) return;
      // Mismatch: child speaks a version we don't recognize.
      // Record for the result-building branch and tear the
      // child down. Send interrupt:hard so a child that DOES
      // honor the wire (just not the version) still drains
      // cleanly; SIGTERM is the fallback.
      ipcVersionMismatch = msg.protocolVersion;
      try {
        handle.ipc?.send(makeInterruptHard());
      } catch {
        // Channel may already be torn down; SIGTERM below
        // covers the dead-pipe case.
      }
      handle.kill('SIGTERM');
      // Belt-and-suspenders SIGKILL escalation. A child that
      // ignores SIGTERM (custom signal handler, infinite loop
      // in the harness's exit path) would otherwise block the
      // parent's wait loop forever — the regular hard-trigger
      // path that schedules SIGKILL only fires when
      // signal.aborted, which a protocol-mismatch caller didn't
      // necessarily set. Use the caller's graceMs (or the
      // default) so the escalation is bounded by the same
      // window as every other kill path.
      const gms = input.graceMs ?? WALL_CLOCK_GRACE_MS;
      mismatchKillTimer = setTimeout(() => {
        try {
          handle.kill('SIGKILL');
        } catch {
          // Already exited; ignore.
        }
      }, gms);
      mismatchKillTimer.unref?.();
    });
    // Clear the mismatch SIGKILL timer once the child exits —
    // mirrors the wait loop's own exit-handler cleanup of its
    // SIGKILL escalation timer.
    handle.exited.then(() => {
      if (mismatchKillTimer !== undefined) {
        clearTimeout(mismatchKillTimer);
        mismatchKillTimer = undefined;
      }
    });
    if (input.onIpcMessage !== undefined) {
      const observer = input.onIpcMessage;
      handle.ipc.onMessage((msg) => {
        try {
          observer(msg);
        } catch {
          // Observer bugs must not break the parent loop.
        }
      });
    }
    // Typed child-event forwarding (S2). For each `event` IPC
    // variant arriving from the child, decode the inner
    // HarnessEvent and re-emit as `subagent_progress` on the
    // parent's observer. Drops nested subagent observability and
    // session_finished — the parent doesn't render its
    // grandchildren, and the bracket close fires from
    // waitForChild's outcome below.
    if (childEventObserver !== undefined) {
      handle.ipc.onMessage((msg) => {
        if (msg.type !== 'event') return;
        const inner = msg.event;
        if (
          typeof inner !== 'object' ||
          inner === null ||
          typeof (inner as { type?: unknown }).type !== 'string'
        ) {
          // Defensive: the child should have sent a real
          // HarnessEvent; a corrupted payload is logged once
          // and dropped.
          return;
        }
        const innerType = (inner as { type: string }).type;
        if (
          innerType === 'session_finished' ||
          innerType === 'subagent_start' ||
          innerType === 'subagent_progress' ||
          innerType === 'subagent_finished'
        ) {
          return;
        }
        fireChildEvent({
          type: 'subagent_progress',
          subagentId: childSession.id,
          lastEvent: inner as HarnessEvent,
        });
      });
    }
    handle.ipc.onError((err) => {
      process.stderr.write(
        `subagent ${childSession.id}: ipc malformed line dropped (${err.reason}): ${err.line.slice(0, 120)}\n`,
      );
    });
  }

  // 6. Wait for the child. Outcome maps to the result envelope:
  //    payload   → use child's reported status/reason/cost
  //    crashed   → status='error', reason='subprocess_crashed'
  //    aborted   → status='interrupted', reason='aborted'
  //    wall_clock → status='interrupted', reason='maxWallClockMs'
  //
  // C4 fix: parent's effective wall-clock = child's budget +
  // 2× grace. Without the buffer, a child whose own
  // wall-clock budget fires at the same instant the parent's
  // does would race against the parent's SIGTERM/SIGKILL —
  // the parent could kill the child mid-`setSubagentPayload`,
  // losing the terminal envelope and reporting
  // `subprocess_crashed` instead of the honest `interrupted`.
  // The buffer gives the child time to (a) hit its own
  // wall-clock, (b) write the envelope with status='interrupted',
  // (c) exit cleanly. Caller's explicit `wallClockMs` overrides
  // the buffered value — tests rely on that to exercise the
  // timeout path quickly.
  const startTs = Date.now();
  const childWallClockMs = definition.budget.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const graceMs = input.graceMs ?? WALL_CLOCK_GRACE_MS;
  const wallClockMs = input.wallClockMs ?? childWallClockMs + graceMs * 2;
  const heartbeatStaleMs = input.heartbeatStaleMs ?? HEARTBEAT_STALE_THRESHOLD_MS;
  const outcome = await waitForChild({
    db: input.db,
    sessionId: childSession.id,
    handle,
    signal: input.signal,
    softStopSignal: input.softStopSignal,
    wallClockMs,
    graceMs,
    heartbeatStaleMs,
    startTs,
  });

  // Tear down the IPC channel before bg/worktree cleanup. The
  // child's own finally already sent `session_finished` and
  // closed its side; closing here releases the parent's pump
  // loop subscription so the post-run cleanup runs without a
  // dangling reader on a defunct stream. Idempotent —
  // transport.close() short-circuits if already closed.
  if (handle.ipc !== undefined) {
    handle.ipc.close();
  }

  // 7a. Reap orphan bg processes BEFORE worktree cleanup. The
  // happy path (child exits cleanly via published payload)
  // already runs the child harness's bgManager.cleanup() hook
  // before the subprocess ends — by the time we get here, the
  // bg DB rows should be in terminal status. But the child can
  // also exit via paths that bypass its own finally:
  //
  //   - SIGKILL on heartbeat staleness (4.2b.ii.b): the harness's
  //     finally is uncatchable, the bg manager's cleanup never
  //     runs, and bg processes the child spawned are reparented
  //     to PID 1, kept alive by the kernel.
  //   - SIGKILL on wall-clock budget exceeded.
  //   - Caller abort that escalated past SIGTERM grace.
  //
  // In those paths the bg DB still has `status='running'` rows
  // pointing at PIDs that are now orphaned. The reaper:
  //   1. Queries the child's running rows.
  //   2. SIGTERM each verified PID; waits BG_REAP_GRACE_MS.
  //   3. SIGKILL any still-verified survivors.
  //   4. Per-row markBgProcessAsKilled for matched/gone rows.
  //
  // Best-effort throughout — if a kill fails (process already
  // exited, EPERM, ESRCH), we move on. The reaper exists so the
  // operator never sees zombies under a finished subagent's
  // session ID, not as a security boundary.
  //
  // Order matters: reap MUST precede `cleanupWorktree`. A bg
  // process the child spawned with `bash_background` defaults to
  // the worktree as its cwd. While alive, that process pins the
  // worktree directory in two ways the cleanup is sensitive to:
  //   - Dirtiness check: bg writers can race with `git status
  //     --porcelain`, producing partial-write artifacts that
  //     trigger preserve when the post-reap state would have
  //     been clean.
  //   - Removal failure: `git worktree remove --force` can fail
  //     on filesystems that refuse to drop a directory while
  //     another process has it as cwd (Linux is lenient here,
  //     but Windows / older macOS / NFS mounts are not — and the
  //     existing cleanupWorktree comment already calls out this
  //     failure mode). The audit then records 'preserved' for a
  //     worktree that's logically empty but stuck.
  // Reaping first stabilizes the state: bg processes are dead,
  // their cwd-pins released, the worktree's tracked diff stops
  // changing, and the cleanup pass sees a deterministic snapshot.
  await reapChildBgProcesses(input.db, childSession.id);

  // 7b. Cleanup worktree if isolated. Same contract as 4.2a:
  // clean tree → remove; dirty tree → preserve.
  let cleanup: CleanupResult | undefined;
  let auditFailure: { code: string; message: string } | undefined;
  if (worktreeHandle !== undefined) {
    cleanup = await cleanupWorktree({
      handle: worktreeHandle,
      parentCwd: input.cwd,
    });
    try {
      insertSubagentWorktree(input.db, {
        sessionId: childSession.id,
        path: worktreeHandle.path,
        branch: worktreeHandle.branch,
        status: cleanup.removed ? 'cleaned' : 'preserved',
      });
    } catch (e) {
      auditFailure = {
        code: 'worktree_audit_insert_failed',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Best-effort cleanup of the per-subagent bg log directory —
  // BUT ONLY if every bg row reached terminal status. The
  // reaper bails on non-Linux (no /proc, no identity check) and
  // can also leave rows as 'running' if `markRunningAsKilled`
  // hits a DB write error after the kills succeeded. In either
  // case, removing the log dir would unlink files that processes
  // (still alive on the OS) are actively writing to — the exact
  // unlink-while-running behavior the reaper exists to prevent.
  // The dir also holds artifacts the operator needs for manual
  // investigation when the reap fell short.
  //
  // Re-query post-reap; if the DB shows no 'running' rows for
  // this child session, every process is accounted for and the
  // dir is safe to remove. Otherwise we leave it; `agent worktree
  // gc` (4.2d) will reconcile alongside the audit table.
  let stillRunningCount: number;
  try {
    stillRunningCount = listBgProcessesBySession(input.db, childSession.id, {
      status: 'running',
    }).length;
  } catch {
    // Defensive: if the re-query fails (DB locked / corrupt),
    // assume the worst and skip the rmSync. Operator
    // investigates via gc.
    stillRunningCount = -1;
  }
  if (stillRunningCount === 0) {
    // ENOENT is expected (bg manager creates the dir lazily on
    // first spawn — subagents that never invoked a bg tool leave
    // no directory to remove), so we silence it; other errors
    // (permission denied, disk full, etc.) get logged to stderr
    // so the operator knows the cache is leaking. Cleanup failure
    // never changes the run outcome — operator's `agent worktree
    // gc` (4.2d) sweeps stragglers.
    try {
      rmSync(bgLogDir, { recursive: true, force: true });
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(
          `subagent ${childSession.id}: failed to remove bg log dir '${bgLogDir}': ${e.message}\n`,
        );
      }
    }
  } else if (stillRunningCount > 0) {
    process.stderr.write(
      `subagent ${childSession.id}: bg log dir '${bgLogDir}' preserved — ${stillRunningCount} bg row(s) still 'running' (reaper deferred or kill incomplete); inspect via OS tools or 'agent worktree gc'\n`,
    );
  }
  // stillRunningCount === -1: re-query failed; warning already
  // implicit (operator will notice the leftover dir).

  // 8. Build the result envelope from the wait outcome.
  let result: RunSubagentResult;
  switch (outcome.kind) {
    case 'payload': {
      result = buildResultFromPayload(outcome.payload, childSession.id);
      break;
    }
    case 'crashed': {
      // Distinguish IPC version mismatch from generic crash. The
      // child refuses with `IPC_VERSION_MISMATCH_EXIT_CODE` BEFORE
      // sending any IPC message (spec §4.2), so the exit code is
      // the only signal channel for the startup-refusal case —
      // the parent's session_start mismatch listener never fires
      // when the child gates pre-message. Mapping here closes
      // the loop for mixed-version deployments where the parent
      // runs a newer protocol than the child's binary.
      //
      // Gate on `effectiveIpc`: a child invoked WITHOUT `--ipc`
      // never enters the version-check path, so an exit code of
      // 64 from such a child means the value came from somewhere
      // else (a tool that called `process.exit(64)`, a build
      // accidentally returning the EX_USAGE constant). Without
      // this gate, those would be mis-stamped as version
      // mismatches even though IPC was off and no version was
      // negotiated. Tighter sentinel = fewer false positives.
      const reason: RunSubagentResult['reason'] =
        effectiveIpc && outcome.exitCode === IPC_VERSION_MISMATCH_EXIT_CODE
          ? 'ipc_version_mismatch'
          : 'subprocess_crashed';
      result = {
        output: '',
        sessionId: childSession.id,
        status: 'error',
        reason,
        costUsd: 0,
        steps: 0,
        durationMs: Date.now() - startTs,
      };
      break;
    }
    case 'aborted': {
      // S3: surface the soft/hard discriminator from the wait
      // outcome onto the synthesized result. The payload-arrived
      // path already pulls `abort_cause` off the child's envelope
      // via `buildResultFromPayload`; this branch is the
      // no-payload synthesis (child crashed/killed before
      // publishing) and the `outcome.cause` is the parent's own
      // observation of which signal won.
      result = {
        output: '',
        sessionId: childSession.id,
        status: 'interrupted',
        reason: 'aborted',
        costUsd: 0,
        steps: 0,
        durationMs: Date.now() - startTs,
        abortCause: outcome.cause,
      };
      break;
    }
    case 'wall_clock': {
      result = {
        output: '',
        sessionId: childSession.id,
        status: 'interrupted',
        reason: 'maxWallClockMs',
        costUsd: 0,
        steps: 0,
        durationMs: Date.now() - startTs,
      };
      break;
    }
    case 'heartbeat_stale': {
      // Child stopped pulsing — typically a wedge inside a
      // tool call (provider request hung, sync block). Same
      // shape as wall_clock: 'interrupted' status, lower-bound
      // cost (we don't know what the child accumulated before
      // the wedge). Distinct reason so operators can
      // distinguish "hit the time budget" from "appeared hung
      // before the budget".
      result = {
        output: '',
        sessionId: childSession.id,
        status: 'interrupted',
        reason: 'heartbeat_stale',
        costUsd: 0,
        steps: 0,
        durationMs: Date.now() - startTs,
      };
      break;
    }
  }

  // Protocol version mismatch override: spec §4.2 mandates the
  // run be refused before useful work runs. If the version
  // listener fired, the child was killed mid-spawn; the wait
  // loop's outcome (`aborted` / `crashed` depending on timing)
  // is technically correct but operationally misleading — the
  // operator cares that this was a protocol problem, not a
  // runtime abort. Stamp the dedicated reason.
  if (ipcVersionMismatch !== undefined) {
    result = {
      output: '',
      sessionId: childSession.id,
      status: 'error',
      reason: 'ipc_version_mismatch',
      costUsd: 0,
      steps: 0,
      durationMs: Date.now() - startTs,
    };
  }

  // Best-effort finalize the child session row. The 'payload'
  // outcome already saw the child's harness call
  // `completeSession` before publishing — the call here is a
  // no-op for that path because `completeSession` filters on
  // `status='running'` and a finalized row no longer matches.
  // For the kill paths (`crashed`/`aborted`/`wall_clock`) the
  // child was terminated before its harness could finalize,
  // and without the call below the session row sits in
  // 'running' indefinitely — phantom active sessions in
  // `--list-sessions` and a misleading signal for any future
  // stale-session sweeper. Mapping is lossless:
  //   result.status ∈ { done, exhausted, error, interrupted }
  // and that's exactly the terminal `SessionStatus` shape
  // `completeSession` accepts.
  //
  // `usageComplete` flag: only the 'payload' outcome carries
  // an authoritative cost (the child's harness measured it
  // before publishing). For 'crashed' / 'aborted' / 'wall_clock'
  // the synthesized `result.costUsd === 0` is a lower bound —
  // the child may well have made expensive provider calls
  // before dying, but we have no way to read its in-flight
  // accumulator across the IPC boundary. Marking the row
  // `usage_complete = false` tells consumers (cost rollups,
  // budget reconciliation, billing audits) "this total is a
  // floor, not authoritative" — same semantics the harness
  // uses for its own incomplete-measurement paths.
  //
  // Wrapped in try/catch because the function throws when the
  // row already finalized (concurrent purge, child raced to
  // it) — that's a non-event, not an error to surface. On
  // that no-op path the value of `usageComplete` we pass is
  // irrelevant; the child's own finalize already set the row.
  const usageComplete = outcome.kind === 'payload';
  try {
    completeSession(input.db, childSession.id, result.status, result.costUsd, usageComplete);
  } catch {
    // ignore — the row is already in a terminal state
  }

  // Bracket close (S2): fire `subagent_finished` for the typed
  // observer. Summary picks the first non-blank line of the
  // child's output (capped at 80 chars) so the parent's
  // permanent line shows what the run actually produced.
  // `output` is empty for non-payload outcomes (crashed /
  // aborted / wall-clock) — fall back to the reason in those
  // cases so the operator sees something meaningful.
  const summaryFromOutput = (raw: string): string => {
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (firstLine.length === 0) return '';
    if (firstLine.length <= 80) return firstLine;
    return `${firstLine.slice(0, 79)}…`;
  };
  const summary = result.output.length > 0 ? summaryFromOutput(result.output) : `${result.reason}`;
  fireChildEvent({
    type: 'subagent_finished',
    subagentId: childSession.id,
    status: result.status,
    summary,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
  });

  // Attach worktree shape and any audit failure side-channel.
  return {
    ...result,
    ...(auditFailure !== undefined ? { auditFailure } : {}),
    ...(worktreeHandle !== undefined && cleanup !== undefined
      ? {
          worktree: {
            path: worktreeHandle.path,
            branch: worktreeHandle.branch,
            dirty: cleanup.dirty,
            preserved: cleanup.preserved,
            removed: cleanup.removed,
          },
        }
      : {}),
  };
};

