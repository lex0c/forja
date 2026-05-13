import { describe, expect, test } from 'bun:test';
import { isSandboxProfile } from '../../src/permissions/sandbox-plan.ts';
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
      env: {},
    });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('host slices innerArgv (caller-mutation defense)', () => {
    const argv = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
    });
    argv.push('mutated');
    // Calling again returns a fresh array — the previous mutation
    // didn't leak into the function's source data.
    const argv2 = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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
      env: {},
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
      const argv = buildBwrapArgv({ profile, cwd: CWD, home: HOME, innerArgv: INNER, env: {} });
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
      env: {},
    });
    const dashIdx = argv.indexOf('--');
    expect(argv.slice(dashIdx + 1)).toEqual(innerArgv);
  });

  test('empty innerArgv throws (programmer bug, fail loud)', () => {
    expect(() =>
      buildBwrapArgv({ profile: 'ro', cwd: CWD, home: HOME, innerArgv: [], env: {} }),
    ).toThrow('innerArgv must not be empty');
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
      // Slice 154 (review): argv[0] is the resolved absolute path.
      // On Linux the canonical /usr/bin/bwrap wins if present;
      // otherwise the PATH-resolved fallback applies.
      expect(argv[0]).toMatch(/bwrap$/);
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
        // Slice 154: pin exists() so canonical-first hits /usr/bin/sandbox-exec
        // deterministically regardless of host filesystem.
        exists: (p) => p === '/usr/bin/sandbox-exec',
      });
      // Slice 154 (review): argv[0] is the absolute resolved path.
      expect(argv[0]).toBe('/usr/bin/sandbox-exec');
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
        // Slice 154: deterministic absent — canonical /usr/bin/<tool>
        // must report as missing regardless of host filesystem.
        exists: () => false,
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
        // Slice 154: deterministic absent (test host may have bwrap
        // at /usr/bin/bwrap; pin to make this a true "missing" probe).
        exists: () => false,
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

// Slice 103 — R6 #9: maybeWrapSandboxArgv accepted any string as
// profile (TS cast erased at runtime). An attacker passing `'host'`
// or any unknown string in a BrokerRequest pivoted through the
// platform fallback into an unsandboxed exec. Slice 103 validates
// enum membership at the gate and throws on unknown values.
describe('maybeWrapSandboxArgv — wire validation (slice 103, R6 #9)', () => {
  test('valid profiles still wrap normally (no regression)', () => {
    for (const profile of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const argv = maybeWrapSandboxArgv({
        profile,
        cwd: CWD,
        innerArgv: INNER,
        platform: 'linux',
        which: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
      });
      // Slice 154 (review — PATH-shim resistance): argv[0] is now
      // the absolute resolved bwrap path, not the bare name. This
      // is the defense — kernel execve doesn't re-walk $PATH at
      // spawn time.
      expect(argv[0]).toBe('/usr/bin/bwrap');
    }
  });

  test("'host' still passes through (intentional passthrough)", () => {
    // host is a real enum member — operator-opted-in passthrough.
    // Validation accepts it; the runner short-circuits to
    // innerArgv (the existing branch). The defense is against
    // UNKNOWN strings, not against host itself (the engine is
    // responsible for only emitting host when authorized).
    const argv = maybeWrapSandboxArgv({
      profile: 'host',
      cwd: CWD,
      innerArgv: INNER,
      platform: 'linux',
    });
    expect(argv).toEqual([...INNER]);
  });

  test('undefined profile passes through (no-sandbox-requested shape)', () => {
    const argv = maybeWrapSandboxArgv({
      cwd: CWD,
      innerArgv: INNER,
      platform: 'linux',
    });
    expect(argv).toEqual([...INNER]);
  });

  test('unknown string profile throws with enum list', () => {
    // An attacker-crafted profile pre-slice would pivot through
    // the platform fallback and emerge unsandboxed. Now it
    // throws; the broker maps to `sandbox wrap failed: ...`.
    expect(() =>
      maybeWrapSandboxArgv({
        profile: 'attacker',
        cwd: CWD,
        innerArgv: INNER,
        platform: 'linux',
        which: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
      }),
    ).toThrow(/unknown profile 'attacker'/);
  });

  test('error message lists every supported profile', () => {
    try {
      maybeWrapSandboxArgv({
        profile: 'nope',
        cwd: CWD,
        innerArgv: INNER,
      });
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('ro');
      expect(msg).toContain('cwd-rw');
      expect(msg).toContain('cwd-rw-net');
      expect(msg).toContain('home-rw');
      expect(msg).toContain('host');
    }
  });

  test('unknown profile throws even on platforms without sandbox tooling', () => {
    // Pre-slice the no-tool fallback at line 196 silently passed
    // through ANY profile (including unknown). The validation
    // happens BEFORE the platform branches, so an attacker can't
    // pivot through the degraded path.
    expect(() =>
      maybeWrapSandboxArgv({
        profile: 'attacker',
        cwd: CWD,
        innerArgv: INNER,
        platform: 'win32' as NodeJS.Platform,
        which: () => null,
      }),
    ).toThrow(/unknown profile/);
  });
});

