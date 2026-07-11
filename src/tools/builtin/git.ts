import { resolve } from 'node:path';
import { maybeWrapSandboxArgv } from '../../permissions/index.ts';
import { getGitBinaryWithEnv } from '../../subagents/git-binary.ts';
import {
  ERROR_CODES,
  isToolError,
  type Tool,
  type ToolContext,
  type ToolError,
  type ToolResult,
  toolError,
} from '../types.ts';

// Read-only, structured git access. A normal builtin offered to
// every agent (main + subagents) like read_file/grep — it originated
// as the `general-purpose` subagent's window into history +
// working-tree state (PLAYBOOKS.md §1.2), and that playbook whitelists
// it, but it is not subagent-exclusive.
//
// The model never passes raw git flags: it picks a `mode` and typed
// params, and THIS module builds a hardened argv. That is the whole
// security posture — there is no passthrough, so the classic
// read-command footguns (`-c core.pager=<cmd>`, `--output=<file>`,
// `--ext-diff` + a malicious `.gitattributes`, alias invocation) are
// unreachable.
//
// Because it is `writes: false` / `escapesCwd: false`, it runs in an
// `isolation: none` subagent (no worktree) AND it reads the parent's
// LIVE working tree — so `diff` / `status` see uncommitted changes,
// which a HEAD-checked-out worktree would miss.

export type GitMode = 'log' | 'show' | 'show_file' | 'diff' | 'blame' | 'status' | 'ls_files';

export interface GitInput {
  mode: GitMode;
  path?: string;
  ref?: string;
  max_count?: number;
  staged?: boolean;
  follow?: boolean;
  stat?: boolean;
}

export interface GitOutput {
  mode: GitMode;
  // A representative, copy-pasteable `git <mode> …` line (see
  // representativeCommand): the logical command, with internal hardening/
  // framing flags omitted. NOT a byte-exact replay — `output` is also
  // policy-filtered.
  command: string;
  output: string;
  truncated: boolean;
  exit_code: number;
}

// The valid `mode` values. Exported so the `/perms why git` dry-check
// can tell a mode token (`status`) from a path argument.
export const GIT_MODES: ReadonlySet<string> = new Set([
  'log',
  'show',
  'show_file',
  'diff',
  'blame',
  'status',
  'ls_files',
]);

const DEFAULT_LOG_COUNT = 50;
const MAX_LOG_COUNT = 1000;
// Hard cap on captured stdout. git `show`/`diff`/`blame` on a large
// file can run to MBs; we stream and stop here, flag `truncated`. Sized
// to match read_file's MAX_OUTPUT_BYTES (256 KiB) so a `show`/`diff` of a
// real change usually completes rather than truncating mid-patch; the
// `stat` mode + `path` scoping are the cheaper ways to survey a big diff.
const OUTPUT_CAP_BYTES = 256 * 1024;

// Grace window after we ask a git child to stop (the truncation SIGTERM,
// or an abort that made Bun SIGTERM it) before escalating to an
// uncatchable SIGKILL. Bounds the `await proc.exited` hang if the child
// ignores SIGTERM — the structural backstop the broker has and this path,
// unsandboxed, otherwise lacked. Only armed on the stop path; a normally
// running git is awaited without a deadline.
const REAP_GRACE_MS = 2_000;

// A ref is positional, so a value beginning with `-` would be parsed
// as a flag. We forbid that and restrict to the characters that
// appear in real ref names + range syntax (`A..B`, `A...B`). No
// spaces, no shell metacharacters (there is no shell — argv is
// passed directly — but this keeps the surface tight).
const REF_RE = /^[A-Za-z0-9_./~^@{}-]+$/;

// Defensive `-c` overrides we inject ourselves (never the model).
// These close every config-driven way a hostile `.git/config` (repo-
// local OR the operator's global) could get an "otherwise read-only"
// git command to fork-exec an attacker-chosen program:
//   - core.fsmonitor: runs a monitor program on most commands.
//   - core.hooksPath / hooks: run on lifecycle events.
//   - log.showSignature: makes log/show assume `--show-signature`,
//     which feeds the commit signature to `gpg.program` /
//     `gpg.ssh.program` — both config-selected executables. Forcing
//     it false means signature verification (and thus the gpg exec)
//     is never attempted. `--no-ext-diff` / `--no-textconv` (added
//     per-mode) close the diff/textconv exec paths.
//   - diff.submodule=short: with `diff.submodule=diff` set, diff/show
//     inline the FULL content diff of a changed submodule, but the
//     `--name-only` content-gate pre-flight only sees the submodule
//     PATH — so a denied `sub/.env` would leak whenever `sub` itself
//     is readable. Forcing `short` emits only the subproject SHAs.
//   - diff.external=: empty disables an external diff driver at the
//     config level — defense in depth behind the per-mode
//     `--no-ext-diff`, so the exec path stays shut even for a mode
//     that forgets the flag. (`*.textconv` / `diff.<d>.command` bound
//     via in-tree `.gitattributes` have no config wildcard and rely on
//     the per-mode `--no-textconv` / `--no-ext-diff` — see the audit
//     note in BACKLOG.)
//   - diff.renames=false: with rename detection ON, `--name-only`
//     reports only the rename DESTINATION, so the content-gate
//     pre-flight would miss the SOURCE path — a denied `secret.env`
//     renamed+edited into an allowed `src/a.txt` would leak its old
//     contents through the real diff's `--- a/secret.env` lines.
//     Disabling it decomposes a rename into delete(source)+add(dest)
//     so `--name-only` reports both and the gate sees the source.
//     (`log --follow` keeps working — it drives its own rename
//     detection regardless of this config.)
const HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'log.showSignature=false',
  '-c',
  'diff.submodule=short',
  '-c',
  'diff.external=',
  '-c',
  'diff.renames=false',
  // Disable color globally here rather than per-mode: `--no-color` is
  // not accepted by every subcommand (`git status` rejects it), but
  // the `-c color.ui=false` override is honored uniformly. Piped
  // output already auto-disables color; this makes it deterministic.
  '-c',
  'color.ui=false',
  '--no-pager',
];

// Validate the optional path: relative, no `..` escape, no leading
// `-` (would be read as a flag even after `--` in some git versions
// for certain modes — cheap to reject outright).
const validatePath = (path: string): string | null => {
  if (path.length === 0) return 'path must be non-empty';
  if (path.startsWith('-')) return "path must not start with '-'";
  if (path.startsWith('/')) return 'path must be relative to the repo, not absolute';
  // Reject git pathspec magic (`:(top)`, `:(exclude)`, `:(glob)`,
  // `:!`, `:/…`). `--` ends OPTION parsing but does NOT disable
  // pathspec magic, so a leading `:` would still change which files
  // git reports — repo-confined and read-only, but it breaks the
  // "literal repo-relative path" contract this tool advertises.
  if (path.startsWith(':')) return "path must not start with ':' (no pathspec magic)";
  const segments = path.split('/');
  if (segments.includes('..')) return "path must not contain '..'";
  return null;
};

