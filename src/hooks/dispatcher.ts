import type { DB } from '../storage/db.ts';
import { createHookRun } from '../storage/repos/hook-runs.ts';
import { expandTemplate } from './template.ts';
import {
  BLOCKING_EVENTS,
  HOOK_STDOUT_MAX_BYTES,
  type HookChainResult,
  type HookEvent,
  type HookEventPayload,
  type HookRunResult,
  type HookSpec,
  MAX_HOOK_CHAIN_MS,
} from './types.ts';

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
}

// Spawn signature the dispatcher uses. Returns an interface
// the dispatcher drives: write stdin, kill, await exit.
export interface DispatchedProcess {
  stdin: { write: (chunk: string) => void; end: () => void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  // Promise resolves when the process exits. `kill(signal)` sends
  // the signal; the resulting exit may take more time. Caller
  // is responsible for the SIGTERM → 1s → SIGKILL ladder.
  exited: Promise<number>;
  kill: (signal?: 'SIGTERM' | 'SIGKILL') => void;
}

export type SpawnFn = (cmd: string[], opts: SpawnOpts) => DispatchedProcess;

export interface SpawnOpts {
  env: Record<string, string>;
  cwd: string;
  stdin: 'pipe';
  stdout: 'pipe';
  stderr: 'pipe';
}

const defaultSpawn: SpawnFn = (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    env: opts.env,
    cwd: opts.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdin: {
      write: (chunk) => {
        proc.stdin.write(chunk);
      },
      end: () => {
        proc.stdin.end();
      },
    },
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: (signal) => {
      proc.kill(signal);
    },
  };
};

// Truncate a string to HOOK_STDOUT_MAX_BYTES; appends a marker
// when truncated so the audit row makes the cap visible.
const truncate = (s: string): string => {
  // Convert to UTF-8 bytes for the cap check — operators may
  // emit multi-byte chars and a char-count cap would over- or
  // under-truncate.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  if (bytes.length <= HOOK_STDOUT_MAX_BYTES) return s;
  const cut = bytes.slice(0, HOOK_STDOUT_MAX_BYTES - 24);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return `${decoder.decode(cut)}\n... (truncated)`;
};

// Read a stream to a string, capping at the byte limit. The cap
// is 4× HOOK_STDOUT_MAX_BYTES so `truncate()` (post-read) has
// slack for the trailing "(truncated)" marker without losing
// useful prefix bytes — keeping the audit-visible cap as the
// canonical truncate point. The READ-side cap is the OOM guard
// against pathological hooks emitting megabytes; truncate is
// the audit-presentation cap. Exported for direct unit-test of
// the slicing behavior without driving a full dispatchOne.
export const STREAM_READ_CAP_BYTES = 16 * 1024;

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Read to EOF, but cap how much we BUFFER. Two layered caps:
  //
  //   - Buffer cap (STREAM_READ_CAP_BYTES): per-chunk slice
  //     before push, so a single multi-MB chunk can't blow
  //     past the cap by being pushed-then-checked.
  //   - Drain semantics: AFTER the buffer cap is reached, we
  //     keep reading and DISCARDING. Breaking out early would
  //     leave bytes in the OS pipe buffer; once that fills,
  //     the subprocess blocks on its next `write()` and never
  //     exits — the dispatcher's per-hook timer fires and we
  //     report `timeout` even though the hook's logic
  //     completed. With failClosed=true on a blockable event,
  //     a chatty-but-correct hook would wrongly deny the
  //     gated tool. Drain-and-discard keeps the pipe flowing,
  //     subprocess writes succeed, child exits naturally,
  //     true exit code reaches classifyExitCode.
  //
  // Drain-and-discard (vs reader.cancel()) is deliberate:
  // canceling the stream propagates to the source, closing
  // the pipe's read end → child gets SIGPIPE / EPIPE on next
  // write. Some operators' hooks ignore SIGPIPE and complete;
  // others abort with a non-zero code that classifyExitCode
  // would call an "error". Drain semantics give a stable
  // contract: cap bounds memory, child sees a healthy pipe.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total >= STREAM_READ_CAP_BYTES) {
      // Cap already reached — discard and keep draining so
      // the subprocess's stdout pipe never fills.
      continue;
    }
    const remaining = STREAM_READ_CAP_BYTES - total;
    const slice = value.byteLength <= remaining ? value : value.subarray(0, remaining);
    chunks.push(slice);
    total += slice.byteLength;
  }
  if (chunks.length === 0) return '';
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
};

