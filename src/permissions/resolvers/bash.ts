// bash resolver. Per PERMISSION_ENGINE.md §5.2 the production-grade
// implementation walks a tree-sitter-bash AST and extracts (cmd,
// args, redirections, env_vars) per pipeline node. Tree-sitter is
// not wired in this slice — it's its own slice that also closes the
// bash-side protected-path gap from slice 1.
//
// Until then, this token-based resolver:
//
//   1. Detects compound/dynamic shapes via `containsShellInjection`
//      (the slice-1 heuristic). Compound → Conservative (low confidence,
//      wide capability set). Dynamic eval shapes → Refuse.
//   2. For "simple" commands (no injection metachars), extracts the
//      first token and looks it up in a hardcoded command table.
//      A hit produces specific capabilities with high confidence
//      ("ls -la" → read-fs(cwd)). A miss produces Conservative
//      (capabilities reflect "we don't know" — exec:shell + cwd
//      read-fs + cwd write-fs + open egress).
//
// The token-based path catches every shape the model-driven agent
// commonly emits (`git status`, `npm install`, `rm -rf X`, `curl
// URL`) without needing the parser. Anything beyond that defaults
// conservative and the operator sees the modal once; session-allow
// then mutes it for repeat shapes.

import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { Capability } from '../capabilities.ts';
import { deleteFs, exec, gitWrite, netEgress, readFs, writeFs } from '../capabilities.ts';
import { containsShellInjection } from '../matcher.ts';
import {
  type Resolver,
  type ResolverContext,
  type ResolverResult,
  registerResolver,
} from './registry.ts';

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Resolve a path-shaped arg to absolute form, mirroring the FS
// resolvers. Bash commands often carry relative paths (`rm ./x`,
// `cat ../foo`), and emitting capabilities that pin the textual
// absolute form keeps the audit row faithful to what'll touch the
// filesystem.
const resolveArg = (path: string, ctx: ResolverContext): string =>
  isAbsolute(path) ? path : resolvePath(ctx.cwd, path);

// Strip leading flags from a token list. `rm -rf /tmp/x` → ['/tmp/x'].
// Conservative: anything starting with `-` is treated as a flag,
// even custom long options. Empty list when only flags or empty.
const stripFlags = (tokens: readonly string[]): string[] =>
  tokens.filter((t) => !t.startsWith('-'));

