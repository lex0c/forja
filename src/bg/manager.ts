import { existsSync, mkdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubEnv } from '../sanitize/index.ts';
import type { DB } from '../storage/db.ts';
import {
  type BgProcess,
  advanceBgProcessStderrCursor,
  advanceBgProcessStdoutCursor,
  finalizeBgProcess,
  getBgProcess,
  insertBgProcess,
  markRunningAsKilled,
} from '../storage/repos/bg-processes.ts';

// Per-call ceiling on bash_output reads. Without a cap, a chatty
// background process (npm run watch with a flood of warnings) could
// dump megabytes of stdout into the model's context in one tool call,
// exhausting the budget. 64 KB is roughly 16k tokens — generous for
// a single read but bounded.
const DEFAULT_OUTPUT_READ_LIMIT_BYTES = 64 * 1024;

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

export interface BgManager {
  spawn(input: SpawnInput): Promise<SpawnResult>;
  readOutput(id: string, opts?: ReadOutputInput): Promise<ReadOutputResult>;
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
}

interface LiveHandle {
  proc: ReturnType<typeof Bun.spawn>;
  exitedSettled: Promise<void>;
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
}

const ensureDir = (dir: string): void => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });

export const createBgManager = (options: CreateBgManagerOptions): BgManager => {
  const { db, sessionId, logDir, abortSignal, onEvent } = options;
  // In-memory map of live handles, keyed by internal process id. The
  // DB is the source of truth for status across restarts; this map
  // is the in-flight reference we need to actually call .kill() on
  // a Bun subprocess.
  const live = new Map<string, LiveHandle>();

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

    const cwd = input.cwd ?? process.cwd();
    const spawnedAt = Date.now();

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd: ['bash', '-c', input.command],
        cwd,
        // env scrubbed at the boundary — same defense the synchronous
        // bash tool applies. Without this, a model can spawn a bg
        // process whose command echoes the harness's API keys to the
        // log file and exfiltrate via bash_output. Defense in depth;
        // sandbox (M3+) is the next layer.
        env: scrubEnv(process.env),
        stdout: Bun.file(stdoutPath),
        stderr: Bun.file(stderrPath),
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

    live.set(id, { proc, exitedSettled });
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
    const stdoutStart = opts.sinceStdout ?? row.stdoutCursorPosition;
    const stderrStart = opts.sinceStderr ?? row.stderrCursorPosition;
    const maxBytes = opts.maxBytes ?? DEFAULT_OUTPUT_READ_LIMIT_BYTES;

    const stdoutTotal = fileSize(row.stdoutLogPath);
    const stderrTotal = fileSize(row.stderrLogPath);

    // Two cursors, two windows. Each stream advances independently
    // — without this, a noisy stdout would strand stderr writes
    // (see migration 006 for the failure trace). Spec §7.3 surface
    // (`bash_output(process_id, since?)`) was vague on multiple
    // streams; we extend it to dual since.
    const stdoutWin = await readWindow(row.stdoutLogPath, stdoutStart, maxBytes);
    const stderrWin = await readWindow(row.stderrLogPath, stderrStart, maxBytes);

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
      advanceBgProcessStdoutCursor(db, id, stdoutWin.end);
    }
    if (!isExplicitStderrSince) {
      advanceBgProcessStderrCursor(db, id, stderrWin.end);
    }

    return {
      stdout: stdoutWin.text,
      stderr: stderrWin.text,
      stdoutCursor: stdoutWin.end,
      stderrCursor: stderrWin.end,
      status: row.status,
      exitCode: row.exitCode,
      stdoutPending: Math.max(0, stdoutTotal - stdoutWin.end),
      stderrPending: Math.max(0, stderrTotal - stderrWin.end),
    };
  };

  const kill = async (id: string, opts: KillInput = {}): Promise<KillResult> => {
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
      // here. Mark as killed in DB to converge state and return.
      finalizeBgProcess(db, { id, status: 'killed' });
      return { status: 'killed', exitCode: null, exitedAt: Date.now() };
    }

    const initialSignal = opts.signal ?? 'SIGTERM';
    const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_KILL_GRACE_MS;

    // Mark BEFORE sending the signal so the exitedSettled handler
    // (which races us to the finish line) sees the marker and emits
    // status='killed' instead of 'exited'. Cleared in exitedSettled's
    // finally — no leak even if kill() throws between here and the
    // signal taking effect.
    killing.add(id);
    handle.proc.kill(initialSignal);

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
        try {
          handle.proc.kill('SIGKILL');
        } catch {
          // process already gone — race between status check and
          // kill is benign; the DB update below settles state
        }
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
  };

  const cleanup = async (): Promise<{ killed: number }> => {
    const ids = [...live.keys()];
    // Send SIGTERM to all in parallel, then wait for the grace cycle
    // collectively. Sequential kill would multiply wall-clock by N
    // for a session with many long-running processes (rare today,
    // common when the orchestrated profile lands in M6).
    await Promise.allSettled(
      ids.map((id) => kill(id, { signal: 'SIGTERM', gracePeriodMs: CLEANUP_KILL_GRACE_MS })),
    );
    // Defensive: any DB row still 'running' after the kill round
    // gets flipped. Catches the case where a kill threw (process
    // disappeared, etc.) — DB shouldn't lie.
    const flipped = markRunningAsKilled(db, sessionId);
    return { killed: ids.length + flipped };
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

  return { spawn, readOutput, kill, getStatus, cleanup, liveCount };
};