// Test-only seam exposing the module-private readStream so the
// per-chunk slicing behavior can be unit-tested without driving
// a full dispatchOne (which post-truncates the audit-cap on top).
export const _readStreamForTests = (stream: ReadableStream<Uint8Array>): Promise<string> =>
  readStream(stream);

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

// Shell selection per platform (spec AGENTIC_CLI.md §10.3:
// "comando: shell line"). The dispatcher historically hardcoded
// `['sh', '-c', ...]`. On Windows hosts without Git Bash / WSL /
// MSYS the `sh` binary isn't on PATH — Bun.spawn throws ENOENT,
// dispatchOne propagates, and operators with `failClosed: true`
// hooks get every blocking event treated as "shell unavailable
// → block". Since paths.ts already resolves
// %PROGRAMDATA%\agent\hooks.toml on Windows, this layer must
// match: hooks need to dispatch on the same hosts where their
// config gets loaded.
//
// Strategy:
//   1. Operator override via `FORJA_HOOK_SHELL` env (split on
//      whitespace; first token is the binary). Power-users pin
//      the shell when auto-detect picks the wrong one.
//   2. Auto-detect: prefer `sh` (POSIX template quoting from
//      template.ts works under any sh-compatible shell — that's
//      bash, dash, zsh, busybox, Git Bash on Windows). Fall
//      back to `bash` (some minimal Linux containers don't
//      install `/bin/sh` but always have `/bin/bash`). On
//      Windows, fall back to `cmd.exe /c` as a last resort.
//   3. If no shell is found, the dispatcher returns
//      `kind: 'unavailable'` and dispatchChain short-circuits
//      to a no-op (no spawn, no audit row, no block). Boot-time
//      caller (CLI run.ts / repl.ts) logs the warning so the
//      operator sees the cause; failClosed hooks WON'T wrongly
//      deny normal operations because no hook ever runs.
//
// Cmd.exe quoting caveat: template.ts emits POSIX single-
// quoted args (`'value'`). Cmd treats single quotes as
// LITERAL characters — `echo 'hello'` outputs `'hello'` (with
// quotes). Operators on Windows-without-sh should either (a)
// install Git Bash / WSL for portable templates, or (b) write
// hook commands that don't depend on POSIX quoting and use
// `{{!key}}` raw with manual escape.
export type HookShellResolution =
  | {
      kind: 'posix' | 'cmd';
      // The shell prefix appended in front of the expanded
      // command. Multi-element to accommodate shells that need
      // more than one flag (e.g., `powershell -NoProfile
      // -Command` requires both before the command string is
      // accepted as code rather than a script-file path).
      argv: readonly string[];
      sourcePath: string;
    }
  | { kind: 'unavailable'; reason: string };

export interface ResolveHookShellOpts {
  platform?: NodeJS.Platform;
  which?: (bin: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

// Tokenize FORJA_HOOK_SHELL the way an operator would expect a
// shell-style env var to parse: whitespace separates tokens UNLESS
// inside matching `"` or `'` quotes. An earlier cut split on raw
// whitespace, so a Windows operator setting
// `"C:\Program Files\Git\bin\bash.exe" -lc` would see the binary
// path shred into `"C:\Program`, `Files\Git\bin\bash.exe"`, and
// `-lc` — the `which` lookup against the first token would fail
// and the dispatcher would mark the shell unavailable, silently
// skipping every hook.
//
// Lenient: unterminated quotes consume to end-of-string (POSIX sh
// would error here, but operator typo-recovery is preferred to a
// hard refusal). No backslash escape — operators with paths that
// contain quote characters in the binary name are an unusual
// edge case; quoting fully is the documented contract.
const splitOverride = (raw: string): string[] => {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (quote !== null) {
      // Inside a quoted segment: anything except the matching
      // close-quote is literal. Whitespace inside quotes does
      // NOT split tokens.
      if (c === quote) {
        quote = null;
      } else {
        buf += c;
      }
      // Stay inToken so an empty-quoted "" still emits the
      // current accumulator at token-end (rare but consistent
      // with shell behavior).
      inToken = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) {
        out.push(buf);
        buf = '';
        inToken = false;
      }
      continue;
    }
    buf += c;
    inToken = true;
  }
  if (inToken) out.push(buf);
  return out;
};

