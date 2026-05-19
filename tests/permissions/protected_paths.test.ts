import { describe, expect, test } from 'bun:test';
import {
  allProtectedRoots,
  classifyProtectedPath,
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
  test.each(['/etc', '/etc/hosts', '/etc/passwd', '/etc/agent/policy.toml'])(
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
    '/home/op/.config/agent',
    '/home/op/.config/agent/policy.yaml',
    '/home/op/.config/claude',
    '/home/op/.config/claude/install_id',
  ])('tilde escalate dir %s', (absPath) => {
    expect(classifyProtectedPath({ absPath, op: 'write', home: HOME, cwd: CWD })).toBe('escalate');
  });

  test.each([
    '/work/proj/.git',
    '/work/proj/.git/HEAD',
    '/work/proj/.git/refs/heads/main',
    '/work/proj/.agent',
    '/work/proj/.agent/sessions.db',
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
    expect(t.tildeEscalateDirs).toContain('/home/op/.config/agent');
    expect(t.cwdEscalateDirs).toContain('/work/proj/.git');
    expect(t.cwdEscalateDirs).toContain('/work/proj/.agent');
    expect(t.cwdEscalateDirs).toContain('/work/proj/.claude');
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
