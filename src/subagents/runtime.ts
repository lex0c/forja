import type { HarnessResult } from '../harness/index.ts';
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
} from '../storage/index.ts';
import type { ToolRegistry } from '../tools/index.ts';
import type { SubagentSet } from './load.ts';
import type { SubagentDefinition, WorktreeOutcome } from './types.ts';
import {
  type CleanupResult,
  type WorktreeHandle,
  cleanupWorktree,
  createWorktree,
} from './worktree.ts';

// Filter the parent's registry down to a child registry. The
// child runs in a SUBPROCESS (Step 4.2b.ii.a) and reads the
// definition from `subagent_runs` itself; the parent never
// passes the registry across the IPC boundary. This validation
// is defense in depth: bootstrap pre-validates via
// `validateSubagentSet`, but a programmatic caller building a
// `RunSubagentInput` without that step still gets refused on
// the same grounds. We throw on three conditions:
//   1. Tool name not registered with the parent's full toolset
//      (typo — model would never recover)
//   2. Tool declares writes:true but isolation is not worktree
//   3. Tool declares requiresBgManager:true (Step 4.2a runtime
//      doesn't wire bgManager into the child harness)
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
): void => {
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
    if (tool.metadata.requiresBgManager === true) {
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' declares metadata.requiresBgManager=true; the 4.2a subagent runtime does not wire ctx.bgManager (deferred to 4.2b). Bootstrap should have caught this via validateSubagentSet.`,
      );
    }
  }
};

// Subprocess handle abstracted so tests can inject a fake without
// spawning a real binary. Production wiring uses `Bun.spawn`; the
// fake in tests runs the child harness in-process and writes
// payload directly to `subagent_outputs`.
export interface ChildProcessHandle {
  // Resolves with the exit code when the subprocess terminates.
  // Implementations must NOT reject this promise — even SIGKILL
  // produces a numeric exit code (typically 137). Tests that want
  // to model "still running" return a never-resolving promise
  // and rely on the runtime's wall-clock timeout to trigger a
  // kill that finally settles it.
  exited: Promise<{ exitCode: number }>;
  // Send a signal. The runtime sends SIGTERM first (graceful),
  // waits for `WALL_CLOCK_GRACE_MS`, then SIGKILL. Implementations
  // are responsible for translating these to whatever the platform
  // exposes; Bun.spawn accepts them as strings directly.
  kill: (signal: 'SIGTERM' | 'SIGKILL') => void;
}

export interface SpawnChildProcessOptions {
  sessionId: string;
  // Working directory the subprocess starts in. For worktree-
  // isolated subagents this is the worktree root; otherwise the
  // parent's cwd. The child harness validates that the session
  // row's cwd matches, so a mismatch here surfaces as an init
  // failure (not silently runs in the wrong tree).
  cwd: string;
}

export type SpawnChildProcess = (opts: SpawnChildProcessOptions) => ChildProcessHandle;

// Resolve the launcher's argv into the cmd we should pass to
// `Bun.spawn` for the subagent-child process. Pure function so
// tests can cover every shape (compiled binary, bun-run dev
// script, edge case empty argv) without spawning anything.
//
// Heuristic: if argv[1] ends in `.ts`/`.js`/`.mts`/`.cts`/`.mjs`
// we're in interpreter mode and need [bun, script]; otherwise
// we're compiled and only argv[0] matters. We extend the suffix
// list beyond `.ts`/`.js` so a future rename of the entry to
// `.mts` (ESM-explicit) doesn't silently swap to compiled-mode
// resolution. argv[0] missing falls back to process.execPath.
//
// `appendArgs` is the suffix the subagent-child invocation needs
// (`--subagent-session-id <id>`); the resolver appends them so
// the final cmd is ready for spawn.
const DEV_SCRIPT_SUFFIXES = ['.ts', '.js', '.mts', '.cts', '.mjs'];

export interface ResolveChildBinaryArgs {
  argv: readonly string[];
  execPath: string;
  appendArgs: readonly string[];
}

export const resolveChildBinaryCmd = (input: ResolveChildBinaryArgs): string[] => {
  const interpreter = input.argv[0] ?? input.execPath;
  const script = input.argv[1];
  const isDevScript =
    script !== undefined && DEV_SCRIPT_SUFFIXES.some((suffix) => script.endsWith(suffix));
  const cmd = isDevScript ? [interpreter, script] : [interpreter];
  cmd.push(...input.appendArgs);
  return cmd;
};