// Slice 118 — R4: §9 hide_paths defense in the Linux bwrap
// runner. Pre-slice every profile started with `--ro-bind / /`
// which exposed the operator's full home read-only inside the
// sandbox — the LLM could `cat ~/.ssh/id_rsa` from even a
// `ro` profile. The engine-side §11 protected paths classifier
// (slice 97) only catches calls that surface as resolved
// capabilities; a sandboxed bash process reading the file
// directly bypassed the classifier. Slice 118 emits bwrap
// flags that mask credential dirs (`--tmpfs`) and files
// (`--ro-bind /dev/null`) inside the sandbox.
describe('buildBwrapArgv — hide_paths defense (slice 118, R4)', () => {
  const expectHidePaths = (argv: readonly string[]): void => {
    const argvStr = argv.join(' ');
    // Per PERMISSION_ENGINE.md §9 the canonical dir list.
    expect(argvStr).toContain('--tmpfs /home/op/.ssh');
    expect(argvStr).toContain('--tmpfs /home/op/.aws');
    expect(argvStr).toContain('--tmpfs /home/op/.config/gcloud');
    expect(argvStr).toContain('--tmpfs /home/op/.gnupg');
    expect(argvStr).toContain('--tmpfs /home/op/.kube');
    // Slice 149 (review): rustup toolchain + subversion auth cache.
    expect(argvStr).toContain('--tmpfs /home/op/.rustup');
    expect(argvStr).toContain('--tmpfs /home/op/.subversion/auth');
    // Canonical file list — masked via /dev/null overlay.
    expect(argvStr).toContain('--ro-bind-try /dev/null /home/op/.netrc');
    expect(argvStr).toContain('--ro-bind-try /dev/null /home/op/.docker/config.json');
    expect(argvStr).toContain('--ro-bind-try /dev/null /home/op/.npmrc');
    expect(argvStr).toContain('--ro-bind-try /dev/null /home/op/.pypirc');
    // Slice 149 (review): gitconfig (executable hooks) + cargo
    // credentials.toml (crates.io API token).
    expect(argvStr).toContain('--ro-bind-try /dev/null /home/op/.gitconfig');
    expect(argvStr).toContain('--ro-bind-try /dev/null /home/op/.cargo/credentials.toml');
  };

  test('ro profile emits hide_paths flags', () => {
    const argv = buildBwrapArgv({ profile: 'ro', cwd: CWD, home: HOME, innerArgv: INNER, env: {} });
    expectHidePaths(argv);
  });

  test('cwd-rw profile emits hide_paths flags', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
    });
    expectHidePaths(argv);
  });

  test('cwd-rw-net profile emits hide_paths flags', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw-net',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
    });
    expectHidePaths(argv);
  });

  test('home-rw profile emits hide_paths flags (load-bearing — home is writable)', () => {
    // home-rw is the most exposed profile: full home is mounted
    // read-write. Without the hide_paths overlay the LLM could
    // not only READ but also WRITE to ~/.ssh/authorized_keys etc.
    // Pin that the tmpfs overlays still mask these — applied
    // AFTER `--bind home home` in the argv so the later mount wins.
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
    });
    expectHidePaths(argv);
    // Verify the order: --bind home home appears BEFORE --tmpfs
    // home/.ssh. bwrap applies in argv order; the tmpfs MUST be
    // later or the rw bind would overwrite the mask.
    const bindIdx = argv.indexOf('--bind');
    const tmpfsSshIdx = argv.findIndex(
      (v, i) => v === '--tmpfs' && argv[i + 1] === '/home/op/.ssh',
    );
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(tmpfsSshIdx).toBeGreaterThan(bindIdx);
  });

  test('host profile does NOT emit hide_paths flags (passthrough)', () => {
    // Host is the operator-opted-in passthrough; no bwrap wrap,
    // no flags. The hide_paths defense doesn't apply because
    // the inner process runs directly on the host.
    const argv = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
    });
    // Should be just innerArgv, no bwrap.
    expect(argv).toEqual([...INNER]);
  });

  test('hide_paths use operator-supplied home, not host HOME env', () => {
    // The defense follows the operator's chosen home value, not
    // process.env.HOME. Tests pinning macOS home shape against
    // a Linux runner stay reliable.
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: '/work/macproj',
      home: '/Users/devloper',
      innerArgv: INNER,
      env: {},
    });
    const argvStr = argv.join(' ');
    expect(argvStr).toContain('--tmpfs /Users/devloper/.ssh');
    expect(argvStr).toContain('--ro-bind-try /dev/null /Users/devloper/.netrc');
  });
});

