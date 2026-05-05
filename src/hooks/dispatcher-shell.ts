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
  // POSIX combined short flags. `bash -lc "cmd"` parses as
  // `-l` (login shell) + `-c` (command), and the `-c` portion
  // still consumes the next arg as command text. Other common
  // forms in the wild: `-ic` (interactive + command), `-clm`,
  // `-cl`. Any group of dash-prefixed letters that contains a
  // LOWERCASE `c` is command-leading. Case-sensitive on `c`
  // because `-C` is bash's noclobber, not a command flag, so
  // `-Cl` / `-CC` should NOT trip. Length > 2 skips the lone
  // `-c` already handled above and the `-x`-style single
  // flags (`-i`, `-l`, `-x`).
  if (token.length > 2 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(token)) return true;
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
// Package-internal — exported only so dispatcher.ts can call
// it across the module boundary. Do NOT re-export from
// dispatcher.ts or index.ts; consumers outside src/hooks/
// should reach for `resolveHookShell()` directly to get the
// uncached resolution they can control via opts.
export const getCachedShell = (): HookShellResolution => {
  if (cachedShell === null) cachedShell = resolveHookShell();
  return cachedShell;
};

// Test seam: reset the module-level cache so tests can swap
// platform/which fixtures between cases.
export const _resetHookShellCacheForTests = (): void => {
  cachedShell = null;
};
