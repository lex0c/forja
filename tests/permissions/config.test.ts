import { describe, expect, test } from 'bun:test';
import { defaultPolicy, loadPolicyFromString, parsePolicy } from '../../src/permissions/config.ts';

describe('parsePolicy', () => {
  test('accepts a full valid policy', () => {
    const p = parsePolicy({
      defaults: { mode: 'acceptEdits' },
      tools: {
        bash: { allow: ['git status'], confirm: ['git push *'], deny: ['rm -rf *'] },
        write_file: { allow_paths: ['src/**'], deny_paths: ['**/.env*'] },
        fetch_url: { allow_hosts: ['*.public.com'] },
      },
    });
    expect(p.defaults.mode).toBe('acceptEdits');
    expect(p.tools.bash?.allow).toEqual(['git status']);
    expect(p.tools.write_file?.deny_paths).toEqual(['**/.env*']);
    expect(p.tools.fetch_url?.allow_hosts).toEqual(['*.public.com']);
  });

  test('preserves mode-omitted as undefined (engine/resolver applies the default downstream)', () => {
    // parsePolicy used to inject mode='strict' as a default. Doing
    // so made "user file silent on mode" indistinguishable from
    // "user file said strict explicitly", which then produced
    // phantom lock-conflicts when a higher layer locked mode at
    // a non-strict value. Now ms is preserved as undefined; the
    // engine reads `mode ?? 'strict'` and the hierarchy resolver
    // applies the default at merge-emit time.
    expect(parsePolicy({}).defaults.mode).toBeUndefined();
    expect(parsePolicy({ tools: {} }).defaults.mode).toBeUndefined();
    expect(parsePolicy({ defaults: { mode: 'strict' } }).defaults.mode).toBe('strict');
  });

  test('rejects unknown keys (typo defense)', () => {
    // Typo `allow_path` (singular) used to silently turn into a
    // no-op section that allows everything by virtue of having no
    // declared rules. parsePolicy now rejects unknown keys to
    // catch these at config load time.
    expect(() => parsePolicy({ tools: { write_file: { allow_path: ['./src/**'] } } })).toThrow(
      /unknown key 'allow_path'/,
    );
    expect(() => parsePolicy({ tools: { bash: { lockd: true } } })).toThrow(/unknown key 'lockd'/);
    expect(() => parsePolicy({ defaults: { lcoked: true } })).toThrow(/unknown key 'lcoked'/);
  });

  test('rejects invalid mode', () => {
    expect(() => parsePolicy({ defaults: { mode: 'lax' } })).toThrow(/defaults.mode/);
  });

  test('rejects non-mapping top-level', () => {
    expect(() => parsePolicy(null)).toThrow(/YAML mapping/);
    expect(() => parsePolicy('a string')).toThrow(/YAML mapping/);
    expect(() => parsePolicy(['array'])).toThrow(/YAML mapping/);
    expect(() => parsePolicy(123)).toThrow(/YAML mapping/);
  });

  test('rejects mistyped allow_paths (not array of strings)', () => {
    expect(() => parsePolicy({ tools: { write_file: { allow_paths: 'src/**' } } })).toThrow(
      /allow_paths/,
    );
    expect(() => parsePolicy({ tools: { write_file: { allow_paths: [1, 2] } } })).toThrow();
  });

  test('rejects mistyped bash deny rules', () => {
    expect(() => parsePolicy({ tools: { bash: { deny: 'rm *' } } })).toThrow(/bash.deny/);
  });

  test('rejects malformed tools section', () => {
    expect(() => parsePolicy({ tools: 'not a map' })).toThrow(/tools/);
  });
});

describe('loadPolicyFromString', () => {
  test('parses a YAML document', () => {
    const yaml = `
defaults:
  mode: strict

tools:
  bash:
    allow:
      - "git status"
    deny:
      - "rm -rf *"
  write_file:
    allow_paths:
      - "src/**"
`;
    const p = loadPolicyFromString(yaml);
    expect(p.defaults.mode).toBe('strict');
    expect(p.tools.bash?.allow).toEqual(['git status']);
    expect(p.tools.write_file?.allow_paths).toEqual(['src/**']);
  });

  test('throws on YAML syntax errors', () => {
    expect(() => loadPolicyFromString('defaults: { mode: [unterminated')).toThrow();
  });
});

