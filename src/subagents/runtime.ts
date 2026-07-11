import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { forjaCommand } from '../cli/forja-command.ts';
import { projectDirName } from '../config/app-namespace.ts';
import type { HarnessEvent } from '../harness/index.ts';
import type { HookSpec } from '../hooks/types.ts';
import type { PermissionEngine } from '../permissions/index.ts';
import type { Provider, ProviderEffort } from '../providers/index.ts';
import {
  type DB,
  type SubagentProcessExitReason,
  appendMessage,
  completeSession,
  createSession,
  getSession,
  insertSubagentRun,
  insertSubagentWorktree,
  listBgProcessesBySession,
  markIpcHandshakeOk,
  recordProcessExit,
  recordProcessSpawn,
} from '../storage/index.ts';
import { type ToolRegistry, createToolRegistry, registerBuiltinTools } from '../tools/index.ts';
import { reapChildBgProcesses } from './bg-reaper.ts';
import {
  IPC_PROTOCOL_VERSION,
  IPC_VERSION_MISMATCH_EXIT_CODE,
  type IpcMessage,
  type PermissionDecision,
  isExpectedIpcTeardown,
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
import { MAX_SUBAGENT_DEPTH, type SubagentDefinition } from './types.ts';
import {
  DEFAULT_WALL_CLOCK_MS,
  HEARTBEAT_STALE_THRESHOLD_MS,
  STARTUP_STALE_THRESHOLD_MS,
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

// Argv flags that vary per spawn but don't represent config (the
// child's session id is a fresh UUID; `--subagent-bg-log-dir`
// embeds that same UUID in its path). Hashing them in would make
// `argv_hash` unique per spawn — useless as a "did this playbook
// run with the same flags last time" fingerprint, which is the
// stated audit purpose (AUDIT.md §1.7.2). Drop both as (flag,
// value) pairs before hashing. Other forwarded flags
// (`--subagent-depth`, `--subagent-temperature`,
// `--subagent-cwd-trusted`, `--subagent-memory-cwd`, `--ipc=N`)
// ARE config and stay in.
const ARGV_HASH_DROP_PAIRS: readonly string[] = ['--subagent-session-id', '--subagent-bg-log-dir'];

// SHA256 over a stable subset of the spawn argv. The hash is a
// fingerprint of the playbook's effective config (binary +
// forwarded settings), NOT the unique invocation. Two runs of
// the same playbook in the same project against the same
// settings produce the same hash, so a regression hunt
// ("when did this start failing?") can compare hashes across
// rows without a JOIN against `sessions`.
//
// Algorithm: walk argv left-to-right; whenever we see one of
// the drop flags, skip it AND its next positional value;
// hash everything else. NUL-joined to avoid ambiguity between
// `["--foo", "bar"]` and `["--foobar"]`.
//
// Exported for direct test coverage — the regression risk is
// "future hand-edit drops a real-config flag by accident",
// which a unit test pinning the hash for a known argv
// surfaces immediately.
export const computeArgvHash = (cmd: readonly string[]): string => {
  const kept: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    const tok = cmd[i] ?? '';
    if (ARGV_HASH_DROP_PAIRS.includes(tok)) {
      // Skip the flag AND its value. Defensive bound check in
      // case a malformed cmd ends mid-pair.
      i += 1;
      continue;
    }
    kept.push(tok);
  }
  return createHash('sha256').update(kept.join('\0')).digest('hex');
};

export interface RunSubagentInput {
  definition: SubagentDefinition;
  prompt: string;
  parentSessionId: string;
  provider: Provider;
  parentToolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  // Whether this spawn inherits the parent's approval posture
  // (operation-mode). Default true — task subagents the operator
  // dispatched run under the operator's posture. The memory-governance
  // verify dispatchers pass `false`: they're automatic, security-
  // sensitive (they scan possibly-injected memory), and NOT the
  // operator's delegated work, so they always run Supervised regardless
  // of the parent's posture (fail-closed).
  inheritApprovalPosture?: boolean;
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
  // Provider reasoning-effort the parent forwards so the child
  // inherits the operator's `/effort` reasoning depth (carried to the
  // subprocess via `--subagent-effort`). Operational caps are NOT
  // forwarded — those stay per-playbook.
  providerEffort?: ProviderEffort;
  // Every catalog model's custom api_key_env var (from the parent's resolved
  // model registry). Forwarded so the child's env preserves them through
  // scrubEnv — needed when this child can spawn a grandchild whose playbook
  // declares a model override with a custom credential var (PLAYBOOKS.md §1.1).
  catalogApiKeyEnvVars?: string[];
  subagentRegistry?: SubagentSet;
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
  // S5 CRIT/H3: forwarded from the parent's bootstrap when the
  // shared-corpus trust probe returned a non-confirmed outcome
  // (verify_failed / deferred / revoked). The child's harness
  // mirrors the fail-closed posture on both `assembleMemorySection`
  // (eager-load) and `retrieve_context` (tool surface). Absence =
  // false (parent confirmed OR no probe ran).
  sharedScopeOffline?: boolean;
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
  // First-pulse startup deadline, in ms. Defaults to
  // `STARTUP_STALE_THRESHOLD_MS` (30_000). While the child has never
  // pulsed (no outputs row or a null `last_heartbeat`), exceeding
  // this since spawn means the child wedged during boot, before the
  // heartbeat writer started — the parent escalates SIGTERM → grace
  // → SIGKILL. Tests pass small values to exercise the path without
  // waiting 30s.
  startupStaleMs?: number;
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
  // PERMISSION_ENGINE.md §10.1 — effective capability envelope at
  // spawn time (slice 95). The harness loop's spawn factory
  // already computes the intersection `parent_caps ∩ declared_caps`
  // to refuse on excess; slice 95 also forwards the SURVIVING
  // `effective` set here so `runSubagent` can seal it into the
  // child's audit row. The child engine reads the row and
  // configures `EngineOptions.effectiveCapabilities`, gating
  // every resolved cap against the declared envelope at
  // evaluation time.
  //
  // Tri-state:
  //   - `undefined` — caller didn't pass declared (programmatic
  //     test fixture, or a legacy code path). Row's
  //     `effective_capabilities` column stays NULL; child engine
  //     runs WITHOUT a §10.1 bound. Same forensic story as
  //     `hooksSnapshot=undefined` — "no snapshot taken".
  //   - `[]` — pure-LLM child (declared = []). Sealed as `'[]'`
  //     into the column; child denies any non-empty resolved
  //     cap.
  //   - `['cap', ...]` — narrowed envelope. Sealed verbatim;
  //     child gates each resolved cap via cwd-aware coverage.
  effectiveCapabilities?: readonly string[];
  // Migration 058 — id of the `approvals` row that authorized this
  // spawn (PERMISSION_ENGINE.md §10.2). Sealed into
  // `subagent_runs.parent_approval_id` so the audit chain stays
  // one-hop. Optional because (a) test fixtures construct
  // RunSubagentInput without an approval, (b) the verify-semantic
  // scheduler bypasses the approval path entirely (forensics route
  // via memory_verify_attempts.subagent_run_session_id).
  parentApprovalId?: string;
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
  // Cap on concurrent permission asks per child session. When a
  // child has this many asks pending and emits one more, the
  // runtime auto-denies the new ask immediately (synthetic
  // `permission:answer { decision: 'deny' }`) without invoking
  // the hook. Defends the operator's modal queue against a
  // child stuck in a confirm-loop or a hostile agent definition
  // emitting hundreds of asks. Default `DEFAULT_MAX_PENDING_ASKS`
  // (5) — small enough that the operator never sees a runaway
  // queue, large enough that legitimate batch workflows (e.g.,
  // confirm 4 file edits as a unit) pass through. Set to 0 to
  // disable the cap entirely (eval / smoke harnesses that need
  // to stress-test the wire).
  maxPendingPermissionAsks?: number;
}

// MAX_SUBAGENT_DEPTH lives in `./types.ts` — see the comment
// there for why. Re-exported here so existing callers
// (`harness/loop.ts` and the e2e tests) keep working without
// import churn.
export { MAX_SUBAGENT_DEPTH };

// Default cap on concurrent permission asks per child session.
// Picked to keep the modal queue ergonomic — operator answering
// one at a time can drain N=5 in roughly the same time a child
// would take to issue a sixth, so legitimate batch workflows
// don't trigger the cap. Hostile / buggy children that emit
// 100s of asks hit the cap on the 6th one and every subsequent
// ask auto-denies, keeping the operator's queue bounded.
export const DEFAULT_MAX_PENDING_ASKS = 5;

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
      // R6 — pre-fix the catch swallowed both success and failure
      // outcomes silently. A cleanupWorktree that succeeded on dir
      // removal but failed on `git branch -D <agent>` left a stale
      // branch in git with no logged signal; operator perception
      // was "agent worked fine" while the branch list grew. Surface
      // failure paths on stderr (cleanup is best-effort; we still
      // swallow the throw, but the operator gets the breadcrumb).
      try {
        await cleanupWorktree({ handle: worktreeHandle, parentCwd: input.cwd });
      } catch (cleanupErr) {
        const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        process.stderr.write(
          `subagent ${childSession.id}: cleanupWorktree threw during failure cleanup: ${msg}\n`,
        );
      }
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
      // The storage schema (migration 012) constrains scope to
      // Migration 058 widened the CHECK to include 'builtin', so
      // the row now records the true provenance ('user'/'project'/
      // 'builtin') directly. Forensic queries can filter shipped
      // vs. operator-authored without cross-referencing the
      // in-process registry. Pre-058 sessions recorded 'user' for
      // builtin definitions; that drift is unrecoverable for old
      // rows but new dispatches are honest.
      scope: definition.scope,
      ...(input.parentApprovalId !== undefined ? { parentApprovalId: input.parentApprovalId } : {}),
      // Snapshot the catalog entry the parent's provider was built from
      // (migration 076) so the spawned child rebuilds the SAME provider
      // instead of re-reading a possibly-edited model_providers.json.
      // Absent on test mocks / providerOverride → child re-reads the file.
      ...(input.provider.catalogEntry !== undefined
        ? { modelEntrySnapshot: input.provider.catalogEntry }
        : {}),
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
      // `.forja/permissions.yaml` etc. on its own startup; an
      // edit between parent spawn and child read would diverge
      // the rules mid-run. The engine exposes its underlying
      // policy via `policy()`; that's the canonical source for
      // this snapshot.
      policySnapshot: input.permissionEngine.policy(),
      // Inherit the parent's live approval posture so an autonomous
      // parent's task subagents run autonomous too (operation-mode).
      // Captured at spawn alongside policySnapshot — the child reads it
      // from this row rather than re-deriving, so a mid-run parent
      // toggle doesn't retroactively change an already-spawned child.
      // `inheritApprovalPosture: false` (memory-governance verify
      // spawns) pins Supervised: that machinery is automatic and
      // security-sensitive, not the operator's delegated work.
      approvalPosture:
        input.inheritApprovalPosture === false
          ? 'supervised'
          : input.permissionEngine.approvalPosture(),
      // Mirror snapshot for the hook chain (migration 020). Same
      // drift defense: child reads from this on startup instead
      // of re-resolving hooks.toml from disk, so an edit between
      // parent spawn and child read can't diverge the chain
      // mid-run. Falls through to disk re-resolve when the
      // caller didn't supply a chain (older test fixtures,
      // programmatic callers without a hook context).
      ...(input.hooksSnapshot !== undefined ? { hooksSnapshot: input.hooksSnapshot } : {}),
      // Mirror snapshot for tool_restrictions (migration 024,
      // `PLAYBOOKS.md` §1.1). Same drift defense applied to the
      // playbook's per-tool allow/deny lists: child reads from
      // this row instead of re-parsing the .md, so an edit
      // between spawn and child read can't relax / tighten gates
      // mid-run. Absent (undefined) ⇒ column NULL ⇒ child runs
      // with no restriction gate (the `tools[]` whitelist is the
      // floor regardless).
      ...(definition.toolRestrictions !== undefined
        ? { toolRestrictions: definition.toolRestrictions }
        : {}),
      // Mirror snapshot for sampling overrides (migration 025,
      // `PLAYBOOKS.md` §1.1). Same drift defense applied to
      // generation parameters: the parent committed the values
      // from the .md, the child runs the harness with exactly
      // those overrides on every provider call.
      ...(definition.sampling !== undefined ? { sampling: definition.sampling } : {}),
      // Mirror snapshot for reference paths (migration 026,
      // `PLAYBOOKS.md` §1.1). The child renders these as a
      // trailing "References (read on demand)" block in its
      // system prompt — the model reads them lazily via the
      // `read_file` tool. Drift defense: a live edit to the
      // .md between spawn and child read can't change which
      // documents the child believes are "available for
      // consultation".
      ...(definition.references !== undefined ? { references: definition.references } : {}),
      // Mirror snapshot for output_schema (migration 027,
      // `PLAYBOOKS.md` §1.2). Child renders this into the
      // system prompt as a "## Output schema" block AND
      // validates the terminal text against it post-hoc.
      // Drift defense: an edit to the schema after spawn cannot
      // change what the child must produce.
      ...(definition.outputSchema !== undefined ? { outputSchema: definition.outputSchema } : {}),
      // Mirror snapshot for context_recipe (migration 028,
      // `PLAYBOOKS.md` §1.1, `CONTEXT_TUNING.md` §13). Slice 9
      // wires `memory_filter` and `step_reflection`; the other
      // fields persist for forward-compat consumer slices.
      ...(definition.contextRecipe !== undefined
        ? { contextRecipe: definition.contextRecipe }
        : {}),
      // PERMISSION_ENGINE.md §10.1 effective envelope (migration
      // 040, slice 95). Forwarded only when the caller explicitly
      // computed it — `undefined` keeps the column NULL (root /
      // legacy semantics). The harness's spawn factory passes
      // the `effective` array from `intersectCapabilities`; the
      // child engine reads the column at startup and gates
      // every resolved capability against this envelope.
      ...(input.effectiveCapabilities !== undefined
        ? { effectiveCapabilities: input.effectiveCapabilities }
        : {}),
    });
  } catch (e) {
    await cleanupOnFail();
    throw e;
  }

  // 4. Append the user prompt as the seed message on the child
  // session row. The child's harness loads this via the
  // preassignedSessionId path and uses it as the conversation
  // start — the parent's prompt never crosses the IPC boundary
  // as a CLI arg (avoids quoting / size limits). It carries the
  // provider `user` role but is harness-injected, never typed by
  // a human — so `source: 'system'` keeps the child's audit/resume
  // from attributing it to an operator (same rule as wake turns).
  try {
    appendMessage(input.db, {
      sessionId: childSession.id,
      role: 'user',
      content: input.prompt,
      source: 'system',
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
  // `.forja/bg/<bgId>.stdout.log` directly in the dir; subagent
  // bg files nest two more levels down at
  // `.forja/bg/subagents/<sessionId>/<bgId>.stdout.log`); per-
  // session subdirectory so concurrent subagents don't collide
  // and cleanup is a single recursive rm. The dir is created
  // lazily by the bg manager on first spawn — we only compute
  // the path here and forward it. For tests that inject a fake
  // spawn, the path is still computed (deterministic shape) but
  // unused by the fake.
  const bgLogDir = join(input.cwd, projectDirName(), 'bg', 'subagents', childSession.id);
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
      // Preserve the selected model's custom api_key_env through the
      // child's scrubEnv so a custom catalog model (non-built-in key var)
      // can authenticate after rebuilding from the snapshot; built-in
      // families already ride PROVIDER_API_KEY_VARS.
      ...(input.provider.catalogEntry?.api_key_env !== undefined
        ? { apiKeyEnv: input.provider.catalogEntry.api_key_env }
        : {}),
      ...(input.catalogApiKeyEnvVars !== undefined && input.catalogApiKeyEnvVars.length > 0
        ? { catalogApiKeyEnvVars: input.catalogApiKeyEnvVars }
        : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.providerEffort !== undefined ? { providerEffort: input.providerEffort } : {}),
      ...(input.cwdTrusted === true ? { cwdTrusted: true } : {}),
      ...(input.sharedScopeOffline === true ? { sharedScopeOffline: true } : {}),
      // Forward the IPC opt-in. The default spawn factory
      // converts this into pipe streams + the `--ipc=<n>` argv
      // flag; injected fakes can either build their own channel
      // (set handle.ipc) or ignore the flag (handle.ipc stays
      // undefined and the runtime degrades to payload-only).
      ...(effectiveIpc ? { ipc: true } : {}),
    });
  } catch (e) {
    // Subprocess never produced a pid; no `subagent_processes` row
    // is written here — the absence of a row is the audit signal
    // for "spawn failed". `subagent_outputs` (set below to a
    // spawn-failed result via the unified failure path) carries
    // the human-readable cause.
    await cleanupOnFail();
    // Bracket close on spawn failure too. The observer saw
    // `subagent_start` above; without a matching close the
    // parent's renderer would leak a live row indefinitely.
    fireChildEvent({
      type: 'subagent_finished',
      subagentId: childSession.id,
      status: 'error',
      reason: 'subprocess_spawn_failed',
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

  // 5a-bis. End-to-end subprocess audit (migration 029). The row
  // is born here — after Bun.spawn returned a pid, before the
  // wait loop. argv_hash is SHA256 over the cmd joined with NUL
  // (a fingerprint of "what flags this child got"); we store the
  // hash, not the cmd, so paths/tokens in argv stay out of audit.
  // Tests that inject a fake `spawnChildProcess` typically omit
  // pid/cmd — the row is skipped in that case (no audit, but the
  // fake's whole point is to bypass the subprocess surface).
  //
  // The audit write is best-effort: a SQLite lock contention or
  // schema-mismatch throw must NOT break the spawn flow. The
  // subagent run continues; the audit gap surfaces as an absent
  // row at query time. See AUDIT.md §1.
  const spawnedAt = Date.now();
  const stderrLogPath = join(bgLogDir, 'stderr.log');
  if (handle.pid !== undefined && handle.cmd !== undefined) {
    const argvHash = computeArgvHash(handle.cmd);
    try {
      recordProcessSpawn(input.db, {
        sessionId: childSession.id,
        parentSessionId: input.parentSessionId,
        pid: handle.pid,
        argvHash,
        spawnedAt,
        stderrLogPath,
      });
    } catch {
      // Audit gap; spawn continues.
    }
  }

  // Track parent-initiated kills for the exit_reason classifier
  // below. Wraps `handle.kill` so every kill site (this file's
  // protocol-mismatch path AND wait-loop's wall-clock path) flips
  // the flag through the shared handle reference. Without this,
  // we couldn't distinguish "we killed the child" (exit_reason =
  // 'killed') from "the OS killed the child" (exit_reason =
  // 'signal' — SIGSEGV, OOM, external SIGKILL).
  let parentInitiatedKill = false;
  const originalKill = handle.kill;
  handle.kill = (sig) => {
    parentInitiatedKill = true;
    originalKill(sig);
  };

  // Single-fire exit-record handler. Fires when the OS reaps the
  // child (proc.exited resolves). We classify the exit reason
  // from (input.signal.aborted, exit.signal, parentInitiatedKill,
  // exit.exitCode) — see SubagentProcessExitReason for the
  // category meanings. The classify-then-write pattern is local
  // to this file so a future audit consumer that wants the same
  // taxonomy doesn't have to re-derive it.
  handle.exited.then((exit) => {
    if (handle.pid === undefined) return;
    const exitedAt = Date.now();
    const reason: SubagentProcessExitReason =
      input.signal?.aborted === true
        ? 'parent_aborted'
        : exit.signal !== undefined && parentInitiatedKill
          ? 'killed'
          : exit.signal !== undefined
            ? 'signal'
            : exit.exitCode === 0
              ? 'normal'
              : 'crash';
    try {
      recordProcessExit(input.db, {
        sessionId: childSession.id,
        exitedAt,
        // POSIX semantics: a process killed by signal has no
        // meaningful exit code. We persist NULL so audit queries
        // can filter "signal exits" cleanly via WHERE exit_signal
        // IS NOT NULL rather than guessing 0/137/etc.
        exitCode: exit.signal !== undefined ? null : exit.exitCode,
        exitSignal: exit.signal ?? null,
        exitReason: reason,
      });
    } catch {
      // Audit gap; the row stays in the "still running" partial
      // index. `forja worktree gc` reaps it later as orphan.
    }
  });

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
      if (msg.protocolVersion === IPC_PROTOCOL_VERSION) {
        // Matching protocol version. The handshake is complete —
        // stamp `subagent_processes.ipc_handshake_ok = 1` so a
        // post-mortem can tell "child crashed before booting"
        // (handshake_ok=0) from "child booted, then misbehaved"
        // (handshake_ok=1, anything else). Idempotent: a future
        // duplicate session_start (regression-bug or buffered
        // replay) is a no-op via the WHERE clause in the repo.
        try {
          markIpcHandshakeOk(input.db, childSession.id);
        } catch {
          // Audit gap; handshake_ok stays 0 in the row.
        }
        return;
      }
      // Mismatch: child speaks a version we don't recognize.
      // Record for the result-building branch and tear the
      // child down. Send interrupt:hard so a child that DOES
      // honor the wire (just not the version) still drains
      // cleanly; SIGTERM is the fallback.
      ipcVersionMismatch = msg.protocolVersion;
      try {
        handle.ipc?.send(makeInterruptHard());
      } catch (e) {
        // SIGTERM below covers the channel-broken case; an
        // unexpected throw should not hide behind the OS-
        // fallback safety net.
        if (!isExpectedIpcTeardown(e)) {
          process.stderr.write(
            `subagent ${childSession.id}: ipc send (version-mismatch interrupt:hard) failed unexpectedly: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
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
      // Concurrent-ask cap (rate-limit per child). Tracks the
      // promptIds currently in flight; entries are added on
      // `permission:ask` arrival and removed when the hook
      // settles (resolve OR reject). When the set is at the
      // cap, additional asks short-circuit to deny — child's
      // bridge sees `permission:answer { 'deny' }` and treats
      // it like any other denial. The cap defaults to
      // DEFAULT_MAX_PENDING_ASKS (5); set 0 to disable
      // (stress-testing surface).
      const askCap = input.maxPendingPermissionAsks ?? DEFAULT_MAX_PENDING_ASKS;
      const inFlightAsks = new Set<string>();
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
          } catch (e) {
            // Channel may already be torn down (child died
            // mid-ask). The child's bridge drains pending as
            // denied on its onClose, so the verdict here is
            // moot in that case. Anything that isn't a known
            // teardown signature is surfaced — silently
            // swallowing a serialization or backpressure error
            // would manifest as the child hanging on a
            // permission answer that never arrived, with no
            // forensic trail to diagnose from.
            if (!isExpectedIpcTeardown(e)) {
              process.stderr.write(
                `subagent ${childSession.id}: ipc send (deny for unhooked ask) failed unexpectedly (promptId=${promptId}): ${e instanceof Error ? e.message : String(e)}\n`,
              );
            }
          }
          return;
        }
        // Rate-limit gate: deny without invoking the hook when
        // the child has hit the concurrent-ask cap. Operator's
        // modal queue stays bounded under a hostile / buggy
        // child that emits 100s of asks. Diagnostic to stderr
        // (not the bus — operator's TUI shouldn't see a
        // synthetic warn for every rate-limited ask; child's
        // own model sees the deny and is expected to back off).
        // `askCap === 0` opts out of the gate (stress-testing
        // surface); ordering puts the opt-out check first so a
        // legitimate uncapped run never even reads the set.
        if (askCap > 0 && inFlightAsks.size >= askCap) {
          process.stderr.write(
            `subagent ${childSession.id}: permission ask rate-limited (cap=${askCap}); promptId=${promptId} auto-denied\n`,
          );
          try {
            handle.ipc?.send(makePermissionAnswer({ promptId, decision: 'deny' }));
          } catch (e) {
            if (!isExpectedIpcTeardown(e)) {
              process.stderr.write(
                `subagent ${childSession.id}: ipc send (rate-limit deny) failed unexpectedly (promptId=${promptId}): ${e instanceof Error ? e.message : String(e)}\n`,
              );
            }
          }
          return;
        }
        // Track the in-flight ask so subsequent ones see the
        // count. The .then/.catch handlers below remove the
        // entry; ordering is naturally correct (Promise
        // continuations always schedule on a later microtask,
        // never synchronously) but doing the add before the
        // hook call also keeps the failure surface tight — a
        // hook that throws synchronously (turned into a rejected
        // promise) still has its .catch run async, by which time
        // the entry is in the set and the .catch's delete is the
        // matching cleanup.
        inFlightAsks.add(promptId);
        // Async hook. We don't await here (the IPC observer is
        // sync); fire-and-forward and let the .then send the
        // answer when the operator decides. Multiple parallel
        // asks from the same child interleave naturally because
        // each .then closure carries its own promptId. The
        // finally-style cleanup removes from the set whether
        // the hook resolved or threw — slot frees up either way.
        //
        // Wrap in `Promise.resolve().then(() => hook(...))` so a
        // hook that throws SYNCHRONOUSLY (non-async function
        // that validates input and throws before returning a
        // promise; or a JS caller violating the typed contract)
        // collapses into a rejected promise the .catch below
        // handles uniformly. Without this wrap, a sync throw
        // propagates up to onMessage where the channel emitter
        // swallows listener exceptions silently — no
        // permission:answer is sent, the child's bridge stays
        // pending, and the run blocks until channel
        // teardown / wall-clock. The wrap also keeps
        // `inFlightAsks` accounting honest: the .catch's delete
        // matches the .add above instead of leaking a slot
        // when the hook never completes.
        Promise.resolve()
          .then(() =>
            hook({
              toolName: msg.toolName,
              args,
              cwd: msg.cwd,
              prompt: msg.prompt,
              subagent: { sessionId: childSession.id, name: definition.name },
              signal: askAbort.signal,
            }),
          )
          .then((decision: PermissionDecision) => {
            inFlightAsks.delete(promptId);
            // Defensive coercion. The hook signature types
            // `decision` as PermissionDecision ('allow' | 'deny'),
            // but JS callers and TS callers reaching this path
            // through `any` can return arbitrary values. The
            // child's IPC parser refuses any decision outside
            // {'allow', 'deny'} as `permission_answer.unknown_decision:<v>`,
            // routing it to onError instead of onMessage — the
            // bridge's `pending` entry stays unresolved and the
            // child blocks on the prompt until channel close or
            // wall-clock. Coercing invalid values to 'deny'
            // here means the child always gets a usable answer
            // and the diagnostic surfaces on stderr so a buggy
            // hook is debuggable.
            const safeDecision: PermissionDecision =
              decision === 'allow' || decision === 'deny' ? decision : 'deny';
            if (safeDecision !== decision) {
              process.stderr.write(
                `subagent ${childSession.id}: onPermissionAsk returned invalid decision (${String(decision)}); coercing to 'deny'\n`,
              );
            }
            try {
              handle.ipc?.send(makePermissionAnswer({ promptId, decision: safeDecision }));
            } catch (e) {
              if (!isExpectedIpcTeardown(e)) {
                process.stderr.write(
                  `subagent ${childSession.id}: ipc send (permission answer) failed unexpectedly (promptId=${promptId}, decision=${safeDecision}): ${e instanceof Error ? e.message : String(e)}\n`,
                );
              }
            }
          })
          .catch(() => {
            inFlightAsks.delete(promptId);
            // Hook threw. Treat as deny so the child doesn't
            // hang waiting for an answer that will never come.
            try {
              handle.ipc?.send(makePermissionAnswer({ promptId, decision: 'deny' }));
            } catch (e) {
              if (!isExpectedIpcTeardown(e)) {
                process.stderr.write(
                  `subagent ${childSession.id}: ipc send (hook-threw deny) failed unexpectedly (promptId=${promptId}): ${e instanceof Error ? e.message : String(e)}\n`,
                );
              }
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
  const startupStaleMs = input.startupStaleMs ?? STARTUP_STALE_THRESHOLD_MS;
  const outcome = await waitForChild({
    db: input.db,
    sessionId: childSession.id,
    handle,
    signal: input.signal,
    softStopSignal: input.softStopSignal,
    wallClockMs,
    graceMs,
    heartbeatStaleMs,
    startupStaleMs,
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
  // dir is safe to remove. Otherwise we leave it; `forja worktree
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
    // never changes the run outcome — operator's `forja worktree
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
      `subagent ${childSession.id}: bg log dir '${bgLogDir}' preserved — ${stillRunningCount} bg row(s) still 'running' (reaper deferred or kill incomplete); inspect via OS tools or '${forjaCommand('worktree gc')}'\n`,
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
    case 'startup_stalled': {
      // Child wedged during boot — never published its first
      // heartbeat, so it never reached the harness loop. Same
      // 'interrupted' shape as heartbeat_stale / wall_clock; cost is
      // a hard 0 (no provider call could have billed before the
      // first pulse). Distinct reason so operators can tell "hung
      // before it even started" from "hung mid-run".
      result = {
        output: '',
        sessionId: childSession.id,
        status: 'interrupted',
        reason: 'startup_stalled',
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
  // but the row itself usually holds a BETTER floor: the child's
  // harness persists its running spend into `total_cost_usd`
  // per response (loop.ts emitCostUpdate rollup), so a child
  // killed mid-run leaves its last persisted figure behind.
  // Read it back and keep the larger value — writing the
  // synthesized zero over it would destroy real recorded spend
  // (footer totals visibly DROP, billing audits lose the run).
  // Marking the row `usage_complete = false` still tells
  // consumers "this total is a floor, not authoritative".
  //
  // Wrapped in try/catch because the function throws when the
  // row already finalized (concurrent purge, child raced to
  // it) — that's a non-event, not an error to surface. On
  // that no-op path the values we pass are irrelevant; the
  // child's own finalize already set the row.
  const usageComplete = outcome.kind === 'payload';
  // Reconcile the synthesized cost against any per-response spend the
  // child already persisted into its session row (loop.ts
  // emitCostUpdate rollup). A non-payload exit synthesizes
  // costUsd=0, but the row may hold a real floor from billed
  // responses before the kill. Recover it ONCE and carry the same
  // figure into the row, the returned result, AND the
  // subagent_finished event: the SYNC `task` path has no live handle
  // tracker (loop.ts ~1990 falls through to the terminal
  // result.costUsd), so a stale 0 here undercounts
  // cumulativeChildCostUsd, the task error detail, and every later
  // maxCostUsd spawn gate even though the DB row carries the floor.
  let reconciledCostUsd = result.costUsd;
  try {
    const persistedFloor = getSession(input.db, childSession.id)?.totalCostUsd ?? 0;
    reconciledCostUsd = Math.max(result.costUsd, persistedFloor);
    completeSession(input.db, childSession.id, result.status, reconciledCostUsd, usageComplete);
  } catch {
    // ignore — the row is already in a terminal state, or the DB
    // read/write failed; fall back to the synthesized result.costUsd.
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
    reason: result.reason,
    summary,
    durationMs: result.durationMs,
    costUsd: reconciledCostUsd,
  });

  // Attach worktree shape and any audit failure side-channel.
  // `costUsd` overrides the spread so the parent's sync reconciliation
  // (and any caller reading the result) sees the floor-preserved figure,
  // not the synthesized 0 — same value written to the row above.
  return {
    ...result,
    costUsd: reconciledCostUsd,
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
