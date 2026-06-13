import { resolve } from 'node:path';
import { maybeWrapSandboxArgv } from '../../permissions/index.ts';
import { getGitBinaryWithEnv } from '../../subagents/git-binary.ts';
import {
  ERROR_CODES,
  type Tool,
  type ToolContext,
  type ToolError,
  type ToolResult,
  isToolError,
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

export type GitMode = 'log' | 'show' | 'diff' | 'blame' | 'status' | 'ls_files';

export interface GitInput {
  mode: GitMode;
  path?: string;
  ref?: string;
  max_count?: number;
  staged?: boolean;
  follow?: boolean;
}

export interface GitOutput {
  mode: GitMode;
  command: string; // the meaningful `git <mode> …` line (hardening prefix elided)
  output: string;
  truncated: boolean;
  exit_code: number;
}

// The valid `mode` values. Exported so the `/perms why git` dry-check
// can tell a mode token (`status`) from a path argument.
export const GIT_MODES: ReadonlySet<string> = new Set([
  'log',
  'show',
  'diff',
  'blame',
  'status',
  'ls_files',
]);

const DEFAULT_LOG_COUNT = 50;
const MAX_LOG_COUNT = 1000;
// Hard cap on captured stdout. git `show`/`diff`/`blame` on a large
// file can run to MBs; we stream and stop here, flag `truncated`.
const OUTPUT_CAP_BYTES = 64 * 1024;

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
  const path = args.path;
  const ref = args.ref;

  if (path !== undefined) {
    const err = validatePath(path);
    if (err !== null) return { error: err };
  }
  if (ref !== undefined) {
    if (ref.length === 0) return { error: 'ref must be non-empty' };
    if (ref.startsWith('-')) return { error: "ref must not start with '-'" };
    if (!REF_RE.test(ref)) return { error: 'ref contains unsupported characters' };
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
      // in lockstep with nameOnlyArgs's show form.
      return {
        args: ['show', '--no-ext-diff', '--no-textconv', `${ref ?? 'HEAD'}^{commit}`, ...pathspec],
      };
    case 'diff':
      return {
        args: [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
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
      // Names stay cwd-relative (git's default) so the gate resolves them
      // against ctx.cwd with no extra `rev-parse` spawn; `-- .` already
      // confines the listing to the cwd subtree. The gate re-renders the
      // kept records as newline-separated lines.
      return { args: ['status', '--short', '--branch', '--no-renames', '-z', ...pathspec] };
    case 'ls_files':
      // `-z` frames each path for reliable, quoting-proof splitting. Names
      // stay cwd-relative (git's default — no `--full-name`) so the gate
      // resolves them against ctx.cwd without a `rev-parse` spawn.
      return { args: ['ls-files', '-z', ...pathspec] };
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
  return null;
};

interface GitCapture {
  output: string;
  truncated: boolean;
  exit: number;
  stderr: string;
}

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
    // from our controlled env rather than `process.env`.
    env: spawnEnv,
    passthroughEnv: spawnEnv,
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

  const exit = await proc.exited;
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
// Returns the extra `-c key=` flags to prepend to subsequent runs, OR
// `null` when the enumeration could not be trusted to be COMPLETE — a
// truncated key list (a hostile repo with > a capful of filter entries
// could push the active driver past the cap) or an unexpected read
// failure. The caller MUST fail closed on null: a partial pin leaves an
// undisabled clean/process command that a later worktree diff runs.
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
  for (const key of cap.output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    flags.push('-c', `${key}=`);
  }
  return flags;
};

// Resolve the repo root for the content gate, whose `--name-only` paths
// are repo-root-relative (git diff always reports root-relative). Returns
// null when it cannot be determined; the caller falls back to cwd.
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

// Extract the cwd-relative path from one NUL-framed metadata record.
// ls_files: the record IS the path. status (`--short -z`): the status
// field is two columns + a space, so the path starts at index 3; the
// `## …` branch header carries no path. Returns null for records that
// carry no path (kept verbatim in the output).
const metadataRecordPath = (mode: GitMode, record: string): string | null => {
  if (mode === 'ls_files') return record.length > 0 ? record : null;
  // status: keep the branch header (and any other non-path line) as-is.
  if (record.startsWith('##')) return null;
  return record.length > 3 ? record.slice(3) : null;
};

// Filter a path-emitting metadata mode's captured output: drop every
// record whose path the policy denies reading, then re-render the kept
// records as newline-separated lines (the raw capture is `-z` framed).
// No git sub-process: status/ls_files emit cwd-relative names (`-- .`
// confines them to the cwd subtree), so each resolves against ctx.cwd
// directly — no `rev-parse` spawn on this hot path. The only per-path
// cost is canReadPath (one realpathSync), bounded by the capture's 64 KiB
// cap (~hundreds of paths) regardless of repo size. Truncation is SAFE to
// filter: only the captured (gated) prefix is shown; the unseen tail past
// the cap is never emitted, and the trailing PARTIAL record is dropped.
const filterMetadataOutput = (mode: GitMode, capture: GitCapture, ctx: ToolContext): string => {
  if (capture.output.length === 0) return '';
  // `-z` NUL-terminates every record. A complete capture ends in NUL, so
  // splitting yields a trailing '' we discard. A capture truncated
  // mid-record leaves a trailing PARTIAL path we can neither render nor
  // gate — `pop()` drops it, so an incomplete final name is never shown.
  const parts = capture.output.split('\0');
  parts.pop();
  const kept: string[] = [];
  for (const record of parts) {
    if (record.length === 0) continue;
    const relPath = metadataRecordPath(mode, record);
    if (relPath === null) {
      kept.push(record); // header / pathless — no name to gate
      continue;
    }
    if (ctx.permissions.canReadPath(resolve(ctx.cwd, relPath))) {
      kept.push(record);
    }
    // denied → dropped
  }
  return kept.join('\n');
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
  // would. Fall back to cwd if rev-parse fails (the pre-flight already
  // succeeded, so we are inside a repo; the fallback is belt-and-braces).
  const repoRoot = (await resolveRepoRoot(gitBin, spawnEnv, ctx, hardening)) ?? ctx.cwd;
  const denied = files.filter((f) => !ctx.permissions.canReadPath(resolve(repoRoot, f)));
  if (denied.length === 0) return null;
  return toolError(
    ERROR_CODES.gitDenied,
    `git ${args.mode} would emit content from ${denied.length} of ${files.length} file(s) the policy denies reading; scope to a specific allowed path (e.g. path: "src/...") and retry`,
    { details: { denied_count: denied.length, total: files.length } },
  );
};

export const gitTool: Tool<GitInput, GitOutput> = {
  name: 'git',
  description:
    'Read-only git: inspect history and working-tree state. Pick a `mode` (log/show/diff/blame/status/ls_files) and typed params — never raw flags. `diff`/`status` reflect the LIVE working tree (uncommitted changes included). Cannot commit, push, or mutate. Parallel-safe.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['log', 'show', 'diff', 'blame', 'status', 'ls_files'],
        description:
          'log: commit history; show: a commit + its diff; diff: working-tree or staged changes (vs ref if given); blame: per-line last-change (requires path); status: working-tree state; ls_files: tracked files.',
      },
      path: {
        type: 'string',
        description: 'Repo-relative file/dir to scope to. Required for blame.',
      },
      ref: {
        type: 'string',
        description: 'Commit/branch/tag (or A..B range for diff). Read-only; never a flag.',
      },
      max_count: { type: 'integer', minimum: 1, description: 'log: max commits (default 50).' },
      staged: {
        type: 'boolean',
        description: 'diff: show staged (index) changes instead of unstaged.',
      },
      follow: { type: 'boolean', description: 'log: follow a single file across renames.' },
    },
    required: ['mode'],
  },
  metadata: {
    category: 'fs.read',
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
        `mode must be one of log/show/diff/blame/status/ls_files (got '${String(args.mode)}')`,
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

    // Neutralize any repo-configured clean/smudge/process filter before
    // any worktree-comparing command runs (diff/status + the gate's
    // pre-flight clean the worktree, executing the filter command).
    // Extend the hardening prefix used by every subsequent run.
    const filterFlags = await filterDisableFlags(gitBin, spawnEnv, ctx);
    if (filterFlags === null) {
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

    // The gate above ran one or two git sub-processes; honor an abort
    // that landed in the meantime before spawning the (potentially
    // expensive) main run.
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before git', { retryable: true });
    }

    const cap = await captureGit(modeArgs, gitBin, spawnEnv, ctx, hardening);
    if (isToolError(cap)) return cap;
    const { output, truncated, exit } = cap;
    const commandLine = `git ${modeArgs.join(' ')}`;

    // SIGTERM-after-truncation exits non-zero; that is expected, not a
    // failure. Otherwise a non-zero exit is a real git error.
    if (!truncated && exit !== 0) {
      if (/not a git repository/i.test(cap.stderr)) {
        return toolError(ERROR_CODES.gitNotRepo, 'cwd is not inside a git repository', {
          details: { command: commandLine },
        });
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
    const finalOutput = PATH_METADATA_MODES.has(args.mode)
      ? filterMetadataOutput(args.mode, cap, ctx)
      : output;

    return {
      mode: args.mode,
      command: commandLine,
      output: finalOutput,
      truncated,
      exit_code: exit,
    };
  },
};
