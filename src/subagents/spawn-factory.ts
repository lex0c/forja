import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderEffort } from '../providers/index.ts';
import { PROVIDER_API_KEY_VARS, scrubEnv } from '../sanitize/env.ts';
import {
  IPC_PROTOCOL_VERSION,
  type IpcChannel,
  createChannel,
  subprocessTransport,
} from './ipc.ts';

// Subprocess handle abstracted so tests can inject a fake without
// spawning a real binary. Production wiring uses `Bun.spawn`; the
// fake in tests runs the child harness in-process and writes
// payload directly to `subagent_outputs`.
export interface ChildProcessHandle {
  // Resolves with the exit code AND optional signal when the
  // subprocess terminates. Implementations must NOT reject this
  // promise — even SIGKILL produces a numeric exit code (typically
  // 137). The optional `signal` field carries the POSIX signal
  // name (e.g. 'SIGKILL', 'SIGSEGV') when the OS killed the
  // process; absent on normal exit. The audit layer
  // (`subagent_processes`) records both fields verbatim so
  // post-mortem queries can distinguish "child returned 1" from
  // "OS killed child with SIGSEGV".
  // Tests that want to model "still running" return a
  // never-resolving promise and rely on the runtime's wall-clock
  // timeout to trigger a kill that finally settles it.
  exited: Promise<{ exitCode: number; signal?: string | undefined }>;
  // OS pid of the spawned process. Production wiring fills this
  // from `proc.pid`; tests that inject a fake child run in-process
  // and have no real pid set this to undefined (the audit row
  // skip is acceptable — those tests don't audit the subprocess
  // surface). When present, the value lands in
  // `subagent_processes.pid` for `ps`/`top`/profiler correlation.
  pid?: number;
  // The cmd argv that produced this process, for audit
  // fingerprinting. The runtime hashes this (SHA256 over the
  // strings joined with NUL) and stores the hash in
  // `subagent_processes.argv_hash`. Optional for the same reason
  // as `pid`: in-process fakes have no argv.
  cmd?: readonly string[];
  // Send a signal. The runtime sends SIGTERM first (graceful),
  // waits for `WALL_CLOCK_GRACE_MS`, then SIGKILL. Implementations
  // are responsible for translating these to whatever the platform
  // exposes; Bun.spawn accepts them as strings directly.
  kill: (signal: 'SIGTERM' | 'SIGKILL') => void;
  // Live IPC channel to the child (spec docs/spec/IPC.md). Set
  // when the parent enabled `ipc: true` AND the spawn factory
  // produced one. Tests that don't model IPC (existing fakes)
  // omit this field — the runtime treats absence the same as
  // ipc-disabled (no live wire, payload-only). When present,
  // the runtime subscribes to messages and forwards them to the
  // optional `onIpcMessage` observer; on subprocess exit the
  // channel is closed alongside the rest of the cleanup.
  ipc?: IpcChannel;
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
  // Provider reasoning-effort carried across via `--subagent-effort`.
  // Lets a subagent inherit the operator's `/effort` reasoning depth.
  // Undefined ⇒ omit the flag (child uses the provider default).
  providerEffort?: ProviderEffort;
  // Trust verdict carried across via `--subagent-cwd-trusted`.
  // Spec §9 trust is per-project; the child runs under the
  // parent's resolved verdict. Without forwarding, the child's
  // harness defaults `isCwdTrusted=false` and tools gating on
  // trust (memory_write inferred source) silently deny.
  cwdTrusted?: boolean;
  // Shared-corpus trust verdict forwarded via
  // `--subagent-shared-scope-offline` (S5 CRIT/H3). When the
  // parent's trust probe returned a non-confirmed outcome
  // (verify_failed / deferred / revoked), the parent's eager-load
  // and retrieval BOTH exclude project_shared; the child inherits
  // the same posture so a spawned subagent doesn't load bodies
  // the operator just refused. Without this, a child's separate
  // assembleMemorySection would re-read the disk and surface
  // unattested content the parent specifically gated.
  sharedScopeOffline?: boolean;
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
  // Open the live IPC channel between parent and child. When
  // true, the spawn factory MUST set `stdin: 'pipe'` and
  // `stdout: 'pipe'` (subprocess can't write the channel if
  // stdout is `'ignore'`) and append `--ipc=<n>` to argv so the
  // child opens its side. Returned `ChildProcessHandle.ipc`
  // carries the wire. Undefined / false ⇒ legacy mode: child
  // runs in SQLite-only mode (existing one-shot contract).
  ipc?: boolean;
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
// binary, which is the original regression this resolver was
// written for. Always use execPath, never argv[0].
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

// Drain a child's stderr stream to `<logDir>/stderr.log`. Lazy:
// the file is opened on the FIRST byte, so a child that never
// writes stderr produces no on-disk artifact (no empty-file
// noise across thousands of subagent invocations). Without
// this, the OS pipe fills at ~64 KiB and the child blocks on
// next stderr write — which the heartbeat staleness path
// would then mistake for a wedge. Discards silently when:
//   - `logDir` is undefined (test fixture without a log dir)
//   - mkdir/open fails (disk full, EACCES) — child still
//     runs, just without a post-mortem trail
//   - mid-run write fails (disk full mid-run) — sink dropped,
//     pipe keeps draining to prevent child blocking
//
// Exported for direct testing without a real subprocess: tests
// build a `ReadableStream<Uint8Array>` controller, push bytes,
// close, and assert the resulting `<logDir>/stderr.log`.
export const drainStderrToLogFile = (
  stderr: ReadableStream<Uint8Array>,
  logDir: string | undefined,
): Promise<void> => {
  return (async () => {
    const reader = stderr.getReader();
    // Duck-typed sink — Bun's FileSink generic shape varies
    // between releases; we only need write + end.
    let sink: { write: (chunk: Uint8Array) => void; end: () => void } | undefined;
    let opened = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined || value.length === 0) continue;
        if (!opened) {
          if (logDir === undefined) {
            // Drain-to-discard mode: no log dir configured.
            // The pipe still has to be read or the child
            // blocks; just throw the bytes away.
            opened = true;
            continue;
          }
          try {
            mkdirSync(logDir, { recursive: true });
            // Slice 172 (review — information-leak P1): subagent
            // stderr can carry the same secret-shaped payloads as
            // bg logs (panics with env dumps, stack traces from
            // tools that echoed Bearer tokens). Lock down dir +
            // file to operator-only. Best-effort across exotic FS.
            try {
              chmodSync(logDir, 0o700);
            } catch {
              // Best-effort.
            }
            const stderrPath = join(logDir, 'stderr.log');
            const writer = Bun.file(stderrPath).writer();
            try {
              chmodSync(stderrPath, 0o600);
            } catch {
              // Best-effort. Bun.file().writer() lazy-creates the
              // file on first write — chmod here may race the
              // create. The dir 0700 is the load-bearing barrier.
            }
            sink = {
              write: (chunk) => {
                writer.write(chunk);
              },
              end: () => {
                writer.end();
              },
            };
            opened = true;
          } catch {
            // mkdir/open failed. Child keeps running; the
            // post-mortem trail is the operator's filesystem
            // problem to investigate.
            opened = true;
            continue;
          }
        }
        if (sink !== undefined) {
          try {
            sink.write(value);
          } catch {
            // Disk full mid-run, etc. Drop the sink but keep
            // reading so the child's pipe doesn't block.
            sink = undefined;
          }
        }
      }
    } catch {
      // Pipe closed mid-read on kill — normal termination shape.
    } finally {
      if (sink !== undefined) {
        try {
          sink.end();
        } catch {
          // best-effort flush
        }
      }
    }
  })();
};