// Build the mode-specific argv (without the `git` + hardening
// prefix). Returns either the args or a validation error string.
// Exported so the security contract (flag-injection rejection, the
// per-mode argv shape) is unit-testable without spawning git.
export const buildModeArgs = (args: GitInput): { args: string[] } | { error: string } => {
  const { mode } = args;
  // An empty-string path/ref is treated as OMITTED (not an error): models often
  // emit `ref: ''` / `path: ''` to mean "the default" instead of omitting the
  // optional field. ref undefined → working-tree (status/log) or HEAD (show);
  // path undefined → the cwd subtree (`-- .`). A non-string still fails the
  // typeof guard below.
  const path = args.path === '' ? undefined : args.path;
  const ref = args.ref === '' ? undefined : args.ref;

  // Defend against non-string path/ref: nothing validates the model's
  // tool-call JSON against `inputSchema` before execute(), so an internal
  // or IPC caller can hand us `path: 123` / `ref: ['x']`. Without these
  // guards the `.startsWith`/`.test` below throw a raw TypeError that
  // surfaces as a leaky `tool.exception` instead of a clean `invalidArg`.
  if (path !== undefined) {
    if (typeof path !== 'string') return { error: 'path must be a string' };
    const err = validatePath(path);
    if (err !== null) return { error: err };
  }
  if (ref !== undefined) {
    if (typeof ref !== 'string') return { error: 'ref must be a string' };
    if (ref.length === 0) return { error: 'ref must be non-empty' };
    if (ref.startsWith('-')) return { error: "ref must not start with '-'" };
    // A `:` means the caller used git's native `rev:path` form — the common
    // show_file mistake. Catch it specifically (REF_RE would reject it with
    // a generic message) and point at the typed-arg shape.
    if (ref.includes(':')) {
      return {
        error:
          "ref must be a bare revision (e.g. HEAD, a tag, a SHA) — not git's `rev:path` form; for show_file, pass the file in `path` separately",
      };
    }
    if (!REF_RE.test(ref)) return { error: 'ref contains unsupported characters' };
  }

  // `stat` is `diff`-only. `show --stat` on a MERGE reports the FIRST-PARENT
  // diffstat while the content gate's `--name-only` pre-flight uses
  // COMBINED-diff semantics — so a file taken cleanly from the second
  // parent is invisible to the gate but its name+churn appears in the
  // stat (a denied-name leak). `diff` is always two-endpoint (never
  // combined), so `diff --stat` is gate-consistent. For a single commit's
  // stat, use `diff` with a range (e.g. ref: "HEAD~1..HEAD").
  if (args.stat === true && mode !== 'diff') {
    return {
      error: 'stat is only supported for diff (for a commit, use a ref range like "HEAD~1..HEAD")',
    };
  }

  // Pathless modes get an explicit `-- .` (current directory) pathspec.
  // Without it, `status`/`log`/`diff`/`ls-files` operate REPO-WIDE even
  // when the session cwd is a repo subdirectory — so from `/repo/src` a
  // pathless call would expose `/repo/docs/*` status/history metadata
  // that the permission gate (which resolves a pathless git target to
  // the cwd) never authorized. `-- .` scopes git's output to the cwd
  // subtree, matching what was gated. (`--name-only` paths stay
  // repo-root-relative, so the content gate's resolution is unaffected.)
  const pathspec = path !== undefined ? ['--', path] : ['--', '.'];

  switch (mode) {
    case 'log': {
      let max = DEFAULT_LOG_COUNT;
      if (args.max_count !== undefined) {
        if (
          typeof args.max_count !== 'number' ||
          !Number.isInteger(args.max_count) ||
          args.max_count < 1
        ) {
          return { error: 'max_count must be a positive integer' };
        }
        max = Math.min(args.max_count, MAX_LOG_COUNT);
      }
      return {
        args: [
          'log',
          '-n',
          String(max),
          '--date=short',
          '--pretty=format:%h %ad %an%d %s',
          ...(args.follow === true ? ['--follow'] : []),
          ...(ref !== undefined ? [ref] : []),
          ...pathspec,
        ],
      };
    }
    case 'show':
      // Peel to a commit so `show` can only ever emit a (gated) commit
      // diff — a bare blob/tree ref would dump object content the
      // content-gate's `--name-only` pre-flight cannot enumerate. Kept
      // in lockstep with nameOnlyArgs's show form. (`stat` is rejected for
      // show above — its first-parent enumeration would diverge from the
      // gate's combined-diff `--name-only` on a merge.)
      return {
        args: ['show', '--no-ext-diff', '--no-textconv', `${ref ?? 'HEAD'}^{commit}`, ...pathspec],
      };
    case 'show_file':
      // Print the CONTENT of one file at a revision via `git cat-file blob
      // <rev>:./<path>` — a raw object read, deliberately NOT `git show`:
      //   - cat-file blob FAILS CLOSED on a non-blob: a DIRECTORY path
      //     (`git show <rev>:./dir`) would dump the tree's child NAMES,
      //     which `show_file`'s single-path gate never checks and the
      //     metadata name-filter doesn't cover — a filename leak. cat-file
      //     blob errors ("bad file") on a tree, so only real files emit.
      //   - it never runs textconv/filters/diff drivers (pure object
      //     access), so there is no `.gitattributes`-driven exec to block.
      // The `./` prefix forces git to resolve <path> relative to the CWD
      // (a bare `<rev>:<path>` is repo-root-relative) so the file git reads
      // is exactly the one the engine + execute gate on (resolve(cwd, path)).
      if (path === undefined) return { error: 'show_file requires a path' };
      return {
        args: ['cat-file', 'blob', `${ref ?? 'HEAD'}:./${path}`],
      };
    case 'diff':
      return {
        args: [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          ...(args.stat === true ? ['--stat'] : []),
          ...(args.staged === true ? ['--staged'] : []),
          ...(ref !== undefined ? [ref] : []),
          ...pathspec,
        ],
      };
    case 'blame': {
      if (path === undefined) return { error: 'blame requires a path' };
      return {
        args: ['blame', '--no-textconv', ...(ref !== undefined ? [ref] : []), '--', path],
      };
    }
    case 'status':
      // `-z` + `--no-renames` make the output a stream of single-path,
      // NUL-framed records (a rename decomposes into delete(source) +
      // add(dest), each its own record) so the metadata path-gate can
      // reliably split records and gate EVERY emitted name — a two-path
      // rename record would otherwise hide the source path from the gate.
      // `-z` emits REPO-ROOT-relative names (porcelain ignores
      // status.relativePaths under `-z`), so the gate resolves them
      // against the repo root, matching ls_files's `--full-name` below.
      // `-- .` confines the listing to the cwd subtree. The gate
      // re-renders the kept records as newline-separated lines.
      return { args: ['status', '--short', '--branch', '--no-renames', '-z', ...pathspec] };
    case 'ls_files':
      // `--full-name` forces REPO-ROOT-relative names (default is
      // cwd-relative) so the gate resolves them against the repo root —
      // the SAME base as status's `-z` output, so one resolution rule
      // covers both modes. `-z` frames each path for reliable,
      // quoting-proof splitting; `-- .` keeps the listing cwd-scoped.
      return { args: ['ls-files', '--full-name', '-z', ...pathspec] };
    default:
      return { error: `unknown mode '${String(mode)}'` };
  }
};