describe('defaultPolicy', () => {
  test('strict mode + empty rules', () => {
    const p = defaultPolicy();
    expect(p.defaults.mode).toBe('strict');
    expect(p.tools).toEqual({});
  });
});

describe('parsePolicy — protected paths (§11)', () => {
  const ctx = { home: '/home/op', cwd: '/work/proj' };

  test('rejects allow_paths that targets a protected file directly', () => {
    expect(() =>
      parsePolicy({ tools: { write_file: { allow_paths: ['/etc/hosts'] } } }, ctx),
    ).toThrow(/redefines a protected path/);
  });

  test('rejects allow_paths that targets /etc with descend', () => {
    expect(() => parsePolicy({ tools: { write_file: { allow_paths: ['/etc/**'] } } }, ctx)).toThrow(
      /redefines a protected path/,
    );
  });

  test('rejects allow_paths that targets exact protected root', () => {
    expect(() => parsePolicy({ tools: { write_file: { allow_paths: ['/proc'] } } }, ctx)).toThrow(
      /redefines a protected path/,
    );
  });

  test('rejects allow_paths targeting tilde-protected file', () => {
    expect(() =>
      parsePolicy({ tools: { write_file: { allow_paths: ['~/.bashrc'] } } }, ctx),
    ).toThrow(/redefines a protected path/);
  });

  test('rejects confirm_paths with same protected redefinition', () => {
    expect(() =>
      parsePolicy({ tools: { write_file: { confirm_paths: ['/proc/sys/kernel'] } } }, ctx),
    ).toThrow(/redefines a protected path/);
  });

  test('accepts deny_paths for protected (reinforcement is welcome)', () => {
    expect(() =>
      parsePolicy({ tools: { write_file: { deny_paths: ['/etc/**', '~/.bashrc'] } } }, ctx),
    ).not.toThrow();
  });

  test('accepts broad catch-all globs (engine handles via runtime classifier)', () => {
    // `/**` and `**` legitimately cover the whole filesystem;
    // they get caught at decision time by the protected-path
    // classifier. Flagging them at parse time would break the
    // ergonomic "allow everywhere" + protected-path-fallback
    // pattern operators write today.
    expect(() =>
      parsePolicy({ tools: { write_file: { allow_paths: ['/**'] } } }, ctx),
    ).not.toThrow();
    expect(() =>
      parsePolicy({ tools: { write_file: { allow_paths: ['**'] } } }, ctx),
    ).not.toThrow();
  });

  test('error message points at PERMISSION_ENGINE.md §11', () => {
    expect(() =>
      parsePolicy({ tools: { write_file: { allow_paths: ['/etc/passwd'] } } }, ctx),
    ).toThrow(/PERMISSION_ENGINE\.md §11/);
  });

  test('skips check when context has no home/cwd (compat path)', () => {
    expect(() =>
      parsePolicy({ tools: { write_file: { allow_paths: ['/etc/hosts'] } } }),
    ).not.toThrow();
  });

  test('cwd-rooted protected dirs (.git, .agent, .claude) flagged', () => {
    expect(() =>
      parsePolicy({ tools: { write_file: { allow_paths: ['/work/proj/.git/**'] } } }, ctx),
    ).toThrow(/redefines a protected path/);
    expect(() =>
      parsePolicy(
        { tools: { write_file: { allow_paths: ['/work/proj/.agent/sessions.db'] } } },
        ctx,
      ),
    ).toThrow(/redefines a protected path/);
  });
});