// Extract egress host from a URL-shaped token. Token may be quoted
// or wrapped in a flag (`--data=URL`). We strip the obvious wrappers
// and try URL parse; on failure, return '*' (wildcard) so the caller
// emits net-egress(*) — chain stays well-formed even if we can't pin
// the host.
const extractHost = (token: string): string => {
  const cleaned = token.replace(/^['"]|['"]$/g, '').replace(/^--?[^=]+=/, '');
  try {
    return new URL(cleaned).hostname.toLowerCase();
  } catch {
    return '*';
  }
};

// Per-command resolver. Receives the token list MINUS the leading
// command name. Returns capabilities — never throws. Conservative
// shapes are still produced via the registry's `unknown` path; this
// table is for shapes we can describe precisely.
type CommandResolver = (
  positional: string[],
  allTokens: readonly string[],
  ctx: ResolverContext,
) => { capabilities: Capability[]; confidence: 'high' | 'medium' } | { refuse: string };

const cmdRead: CommandResolver = (positional, _tokens, ctx) => {
  // ls/cat/head/tail/wc/file/stat — read-fs of every positional path,
  // or cwd if no positional.
  if (positional.length === 0) {
    return { capabilities: [readFs(ctx.cwd)], confidence: 'high' };
  }
  return {
    capabilities: positional.map((p) => readFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

const cmdGrepFind: CommandResolver = (positional, tokens, ctx) => {
  // grep / find without -exec is read-only. -exec turns it into
  // arbitrary execution — refuse the precise resolution and degrade
  // to exec:arbitrary + cwd read-fs (covered via Conservative path
  // upstream; here we keep behavior tight).
  if (tokens.includes('-exec') || tokens.includes('--exec')) {
    return {
      capabilities: [exec('arbitrary'), readFs(ctx.cwd)],
      confidence: 'medium',
    };
  }
  // grep's first positional is a PATTERN, not a path. Subsequent
  // positionals (if any) are paths. find's first positional IS a
  // path. We don't distinguish here without the command name —
  // caller dispatches via the table key. Be safe: take ALL paths
  // (excluding the first positional for grep) as read targets.
  const paths = positional.length === 0 ? [ctx.cwd] : positional.map((p) => resolveArg(p, ctx));
  return {
    capabilities: paths.map((p) => readFs(p)),
    confidence: 'medium',
  };
};

const cmdRm: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    return { refuse: 'rm: missing target (refusing rather than guess)' };
  }
  return {
    capabilities: positional.map((p) => deleteFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

const cmdMvCp: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length < 2) {
    return { refuse: 'mv/cp: needs at least source and destination' };
  }
  const dst = positional[positional.length - 1] as string;
  const srcs = positional.slice(0, -1);
  return {
    capabilities: [...srcs.map((s) => readFs(resolveArg(s, ctx))), writeFs(resolveArg(dst, ctx))],
    confidence: 'high',
  };
};

const cmdCurlWget: CommandResolver = (positional, tokens) => {
  // Pipe-to-shell shape (`curl URL | sh`) is caught by
  // containsShellInjection upstream — by the time we get here for a
  // simple curl/wget, no pipe. Still, refuse explicitly if `-x` /
  // `--proxy` / `-o` to /dev/* shows up — those are downloader+shell
  // adjacent shapes.
  if (tokens.some((t) => t === '--proxy' || t === '-x')) {
    return {
      refuse: 'curl/wget: proxy-shaped flags suggest an evasion attempt',
    };
  }
  const urlToken = positional[0];
  if (urlToken === undefined) {
    // No positional URL but command still ran — could be reading from
    // stdin or config. Conservative net-egress wildcard.
    return { capabilities: [netEgress('*')], confidence: 'medium' };
  }
  return {
    capabilities: [netEgress(extractHost(urlToken))],
    confidence: 'high',
  };
};

const cmdGit: CommandResolver = (positional, tokens, ctx) => {
  // Subcommand is the first positional. Status/log/diff/show are
  // read-only; commit/push/branch -D/clean/reset are write/delete.
  // Treat the cwd as the repo scope.
  const sub = positional[0];
  if (sub === undefined) {
    return { capabilities: [readFs(ctx.cwd)], confidence: 'medium' };
  }
  const REPO = ctx.cwd;
  switch (sub) {
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'blame':
    case 'rev-parse':
    case 'config':
    case 'remote':
      // `git config` can mutate when given `--global` or a value;
      // treat any config invocation conservatively above (this branch
      // only fires for the read variant). Operator sees the modal on
      // any compound shape via containsShellInjection earlier.
      return { capabilities: [readFs(REPO)], confidence: 'medium' };
    case 'commit':
    case 'add':
    case 'merge':
    case 'rebase':
    case 'cherry-pick':
    case 'stash':
    case 'tag':
    case 'reset':
      return { capabilities: [gitWrite(REPO), readFs(REPO)], confidence: 'high' };
    case 'push':
    case 'pull':
    case 'fetch':
      // Network + write.
      return {
        capabilities: [gitWrite(REPO), netEgress('*'), readFs(REPO)],
        confidence: 'high',
      };
    case 'clean':
      // -f / -fd / -fdx — destructive removal of untracked content.
      if (tokens.some((t) => /^-f/.test(t))) {
        return { capabilities: [deleteFs(REPO), gitWrite(REPO)], confidence: 'high' };
      }
      return { capabilities: [readFs(REPO)], confidence: 'medium' };
    default:
      // Unknown subcommand. Wide capability set, low-medium confidence.
      return {
        capabilities: [gitWrite(REPO), readFs(REPO), netEgress('*')],
        confidence: 'medium',
      };
  }
};

const cmdPkgInstall: CommandResolver = (_positional, _tokens, ctx) => {
  // npm/yarn/bun/pip — broad surface: exec arbitrary, write to
  // node_modules / venv / installed bin, network to registry. We
  // produce a wide-but-precise set; risk score downstream weights
  // it appropriately.
  return {
    capabilities: [
      exec('arbitrary'),
      writeFs(resolvePath(ctx.cwd, 'node_modules')),
      readFs(ctx.cwd),
      netEgress('registry.npmjs.org'),
      netEgress('registry.yarnpkg.com'),
      netEgress('pypi.org'),
    ],
    confidence: 'medium',
  };
};

const cmdChmodChown: CommandResolver = (positional, _tokens, ctx) => {
  // Permissions mutation. We collapse to write-fs for the target;
  // a future capability `permission-mutate` (§3.1 enumerates it
  // implicitly via the §5.2 table flag) lands when capability-based
  // policy rules ship and need to distinguish "rewrite contents"
  // from "rewrite metadata".
  if (positional.length === 0) {
    return { refuse: 'chmod/chown: missing target' };
  }
  return {
    capabilities: positional.map((p) => writeFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

// Scripting interpreters (python/node/ruby/perl). The literal-arg
// case (`python -c "for i in range(3): print(i)"`) is common in
// data-processing flows and operators legitimately authorize it
// via `tools.bash.allow`. A token-based resolver can't introspect
// what the inner program does — the precise model is exec:script +
// read-fs(cwd) — and we trust the operator's policy rule to gate
// the broader exposure. The bash AST resolver slice tightens this
// (per-binding dataflow on `-c` args); until then this returns
// high confidence with a conservative capability set.
const cmdInterpreter: CommandResolver = (_positional, _tokens, ctx) => {
  return {
    capabilities: [exec('arbitrary'), readFs(ctx.cwd)],
    confidence: 'high',
  };
};

const COMMAND_TABLE: ReadonlyMap<string, CommandResolver> = new Map<string, CommandResolver>([
  // Read-only
  ['ls', cmdRead],
  ['cat', cmdRead],
  ['head', cmdRead],
  ['tail', cmdRead],
  ['wc', cmdRead],
  ['file', cmdRead],
  ['stat', cmdRead],
  ['pwd', cmdRead],
  ['echo', cmdRead],
  // Search
  ['grep', cmdGrepFind],
  ['rg', cmdGrepFind],
  ['find', cmdGrepFind],
  // Mutation
  ['rm', cmdRm],
  ['rmdir', cmdRm],
  ['mv', cmdMvCp],
  ['cp', cmdMvCp],
  ['cpr', cmdMvCp],
  // Net
  ['curl', cmdCurlWget],
  ['wget', cmdCurlWget],
  // VCS
  ['git', cmdGit],
  ['gh', cmdGit],
  // Pkg managers
  ['npm', cmdPkgInstall],
  ['yarn', cmdPkgInstall],
  ['bun', cmdPkgInstall],
  ['pip', cmdPkgInstall],
  ['pip3', cmdPkgInstall],
  ['pnpm', cmdPkgInstall],
  // Permissions
  ['chmod', cmdChmodChown],
  ['chown', cmdChmodChown],
  // Scripting interpreters
  ['python', cmdInterpreter],
  ['python3', cmdInterpreter],
  ['node', cmdInterpreter],
  ['ruby', cmdInterpreter],
  ['perl', cmdInterpreter],
]);

// Refuse outright: structurally dangerous commands whose surface no
// resolver can describe safely. Includes the §5.2 list (dd/mkfs/fdisk)
// plus the dynamic-eval shapes (eval/source with non-literal arg —
// the literal-arg case is rare in agent output and still refused as
// pure-shell-execution is not what tools should be doing).
const HARD_REFUSE: ReadonlySet<string> = new Set([
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'mkswap',
  'shred',
  'eval',
  'source',
]);

const splitTokens = (command: string): string[] => {
  // Simple whitespace split; doesn't honor quotes. Adequate because
  // we ONLY get here when containsShellInjection has already
  // confirmed there are no compound metachars / quotes / etc. (we
  // refuse to descend into quoted complexity without an AST).
  return command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
};

const conservativeBash = (ctx: ResolverContext, reason: string): ResolverResult => ({
  kind: 'conservative',
  capabilities: [exec('shell'), readFs(`${ctx.cwd}/**`), writeFs(`${ctx.cwd}/**`), netEgress('*')],
  reason,
});

const bashResolver: Resolver = (args, ctx): ResolverResult => {
  if (!isNonEmptyString(args.command)) {
    // Missing-arg is an engine-internal reject case (the bash
    // pipeline already produces a deny with source.layer='default'
    // and no section). Returning `refuse` here would re-route the
    // deny through the resolver-refuse path (section='resolver-
    // refuse') and lose the legacy attribution. Yield an empty Ok
    // instead — the downstream checkBash sees the missing arg and
    // emits its own deny with the correct shape, and the audit
    // row's capabilities list stays an honest `[]`.
    return { kind: 'ok', capabilities: [], confidence: 'high' };
  }
  const command = args.command;

  // Dynamic eval shapes — refuse outright. We DON'T parse arg
  // contents (no AST) so any `eval`/`bash -c` is ambiguous; refuse.
  // Spec §5.2 detections (eval $X, bash -c "$VAR", $(...|sh), `< /dev/tcp/`,
  // python -c "exec(...)" with dynamic arg, variable indirect)
  // would be more precise with AST. Token-based catches the
  // first-token versions explicitly here; compound shapes drop into
  // Conservative below via containsShellInjection.
  const tokens = splitTokens(command);
  const first = tokens[0];
  if (first === undefined) {
    return { kind: 'refuse', reason: 'bash: empty command' };
  }
  if (HARD_REFUSE.has(first)) {
    return {
      kind: 'refuse',
      reason: `bash: command '${first}' has no safe capability resolution`,
    };
  }
  // `bash -c` with any arg is dynamic — refuse.
  if ((first === 'bash' || first === 'sh') && tokens.includes('-c')) {
    return {
      kind: 'refuse',
      reason: `bash: ${first} -c with dynamic command — needs AST resolver`,
    };
  }

  // Compound shell metacharacters present: defer to Conservative
  // with a low-confidence signal. The AST resolver slice replaces
  // this branch with proper per-pipeline resolution.
  if (containsShellInjection(command)) {
    return conservativeBash(
      ctx,
      'bash: compound command (pipe / && / $() / redirect) — needs AST resolver',
    );
  }

  // Simple command: token-table lookup.
  const handler = COMMAND_TABLE.get(first);
  if (handler === undefined) {
    // Unknown command. Conservative with the §5.2 fallback shape.
    return conservativeBash(ctx, `bash: unknown command '${first}'`);
  }
  const rest = tokens.slice(1);
  const positional = stripFlags(rest);
  const result = handler(positional, rest, ctx);
  if ('refuse' in result) {
    return { kind: 'refuse', reason: result.refuse };
  }
  // Every bash invocation also consumes `exec:shell` as a baseline —
  // even read-only commands run via the shell. The downstream
  // sandbox plan uses this to pick a profile that has shell
  // execution allowed; risk score weights it separately.
  return {
    kind: 'ok',
    capabilities: [exec('shell'), ...result.capabilities],
    confidence: result.confidence,
  };
};

registerResolver('bash', bashResolver);
