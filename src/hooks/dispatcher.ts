import { redactSecrets } from '../sanitize/secrets.ts';
import type { DB } from '../storage/db.ts';
import { createHookRun } from '../storage/repos/hook-runs.ts';
import { classifyExitCode, matchesPayload } from './dispatcher-matching.ts';
import { getCachedShell, type HookShellResolution } from './dispatcher-shell.ts';
import { type DispatchedProcess, defaultSpawn, type SpawnFn } from './dispatcher-spawn.ts';
import { readStream, truncate } from './dispatcher-stream.ts';
import { expandTemplate } from './template.ts';
import {
  BLOCKING_EVENTS,
  type HookChainResult,
  type HookEventPayload,
  type HookRunResult,
  type HookSpec,
  MAX_HOOK_CHAIN_MS,
} from './types.ts';

export { filterMatchingHooks } from './dispatcher-matching.ts';
export {
  _resetHookShellCacheForTests,
  type HookShellResolution,
  type ResolveHookShellOpts,
  resolveHookShell,
} from './dispatcher-shell.ts';
export type { DispatchedProcess, SpawnFn, SpawnOpts } from './dispatcher-spawn.ts';
export { _readStreamForTests, STREAM_READ_CAP_BYTES } from './dispatcher-stream.ts';

// Hook dispatcher (spec AGENTIC_CLI.md §10.3 + CONTRACTS.md §3 +
// §10).
//
// Owns the spawn → wait → parse-exit-code → audit pipeline for a
// single hook AND the chain orchestration for one event:
//
//   - Per-hook: spawn `sh -c "<expanded>"`, write JSON event
//     payload to stdin, wait with timeout (SIGTERM → 1s →
//     SIGKILL), capture stdout/stderr (truncated to 4KB), map
//     exit code to a `HookRunResult` discriminator.
//
//   - Per-event chain: iterate hooks that match (event + matcher),
//     run sequentially, stop at the first blocking decision for
//     blockable events. Whole-chain timeout (15s default) caps
//     wall-clock so a misbehaving chain can't freeze the
//     harness.
//
// SECURITY CONTRACT (mirrors CONTRACTS.md §3 lines 706-709):
//
//   - Env passed to child: PATH, HOME, AGENT_SESSION_ID,
//     AGENT_CWD only. Operators relying on other env vars must
//     `source` their own profile inside the hook command.
//   - cwd of child = session cwd (from payload data).
//   - stdin = JSON event payload + `\n`. No prompt injection
//     vectors via the payload itself; the operator's shell
//     command can introduce them but that's their responsibility.
//
// Failure modes the dispatcher handles internally (returns
// HookRunResult variants):
//
//   - Timeout → kind='timeout'. Audit row records exit_code=124
//     (POSIX `timeout(1)` convention per CONTRACTS.md §3 line
//     725) regardless of the killed-process's signal-derived
//     code (143/137 for SIGTERM/SIGKILL — neither carries
//     decision semantics).
//   - Spawn error (command not found, permission denied, etc.)
//     → kind='error', exit_code synthesized to 127 / 126 by
//     the shell when applicable. Audit row outcome='error'.
//   - Stdin write error (rare — child closed stdin early) →
//     ignored; we keep waiting for the process to exit.
//
// Dispatch is INHERENTLY async (subprocess wait) but the
// surrounding subsystem may be sync (e.g., bootstrap). Caller
// chooses fire-and-forget for non-blocking events.

export interface DispatcherDeps {
  // Persistent DB handle for audit emission. Optional so a
  // headless / one-shot dispatch (where audit storage is
  // unavailable) can still run hooks without a `recordEvent`-
  // style throw.
  db?: DB;
  // Active session id for audit attribution. Null when the
  // dispatcher fires before the harness has created the
  // session (SessionStart hook runs at boot — the session id
  // exists but the dispatcher caller may not yet have it).
  sessionId?: string | null;
  // Wall-clock source. Tests inject a counter; production
  // uses Date.now.
  now?: () => number;
  // Spawn override for tests. Defaults to Bun's subprocess
  // spawn. The shape mirrors `Bun.spawn` so tests can swap a
  // synthetic process driver without rewriting the dispatcher.
  spawn?: SpawnFn;
  // Shell resolution override. Production uses the cached
  // `resolveHookShell()` result; tests inject a fixture so a
  // Linux runner can verify the Windows-fallback path without
  // actually running on Windows.
  shell?: HookShellResolution;
  // Per-call timeout override. dispatchChain clamps each
  // blocking hook's `spec.timeoutMs` against the remaining
  // chain budget (`MAX_HOOK_CHAIN_MS - elapsed`) so a hook
  // configured with `timeout_ms = 30000` can't push a chain
  // past the 15s wall-clock cap. When set, dispatchOne uses
  // this instead of `spec.timeoutMs` both for the timer AND
  // for the audit row's recorded timeout. Caller must respect
  // the operator's spec.timeoutMs as the upper bound.
  effectiveTimeoutMs?: number;
  // Slice 181 — kill switch. When true, `dispatchChain` returns
  // an empty chain immediately without evaluating matchers,
  // spawning hooks, or emitting audit rows. Per CONTRACTS.md
  // hook hierarchy, managed settings can pin this at the
  // enterprise layer; user/project layers cannot un-set it.
  // Resolution + locking lives in the config-load step
  // (bootstrap/runtime); the dispatcher just reads the
  // already-resolved value.
  disableAllHooks?: boolean;
}

