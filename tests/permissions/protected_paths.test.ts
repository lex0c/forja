import { describe, expect, test } from 'bun:test';
import {
  allProtectedRoots,
  classifyProtectedPath,
  isDevSafe,
  isGlobSafeRunCarveout,
  protectedTargets,
} from '../../src/permissions/protected_paths.ts';

const HOME = '/home/op';
const CWD = '/work/proj';

describe('classifyProtectedPath — system deny tier', () => {
  test.each([
    ['/proc', 'read'],
    ['/proc', 'write'],
    ['/proc/1/environ', 'read'],
    ['/proc/cpuinfo', 'write'],
    ['/sys', 'read'],
    ['/sys/class/net', 'read'],
    ['/boot', 'write'],
    ['/boot/vmlinuz', 'read'],
  ] as const)('%s (op=%s) → deny', (absPath, op) => {
    expect(classifyProtectedPath({ absPath, op, home: HOME, cwd: CWD })).toBe('deny');
  });

  test('look-alike paths do not match (segment-boundary aware)', () => {
    // `/procfoo` is NOT inside /proc — segment-boundary check.
    expect(
      classifyProtectedPath({ absPath: '/procfoo', op: 'write', home: HOME, cwd: CWD }),
    ).toBeNull();
    expect(
      classifyProtectedPath({ absPath: '/systemd-something', op: 'read', home: HOME, cwd: CWD }),
    ).toBeNull();
  });

  // Carve-outs from the /run deny prefix. Real user-facing paths
  // live under /run on modern Linux: removable media mount points
  // (udisks2 default surface) and XDG_RUNTIME_DIR (per-user
  // tmpfs). Pre-fix every read or write under either prefix
  // landed as deny tier, including operators with their workspace
  // on an external drive (e.g. /run/media/<user>/<volume>/repo)
  // — the .gitignore in such a repo was deny-tier protected and
  // every edit was refused with no modal escape hatch.
  test.each([
    // Removable media — udisks2 mounts at /run/media/<user>/<volume>.
    ['/run/media/lex/disk/Workspaces/forja/.gitignore', 'read'],
    ['/run/media/lex/disk/Workspaces/forja/.gitignore', 'write'],
    ['/run/media/alice/usb/notes.md', 'write'],
    // Regular files under XDG_RUNTIME_DIR — apps drop per-session
    // config/cache here. These should pass the engine's normal
    // allow/confirm/deny chain (not pre-emptively deny-tier).
    ['/run/user/1000/myapp/cache.json', 'write'],
    ['/run/user/1000/forja/lockfile', 'read'],
  ] as const)('%s (op=%s) → null (user-owned carve-out under /run)', (absPath, op) => {
    expect(classifyProtectedPath({ absPath, op, home: HOME, cwd: CWD })).toBeNull();
  });

  test.each([
    ['/run/postgresql/.s.PGSQL.5432', 'read'],
    ['/run/dbus/system_bus_socket', 'write'],
    ['/run/systemd/private', 'write'],
    ['/var/run/docker.sock', 'write'],
  ] as const)('%s (op=%s) → deny (privileged daemon socket, NOT in carve-out)', (absPath, op) => {
    expect(classifyProtectedPath({ absPath, op, home: HOME, cwd: CWD })).toBe('deny');
  });

  // Post-review: the /run/user carve-out used to re-admit EVERY
  // path under XDG_RUNTIME_DIR, including the user-scoped IPC
  // sockets the /run deny tier was specifically meant to block.
  // Narrow the carve-out: regular files pass (test above), but
  // ssh-agent, gpg-agent, user dbus, podman, Wayland, etc. stay
  // denied.
  test.each([
    // gnupg sockets: S.gpg-agent, S.gpg-agent.ssh, S.scdaemon, S.dirmngr
    ['/run/user/1000/gnupg/S.gpg-agent', 'read'],
    ['/run/user/1000/gnupg/S.gpg-agent.ssh', 'write'],
    ['/run/user/1000/gnupg/S.scdaemon', 'read'],
    // gnome-keyring (incl. SSH agent surrogate)
    ['/run/user/1000/keyring/ssh', 'read'],
    ['/run/user/1000/keyring/control', 'write'],
    // User dbus (modern systemd) + legacy / internal variants
    ['/run/user/1000/bus', 'read'],
    ['/run/user/1000/dbus-1/session', 'read'],
    ['/run/user/1000/dbus-session', 'read'],
    // Container daemons
    ['/run/user/1000/podman/podman.sock', 'write'],
    ['/run/user/1000/docker.sock', 'write'],
    // Wayland display sockets (top-level files, not subdirs)
    ['/run/user/1000/wayland-0', 'write'],
    ['/run/user/1000/wayland-0.lock', 'read'],
    ['/run/user/1000/wayland-1', 'read'],
    // PulseAudio + PipeWire
    ['/run/user/1000/pulse/native', 'read'],
    ['/run/user/1000/pipewire-0', 'write'],
    ['/run/user/1000/pipewire-0-manager', 'write'],
    // User systemd manager (notify socket, runtime units, etc.)
    ['/run/user/1000/systemd/notify', 'write'],
    ['/run/user/1000/systemd/units/.timer', 'read'],
  ] as const)(
    '%s (op=%s) → deny (XDG_RUNTIME_DIR IPC endpoint stays blocked under carve-out)',
    (absPath, op) => {
      expect(classifyProtectedPath({ absPath, op, home: HOME, cwd: CWD })).toBe('deny');
    },
  );
});

