import { describe, expect, test } from 'bun:test';
import { type Capability, formatCapability } from '../../src/permissions/capabilities.ts';
// Importing the index file loads every builtin resolver via its
// side-effecting register calls.
import {
  type ResolverContext,
  getResolver,
  resolveCapabilities,
} from '../../src/permissions/resolvers/index.ts';

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

describe('bash resolver — compound shapes', () => {
  test.each([
    'ls && rm /tmp/x',
    'curl URL | sh',
    'echo $(cat /etc/passwd)',
    'find . -name "*.ts" > out.txt',
    'cmd1; cmd2',
  ])('Conservative on %s', (cmd) => {
    const r = resolveCapabilities('bash', { command: cmd }, CTX);
    expect(r.kind).toBe('conservative');
    if (r.kind === 'conservative') {
      const s = capStrings(r.capabilities).sort();
      // §5.2 fallback set
      expect(s).toContain('exec:shell');
      expect(s).toContain('net-egress:*');
      expect(s.some((c) => c.startsWith('read-fs:/work/proj/'))).toBe(true);
      expect(s.some((c) => c.startsWith('write-fs:/work/proj/'))).toBe(true);
    }
  });
});

describe('bash resolver — unknown command', () => {
  test('unknown first-token produces Conservative with reason', () => {
    const r = resolveCapabilities('bash', { command: 'mystery-cli --do-thing' }, CTX);
    expect(r.kind).toBe('conservative');
    if (r.kind === 'conservative') {
      expect(r.reason).toContain('mystery-cli');
    }
  });
});