// Detect a "command-leading" flag — one whose IMMEDIATELY-NEXT
// arg is interpreted as the command string by the shell. The
// dispatcher always APPENDS the expanded hook command at the
// end, so a command-leading flag MUST be the last token in
// `argv` for the appended command to land in the right slot.
// Examples:
//   - sh / bash / dash / zsh: `-c <command>`
//   - cmd.exe: `/c <command>` (or `/k`)
//   - powershell: `-Command <command>` / `-EncodedCommand <b64>`
//                 (PowerShell is case-insensitive)
const isCommandLeadingFlag = (token: string): boolean => {
  // POSIX `-c` is case-sensitive (`-C` is bash's noclobber).
  // Powershell ALSO accepts `-c` lower- or upper-case as alias
  // for `-Command`; flagging both `-c` and `-C` here is OK
  // because operator using bash with `-C` (noclobber) for hook
  // dispatch is exotic — happy-path operators don't trip on
  // this.
  if (token === '-c' || token === '-C') return true;
  // cmd.exe case-insensitive `/c` / `/k`.
  if (/^\/[ck]$/i.test(token)) return true;
  // Powershell long-form, case-insensitive.
  if (/^-(?:command|encodedcommand)$/i.test(token)) return true;
  return false;
};

export const resolveHookShell = (opts: ResolveHookShellOpts = {}): HookShellResolution => {
  const platform = opts.platform ?? process.platform;
  const which = opts.which ?? ((bin: string) => Bun.which(bin));
  const env = opts.env ?? process.env;

  // 1. Explicit override wins. Operator picks what they want.
  // Override can carry multiple args after the binary —
  // `powershell -NoProfile -Command` needs all three before the
  // command string is treated as code. We pass everything past
  // index 0 through unchanged.
  const override = env.FORJA_HOOK_SHELL;
  if (override !== undefined && override.length > 0) {
    const parts = splitOverride(override);
    const bin = parts[0];
    if (bin === undefined) {
      return { kind: 'unavailable', reason: 'FORJA_HOOK_SHELL is set but empty after split' };
    }
    const found = which(bin);
    if (found === null) {
      return {
        kind: 'unavailable',
        reason: `FORJA_HOOK_SHELL='${override}' but '${bin}' is not on PATH`,
      };
    }
    // Reject overrides that pre-fill the command slot. The
    // dispatcher appends the expanded hook command after the
    // operator's argv, so a command-leading flag (`-c`, `/c`,
    // `-Command`, etc.) MUST be the last token. If it isn't —
    // e.g. operator wrote `FORJA_HOOK_SHELL='sh -c "echo hi"'`
    // — the shell would treat `"echo hi"` as the command and
    // the actual hook becomes `$0` (positional, ignored), so
    // every dispatch silently runs `echo hi` and operator
    // policy is bypassed. Refuse loudly with guidance.
    for (let j = 1; j < parts.length - 1; j++) {
      const tok = parts[j] as string;
      if (isCommandLeadingFlag(tok)) {
        return {
          kind: 'unavailable',
          reason: `FORJA_HOOK_SHELL='${override}' has tokens after command flag '${tok}'; the hook command is appended at dispatch time, so any text past the flag pre-empts it. Move the flag to the end (or remove the trailing tokens).`,
        };
      }
    }
    // Cmd-vs-POSIX heuristic from the binary name. Match the
    // basename across either path separator so /wine/cmd.exe
    // (POSIX path style) and C:\\Windows\\cmd.exe (Windows
    // style) both classify correctly. Anything else assumes
    // POSIX semantics — operator override is expected to know
    // what they're doing.
    const looksLikeCmd = /(?:^|[/\\])cmd(?:\.exe)?$/i.test(found);
    // Default flag is shell-aware: cmd.exe accepts only `/c` or
    // `/k` (Microsoft `cmd [/c|/k]`). Defaulting to `-c` for
    // cmd would spawn `cmd.exe -c <expanded>` and fail with
    // "no such command -c", surfacing as a hook-error outcome —
    // worst case a failClosed blocking hook denies the gated
    // tool for the wrong reason. POSIX shells take `-c`. When
    // the operator passed flags explicitly, honor them as-is.
    const flagArgs = parts.length > 1 ? parts.slice(1) : looksLikeCmd ? ['/c'] : ['-c'];
    return {
      kind: looksLikeCmd ? 'cmd' : 'posix',
      argv: [found, ...flagArgs],
      sourcePath: found,
    };
  }

  // 2. Auto-detect.
  for (const bin of ['sh', 'bash']) {
    const found = which(bin);
    if (found !== null) {
      return { kind: 'posix', argv: [found, '-c'], sourcePath: found };
    }
  }

  // 3. Windows fallback: cmd.exe is always present.
  if (platform === 'win32') {
    const found = which('cmd.exe') ?? 'cmd.exe';
    return { kind: 'cmd', argv: [found, '/c'], sourcePath: found };
  }

  return {
    kind: 'unavailable',
    reason: 'no POSIX shell on PATH (looked for sh, bash); set FORJA_HOOK_SHELL to override',
  };
};