// Build the env dict passed to the hook subprocess. Strict
// allow-list per CONTRACTS.md §3 line 707: PATH, HOME,
// AGENT_SESSION_ID, AGENT_CWD only. AGENT_SESSION_ID is always
// present for shape consistency — empty string when no session
// id is available (e.g., SessionStart hook firing before the
// harness loop creates the row). Spec doesn't say "omit when
// missing"; an operator's hook script can `[ -z "$AGENT_SESSION_ID" ]`
// to detect the no-session window.
const buildHookEnv = (sessionCwd: string, sessionId: string | null): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  AGENT_CWD: sessionCwd,
  AGENT_SESSION_ID: sessionId ?? '',
});

// Run one hook with timeout + audit emission. Returns the
// dispatcher's outcome; the caller chains decisions.
export const dispatchOne = async (
  spec: HookSpec,
  hookIndex: number,
  payload: HookEventPayload,
  cwd: string,
  deps: DispatcherDeps,
): Promise<HookRunResult> => {
  const now = deps.now ?? (() => Date.now());
  const spawn = deps.spawn ?? defaultSpawn;
  const startedAt = now();

  // Template-expand the command against the payload (data
  // shape per HookEventPayload). All values are shell-quoted by
  // default — see template.ts for the contract.
  const { expanded } = expandTemplate(spec.command, payload);

  // Spawn `<shell> <flag> "<expanded>"` so operators get
  // pipelines, redirections, and env-var interp. We DON'T
  // inherit env; strict allow-list per CONTRACTS.md §3. Shell
  // selection is platform-aware (resolveHookShell): `sh` /
  // `bash` on POSIX, `cmd.exe /c` as Windows fallback when no
  // POSIX shell is on PATH. When NEITHER is available, the
  // chain short-circuits in dispatchChain — we should never
  // reach here.
  const shell = deps.shell ?? getCachedShell();
  if (shell.kind === 'unavailable') {
    // Defensive — dispatchChain filters this out before calling
    // dispatchOne, but the test seam may pass an unavailable
    // shell directly. Synthesize an error result with
    // shouldBlock=false so failClosed hooks don't wrongly deny.
    const durationMs = now() - startedAt;
    return {
      kind: 'error',
      exitCode: -1,
      reason: `shell unavailable: ${shell.reason}`,
      durationMs,
      shouldBlock: false,
    };
  }
  // Audit-emission closure shared by the spawn-failure catch
  // below AND the normal path further down. Extracted so a
  // synchronous spawn throw doesn't drop the row that operator
  // queries (`/hooks audit`) need to forensically diagnose
  // "why did my hook fail?".
  const emitAudit = (
    exitCode: number | null,
    outcome: HookRunResult['kind'],
    durationMs: number,
    stdout: string | null,
    stderr: string | null,
  ): void => {
    if (deps.db === undefined) return;
    try {
      const matcherTool =
        payload.event === 'PreToolUse' ||
        payload.event === 'PostToolUse' ||
        payload.event === 'PostToolUseFailure'
          ? payload.data.tool.name
          : null;
      createHookRun(deps.db, {
        sessionId: deps.sessionId ?? null,
        event: spec.event,
        layer: spec.layer,
        sourcePath: spec.sourcePath,
        hookIndex,
        command: spec.command,
        expanded,
        exitCode,
        outcome,
        durationMs,
        stdout,
        stderr,
        matchedTool: matcherTool,
        createdAt: now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Slice 178 (review — P2 defense in depth). The audit-drift
      // stderr line is operator-visible AND captured by any
      // process supervisor / log aggregator the operator runs
      // (journald, container log drivers, etc). A db-side error
      // can include the offending SQL statement, which can include
      // bound-parameter values from the hook's stdout/stderr (a
      // hook that printed a Bearer token would land in the error).
      // Redact secrets in the message; the operator still gets
      // the structural failure shape and the spec hint.
      process.stderr.write(
        `hooks: AUDIT DRIFT: failed to record ${spec.event} run (${spec.sourcePath}#${hookIndex}): ${redactSecrets(msg)}\n`,
      );
    }
  };

  let proc: DispatchedProcess;
  try {
    proc = spawn([...shell.argv, expanded], {
      env: buildHookEnv(cwd, deps.sessionId ?? null),
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    // Synchronous spawn failure. Common causes: `cwd` no
    // longer exists (ENOTDIR / ENOENT — operator deleted the
    // directory between session boot and hook dispatch), the
    // resolved shell binary lost permission since module load
    // (EACCES), or fd / process-table exhaustion. Without
    // this catch, the throw propagates up through
    // dispatchChain into the harness's `dispatchHooks`
    // try/catch, which converts to `null` (fail-OPEN) — for
    // blocking events that bypasses `failClosed` AND drops
    // the expected audit row. Convert to a normal error
    // HookRunResult so failClosed still gates and forensic
    // queries see the spawn failure. exit_code -1 is a
    // synthetic marker (no real process to read from);
    // operator query `WHERE exit_code = -1` finds these.
    const durationMs = now() - startedAt;
    const reason = err instanceof Error ? err.message : String(err);
    const result: HookRunResult = {
      kind: 'error',
      exitCode: -1,
      reason: `spawn failed: ${reason}`,
      durationMs,
      shouldBlock: spec.failClosed,
    };
    emitAudit(-1, 'error', durationMs, null, reason);
    return result;
  }

  // Write the JSON payload to stdin and close. Process can
  // ignore it; that's fine. Stdin write errors are swallowed —
  // the spawn already happened, we proceed to exit-wait.
  try {
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    proc.stdin.end();
  } catch {
    // Operator's command may not consume stdin; pipe close on
    // the child side surfaces here as EPIPE. Not a dispatcher
    // failure.
  }

  // Concurrently: wait for exit, drain stdout/stderr, race
  // timeout. Race carries the WINNER's discriminator so each
  // branch owns its teardown. A shared `timedOut` bool would
  // land true even when the natural-exit branch ultimately
  // won the race (timer microsecond-firing on a clean exit),
  // causing the dispatcher to misreport a normal exit as
  // `timeout` — tagged-result race avoids the shared mutable
  // state.
  const stdoutP = readStream(proc.stdout);
  const stderrP = readStream(proc.stderr);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let killHandle: ReturnType<typeof setTimeout> | undefined;

  type RaceWinner = { kind: 'exited'; code: number } | { kind: 'timeout' };

  const exitedPromise: Promise<RaceWinner> = proc.exited.then((code) => ({
    kind: 'exited',
    code,
  }));
  // Effective timeout: chain may clamp this below spec.timeoutMs
  // when the chain budget is nearly exhausted (see DispatcherDeps
  // doc). Audit row + result both record the EFFECTIVE value so
  // forensic readers see the deadline that actually fired.
  const effectiveTimeoutMs = deps.effectiveTimeoutMs ?? spec.timeoutMs;
  const timeoutPromise: Promise<RaceWinner> = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      proc.kill('SIGTERM');
      killHandle = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 1000);
      resolve({ kind: 'timeout' });
    }, effectiveTimeoutMs);
  });

  const winner = await Promise.race([exitedPromise, timeoutPromise]);

  // Each branch settles its own teardown + final exit code.
  // After the if/else, `exitCode`, `stdout`, `stderr`, and
  // `durationMs` are all in scope for both result construction
  // and audit emission.
  let exitCode: number;
  if (winner.kind === 'exited') {
    // Natural exit — cancel the pending timer. There IS a race
    // window where `proc.exited` and the timer callback both
    // fire in the same tick: the timer's callback runs
    // (calling SIGTERM on a now-dead pid + scheduling
    // `killHandle` for the +1s SIGKILL) BEFORE Promise.race
    // settles, then exitedPromise wins by microtask order.
    // The dead-pid SIGTERM is harmless (ESRCH) but `killHandle`
    // is now a 1s pending timer that holds the event loop
    // open. Clear BOTH handles defensively in this branch.
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (killHandle !== undefined) clearTimeout(killHandle);
    exitCode = winner.code;
  } else {
    // Timer fired — wait for the kill ladder to complete.
    // proc.exited resolves once SIGTERM (or SIGKILL at +1s)
    // takes effect. Per CONTRACTS.md §3 line 725, timeout's
    // canonical exit code is 124 (matches POSIX `timeout(1)`);
    // we surface the synthesized 124 via classifyExitCode-
    // bypass below regardless of what the killed process
    // actually returned (typically 143 for SIGTERM, 137 for
    // SIGKILL — neither is meaningful as a "decision").
    await proc.exited;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (killHandle !== undefined) clearTimeout(killHandle);
    exitCode = 124;
  }
  const stdout = truncate(await stdoutP);
  const stderr = truncate(await stderrP);
  const durationMs = now() - startedAt;

  const result: HookRunResult =
    winner.kind === 'timeout'
      ? { kind: 'timeout', timeoutMs: effectiveTimeoutMs, shouldBlock: spec.failClosed }
      : classifyExitCode(exitCode, stdout, durationMs, spec.failClosed);

  // CONTRACTS.md §3 line 725: timeouts record exit_code 124
  // (POSIX `timeout(1)` convention). exitCode is already 124
  // in the timeout branch above; pass through.
  emitAudit(
    exitCode,
    result.kind,
    durationMs,
    stdout.length > 0 ? stdout : null,
    stderr.length > 0 ? stderr : null,
  );

  return result;
};

