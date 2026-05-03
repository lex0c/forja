import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  listBgProcessesBySession,
  markBgProcessAsKilled,
} from '../storage/index.ts';
import { type ToolRegistry, createToolRegistry, registerBuiltinTools } from '../tools/index.ts';
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
  // Recursion depth this child run is at (0 for a direct child
  // of the user's session, 1 for a grandchild, etc). Passed
  // across the subprocess boundary via `--subagent-depth`
  // so the child's harness keeps `subagentDepth` non-zero and
  // any nested task() invocation increments from the right
  // baseline. Without this propagation, a chain of subprocess
  // subagents would compute depth from 0 inside each child
  // and bypass MAX_SUBAGENT_DEPTH at the chain level —
  // runaway fan-out risk.
  depth: number;
  // Sampling temperature for the child. Carried across via
  // `--subagent-temperature`. Undefined means "let the child
  // use the provider default" (same semantics as omitting
  // temperature on a top-level harness). Eval / automation
  // pipelines pin this to 0 for determinism; without
  // propagation, the subprocess child would silently fall back
  // to the provider default (~1.0) and break reproducibility.
  temperature?: number;
  // Plan-mode propagation. Carried across via `--subagent-plan-mode`
  // (presence-only flag). The top-level task tool gate already
  // refuses spawning under plan mode (planSafe:false), so this
  // is defense in depth: programmatic callers that invoke
  // runSubagent directly with planMode:true, AND any future
  // regression that flips the task tool gate, must still see
  // the child's harness reject writing tools. Without this
  // forward, the child runs without planMode and a write tool
  // in its whitelist would execute. Boolean shape — undefined /
  // false omits the flag, true emits it.
  planMode?: boolean;
  // Per-subagent background-process log directory. Threaded
  // across via `--subagent-bg-log-dir`. Format:
  // `<parentCwd>/.agent/bg/<childSessionId>/`. Each subagent
  // gets its own directory so that:
  //   - parent's `bg list` doesn't see (and doesn't accidentally
  //     manage) the child's bg processes
  //   - two concurrent subagents don't collide on log file names
  //     (the bg manager generates unique IDs per-instance, but
  //     sub-namespacing by sessionId removes any cross-instance
  //     coupling)
  //   - cleanup at end-of-run is a single recursive rm of the
  //     dir, no need to enumerate by id
  // Undefined when the runtime decided not to wire bg (none in
  // the current design — every subagent gets one — but the
  // optional shape leaves room for tests that want to skip it).
  bgLogDir?: string;
  // Parent's cwd, threaded across so the child can build a
  // MemoryRegistry anchored at the parent's repo. Memory is
  // per-repo logically (project_local + project_shared), not
  // per-worktree — a worktree-isolated subagent that resolved
  // memory from its own cwd (a cache directory) would lose
  // access to project_local entirely (gitignored, never copied
  // to worktrees). Forwarding the parent's cwd via
  // `--subagent-memory-cwd` lets the child resolve roots from
  // the right anchor while still recording its own session.cwd
  // on every audit row. Undefined disables memory wiring (tests,
  // older callers); the child surfaces `memory.registry_unavailable`
  // on tool calls.
  memoryCwd?: string;
}

export type SpawnChildProcess = (opts: SpawnChildProcessOptions) => ChildProcessHandle;