describe('parsePolicy — sandbox section (§6.5, slice 23)', () => {
  test('absent sandbox block leaves the field undefined', () => {
    const p = parsePolicy({});
    expect(p.sandbox).toBeUndefined();
  });

  test('parses required + host_allowed and maps to camelCase', () => {
    const p = parsePolicy({ sandbox: { required: true, host_allowed: true } });
    expect(p.sandbox).toEqual({ required: true, hostAllowed: true });
  });

  test('preserves "not present" vs "explicit false" for each field', () => {
    const p1 = parsePolicy({ sandbox: { required: true } });
    expect(p1.sandbox).toEqual({ required: true });
    expect(p1.sandbox?.hostAllowed).toBeUndefined();

    const p2 = parsePolicy({ sandbox: { host_allowed: false } });
    expect(p2.sandbox).toEqual({ hostAllowed: false });
    expect(p2.sandbox?.required).toBeUndefined();
  });

  test('rejects non-boolean required', () => {
    expect(() => parsePolicy({ sandbox: { required: 'yes' } })).toThrow(
      'sandbox.required must be boolean',
    );
  });

  test('rejects non-boolean host_allowed', () => {
    expect(() => parsePolicy({ sandbox: { host_allowed: 1 } })).toThrow(
      'sandbox.host_allowed must be boolean',
    );
  });

  test('rejects unknown keys', () => {
    expect(() => parsePolicy({ sandbox: { typo: true } })).toThrow(
      "sandbox has unknown key 'typo'",
    );
  });

  test('rejects non-mapping sandbox', () => {
    expect(() => parsePolicy({ sandbox: true })).toThrow('`sandbox` must be a mapping');
    expect(() => parsePolicy({ sandbox: [] })).toThrow('`sandbox` must be a mapping');
  });

  test('empty sandbox object leaves the field undefined (no fields written)', () => {
    const p = parsePolicy({ sandbox: {} });
    expect(p.sandbox).toBeUndefined();
  });
});

