import { readFileSync } from 'node:fs';
import {
  type DB,
  listBgProcessesBySession,
  markBgProcessAsKilled,
} from '../storage/index.ts';

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
export const reapChildBgProcesses = async (db: DB, sessionId: string): Promise<void> => {
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
