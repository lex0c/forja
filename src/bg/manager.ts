import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { FailureEventSink } from '../failures/index.ts';
import type { SandboxProfile } from '../permissions/index.ts';
import { maybeWrapSandboxArgv } from '../permissions/index.ts';
import { redactSecrets, scrubEnv } from '../sanitize/index.ts';
import type { DB } from '../storage/db.ts';
import {
  type BgProcess,
  advanceBgProcessStderrCursor,
  advanceBgProcessStdoutCursor,
  finalizeBgProcess,
  getBgProcess,
  incrementBgProcessStderrBytesDropped,
  incrementBgProcessStdoutBytesDropped,
  insertBgProcess,
  listBgProcessesBySession,
  markRunningAsKilled,
} from '../storage/repos/bg-processes.ts';

// Per-call ceiling on bash_output reads. Without a cap, a chatty
// background process (npm run watch with a flood of warnings) could
// dump megabytes of stdout into the model's context in one tool call,
// exhausting the budget. 64 KB is roughly 16k tokens — generous for
// a single read but bounded.
const DEFAULT_OUTPUT_READ_LIMIT_BYTES = 64 * 1024;

// Bootstrap that delivers the bg script without putting its body in
// argv AND without letting a stdin-reading command inside the script
// cannibalize the rest of the script.
//
// Background: keeping the body out of `/proc/<pid>/cmdline` (a local
// info-leak: `ps aux` would expose interpolated secrets) means it
// can't ride on argv. The previous fix piped the script to `bash -s`,
// which reads the program from fd 0 — but `-s` makes fd 0 do double
// duty: it's both the program source AND the inherited stdin of every
// command the script runs. A script like `cat; echo done` or
// `read x; ...` then has its `cat`/`read` swallow the remaining
// script lines (or EOF), so later commands silently vanish.
//
// This wrapper severs the two roles. `cat` drains the ENTIRE script
// off fd 0 into a variable in one shot (before any of it executes),
// then `eval … </dev/null` runs it with a clean, empty stdin — so a
// `read`/`cat` in the body sees EOF immediately instead of eating the
// program. The argv is this constant string; the body lives only in
// the shell's memory (the variable), never in cmdline. bwrap/
// sandbox-exec forward fd 0 already, so this needs no temp file (which
// `--tmpfs /tmp` would mask) and no extra fd (which bwrap would close).
const BG_SCRIPT_BOOTSTRAP = '__forja_script="$(cat)"; eval "$__forja_script" </dev/null';

// Default grace period for SIGTERM → SIGKILL escalation on per-call
// kill. Long enough for a well-behaved process to flush state and
// exit cleanly; short enough that an operator killing a hung server
// doesn't wait forever. Spec §7.3 doesn't pin a number; this matches
// the common shell `kill ... && sleep 5 && kill -9` convention.
const DEFAULT_KILL_GRACE_MS = 5000;

// Tighter grace for session-end cleanup. Multiplied by N when N
// processes ignore SIGTERM, so the per-call default (5s) would add
// 5×N seconds to session-end latency in the worst case. Two seconds
// is enough for most processes to flush and exit; well-behaved ones
// finish on the first SIGTERM and pay zero.
const CLEANUP_KILL_GRACE_MS = 2000;

// Slice 148 (BG1 — process-group isolation): kill the entire
// process group rooted at the spawned bash, so grandchildren
// (npm run dev → node → webpack, pytest --watch → many subprocs)
// receive the signal too. `process.kill(-pid, signal)` is the POSIX
// convention: a negative PID targets the process group whose leader
// has that PID. Pairs with `detached: true` on Bun.spawn — without
// the spawn-side setsid, `-pid` would either fail (no PG) or signal
// the wrong group.
//
// Fallback to direct `proc.kill(signal)` on ANY PG signal failure:
//   - ESRCH (no such process / group) is benign — the natural-exit
//     path already reaped the child. Returning quietly avoids
//     "kill failed" spam in logs.
//   - EPERM is unusual but possible under restricted execution
//     contexts; direct kill on the leader is the same blast radius
//     as the pre-slice behavior, so falling back loses nothing.
//   - Any other error: log a warning to stderr and fall back so the
//     visible behavior matches pre-slice (kill the leader, accept
//     orphan risk on this one process). Best-effort posture matches
//     the rest of the bg manager.
const killProcessGroup = (proc: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void => {
  const pid = proc.pid;
  if (pid === undefined || pid <= 0) {
    // No usable PID — fall back to the proc handle's own kill.
    proc.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // group already gone — benign
    // Last-ditch: signal the leader directly. Worst case the
    // grandchildren stay alive (pre-slice behavior).
    try {
      proc.kill(signal);
    } catch {
      // also gone — give up silently. The DB-side finalize path
      // marks status='killed' regardless of OS-level race.
    }
  }
};

// Slice 153 (review): drain a Bun.spawn pipe into a file with a
// truncate-head cap. Owns the file descriptor for its whole
// lifetime so a truncate from inside doesn't race with the
// kernel writer (which is exactly the race that made
// `Bun.file(path)` redirection unsafe to truncate — the spawn's
// fd would keep writing at a stale position and the kernel would
// sparse-pad the resulting hole with zeros). Drainer fully owns
// the fd: the spawn writes into a pipe, this loop reads from the
// pipe and writes to the file at offsets we control.
//
// On each chunk:
//   - If currentSize + chunk.length <= cap: append chunk, advance.
//   - Else: compute how much tail (existing bytes) we can keep,
//     read that tail in memory, truncate the file to 0, rewrite
//     the tail + new chunk. Call `onDropped(droppedBytes)` so the
//     LiveHandle's bookkeeping advances and `readOutput` knows
//     to skip dropped offsets when computing the file position
//     for a given persisted cursor.
//
// One pathological case: a single chunk >= cap. We can't keep
// any of the prior file content; we keep only the LAST `cap`
// bytes of the chunk itself. The whole prior file + the chunk
// prefix are dropped. Rare in practice (Bun.spawn returns
// chunks of at most ~64 KB, and the default cap is 50 MB).
const drainStream = async (
  source: ReadableStream<Uint8Array>,
  filePath: string,
  cap: number,
  onDropped: (bytes: number) => void,
): Promise<void> => {
  const { open } = await import('node:fs/promises');
  const fd = await open(filePath, 'r+');
  let currentSize = 0;
  const reader = source.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (chunk === undefined || chunk.length === 0) continue;

      // Special-case: cap disabled (Number.POSITIVE_INFINITY) or
      // chunk fits comfortably under the budget. Append at end.
      if (cap === Number.POSITIVE_INFINITY || currentSize + chunk.length <= cap) {
        await fd.write(chunk, 0, chunk.length, currentSize);
        currentSize += chunk.length;
        continue;
      }

      // Over-cap path: truncate-head. Decide how much existing
      // tail we keep (could be 0 if the new chunk alone is >=
      // cap), read it into memory, truncate, rewrite.
      const headroomForOld = Math.max(0, cap - chunk.length);
      let droppedFromOld = 0;
      let keptOldBytes: Buffer | null = null;
      if (headroomForOld > 0 && currentSize > headroomForOld) {
        // Keep the LAST headroomForOld bytes of the existing file;
        // drop the prefix.
        droppedFromOld = currentSize - headroomForOld;
        keptOldBytes = Buffer.alloc(headroomForOld);
        await fd.read(keptOldBytes, 0, headroomForOld, droppedFromOld);
      } else if (headroomForOld > 0 && currentSize > 0) {
        // The whole existing file fits in the new headroom; keep
        // it all.
        keptOldBytes = Buffer.alloc(currentSize);
        await fd.read(keptOldBytes, 0, currentSize, 0);
      } else {
        // headroomForOld == 0 → the new chunk alone exceeds cap.
        // Drop the entire existing file.
        droppedFromOld = currentSize;
      }

      // Determine which slice of the new chunk we keep. Almost
      // always the whole thing, but if chunk.length > cap we keep
      // only the last `cap` bytes.
      const chunkKeepStart = Math.max(0, chunk.length - cap);
      const chunkKept = chunkKeepStart === 0 ? chunk : chunk.subarray(chunkKeepStart);
      const droppedFromChunk = chunkKeepStart;

      // Apply the truncation + rewrite atomically from the file's
      // perspective: the fd is the only writer.
      await fd.truncate(0);
      let writePos = 0;
      if (keptOldBytes !== null) {
        await fd.write(keptOldBytes, 0, keptOldBytes.length, writePos);
        writePos += keptOldBytes.length;
      }
      await fd.write(chunkKept, 0, chunkKept.length, writePos);
      currentSize = writePos + chunkKept.length;

      onDropped(droppedFromOld + droppedFromChunk);
    }
  } finally {
    await fd.close();
  }
};

