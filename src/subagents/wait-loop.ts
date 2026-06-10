import { type DB, getSubagentOutput } from '../storage/index.ts';
import { isExpectedIpcTeardown, makeInterruptHard, makeInterruptSoft } from './ipc.ts';
import type { ChildProcessHandle } from './spawn-factory.ts';

// Default wall-clock for a subagent run when the definition
// doesn't specify `budget.maxWallClockMs`. 1 hour is enough
// for substantive work (refactor, audit, multi-file edit) while
// still bounding a hung child to that window.
// Definitions that need longer override via budget.
export const DEFAULT_WALL_CLOCK_MS = 60 * 60 * 1000;

// Time the parent waits between SIGTERM and SIGKILL on either a
// caller abort or wall-clock timeout. 5s matches FAILURE_MODES
// §7.3's "5s grace; SIGKILL" mandate. The child has this window
// to flush its terminal payload to `subagent_outputs` before the
// kernel drops it.
export const WALL_CLOCK_GRACE_MS = 5_000;

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
// would catch this in DEFAULT_WALL_CLOCK_MS (1h) — the
// heartbeat path catches it in single-digit seconds.
//
// The child writes every HEARTBEAT_CADENCE_MS=2000ms (defined
// in cli/subagent-child.ts). 3 missed beats = 6s of silence.
// Floor at 10s to absorb transient SQLite contention / GC
// pauses without false-positive killing of healthy children.
export const HEARTBEAT_STALE_THRESHOLD_MS = 10_000;

// Startup deadline for the child's FIRST pulse. The heartbeat-stale
// path above only fires once `last_heartbeat` is non-null — but the
// child stamps its first beat only AFTER `insertSubagentOutput`, and
// everything before that (open DB, run migrations, detect the
// sandbox, load the audit row, assemble the system prompt, construct
// the provider) runs with no heartbeat coverage. A child wedged in
// that window (SQLite lock on open, a hung sandbox probe, slow cold
// start of the compiled binary) would otherwise be caught only by
// the wall-clock ceiling — DEFAULT_WALL_CLOCK_MS (1h).
//
// This bounds the boot-hang to single-digit-times-ten seconds. The
// child does only LOCAL work before its first beat (no provider
// request — that happens inside the harness loop, after the beat is
// running), so 30s is a generous ceiling: a healthy boot is
// sub-second even on a loaded machine, and the cushion absorbs cold
// binary start + migration replay + SQLite contention without a
// false-positive kill. The child writes its first beat at
// HEARTBEAT_CADENCE_MS (2s) after the outputs row lands, so a healthy
// child clears this gate with ~28s to spare.
export const STARTUP_STALE_THRESHOLD_MS = 30_000;

// Wait for the subprocess to publish its terminal payload, OR
// exit without one (child crashed), OR be killed by signal /
// wall-clock. Returns the resolved state; the runtime's caller
// converts it into `RunSubagentResult`.
export type WaitOutcome =
  | { kind: 'payload'; payload: Record<string, unknown> }
  | { kind: 'crashed'; exitCode: number }
  | { kind: 'aborted'; cause: 'soft' | 'hard' }
  | { kind: 'wall_clock' }
  | { kind: 'heartbeat_stale' }
  | { kind: 'startup_stalled' };

interface WaitForChildArgs {
  db: DB;
  sessionId: string;
  handle: ChildProcessHandle;
  signal: AbortSignal | undefined;
  // Parent's cooperative-stop signal. Triggers `interrupt:soft`
  // over IPC; the child's harness exits at the next step boundary.
  // Without IPC, no-op for the subprocess path (the OS has no
  // cooperative signal). Hard `signal` above remains the
  // preemptive escalation target.
  softStopSignal: AbortSignal | undefined;
  wallClockMs: number;
  graceMs: number;
  heartbeatStaleMs: number;
  // Deadline for the child's FIRST heartbeat, measured from
  // `startTs`. While the child has never pulsed (no outputs row, or
  // the row exists but `last_heartbeat` is still null), the
  // heartbeat-stale path can't fire; this catches a boot-time wedge
  // that would otherwise wait out the full wall-clock.
  startupStaleMs: number;
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

export const waitForChild = async (args: WaitForChildArgs): Promise<WaitOutcome> => {
  const {
    db,
    sessionId,
    handle,
    signal,
    softStopSignal,
    wallClockMs,
    graceMs,
    heartbeatStaleMs,
    startupStaleMs,
    startTs,
  } = args;

  let pollDelay = POLL_INITIAL_MS;
  // `killed` tracks non-abort kill verdicts (wall_clock,
  // heartbeat_stale). The abort path uses `interruptCause`
  // separately so its soft/hard discriminator survives into
  // the outcome.
  let killed: 'wall_clock' | 'heartbeat_stale' | 'startup_stalled' | undefined;
  let killedAt = 0;
  // Tri-state tracking the parent's cooperative-vs-preemptive
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
      //   1. `killed` (wall_clock / heartbeat_stale / startup_stalled):
      //      system constraint terminations win over operator intent.
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

    // Soft trigger. Parent's cooperative-stop
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
        } catch (e) {
          // Channel may be torn down; the OS-level kill path
          // below picks up the slack on grace expiry. Only
          // surface unexpected errors so a serialization or
          // transport bug doesn't get masked as a normal race.
          if (!isExpectedIpcTeardown(e)) {
            process.stderr.write(
              `subagent ${sessionId}: ipc send (interrupt:soft) failed unexpectedly: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
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
        } catch (e) {
          // SIGTERM below covers the channel-broken case; only
          // surface unexpected throws so a serialization bug
          // doesn't hide behind the OS-fallback safety net.
          if (!isExpectedIpcTeardown(e)) {
            process.stderr.write(
              `subagent ${sessionId}: ipc send (interrupt:hard) failed unexpectedly: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
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

    // Startup deadline — the child has never pulsed (outputs row
    // absent, OR present but `last_heartbeat` still null) and the
    // first-pulse window has elapsed since spawn. Mutually exclusive
    // with the heartbeat-stale check below, which structurally
    // requires a non-null `last_heartbeat`: a child that wedges
    // BEFORE its first beat (boot-time hang) is invisible to that
    // path and would otherwise sit until the wall-clock ceiling.
    // Same escalation shape: SIGTERM now, SIGKILL after grace.
    if (
      killed === undefined &&
      interruptCause === undefined &&
      (out === null || out.lastHeartbeat === null) &&
      Date.now() - startTs > startupStaleMs
    ) {
      killed = 'startup_stalled';
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