describe('isSandboxProfile (slice 103)', () => {
  test('returns true for every enum member', () => {
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw', 'host']) {
      expect(isSandboxProfile(p)).toBe(true);
    }
  });

  test('returns false for unknown strings', () => {
    expect(isSandboxProfile('attacker')).toBe(false);
    expect(isSandboxProfile('')).toBe(false);
    expect(isSandboxProfile('RO')).toBe(false); // case-sensitive
  });

  test('returns false for non-strings', () => {
    expect(isSandboxProfile(null)).toBe(false);
    expect(isSandboxProfile(undefined)).toBe(false);
    expect(isSandboxProfile(42)).toBe(false);
    expect(isSandboxProfile({})).toBe(false);
  });
});

// Slice 125 (R2 P0-4) + Slice 127 (R3): cwd-in-hide_paths precondition
// refuse + boundary semantics.
describe('buildBwrapArgv — cwd inside hide_paths dir (slice 125, R3 P1 coverage)', () => {
  test('refuses when cwd === a hide_paths dir', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/home/op/.ssh',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      }),
    ).toThrow(/inside hide_paths dir/);
  });

  test('refuses when cwd is INSIDE a hide_paths dir', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/home/op/.ssh/audit',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      }),
    ).toThrow(/inside hide_paths dir/);
  });

  test('does NOT refuse for a sibling whose name shares a prefix with a hide_paths dir', () => {
    // R3 P2: pin the boundary. `~/.ssh-backup` is NOT inside
    // `~/.ssh` (different segment); the `${hiddenAbs}/` suffix
    // in the startsWith check protects against this.
    expect(() =>
      buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/home/op/.ssh-backup',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      }),
    ).not.toThrow();
  });

  test('does NOT refuse when cwd is outside all hide_paths dirs', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/home/op/work',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      }),
    ).not.toThrow();
  });

  test('host profile bypasses the guard (innerArgv passthrough)', () => {
    // Host profile short-circuits before the hide_paths check
    // because the runner returns innerArgv unchanged.
    expect(() =>
      buildBwrapArgv({
        profile: 'host',
        cwd: '/home/op/.ssh',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      }),
    ).not.toThrow();
  });
});