export const defaultSpawnChildProcess: SpawnChildProcess = (opts) => {
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
  if (opts.providerEffort !== undefined) {
    appendArgs.push('--subagent-effort', opts.providerEffort);
  }
  if (opts.cwdTrusted === true) {
    appendArgs.push('--subagent-cwd-trusted');
  }
  if (opts.sharedScopeOffline === true) {
    appendArgs.push('--subagent-shared-scope-offline');
  }
  if (opts.bgLogDir !== undefined) {
    appendArgs.push('--subagent-bg-log-dir', opts.bgLogDir);
  }
  if (opts.memoryCwd !== undefined) {
    appendArgs.push('--subagent-memory-cwd', opts.memoryCwd);
  }
  // IPC opt-in. The flag carries the protocol version so the
  // child can refuse a parent it doesn't speak (spec §4.2). A
  // child binary on an older release that doesn't recognize
  // `--ipc` would surface "unknown flag" — caller catches it as
  // `subprocess_spawn_failed` upstream, which is the correct
  // outcome (operator runs `agent --version` and learns the
  // mismatch).
  if (opts.ipc === true) {
    appendArgs.push(`--ipc=${IPC_PROTOCOL_VERSION}`);
  }
  const cmd = resolveChildBinaryCmd({
    argv: Bun.argv,
    execPath: process.execPath,
    appendArgs,
  });
  // Spawn shape depends on IPC opt-in:
  //   - ipc off (legacy): stdin/stdout left detached; child uses
  //     SQLite for the terminal payload.
  //   - ipc on: stdin/stdout piped so subprocessTransport can
  //     attach to the channel. Spec §2.3 requires the parent
  //     to drain stdout continuously — the channel's pump loop
  //     does this from the moment subprocessTransport binds.
  // Slice 128 (R4 P1): subagent spawn now applies scrubEnv (slice
  // 105 already wired this for the broker spawn). Pre-slice the
  // child inherited every operator secret (API keys, vault tokens,
  // ssh-agent socket — the new R4 P1 additions). A child whose
  // whitelist allowed bash could `env | grep -i token` and recover
  // credentials the parent meant to strip. Symmetric coverage at
  // the subagent boundary closes the gap.
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    // Preserve the provider API key: this CHILD process must talk to the
    // model it was assigned, else it dies "API key required" before running
    // a single step (the generic scrub strips ANTHROPIC_*/OPENAI_*/… as a
    // bash-exfiltration defense). Every other credential stays stripped. Safe
    // because the child never lets a subprocess inherit its raw env: each tool
    // spawn passes an explicitly-shaped env (broker/bg scrubEnv, git
    // safeGitEnv, hooks buildHookEnv, grep buildGrepSpawnEnv) and sandboxed
    // tools clear the env at the kernel boundary — so the key reaches only the
    // child's HTTP call to the provider. See PROVIDER_API_KEY_VARS for the
    // full invariant; a new spawn site that inherits process.env re-opens it.
    env: scrubEnv(process.env, { keep: PROVIDER_API_KEY_VARS }),
    ...(opts.ipc === true ? { stdin: 'pipe', stdout: 'pipe' } : { stdout: 'ignore' }),
    stderr: 'pipe',
  });
  // Route child stderr to a per-subagent log file under
  // bgLogDir. Extracted as a helper so tests can drive it with
  // synthetic streams without spawning a real subprocess.
  if (proc.stderr !== null && proc.stderr !== undefined) {
    drainStderrToLogFile(proc.stderr as ReadableStream<Uint8Array>, opts.bgLogDir);
  }
  // Build the IPC channel only when both opt-in is set AND the
  // OS streams resolved (defensive — `Bun.spawn` should always
  // honor `'pipe'` but a future Bun bug or platform quirk could
  // strand them as null/undefined). Without the channel we leave
  // `handle.ipc` undefined and the runtime falls back to the
  // legacy poller path — same behavior as the legacy mode.
  let ipc: IpcChannel | undefined;
  if (opts.ipc === true && proc.stdin !== undefined && proc.stdout !== undefined) {
    // Bun.spawn's `proc.stdin` is a FileSink (not a WHATWG
    // WritableStream — that was the early bug caught by the
    // real-subprocess smoke). subprocessTransport accepts either
    // shape and branches internally; cast through unknown
    // because the SubprocessStreams union covers both with
    // structural types Bun's typings don't quite line up with.
    const transport = subprocessTransport({
      stdin: proc.stdin as unknown as Parameters<typeof subprocessTransport>[0]['stdin'],
      stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
    });
    ipc = createChannel(transport);
  }
  return {
    exited: proc.exited.then(() => ({
      exitCode: proc.exitCode ?? 0,
      // Bun exposes the POSIX signal name on `proc.signalCode`
      // for processes killed by signal; null/undefined for normal
      // exit. We propagate `undefined` so the audit layer can
      // emit NULL columns rather than a string "null". The
      // explicit ?? null → undefined coercion is so a future Bun
      // release that returns null instead of undefined doesn't
      // leak the literal into our typed surface.
      ...(proc.signalCode !== null && proc.signalCode !== undefined
        ? { signal: proc.signalCode }
        : {}),
    })),
    pid: proc.pid,
    cmd,
    kill: (signal) => {
      try {
        proc.kill(signal);
      } catch {
        // proc may already be exited; kill() throws — ignore.
      }
    },
    ...(ipc !== undefined ? { ipc } : {}),
  };
};