// Extra env overlaid on top of `safeGitEnv()` for this read-only
// path. `safeGitEnv()` is the controlled baseline the whole codebase
// uses for git subprocesses — crucially it builds a fresh allowlist
// (LC_ALL/PATH/HOME/GIT_TERMINAL_PROMPT) rather than inheriting
// `process.env`, so repository-selection vars (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, …) cannot redirect this
// supposedly cwd-scoped tool at a repo/index outside `ctx.cwd`. We add
// pager/lock guards; `GIT_LITERAL_PATHSPECS` disables pathspec magic
// at the env level as defense-in-depth behind the leading-`:` reject.
const EXTRA_GIT_ENV: Record<string, string> = {
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
  // Ignore the operator's global (~/.gitconfig) AND /etc/gitconfig:
  // an exec/leak knob set there cannot fire (the `-c` overrides above
  // already beat them for KNOWN knobs; this removes the whole source
  // for unknown ones). Read-only modes never need the global identity,
  // so dropping it is safe. The repo-local `.git/config` + in-tree
  // `.gitattributes` are NOT (and cannot be) dropped this way — git
  // always reads them — which is why the dangerous knobs are pinned
  // via `-c` (highest precedence) and `--no-textconv`/`--no-ext-diff`.
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

// Modes whose OUTPUT carries file CONTENT (not just names/metadata):
// a `diff` or `show` over a directory/whole-tree emits the contents of
// every changed/committed file, so gating only the search root would
// let a policy-denied descendant (a .env, a secrets/ file) leak in the
// body. These fail CLOSED (refuse the whole command) — a diff cannot be
// partially redacted into something meaningful.
const CONTENT_MODES: ReadonlySet<string> = new Set(['diff', 'show']);

// Modes whose OUTPUT is a list of file NAMES. The engine gates git on
// the search ROOT only (cwd, or `src/**`), so under an allowed root a
// `ls_files`/`status` would still EMIT the names of a policy-denied
// descendant (deny_paths: `src/secrets/**`, a sensitive `src/.env`) —
// the metadata sibling of the diff/show content leak. Unlike content,
// names CAN be redacted line-by-line, so these FILTER: each emitted path
// is resolved + canReadPath-checked, and denied entries are dropped from
// the output (a single denied file does not blank the whole listing).
// `log` (compact format) emits no per-file paths; `blame` requires a
// single-file path the engine already gated — neither needs this.
const PATH_METADATA_MODES: ReadonlySet<string> = new Set(['status', 'ls_files']);

// The `--name-only` form of a content mode — used as a pre-flight to
// learn which files the real command would emit, so each can be gated.
// `-z` (NUL-terminated) is load-bearing: with the default
// `core.quotePath`, git C-escapes non-ASCII/control-char filenames
// (e.g. `"\321\204.env"`), which would parse to the wrong path and
// slip a denied file past the gate. NUL framing emits raw bytes and
// also survives spaces/newlines in names. `show` peels its ref with
// `^{commit}` so it can only ever diff a COMMIT — a bare blob/tree ref
// would otherwise dump object content that `--name-only` does not
// represent (see buildModeArgs show, kept in lockstep).
const nameOnlyArgs = (args: GitInput): string[] | null => {
  const ref = args.ref;
  // Mirror buildModeArgs: pathless pre-flight scopes to `-- .` so the
  // file list matches the (cwd-scoped) real command exactly.
  const pathspec = args.path !== undefined ? ['--', args.path] : ['--', '.'];
  if (args.mode === 'diff') {
    return [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      ...(args.staged === true ? ['--staged'] : []),
      ...(ref !== undefined ? [ref] : []),
      ...pathspec,
    ];
  }
  if (args.mode === 'show') {
    return [
      'show',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      '--format=',
      `${ref ?? 'HEAD'}^{commit}`,
      ...pathspec,
    ];
  }
  if (args.mode === 'log') {
    // Enumerate each shown commit's touched files so a commit that ONLY
    // touched a policy-denied path can be dropped (its subject/author/date
    // would otherwise leak denied-subtree history). `%x1e` (ASCII record
    // separator) prefixes every commit's `%h` so one commit's NUL-framed
    // --name-only file list can't be misread as the next commit's hash.
    // Mirror buildModeArgs' count clamp + ref/follow/pathspec so the gate
    // enumerates EXACTLY the commits the display run shows.
    const max = Math.min(
      typeof args.max_count === 'number' && Number.isInteger(args.max_count) && args.max_count > 0
        ? args.max_count
        : DEFAULT_LOG_COUNT,
      MAX_LOG_COUNT,
    );
    return [
      'log',
      '-n',
      String(max),
      '--name-only',
      '-z',
      '--format=%x1e%h',
      ...(args.follow === true ? ['--follow'] : []),
      ...(ref !== undefined ? [ref] : []),
      ...pathspec,
    ];
  }
  return null;
};

interface GitCapture {
  output: string;
  truncated: boolean;
  exit: number;
  stderr: string;
}

// The passthrough env for the sandbox wrapper: every key in spawnEnv
// EXCEPT TMPDIR. TMPDIR must NOT cross via passthrough — under `shared_tmp`
// (default on, Linux) the runner binds the session tmp dir to `/tmp` and
// FORCES `TMPDIR=/tmp` (the writable mountpoint), but it applies the
// caller's passthrough LAST (last-setenv-wins). So a host-path TMPDIR
// forwarded here would override `/tmp` and point git's temp writes at a
// path that isn't the writable bind inside the namespace (EROFS/ENOENT on
// a large-object spill). TMPDIR stays in `env`: correct for the
// unsandboxed spawn, and carried by the sandbox safe-list which the runner
// then overrides with `/tmp`. Exported pure so the exclusion is unit-
// testable without spawning git.
export const sandboxPassthroughEnv = (spawnEnv: Record<string, string>): Record<string, string> => {
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(spawnEnv)) {
    if (key !== 'TMPDIR') rest[key] = value;
  }
  return rest;
};

