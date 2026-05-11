import { describe, expect, test } from 'bun:test';
import { buildBwrapArgv, maybeWrapSandboxArgv } from '../../src/permissions/sandbox-runner.ts';

const INNER = ['bash', '-c', 'echo hi'] as const;
const CWD = '/work/proj';
const HOME = '/home/op';

describe('buildBwrapArgv — host profile (passthrough)', () => {
  test('host returns innerArgv unchanged', () => {
    const argv = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('host slices innerArgv (caller-mutation defense)', () => {
    const argv = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    argv.push('mutated');
    // Calling again returns a fresh array — the previous mutation
    // didn't leak into the function's source data.
    const argv2 = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    expect(argv2).toEqual(['bash', '-c', 'echo hi']);
  });
});

describe('buildBwrapArgv — ro profile', () => {
  test('binds / read-only, unshares net + pid, no rw mount', () => {
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    expect(argv[0]).toBe('bwrap');
    expect(argv).toContain('--ro-bind');
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--unshare-pid');
    expect(argv).toContain('--die-with-parent');
    // No writable bind mount.
    expect(argv).not.toContain('--bind');
    // Inner command after `--`.
    const dashIdx = argv.indexOf('--');
    expect(dashIdx).toBeGreaterThan(0);
    expect(argv.slice(dashIdx + 1)).toEqual(['bash', '-c', 'echo hi']);
  });
});

describe('buildBwrapArgv — cwd-rw profile', () => {
  test('binds cwd RW, unshares net (no egress)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    expect(argv).toContain('--bind');
    // bind cwd→cwd appears as adjacent pair.
    const bindIdx = argv.indexOf('--bind');
    expect(argv[bindIdx + 1]).toBe(CWD);
    expect(argv[bindIdx + 2]).toBe(CWD);
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--chdir');
  });
});

describe('buildBwrapArgv — cwd-rw-net profile', () => {
  test('binds cwd RW, KEEPS network (no unshare-net)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw-net',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    expect(argv).toContain('--bind');
    expect(argv).not.toContain('--unshare-net');
    // pid still unshared.
    expect(argv).toContain('--unshare-pid');
  });
});

describe('buildBwrapArgv — home-rw profile', () => {
  test('binds HOME RW + chdir to cwd', () => {
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    const bindIdx = argv.indexOf('--bind');
    expect(argv[bindIdx + 1]).toBe(HOME);
    expect(argv[bindIdx + 2]).toBe(HOME);
    const chdirIdx = argv.indexOf('--chdir');
    expect(argv[chdirIdx + 1]).toBe(CWD);
    // Unshare-net still on — home-rw doesn't grant net.
    expect(argv).toContain('--unshare-net');
  });
});

describe('buildBwrapArgv — common flags', () => {
  test.each(['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const)(
    'profile %s has die-with-parent + tmpfs/proc/dev + chdir',
    (profile) => {
      const argv = buildBwrapArgv({ profile, cwd: CWD, home: HOME, innerArgv: INNER });
      expect(argv).toContain('--die-with-parent');
      expect(argv).toContain('--tmpfs');
      expect(argv).toContain('--proc');
      expect(argv).toContain('--dev');
      expect(argv).toContain('--chdir');
    },
  );
});

describe('buildBwrapArgv — innerArgv preservation', () => {
  test('any innerArgv shape ends up after `--` verbatim', () => {
    const innerArgv = ['python3', '-c', 'print(1+1)'];
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv,
    });
    const dashIdx = argv.indexOf('--');
    expect(argv.slice(dashIdx + 1)).toEqual(innerArgv);
  });

  test('empty innerArgv throws (programmer bug, fail loud)', () => {
    expect(() => buildBwrapArgv({ profile: 'ro', cwd: CWD, home: HOME, innerArgv: [] })).toThrow(
      'innerArgv must not be empty',
    );
  });
});