// Slice 153 (review): per-stream on-disk cap. Pre-slice the bg
// manager wrote stdout/stderr directly into `Bun.file(path)` via
// Bun.spawn's redirection — kernel-side append-only with no upper
// bound. A multi-hour `npm run watch` with chatty warnings would
// grow the log file indefinitely until the filesystem ran out.
// The model-facing `maxBytes` cap on bash_output only bounded
// what the LLM SAW, not what was on disk.
//
// Slice 153 switches the spawn to `stdout: 'pipe'` / `stderr:
// 'pipe'` plus a drainer task per stream that owns the file fd
// directly. When the on-disk file size would exceed
// `DEFAULT_LOG_CAP_BYTES`, the drainer truncates the head and
// rewrites the tail — preserving the most-recent bytes (which
// matter most for the LLM's read-the-latest pattern) while
// dropping the oldest. The drainer tracks how many bytes were
// dropped per stream so `readOutput` can map an absolute "bytes
// emitted since spawn" cursor onto the current file offset
// (`file_offset = max(0, cursor - dropped)`).
//
// 50 MB per stream is the default — generous enough to capture
// hours of typical dev-server output, tight enough to bound the
// FS impact at ~100 MB per concurrent bg job (stdout + stderr).
// `maxLogBytes` on SpawnInput overrides per call.
const DEFAULT_LOG_CAP_BYTES = 50 * 1024 * 1024;

export interface SpawnInput {
  command: string;
  label?: string;
  cwd?: string;
  // Optional absolute runtime cap. When set, the manager schedules
  // a SIGTERM (with normal kill grace → SIGKILL escalation) after
  // this many milliseconds. Cleared on natural exit so it never
  // fires after the process is already gone. Default undefined =
  // no cap, keeping the long-running semantics for dev servers /
  // watchers / file-system monitors. Models can opt in when they
  // know a build / test run / one-shot job has a bounded duration.
  maxRuntimeMs?: number;
  // §6.5 sandbox profile chosen by the engine for THIS spawn.
  // Threaded through from `ToolContext.sandboxProfile` at the
  // bash_background tool layer. When set + Linux + bwrap available
  // AND profile ≠ `host`, the manager wraps the spawn argv via
  // `maybeWrapSandboxArgv`. Undefined → status quo direct spawn.
  sandboxProfile?: SandboxProfile;
  // Slice 153 (review): per-stream cap in bytes. When the on-disk
  // log file would grow past this, the drainer truncates the
  // head and retains the tail. Default DEFAULT_LOG_CAP_BYTES.
  // Set explicitly when the spawn is short-lived and the operator
  // wants the full log retained (use 0 to disable the cap — file
  // grows unbounded, same as pre-slice behavior).
  maxLogBytes?: number;
}

export interface SpawnResult {
  id: string;
  osPid: number;
  label: string | null;
  spawnedAt: number;
}

export interface ReadOutputInput {
  // Override the stored stdout cursor. If omitted, reads from the
  // offset recorded by the prior call (or 0 on first read). Explicit
  // override lets the model re-read or skip ahead.
  sinceStdout?: number;
  // Override the stored stderr cursor. Independent from stdout —
  // see migration 006 for why dual cursors are necessary.
  sinceStderr?: number;
  // Cap on bytes returned per stream. Defaults to 64 KB to keep a
  // single tool result inside the model's context budget.
  maxBytes?: number;
}

export interface ReadOutputResult {
  // Bytes returned for each stream. UTF-8 decoded; invalid sequences
  // are replaced with U+FFFD so the model never sees a hard error
  // from a binary-flavored log.
  stdout: string;
  stderr: string;
  // Byte offsets for the NEXT call. The caller advances the persisted
  // cursors on success — failed reads (process not found, io error)
  // do NOT advance.
  stdoutCursor: number;
  stderrCursor: number;
  // Snapshot of the row's current status / exit metadata. Lets the
  // model decide "should I keep polling or has it finished?"
  // without a separate getStatus call.
  status: BgProcess['status'];
  exitCode: number | null;
  // Number of bytes still unread on each stream beyond the returned
  // slice. Zero means caught up; >0 means truncated by maxBytes.
  stdoutPending: number;
  stderrPending: number;
}

export interface KillInput {
  // Initial signal. Defaults to SIGTERM. Pass 'SIGKILL' to skip the
  // grace period entirely (immediate hard kill).
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP';
  // Grace period after the initial signal before SIGKILL fires.
  // Defaults to 5000ms. Ignored when signal is already SIGKILL.
  gracePeriodMs?: number;
}

export interface KillResult {
  status: BgProcess['status'];
  exitCode: number | null;
  exitedAt: number | null;
}

export interface StatusSnapshot {
  status: BgProcess['status'];
  exitCode: number | null;
  exitedAt: number | null;
}

export interface GrepOutputInput {
  // Literal substring to match (NOT a regex — avoids ReDoS from
  // model-supplied patterns). A line matches if it contains this.
  pattern: string;
  // Cap on matching lines returned per stream. Default 200.
  maxMatches?: number;
  // Case-insensitive substring match. Default false.
  ignoreCase?: boolean;
}

export interface GrepOutputResult {
  status: BgProcess['status'];
  exitCode: number | null;
  stdoutMatches: string[];
  stderrMatches: string[];
  // True if either stream had more matches than `maxMatches`.
  truncated: boolean;
}

export interface BgManager {
  spawn(input: SpawnInput): Promise<SpawnResult>;
  readOutput(id: string, opts?: ReadOutputInput): Promise<ReadOutputResult>;
  // Scan the WHOLE log of a process for lines containing `pattern` and
  // return just those — the cheap path for "find the failures in a huge
  // output" without paging the cursor window. Reads the log files
  // directly server-side; does NOT advance the readOutput cursor.
  grepOutput(id: string, opts: GrepOutputInput): Promise<GrepOutputResult>;
  kill(id: string, opts?: KillInput): Promise<KillResult>;
  // Thin status accessor — returns null when the id is unknown.
  // Used by the wait subsystem's `process_exit` polling loop and
  // by external tooling that needs lifecycle info without pulling
  // the whole row (`agent doctor`, future UI tray, etc). Cheaper
  // than readOutput (no log file IO).
  getStatus(id: string): StatusSnapshot | null;
  // Terminate every still-running process started by this manager.
  // Used by the session-end cleanup hook. Best-effort — the actual
  // DB rows are flipped to 'killed' even if the OS kill fails.
  cleanup(): Promise<{ killed: number }>;
  // Diagnostic accessor — number of in-memory live process handles.
  // Useful for tests and for `agent doctor` to spot leaks. Not
  // intended to be called during normal session flow.
  liveCount(): number;
  // Snapshot of every bg process in THIS session (running and
  // terminated), read straight from the durable `background_processes`
  // rows — independent of the in-memory `live` map, so it surfaces
  // processes that already exited. Backs the `bash_list` tool
  // (`CONTRACTS.md §2.6.5d`): lets the model recover a `process_id` it
  // lost across turns / compaction. Returns the full session set; the
  // tool filters by status in-process (it needs the full set for the
  // running/total counts anyway).
  list(): BgProcess[];
}

