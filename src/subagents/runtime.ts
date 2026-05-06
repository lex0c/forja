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
  type PermissionDecision,
  makeInterruptHard,
  makePermissionAnswer,
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
  DEFAULT_WALL_CLOCK_MS,
  HEARTBEAT_STALE_THRESHOLD_MS,
  WALL_CLOCK_GRACE_MS,
  waitForChild,
} from './wait-loop.ts';
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
// child runs in a SUBPROCESS and reads the
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
// `requiresBgManager` is not a check — every subagent gets
// its own bg log dir threaded across via `--subagent-bg-log-dir`,
// so background-process tools are safe to expose.
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
      // set doesn't. Subagent subprocesses require builtin
      // tools because the subprocess child rebuilds its
      // registry from `registerBuiltinTools()` — the only
      // tool source visible across the IPC boundary today.
      // Custom tools (programmatic callers, evals, future
      // MCP clients) need a transmission mechanism that
      // doesn't exist yet; refusing here surfaces the issue
      // at the parent's spawn time instead of letting the
      // child fail at startup with `unknown_tool`.
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' is registered with the parent but NOT in the builtin set — subagent subprocesses can only run with builtin tools because the child rebuilds its registry from registerBuiltinTools(). Custom tools require a transmission mechanism that lands with MCP / plugin support in a later slice.`,
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
  // Cooperative-stop signal. Parent forwards its own
  // softStopSignal here; runSubagent threads it across to the
  // child via IPC, which sends `interrupt:soft` so the child
  // exits at its next step boundary.
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
  // Typed child-event observer.
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
  // Permission proxy callback (spec docs/spec/IPC.md §7,
  // permission:ask / permission:answer slice). When the child's
  // engine returns a `confirm` verdict, the child bridge
  // forwards a `permission:ask` over IPC; the runtime calls
  // this hook with the child's request plus baked-in subagent
  // attribution (sessionId + agent name). Callback resolves
  // with the operator's verdict; runtime sends the matching
  // `permission:answer` back over the channel. When omitted,
  // every `permission:ask` from the child auto-denies (the
  // safe fallback when no operator is wired — keeps the child
  // from hanging on a missing answer).
  onPermissionAsk?: (req: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
    prompt: string;
    subagent: { sessionId: string; name: string };
    // Per-session abort signal. Fires when the child's IPC
    // channel closes (peer death, normal exit, hard abort) so
    // the parent's modal layer can close any open prompt
    // instead of stranding the operator on a stale request
    // whose answer would go into a closed pipe. Hook
    // implementations forward it to ModalManager via
    // `confirmPermission`'s own `signal` field.
    signal: AbortSignal;
  }) => Promise<PermissionDecision>;
}