// Dispatch the full chain for one event. Caller already has the
// resolved hook list and just filters per event + matcher.
//
// Blocking-event behavior (BLOCKING_EVENTS set): runs each
// matching hook sequentially; first hook that returns a
// blocking outcome (block_silent / block_message / error+
// failClosed / timeout+failClosed) interrupts the chain. Spec
// CONTRACTS.md §10 line 1046 mandates this.
//
// Non-blocking events: every matching hook still runs (so audit
// rows accumulate), but the dispatcher returns blockedBy=null
// regardless of outcomes.
export const dispatchChain = async (
  hooks: readonly HookSpec[],
  payload: HookEventPayload,
  cwd: string,
  deps: DispatcherDeps,
): Promise<HookChainResult> => {
  // Slice 181 — disableAllHooks short-circuit. When the operator
  // (or managed settings) flipped the kill switch, the chain
  // returns empty immediately. No audit rows, no spawns, no
  // matcher evaluation. Caller still receives a well-shaped
  // HookChainResult so downstream code paths don't need their
  // own opt-out logic.
  if (deps.disableAllHooks === true) {
    return { blockedBy: null, runs: [], additionalContext: '' };
  }

  const matching = hooks.filter((spec) => matchesPayload(spec, payload));
  const isBlocking = BLOCKING_EVENTS.has(payload.event);
  const now = deps.now ?? (() => Date.now());
  const chainStarted = now();
  const runs: { spec: HookSpec; result: HookRunResult }[] = [];
  let blockedBy: HookChainResult['blockedBy'] = null;
  // Slice 181 — aggregation of JSON-output fields across the chain.
  const contextParts: string[] = [];
  let updatedInput: Record<string, unknown> | undefined;

  // Short-circuit when no shell is available (Windows host
  // without sh/bash AND without cmd.exe — exotic, but possible
  // in container builds). Returning early with an empty chain
  // means failClosed hooks DO NOT wrongly deny normal
  // operations: the chain looks identical to "no hooks
  // configured". Boot-time warning lives in resolveHookShell's
  // caller (CLI driver).
  const shell = deps.shell ?? getCachedShell();
  if (matching.length > 0 && shell.kind === 'unavailable') {
    process.stderr.write(
      `hooks: ${matching.length} hook(s) for ${payload.event} skipped — ${shell.reason}\n`,
    );
    return { blockedBy: null, runs, additionalContext: '' };
  }

  for (let i = 0; i < matching.length; i++) {
    const spec = matching[i];
    if (spec === undefined) continue;
    const elapsed = now() - chainStarted;
    // Wall-clock cap applies to ALL events (blocking AND
    // non-blocking) per CONTRACTS.md §10 line 1040. Non-blocking
    // chains are still AWAITED by the harness in lifecycle paths
    // (SessionStart / Stop) and DRAINED at finish() before the
    // session row closes — gating the cap on `isBlocking` would
    // leave them uncapped. N hooks × MAX_HOOK_TIMEOUT_MS each
    // (up to 30s) could stall startup / shutdown by minutes,
    // defeating the runtime guard operators rely on. Non-blocking
    // just means "decisions don't gate", not "latency unbounded".
    //
    // `>=` not `>`: at exactly `elapsed === MAX`, remaining
    // budget is zero and the per-hook clamp downstream would
    // floor to 1ms (`Math.max(1, 0)`) — sneaking one extra
    // hook past the documented hard cap. The boundary belongs
    // to "expired", not "one more for free".
    if (elapsed >= MAX_HOOK_CHAIN_MS) {
      // Whole-chain timeout. Surface as a stderr warning + skip
      // remaining hooks. For audit clarity, we don't emit
      // `hook_runs` rows for skipped hooks — the absence is
      // itself the signal (compare against the resolved chain
      // to spot it).
      process.stderr.write(
        `hooks: chain for ${payload.event} exceeded ${MAX_HOOK_CHAIN_MS}ms; skipping ${matching.length - i} remaining hook(s)\n`,
      );
      break;
    }

    // Per-hook timeout clamped against the remaining chain
    // budget — applies to ALL events for the same reason as
    // the cap check above. Without this, a chain that reached
    // t=14.9s could still launch a hook with
    // spec.timeoutMs=30000 and run out to t=44.9s — violating
    // the 15s wall-clock cap that CONTRACTS.md §10 advertises.
    const remaining = MAX_HOOK_CHAIN_MS - elapsed;
    const effectiveTimeoutMs = Math.max(1, Math.min(spec.timeoutMs, remaining));

    // Pass the SPEC'S OWN entryIndex, not `i` (the index in the
    // filtered `matching` array). With matcher filtering, `i`
    // would mismatch the operator's source-file position
    // whenever a non-matching hook appeared earlier in the
    // file — the audit row's `sourcePath#hookIndex` reference
    // would point at the wrong rule.
    // Thread the already-resolved shell through to dispatchOne
    // so the chain doesn't re-resolve per hook. Passes the same
    // value already cached or test-injected at the chain layer.
    const result = await dispatchOne(spec, spec.entryIndex, payload, cwd, {
      ...deps,
      shell,
      effectiveTimeoutMs,
    });
    runs.push({ spec, result });

    // Slice 181 — aggregate JSON output fields from allow results.
    // additionalContext concatenates in execution order so the LLM
    // sees the chain's enrichment in the order operator declared.
    // updatedInput is last-wins (paralelo a "the last hook in the
    // chain that emits updatedInput defines the final input"); an
    // earlier hook's mutation is overridden by a later one. This
    // matches the operator-mental-model "later hooks have higher
    // precedence" because they declared their handler after.
    if (result.kind === 'allow') {
      if (result.additionalContext !== undefined && result.additionalContext.length > 0) {
        contextParts.push(result.additionalContext);
      }
      if (result.updatedInput !== undefined) {
        updatedInput = result.updatedInput;
      }
    }

    if (!isBlocking) continue;

    // Blockable event — first blocking decision wins.
    if (result.kind === 'block_silent') {
      blockedBy = { spec, reason: 'silent', message: null };
      break;
    }
    if (result.kind === 'block_message') {
      blockedBy = { spec, reason: 'message', message: result.message };
      break;
    }
    if ((result.kind === 'error' || result.kind === 'timeout') && result.shouldBlock) {
      // Fail-closed error / timeout → block as `silent`. Per
      // `HookRunResult.shouldBlock` contract in types.ts:198 +
      // 204: "caller treats this as block_silent for blockable
      // events". A misbehaving hook that crashed or hung is an
      // OPERATIONAL signal — leaking its internal exit-code or
      // crash reason into the model-facing message would (a)
      // break the silent-block contract documented for
      // failClosed and (b) hand the model arbitrary operator-
      // side text it has no business consuming. Audit row in
      // hook_runs still carries the full reason / exit code for
      // the operator's forensic queries; only the
      // `chain.blockedBy.message` (which propagates to the
      // model) is sanitized to null.
      blockedBy = { spec, reason: 'silent', message: null };
      break;
    }
    // allow / non-failClosed error — continue to next.
  }

  const finalContext = contextParts.join('\n\n');
  const result: HookChainResult = { blockedBy, runs, additionalContext: finalContext };
  if (updatedInput !== undefined) result.updatedInput = updatedInput;
  return result;
};