// Slice 140 sec-1: XDG_DATA_HOME unmask. `defaultDataDir()` honors
// $XDG_DATA_HOME at runtime; without an XDG-aware tmpfs overlay
// the canonical literal `.local/share/forja` covers the WRONG
// path when the operator sets XDG to anything else, and the
// sandboxed process on `home-rw` would have writable access to
// the live audit DB at the XDG location.
describe('buildBwrapArgv — XDG_DATA_HOME unmask defense (slice 140 sec-1)', () => {
  const originalXdg = process.env.XDG_DATA_HOME;

  // Restore env in afterEach to avoid leaking state.
  const restoreEnv = (): void => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
  };

  test('XDG_DATA_HOME unset: no extra tmpfs beyond the canonical home-relative literal', () => {
    delete process.env.XDG_DATA_HOME;
    try {
      const argv = buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/work/proj',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      });
      const argvStr = argv.join(' ');
      // The canonical home-relative overlay IS present.
      expect(argvStr).toContain('--tmpfs /home/op/.local/share/forja');
      // No extra tmpfs for an XDG path (count occurrences of
      // `.local/share/forja` — exactly one).
      const matches = argv.filter(
        (v) => v.endsWith('/share/forja') || v.includes('share/forja '),
      ).length;
      expect(matches).toBeGreaterThan(0);
    } finally {
      restoreEnv();
    }
  });

  test('XDG_DATA_HOME set to a NON-HOME path: extra tmpfs overlay added for the live data dir', () => {
    process.env.XDG_DATA_HOME = '/tmp/data';
    try {
      const argv = buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/work/proj',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      });
      const argvStr = argv.join(' ');
      // Both overlays present: the canonical home-relative one
      // (always there from HIDE_PATHS_DIRS) AND the XDG-driven
      // one (added by the sec-1 fix).
      expect(argvStr).toContain('--tmpfs /home/op/.local/share/forja');
      expect(argvStr).toContain('--tmpfs /tmp/data/forja');
    } finally {
      restoreEnv();
    }
  });

  test('XDG_DATA_HOME set to the home-relative default: no duplicate overlay', () => {
    // When XDG matches the default, the live data dir EQUALS the
    // home-relative path and the sec-1 fix skips the extra overlay
    // (de-dup at the path-string level).
    process.env.XDG_DATA_HOME = '/home/op/.local/share';
    try {
      const argv = buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/work/proj',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
      });
      // Count tmpfs flags pointing at the data dir (`share/forja`).
      // Should be exactly 1: the canonical home-relative one. sec-1
      // skipped because liveDataDir === homeRelativeDataDir. Filter
      // by `share/forja` specifically — `.config/forja` is a
      // separate HIDE_PATHS_DIRS entry that also ends with `/forja`.
      const dataDirTmpfsCount = argv.filter(
        (v, i) => v === '--tmpfs' && argv[i + 1]?.endsWith('/share/forja'),
      ).length;
      expect(dataDirTmpfsCount).toBe(1);
    } finally {
      restoreEnv();
    }
  });
});