describe('classifyProtectedPath — escalate tier (writes only)', () => {
  test.each(['/etc', '/etc/hosts', '/etc/passwd', '/etc/forja/policy.toml'])(
    'absolute escalate root %s',
    (absPath) => {
      expect(classifyProtectedPath({ absPath, op: 'write', home: HOME, cwd: CWD })).toBe(
        'escalate',
      );
      expect(classifyProtectedPath({ absPath, op: 'read', home: HOME, cwd: CWD })).toBeNull();
    },
  );

  test.each(['/home/op/.bashrc', '/home/op/.zshrc', '/home/op/.profile', '/home/op/.bash_profile'])(
    'tilde escalate file %s',
    (absPath) => {
      expect(classifyProtectedPath({ absPath, op: 'write', home: HOME, cwd: CWD })).toBe(
        'escalate',
      );
      expect(classifyProtectedPath({ absPath, op: 'read', home: HOME, cwd: CWD })).toBeNull();
    },
  );

  test.each([
    '/home/op/.config/forja',
    '/home/op/.config/forja/policy.yaml',
    '/home/op/.config/claude',
    '/home/op/.config/claude/install_id',
  ])('tilde escalate dir %s', (absPath) => {
    expect(classifyProtectedPath({ absPath, op: 'write', home: HOME, cwd: CWD })).toBe('escalate');
  });

  test.each([
    '/work/proj/.git',
    '/work/proj/.git/HEAD',
    '/work/proj/.git/refs/heads/main',
    '/work/proj/.forja',
    '/work/proj/.forja/sessions.db',
    '/work/proj/.claude',
    '/work/proj/.claude/settings.json',
  ])('cwd escalate dir %s', (absPath) => {
    expect(classifyProtectedPath({ absPath, op: 'write', home: HOME, cwd: CWD })).toBe('escalate');
  });

  test('reads of escalate-tier paths return null (not restricted)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/work/proj/.git/HEAD',
        op: 'read',
        home: HOME,
        cwd: CWD,
      }),
    ).toBeNull();
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.bashrc',
        op: 'read',
        home: HOME,
        cwd: CWD,
      }),
    ).toBeNull();
  });

  test('unprotected paths classify as null', () => {
    expect(
      classifyProtectedPath({
        absPath: '/work/proj/src/index.ts',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBeNull();
    expect(
      classifyProtectedPath({
        absPath: '/home/op/notes.md',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBeNull();
  });

  test('cwd-relative dirs honor the supplied cwd (not host process cwd)', () => {
    // .git inside /work/other/.git should NOT classify under cwd=/work/proj
    expect(
      classifyProtectedPath({
        absPath: '/work/other/.git/HEAD',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBeNull();
    expect(
      classifyProtectedPath({
        absPath: '/work/other/.git/HEAD',
        op: 'write',
        home: HOME,
        cwd: '/work/other',
      }),
    ).toBe('escalate');
  });

  test('tilde dirs honor the supplied home (not host process HOME)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/other/.bashrc',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBeNull();
    expect(
      classifyProtectedPath({
        absPath: '/home/other/.bashrc',
        op: 'write',
        home: '/home/other',
        cwd: CWD,
      }),
    ).toBe('escalate');
  });
});

describe('protectedTargets', () => {
  test('resolves tilde and cwd entries against supplied roots', () => {
    const t = protectedTargets(HOME, CWD);
    // Slice 180: `/run` and `/var/run` added (runtime sockets —
    // docker.sock / postgresql.sock / dbus). Order matches the
    // declared array order in protected_paths.ts.
    expect(t.systemDeny).toEqual(['/proc', '/sys', '/boot', '/dev', '/run', '/var/run']);
    expect(t.absoluteEscalate).toEqual(['/etc']);
    expect(t.tildeEscalateFiles).toContain('/home/op/.bashrc');
    expect(t.tildeEscalateFiles).toContain('/home/op/.zshrc');
    expect(t.tildeEscalateDirs).toContain('/home/op/.config/forja');
    expect(t.cwdEscalateDirs).toContain('/work/proj/.git');
    expect(t.cwdEscalateDirs).toContain('/work/proj/.forja');
    expect(t.cwdEscalateDirs).toContain('/work/proj/.claude');
    // Default namespace: no foreign deny root.
    expect(t.cwdForeignDenyDirs).toEqual([]);
  });

  test('under a profile, surfaces the foreign canonical .forja deny root (for the glob guard)', () => {
    // The bash glob guard consumes protectedTargets, so the foreign deny must
    // appear here too (not just in classifyProtectedPath) — else a glob like
    // `.forja/*` / `../.forja/*` slips the protected-glob refuse in
    // sandbox-host / in-process runs. Synthetic cwd ⇒ resolveRepoRoot falls
    // back to cwd; the repo-root anchoring for a subdir is covered by the
    // real-git shakeout. The active `.forja-<profile>/` is NOT foreign.
    const prev = process.env.FORJA_PROFILE;
    process.env.FORJA_PROFILE = 'dev';
    const cwd = '/work/profiled-targets';
    try {
      const t = protectedTargets(HOME, cwd);
      expect(t.cwdForeignDenyDirs).toContain(`${cwd}/.forja`);
      expect(t.cwdForeignDenyDirs).not.toContain(`${cwd}/.forja-dev`);
    } finally {
      if (prev === undefined) delete process.env.FORJA_PROFILE;
      else process.env.FORJA_PROFILE = prev;
    }
  });
});

describe('allProtectedRoots', () => {
  test('returns the union of all tiers as absolute strings', () => {
    const roots = allProtectedRoots(HOME, CWD);
    expect(roots).toContain('/proc');
    expect(roots).toContain('/etc');
    expect(roots).toContain('/home/op/.bashrc');
    expect(roots).toContain('/work/proj/.git');
  });
});

// Slice 97 — R2 protected paths hardening. Three coordinated
// changes land here: `/dev` joins the system deny tier, the cred
// dirs `.ssh` / `.aws` / `.gnupg` / `.kube` join the tilde escalate
// dir list, and `.netrc` / `.npmrc` join the tilde escalate file
// list. These coverage tests pin each addition so a refactor that
// drops one is loud rather than silent.
describe('classifyProtectedPath — slice 97 additions (R2 P0/P1)', () => {
  test('/dev write denies (slice 97, R2 #12)', () => {
    // write_file('/dev/sda') would overwrite a raw disk — kernel-
    // managed pseudofs, never a legitimate LLM target.
    expect(classifyProtectedPath({ absPath: '/dev/sda', op: 'write', home: HOME, cwd: CWD })).toBe(
      'deny',
    );
  });

  test('/dev read also denies (system pseudofs, not just writes)', () => {
    // Spec §11 deny tier applies to reads AND writes. `/dev/tcp/...`
    // is the reverse-shell-via-redirect shape; refusing reads
    // closes that bypass.
    expect(
      classifyProtectedPath({ absPath: '/dev/tcp/attacker/80', op: 'read', home: HOME, cwd: CWD }),
    ).toBe('deny');
  });

  test('/dev exact-segment match (not /devfoo)', () => {
    // `startsWithSegment` invariant — `/devfoo` is NOT under /dev,
    // and a future kernel pseudofs `/devel` would survive renaming
    // without colliding with this protected entry.
    expect(
      classifyProtectedPath({ absPath: '/devfoo', op: 'write', home: HOME, cwd: CWD }),
    ).toBeNull();
  });

  test('~/.ssh/* escalates on write (slice 97, R2 P1)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.ssh/authorized_keys',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.ssh/* reads pass through (operator legitimately enumerates known_hosts)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.ssh/known_hosts',
        op: 'read',
        home: HOME,
        cwd: CWD,
      }),
    ).toBeNull();
  });

  test('~/.aws/credentials escalates on write', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.aws/credentials',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.gnupg/private-keys-v1.d escalates on write', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.gnupg/private-keys-v1.d/abc.key',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.kube/config escalates on write', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.kube/config',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.netrc file escalates on write (credential injection defense)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.netrc',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.npmrc file escalates on write', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.npmrc',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });
});

// Slice 180 — protected-path expansions. Three categories:
//   1. SYSTEM_DENY: `/run` + `/var/run` (runtime sockets like
//      docker.sock / postgresql.sock / dbus).
//   2. TILDE_ESCALATE_FILES: shell variants (`.zshenv`, `.zprofile`,
//      `.bash_aliases`, `.config/fish/config.fish`, `.tmux.conf`,
//      `.inputrc`) + sync with HIDE_PATHS_FILES (`.gitconfig`,
//      `.docker/config.json`, `.cargo/credentials.toml`,
//      `.git-credentials`, `.pypirc`, `.boto`).
//   3. TILDE_ESCALATE_DIRS: sync with HIDE_PATHS_DIRS (10 dirs
//      that were sandbox-masked but engine-allowed pre-slice).
describe('classifyProtectedPath — slice 180 additions', () => {
  test('/var/run write denies (docker.sock + similar privileged sockets)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/var/run/docker.sock',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('deny');
  });

  test('/run write denies (systemd-host postgresql/dbus sockets)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/run/postgresql/.s.PGSQL.5432',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('deny');
  });

  test('/var/run READ also denies (socket file metadata leak)', () => {
    // Reads of socket files leak daemon state and presence.
    // SYSTEM_DENY applies to both ops.
    expect(
      classifyProtectedPath({
        absPath: '/var/run/docker.sock',
        op: 'read',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('deny');
  });

  test('~/.zshenv escalates on write (sourced in EVERY zsh invocation)', () => {
    // `.zshenv` loads in non-interactive `zsh -c "..."` too;
    // RCE on any zsh subprocess after a poisoned write.
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.zshenv',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.gitconfig escalates on write (slice 180 — sync with HIDE_PATHS)', () => {
    // Pre-slice .gitconfig was in HIDE_PATHS_FILES (sandbox-side)
    // but NOT in TILDE_ESCALATE_FILES (engine-side). A write via
    // fs tool in degraded/host profile bypassed both. Fixed.
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.gitconfig',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.docker/config.json escalates on write (registry auth + credsStore RCE)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.docker/config.json',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.cargo/credentials.toml escalates on write (crates.io token)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.cargo/credentials.toml',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.config/gcloud/* escalates on write (slice 180 — was HIDE_PATHS-only)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.config/gcloud/credentials.db',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.config/azure/* escalates on write', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.config/azure/azureProfile.json',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.terraform.d/* escalates on write', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.terraform.d/credentials.tfrc.json',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.rustup/* escalates on write (default-toolchain hijack vector)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.rustup/settings.toml',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.tmux.conf escalates on write (run-shell directive is RCE)', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.tmux.conf',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });

  test('~/.config/fish/config.fish escalates on write', () => {
    expect(
      classifyProtectedPath({
        absPath: '/home/op/.config/fish/config.fish',
        op: 'write',
        home: HOME,
        cwd: CWD,
      }),
    ).toBe('escalate');
  });
});

describe('isGlobSafeRunCarveout — removable-media glob carve-out', () => {
  test.each(['/run/media/op', '/run/media/op/extdrive', '/run/media/op/extdrive/proj/src'])(
    '%s is a glob-safe carve-out (true)',
    (p) => {
      expect(isGlobSafeRunCarveout(p)).toBe(true);
    },
  );

  test.each([
    '/run', // the deny root itself
    // The bare segment, NOT a glob-safe prefix: it comes from `/run/media*`,
    // whose `*` extends the `media` segment to siblings (`/run/mediaevil`)
    // directly under the /run deny zone. Must fall through to the deny scan.
    '/run/media',
    '/run/user', // XDG runtime — globs stay conservative (sockets)
    '/run/user/1000',
    '/run/user/1000/gnupg',
    '/run/dbus', // privileged system socket dir
    '/run/systemd',
    '/run/mediafoo', // shares a byte-prefix with /run/media but NOT a path segment
    '/home/op', // unrelated
    '/etc',
  ])('%s is NOT a glob-safe carve-out (false)', (p) => {
    expect(isGlobSafeRunCarveout(p)).toBe(false);
  });
});

describe('isDevSafe — /dev pseudo-device deny carve-out', () => {
  const HOME = '/home/op';
  const CWD = '/work/proj';

  test.each([
    '/dev/null',
    '/dev/zero',
    '/dev/full',
    '/dev/random',
    '/dev/urandom',
    '/dev/tty',
    '/dev/stdin',
    '/dev/stdout',
    '/dev/stderr',
    '/dev/fd/3',
  ])('%s is a safe pseudo-device (true)', (p) => {
    expect(isDevSafe(p)).toBe(true);
  });

  test.each([
    '/dev/sda', // block device
    '/dev/sda1',
    '/dev/mem', // raw memory
    '/dev/kmem',
    '/dev/port',
    '/dev/tcp/evil.com/80', // bash-virtual network (reverse shell)
    '/dev/udp/evil.com/53',
    '/dev/nullfoo', // byte-prefix of /dev/null, NOT the device
    '/dev', // the dir itself
    '/dev/fd', // the dir, not an fd
  ])('%s is NOT a safe pseudo-device (false)', (p) => {
    expect(isDevSafe(p)).toBe(false);
  });

  test('classifyProtectedPath does NOT deny safe /dev pseudo-devices (read AND write)', () => {
    for (const op of ['read', 'write'] as const) {
      expect(classifyProtectedPath({ absPath: '/dev/null', op, home: HOME, cwd: CWD })).toBeNull();
      expect(
        classifyProtectedPath({ absPath: '/dev/urandom', op, home: HOME, cwd: CWD }),
      ).toBeNull();
      expect(classifyProtectedPath({ absPath: '/dev/fd/2', op, home: HOME, cwd: CWD })).toBeNull();
    }
  });

  test('classifyProtectedPath STILL denies dangerous /dev nodes (block dev, mem, tcp/udp, dir)', () => {
    for (const p of [
      '/dev/sda',
      '/dev/mem',
      '/dev/tcp/evil/80',
      '/dev/udp/evil/53',
      '/dev/nullfoo',
      '/dev',
    ]) {
      expect(classifyProtectedPath({ absPath: p, op: 'write', home: HOME, cwd: CWD })).toBe('deny');
      expect(classifyProtectedPath({ absPath: p, op: 'read', home: HOME, cwd: CWD })).toBe('deny');
    }
  });
});

// Dev-mode read floor: under a profile, the canonical `.forja/` is FOREIGN —
// the operator's real project state — and is DENIED for READ and WRITE so a
// profiled session can neither disclose nor touch it. The active
// `.forja-<profile>/` is the session's own: writes escalate (confirm), reads
// pass. On the default namespace `.forja/` is the active dir (covered by the
// escalate-tier tests above), so there's no foreign dir and behavior is
// unchanged.
describe('classifyProtectedPath — profile isolates the foreign canonical .forja/', () => {
  test('under FORJA_PROFILE: canonical .forja/ DENIED (read+write); active .forja-<profile>/ escalates writes, reads pass', () => {
    const prev = process.env.FORJA_PROFILE;
    process.env.FORJA_PROFILE = 'dev';
    // Fresh cwd so the (home,cwd)-keyed target cache can't serve a no-profile
    // entry from an earlier test (profile is frozen per process in production).
    const cwd = '/work/profiled-proj';
    try {
      // The operator's REAL project state — foreign to a dev session: deny BOTH
      // reads (no disclosure of real memory/config) and writes (no pollution).
      expect(
        classifyProtectedPath({
          absPath: `${cwd}/.forja/permissions.yaml`,
          op: 'write',
          home: HOME,
          cwd,
        }),
      ).toBe('deny');
      expect(
        classifyProtectedPath({
          absPath: `${cwd}/.forja/memory/local/x.md`,
          op: 'read',
          home: HOME,
          cwd,
        }),
      ).toBe('deny');
      // The dev session's OWN project state — writes escalate (confirm), reads pass.
      expect(
        classifyProtectedPath({
          absPath: `${cwd}/.forja-dev/permissions.yaml`,
          op: 'write',
          home: HOME,
          cwd,
        }),
      ).toBe('escalate');
      expect(
        classifyProtectedPath({
          absPath: `${cwd}/.forja-dev/memory/local/x.md`,
          op: 'read',
          home: HOME,
          cwd,
        }),
      ).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FORJA_PROFILE;
      else process.env.FORJA_PROFILE = prev;
    }
  });
});