interface LiveHandle {
  proc: ReturnType<typeof Bun.spawn>;
  exitedSettled: Promise<void>;
  // Slice 153 (review): promise that resolves when BOTH drainer
  // tasks have finished reading their pipes (proc exit closes
  // the pipes → drainers loop returns done). exitedSettled
  // awaits this before emitting 'ended' so readOutput run AFTER
  // the ended event sees a fully flushed file with the final
  // bytes captured. The per-stream bytes-dropped count lives in
  // the DB row (migration 043) so it survives process exit + the
  // handle being deleted from `live`.
  drainersSettled: Promise<void>;
}

// Lifecycle observation. Fires once per process for `started` (right
// after spawn succeeds and the live handle is registered) and once
// for `ended` (from inside the exitedSettled handler, regardless of
// whether the exit was natural or kill-induced — kill() awaits the
// same promise, so a single source of truth keeps the contract
// "one started, one ended" without dedup logic on the consumer).
//
// Skipped paths (intentional, no emit):
//   - Spawn failure (Bun.spawn throws): no live process exists, the
//     audit row exists but the TUI tray would show a phantom entry.
//     Caller sees the exception synchronously.
//   - kill() with no live handle (race: spawn happened, exited before
//     kill could attach): no live process to track in the tray.
//
// Status discriminates intent:
//   - 'exited': natural exit (process returned without external signal).
//   - 'killed': operator-initiated termination (kill() or cleanup()).
// 'failed' (spawn-time / DB-write errors) is intentionally NOT in the
// union — those paths skip emit per D147. If a future producer needs
// to surface failure for audit, add the variant + a producer in the
// same slice.
export type BgManagerEvent =
  | { kind: 'started'; processId: string; command: string; label: string | null }
  | {
      kind: 'ended';
      processId: string;
      status: 'exited' | 'killed';
      exitCode: number | null;
    };

export interface CreateBgManagerOptions {
  db: DB;
  sessionId: string;
  // Directory where stdout/stderr log files for this session's bg
  // processes are written. Created on demand. Caller's responsibility
  // to wire to `.agent/bg/<session-or-global>/` per spec §2.7.
  logDir: string;
  // Harness-level abort signal. When provided, the manager registers
  // a one-shot listener that runs `cleanup()` immediately on abort
  // — bg processes die at signal time instead of waiting for the
  // session-end finally to fire (which can be seconds later if the
  // loop is mid-stream). Cleanup is idempotent so the explicit
  // call in `runAgent`'s outer finally is harmless after this fires.
  abortSignal?: AbortSignal;
  // Lifecycle observer. Fires `started` after spawn succeeds and
  // `ended` after the OS reaped the process. Optional — managers
  // built without it run unobserved (tests, headless audits). Throws
  // are caught and discarded so a buggy observer can't break the
  // process lifecycle (mirrors HarnessConfig.onEvent's contract).
  onEvent?: (event: BgManagerEvent) => void;
  // failure_events sink (slice 130). When set + sandboxBootTool is
  // also set, the manager probes sandbox-tool availability before
  // each spawn and emits `sandbox.mid_session_loss` the first time
  // the boot-time tool is no longer present (subsequent spawns in
  // the same loss window suppress; cleared when the tool reappears).
  // Without the sink + boot tool, the probe is skipped entirely
  // and behavior matches pre-slice-130.
  failureSink?: FailureEventSink;
  // The sandbox tool that was available at boot. Used by the
  // mid-session-loss probe — comparing CURRENT `which()` against
  // this BOOT state is what distinguishes "always unavailable"
  // (audited at bootstrap as sandbox.tool_unavailable) from
  // "available then lost" (audited here as sandbox.mid_session_loss).
  // Caller sources via `detectSandboxAvailability` at bootstrap.
  sandboxBootTool?: 'bwrap' | 'sandbox-exec';
  // Test seam for the mid-session-loss probe. Production uses
  // `Bun.which`; tests pin a fake that flips the return value
  // between calls to simulate boot-vs-spawn-time divergence.
  sandboxWhich?: (name: string) => string | null;
  // Test seam for the §6.5 sandbox wrap. Production uses
  // `maybeWrapSandboxArgv` (resolves bwrap/sandbox-exec, fail-closes
  // when a boot tool was present at boot but vanished). Tests that
  // exercise the spawn path WITHOUT depending on a real bwrap on the
  // host's $PATH pin a passthrough (`(o) => o.innerArgv.slice()`), so
  // the spawn runs the inner argv directly. Without this seam a
  // `cwd-rw` spawn on a host lacking bwrap throws "tool unavailable
  // mid-session" (fail-closed, since sandboxBootTool is set), which
  // made the probe tests pass or fail by whether the runner had
  // bubblewrap installed.
  wrapArgv?: typeof maybeWrapSandboxArgv;
  // Slice 157 (review — phase 2 of macOS /tmp isolation). Per-CLI-run
  // tmpdir, plumbed from `HarnessConfig.sandboxTmpdir`. When set, the
  // bg spawn passes it to `maybeWrapSandboxArgv.tmpdir` AND merges
  // `TMPDIR=<this>` into the child's env so the sandboxed bg process
  // confines temp writes to the scoped path on darwin. Undefined on
  // linux (`bwrap --tmpfs /tmp` already isolates) or on darwin when
  // bootstrap mkdir failed (graceful pre-slice-156 fallback).
  sandboxTmpdir?: string;
}

const ensureDir = (dir: string): void => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Slice 172 (review — information-leak P0): bg log dir contains
  // up to 50 MB/stream of captured stdout/stderr from arbitrary
  // bash commands — npm-install network secrets, curl Bearer tokens,
  // env dumps that echo provider API keys. Default umask leaves the
  // dir 0755 (other local users read) and files 0644. Slice 163
  // tightened sessions.db perms but not `.agent/bg/`. Lock down
  // here; the dir lives under `<cwd>/.agent/bg/` per spec §2.7
  // (or per-subagent under `<cwd>/.agent/bg/subagents/<id>/`),
  // both of which are operator-owned trees.
  // Best-effort — exotic FS (FAT/exFAT) ignore chmod.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort lockdown.
  }
};

const fileSize = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

// Read a byte window from a log file. Returns the decoded text plus
// the actual end offset reached (which may be < requested when EOF
// is closer than the cap).
const readWindow = async (
  path: string,
  start: number,
  maxBytes: number,
): Promise<{ text: string; end: number }> => {
  const total = fileSize(path);
  if (start >= total || maxBytes <= 0) {
    return { text: '', end: start };
  }
  const length = Math.min(maxBytes, total - start);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return {
      // 'replace' fatal mode keeps malformed sequences from throwing.
      // Per the comment on ReadOutputResult: bg processes can emit
      // binary or non-UTF8 bytes (npm fancy-spinners, raw byte
      // dumps); the model receives a string regardless.
      text: new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, bytesRead)),
      end: start + bytesRead,
    };
  } finally {
    await fh.close();
  }
};