// Default subprocess factory: spawn the same binary with the
// `--subagent-session-id` flag.
//
// stdout/stderr handling:
//   - stdout is piped to nowhere (`'ignore'`) — the child uses
//     SQLite for IPC; anything it writes to stdout is debug
//     noise we don't want mixed with the parent's `--json`
//     output stream. Production children should not write to
//     stdout under normal operation; if they do, we swallow.
//   - stderr is piped AND drained in the background. The child
//     uses stderr for diagnostic lines (errSink in
//     subagent-child.ts). Without draining, a child that writes
//     more than the OS pipe buffer (~64KB on Linux) blocks on
//     write — the parent's poller would then time out a child
//     that's actually trying to report a clear error. Background
//     drain prevents the block; the captured text is currently
//     dropped (a future slice can route it to a log file).
//
// Spawn failure: `Bun.spawn` throws synchronously on ENOENT /
// EACCES / out-of-fds. The runtime's try/catch in
// `runSubagent` converts that throw into a result with
// `reason: 'subprocess_spawn_failed'`. We let the exception
// propagate from here — the runtime is the only caller of the
// default factory.
const defaultSpawnChildProcess: SpawnChildProcess = (opts) => {
  const cmd = resolveChildBinaryCmd({
    argv: Bun.argv,
    execPath: process.execPath,
    appendArgs: ['--subagent-session-id', opts.sessionId],
  });
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: process.env,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  // Drain stderr in the background. We swallow read errors —
  // the stream may close mid-read on a kill, which is normal.
  // The drained content is dropped today; capturing it for
  // post-mortem diagnosis is a follow-up (likely under the
  // 4.2b.iv bgLogDir work, where child stderr would naturally
  // route to per-worktree log files).
  if (proc.stderr !== null && proc.stderr !== undefined) {
    new Response(proc.stderr).text().catch(() => undefined);
  }
  return {
    exited: proc.exited.then(() => ({ exitCode: proc.exitCode ?? 0 })),
    kill: (signal) => {
      try {
        proc.kill(signal);
      } catch {
        // proc may already be exited; kill() throws — ignore.
      }
    },
  };
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
  // Lifecycle observer. The subprocess child can't stream events
  // directly to the parent (no IPC channel for that); the parent
  // sees only the terminal payload. Reserved for parity with the
  // in-process API; today this hook is invoked only for spawn-
  // failure synthetic events.
  onEvent?: (event: unknown) => void;
  temperature?: number;
  subagentRegistry?: SubagentSet;
  planMode?: boolean;
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
}