// Reap a git child we've ASKED to stop (truncation SIGTERM, or an abort
// that made Bun SIGTERM it), bounding the wait: race `proc.exited` against
// a grace window and escalate to an uncatchable SIGKILL if it overruns.
// Used only on the stop path — a normally running git is awaited with no
// deadline (it may legitimately take seconds), so this never kills healthy
// work. Without it, a child ignoring SIGTERM (reachable only on the
// unsandboxed path — bwrap's --die-with-parent reaps for us) would hang
// `await proc.exited`, and invoke-tool awaits execute() with no timeout.
const reapWithGrace = async (proc: ReturnType<typeof Bun.spawn>): Promise<number> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graced = new Promise<'grace'>((res) => {
    timer = setTimeout(() => res('grace'), REAP_GRACE_MS);
  });
  const winner = await Promise.race([proc.exited.then(() => 'exited' as const), graced]);
  if (winner === 'grace') {
    try {
      proc.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  const code = await proc.exited;
  if (timer !== undefined) clearTimeout(timer);
  return code;
};

// Run one hardened git invocation and capture stdout (byte-capped) +
// exit + stderr. Returns a ToolError for spawn/stream failures; the
// caller inspects exit/stderr for command-level errors. Shared by the
// content pre-flight, the repo-root probe, and the main run.
const captureGit = async (
  modeArgs: readonly string[],
  gitBin: string,
  spawnEnv: Record<string, string>,
  ctx: ToolContext,
  hardening: readonly string[] = HARDENING,
): Promise<GitCapture | ToolError> => {
  const innerArgv = [gitBin, ...hardening, ...modeArgs];
  const spawnArgv = maybeWrapSandboxArgv({
    ...(ctx.sandboxProfile !== undefined ? { profile: ctx.sandboxProfile } : {}),
    cwd: ctx.cwd,
    innerArgv,
    // Under a sandbox profile the inner git runs after bwrap's
    // `--clearenv`, so the outer `Bun.spawn({ env })` never reaches it
    // and the `GIT_*` guards (GIT_CONFIG_GLOBAL=/dev/null, NOSYSTEM,
    // OPTIONAL_LOCKS, LITERAL_PATHSPECS, PAGER, TERMINAL_PROMPT) would
    // be silently absent — the whole config-hardening of this file
    // gone whenever sandboxing is on. They are NOT in SANDBOX_SAFE_ENV
    // _VARS, so thread them through `passthroughEnv` (emitted as
    // `--setenv` past the clearenv boundary); `env` seeds the safe-list
    // from our controlled env rather than `process.env`. TMPDIR is
    // dropped from the passthrough (see sandboxPassthroughEnv) so it can't
    // override the runner's forced `TMPDIR=/tmp` under shared_tmp.
    env: spawnEnv,
    passthroughEnv: sandboxPassthroughEnv(spawnEnv),
    ...(ctx.sandboxTmpdir !== undefined ? { tmpdir: ctx.sandboxTmpdir } : {}),
    failClosed: ctx.sandboxBootTool !== undefined,
  });

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(spawnArgv, {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: ctx.cwd,
      env: spawnEnv,
      // biome-ignore lint/suspicious/noExplicitAny: Bun's spawn typing for `signal` is too narrow
      ...({ signal: ctx.signal } as any),
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('ENOENT')) {
      return toolError(ERROR_CODES.gitMissing, 'git not found in PATH', {
        hint: 'Install git to use the git tool.',
      });
    }
    return toolError(ERROR_CODES.gitFailed, `failed to spawn git: ${msg}`);
  }

  let output = '';
  let bytes = 0;
  let truncated = false;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes >= OUTPUT_CAP_BYTES) {
        const remaining = OUTPUT_CAP_BYTES - (bytes - chunk.byteLength);
        output += decoder.decode(chunk.subarray(0, Math.max(0, remaining)), { stream: true });
        truncated = true;
        try {
          proc.kill('SIGTERM');
        } catch {
          // already exited
        }
        break;
      }
      output += decoder.decode(chunk, { stream: true });
    }
  } catch (e) {
    return toolError(ERROR_CODES.gitFailed, `git stream failed: ${(e as Error).message}`);
  }

  // If we asked the child to stop (truncation kill above, or an abort that
  // made Bun SIGTERM it), reap with a SIGKILL-escalating grace so a
  // SIGTERM-ignoring child can't hang `await proc.exited`. A normal
  // completion takes neither branch's deadline — it's awaited directly.
  const stopping = truncated || ctx.signal.aborted;
  const exit = stopping ? await reapWithGrace(proc) : await proc.exited;
  // A mid-stream abort is silent: Bun SIGTERMs the child and closes stdout
  // cleanly, so the `for await` ends WITHOUT throwing and `proc.exited`
  // resolves to 143 (128+SIGTERM). Without this check that 143 would fall
  // through to the caller's `exit !== 0` branch and surface as a spurious
  // `git.failed` ("git exited 143") instead of a clean `aborted`. Catch it
  // here so every captureGit caller (filter enum, preflight, main run)
  // reports cancellation correctly.
  if (ctx.signal.aborted) {
    return toolError(ERROR_CODES.aborted, 'git aborted mid-run', { retryable: true });
  }
  const stderr = truncated
    ? ''
    : (await new Response(proc.stderr as ReadableStream<Uint8Array>).text()).trim();
  return { output, truncated, exit, stderr };
};

// Worktree-comparing commands (diff/status and the --name-only
// pre-flight) run the `.gitattributes`-bound `clean`/`process` FILTER
// to convert worktree content to repo form — and that filter is a
// repo-config-backed COMMAND, i.e. attacker-controlled code in an
// untrusted repo. Neither `--no-textconv` (text-conversion only) nor
// any wildcard config disables it, so this read-only tool would run
// repo code before the content gate even sees the file. There is no
// name-agnostic switch, so enumerate the configured filter drivers and
// pin each clean/smudge/process to empty (git then treats them as
// pass-through — no exec). The `git config` read itself runs no filter.
//
// Pinning the command to empty is NOT inert for a repo with a real
// clean/smudge filter (Git LFS being the common case). With the filter
// neutralized git cannot convert the worktree file to its repo form, so a
// worktree comparison (diff/status) measures the RAW worktree bytes
// against the CLEANED blob already in the index. They differ by
// construction: an unchanged LFS file then reports as MODIFIED and
// `git diff` emits a bogus pointer-vs-content hunk. Pass-through here
// silently CORRUPTS the working-tree result.
//
// So rather than accept that (an earlier version pinned `required=false`
// to swallow the error and take the corrupt passthrough), we FORCE
// `filter.<d>.required=true` for every disabled driver. git then treats
// the empty clean as fatal and exits 128 ("clean filter '<d>' failed")
// the moment a worktree comparison would touch a filter-bound file —
// fail-closed instead of corrupt. The main-run error mapping translates
// that exit into an actionable refusal. This holds for ALL configured
// drivers, not just LFS: a custom filter that did not set `required`
// would otherwise pass-through-corrupt just the same. Forcing required
// changes ONLY error handling (the empty command already guarantees no
// exec), and it bites ONLY worktree-comparing modes — show/log/blame/
// ls_files/show_file never run a clean filter, and a path-scoped
// diff/status of unfiltered files still works on an LFS repo.
//
// Returns the extra `-c …` flags to prepend to subsequent runs, OR `null`
// when the enumeration could not be trusted to be COMPLETE — a truncated
// key list (a hostile repo with > a capful of filter entries could push
// the active driver past the cap) or an unexpected read failure. The
// caller MUST fail closed on null: a partial pin leaves an undisabled
// clean/process command that a later worktree diff runs.
const filterDisableFlags = async (
  gitBin: string,
  spawnEnv: Record<string, string>,
  ctx: ToolContext,
): Promise<string[] | null> => {
  const cap = await captureGit(
    ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'],
    gitBin,
    spawnEnv,
    ctx,
  );
  if (isToolError(cap)) {
    // git-missing surfaces cleanly on the main run (don't mask it with a
    // filter message); any other spawn/stream failure is unexpected →
    // we cannot verify the filter set, so fail closed.
    return cap.error_code === ERROR_CODES.gitMissing ? [] : null;
  }
  // Truncation is the exploitable case: the remaining (unseen) keys may
  // include the ACTIVE driver, which would then run unpinned. exit 0
  // (matches) / 1 (no match) / 128 (not a repo) all yield a COMPLETE
  // key set (empty when none) as long as it wasn't truncated.
  if (cap.truncated) return null;
  const flags: string[] = [];
  const drivers = new Set<string>();
  for (const key of cap.output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    flags.push('-c', `${key}=`);
    // Derive the driver name from `filter.<name>.<clean|smudge|process>`.
    // `<name>` is a case-sensitive subsection that may itself contain dots
    // (`filter.my.driver.clean`); strip the `filter.` prefix and the known
    // suffix. The regex anchored the match, so both are present.
    const name = key.slice('filter.'.length).replace(/\.(clean|smudge|process)$/, '');
    if (name.length > 0) drivers.add(name);
  }
  for (const name of drivers) {
    flags.push('-c', `filter.${name}.required=true`);
  }
  return flags;
};