// Slice 129 (R5 P1 leak): the prior shape registered an `abort`
// listener on every sleep but never removed it on the natural-
// timeout path. A long-lived AbortSignal (e.g., the harness-
// level abortSignal threaded through many kill cycles) would
// accumulate one listener per sleep — leaking memory and
// triggering Node's MaxListenersExceededWarning around the
// 11th call. Fix: both `{ once: true }` (auto-detaches if abort
// DOES fire) and an explicit `removeEventListener` on the
// natural-resolve branch (so the listener detaches BEFORE the
// signal might ever fire). Either path cleans up; doubling up
// is defensive but free.
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Slice 130 (R5 Tier 3): probe state cache for sandbox-loss
// detection. Held by reference inside the closure so duplicate
// emits are suppressed within a single manager instance. The
// cache flips back to `false` if the tool reappears, so a
// transient outage produces one event; a permanent loss
// produces one event regardless of how many spawns happen.
interface SandboxLossCache {
  emittedAt: number | null;
}

const probeSandboxLoss = (
  bootTool: 'bwrap' | 'sandbox-exec' | undefined,
  cache: SandboxLossCache,
  failureSink: FailureEventSink | undefined,
  sessionId: string,
  plannedProfile: SandboxProfile | undefined,
  which: (name: string) => string | null,
): void => {
  if (bootTool === undefined || failureSink === undefined) return;
  if (plannedProfile === undefined || plannedProfile === 'host') return;
  const stillAvailable = which(bootTool) !== null;
  if (stillAvailable) {
    // Tool came back (or never left) — clear the suppression so
    // a future loss produces a fresh event.
    cache.emittedAt = null;
    return;
  }
  if (cache.emittedAt !== null) {
    // Already emitted for this loss window; suppress.
    return;
  }
  try {
    failureSink.emit({
      code: 'sandbox.mid_session_loss',
      classe: 'sandbox',
      recovery_action: 'degraded',
      user_visible: true,
      session_id: sessionId,
      payload: {
        tool: bootTool,
        planned_profile: plannedProfile,
        detected_at_site: 'bg_manager.spawn',
      },
    });
    cache.emittedAt = Date.now();
  } catch {
    // Best-effort — never break spawn on failure_events error.
  }
};