describe('parsePolicy — seal section (§7.3, slice 57)', () => {
  test('mode=none parses with no other fields required', () => {
    const p = parsePolicy({ seal: { mode: 'none' } });
    expect(p.seal).toEqual({ mode: 'none' });
  });

  test('mode=worm-file with path parses cleanly', () => {
    const p = parsePolicy({ seal: { mode: 'worm-file', path: '/var/log/agent/seal.log' } });
    expect(p.seal).toEqual({ mode: 'worm-file', path: '/var/log/agent/seal.log' });
  });

  test('all optional fields propagate', () => {
    const p = parsePolicy({
      seal: {
        mode: 'worm-file',
        path: '/var/log/agent/seal.log',
        interval_decisions: 50,
        interval_seconds: 1800,
        on_failure: 'refuse',
      },
    });
    expect(p.seal).toEqual({
      mode: 'worm-file',
      path: '/var/log/agent/seal.log',
      interval_decisions: 50,
      interval_seconds: 1800,
      on_failure: 'refuse',
    });
  });

  test('mode is required', () => {
    expect(() => parsePolicy({ seal: {} })).toThrow('seal.mode is required');
  });

  test('mode=worm-file requires path', () => {
    expect(() => parsePolicy({ seal: { mode: 'worm-file' } })).toThrow(
      'seal.path is required when seal.mode is worm-file',
    );
  });

  test('mode=git-anchored requires path (slice 63)', () => {
    expect(() => parsePolicy({ seal: { mode: 'git-anchored' } })).toThrow(
      'seal.path is required when seal.mode is git-anchored',
    );
  });

  test('mode=git-anchored with path parses cleanly', () => {
    const p = parsePolicy({ seal: { mode: 'git-anchored', path: '/var/audit/seal-repo' } });
    expect(p.seal).toEqual({ mode: 'git-anchored', path: '/var/audit/seal-repo' });
  });

  test('mode=none does NOT require path', () => {
    expect(() => parsePolicy({ seal: { mode: 'none' } })).not.toThrow();
  });

  test('all §7.3 modes shipped — no reserved modes today', () => {
    // After slice 89 the reserved set is empty; every §7.3 mode is
    // implemented. Adding a new mode to the spec resurrects this
    // assertion against the new value.
    for (const mode of ['none', 'worm-file', 'git-anchored', 'rfc3161-tsa', 's3-object-lock']) {
      expect(() => parsePolicy({ seal: { mode } })).not.toThrow(/reserved for a future slice/);
    }
  });

  test('unknown mode rejected with enum error', () => {
    expect(() => parsePolicy({ seal: { mode: 'cloud-storage' } })).toThrow(
      "seal.mode must be one of none|worm-file|git-anchored|rfc3161-tsa|s3-object-lock, got 'cloud-storage'",
    );
  });

  test('invalid on_failure rejected with enum error', () => {
    expect(() => parsePolicy({ seal: { mode: 'none', on_failure: 'crash' } })).toThrow(
      "seal.on_failure must be one of degrade|refuse, got 'crash'",
    );
  });

  test('rejects non-mapping seal', () => {
    expect(() => parsePolicy({ seal: true })).toThrow('`seal` must be a mapping');
    expect(() => parsePolicy({ seal: [] })).toThrow('`seal` must be a mapping');
  });

  test('rejects empty path', () => {
    expect(() => parsePolicy({ seal: { mode: 'worm-file', path: '' } })).toThrow(
      'seal.path must be a non-empty string',
    );
  });

  test('rejects non-integer interval_decisions', () => {
    expect(() => parsePolicy({ seal: { mode: 'none', interval_decisions: 1.5 } })).toThrow(
      'seal.interval_decisions must be a non-negative integer',
    );
    expect(() => parsePolicy({ seal: { mode: 'none', interval_decisions: -1 } })).toThrow(
      'seal.interval_decisions must be a non-negative integer',
    );
    expect(() => parsePolicy({ seal: { mode: 'none', interval_decisions: 'lots' } })).toThrow(
      'seal.interval_decisions must be a non-negative integer',
    );
  });

  test('rejects non-integer interval_seconds', () => {
    expect(() => parsePolicy({ seal: { mode: 'none', interval_seconds: 60.5 } })).toThrow(
      'seal.interval_seconds must be a non-negative integer',
    );
  });

  test('accepts interval_decisions=0 (disables decision-driven sealing)', () => {
    const p = parsePolicy({ seal: { mode: 'none', interval_decisions: 0 } });
    expect(p.seal?.interval_decisions).toBe(0);
  });

  test('accepts interval_seconds=0 (disables time-driven sealing)', () => {
    const p = parsePolicy({ seal: { mode: 'none', interval_seconds: 0 } });
    expect(p.seal?.interval_seconds).toBe(0);
  });

  test('rejects unknown keys', () => {
    // `endpoint` is the new valid key (slice 88, for rfc3161-tsa);
    // use a clearly-bogus name to exercise the rejection path.
    expect(() => parsePolicy({ seal: { mode: 'none', frobnicate: 'yes' } })).toThrow(
      "seal has unknown key 'frobnicate'",
    );
  });

  test('rfc3161-tsa requires path AND endpoint', () => {
    expect(() => parsePolicy({ seal: { mode: 'rfc3161-tsa' } })).toThrow(
      'seal.path is required when seal.mode is rfc3161-tsa',
    );
    expect(() => parsePolicy({ seal: { mode: 'rfc3161-tsa', path: '/tmp/seals' } })).toThrow(
      "seal.endpoint is required when seal.mode is 'rfc3161-tsa'",
    );
  });

  test('rfc3161-tsa endpoint must be http:// or https:// scheme', () => {
    expect(() =>
      parsePolicy({
        seal: { mode: 'rfc3161-tsa', path: '/tmp/seals', endpoint: 'ftp://tsa.example.com' },
      }),
    ).toThrow('must start with http:// or https://');
  });

  test('rfc3161-tsa rejects empty endpoint', () => {
    expect(() =>
      parsePolicy({ seal: { mode: 'rfc3161-tsa', path: '/tmp/seals', endpoint: '' } }),
    ).toThrow('seal.endpoint must be a non-empty string');
  });

  test('rfc3161-tsa with valid path + endpoint parses cleanly', () => {
    const p = parsePolicy({
      seal: {
        mode: 'rfc3161-tsa',
        path: '/var/forja/seals',
        endpoint: 'https://tsa.example.com',
        interval_decisions: 100,
        interval_seconds: 3600,
        on_failure: 'degrade',
      },
    });
    expect(p.seal).toEqual({
      mode: 'rfc3161-tsa',
      path: '/var/forja/seals',
      endpoint: 'https://tsa.example.com',
      interval_decisions: 100,
      interval_seconds: 3600,
      on_failure: 'degrade',
    });
  });

  test('s3-object-lock requires path + bucket + retention_days', () => {
    expect(() => parsePolicy({ seal: { mode: 's3-object-lock' } })).toThrow(
      'seal.path is required when seal.mode is s3-object-lock',
    );
    expect(() => parsePolicy({ seal: { mode: 's3-object-lock', path: '/tmp/s' } })).toThrow(
      "seal.bucket is required when seal.mode is 's3-object-lock'",
    );
    expect(() =>
      parsePolicy({ seal: { mode: 's3-object-lock', path: '/tmp/s', bucket: 'b' } }),
    ).toThrow('seal.retention_days is required');
  });

  test('s3-object-lock retention_days must be integer >= 1', () => {
    const base = { mode: 's3-object-lock', path: '/tmp/s', bucket: 'b' };
    expect(() => parsePolicy({ seal: { ...base, retention_days: 0 } })).toThrow(
      'seal.retention_days must be an integer >= 1',
    );
    expect(() => parsePolicy({ seal: { ...base, retention_days: 1.5 } })).toThrow(
      'seal.retention_days must be an integer >= 1',
    );
    expect(() => parsePolicy({ seal: { ...base, retention_days: -5 } })).toThrow(
      'seal.retention_days must be an integer >= 1',
    );
  });

  test('s3-object-lock key_prefix must not start or end with /', () => {
    const base = { mode: 's3-object-lock', path: '/tmp/s', bucket: 'b', retention_days: 30 };
    expect(() => parsePolicy({ seal: { ...base, key_prefix: '/leading' } })).toThrow(
      "must not start or end with '/'",
    );
    expect(() => parsePolicy({ seal: { ...base, key_prefix: 'trailing/' } })).toThrow(
      "must not start or end with '/'",
    );
  });

  test('s3-object-lock rejects empty bucket / region', () => {
    expect(() =>
      parsePolicy({
        seal: { mode: 's3-object-lock', path: '/tmp/s', bucket: '', retention_days: 30 },
      }),
    ).toThrow('seal.bucket must be a non-empty string');
    expect(() =>
      parsePolicy({
        seal: {
          mode: 's3-object-lock',
          path: '/tmp/s',
          bucket: 'b',
          retention_days: 30,
          region: '',
        },
      }),
    ).toThrow('seal.region must be a non-empty string');
  });

  test('s3-object-lock with full config parses cleanly', () => {
    const p = parsePolicy({
      seal: {
        mode: 's3-object-lock',
        path: '/var/forja/seals',
        bucket: 'forja-audit',
        region: 'us-east-1',
        key_prefix: 'install-id/seals',
        retention_days: 2555,
        endpoint: 'https://s3.amazonaws.com',
        interval_decisions: 100,
        interval_seconds: 3600,
        on_failure: 'degrade',
      },
    });
    expect(p.seal).toEqual({
      mode: 's3-object-lock',
      path: '/var/forja/seals',
      bucket: 'forja-audit',
      region: 'us-east-1',
      key_prefix: 'install-id/seals',
      retention_days: 2555,
      endpoint: 'https://s3.amazonaws.com',
      interval_decisions: 100,
      interval_seconds: 3600,
      on_failure: 'degrade',
    });
  });

  test('absent seal section leaves the field undefined', () => {
    const p = parsePolicy({ defaults: { mode: 'strict' } });
    expect(p.seal).toBeUndefined();
  });
});