// Slice 146 (review minor): XDG_CONFIG_HOME unmask — same shape as
// slice 140 sec-1 but for the config-XDG root. The 6 `.config/*`
// HIDE_PATHS_DIRS entries (gcloud, azure, op, sops, agent, forja)
// all live under `$XDG_CONFIG_HOME/<sub>` when the operator
// relocates the config dir away from `~/.config`. Pre-slice the
// bwrap overlay masked `<home>/.config/<sub>` while the REAL
// credentials sat at the relocated XDG path. Build-time overlay
// closes the gap.
describe('buildBwrapArgv — XDG_CONFIG_HOME unmask defense (slice 146)', () => {
  const restoreEnv = (): void => {
    delete process.env.XDG_CONFIG_HOME;
  };

  test('XDG_CONFIG_HOME unset: only canonical home-relative overlays', () => {
    delete process.env.XDG_CONFIG_HOME;
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: INNER,
      env: {},
    });
    const argvStr = argv.join(' ');
    // The canonical home-relative overlays ARE present.
    expect(argvStr).toContain('--tmpfs /home/op/.config/gcloud');
    expect(argvStr).toContain('--tmpfs /home/op/.config/forja');
    // No tmpfs pointing at `/srv/conf/...` etc. (XDG unset).
    expect(argvStr).not.toContain('/srv/conf');
  });

  test('XDG_CONFIG_HOME relocated: extra overlay for each .config/* entry', () => {
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: INNER,
      env: { XDG_CONFIG_HOME: '/srv/conf' },
    });
    const argvStr = argv.join(' ');
    // Canonical home-relative overlays still present (defense
    // against process-env override at runtime).
    expect(argvStr).toContain('--tmpfs /home/op/.config/gcloud');
    expect(argvStr).toContain('--tmpfs /home/op/.config/azure');
    expect(argvStr).toContain('--tmpfs /home/op/.config/op');
    expect(argvStr).toContain('--tmpfs /home/op/.config/sops');
    expect(argvStr).toContain('--tmpfs /home/op/.config/agent');
    expect(argvStr).toContain('--tmpfs /home/op/.config/forja');
    // Plus the XDG-relocated overlays, one per .config/* entry.
    expect(argvStr).toContain('--tmpfs /srv/conf/gcloud');
    expect(argvStr).toContain('--tmpfs /srv/conf/azure');
    expect(argvStr).toContain('--tmpfs /srv/conf/op');
    expect(argvStr).toContain('--tmpfs /srv/conf/sops');
    expect(argvStr).toContain('--tmpfs /srv/conf/agent');
    expect(argvStr).toContain('--tmpfs /srv/conf/forja');
  });

  test('XDG_CONFIG_HOME equal to home-relative default: no duplicate overlays', () => {
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: INNER,
      env: { XDG_CONFIG_HOME: '/home/op/.config' },
    });
    // Each .config/* HIDE entry should produce EXACTLY one
    // --tmpfs. Slice 146 skipped because effective path matches
    // the home-relative default.
    const gcloudTmpfsCount = argv.filter(
      (v, i) => v === '--tmpfs' && argv[i + 1] === '/home/op/.config/gcloud',
    ).length;
    expect(gcloudTmpfsCount).toBe(1);
  });

  test('XDG_CONFIG_HOME with non-absolute value is ignored (defensive)', () => {
    // Relative XDG paths are spec-illegal; treat as unset to avoid
    // building an undefined overlay. POSIX consumers also skip.
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: INNER,
      env: { XDG_CONFIG_HOME: 'relative/path' },
    });
    const argvStr = argv.join(' ');
    expect(argvStr).not.toContain('relative/path');
  });

  test('XDG_CONFIG_HOME empty string is ignored', () => {
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: INNER,
      env: { XDG_CONFIG_HOME: '' },
    });
    // No extra overlays beyond the canonical home-relative ones.
    const gcloudTmpfsCount = argv.filter(
      (v, i) => v === '--tmpfs' && argv[i + 1] === '/home/op/.config/gcloud',
    ).length;
    expect(gcloudTmpfsCount).toBe(1);
  });

  // Restore env in afterAll so other test files don't see leakage.
  // No beforeEach reset needed — each test sets XDG explicitly.
  test('cleanup: restore process.env.XDG_CONFIG_HOME', () => {
    restoreEnv();
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
  });
});

// Slice 145 (S1 — sandbox hardening): the four sandboxed profiles
// MUST unshare UTS / IPC / cgroup namespaces and start a new
// session. Pre-slice only pid was unshared, leaving four escape
// surfaces (hostname leak via UTS, SysV IPC / POSIX shm probes,
// cgroup hierarchy visibility, and the most-severe TIOCSTI
// keystroke injection back into the operator's controlling tty).
// Pin each flag's presence so a future refactor of
// `COMMON_PROFILE_FLAGS` can't silently drop one.
describe('buildBwrapArgv — slice 145 S1 namespace + session isolation', () => {
  test.each(['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const)(
    '%s profile includes --unshare-uts / --unshare-ipc / --unshare-cgroup-try / --new-session',
    (profile) => {
      const argv = buildBwrapArgv({ profile, cwd: CWD, home: HOME, innerArgv: INNER, env: {} });
      expect(argv).toContain('--unshare-uts');
      expect(argv).toContain('--unshare-ipc');
      expect(argv).toContain('--unshare-cgroup-try');
      expect(argv).toContain('--new-session');
    },
  );

  test('host profile remains a verbatim passthrough (no bwrap flags)', () => {
    const argv = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
    });
    expect(argv).toEqual([...INNER]);
    expect(argv).not.toContain('--new-session');
    expect(argv).not.toContain('--unshare-uts');
  });
});