// Hard cap on how deep a chain of `task → task → task` can nest.
// 4 levels covers every plausible playbook composition; surfaces
// a clear error well before the budget caps would.
export const MAX_SUBAGENT_DEPTH = 4;

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
    // Typed child-event forwarding. For each `event` IPC
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
    // Permission proxy (spec docs/spec/IPC.md §7,
    // permission:ask / permission:answer slice). The child's
    // bridge emits `permission:ask` when its engine returns a
    // `confirm` verdict; the runtime forwards to the caller's
    // hook with subagent attribution baked in, then ships the
    // operator's verdict back as `permission:answer`. When
    // `onPermissionAsk` is unset the runtime auto-denies so
    // the child unblocks promptly — a child waiting on an
    // answer that never arrives would hang past wall-clock.
    {
      const hook = input.onPermissionAsk;
      // Per-session abort signal threaded into every hook call.
      // Fires when the IPC channel closes (child died / EOF /
      // post-wait teardown) — that's the moment the operator's
      // modal must close, because any answer the operator
      // produces afterward would land on a dead pipe and the
      // child can't act on it. Without this, a child crash with
      // the modal open would strand the operator on a stale
      // prompt that blocks the rest of the modal queue. The
      // abort fires AT MOST ONCE per session; AbortController
      // is idempotent. Subscribe BEFORE wiring the ask handler
      // so a `permission:ask` arriving simultaneously with a
      // close (race) sees the signal already set.
      const askAbort = new AbortController();
      handle.ipc.onClose(() => askAbort.abort());
      // Belt-and-suspenders: parent's hard-abort signal also
      // fires the per-session abort. The channel.onClose path
      // covers the typical case (waitForChild → handle.ipc.close
      // → onClose listeners), but a pathological teardown that
      // closes the underlying transport without firing onClose
      // (or a future code change that reorders the cleanup)
      // would leave the modal open. The parent's hard-signal is
      // a redundant trigger — if it fired, the operator already
      // gave up on the run.
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          askAbort.abort();
        } else {
          // Pair add/remove so the listener doesn't accumulate on
          // the parent's signal across N subagent runs in a long
          // REPL session. Without this cleanup, every runSubagent
          // call leaves a closure attached to input.signal that
          // only auto-removes when the parent itself aborts (Ctrl+C
          // / REPL exit) — a handful per session is fine, but a
          // session running 1000s of subagents would accumulate
          // 1000s of closures. `askAbort` always fires by end of
          // session (channel.onClose is the typical path; the
          // input.signal forward is the belt-and-suspenders), so
          // wiring removal off askAbort guarantees cleanup runs
          // exactly once at the right moment.
          const parentSignal = input.signal;
          const onParentAbort = (): void => askAbort.abort();
          parentSignal.addEventListener('abort', onParentAbort);
          askAbort.signal.addEventListener(
            'abort',
            () => parentSignal.removeEventListener('abort', onParentAbort),
            { once: true },
          );
        }
      }
      handle.ipc.onMessage((msg) => {
        if (msg.type !== 'permission:ask') return;
        const promptId = msg.promptId;
        // Args sanitization: the wire field is `unknown`. The
        // hook contract requires Record<string, unknown>; if
        // the child sent something else (model bug, malformed
        // bridge) we deny rather than pass garbage to the
        // modal renderer.
        const args =
          typeof msg.args === 'object' && msg.args !== null && !Array.isArray(msg.args)
            ? (msg.args as Record<string, unknown>)
            : null;
        if (hook === undefined || args === null) {
          try {
            handle.ipc?.send(makePermissionAnswer({ promptId, decision: 'deny' }));
          } catch {
            // Channel may already be torn down (child died
            // mid-ask). The child's bridge drains pending as
            // denied on its onClose, so the verdict here is
            // moot in that case.
          }
          return;
        }
        // Async hook. We don't await here (the IPC observer is
        // sync); fire-and-forward and let the .then send the
        // answer when the operator decides. Multiple parallel
        // asks from the same child interleave naturally because
        // each .then closure carries its own promptId.
        hook({
          toolName: msg.toolName,
          args,
          cwd: msg.cwd,
          prompt: msg.prompt,
          subagent: { sessionId: childSession.id, name: definition.name },
          signal: askAbort.signal,
        })
          .then((decision: PermissionDecision) => {
            try {
              handle.ipc?.send(makePermissionAnswer({ promptId, decision }));
            } catch {
              // Channel teardown race — same as above.
            }
          })
          .catch(() => {
            // Hook threw. Treat as deny so the child doesn't
            // hang waiting for an answer that will never come.
            try {
              handle.ipc?.send(makePermissionAnswer({ promptId, decision: 'deny' }));
            } catch {
              // ignored
            }
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
  //   - SIGKILL on heartbeat staleness: the harness's
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

  // 7b. Cleanup worktree if isolated. Contract:
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
  // gc` will reconcile alongside the audit table.
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
    // gc` sweeps stragglers.
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
      // Surface the soft/hard discriminator from the wait
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

  // Bracket close: fire `subagent_finished` for the typed
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