// Cached at module load; one resolution per process. Operators
// changing PATH mid-process won't re-detect (would need a
// restart) — acceptable since the harness is one-process-per-
// session today.
let cachedShell: HookShellResolution | null = null;
const getCachedShell = (): HookShellResolution => {
  if (cachedShell === null) cachedShell = resolveHookShell();
  return cachedShell;
};

// Test seam: reset the module-level cache so tests can swap
// platform/which fixtures between cases.
export const _resetHookShellCacheForTests = (): void => {
  cachedShell = null;
};

// Decide whether a hook spec applies given an event + optional
// tool name. Today only `tool` matchers exist; matcher succeeds
// when spec.matcher.tool either equals or glob-prefix-matches
// the supplied tool name. Glob is a single trailing `*`
// (`bash*` matches `bash` and `bash_background`).
//
// Both `matchesPayload` and the public `filterMatchingHooks`
// share this; earlier cut had two near-identical
// implementations that risked drifting.
const specMatches = (spec: HookSpec, event: HookEvent, toolName: string | null): boolean => {
  if (spec.event !== event) return false;
  const toolMatcher = spec.matcher.tool;
  if (toolMatcher === undefined) return true;
  // Tool matcher only meaningful when a tool name is in scope.
  // Non-tool events pass `null` and never match.
  if (toolName === null) return false;
  if (toolMatcher.endsWith('*')) {
    return toolName.startsWith(toolMatcher.slice(0, -1));
  }
  return toolName === toolMatcher;
};

// Extract the tool name from a payload, if it's a tool-shaped
// event. Centralizes the discriminant check so callers don't
// repeat `event === 'PreToolUse' || ...`.
const toolNameFromPayload = (payload: HookEventPayload): string | null => {
  if (payload.event === 'PreToolUse' || payload.event === 'PostToolUse') {
    return payload.data.tool.name;
  }
  return null;
};

const matchesPayload = (spec: HookSpec, payload: HookEventPayload): boolean =>
  specMatches(spec, payload.event, toolNameFromPayload(payload));