// Slice 145 (S2 — env-scrub defense in depth): bwrap should apply
// `--clearenv` and rebuild the env from a narrow allowlist via
// `--setenv KEY VALUE`. Pre-slice the wrapped process inherited
// the parent's env verbatim — userspace `scrubEnv` was the only
// defense, and any future spawn site that forgot to call it
// collapsed the boundary. Pin: clearenv present, allowed vars
// forwarded, disallowed vars NOT forwarded.
describe('buildBwrapArgv — slice 145 S2 env allowlist via --clearenv + --setenv', () => {
  test.each(['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const)(
    '%s profile starts with --clearenv',
    (profile) => {
      const argv = buildBwrapArgv({ profile, cwd: CWD, home: HOME, innerArgv: INNER, env: {} });
      expect(argv).toContain('--clearenv');
    },
  );

  test('allowed vars (PATH/HOME/USER/LANG/TZ etc.) flow through as --setenv', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/op',
        USER: 'op',
        LANG: 'en_US.UTF-8',
        TZ: 'UTC',
        SHELL: '/bin/bash',
      },
    });
    // Each var should appear as `--setenv KEY VALUE` in argv order.
    const setenvAt = (key: string, value: string): boolean => {
      for (let i = 0; i < argv.length - 2; i++) {
        if (argv[i] === '--setenv' && argv[i + 1] === key && argv[i + 2] === value) return true;
      }
      return false;
    };
    expect(setenvAt('PATH', '/usr/bin:/bin')).toBe(true);
    expect(setenvAt('HOME', '/home/op')).toBe(true);
    expect(setenvAt('USER', 'op')).toBe(true);
    expect(setenvAt('LANG', 'en_US.UTF-8')).toBe(true);
    expect(setenvAt('TZ', 'UTC')).toBe(true);
    expect(setenvAt('SHELL', '/bin/bash')).toBe(true);
  });

  test('dangerous vars (LD_PRELOAD, NODE_OPTIONS, PYTHONPATH, HTTPS_PROXY) are NOT forwarded', () => {
    // Even when the env carries them (e.g. caller forgot scrubEnv,
    // or the operator's shell has them set legitimately), the
    // sandbox allowlist drops them — kernel-level defense in depth.
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {
        LD_PRELOAD: '/tmp/evil.so',
        LD_LIBRARY_PATH: '/tmp/lib',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        NODE_OPTIONS: '--require /tmp/x.js',
        PYTHONPATH: '/tmp/py',
        PYTHONSTARTUP: '/tmp/start.py',
        BASH_ENV: '/tmp/bashenv',
        HTTPS_PROXY: 'http://attacker.example.com',
        HTTP_PROXY: 'http://attacker.example.com',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        AWS_SECRET_ACCESS_KEY: 'leaked',
        PATH: '/usr/bin', // control: allowed, must still appear
      },
    });
    const setenvKeys: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--setenv') setenvKeys.push(argv[i + 1] as string);
    }
    expect(setenvKeys).toContain('PATH');
    // None of these dangerous vars should appear.
    expect(setenvKeys).not.toContain('LD_PRELOAD');
    expect(setenvKeys).not.toContain('LD_LIBRARY_PATH');
    expect(setenvKeys).not.toContain('DYLD_INSERT_LIBRARIES');
    expect(setenvKeys).not.toContain('NODE_OPTIONS');
    expect(setenvKeys).not.toContain('PYTHONPATH');
    expect(setenvKeys).not.toContain('PYTHONSTARTUP');
    expect(setenvKeys).not.toContain('BASH_ENV');
    expect(setenvKeys).not.toContain('HTTPS_PROXY');
    expect(setenvKeys).not.toContain('HTTP_PROXY');
    expect(setenvKeys).not.toContain('SSH_AUTH_SOCK');
    expect(setenvKeys).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  test('env vars containing a NUL byte are skipped (bwrap argv cannot carry them)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {
        PATH: '/usr/bin',
        // Synthesized NUL — could happen if a tool exports a
        // malformed value. Skip rather than crash bwrap.
        HOME: '/home/op /extra',
      },
    });
    const setenvKeys: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--setenv') setenvKeys.push(argv[i + 1] as string);
    }
    expect(setenvKeys).toContain('PATH');
    expect(setenvKeys).not.toContain('HOME');
  });

  test('empty env still applies --clearenv (every spawn is shaped)', () => {
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
    });
    expect(argv).toContain('--clearenv');
    const setenvCount = argv.filter((v) => v === '--setenv').length;
    expect(setenvCount).toBe(0);
  });
});
