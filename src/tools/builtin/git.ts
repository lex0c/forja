import { maybeWrapSandboxArgv } from '../../permissions/index.ts';
import { scrubEnv } from '../../sanitize/env.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

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

const MODES: ReadonlySet<string> = new Set(['log', 'show', 'diff', 'blame', 'status', 'ls_files']);

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
// `core.fsmonitor` and hook execution are the two ways a hostile
// repo-local `.git/config` could get git to run an arbitrary program
// during an otherwise read-only command; both are disabled here.
const HARDENING: readonly string[] = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
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

  const pathspec = path !== undefined ? ['--', path] : [];

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
      return {
        args: ['show', '--no-ext-diff', '--no-textconv', ref ?? 'HEAD', ...pathspec],
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
      return { args: ['status', '--short', '--branch', ...pathspec] };
    case 'ls_files':
      return { args: ['ls-files', ...pathspec] };
    default:
      return { error: `unknown mode '${String(mode)}'` };
  }
};

// Env for the spawned git: scrubbed (no operator/provider secrets
// reach the subprocess — same contract as grep), plus a few
// read-only / non-interactive guards. `--no-pager` is already in the
// argv; `GIT_PAGER=cat` is belt-and-suspenders. Optional sandbox
// TMPDIR overlaid after the scrub, as elsewhere.
export const buildGitSpawnEnv = (sandboxTmpdir: string | undefined): Record<string, string> => ({
  ...scrubEnv(process.env),
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  ...(sandboxTmpdir !== undefined ? { TMPDIR: sandboxTmpdir } : {}),
});

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
    if (typeof args.mode !== 'string' || !MODES.has(args.mode)) {
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
    const innerArgv = ['git', ...HARDENING, ...modeArgs];

    const spawnArgv = maybeWrapSandboxArgv({
      ...(ctx.sandboxProfile !== undefined ? { profile: ctx.sandboxProfile } : {}),
      cwd: ctx.cwd,
      innerArgv,
      ...(ctx.sandboxTmpdir !== undefined ? { tmpdir: ctx.sandboxTmpdir } : {}),
      failClosed: ctx.sandboxBootTool !== undefined,
    });

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(spawnArgv, {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: ctx.cwd,
        env: buildGitSpawnEnv(ctx.sandboxTmpdir),
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

    // Stream stdout with a byte cap; kill git once the cap is hit so a
    // huge diff cannot blow up memory or the model's budget.
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
    const commandLine = `git ${modeArgs.join(' ')}`;

    // SIGTERM-after-truncation exits non-zero; that is expected, not a
    // failure. Otherwise a non-zero exit is a real git error.
    if (!truncated && exit !== 0) {
      const stderr = (await new Response(proc.stderr as ReadableStream<Uint8Array>).text()).trim();
      if (/not a git repository/i.test(stderr)) {
        return toolError(ERROR_CODES.gitNotRepo, 'cwd is not inside a git repository', {
          details: { command: commandLine },
        });
      }
      return toolError(ERROR_CODES.gitFailed, `git exited ${exit}: ${stderr || '(no stderr)'}`, {
        details: { exit_code: exit, command: commandLine },
      });
    }

    return {
      mode: args.mode,
      command: commandLine,
      output,
      truncated,
      exit_code: exit,
    };
  },
};