// Map exit code + event to the dispatcher's discriminated
// outcome. See HookRunResult in types.ts for the kind union.
const classifyExitCode = (
  exitCode: number,
  stdout: string,
  durationMs: number,
  failClosed: boolean,
): HookRunResult => {
  if (exitCode === 0) return { kind: 'allow', stdoutTruncated: stdout, durationMs };
  if (exitCode === 1) return { kind: 'block_silent', durationMs };
  if (exitCode === 2) {
    // Per spec: stdout becomes the reason. Empty stdout still
    // produces a block_message (with empty reason) — operator
    // intent is "block, here's why" even if `why` ended up
    // missing.
    return { kind: 'block_message', message: stdout.trim(), durationMs };
  }
  // Exit > 2: hook error. Caller treats as block iff failClosed.
  return {
    kind: 'error',
    exitCode,
    reason: `hook exited with code ${exitCode}`,
    durationMs,
    shouldBlock: failClosed,
  };
};

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
  const proc = spawn([...shell.argv, expanded], {
    env: buildHookEnv(cwd, deps.sessionId ?? null),
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

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
  // branch owns its teardown — earlier cut shared a `timedOut`
  // bool that could land true even when the natural-exit branch
  // ultimately won the race (timer microsecond-firing on a
  // clean exit), causing the dispatcher to misreport a normal
  // exit as `timeout`. Tagged-result race avoids the shared
  // mutable state.
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

  // Emit audit row. Best-effort try/catch — DB failure must
  // not invalidate the hook's decision (the operator's
  // shell command already ran and returned).
  if (deps.db !== undefined) {
    try {
      const matcherTool =
        payload.event === 'PreToolUse' || payload.event === 'PostToolUse'
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
        // CONTRACTS.md §3 line 725: timeouts record exit_code
        // 124 (POSIX `timeout(1)` convention). exitCode is
        // already 124 in the timeout branch above; pass through.
        exitCode,
        outcome: result.kind,
        durationMs,
        stdout: stdout.length > 0 ? stdout : null,
        stderr: stderr.length > 0 ? stderr : null,
        matchedTool: matcherTool,
        createdAt: now(),
      });
    } catch (err) {
      // AUDIT DRIFT — same pattern as memory registry.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `hooks: AUDIT DRIFT: failed to record ${spec.event} run (${spec.sourcePath}#${hookIndex}): ${msg}\n`,
      );
    }
  }

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
  const matching = hooks.filter((spec) => matchesPayload(spec, payload));
  const isBlocking = BLOCKING_EVENTS.has(payload.event);
  const now = deps.now ?? (() => Date.now());
  const chainStarted = now();
  const runs: { spec: HookSpec; result: HookRunResult }[] = [];
  let blockedBy: HookChainResult['blockedBy'] = null;

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
    return { blockedBy: null, runs };
  }

  for (let i = 0; i < matching.length; i++) {
    const spec = matching[i];
    if (spec === undefined) continue;
    const elapsed = now() - chainStarted;
    if (isBlocking && elapsed >= MAX_HOOK_CHAIN_MS) {
      // Whole-chain timeout per CONTRACTS.md §10 line 1040.
      // Surface as a stderr warning + skip remaining hooks.
      // For audit clarity, we don't emit `hook_runs` rows for
      // skipped hooks — the absence is itself the signal
      // (compare against the resolved chain to spot it).
      //
      // `>=` not `>`: at exactly `elapsed === MAX`, remaining
      // budget is zero and the per-hook clamp downstream would
      // floor to 1ms (`Math.max(1, 0)`) — sneaking one extra
      // hook past the documented hard cap. The boundary belongs
      // to "expired", not "one more for free".
      process.stderr.write(
        `hooks: chain for ${payload.event} exceeded ${MAX_HOOK_CHAIN_MS}ms; skipping ${matching.length - i} remaining hook(s)\n`,
      );
      break;
    }

    // Per-hook timeout clamped against the remaining chain
    // budget for blocking events. Without this, a chain that
    // reached t=14.9s could still launch a hook with
    // spec.timeoutMs=30000 and run out to t=44.9s — violating
    // the 15s wall-clock cap that CONTRACTS.md §10 line 1040
    // advertises to callers. Non-blocking events don't gate
    // anything, so their clamp is moot (chain return doesn't
    // wait on them in spec terms; harness drains separately).
    const remaining = MAX_HOOK_CHAIN_MS - elapsed;
    const effectiveTimeoutMs = isBlocking
      ? Math.max(1, Math.min(spec.timeoutMs, remaining))
      : spec.timeoutMs;

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

  return { blockedBy, runs };
};

export const filterMatchingHooks = (
  hooks: readonly HookSpec[],
  event: HookEvent,
  toolName: string | null = null,
): HookSpec[] => hooks.filter((spec) => specMatches(spec, event, toolName));