// Resolve the repo root. Both gates resolve git's repo-root-relative
// output (content `--name-only`, status `-z`, ls_files `--full-name`)
// against it. Returns null when it cannot be determined; both callers
// FAIL CLOSED on null rather than fall back to cwd (a cwd fallback would
// double the prefix for a subdir cwd and mis-gate root-relative names).
const resolveRepoRoot = async (
  gitBin: string,
  spawnEnv: Record<string, string>,
  ctx: ToolContext,
  hardening: readonly string[],
): Promise<string | null> => {
  const rootCap = await captureGit(
    ['rev-parse', '--show-toplevel'],
    gitBin,
    spawnEnv,
    ctx,
    hardening,
  );
  if (isToolError(rootCap) || rootCap.exit !== 0) return null;
  const root = rootCap.output.trim();
  return root.length > 0 ? root : null;
};

// Synthetic descendant appended to a collapsed untracked-directory record
// to test whether reading INTO the subtree is denied (mirrors the
// permission engine's own search-root probe of the same name; this glob
// matches dotfiles under `**`, so it correctly trips a `dir/**` deny).
const UNTRACKED_DIR_PROBE = '.forja-check';

// Extract the repo-root-relative path from one NUL-framed metadata
// record. ls_files (`--full-name`): the record IS the path. status
// (`--short -z`): the status field is two columns + a space, so the path
// starts at index 3; the `## …` branch header carries no path. Returns
// null for records that carry no path (kept verbatim in the output).
const metadataRecordPath = (mode: GitMode, record: string): string | null => {
  if (mode === 'ls_files') return record.length > 0 ? record : null;
  // status: keep the branch header (and any other non-path line) as-is.
  if (record.startsWith('##')) return null;
  return record.length > 3 ? record.slice(3) : null;
};

// Filter a path-emitting metadata mode's captured output: drop every
// record whose path the policy denies reading, then re-render the kept
// records as newline-separated lines (the raw capture is `-z` framed).
// status (`-z`) and ls_files (`--full-name`) BOTH emit REPO-ROOT-relative
// names, so each is resolved against the repo root — NOT ctx.cwd. (status
// `-z` is always root-relative regardless of status.relativePaths, so a
// cwd resolution would double the prefix from a subdir and mis-gate.) The
// `rev-parse` is LAZY + fail-closed: skipped entirely when no record
// carries a path (a clean `status` is just the `## branch` header; an
// empty `ls_files` is nothing), so the common case stays spawn-free;
// taken only when there are real entries to gate, and on failure the
// listing is refused rather than mis-resolved. Truncation is SAFE to
// filter: only the captured (gated) prefix is shown, and the trailing
// PARTIAL record is dropped.
const filterMetadataOutput = async (
  mode: GitMode,
  capture: GitCapture,
  gitBin: string,
  spawnEnv: Record<string, string>,
  ctx: ToolContext,
  hardening: readonly string[],
): Promise<string | ToolError> => {
  if (capture.output.length === 0) return '';
  // `-z` NUL-terminates every record. A complete capture ends in NUL, so
  // splitting yields a trailing '' we discard. A capture truncated
  // mid-record leaves a trailing PARTIAL path we can neither render nor
  // gate — `pop()` drops it, so an incomplete final name is never shown.
  const parts = capture.output.split('\0');
  parts.pop();
  const records = parts.filter((r) => r.length > 0);
  // Only resolve the repo root when at least one record carries a path to
  // gate — keeps a clean `status` (header only) / empty `ls_files`
  // spawn-free.
  if (!records.some((r) => metadataRecordPath(mode, r) !== null)) {
    return records.join('\n');
  }
  const repoRoot = await resolveRepoRoot(gitBin, spawnEnv, ctx, hardening);
  if (repoRoot === null) {
    return toolError(
      ERROR_CODES.gitDenied,
      `cannot resolve the repo root to policy-check the ${mode} listing; refusing rather than risk emitting a denied path`,
      { details: { repo_root: 'unresolved' } },
    );
  }
  const kept: string[] = [];
  let hidden = 0;
  for (const record of records) {
    const relPath = metadataRecordPath(mode, record);
    if (relPath === null) {
      kept.push(record); // header / pathless — no name to gate
      continue;
    }
    const abs = resolve(repoRoot, relPath);
    // A `git status -u normal` UNTRACKED DIRECTORY collapses into ONE record
    // with a trailing slash (`?? secrets/`) instead of listing its files.
    // The literal check catches a bare-dir deny, but a subtree glob
    // (deny_paths: ['secrets/**']) does NOT match the directory path itself
    // — so for a trailing-slash record ALSO gate a synthetic descendant,
    // dropping it when reading INTO the subtree is denied. Otherwise the
    // denied subtree's existence leaks through the collapsed name.
    const readable =
      ctx.permissions.canReadPath(abs) &&
      (!relPath.endsWith('/') || ctx.permissions.canReadPath(resolve(abs, UNTRACKED_DIR_PROBE)));
    if (readable) {
      kept.push(record);
    } else {
      hidden++; // denied → dropped
    }
  }
  const body = kept.join('\n');
  // Don't let a silently-shortened listing read as "those files are clean /
  // absent" — a `git status` that drops entries without a word is a trust
  // bug. Append a framework notice (the `[forja: …]` convention the harness
  // already uses) so both the model (full JSON result) and the user (raw
  // display of `output`) see that the view is policy-filtered.
  if (hidden === 0) return body;
  const notice = `[forja: ${hidden} path(s) hidden by policy]`;
  return body.length > 0 ? `${body}\n${notice}` : notice;
};