export interface RunSubagentResult {
  output: string;
  sessionId: string;
  status: HarnessResult['status'];
  // The harness's ExitReason union plus subagent-runtime reasons
  // for pre-run / IPC-layer failures the harness never sees.
  // Consumers that branch on this string should match positively
  // on known values (`done`, `maxSteps`, etc.) and treat the
  // rest as opaque diagnostic text — the union grows as new
  // failure modes are added (heartbeat_timeout,
  // subprocess_crashed, etc.).
  reason:
    | HarnessResult['reason']
    | 'worktree_create_failed'
    | 'subprocess_crashed'
    | 'subprocess_spawn_failed';
  costUsd: number;
  steps: number;
  durationMs: number;
  auditFailure?: { code: string; message: string };
  worktree?: WorktreeOutcome;
  worktreeError?: { code: string; message: string };
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

// Wait for the subprocess to publish its terminal payload, OR
// exit without one (child crashed), OR be killed by signal /
// wall-clock. Returns the resolved state; the runtime's caller
// converts it into `RunSubagentResult`.
type WaitOutcome =
  | { kind: 'payload'; payload: Record<string, unknown> }
  | { kind: 'crashed'; exitCode: number }
  | { kind: 'aborted' }
  | { kind: 'wall_clock' };

interface WaitForChildArgs {
  db: DB;
  sessionId: string;
  handle: ChildProcessHandle;
  signal: AbortSignal | undefined;
  wallClockMs: number;
  graceMs: number;
  startTs: number;
}

const waitForChild = async (args: WaitForChildArgs): Promise<WaitOutcome> => {
  const { db, sessionId, handle, signal, wallClockMs, graceMs, startTs } = args;

  let pollDelay = POLL_INITIAL_MS;
  let killed: 'aborted' | 'wall_clock' | undefined;
  let killedAt = 0;
  let exitedResolved = false;
  // Track exit so we can short-circuit the polling loop.
  handle.exited.then(() => {
    exitedResolved = true;
  });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  while (true) {
    // Check payload first — a child that exited cleanly may have
    // raced ahead of our polling cadence and already published.
    const out = getSubagentOutput(db, sessionId);
    if (out !== null && out.payload !== null) {
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
      if (signal?.aborted === true) {
        return { kind: 'aborted' };
      }
      if (killed !== undefined) {
        return { kind: killed };
      }
      const { exitCode } = await handle.exited;
      return { kind: 'crashed', exitCode };
    }

    // Caller aborted — escalate via SIGTERM, wait grace, then
    // SIGKILL if still alive. The first iteration sets
    // `killed='aborted'`; subsequent iterations skip the kill
    // calls but keep polling for the payload (the child's
    // graceful-shutdown writes still count) until the grace
    // window expires or the child exits.
    if (signal?.aborted === true && killed === undefined) {
      killed = 'aborted';
      killedAt = Date.now();
      handle.kill('SIGTERM');
      // Schedule SIGKILL after grace, ignore-on-already-exited.
      setTimeout(() => {
        if (!exitedResolved) handle.kill('SIGKILL');
      }, graceMs);
    }

    // Wall-clock budget exceeded — same escalation shape.
    const elapsed = Date.now() - startTs;
    if (elapsed >= wallClockMs && killed === undefined) {
      killed = 'wall_clock';
      killedAt = Date.now();
      handle.kill('SIGTERM');
      setTimeout(() => {
        if (!exitedResolved) handle.kill('SIGKILL');
      }, graceMs);
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

    await sleep(pollDelay);
    pollDelay = Math.min(pollDelay * POLL_GROWTH, POLL_MAX_MS);
  }
};

// Convert the child's payload envelope into a strongly-typed
// `RunSubagentResult`. Defensive on every field: a payload from
// a misconfigured / corrupted child must not crash the parent's
// poller. Each missing or wrong-typed field falls back to a
// safe default that surfaces as 'error' / reason='internalError'
// downstream when it matters.
const buildResultFromPayload = (
  payload: Record<string, unknown>,
  sessionId: string,
): RunSubagentResult => {
  const status = (payload.status as RunSubagentResult['status']) ?? 'error';
  const reason = (payload.reason as RunSubagentResult['reason']) ?? 'internalError';
  return {
    output: typeof payload.output === 'string' ? payload.output : '',
    sessionId,
    status,
    reason,
    costUsd: typeof payload.cost_usd === 'number' ? payload.cost_usd : 0,
    steps: typeof payload.steps === 'number' ? payload.steps : 0,
    durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : 0,
  };
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
  // programmatic callers.
  assertWhitelistValidForSubagent(
    input.parentToolRegistry,
    definition.tools,
    definition.name,
    isolation === 'worktree',
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
  const childSession = createSession(input.db, {
    model: input.provider.id,
    cwd: childCwd,
    parentSessionId: input.parentSessionId,
  });

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

  // 5. Spawn the subprocess. Production uses `Bun.spawn` of the
  // same binary; tests inject a fake that runs the harness
  // in-process and writes the payload synchronously. Spawn
  // throws synchronously on ENOENT / EACCES / out-of-fds — we
  // surface those as a clean run-failed result rather than
  // letting the exception escape, because the parent/model
  // should be able to recover (retry without the subagent, or
  // diagnose a deployment misconfiguration).
  const spawn = input.spawnChildProcess ?? defaultSpawnChildProcess;
  let handle: ChildProcessHandle;
  try {
    handle = spawn({ sessionId: childSession.id, cwd: childCwd });
  } catch (e) {
    await cleanupOnFail();
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
  const outcome = await waitForChild({
    db: input.db,
    sessionId: childSession.id,
    handle,
    signal: input.signal,
    wallClockMs,
    graceMs,
    startTs,
  });

  // 7. Cleanup worktree if isolated. Same contract as 4.2a:
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

  // 8. Build the result envelope from the wait outcome.
  let result: RunSubagentResult;
  switch (outcome.kind) {
    case 'payload': {
      result = buildResultFromPayload(outcome.payload, childSession.id);
      break;
    }
    case 'crashed': {
      result = {
        output: '',
        sessionId: childSession.id,
        status: 'error',
        reason: 'subprocess_crashed',
        costUsd: 0,
        steps: 0,
        durationMs: Date.now() - startTs,
      };
      break;
    }
    case 'aborted': {
      result = {
        output: '',
        sessionId: childSession.id,
        status: 'interrupted',
        reason: 'aborted',
        costUsd: 0,
        steps: 0,
        durationMs: Date.now() - startTs,
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
  // `completeSession` accepts. Wrapped in try/catch because
  // the function throws when the row already finalized
  // (concurrent purge, child raced to it) — that's a non-event,
  // not an error to surface.
  try {
    completeSession(input.db, childSession.id, result.status, result.costUsd, true);
  } catch {
    // ignore — the row is already in a terminal state
  }

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

// Surface the spec'd "structured" envelope for the calling tool.
// Same shape the in-process path used in 4.2a; kept stable across
// the subprocess refactor so consumers don't break.
export interface SubagentEnvelope {
  output: string;
  session_id: string;
  status: HarnessResult['status'];
  reason:
    | HarnessResult['reason']
    | 'worktree_create_failed'
    | 'subprocess_crashed'
    | 'subprocess_spawn_failed';
  cost_usd: number;
  steps: number;
  duration_ms: number;
}

export const toEnvelope = (result: RunSubagentResult): SubagentEnvelope => ({
  output: result.output,
  session_id: result.sessionId,
  status: result.status,
  reason: result.reason,
  cost_usd: result.costUsd,
  steps: result.steps,
  duration_ms: result.durationMs,
});