export const createBgManager = (options: CreateBgManagerOptions): BgManager => {
  const {
    db,
    sessionId,
    logDir,
    abortSignal,
    onEvent,
    failureSink,
    sandboxBootTool,
    sandboxWhich,
    sandboxTmpdir,
    wrapArgv,
  } = options;
  const whichFn = sandboxWhich ?? ((name: string) => Bun.which(name));
  const wrapFn = wrapArgv ?? maybeWrapSandboxArgv;
  // In-memory map of live handles, keyed by internal process id. The
  // DB is the source of truth for status across restarts; this map
  // is the in-flight reference we need to actually call .kill() on
  // a Bun subprocess.
  const live = new Map<string, LiveHandle>();
  // Slice 130: sandbox-loss probe state. Persists across spawns of
  // this manager so duplicate emits suppress until the tool
  // reappears.
  const sandboxLossCache: SandboxLossCache = { emittedAt: null };

  // Tracks ids whose termination was operator-initiated (kill() or
  // cleanup()), so the exitedSettled handler can emit `ended` with
  // status='killed' instead of 'exited'. Without this, the natural-
  // exit branch always sees status='running' in the DB row (kill()
  // finalizes AFTER awaiting exitedSettled) and the emit lies about
  // the cause. Cleared in the exitedSettled finally so a process id
  // recycled across runs (theoretical with crypto.randomUUID — vanishingly
  // unlikely) wouldn't carry the killed marker.
  const killing = new Set<string>();

  // Single emit point. Throws are caught so a buggy observer can't
  // break the process lifecycle — same contract as HarnessConfig
  // .onEvent. Inlined helper rather than a wrapper module to keep
  // the manager's surface self-contained.
  const safeEmit = (event: BgManagerEvent): void => {
    if (onEvent === undefined) return;
    try {
      onEvent(event);
    } catch {
      // observer crashed; lifecycle continues
    }
  };

  const spawn = async (input: SpawnInput): Promise<SpawnResult> => {
    ensureDir(logDir);
    const id = crypto.randomUUID();
    const stdoutPath = join(logDir, `${id}.stdout.log`);
    const stderrPath = join(logDir, `${id}.stderr.log`);

    // Touch the log files BEFORE spawn so a fast-failing process
    // (binary not found, immediate exit) still leaves valid empty
    // logs. readOutput's fileSize() returns 0 for a missing file
    // anyway, but creating the files keeps inotify-style watchers
    // (future wait_for) from racing on file_exists.
    await Bun.write(stdoutPath, '');
    await Bun.write(stderrPath, '');
    // Slice 172 (review — information-leak P0). Bg log files
    // capture up to 50 MB/stream of unredacted stdout/stderr —
    // npm-install dependencies' API keys, curl `-H "Authorization:
    // Bearer <token>"` traces, dev-server logs that echo provider
    // tokens. Default umask leaves them 0644 (any other local user
    // on the host can read). Lock down to 0600. Best-effort
    // mirrors the dir chmod above.
    try {
      chmodSync(stdoutPath, 0o600);
      chmodSync(stderrPath, 0o600);
    } catch {
      // Best-effort.
    }

    const cwd = input.cwd ?? process.cwd();
    const spawnedAt = Date.now();

    // §6.5 sandbox runtime wire-up. Same four-condition gate as
    // bash + grep, encapsulated in maybeWrapSandboxArgv. Long-
    // running bg processes get the same isolation when the
    // operator configured a sandbox and the planner chose a
    // non-host profile.
    //
    // Slice 130 (R5 Tier 3): probe boot vs current sandbox-tool
    // state BEFORE the wrap. If the tool was available at boot
    // but isn't now, maybeWrapSandboxArgv silently degrades to
    // passthrough — operator-invisible without this audit trail.
    // Probe is no-op when failureSink or sandboxBootTool aren't
    // wired (test / pre-slice-130 callers).
    probeSandboxLoss(
      sandboxBootTool,
      sandboxLossCache,
      failureSink,
      sessionId,
      input.sandboxProfile,
      whichFn,
    );
    // Info-leak fix mirrors the broker bash handler.
    // `['bash', '-c', input.command]` would leak the full command
    // body (including any interpolated secrets) into
    // `/proc/<pid>/cmdline`, readable by any local user via `ps aux`.
    // We keep the body off argv by piping the script over stdin, but
    // run it through BG_SCRIPT_BOOTSTRAP rather than `bash -s`: the
    // latter aliases the program source to the inherited stdin, so a
    // `cat`/`read` in the script eats its own remaining lines. The
    // bootstrap drains the script into a variable, then evals it with
    // stdin redirected to /dev/null. Both bwrap (Linux) and
    // sandbox-exec (macOS) forward fd 0 to the wrapped child, so the
    // script reaches bash even when wrapped.
    const cmd = wrapFn({
      ...(input.sandboxProfile !== undefined ? { profile: input.sandboxProfile } : {}),
      cwd,
      innerArgv: ['bash', '-c', BG_SCRIPT_BOOTSTRAP],
      // Slice 157 (phase 2): forward per-CLI-run sandbox tmpdir so
      // the SBPL profile on darwin scopes write access. No-op on
      // linux (the option is ignored by the bwrap path) and when
      // bootstrap mkdir failed (sandboxTmpdir is undefined; the
      // wrap degrades to pre-slice-156 blanket allow).
      ...(sandboxTmpdir !== undefined ? { tmpdir: sandboxTmpdir } : {}),
      // fail-closed on mid-session loss when a tool was present at boot
      // (sandboxBootTool set). probeSandboxLoss above already audits the
      // loss for the operator; this surfaces it to the LLM as the tool's
      // error (caught by bash_background's try/catch) instead of a silent
      // unsandboxed bg process.
      failClosed: sandboxBootTool !== undefined,
    });

    // Slice 153 (review): switch to piped streams + drainer tasks.
    // Bun.file(path) redirection is kernel-direct (fast, but the
    // file fd belongs to the kernel and we can't truncate without
    // racing). Piped streams give the manager full fd control.
    // `maxLogBytes: 0` is documented on SpawnInput as the unbounded
    // sentinel ("file grows unbounded, same as pre-cap behavior").
    // Translate to Infinity here so the drainer's existing no-cap
    // branch handles it — without this normalization the validator
    // below saw `0 < 1024` and rejected the documented call shape.
    const requestedCap = input.maxLogBytes ?? DEFAULT_LOG_CAP_BYTES;
    const logCap = requestedCap === 0 ? Number.POSITIVE_INFINITY : requestedCap;
    if (logCap !== Number.POSITIVE_INFINITY && (!Number.isFinite(logCap) || logCap < 1024)) {
      throw new Error(
        `bg spawn: maxLogBytes must be 0, Infinity, or >= 1024 (got ${String(requestedCap)})`,
      );
    }

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd,
        cwd,
        // env scrubbed at the boundary — same defense the synchronous
        // bash tool applies. Without this, a model can spawn a bg
        // process whose command echoes the harness's API keys to the
        // log file and exfiltrate via bash_output. Defense in depth;
        // sandbox (M3+) is the next layer.
        //
        // Slice 157 (phase 2): overlay `TMPDIR=<sandboxTmpdir>` on
        // darwin so mktemp / NSTemporaryDirectory in the sandboxed
        // bash inherit the scoped path. The TMPDIR override sits on
        // top of scrubEnv because scrubEnv only allowlists; TMPDIR
        // isn't on the allowlist by default. Merged AFTER scrubEnv
        // so an attacker injecting TMPDIR via env wouldn't get past
        // scrub anyway.
        env: {
          ...scrubEnv(process.env),
          ...(sandboxTmpdir !== undefined ? { TMPDIR: sandboxTmpdir } : {}),
        },
        // BG_SCRIPT_BOOTSTRAP reads the script from stdin (`cat`).
        // We pipe `input.command` into the child and close stdin so
        // the bootstrap's `cat` sees EOF and the script runs. The
        // body never appears in `/proc/<pid>/cmdline`.
        stdin: 'pipe',
        // Slice 153 (review): pipes instead of Bun.file(path). The
        // manager drains each pipe into the corresponding log file
        // via `drainStream`, owning the fd directly so it can apply
        // the truncate-head cap without racing the kernel writer.
        stdout: 'pipe',
        stderr: 'pipe',
        // Slice 148 (BG1 — process-group isolation): `detached: true`
        // wraps the child in setsid() on Unix, placing it in a fresh
        // process group whose group leader is the child itself. That
        // matters because the typical bg shape is `bash -c "<cmd>"`
        // where `<cmd>` spawns its own children (npm run dev → node →
        // webpack; pytest --watch → many subprocs). Without setsid,
        // those grandchildren share the parent shell's PG; a
        // `proc.kill('SIGTERM')` to the wrapping bash signals ONLY
        // bash, and the grandchildren get orphaned to PID 1 holding
        // their ports / file locks until the next system reboot.
        // With setsid, killing by PG (`process.kill(-pid, sig)` —
        // see killProcessGroup below) cascades to every descendant,
        // exactly what the bg manager's lifecycle needs.
        detached: true,
      });
      // Unref the subprocess so it does NOT keep the parent event
      // loop alive. A bg process is by definition long-running
      // (npm run dev, pytest --watch, file watchers); without unref,
      // a referenced child holds the harness alive after the loop
      // exits, and the CLI hangs on what looks like a clean exit
      // path. Cleanup at session end issues SIGTERM/SIGKILL anyway,
      // so we don't NEED the child to keep the parent alive. The
      // exit handler subscribes via `proc.exited` which still
      // resolves on detached children — no reaping regression.
      proc.unref();

      // Feed the bash script over stdin and close so the
      // bootstrap's `cat` sees EOF and runs the script. Best-effort:
      // if the pipe broke before we could write (child crashed on
      // exec), the child exits non-zero and `proc.exited`
      // surfaces it through the normal lifecycle. We do NOT want
      // a failed stdin write to mask a `proc spawn ok` row.
      try {
        const stdin = (
          proc as unknown as { stdin: { write: (s: string) => unknown; end: () => unknown } }
        ).stdin;
        stdin.write(input.command);
        stdin.end();
      } catch {
        // Best-effort. proc.exited still resolves with the child's
        // actual exit code; finalize will record it.
      }
    } catch (e) {
      // Spawn-time failure (typical: bash not on PATH — vanishingly
      // rare on this stack — or cwd doesn't exist). Record the
      // attempt with status='failed' so it shows up in audit; no
      // live handle is created.
      const row = insertBgProcess(db, {
        id,
        sessionId,
        label: input.label ?? null,
        command: input.command,
        cwd,
        stdoutLogPath: stdoutPath,
        stderrLogPath: stderrPath,
        spawnedAt,
      });
      finalizeBgProcess(db, { id, status: 'failed', exitCode: null, exitedAt: spawnedAt });
      throw new Error(`bg spawn failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: { processId: row.id },
      });
    }

    const row = insertBgProcess(db, {
      id,
      sessionId,
      osPid: proc.pid,
      label: input.label ?? null,
      command: input.command,
      cwd,
      stdoutLogPath: stdoutPath,
      stderrLogPath: stderrPath,
      spawnedAt,
    });

    // Slice 153 (review): spawn the two drainer tasks. Each owns
    // its file fd; truncate-head when the on-disk size would
    // exceed `logCap`. `dropped` is mutated by reference and read
    // by `readOutput` to map persisted absolute cursors onto the
    // current file offset.
    //
    // Type-narrow proc.stdout / proc.stderr: Bun.spawn returns
    // `number | ReadableStream | undefined` depending on the
    // redirection mode. We just passed 'pipe' for both, so they
    // MUST be ReadableStreams; the runtime guard is defense in
    // depth against a future Bun version that returns a different
    // shape for 'pipe'.
    const stdoutStream = proc.stdout as unknown;
    const stderrStream = proc.stderr as unknown;
    if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
      throw new Error(
        `bg spawn: expected stdout/stderr to be piped ReadableStreams (got stdout=${typeof stdoutStream}, stderr=${typeof stderrStream})`,
      );
    }
    // Slice 153 (review): drainer notifies on truncate-head via
    // DB increment. Survives process exit + session restart;
    // readOutput reads the persisted counter from the row.
    const stdoutDrainer = drainStream(stdoutStream, stdoutPath, logCap, (n) => {
      try {
        incrementBgProcessStdoutBytesDropped(db, id, n);
      } catch {
        // DB may have closed mid-shutdown. Drainer's own counter
        // is canonical for the live session via the row lookup
        // in readOutput; a failed DB write loses the increment
        // but doesn't corrupt anything else.
      }
    }).catch((e) => {
      // Drainer crash is best-effort — surface as stderr (operator-
      // visible) and let the process continue. The bash output the
      // operator sees may stop advancing, but the process is alive
      // and a future readOutput will still read whatever made it
      // to disk before the drainer died.
      // Slice 178 (review — P2). Redact secrets in the error
      // message: a write/truncate failure on the log fd can include
      // bound parameter values from internal Bun/Node error shapes
      // that wrapped the on-disk content (rare but possible). The
      // log file itself is already chmod 0600 (slice 172) so
      // operator's stderr is the only fanout vector.
      process.stderr.write(
        `forja bg: stdout drainer failed for pid=${proc.pid} id=${id}: ${redactSecrets(e instanceof Error ? e.message : String(e))}\n`,
      );
    });
    const stderrDrainer = drainStream(stderrStream, stderrPath, logCap, (n) => {
      try {
        incrementBgProcessStderrBytesDropped(db, id, n);
      } catch {
        // see stdout comment
      }
    }).catch((e) => {
      // Slice 178: parallel redaction with the stdout drainer above.
      process.stderr.write(
        `forja bg: stderr drainer failed for pid=${proc.pid} id=${id}: ${redactSecrets(e instanceof Error ? e.message : String(e))}\n`,
      );
    });
    const drainersSettled = Promise.all([stdoutDrainer, stderrDrainer]).then(() => undefined);

    // Optional runtime cap. Schedules a SIGTERM (with normal grace
    // → SIGKILL escalation) after maxRuntimeMs. Stored locally so
    // the exit handler can clear it on natural exit and we don't
    // hold a stale timer past the process's life.
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    if (input.maxRuntimeMs !== undefined && input.maxRuntimeMs > 0) {
      runtimeTimer = setTimeout(() => {
        // Fire-and-forget kill. If the process already exited (race
        // between timer firing and natural exit), kill() is a no-op
        // because status will be 'exited' or 'killed'.
        void kill(id, { signal: 'SIGTERM' }).catch(() => {});
      }, input.maxRuntimeMs);
    }

    // Subscribe to exit. When the process finishes naturally we
    // record the exit code; if it was killed via .kill() the kill
    // handler also awaits this promise, so the DB write happens
    // exactly once (kill flips status to 'killed' AFTER waiting
    // here, which would otherwise race with the natural-exit
    // handler — guarded by checking the row's current status).
    const exitedSettled = (async () => {
      // Two layers of safety:
      //   1. The whole body is in try/finally so `live.delete(id)`
      //      always runs even if the DB write throws (e.g. session
      //      DB closed mid-shutdown). Without this, a stuck handle
      //      sits in `live` forever and shows up in liveCount().
      //   2. The DB write itself is in its own try/swallow so a
      //      thrown error doesn't reject `exitedSettled` — kill()
      //      and cleanup() await this promise; rejecting would
      //      surface DB errors in the kill path that has nothing
      //      to do with them.
      try {
        const code = await proc.exited;
        // Clear the runtime timer so it doesn't fire after the
        // process is already gone (no-op kill, but allocates a
        // pointless task in the loop and keeps the timer
        // referenced for its full duration).
        if (runtimeTimer !== undefined) clearTimeout(runtimeTimer);
        // Slice 153 (review): wait for the drainers to finish
        // reading the pipes before we declare the process ended.
        // Bun.spawn closes the pipes when the child exits;
        // drainStream loops break on read.done. Awaiting here
        // guarantees that any readOutput call AFTER the `ended`
        // event sees the final bytes on disk. Skip the await if
        // it takes more than ~2s — defensive against a pathological
        // drainer (shouldn't happen with the design but a stuck
        // disk write shouldn't block the manager's lifecycle).
        try {
          await Promise.race([drainersSettled, sleep(2000)]);
        } catch {
          // sleep abort or drainer reject — both are swallowed
          // because the manager's lifecycle shouldn't depend on
          // drainer success.
        }
        try {
          const current = getBgProcess(db, id);
          // If status was already moved to 'killed' or 'failed',
          // leave it. Only the 'running'→'exited' transition
          // belongs to this handler. exitCode is recorded even on
          // killed processes — diagnostic (143 for SIGTERM, 137
          // for SIGKILL).
          if (current?.status === 'running') {
            finalizeBgProcess(db, { id, status: 'exited', exitCode: code });
          }
          // Single ended emit, regardless of natural-vs-killed —
          // kill() awaits exitedSettled, so this branch fires
          // exactly once per spawned handle. Status discriminates
          // operator-initiated termination (`killing` set) from
          // natural exit; we can't read it from the DB row because
          // kill() finalizes AFTER this handler runs. exitCode is
          // the OS-reported value; for SIGTERM/SIGKILL it carries
          // the signal-derived code (143/137).
          const finalStatus: 'exited' | 'killed' = killing.has(id) ? 'killed' : 'exited';
          safeEmit({ kind: 'ended', processId: id, status: finalStatus, exitCode: code });
        } catch {
          // DB closed / migration mid-flight / disk error. The OS
          // already reaped the process; we can't update the audit
          // row but cleanup() will run markRunningAsKilled at
          // session end as the safety net. Still emit `ended` with
          // best-effort status so the TUI tray clears — the operator
          // shouldn't see a phantom counter just because the audit
          // path failed. Status mirrors the happy-path discriminator:
          // honor `killing` so a kill()/cleanup()-induced termination
          // surfaces as 'killed' even when the DB write blew up. Pre-
          // fix this branch hardcoded 'exited', which lied about the
          // cause for exactly the scenario this fallback is meant to
          // cover (terminate-then-DB-fail). exitCode stays null
          // because we couldn't read it past the throw.
          const fallbackStatus: 'exited' | 'killed' = killing.has(id) ? 'killed' : 'exited';
          safeEmit({ kind: 'ended', processId: id, status: fallbackStatus, exitCode: null });
        }
      } finally {
        live.delete(id);
        killing.delete(id);
      }
    })();

    live.set(id, { proc, exitedSettled, drainersSettled });
    // Emit AFTER live.set so getStatus() called from within the
    // observer is consistent with the in-memory state.
    safeEmit({
      kind: 'started',
      processId: id,
      command: input.command,
      label: row.label,
    });

    return {
      id,
      osPid: proc.pid,
      label: row.label,
      spawnedAt,
    };
  };

  const readOutput = async (id: string, opts: ReadOutputInput = {}): Promise<ReadOutputResult> => {
    const row = getBgProcess(db, id);
    if (row === null) {
      throw new Error(`bg process not found: ${id}`);
    }
    if (row.sessionId !== sessionId) {
      // Defensive: a row from a different session should never reach
      // a manager bound to THIS session. But the DB is shared, so a
      // caller passing the wrong id would otherwise leak cross-
      // session output. Reject cleanly.
      throw new Error(`bg process not in this session: ${id}`);
    }
    // An explicit `since*` is a transient replay/skip-ahead read —
    // we serve the requested window but DO NOT mutate the persisted
    // cursor. Two failure modes if we did:
    //   (a) `sinceStdout: 0` with small maxBytes rewinds the cursor
    //       to ~maxBytes, so the next canonical read replays old
    //       chunks the model has already seen.
    //   (b) `sinceStdout: 999999` past EOF returns end=999999
    //       (readWindow returns `{ text: '', end: start }` when
    //       start ≥ total), and writing that as the cursor
    //       silently swallows every real future write up to byte
    //       999999.
    // Canonical reads (no since) advance monotonically — `>` rather
    // than `!==` so even an internal regression that produced
    // end < cursor cannot drag the cursor backward.
    const isExplicitStdoutSince = opts.sinceStdout !== undefined;
    const isExplicitStderrSince = opts.sinceStderr !== undefined;
    // Slice 153 (review): cursors are ABSOLUTE bytes-since-spawn.
    // Pre-slice they were file offsets, which broke under truncate-
    // head: a cursor of 50MB before truncate pointed past the new
    // file end after the drainer dropped 30MB of head. Now the
    // file offset is derived by subtracting the persisted dropped
    // count from the absolute cursor.
    //   file_offset = max(0, cursor - dropped)
    //   total_absolute = file_size + dropped
    // Reads happen relative to the file's current state but the
    // accounting is in absolute bytes-since-spawn space, so a
    // since= value from a previous response remains valid after a
    // truncate.
    const stdoutDropped = row.stdoutBytesDropped;
    const stderrDropped = row.stderrBytesDropped;
    const stdoutAbsStart = opts.sinceStdout ?? row.stdoutCursorPosition;
    const stderrAbsStart = opts.sinceStderr ?? row.stderrCursorPosition;
    const stdoutFileStart = Math.max(0, stdoutAbsStart - stdoutDropped);
    const stderrFileStart = Math.max(0, stderrAbsStart - stderrDropped);
    const maxBytes = opts.maxBytes ?? DEFAULT_OUTPUT_READ_LIMIT_BYTES;

    const stdoutFileSize = fileSize(row.stdoutLogPath);
    const stderrFileSize = fileSize(row.stderrLogPath);
    // Total absolute = file size + dropped (bytes truncated from
    // head). Pending = total - current cursor.
    const stdoutTotalAbs = stdoutFileSize + stdoutDropped;
    const stderrTotalAbs = stderrFileSize + stderrDropped;

    // Two cursors, two windows. Each stream advances independently
    // — without this, a noisy stdout would strand stderr writes
    // (see migration 006 for the failure trace). Spec §7.3 surface
    // (`bash_output(process_id, since?)`) was vague on multiple
    // streams; we extend it to dual since.
    const stdoutWin = await readWindow(row.stdoutLogPath, stdoutFileStart, maxBytes);
    const stderrWin = await readWindow(row.stderrLogPath, stderrFileStart, maxBytes);

    // Convert file-offset ends back to absolute for cursor advance
    // + return value. dropped read here may be slightly newer than
    // when we computed start — drainer truncate concurrent with
    // read advances dropped, but readWindow's end is in the file
    // coords of when the read happened. Adding the CURRENT dropped
    // would over-count. Use the same dropped values captured above.
    const stdoutAbsEnd = stdoutWin.end + stdoutDropped;
    const stderrAbsEnd = stderrWin.end + stderrDropped;

    // Cursor advance for canonical reads (no explicit `since`).
    // The local `> row.X` check is intentionally absent: the row
    // snapshot we read at the top of this call may already be
    // stale if another reader (canonical bash_output, wait_for, or
    // monitor poll loop) ran concurrently. Trusting the snapshot
    // means a slower call could clobber a faster one's larger
    // cursor with a smaller value — silent rollback that replays
    // already-seen bytes. Monotonicity is enforced at the DB
    // layer via `WHERE <cursor_col> < ?`; out-of-order writes
    // from concurrent readers become no-ops there.
    if (!isExplicitStdoutSince) {
      advanceBgProcessStdoutCursor(db, id, stdoutAbsEnd);
    }
    if (!isExplicitStderrSince) {
      advanceBgProcessStderrCursor(db, id, stderrAbsEnd);
    }

    return {
      stdout: stdoutWin.text,
      stderr: stderrWin.text,
      stdoutCursor: stdoutAbsEnd,
      stderrCursor: stderrAbsEnd,
      status: row.status,
      exitCode: row.exitCode,
      stdoutPending: Math.max(0, stdoutTotalAbs - stdoutAbsEnd),
      stderrPending: Math.max(0, stderrTotalAbs - stderrAbsEnd),
    };
  };

  // Slice 151 (review): per-id dedup for concurrent kill() callers.
  // Pre-slice two callers entering kill(id) simultaneously both saw
  // status='running', both called handle.proc.kill('SIGTERM'), both
  // awaited exitedSettled, both called finalizeBgProcess. The
  // second escalation timer (after grace) could fire SIGKILL on an
  // already-dead PID; on Linux the kernel filters and it's
  // harmless, but with PID reuse it would signal an unrelated
  // victim. Dedupe by caching the in-flight kill promise per id;
  // concurrent callers AWAIT the same promise rather than racing
  // their own signal+grace cycles.
  const inFlightKills = new Map<string, Promise<KillResult>>();

  const kill = async (id: string, opts: KillInput = {}): Promise<KillResult> => {
    // Concurrent caller: piggyback on the in-flight kill. Same
    // result, no second SIGTERM/SIGKILL cycle, no PID-reuse race.
    const inFlight = inFlightKills.get(id);
    if (inFlight !== undefined) return inFlight;

    const killPromise = (async (): Promise<KillResult> => {
      const row = getBgProcess(db, id);
      if (row === null) {
        throw new Error(`bg process not found: ${id}`);
      }
      if (row.sessionId !== sessionId) {
        throw new Error(`bg process not in this session: ${id}`);
      }

      // Idempotent on already-finished processes: report current
      // state, no signals sent, no DB writes.
      if (row.status !== 'running') {
        return {
          status: row.status,
          exitCode: row.exitCode,
          exitedAt: row.exitedAt,
        };
      }

      const handle = live.get(id);
      if (handle === undefined) {
        // DB says running but no live handle — possible if a prior
        // kill raced or the process exited between getBgProcess and
        // here. Slice 151: preserve the DB's existing exitCode +
        // exitedAt if the natural-exit handler ran between the
        // getBgProcess snapshot above (line 713) and this point.
        // Pre-slice the DB write hard-coded null and clobbered any
        // exit metadata the handler captured.
        const existing = getBgProcess(db, id);
        const preservedExitCode = existing?.exitCode ?? null;
        const preservedExitedAt = existing?.exitedAt ?? Date.now();
        finalizeBgProcess(db, {
          id,
          status: 'killed',
          exitCode: preservedExitCode,
          exitedAt: preservedExitedAt,
        });
        return { status: 'killed', exitCode: preservedExitCode, exitedAt: preservedExitedAt };
      }

      const initialSignal = opts.signal ?? 'SIGTERM';
      const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_KILL_GRACE_MS;

      // Mark BEFORE sending the signal so the exitedSettled handler
      // (which races us to the finish line) sees the marker and emits
      // status='killed' instead of 'exited'. Cleared in exitedSettled's
      // finally — no leak even if kill() throws between here and the
      // signal taking effect.
      killing.add(id);
      // Slice 148 (BG1): kill the whole process group so grandchildren
      // are reaped along with the bash wrapper.
      killProcessGroup(handle.proc, initialSignal);

      if (initialSignal !== 'SIGKILL') {
        // Wait up to gracePeriodMs for graceful exit. Promise.race so
        // a fast-exiting process doesn't pay the full grace; an abort
        // of the sleep on graceful exit avoids a leaked timer.
        const ac = new AbortController();
        try {
          await Promise.race([
            handle.exitedSettled.then(() => ac.abort()),
            sleep(gracePeriodMs, ac.signal),
          ]);
        } catch {
          // sleep aborted on graceful exit — that's the success path
        }
        // If still running after grace, escalate.
        const stillRunning = getBgProcess(db, id)?.status === 'running';
        if (stillRunning) {
          // Slice 148 (BG1): SIGKILL the whole process group. ESRCH
          // (race with natural exit) is handled inside the helper.
          killProcessGroup(handle.proc, 'SIGKILL');
          await handle.exitedSettled;
        }
      } else {
        await handle.exitedSettled;
      }

      // Force-mark as killed even if the natural-exit handler beat us
      // to 'exited' — operator-initiated termination is the correct
      // status for the audit log regardless of signal timing.
      const exitedAt = Date.now();
      finalizeBgProcess(db, {
        id,
        status: 'killed',
        exitCode: handle.proc.exitCode ?? null,
        exitedAt,
      });

      return {
        status: 'killed',
        exitCode: handle.proc.exitCode ?? null,
        exitedAt,
      };
    })();

    // Register the in-flight promise + clear on settle. We use
    // `then(cleanup, cleanup)` rather than `.finally(cleanup)`
    // because `.finally` returns a NEW promise that mirrors the
    // original rejection; without a catch on that derived promise,
    // a kill that throws (e.g. `bg process not found`) surfaces as
    // an unhandled rejection event. `then(handler, handler)`
    // attaches the SAME cleanup to both resolve and reject paths
    // without creating a derived chain that needs its own catch.
    // The original killPromise is the only one returned to the
    // caller — they handle its rejection (or not) on the surface
    // they care about.
    inFlightKills.set(id, killPromise);
    const cleanup = (): void => {
      // Only delete if this is still the registered promise — a
      // future kill cycle for the same id should not be cleared
      // by an old completion. (Same id can't have two in-flight
      // kills at once by construction, but defense in depth.)
      if (inFlightKills.get(id) === killPromise) {
        inFlightKills.delete(id);
      }
    };
    killPromise.then(cleanup, cleanup);
    return killPromise;
  };

  const cleanup = async (): Promise<{ killed: number }> => {
    // Slice 151 (review): count distinct rows we transitioned, not
    // the sum of `ids.length + flipped`. Pre-slice cleanup returned
    // `ids.length + flipped`: for a typical scenario where 3 live
    // handles all get killed cleanly, `kill()` for each marks
    // status='killed' on its DB row, then `markRunningAsKilled`
    // touches 0 rows → flipped=0 → total=3. Correct. But when a
    // kill THREW between signal-sent and finalize (Promise.allSettled
    // swallows the rejection), the row stayed 'running';
    // `markRunningAsKilled` then flipped it, and `ids.length + flipped`
    // double-counted: ids.length counted the killed-attempt, flipped
    // counted the same row in its straggler-pass. Reported "6 killed"
    // for 3 live processes.
    //
    // Fix: snapshot ALL session rows with status='running' BEFORE
    // touching anything, then run kills + flip, then return the
    // snapshot count. That's the definition that matches operator
    // intent: "rows we transitioned out of running".
    const runningBefore = listBgProcessesBySession(db, sessionId, { status: 'running' });
    const runningBeforeCount = runningBefore.length;
    const ids = [...live.keys()];
    // Send SIGTERM to all in parallel, then wait for the grace cycle
    // collectively. Sequential kill would multiply wall-clock by N
    // for a session with many long-running processes (rare today).
    await Promise.allSettled(
      ids.map((id) => kill(id, { signal: 'SIGTERM', gracePeriodMs: CLEANUP_KILL_GRACE_MS })),
    );
    // Defensive: any DB row still 'running' after the kill round
    // gets flipped. Catches the case where a kill threw (process
    // disappeared, etc.) — DB shouldn't lie.
    markRunningAsKilled(db, sessionId);
    return { killed: runningBeforeCount };
  };

  const liveCount = (): number => live.size;

  const getStatus = (id: string): StatusSnapshot | null => {
    const row = getBgProcess(db, id);
    if (row === null) return null;
    if (row.sessionId !== sessionId) {
      // Cross-session ids throw — same surface as readOutput and
      // kill. Returning null would conflate "id doesn't exist
      // anywhere" (caller's bug) with "id belongs to another
      // session" (shared-DB defense), and downstream callers
      // would surface both as bg.process_not_found, hiding the
      // real diagnosis. Throw lets the wait module report a
      // distinct error if needed.
      throw new Error(`bg process not in this session: ${id}`);
    }
    return {
      status: row.status,
      exitCode: row.exitCode,
      exitedAt: row.exitedAt,
    };
  };

  // Durable snapshot of this session's bg processes (running +
  // terminated). Reads the DB rows, not the in-memory `live` map, so
  // it includes processes that already exited — the whole point of
  // `bash_list` (recover a lost process_id).
  const list = (): BgProcess[] => listBgProcessesBySession(db, sessionId);

  // Server-side grep over a process's whole log (both streams). Streams
  // each log file line-by-line and returns only matching lines — the
  // cheap path for "find the failures in a multi-MB output" without
  // paging the cursor window into the model's context. Substring match
  // (no regex). Streaming (not a whole-file read) keeps a huge log out of
  // memory, and the match cap stops the read early.
  const grepOutput = async (id: string, opts: GrepOutputInput): Promise<GrepOutputResult> => {
    const row = getBgProcess(db, id);
    if (row === null) throw new Error(`bg process not found: ${id}`);
    if (row.sessionId !== sessionId) throw new Error(`bg process not in this session: ${id}`);
    const maxMatches = opts.maxMatches !== undefined && opts.maxMatches > 0 ? opts.maxMatches : 200;
    const ignoreCase = opts.ignoreCase === true;
    const needle = ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
    const matches = (line: string): boolean =>
      (ignoreCase ? line.toLowerCase() : line).includes(needle);
    const grepFile = async (path: string): Promise<{ lines: string[]; hitCap: boolean }> => {
      const lines: string[] = [];
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of Bun.file(path).stream()) {
          buf += decoder.decode(chunk, { stream: true });
          const parts = buf.split('\n');
          // Last part is an incomplete line (no trailing newline yet) —
          // carry it to the next chunk; `buf` never holds more than one
          // pending line, so a multi-MB log stays out of memory.
          buf = parts.pop() ?? '';
          for (const line of parts) {
            if (matches(line)) {
              lines.push(line);
              // Reaching the cap returns early; the for-await break
              // cancels the underlying stream (no further read).
              if (lines.length >= maxMatches) return { lines, hitCap: true };
            }
          }
        }
        buf += decoder.decode(); // flush any trailing multibyte remainder
        if (buf.length > 0 && matches(buf)) {
          lines.push(buf);
          if (lines.length >= maxMatches) return { lines, hitCap: true };
        }
      } catch {
        // Log missing/unreadable (never spawned, cleaned up, mid-read
        // truncation) — return whatever matched; the row still gives
        // status. No error rather than failing the whole grep.
      }
      return { lines, hitCap: false };
    };
    const out = await grepFile(row.stdoutLogPath);
    const err = await grepFile(row.stderrLogPath);
    return {
      status: row.status,
      exitCode: row.exitCode,
      stdoutMatches: out.lines,
      stderrMatches: err.lines,
      truncated: out.hitCap || err.hitCap,
    };
  };

  // Wire the abort signal AFTER cleanup is defined so the listener
  // can reference it. `once: true` means the listener runs at most
  // once even if the signal fires multiple times. The catch swallows
  // any cleanup throw so an aborting harness doesn't surface the
  // bg subsystem's errors as the abort cause.
  if (abortSignal !== undefined) {
    if (abortSignal.aborted) {
      // Already aborted at construction time. Fire cleanup immediately
      // — there's nothing to do today (no spawns happened) but the
      // contract should be the same as a normal abort path.
      cleanup().catch(() => {});
    } else {
      abortSignal.addEventListener(
        'abort',
        () => {
          cleanup().catch(() => {});
        },
        { once: true },
      );
    }
  }

  return { spawn, readOutput, kill, getStatus, cleanup, liveCount, list, grepOutput };
};