// `log` carries no file paths in its OUTPUT, yet a pathless / parent-scoped log
// still reports commit subjects/authors/hashes for commits that touched ONLY a
// policy-denied subtree (secrets/, the sensitive .env floor) — leaking that
// history the way an ungated `status`/`ls_files` leaks names. The content +
// metadata gates miss it (there is no path in the log LINE to drop). So
// post-filter: enumerate each shown commit's touched files via a `--name-only`
// pre-flight and drop the line of any commit whose files are ALL denied. A
// commit touching >=1 readable file is KEPT — its line is legitimately in scope
// even if its subject mentions denied work (a subject cannot be partially
// redacted). A commit with NO files (merge / empty) exposes no path, so it
// stays. `canReadPath` already folds in BOTH the parent read policy and the
// subagent's tool_restrictions deny (restrictions.ts), so one gate covers both.
const filterLogOutput = async (
  capture: GitCapture,
  args: GitInput,
  gitBin: string,
  spawnEnv: Record<string, string>,
  ctx: ToolContext,
  hardening: readonly string[],
): Promise<string | ToolError> => {
  if (capture.output.length === 0) return '';
  const gateArgs = nameOnlyArgs(args);
  if (gateArgs === null) return capture.output; // defensive: not a gateable mode
  const gate = await captureGit(gateArgs, gitBin, spawnEnv, ctx, hardening);
  if (isToolError(gate)) {
    // Abort surfaces as-is; any other failure means we cannot tell which
    // commits touched denied paths — refuse rather than emit an ungated log.
    if (gate.error_code === ERROR_CODES.aborted) return gate;
    return toolError(
      ERROR_CODES.gitDenied,
      'cannot enumerate per-commit paths to policy-check the log; refusing rather than risk leaking a denied-subtree commit',
      { details: { log_gate: 'failed' } },
    );
  }
  if (gate.truncated) {
    // A truncated enumeration leaves later commits' file lists unknown — any
    // could be denied-only. Fail closed; narrow `max_count` or scope a path.
    return toolError(
      ERROR_CODES.gitDenied,
      'per-commit path enumeration for the log exceeded the capture cap; lower max_count or pass a path so the policy filter can apply',
      { details: { log_gate: 'truncated' } },
    );
  }
  // Parse the `%x1e`-delimited gate stream. Each block is `<hash>` optionally
  // followed by `\n<file>\0<file>\0…` (the -z --name-only list); a fileless
  // commit (merge / empty) is just `<hash>` with the -z NUL terminator.
  const withFiles: { hash: string; files: string[] }[] = [];
  for (const block of gate.output.split('\x1e').slice(1)) {
    const nl = block.indexOf('\n');
    if (nl === -1) continue; // no files → nothing to deny
    // -z terminates the `%h` format output with a NUL before the --name-only
    // newline, so the pre-newline slice is `<hash>\0`; strip that terminator so
    // the hash matches the clean `%h` the display run printed.
    const hash = block.slice(0, nl).replace(/\0+$/, '');
    const files = block
      .slice(nl + 1)
      .split('\0')
      .filter((f) => f.length > 0);
    if (hash.length > 0 && files.length > 0) withFiles.push({ hash, files });
  }
  if (withFiles.length === 0) return capture.output; // no commit carries a path
  const repoRoot = await resolveRepoRoot(gitBin, spawnEnv, ctx, hardening);
  if (repoRoot === null) {
    return toolError(
      ERROR_CODES.gitDenied,
      'cannot resolve the repo root to policy-check the log; refusing rather than risk leaking a denied-subtree commit',
      { details: { repo_root: 'unresolved' } },
    );
  }
  const denied = new Set<string>();
  for (const { hash, files } of withFiles) {
    if (files.every((f) => !ctx.permissions.canReadPath(resolve(repoRoot, f)))) {
      denied.add(hash);
    }
  }
  if (denied.size === 0) return capture.output;
  // Drop the display line of every denied-only commit. The display format is
  // `%h …`, so the first whitespace-delimited token is the short hash the gate
  // (`%h`, same repo + abbrev) produced.
  const kept: string[] = [];
  let hidden = 0;
  for (const line of capture.output.split('\n')) {
    const hash = line.split(' ', 1)[0];
    if (hash !== undefined && denied.has(hash)) {
      hidden++;
    } else {
      kept.push(line);
    }
  }
  if (hidden === 0) return capture.output;
  const body = kept.join('\n');
  const notice = `[forja: ${hidden} commit(s) hidden by policy]`;
  return body.length > 0 ? `${body}\n${notice}` : notice;
};

// For content modes, pre-flight `--name-only`, resolve each emitted
// file to an absolute path, and refuse (fail-closed) if ANY would not
// pass a `read_file` policy check — this is what stops pathless/dir
// `git diff`/`show` from leaking the CONTENT of denied files (.env,
// secrets/) the way gating only the search root would. Returns a
// ToolError to surface, or null to proceed with the real run.
const gateContentFiles = async (
  args: GitInput,
  gitBin: string,
  spawnEnv: Record<string, string>,
  ctx: ToolContext,
  hardening: readonly string[],
): Promise<ToolError | null> => {
  const noArgs = nameOnlyArgs(args);
  if (noArgs === null) return null;
  const pre = await captureGit(noArgs, gitBin, spawnEnv, ctx, hardening);
  if (isToolError(pre)) return null;
  // Truncation FIRST: an overflowed file list means we cannot see every
  // file the real command would emit → fail closed rather than gate a
  // partial set and leak the unseen tail. This check must precede the
  // exit-code check below, because truncation kills git with SIGTERM
  // (a non-zero exit) — which would otherwise be read as a benign
  // command failure and wrongly let the run proceed.
  if (pre.truncated) {
    return toolError(
      ERROR_CODES.gitDenied,
      `git ${args.mode} touches too many files to policy-check safely (file list truncated); scope to a specific path (e.g. path: "src/...") and retry`,
      { details: { truncated: true } },
    );
  }
  // A genuinely failed pre-flight means the real (superset) command
  // fails too → no content emitted, no leak. Let the main run surface
  // the error.
  if (pre.exit !== 0) return null;
  // `-z` frames each path with a trailing NUL (raw bytes, no quoting).
  const files = pre.output.split('\0').filter((s) => s.length > 0);
  if (files.length === 0) return null;
  // git --name-only paths are repo-root-relative; resolve against the
  // repo root so the policy check sees the same absolute path read_file
  // would. FAIL CLOSED if the root can't be resolved: a cwd fallback would
  // mis-resolve root-relative names from a subdir (doubling the prefix) and
  // could let a denied file slip the gate. The pre-flight already
  // succeeded, so we ARE in a worktree — an unresolvable root here is
  // anomalous, and refusing is safe.
  const repoRoot = await resolveRepoRoot(gitBin, spawnEnv, ctx, hardening);
  if (repoRoot === null) {
    return toolError(
      ERROR_CODES.gitDenied,
      `git ${args.mode}: cannot resolve the repo root to policy-check the file list; refusing rather than risk emitting a denied file`,
      { details: { repo_root: 'unresolved' } },
    );
  }
  const denied = files.filter((f) => !ctx.permissions.canReadPath(resolve(repoRoot, f)));
  if (denied.length === 0) return null;
  return toolError(
    ERROR_CODES.gitDenied,
    `git ${args.mode} would emit content from ${denied.length} of ${files.length} file(s) the policy denies reading; scope to a specific allowed path (e.g. path: "src/...") and retry`,
    { details: { denied_count: denied.length, total: files.length } },
  );
};