// Slice 101 — R8 bootstrap/policy parsing hardening. Four
// findings collapse to the same theme: silent acceptance of
// authored garbage. Each test pins the new "loud refuse"
// contract so a future relaxation is loud rather than silent.
describe('parsePolicy — slice 101 hardening (R8 #318/#319/#320/#321)', () => {
  test('top-level typo refuses with unknown-key error (R8 #319)', () => {
    // `defualts` (typo for `defaults`) used to silently drop —
    // policy parsed as `{}` and the operator's authored bypass
    // mode never took effect. The fix surfaces the typo with
    // the same shape used for nested keys.
    expect(() => parsePolicy({ defualts: { mode: 'bypass' } })).toThrow(/unknown key 'defualts'/);
  });

  test('top-level error message lists every supported key', () => {
    try {
      parsePolicy({ defualts: { mode: 'bypass' } });
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('defaults');
      expect(msg).toContain('tools');
      expect(msg).toContain('sandbox');
      expect(msg).toContain('seal');
    }
  });

  test('tool name typo refuses with unknown-key error (R8 #320)', () => {
    // `tools.bsh` (typo for `tools.bash`) used to silently parse
    // — the dispatcher matched specific names and ignored unknown
    // ones. An operator authoring `tools.bsh.deny: ['rm -rf *']`
    // got a no-op section that admitted everything.
    expect(() => parsePolicy({ tools: { bsh: { deny: ['rm -rf *'] } } })).toThrow(
      /unknown key 'bsh'/,
    );
  });

  test('tool name error message lists every supported tool', () => {
    try {
      parsePolicy({ tools: { bsh: { deny: [] } } });
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('bash');
      expect(msg).toContain('read_file');
      expect(msg).toContain('write_file');
      expect(msg).toContain('edit_file');
      expect(msg).toContain('glob');
      expect(msg).toContain('grep');
      expect(msg).toContain('fetch_url');
    }
  });

  test('seal.locked parses as a boolean field (slice 112 added lock semantics)', () => {
    // Slice 101 refused `seal.locked` because the hierarchy
    // resolver didn't honor it (no-op field would mislead).
    // Slice 112 (R8 #322) wired the full lock semantics in
    // hierarchy.ts; the config parser now accepts the field
    // and the resolver enforces it. Inverted from the slice 101
    // "refuses" assertion.
    const p = parsePolicy({ seal: { mode: 'none', locked: true } });
    expect(p.seal?.locked).toBe(true);
  });

  test('seal.locked must be boolean (typo defense)', () => {
    expect(() => parsePolicy({ seal: { mode: 'none', locked: 'true' } })).toThrow(
      /seal\.locked must be boolean/,
    );
  });

  test('sections that DO support locked still accept it (no regression)', () => {
    // The slice 101 fix removed auto-add, but each supporting
    // section listed 'locked' explicitly. Verify each one still
    // honors the field.
    const p = parsePolicy({
      defaults: { mode: 'strict', locked: true },
      tools: {
        bash: { allow: ['ls *'], locked: true },
        write_file: { allow_paths: ['src/**'], locked: true },
        fetch_url: { allow_hosts: ['*.com'], locked: true },
      },
      sandbox: { required: true, locked: true },
    });
    expect(p.defaults.locked).toBe(true);
    // bash/path/fetch sections retain locked in their raw shape
    // via the validator's pass-through (not modeled on Policy[..]
    // today but visible via the hierarchy resolver). The smoke
    // test here is that the parse SUCCEEDS without erroring.
    expect(p.sandbox?.locked).toBe(true);
  });

  test('/etc* glob-suffix protected redefinition refuses (R8 #321)', () => {
    // `/etc*` glob-matches `/etc` (bare root) via the trailing
    // wildcard, but pre-slice the check only flagged `/etc/...`
    // descendants. Slice 101 catches glob suffixes immediately
    // following a protected root.
    expect(() =>
      parsePolicy(
        { tools: { write_file: { allow_paths: ['/etc*'] } } },
        { home: '/home/op', cwd: '/work/proj' },
      ),
    ).toThrow(/redefines a protected path/);
  });

  test('/etc[abc] character-class shape also refuses', () => {
    // The same defense applies to `[` (character class) and
    // `?` (single-char wildcard) immediately after the root.
    expect(() =>
      parsePolicy(
        { tools: { write_file: { allow_paths: ['/etc[abc]'] } } },
        { home: '/home/op', cwd: '/work/proj' },
      ),
    ).toThrow(/redefines a protected path/);
  });

  test('/etc? single-char wildcard also refuses', () => {
    expect(() =>
      parsePolicy(
        { tools: { write_file: { allow_paths: ['/etc?'] } } },
        { home: '/home/op', cwd: '/work/proj' },
      ),
    ).toThrow(/redefines a protected path/);
  });

  test('/etcd (non-glob continuation) does NOT refuse (different path)', () => {
    // `/etcd` is the etcd config dir on some systems — a real,
    // non-protected target. The fix must NOT regress to flagging
    // it just because it starts with /etc.
    expect(() =>
      parsePolicy(
        { tools: { write_file: { allow_paths: ['/etcd/config'] } } },
        { home: '/home/op', cwd: '/work/proj' },
      ),
    ).not.toThrow();
  });

  test('tilde-rooted glob-suffix shape refuses (~/.ssh*)', () => {
    // ~/.ssh is in TILDE_ESCALATE_DIRS (slice 97). A ~/.ssh* glob
    // would match the bare ~/.ssh directory via the trailing
    // wildcard — same risk as /etc*.
    expect(() =>
      parsePolicy(
        { tools: { write_file: { allow_paths: ['~/.ssh*'] } } },
        { home: '/home/op', cwd: '/work/proj' },
      ),
    ).toThrow(/redefines a protected path/);
  });
});