// Resolve the launcher's argv into the cmd we should pass to
// `Bun.spawn` for the subagent-child process. Pure function so
// tests can cover every shape (compiled binary, bun-run dev
// script, edge case missing argv) without spawning anything.
//
// `process.execPath` is the source of truth for the binary —
// it always points at the actual running executable: the bun
// interpreter in dev (`bun src/cli/index.ts ...`), the compiled
// agent binary in production (`bun build --compile`).
//
// `Bun.argv[0]` is NOT a reliable interpreter source: in
// compiled mode it's the literal string 'bun' (Bun spoofs it
// for Node.js-compatibility) — using it as the cmd[0] would
// spawn the bun CLI instead of re-invoking the compiled agent
// binary, which is the original 4.2b.ii.a regression this
// resolver was written for. Always use execPath, never argv[0].
//
// In dev we additionally need to pass the entry script as
// argv[1] so the interpreter knows what to run. The detection
// heuristic: if the launcher's argv[1] ends in a script-shaped
// suffix (`.ts`/`.js`/`.mts`/`.cts`/`.mjs`), append it. In
// compiled mode argv[1] is the first user arg, which doesn't
// match these suffixes for any normal invocation (a user
// running `./agent foo.ts` would pass 'foo.ts' as a positional
// prompt; the child would still detect subagent mode via the
// flag we append, and the extra positional is harmless because
// child mode short-circuits before prompt processing).
//
// `appendArgs` is the suffix the subagent-child invocation
// needs (`--subagent-session-id <id>`); the resolver appends
// them so the final cmd is ready for spawn.
const DEV_SCRIPT_SUFFIXES = ['.ts', '.js', '.mts', '.cts', '.mjs'];

export interface ResolveChildBinaryArgs {
  argv: readonly string[];
  execPath: string;
  appendArgs: readonly string[];
}