// Shell-quote a token for the human-facing `command` field so it can be
// copy-pasted. Bare-word safe chars pass through; anything else is
// single-quoted with embedded quotes escaped.
const shellQuote = (s: string): string =>
  /^[A-Za-z0-9_./:@^~=,+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

// A clean, copy-pasteable approximation of what the caller asked for — the
// LOGICAL command, not the hardened argv. The real run carries internal
// flags the user never wrote (`-z`, `--no-renames`, `--no-ext-diff`,
// `--no-textconv`, the `--pretty`/`--date` format, the `^{commit}` peel)
// and its output is additionally policy-filtered, so the raw argv is
// neither runnable (unquoted `--pretty=format:%h %ad …` splits on spaces)
// nor faithful to `output`. This keeps the semantic flags (ref, pathspec,
// `--staged`, `--follow`, `-n`) and drops the framing — what a human would
// type to get a similar view. The pathspec is shown (`-- <path>` or the
// pathless `-- .`) so the cwd-scoping is visible rather than surprising.
const representativeCommand = (args: GitInput): string => {
  const parts: string[] = ['git'];
  const ref = typeof args.ref === 'string' ? shellQuote(args.ref) : undefined;
  const tail = typeof args.path === 'string' ? ['--', shellQuote(args.path)] : ['--', '.'];
  switch (args.mode) {
    case 'log':
      parts.push('log');
      if (typeof args.max_count === 'number' && Number.isInteger(args.max_count)) {
        parts.push('-n', String(Math.min(args.max_count, MAX_LOG_COUNT)));
      }
      if (args.follow === true) parts.push('--follow');
      if (ref !== undefined) parts.push(ref);
      parts.push(...tail);
      break;
    case 'show':
      parts.push('show', ref ?? 'HEAD', ...tail);
      break;
    case 'show_file':
      parts.push(
        'show',
        shellQuote(
          `${typeof args.ref === 'string' ? args.ref : 'HEAD'}:./${typeof args.path === 'string' ? args.path : ''}`,
        ),
      );
      break;
    case 'diff':
      parts.push('diff');
      if (args.stat === true) parts.push('--stat');
      if (args.staged === true) parts.push('--staged');
      if (ref !== undefined) parts.push(ref);
      parts.push(...tail);
      break;
    case 'blame':
      parts.push('blame');
      if (ref !== undefined) parts.push(ref);
      // blame always has a path (buildModeArgs rejects it otherwise).
      parts.push('--', shellQuote(typeof args.path === 'string' ? args.path : ''));
      break;
    case 'status':
      parts.push('status', '--short', '--branch', ...tail);
      break;
    case 'ls_files':
      parts.push('ls-files', ...tail);
      break;
  }
  return parts.join(' ');
};

export const gitTool: Tool<GitInput, GitOutput> = {
  name: 'git',
  description:
    'Read-only git: inspect history and working-tree state. Pick a `mode` (log/show/show_file/diff/blame/status/ls_files) and typed params — never raw flags. `diff`/`status` reflect the LIVE working tree (uncommitted changes included). Pathless modes are scoped to the current directory subtree; renames show as delete+add; output is capped (~256KB — when `truncated` is true, narrow with `path` or use `stat`). Cannot commit, push, or mutate. Parallel-safe.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['log', 'show', 'show_file', 'diff', 'blame', 'status', 'ls_files'],
        description:
          "log: commit history; show: a commit + its diff (commit-ish ref only — not a file blob); show_file: the CONTENT of one file at a revision — put the file in `path` and the BARE revision in `ref` (e.g. HEAD/tag/SHA, default HEAD); do NOT use git's `rev:path` form; diff: working-tree or staged changes (vs ref if given); blame: per-line last-change (requires path); status: working-tree state; ls_files: tracked files.",
      },
      path: {
        type: 'string',
        description: 'Repo-relative file/dir to scope to. Required for blame and show_file.',
      },
      ref: {
        type: 'string',
        description:
          "Commit/branch/tag, or A..B range for diff. A BARE revision only — never git's `rev:path` form (pass the file in `path`); show_file defaults it to HEAD. Read-only; never a flag.",
      },
      max_count: { type: 'integer', minimum: 1, description: 'log: max commits (default 50).' },
      staged: {
        type: 'boolean',
        description: 'diff: show staged (index) changes instead of unstaged.',
      },
      follow: { type: 'boolean', description: 'log: follow a single file across renames.' },
      stat: {
        type: 'boolean',
        description:
          'diff only: emit a diffstat (changed files + churn) instead of the full patch.',
      },
    },
    required: ['mode'],
  },
  metadata: {
    category: 'fs.read',
    // Deferred at EVERY window (AGENTIC_CLI §7.6 / CONTEXT_TUNING §2.2): off the
    // base surface entirely. No capability loss — `bash` (always on the wire) runs
    // `git` directly; `tool_search` re-reveals this hardened, no-passthrough tool
    // when its tighter gating earns the schema.
    deferred: true,
    writes: false,
    escapesCwd: false,
    idempotent: true,
    parallel_safe: true,
    display: 'raw',
    cost: { latency_ms_typical: 60 },
  },
  async execute(args, ctx): Promise<ToolResult<GitOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before git', { retryable: true });
    }
    if (typeof args.mode !== 'string' || !GIT_MODES.has(args.mode)) {
      return toolError(
        ERROR_CODES.invalidArg,
        `mode must be one of log/show/show_file/diff/blame/status/ls_files (got '${String(args.mode)}')`,
      );
    }

    const built = buildModeArgs(args);
    if ('error' in built) {
      return toolError(ERROR_CODES.invalidArg, built.error);
    }
    const modeArgs = built.args;
    // Pin git to an absolute path resolved via the canonical SAFE_PATH
    // (anti mid-session PATH-shadowing) and pair it with `safeGitEnv()`
    // — the same hardened binary+env the worktree/checkpoint git
    // callers use. Resolve binary FIRST so the env carries the right
    // PATH (see git-binary.ts ordering note).
    const { git: gitBin, env: gitEnv } = await getGitBinaryWithEnv();
    const spawnEnv: Record<string, string> = {
      ...gitEnv,
      ...EXTRA_GIT_ENV,
      ...(ctx.sandboxTmpdir !== undefined ? { TMPDIR: ctx.sandboxTmpdir } : {}),
    };

    // Neutralize any repo-configured clean/smudge/process filter before a
    // worktree-comparing command runs (the `.gitattributes`-bound clean filter
    // is a repo-config-backed command = attacker code in an untrusted repo).
    // ONLY diff (unstaged) / status / blame read worktree CONTENT and so can
    // fire that filter (verified: each exits 128 against an empty required
    // filter); log / ls_files / show / show_file / `diff --staged` read only
    // committed objects or the index — never the worktree — so they run no
    // filter at all. Limit the FAIL-CLOSED enumeration to that worktree set:
    // running it unconditionally let a hostile/huge filter config overflow the
    // 256 KiB capture cap and refuse a SAFE history/blob read (log, show_file,
    // …) that never touches a filter. Extends the hardening prefix for the run.
    const worktreeComparing =
      args.mode === 'status' ||
      args.mode === 'blame' ||
      (args.mode === 'diff' && args.staged !== true);
    const filterFlags = worktreeComparing ? await filterDisableFlags(gitBin, spawnEnv, ctx) : [];
    if (filterFlags === null) {
      // An abort during the enumeration also collapses to null (captureGit
      // returns the aborted error, which filterDisableFlags maps to null);
      // surface the cancellation rather than the filter-unverified refusal.
      if (ctx.signal.aborted) {
        return toolError(ERROR_CODES.aborted, 'git aborted mid-run', { retryable: true });
      }
      return toolError(
        ERROR_CODES.gitDenied,
        'cannot verify the repo’s git clean/smudge/process filters are disabled (filter-config enumeration was truncated or failed) — refusing rather than risk running a repo-configured filter command',
        { details: { filter_enumeration: 'unverified' } },
      );
    }
    const hardening = filterFlags.length > 0 ? [...HARDENING, ...filterFlags] : HARDENING;

    // Content-emitting modes: refuse if the command would emit any file
    // the policy denies reading (prevents the diff/show body from
    // leaking denied descendants under an allowed root).
    if (CONTENT_MODES.has(args.mode)) {
      const denied = await gateContentFiles(args, gitBin, spawnEnv, ctx, hardening);
      if (denied !== null) return denied;
    }

    // show_file emits ONE file's content at a revision; gate that single
    // path the way read_file would. The `./` form in buildModeArgs makes
    // git read resolve(cwd, path), so gate the same absolute path. The
    // engine also gates it (rootArg: 'path'), but the tool re-checks —
    // never rely solely on the caller's gate.
    if (args.mode === 'show_file' && typeof args.path === 'string') {
      if (!ctx.permissions.canReadPath(resolve(ctx.cwd, args.path))) {
        return toolError(
          ERROR_CODES.gitDenied,
          `git show_file: policy denies reading '${args.path}'`,
          { details: { path: args.path } },
        );
      }
    }

    // The gate above ran one or two git sub-processes; honor an abort
    // that landed in the meantime before spawning the (potentially
    // expensive) main run.
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before git', { retryable: true });
    }

    const cap = await captureGit(modeArgs, gitBin, spawnEnv, ctx, hardening);
    if (isToolError(cap)) return cap;
    const { output, truncated, exit } = cap;
    const commandLine = representativeCommand(args);

    // SIGTERM-after-truncation exits non-zero; that is expected, not a
    // failure. Otherwise a non-zero exit is a real git error.
    if (!truncated && exit !== 0) {
      if (/not a git repository/i.test(cap.stderr)) {
        return toolError(ERROR_CODES.gitNotRepo, 'cwd is not inside a git repository', {
          details: { command: commandLine },
        });
      }
      // `show` peels its ref to `^{commit}`, so a blob/tree ref fails with a
      // raw plumbing error ("expected commit type" / "can't be peeled").
      // Translate it: the model passed a non-commit ref and needs to know
      // this tool shows commits, not file blobs.
      if (
        args.mode === 'show' &&
        /expected commit type|can't be peeled|dereferences to/i.test(cap.stderr)
      ) {
        return toolError(
          ERROR_CODES.invalidArg,
          `git show needs a commit-ish ref; '${args.ref ?? 'HEAD'}' resolves to a non-commit (blob/tree). This tool shows a commit and its diff, not a file blob — to read a file's contents use read_file, or pass a commit/branch/tag ref.`,
          { details: { command: commandLine } },
        );
      }
      // show_file uses `cat-file blob`, which fails closed on a non-file:
      // a directory/tree ("bad file") or a path absent at the revision
      // ("does not exist"). Translate the plumbing error to something the
      // model can act on.
      if (
        args.mode === 'show_file' &&
        /bad file|does not exist|not a valid object|exists, but not/i.test(cap.stderr)
      ) {
        return toolError(
          ERROR_CODES.invalidArg,
          `git show_file: '${args.path}' is not a readable file at '${args.ref ?? 'HEAD'}' — it may be a directory, or absent at that revision. show_file reads one file's content; pass a file path.`,
          { details: { command: commandLine } },
        );
      }
      // A worktree-comparing mode (diff/status) over a file bound to a
      // clean/smudge filter (Git LFS et al.) lands here: filterDisableFlags
      // neutralized the filter command AND forced required=true, so git
      // exits 128 instead of emitting the corrupt raw-worktree-vs-cleaned-
      // index comparison that pass-through would produce. Translate the
      // plumbing error into the actionable refusal — the tool will neither
      // run the repo's filter command nor fabricate a pass-through result.
      const cleanFilter = /(?:^|\n)fatal: (.+?): (?:clean|smudge) filter '([^']*)' failed/.exec(
        cap.stderr,
      );
      if (cleanFilter !== null) {
        const filteredPath = cleanFilter[1];
        const driver = cleanFilter[2];
        return toolError(
          ERROR_CODES.gitDenied,
          `${args.mode} touches '${filteredPath}', which this repo runs through the '${driver}' clean/smudge filter (e.g. Git LFS). This read-only tool disables repo-configured filter commands (they are attacker-controllable code in an untrusted repo) and refuses to emit the corrupt raw-vs-cleaned comparison that disabling them would otherwise produce — narrow \`path\` to unfiltered files, or read one file's stored content with show_file (it returns the committed blob, e.g. the LFS pointer).`,
          {
            details: { command: commandLine, filtered_path: filteredPath, filter_driver: driver },
          },
        );
      }
      return toolError(
        ERROR_CODES.gitFailed,
        `git exited ${exit}: ${cap.stderr || '(no stderr)'}`,
        {
          details: { exit_code: exit, command: commandLine },
        },
      );
    }

    // Path-emitting metadata modes: drop any emitted name the policy
    // denies reading before the listing is returned (closes the metadata
    // sibling of the content leak the gate above stops for diff/show).
    let finalOutput = output;
    if (PATH_METADATA_MODES.has(args.mode)) {
      const filtered = await filterMetadataOutput(args.mode, cap, gitBin, spawnEnv, ctx, hardening);
      if (isToolError(filtered)) return filtered;
      finalOutput = filtered;
    }
    // `log` carries no path in its output line, so drop the whole line for any
    // commit that touched ONLY denied paths (filterLogOutput re-enumerates via
    // --name-only) — otherwise a parent-scoped log leaks denied-subtree
    // subjects/authors that status/ls_files already filter.
    if (args.mode === 'log') {
      const filtered = await filterLogOutput(cap, args, gitBin, spawnEnv, ctx, hardening);
      if (isToolError(filtered)) return filtered;
      finalOutput = filtered;
    }

    return {
      mode: args.mode,
      command: commandLine,
      output: finalOutput,
      truncated,
      exit_code: exit,
    };
  },
};