describe('maybeWrapSandboxArgv — per-spawn-site consume primitive', () => {
  test('omitted profile → returns innerArgv (no wrap)', () => {
    const argv = maybeWrapSandboxArgv({ cwd: CWD, innerArgv: INNER });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('host profile → returns innerArgv even on Linux', () => {
    const argv = maybeWrapSandboxArgv({
      profile: 'host',
      cwd: CWD,
      innerArgv: INNER,
    });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('returned array is a defensive copy (caller mutation safe)', () => {
    const argv = maybeWrapSandboxArgv({ cwd: CWD, innerArgv: INNER });
    argv.push('mutated');
    const argv2 = maybeWrapSandboxArgv({ cwd: CWD, innerArgv: INNER });
    expect(argv2).toEqual(['bash', '-c', 'echo hi']);
  });

  // Live host check — the helper consults process.platform +
  // Bun.which('bwrap') at call time. We can't stub those without
  // intercepting global state, so we ASSERT THE INVARIANT:
  // - on Linux + bwrap installed: argv[0] === 'bwrap'.
  // - on any other state: argv === innerArgv.
  test('on Linux + bwrap available, ro profile wraps; otherwise passthrough', () => {
    const bwrapInstalled = Bun.which('bwrap') !== null;
    const onLinux = process.platform === 'linux';
    const argv = maybeWrapSandboxArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
    });
    if (bwrapInstalled && onLinux) {
      expect(argv[0]).toBe('bwrap');
      expect(argv.slice(-3)).toEqual(['bash', '-c', 'echo hi']);
    } else {
      expect(argv).toEqual(['bash', '-c', 'echo hi']);
    }
  });

  // Test seams added in slice 48: pin a darwin scenario from a
  // Linux runner. Production callers leave platform/which undefined.
  describe('platform dispatch (slice 48 seams)', () => {
    test('darwin + sandbox-exec available → wraps via sandbox-exec', () => {
      const argv = maybeWrapSandboxArgv({
        profile: 'cwd-rw',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        platform: 'darwin',
        which: (name) => (name === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null),
      });
      expect(argv[0]).toBe('sandbox-exec');
      expect(argv[1]).toBe('-p');
      // Profile string is the third element; contains the SBPL
      // version + the cwd writable subpath.
      expect(argv[2]).toContain('(version 1)');
      expect(argv[2]).toContain('(allow file-write* (subpath "/work/proj"))');
      // Inner argv follows the profile, no `--` separator (unlike
      // bwrap).
      expect(argv.slice(3)).toEqual(['bash', '-c', 'echo hi']);
    });

    test('darwin without sandbox-exec → passthrough (degraded)', () => {
      const argv = maybeWrapSandboxArgv({
        profile: 'ro',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        platform: 'darwin',
        which: () => null,
      });
      expect(argv).toEqual(['bash', '-c', 'echo hi']);
    });

    test('linux without bwrap → passthrough (degraded)', () => {
      const argv = maybeWrapSandboxArgv({
        profile: 'ro',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        platform: 'linux',
        which: () => null,
      });
      expect(argv).toEqual(['bash', '-c', 'echo hi']);
    });

    test('host profile bypasses platform dispatch entirely', () => {
      // Host is operator-opted-in passthrough — no wrap regardless
      // of which platform we're on or whether the tool exists.
      const argv = maybeWrapSandboxArgv({
        profile: 'host',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        platform: 'darwin',
        which: (name) => (name === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null),
      });
      expect(argv).toEqual(['bash', '-c', 'echo hi']);
    });

    test('unsupported platform → passthrough', () => {
      // FreeBSD / Windows / etc — `detectSandboxAvailability` would
      // have flagged this at bootstrap. The wrap helper stays
      // forgiving (degraded) instead of throwing, mirroring the
      // missing-binary path.
      const argv = maybeWrapSandboxArgv({
        profile: 'ro',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        platform: 'freebsd' as NodeJS.Platform,
        which: () => '/usr/bin/whatever',
      });
      expect(argv).toEqual(['bash', '-c', 'echo hi']);
    });

    test('darwin home-rw profile carries the home in the profile string', () => {
      const argv = maybeWrapSandboxArgv({
        profile: 'home-rw',
        cwd: CWD,
        home: '/home/op',
        innerArgv: INNER,
        platform: 'darwin',
        which: (name) => (name === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null),
      });
      expect(argv[2]).toContain('(allow file-write* (subpath "/home/op"))');
      // cwd should NOT be writable under home-rw.
      expect(argv[2]).not.toContain('(allow file-write* (subpath "/work/proj"))');
    });

    test('darwin cwd-rw-net profile carries network grant', () => {
      const argv = maybeWrapSandboxArgv({
        profile: 'cwd-rw-net',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        platform: 'darwin',
        which: (name) => (name === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null),
      });
      expect(argv[2]).toContain('(allow network*)');
    });
  });
});