export const resolveChildBinaryCmd = (input: ResolveChildBinaryArgs): string[] => {
  const script = input.argv[1];
  const isDevScript =
    script !== undefined && DEV_SCRIPT_SUFFIXES.some((suffix) => script.endsWith(suffix));
  const cmd = isDevScript ? [input.execPath, script] : [input.execPath];
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
  // Internal flags appended in fixed order. `--subagent-temperature`
  // is conditional: omitting it (instead of stamping a default)
  // preserves "let the provider decide" semantics and matches
  // what a top-level harness sees when the caller didn't pin a
  // value.
  const appendArgs: string[] = [
    '--subagent-session-id',
    opts.sessionId,
    '--subagent-depth',
    String(opts.depth),
  ];
  if (opts.temperature !== undefined) {
    appendArgs.push('--subagent-temperature', String(opts.temperature));
  }
  if (opts.planMode === true) {
    appendArgs.push('--subagent-plan-mode');
  }
  if (opts.bgLogDir !== undefined) {
    appendArgs.push('--subagent-bg-log-dir', opts.bgLogDir);
  }
  if (opts.memoryCwd !== undefined) {
    appendArgs.push('--subagent-memory-cwd', opts.memoryCwd);
  }
  const cmd = resolveChildBinaryCmd({
    argv: Bun.argv,
    execPath: process.execPath,
    appendArgs,
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
    | 'subprocess_spawn_failed'
    | 'heartbeat_stale';
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

// Grace window between SIGTERM and SIGKILL when reaping the
// child's leftover bg processes (the SIGKILL'd-child path; see
// `reapChildBgProcesses`). Shorter than the harness-level
// WALL_CLOCK_GRACE_MS because by the time we reap, the child is
// already dead — we just need the bg subprocesses to flush log
// buffers and exit. 500ms is generous for typical dev tools (npm
// scripts, watchers) and short enough that a stuck process
// doesn't dominate cleanup latency.
const BG_REAP_GRACE_MS = 500;

// Tri-state result for the PID identity check. The reaper needs
// to distinguish three outcomes that the previous boolean
// signature collapsed:
//
//   match     — PID still belongs to the recorded process; safe
//               to signal AND to mark the row as 'killed' once
//               the kill is sent.
//   gone      — /proc/<pid>/cmdline ENOENT (process exited) or
//               returned an empty cmdline (zombie / kernel
//               thread). The original process is demonstrably
//               no longer running. Don't signal (no-op anyway),
//               BUT mark the row 'killed' — audit reflects the
//               truth that the process is gone.
//   mismatch  — PID exists but the cmdline doesn't match the
//               recorded shape. Could be (a) PID recycled to an
//               unrelated workload, (b) `exec sleep 60` style
//               where the original bash-wrapped process replaced
//               itself and now argv[0]='sleep' instead of bash,
//               (c) read failure with EACCES (setuid drop).
//               In every case we DON'T know whether OUR process
//               is still alive somewhere; conservatively skip
//               the signal AND skip the marker so the row stays
//               'running' and the operator can investigate.
type IdentityResult = 'match' | 'gone' | 'mismatch';

// Linux-only: reads `/proc/<pid>/cmdline`. The reaper guards
// `process.platform === 'linux'` upstream, so this helper is
// only called on Linux. macOS doesn't expose /proc the same
// way; supporting it would need a platform branch (likely
// `ps -p <pid> -o command=`).
const checkPidIdentity = (pid: number, expectedCommand: string): IdentityResult => {
  let cmdlineRaw: string;
  try {
    cmdlineRaw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch (e) {
    // ENOENT on /proc/<pid>/cmdline means the process exited
    // and the kernel reaped its proc directory — the recorded
    // process IS gone, audit row should flip terminal.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    // EACCES (setuid'd) or any other I/O error: we can't
    // verify. Conservative: treat as mismatch so we DON'T
    // claim termination of a process whose state we don't
    // know.
    return 'mismatch';
  }
  if (cmdlineRaw.length === 0) {
    // Empty cmdline = kernel thread or zombie. Bg processes
    // we spawn always have argv; an empty result means the
    // process has exited (zombie awaiting reap) — same audit
    // semantics as ENOENT.
    return 'gone';
  }
  // /proc cmdline is NUL-separated. The terminating NUL after
  // the last argument produces a trailing empty element when we
  // split; drop only that trailing one (intermediate empty args
  // are rare but legal — preserving them keeps the index math
  // honest).
  const argv = cmdlineRaw.split('\0');
  if (argv.length > 0 && argv[argv.length - 1] === '') argv.pop();
  if (argv.length === 0) return 'gone';
  if (expectedCommand.length === 0) return 'mismatch';
  const argv0Basename = (argv[0] ?? '').split('/').pop() ?? '';

  // Bash-wrapper case (production): bg manager runs every
  // command as `bash -c <command>`. argv[2] holds the user
  // command BYTE-FOR-BYTE — same string the row's `command`
  // field stores, because the bg manager passes input.command
  // verbatim into both bash and the DB. Trim / whitespace
  // normalization here would falsely reject legitimate commands
  // that carry meaningful whitespace.
  //
  // NOTE on `exec` usage: a command like `exec sleep 60` causes
  // bash to replace itself with sleep, so argv[0] becomes
  // `sleep` and the bash-wrapper match here doesn't apply.
  // Falls through to direct-spawn path; if recorded tokens
  // don't match (`exec` token absent in live argv), returns
  // mismatch. The row stays 'running' and the operator
  // investigates. Conservative is correct here — we genuinely
  // don't know if the post-exec process is still running.
  if (
    (argv0Basename === 'bash' || argv0Basename === 'sh') &&
    argv[1] === '-c' &&
    argv.length >= 3
  ) {
    return argv[2] === expectedCommand ? 'match' : 'mismatch';
  }

  // Direct-spawn case: argv[0] is the executable. Used by
  // tests that bypass the bg manager and by future
  // programmatic callers that spawn without the shell
  // wrapper. Trim here is safe and necessary — we tokenize on
  // whitespace, and a leading space would otherwise produce
  // an empty first token.
  //
  // Compare ALL tokens: argv length, argv[0] basename, then
  // each subsequent token verbatim. Earlier basename-only
  // comparison was too weak — a recycled PID landing on
  // `sleep 30` would falsely match recorded `sleep 60`.
  //
  // Limitation: tokenization is naive whitespace split, so
  // quoted args don't round-trip (`cmd "with space"`). For
  // direct-spawn callers that need quoting fidelity, route
  // through bash-wrapper instead. Production uses bash-wrapper
  // exclusively; this path's primary user is the test suite,
  // where commands are whitespace-clean by construction.
  const expectedTrimmed = expectedCommand.trim();
  if (expectedTrimmed.length === 0) return 'mismatch';
  const recordedTokens = expectedTrimmed.split(/\s+/);
  if (recordedTokens.length === 0) return 'mismatch';
  const recordedFirstToken = recordedTokens[0] ?? '';
  if (argv0Basename.length === 0 || recordedFirstToken.length === 0) return 'mismatch';
  if (argv.length !== recordedTokens.length) return 'mismatch';
  const recordedBasename = recordedFirstToken.split('/').pop() ?? recordedFirstToken;
  if (argv0Basename !== recordedBasename) return 'mismatch';
  for (let i = 1; i < recordedTokens.length; i += 1) {
    if (argv[i] !== recordedTokens[i]) return 'mismatch';
  }
  return 'match';
};

// Reap any bg processes the child spawned but failed to clean
// up. Runs in `runSubagent` after the child has exited and
// before the bg log dir is removed. The child's harness owns
// happy-path cleanup (its bgManager.cleanup() hook in the outer
// finally), so this reaper is the safety net for the paths
// that bypass the child's finally — SIGKILL on heartbeat
// staleness, wall-clock kill, abort escalation. In those cases
// the bg subprocesses survive as orphans (reparented to PID 1)
// with `status='running'` rows still in the DB; without this
// reap, they'd consume CPU/RAM indefinitely AND the subsequent
// `rmSync` of bgLogDir would unlink the log files they're still
// writing to.
const reapChildBgProcesses = async (db: DB, sessionId: string): Promise<void> => {
  let running: ReturnType<typeof listBgProcessesBySession>;
  try {
    running = listBgProcessesBySession(db, sessionId, { status: 'running' });
  } catch {
    // Defensive — DB read shouldn't fail mid-cleanup, but if
    // it does the safest move is to skip the reap and let the
    // operator's worktree gc collect via OS-level inspection.
    return;
  }
  if (running.length === 0) return;

  // Platform gate: identity verification depends on
  // `/proc/<pid>/cmdline`, which only exists on Linux. On
  // macOS / Windows / BSDs the read fails for every PID, both
  // passes skip every signal, and the prior code path then
  // ran `markRunningAsKilled` anyway — leaving real orphan
  // processes alive on disk while audit state claimed they
  // were terminated. Worse than the leak alone, because the
  // operator looking at the audit row can't tell anything
  // is wrong.
  //
  // Honest path: emit a warning so the operator knows the
  // rows weren't reaped, and return WITHOUT marking anything
  // killed. The audit stays truthful (rows remain 'running');
  // operator can use OS-native tools (`ps`, `lsof`, Activity
  // Monitor, Task Manager) to find and kill the actual
  // processes. A future slice can add a ps-based fallback for
  // macOS/BSD, but that needs careful platform-specific
  // parsing of `ps` output and is out of scope here.
  if (process.platform !== 'linux') {
    process.stderr.write(
      `subagent ${sessionId}: bg process reaper requires Linux /proc; ${running.length} row(s) left as 'running' on platform '${process.platform}' — investigate via OS-native tools\n`,
    );
    return;
  }

  // Partition rows by identity outcome. Three buckets:
  //   - matched: PID is still the process we recorded; we'll
  //     signal it AND mark the row killed.
  //   - gone: process exited (ENOENT, or empty cmdline =
  //     zombie/kernel-thread); no signal needed but mark
  //     killed because the row's process IS no longer running.
  //   - mismatched: PID exists but identity doesn't match
  //     (recycled to unrelated workload, exec-replace
  //     scenario, EACCES on cmdline read, etc.). DON'T signal
  //     and DON'T mark — the row stays 'running' so the
  //     operator can investigate via OS tools.
  //
  // The previous bulk `markRunningAsKilled(db, sessionId)`
  // call mistakenly flipped mismatched rows too, leaving real
  // orphan processes alive while audit state claimed termination
  // (and downstream rmSync then unlinked their log files,
  // re-introducing the orphan-with-deleted-FDs leak the reaper
  // exists to prevent). Per-row marking via
  // `markBgProcessAsKilled` keeps audit honest.
  const matched: typeof running = [];
  const gone: typeof running = [];
  for (const proc of running) {
    if (proc.osPid === null) {
      // No PID means we have no signal target. Conservatively
      // treat as mismatch — operator audit decides.
      continue;
    }
    const identity = checkPidIdentity(proc.osPid, proc.command);
    if (identity === 'match') matched.push(proc);
    else if (identity === 'gone') gone.push(proc);
    // 'mismatch' rows: silently dropped from the working set;
    // they stay 'running' in DB.
  }

  // SIGTERM every matched PID. Best-effort (ESRCH from a
  // process that exited between identity check and signal is
  // expected and ignored).
  //
  // Residual race we accept here: between the partition loop's
  // `checkPidIdentity` call and this `process.kill`, the
  // process can in principle exit + the kernel can recycle the
  // PID, in which case our SIGTERM goes to a different
  // process. The window is microseconds (no awaits between
  // partition and signal); the friendly-fire blast radius is
  // a single SIGTERM (which most processes handle as a clean
  // exit rather than crash). The SIGKILL pass below
  // re-runs the identity check, so an unrelated process that
  // happens to ignore SIGTERM won't escalate to SIGKILL.
  // Re-checking here too would close the window further but
  // double the syscall cost on the typical happy path; we
  // chose latency.
  for (const proc of matched) {
    if (proc.osPid === null) continue;
    try {
      process.kill(proc.osPid, 'SIGTERM');
    } catch {
      // ESRCH (already gone) / EPERM (race): nothing to do.
    }
  }
  // Single grace window for all matched processes in parallel.
  // Per-process waits would extend cleanup latency
  // proportional to count.
  await new Promise<void>((r) => setTimeout(r, BG_REAP_GRACE_MS));
  // SIGKILL with re-verification. The PID may have been
  // recycled during the grace window; re-running
  // `checkPidIdentity` keeps the safety property even when the
  // SIGTERM target exited cleanly and the kernel handed the
  // PID to an unrelated workload.
  for (const proc of matched) {
    if (proc.osPid === null) continue;
    if (checkPidIdentity(proc.osPid, proc.command) !== 'match') continue;
    try {
      process.kill(proc.osPid, 'SIGKILL');
    } catch {
      // Best-effort.
    }
  }
  // Audit: flip ONLY matched and gone rows to 'killed'.
  // Mismatched rows stay 'running' — operator investigates.
  for (const proc of [...matched, ...gone]) {
    try {
      markBgProcessAsKilled(db, proc.id);
    } catch {
      // Defensive — DB write failure leaves the row 'running'.
      // Worst-case the runSubagent's running-row recheck sees
      // it and skips rmSync, which is the safe outcome.
    }
  }
};

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
  | { kind: 'aborted' }
  | { kind: 'wall_clock' }
  | { kind: 'heartbeat_stale' };

interface WaitForChildArgs {
  db: DB;
  sessionId: string;
  handle: ChildProcessHandle;
  signal: AbortSignal | undefined;
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
  const { db, sessionId, handle, signal, wallClockMs, graceMs, heartbeatStaleMs, startTs } = args;

  let pollDelay = POLL_INITIAL_MS;
  let killed: 'aborted' | 'wall_clock' | 'heartbeat_stale' | undefined;
  let killedAt = 0;
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
      scheduleKill();
    }

    // Wall-clock budget exceeded — same escalation shape.
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
    });
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
  const heartbeatStaleMs = input.heartbeatStaleMs ?? HEARTBEAT_STALE_THRESHOLD_MS;
  const outcome = await waitForChild({
    db: input.db,
    sessionId: childSession.id,
    handle,
    signal: input.signal,
    wallClockMs,
    graceMs,
    heartbeatStaleMs,
    startTs,
  });

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
    | 'subprocess_spawn_failed'
    | 'heartbeat_stale';
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
