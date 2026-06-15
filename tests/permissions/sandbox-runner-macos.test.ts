import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setCachePersistenceOverride } from '../../src/permissions/sandbox-cache-env.ts';
import {
  buildSandboxExecArgv,
  buildSbplProfile,
} from '../../src/permissions/sandbox-runner-macos.ts';
import { forjaCachePersistBase } from '../../src/storage/paths.ts';

describe('buildSbplProfile — common header + base rules', () => {
  test('every sandboxed profile carries the SBPL version + deny default header', () => {
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(version 1)');
      expect(profile).toContain('(deny default)');
    }
  });

  test('process operations granted in every sandboxed profile', () => {
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(allow process-exec)');
      expect(profile).toContain('(allow process-fork)');
      // Signals restricted to same-sandbox so a wrapped process
      // can't kill the parent agent.
      expect(profile).toContain('(allow signal (target same-sandbox))');
    }
  });

  // Slice 140 sec-2: nested sandbox-exec defense. `(allow
  // process-exec)` above grants exec of arbitrary binaries; an
  // LLM-driven bash could spawn `sandbox-exec -p '(version 1)
  // (allow default)' /bin/sh` to wrap itself in a permissive
  // profile, escaping the outer one. SBPL last-match-wins means
  // a literal-targeted deny of `/usr/bin/sandbox-exec` AFTER the
  // broad allow vetoes the specific exec.
  test('every sandboxed profile denies nested sandbox-exec (slice 140 sec-2)', () => {
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(deny process-exec (literal "/usr/bin/sandbox-exec"))');
      // Sanity: the deny comes AFTER the allow so SBPL's
      // last-match-wins evaluation strands the specific path.
      const allowIdx = profile.indexOf('(allow process-exec)');
      const denyIdx = profile.indexOf('(deny process-exec (literal "/usr/bin/sandbox-exec"))');
      expect(allowIdx).toBeGreaterThanOrEqual(0);
      expect(denyIdx).toBeGreaterThan(allowIdx);
    }
  });

  // Slice 145 (S3 — sandbox-exec copy bypass). Slice 140's literal
  // deny matched only `/usr/bin/sandbox-exec`; an LLM-driven bash
  // could `cp /usr/bin/sandbox-exec /tmp/se && /tmp/se -p ...` to
  // escape via a copied binary (cwd-rw / cwd-rw-net make `/tmp`
  // writable). The basename-regex denys close the bypass: any path
  // whose basename is `sandbox-exec` is refused.
  test('every sandboxed profile denies sandbox-exec by basename regex (slice 145 S3)', () => {
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      // The two regex denys: nested directory + root-level.
      expect(profile).toContain('(deny process-exec (regex #"^/.*/sandbox-exec$"))');
      expect(profile).toContain('(deny process-exec (regex #"^/sandbox-exec$"))');
      // Both come AFTER the broad allow so last-match-wins fires
      // them on any sandbox-exec basename match.
      const allowIdx = profile.indexOf('(allow process-exec)');
      const denyNestedIdx = profile.indexOf('(deny process-exec (regex #"^/.*/sandbox-exec$"))');
      const denyRootIdx = profile.indexOf('(deny process-exec (regex #"^/sandbox-exec$"))');
      expect(denyNestedIdx).toBeGreaterThan(allowIdx);
      expect(denyRootIdx).toBeGreaterThan(allowIdx);
    }
  });

  // Slice 175 (review — sandbox escape P1). `(allow mach-lookup)`
  // is required for dyld + libc + ordinary stdlib calls, but the
  // blanket grant lets the inner bash call `open -a Mail
  // file://exfil.html` — `open` brokers through `lsd` /
  // `coreservicesd`, which spawns the target app OUTSIDE the
  // sandbox with the operator's full privileges. The targeted
  // deny list strands LaunchServices + taskgated mach surfaces
  // while keeping the broad allow for everything else.
  test('every sandboxed profile denies the LaunchServices mach surface (slice 175)', () => {
    const requiredDenies = [
      '(deny mach-lookup (global-name "com.apple.lsd"))',
      '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
      '(deny mach-lookup (global-name "com.apple.LSOpenApplication"))',
    ];
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      const allowIdx = profile.indexOf('(allow mach-lookup)');
      expect(allowIdx).toBeGreaterThanOrEqual(0);
      for (const deny of requiredDenies) {
        expect(profile).toContain(deny);
        // Each deny lands AFTER the broad allow so SBPL's
        // last-match-wins refuses the specific service.
        expect(profile.indexOf(deny)).toBeGreaterThan(allowIdx);
      }
    }
  });

  test('every sandboxed profile denies the taskgated mach surface (slice 175)', () => {
    // taskgated brokers TASK_FOR_PID; access from inside the
    // sandbox would let the wrapped process inject code into a
    // sibling un-sandboxed process. Refuse the lookup.
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(deny mach-lookup (global-name "com.apple.taskgated"))');
      expect(profile).toContain('(deny mach-lookup (global-name "com.apple.taskgated-helper"))');
    }
  });

  test('file-read* always granted (read-only baseline)', () => {
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(allow file-read*)');
    }
  });

  test('/tmp + /private/tmp writable in every profile (slice 125: /private/var/folders REMOVED)', () => {
    // Matches Linux's --tmpfs /tmp.
    //
    // Slice 125 (R2 P0-6): /private/var/folders was the macOS TMPDIR
    // root and pre-slice was writable for mktemp / NSTemporaryDirectory
    // compatibility. But that root is shared across every app the user
    // runs — exposing Keychain / security ephemeral state. Removed;
    // tools needing TMPDIR can override via `TMPDIR=/tmp <cmd>` or
    // use the host-passthrough profile.
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
      expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
      expect(profile).not.toContain('(allow file-write* (subpath "/private/var/folders"))');
    }
  });
});

describe('buildSbplProfile — ro profile', () => {
  test('ro: no cwd / home write rule, no network allow', () => {
    const profile = buildSbplProfile('ro', '/work/proj', '/home/op');
    // /tmp is writable (baseline) but cwd / home are NOT.
    expect(profile).not.toContain('(allow file-write* (subpath "/work/proj"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/home/op"))');
    expect(profile).not.toContain('(allow network*)');
  });
});

describe('buildSbplProfile — cwd-rw profile', () => {
  test('cwd-rw: writable cwd subpath, NO network', () => {
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/home/op');
    expect(profile).toContain('(allow file-write* (subpath "/work/proj"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/home/op"))');
    expect(profile).not.toContain('(allow network*)');
  });
});

describe('buildSbplProfile — cwd-rw-net profile', () => {
  test('cwd-rw-net: writable cwd + network granted', () => {
    const profile = buildSbplProfile('cwd-rw-net', '/work/proj', '/home/op');
    expect(profile).toContain('(allow file-write* (subpath "/work/proj"))');
    expect(profile).toContain('(allow network*)');
  });
});

describe('buildSbplProfile — home-rw profile', () => {
  test('home-rw: writable $HOME subpath, no cwd write, no network', () => {
    const profile = buildSbplProfile('home-rw', '/work/proj', '/home/op');
    expect(profile).toContain('(allow file-write* (subpath "/home/op"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/work/proj"))');
    expect(profile).not.toContain('(allow network*)');
  });
});

describe('buildSbplProfile — path escaping (defense against profile injection)', () => {
  test('embedded `"` is escaped so the literal can\'t close early', () => {
    // A crafted cwd containing `"` could otherwise close the
    // string and inject SBPL clauses. Escape protects against
    // misuse from caller bugs even though filesystem paths
    // almost never contain `"`.
    const profile = buildSbplProfile('cwd-rw', '/work"injected', '/home/op');
    expect(profile).toContain('(allow file-write* (subpath "/work\\"injected"))');
  });

  test('embedded backslash is escaped', () => {
    const profile = buildSbplProfile('cwd-rw', '/work\\sub', '/home/op');
    expect(profile).toContain('(allow file-write* (subpath "/work\\\\sub"))');
  });

  test('null byte in path throws', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work\0x', '/home/op')).toThrow(/NUL byte/);
  });
});

describe('buildSandboxExecArgv', () => {
  test('host profile returns innerArgv unchanged (no wrap)', () => {
    const argv = buildSandboxExecArgv({
      profile: 'host',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['bash', '-c', 'echo hi'],
      realpath: (p) => p,
    });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('ro profile wraps with sandbox-exec -p <profile>', () => {
    const argv = buildSandboxExecArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['ls', '-la'],
      realpath: (p) => p,
    });
    expect(argv[0]).toBe('sandbox-exec');
    expect(argv[1]).toBe('-p');
    expect(argv[2]).toContain('(version 1)');
    expect(argv[2]).toContain('(deny default)');
    expect(argv.slice(3)).toEqual(['ls', '-la']);
  });

  test('cwd-rw profile carries the cwd in the profile string', () => {
    const argv = buildSandboxExecArgv({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['bash', '-c', 'touch src/x'],
      realpath: (p) => p,
    });
    expect(argv[2]).toContain('(allow file-write* (subpath "/work/proj"))');
  });

  test('innerArgv NOT separated by `--` (sandbox-exec convention)', () => {
    // Linux bwrap uses `--` to mark the inner command boundary;
    // sandbox-exec doesn't. Argv after `-p <profile>` is exec'd
    // directly.
    const argv = buildSandboxExecArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['echo', 'hi'],
      realpath: (p) => p,
    });
    expect(argv).not.toContain('--');
  });

  test('empty innerArgv throws', () => {
    expect(() =>
      buildSandboxExecArgv({
        profile: 'ro',
        cwd: '/work/proj',
        home: '/home/op',
        innerArgv: [],
        realpath: (p) => p,
      }),
    ).toThrow(/must not be empty/);
  });
});

// Forja-internal control-plane env (e.g. `FORJA_BROKER_WORKER=1`)
// has to survive the `/usr/bin/env -i` userland clearenv on macOS —
// without it the compiled-binary self-exec falls back to normal
// CLI parsing inside the sandboxed inner. `passthroughEnv` appends
// extra `KEY=VAL` assignments AFTER the safe-list loop so colliding
// keys win (env -i applies args in order, last wins).
describe('buildSandboxExecArgv — passthroughEnv (forja control plane)', () => {
  test('passthroughEnv entries appear inside env -i after safe-list entries', () => {
    const argv = buildSandboxExecArgv({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['/usr/bin/forja'],
      env: { PATH: '/usr/bin' },
      passthroughEnv: { FORJA_BROKER_WORKER: '1' },
      realpath: (p) => p,
    });
    // env -i wrap shape: [sandbox-exec, -p, profile, /usr/bin/env, -i, KEY=VAL, ..., --, inner]
    const envIdx = argv.indexOf('/usr/bin/env');
    expect(envIdx).toBeGreaterThan(-1);
    expect(argv[envIdx + 1]).toBe('-i');
    const sepIdx = argv.indexOf('--');
    expect(sepIdx).toBeGreaterThan(envIdx);
    const envAssignments = argv.slice(envIdx + 2, sepIdx);
    expect(envAssignments).toContain('PATH=/usr/bin');
    expect(envAssignments).toContain('FORJA_BROKER_WORKER=1');
    // Passthrough lands after safe-list (env -i last-wins on collisions).
    expect(envAssignments.indexOf('FORJA_BROKER_WORKER=1')).toBeGreaterThan(
      envAssignments.indexOf('PATH=/usr/bin'),
    );
    // Inner argv preserved after the `--` separator.
    expect(argv.slice(sepIdx + 1)).toEqual(['/usr/bin/forja']);
  });

  test('passthroughEnv alone (no env) still triggers the env -i wrap', () => {
    const argv = buildSandboxExecArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['/usr/bin/forja'],
      passthroughEnv: { FORJA_BROKER_WORKER: '1' },
      realpath: (p) => p,
    });
    expect(argv).toContain('/usr/bin/env');
    expect(argv).toContain('-i');
    expect(argv).toContain('FORJA_BROKER_WORKER=1');
  });

  test('passthroughEnv NUL in value is skipped', () => {
    const argv = buildSandboxExecArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['/usr/bin/forja'],
      passthroughEnv: { FORJA_BROKER_WORKER: '1', BAD: 'a\0b' },
      realpath: (p) => p,
    });
    expect(argv).toContain('FORJA_BROKER_WORKER=1');
    expect(argv.some((v) => v.startsWith('BAD='))).toBe(false);
  });

  test('passthroughEnv NUL or = in key is skipped (argv-injection defense)', () => {
    const argv = buildSandboxExecArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['/usr/bin/forja'],
      passthroughEnv: {
        GOOD: 'ok',
        'BAD\0KEY': 'x',
        'BAD=KEY': 'y',
        '': 'empty',
      },
      realpath: (p) => p,
    });
    expect(argv).toContain('GOOD=ok');
    expect(argv.some((v) => v.startsWith('BAD\0KEY='))).toBe(false);
    expect(argv.some((v) => v.startsWith('BAD=KEY='))).toBe(false);
    // Pure '=empty' would be an unsafe smuggled assignment — skipped.
    expect(argv).not.toContain('=empty');
  });

  test('passthroughEnv omitted → env -i carries only the safe-list', () => {
    const argv = buildSandboxExecArgv({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['/usr/bin/forja'],
      env: { PATH: '/usr/bin' },
      realpath: (p) => p,
    });
    expect(argv.some((v) => v.startsWith('FORJA_BROKER_WORKER='))).toBe(false);
  });
});

// Slice 119 — R4: §9 hide_paths defense in the macOS sandbox-exec
// runner, parallel to slice 118 in the Linux bwrap runner.
// Pre-slice the SBPL profile granted `(allow file-read*)` for
// the whole filesystem, which exposed the operator's full home
// inside the sandbox — the LLM could `cat ~/.ssh/id_rsa` from
// even a `ro` profile. The engine-side §11 protected paths
// classifier (slice 97) only catches calls that surface as
// resolved capabilities; a sandboxed bash process reading the
// file directly bypassed the classifier. Slice 119 emits
// `(deny file-read*|file-write* ...)` clauses for credential
// dirs (subpath) and files (literal) AFTER the allow rules so
// SBPL's last-rule-wins evaluation locks them down.
describe('buildSbplProfile — hide_paths defense (slice 119, R4)', () => {
  const HOME = '/Users/op';
  const expectHidePaths = (profileStr: string): void => {
    // Per PERMISSION_ENGINE.md §9 the canonical dir list (subpath
    // form — covers the dir and every descendant inside).
    expect(profileStr).toContain('(deny file-read* (subpath "/Users/op/.ssh"))');
    expect(profileStr).toContain('(deny file-write* (subpath "/Users/op/.ssh"))');
    expect(profileStr).toContain('(deny file-read* (subpath "/Users/op/.aws"))');
    expect(profileStr).toContain('(deny file-write* (subpath "/Users/op/.aws"))');
    expect(profileStr).toContain('(deny file-read* (subpath "/Users/op/.config/gcloud"))');
    expect(profileStr).toContain('(deny file-write* (subpath "/Users/op/.config/gcloud"))');
    expect(profileStr).toContain('(deny file-read* (subpath "/Users/op/.gnupg"))');
    expect(profileStr).toContain('(deny file-write* (subpath "/Users/op/.gnupg"))');
    expect(profileStr).toContain('(deny file-read* (subpath "/Users/op/.kube"))');
    expect(profileStr).toContain('(deny file-write* (subpath "/Users/op/.kube"))');
    // Slice 149 (review): rustup toolchain dir + subversion auth cache.
    expect(profileStr).toContain('(deny file-read* (subpath "/Users/op/.rustup"))');
    expect(profileStr).toContain('(deny file-write* (subpath "/Users/op/.rustup"))');
    expect(profileStr).toContain('(deny file-read* (subpath "/Users/op/.subversion/auth"))');
    expect(profileStr).toContain('(deny file-write* (subpath "/Users/op/.subversion/auth"))');
    // Canonical file list (literal form — exact path match).
    expect(profileStr).toContain('(deny file-read* (literal "/Users/op/.netrc"))');
    expect(profileStr).toContain('(deny file-write* (literal "/Users/op/.netrc"))');
    expect(profileStr).toContain('(deny file-read* (literal "/Users/op/.docker/config.json"))');
    expect(profileStr).toContain('(deny file-write* (literal "/Users/op/.docker/config.json"))');
    expect(profileStr).toContain('(deny file-read* (literal "/Users/op/.npmrc"))');
    expect(profileStr).toContain('(deny file-write* (literal "/Users/op/.npmrc"))');
    expect(profileStr).toContain('(deny file-read* (literal "/Users/op/.pypirc"))');
    expect(profileStr).toContain('(deny file-write* (literal "/Users/op/.pypirc"))');
    // Slice 149 (review): gitconfig executable hooks + cargo
    // credentials.toml token.
    expect(profileStr).toContain('(deny file-read* (literal "/Users/op/.gitconfig"))');
    expect(profileStr).toContain('(deny file-write* (literal "/Users/op/.gitconfig"))');
    expect(profileStr).toContain('(deny file-read* (literal "/Users/op/.cargo/credentials.toml"))');
    expect(profileStr).toContain(
      '(deny file-write* (literal "/Users/op/.cargo/credentials.toml"))',
    );
  };

  test('ro profile emits hide_paths deny rules', () => {
    const profile = buildSbplProfile('ro', '/work/proj', HOME);
    expectHidePaths(profile);
  });

  test('cwd-rw profile emits hide_paths deny rules', () => {
    const profile = buildSbplProfile('cwd-rw', '/work/proj', HOME);
    expectHidePaths(profile);
  });

  test('cwd-rw-net profile emits hide_paths deny rules', () => {
    const profile = buildSbplProfile('cwd-rw-net', '/work/proj', HOME);
    expectHidePaths(profile);
  });

  test('home-rw profile emits hide_paths deny rules (load-bearing — home is writable)', () => {
    // home-rw grants `(allow file-write* (subpath home))`, which
    // would otherwise let the LLM write `~/.ssh/authorized_keys`
    // and persist a key. The deny file-write* clauses must come
    // AFTER the allow so SBPL's last-rule-wins picks the deny.
    const profile = buildSbplProfile('home-rw', '/work/proj', HOME);
    expectHidePaths(profile);
  });

  test('deny rules appear AFTER allow file-read* (SBPL last-rule-wins)', () => {
    // SBPL evaluates rules top-to-bottom and the LAST matching
    // rule for that (operation, path) tuple wins. If the deny
    // appeared BEFORE the allow file-read* baseline, the allow
    // would win and the credential read would succeed. Pin the
    // ordering for every profile.
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', HOME);
      const allowReadIdx = profile.indexOf('(allow file-read*)');
      const denySshReadIdx = profile.indexOf('(deny file-read* (subpath "/Users/op/.ssh"))');
      expect(allowReadIdx).toBeGreaterThanOrEqual(0);
      expect(denySshReadIdx).toBeGreaterThan(allowReadIdx);
    }
  });

  test('home-rw: deny file-write* appears AFTER allow file-write* home subpath', () => {
    // The critical ordering for home-rw: a `(allow file-write*
    // (subpath "<home>"))` clause grants writes across the
    // whole home, and the deny for `~/.ssh` must come after to
    // override it. Without this order the LLM could write
    // authorized_keys, .aws/credentials, etc.
    const profile = buildSbplProfile('home-rw', '/work/proj', HOME);
    const allowWriteHomeIdx = profile.indexOf(`(allow file-write* (subpath "${HOME}"))`);
    const denySshWriteIdx = profile.indexOf('(deny file-write* (subpath "/Users/op/.ssh"))');
    expect(allowWriteHomeIdx).toBeGreaterThanOrEqual(0);
    expect(denySshWriteIdx).toBeGreaterThan(allowWriteHomeIdx);
  });

  test('host profile is unchanged — no profile string built, innerArgv passes through', () => {
    // sandbox-exec is not invoked at all on host; buildSandboxExecArgv
    // returns innerArgv unchanged. The hide_paths defense doesn't
    // apply because the inner process runs directly on the host.
    const argv = buildSandboxExecArgv({
      profile: 'host',
      cwd: '/work/proj',
      home: HOME,
      innerArgv: ['bash', '-c', 'cat ~/.ssh/id_rsa'],
    });
    expect(argv).toEqual(['bash', '-c', 'cat ~/.ssh/id_rsa']);
  });

  test('deny rules use operator-supplied home, not host HOME env', () => {
    // The defense follows the operator's chosen home value, not
    // process.env.HOME. Same property as the Linux runner (slice 118):
    // tests can pin Linux-shaped home values against the macOS
    // builder and stay platform-independent.
    const profile = buildSbplProfile('home-rw', '/work/proj', '/home/linux-op');
    expect(profile).toContain('(deny file-read* (subpath "/home/linux-op/.ssh"))');
    expect(profile).toContain('(deny file-read* (literal "/home/linux-op/.netrc"))');
  });

  test('home with embedded `"` does not break out of the literal (SBPL injection defense)', () => {
    // The escape applies to hide_paths just like cwd/home rules.
    // A crafted home containing `"` could otherwise close the
    // literal and inject SBPL clauses (e.g. `(allow file-read*)`).
    // Escape protects against caller bugs even though real home
    // paths almost never contain `"`.
    const profile = buildSbplProfile('cwd-rw', '/work', '/Users/op"injected');
    expect(profile).toContain('(deny file-read* (subpath "/Users/op\\"injected/.ssh"))');
    expect(profile).toContain('(deny file-read* (literal "/Users/op\\"injected/.netrc"))');
  });
});

// Slice 125 (R2 P1) + Slice 127 (R3 P1): escapeSbplLiteral rejects
// the full CC0/CC1 control-character range. Pre-slice 125 only
// NUL was rejected; slice 125 added \n/\r; slice 127 expanded to
// the full CC0 + CC1 set (symmetric with welcome.ts).
describe('escapeSbplLiteral control-char rejection (slices 125 + 127)', () => {
  test('NUL byte throws (slice 119 pre-existing)', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work\0', '/home/op')).toThrow(/NUL byte/);
  });

  test('newline (LF) throws (slice 125)', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work\n', '/home/op')).toThrow(/control character/);
  });

  test('carriage return throws (slice 125)', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work\r', '/home/op')).toThrow(/control character/);
  });

  test('ESC byte (0x1B) throws (slice 127)', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work\x1b', '/home/op')).toThrow(/control character/);
  });

  test('BEL byte (0x07) throws (slice 127)', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work\x07', '/home/op')).toThrow(/control character/);
  });

  test('CC1 control char (0x9d, OSC) throws (slice 127)', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work\x9d', '/home/op')).toThrow(/control character/);
  });

  test('benign paths (no control chars) succeed', () => {
    expect(() => buildSbplProfile('cwd-rw', '/work/proj', '/home/op')).not.toThrow();
  });
});

// Slice 134 P0-12: cross-platform parity with sandbox-runner.ts:147.
// Pre-fixup macOS silently produced an SBPL profile where the
// hide_paths deny rule (appended last, last-match-wins) masked the
// cwd mount — the inner process received a working dir that
// "vanishes". Linux refused at build time; macOS exec'd with an
// opaque SBPL error. Fixup adds the equivalent guard.
describe('buildSandboxExecArgv — cwd inside hide_paths dir (slice 134 P0-12 parity)', () => {
  const INNER = ['bash', '-c', 'echo hi'];

  test('refuses when cwd === a hide_paths dir', () => {
    expect(() =>
      buildSandboxExecArgv({
        profile: 'home-rw',
        cwd: '/home/op/.ssh',
        home: '/home/op',
        innerArgv: INNER,
        realpath: (p) => p,
      }),
    ).toThrow(/inside hide_paths dir/);
  });

  test('refuses when cwd is INSIDE a hide_paths dir', () => {
    expect(() =>
      buildSandboxExecArgv({
        profile: 'home-rw',
        cwd: '/home/op/.ssh/audit',
        home: '/home/op',
        innerArgv: INNER,
        realpath: (p) => p,
      }),
    ).toThrow(/inside hide_paths dir/);
  });

  test('does NOT refuse for a sibling sharing a prefix with a hide_paths dir', () => {
    // `.ssh-backup` is NOT inside `.ssh`; the `${hiddenAbs}/`
    // suffix in the startsWith check protects against the
    // prefix-collision false positive (parity with Linux).
    expect(() =>
      buildSandboxExecArgv({
        profile: 'home-rw',
        cwd: '/home/op/.ssh-backup',
        home: '/home/op',
        innerArgv: INNER,
        realpath: (p) => p,
      }),
    ).not.toThrow();
  });

  test('does NOT refuse when cwd is outside all hide_paths dirs', () => {
    expect(() =>
      buildSandboxExecArgv({
        profile: 'home-rw',
        cwd: '/home/op/work',
        home: '/home/op',
        innerArgv: INNER,
        realpath: (p) => p,
      }),
    ).not.toThrow();
  });

  test('host profile bypasses the guard (innerArgv passthrough)', () => {
    // Host short-circuits BEFORE the hide_paths check. Operator
    // who opted in via --sandbox-host accepts the cost.
    const argv = buildSandboxExecArgv({
      profile: 'host',
      cwd: '/home/op/.ssh/audit',
      home: '/home/op',
      innerArgv: INNER,
      realpath: (p) => p,
    });
    expect(argv).toEqual(INNER);
  });
});

// Slice 140 sec-1: XDG_DATA_HOME unmask — macOS parity with Linux.
// `defaultDataDir()` honors $XDG_DATA_HOME on macOS too; the
// canonical literal `.local/share/forja` deny covers the wrong
// subpath when the operator points XDG elsewhere.
describe('buildSbplProfile — XDG_DATA_HOME unmask defense (slice 140 sec-1)', () => {
  const originalXdg = process.env.XDG_DATA_HOME;
  const restoreEnv = (): void => {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
  };

  test('XDG_DATA_HOME set to a NON-HOME path: extra deny rules added', () => {
    process.env.XDG_DATA_HOME = '/tmp/data';
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      // Both the canonical home-relative deny AND the XDG-driven
      // deny appear.
      expect(profile).toContain('(deny file-read* (subpath "/Users/op/.local/share/forja"))');
      expect(profile).toContain('(deny file-read* (subpath "/tmp/data/forja"))');
      expect(profile).toContain('(deny file-write* (subpath "/tmp/data/forja"))');
    } finally {
      restoreEnv();
    }
  });

  test('XDG_DATA_HOME unset: no extra subpath beyond canonical', () => {
    delete process.env.XDG_DATA_HOME;
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      expect(profile).toContain('(deny file-read* (subpath "/Users/op/.local/share/forja"))');
      // No /tmp/data path (operator didn't set XDG).
      expect(profile).not.toContain('/tmp/data/forja');
    } finally {
      restoreEnv();
    }
  });

  test('XDG_DATA_HOME equal to home-relative default: skip extra rule (de-dup)', () => {
    process.env.XDG_DATA_HOME = '/Users/op/.local/share';
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      // Exactly one deny rule on the share/forja subpath.
      const matches =
        profile.match(/\(deny file-read\* \(subpath "[^"]*\/share\/forja"\)\)/g) ?? [];
      expect(matches.length).toBe(1);
    } finally {
      restoreEnv();
    }
  });

  test('XDG_DATA_HOME set to a RELATIVE path: extra deny skipped (review fix)', () => {
    // Pre-review-fix: defaultDataDir() returned `relative/forja`,
    // which the SBPL builder pushed verbatim into a `(deny ...
    // (subpath "relative/forja"))` rule. SBPL requires absolute
    // paths for subpath rules — sandbox-exec would either reject
    // the profile at load OR silently fail to match the real data
    // dir (worse: unmask). Per XDG spec, relative values are
    // ignored; the home-relative deny still covers the canonical
    // `.local/share/forja`.
    process.env.XDG_DATA_HOME = 'relative/path';
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      // No deny rule should reference the relative path.
      expect(profile).not.toMatch(/\(subpath "relative\/[^"]*"\)/);
      // Canonical home-relative deny still present.
      expect(profile).toContain('(deny file-read* (subpath "/Users/op/.local/share/forja"))');
    } finally {
      restoreEnv();
    }
  });
});

// Slice 146: XDG_CONFIG_HOME unmask — macOS parity with the Linux
// runner. Same threat: the `.config/*` hidePathsDirs() entries
// (gcloud, azure, op, sops, forja — plus forja-<profile> under a
// profile) live under `$XDG_CONFIG_HOME/<sub>` when relocated.
// Pre-slice the SBPL deny covered `<home>/.config/<sub>` only.
describe('buildSbplProfile — XDG_CONFIG_HOME unmask defense (slice 146)', () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;

  const restoreEnv = (): void => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  };

  test('XDG_CONFIG_HOME unset: only canonical home-relative denys', () => {
    delete process.env.XDG_CONFIG_HOME;
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      // Canonical home-relative subpath deny present.
      expect(profile).toContain('(deny file-read* (subpath "/Users/op/.config/gcloud"))');
      // No /srv/conf path (XDG unset).
      expect(profile).not.toContain('/srv/conf');
    } finally {
      restoreEnv();
    }
  });

  test('XDG_CONFIG_HOME relocated: extra deny pair for each .config/* entry', () => {
    process.env.XDG_CONFIG_HOME = '/srv/conf';
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      // Canonical home-relative denys still present (defense in depth).
      expect(profile).toContain('(deny file-read* (subpath "/Users/op/.config/gcloud"))');
      // Plus XDG-relocated denys, one read + one write per entry.
      expect(profile).toContain('(deny file-read* (subpath "/srv/conf/gcloud"))');
      expect(profile).toContain('(deny file-write* (subpath "/srv/conf/gcloud"))');
      expect(profile).toContain('(deny file-read* (subpath "/srv/conf/azure"))');
      expect(profile).toContain('(deny file-read* (subpath "/srv/conf/op"))');
      expect(profile).toContain('(deny file-read* (subpath "/srv/conf/sops"))');
      expect(profile).toContain('(deny file-read* (subpath "/srv/conf/forja"))');
      // FILES under .config/* (NuGet/Composer auth) must ALSO get a
      // relocated literal deny, not only the home-relative one (#2 review fix).
      expect(profile).toContain('(deny file-read* (literal "/srv/conf/NuGet/NuGet.Config"))');
      expect(profile).toContain('(deny file-write* (literal "/srv/conf/NuGet/NuGet.Config"))');
      expect(profile).toContain('(deny file-read* (literal "/srv/conf/composer/auth.json"))');
    } finally {
      restoreEnv();
    }
  });

  test('XDG_CONFIG_HOME equal to home-relative default: no duplicate rules', () => {
    process.env.XDG_CONFIG_HOME = '/Users/op/.config';
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      // Exactly one read+write pair on each .config/* subpath.
      const gcloudReadMatches =
        profile.match(/\(deny file-read\* \(subpath "[^"]*\.config\/gcloud"\)\)/g) ?? [];
      expect(gcloudReadMatches.length).toBe(1);
    } finally {
      restoreEnv();
    }
  });

  test('XDG_CONFIG_HOME with non-absolute value is ignored (defensive)', () => {
    process.env.XDG_CONFIG_HOME = 'relative/path';
    try {
      const profile = buildSbplProfile('home-rw', '/work/proj', '/Users/op');
      expect(profile).not.toContain('relative/path');
    } finally {
      restoreEnv();
    }
  });
});

// Slice 155 (review — symlink canonicalization for cwd guard,
// macOS parity). The Linux runner refuses cwd symlinks pointing
// into hide_paths after canonicalization; macOS must do the same
// because SBPL allow-rules generated for the original (uncanonical)
// path would let the sandboxed process write the symlink TARGET,
// bypassing the deny rules that were generated against the
// canonical hidden path.
describe('buildSandboxExecArgv — symlink canonicalization (slice 155)', () => {
  test('symlink cwd pointing to hide_paths dir → refused after realpath', () => {
    expect(() =>
      buildSandboxExecArgv({
        profile: 'home-rw',
        cwd: '/tmp/work',
        home: '/Users/op',
        innerArgv: ['bash', '-c', 'echo hi'],
        realpath: (p) => (p === '/tmp/work' ? '/Users/op/.ssh/audit' : p),
      }),
    ).toThrow(/inside hide_paths dir/);
  });

  test('symlink cwd pointing outside hide_paths → SBPL profile uses canonical target', () => {
    const argv = buildSandboxExecArgv({
      profile: 'cwd-rw',
      cwd: '/tmp/work',
      home: '/Users/op',
      innerArgv: ['bash', '-c', 'echo hi'],
      realpath: (p) => (p === '/tmp/work' ? '/var/build/project' : p),
    });
    // SBPL profile generated from the canonical cwd.
    expect(argv[2]).toContain('/var/build/project');
    // Original symlink path absent from the profile.
    expect(argv[2]).not.toContain('/tmp/work');
  });

  test('broken symlink → refused with clear message', () => {
    expect(() =>
      buildSandboxExecArgv({
        profile: 'cwd-rw',
        cwd: '/tmp/dangling',
        home: '/Users/op',
        innerArgv: ['bash', '-c', 'echo hi'],
        realpath: () => {
          const e = new Error('ENOENT') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        },
      }),
    ).toThrow(/does not exist/);
  });
});

// Slice 156 (review — macOS /tmp shared sandbox+host). Pre-slice
// the SBPL allow blanketly granted file-write* on /tmp +
// /private/tmp — the host's /tmp, shared across every process
// the operator runs. Sandbox A writes /tmp/secret, operator's
// non-sandboxed app B reads it. Cross-tenancy leak. New `tmpdir`
// option restricts the allow to a caller-provided subpath.
describe('buildSbplProfile — slice 156 per-sandbox tmpdir', () => {
  test('default (tmpdir undefined): blanket /tmp + /private/tmp allow kept', () => {
    // Backward-compat: no tmpdir → pre-slice behavior.
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/Users/op');
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
  });

  test('tmpdir set: SBPL allow restricted to subpath (no blanket /tmp)', () => {
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/Users/op', '/tmp/forja-sb-sess123');
    // Scoped allow present.
    expect(profile).toContain('(allow file-write* (subpath "/tmp/forja-sb-sess123"))');
    // Blanket allow absent.
    expect(profile).not.toContain('(allow file-write* (subpath "/tmp"))');
    expect(profile).not.toContain('(allow file-write* (subpath "/private/tmp"))');
  });

  test('tmpdir under /tmp: emits matching /private firmlink form', () => {
    // macOS firmlinks /tmp ↔ /private/tmp; tools resolve via either
    // prefix. Emit both forms so the inner process's mktemp /
    // NSTemporaryDirectory honor the scope regardless of which
    // path SBPL evaluation sees.
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/Users/op', '/tmp/forja-sb-abc');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/forja-sb-abc"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/forja-sb-abc"))');
  });

  test('tmpdir outside /tmp (e.g. /var/tmp): no firmlink form emitted', () => {
    // The firmlink trick is /tmp ↔ /private/tmp specific. Other
    // tmpdir prefixes get only the literal allow.
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/Users/op', '/var/tmp/forja');
    expect(profile).toContain('(allow file-write* (subpath "/var/tmp/forja"))');
    // No /private/var/tmp emission (not a firmlink).
    expect(profile).not.toContain('(allow file-write* (subpath "/private/var/tmp/forja"))');
  });

  test('tmpdir SBPL escaping: backslash + quotes in path escaped', () => {
    // Defensive: a tmpdir with `"` or `\` would otherwise close
    // the SBPL string literal and inject clauses. escapeSbplLiteral
    // (already proven for cwd) covers the tmpdir path too.
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/Users/op', '/tmp/with"quote');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/with\\"quote"))');
  });
});

describe('buildSandboxExecArgv — slice 156 tmpdir forwarded to profile', () => {
  test('tmpdir option flows through to the SBPL profile string', () => {
    const argv = buildSandboxExecArgv({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      home: '/Users/op',
      innerArgv: ['bash', '-c', 'echo hi'],
      realpath: (p) => p,
      tmpdir: '/tmp/forja-sb-XYZ',
    });
    // argv[2] is the SBPL profile string.
    expect(argv[2]).toContain('(allow file-write* (subpath "/tmp/forja-sb-XYZ"))');
    expect(argv[2]).not.toContain('(allow file-write* (subpath "/tmp"))');
  });
});

describe('defaultSandboxTmpdir', () => {
  test('returns /tmp/forja-sb-<sessionId>', async () => {
    const { defaultSandboxTmpdir } = await import('../../src/permissions/sandbox-availability.ts');
    expect(defaultSandboxTmpdir('abc-123')).toBe('/tmp/forja-sb-abc-123');
    expect(defaultSandboxTmpdir('SESSION_42')).toBe('/tmp/forja-sb-SESSION_42');
  });
});

describe('macOS — opt-in persistent cache (cache_persistence)', () => {
  // Pin XDG_CACHE_HOME so forjaCachePersistBase() is deterministic.
  let origXdgCache: string | undefined;
  beforeEach(() => {
    origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/xdgc';
    setCachePersistenceOverride(undefined);
  });
  afterEach(() => {
    setCachePersistenceOverride(undefined);
    if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origXdgCache;
  });

  const PERSIST_BASE = '/xdgc/forja/cache';
  const ALLOW = `(allow file-write* (subpath "${PERSIST_BASE}"))`;

  test('OFF by default — SBPL has no persistent cache write-allow', () => {
    expect(buildSbplProfile('cwd-rw', '/work/proj', '/home/op')).not.toContain(ALLOW);
  });

  test('ON (cwd-rw) — SBPL grants write to the dedicated cache base', () => {
    setCachePersistenceOverride(true);
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/home/op');
    expect(profile).toContain(ALLOW);
    expect(PERSIST_BASE).toBe(forjaCachePersistBase()); // sanity: matches the runner helper
  });

  test('ON but ro — no persistent cache write-allow (ro writes nothing)', () => {
    setCachePersistenceOverride(true);
    expect(buildSbplProfile('ro', '/work/proj', '/home/op')).not.toContain(ALLOW);
  });

  test('ON + home-rw — SBPL grants write to the dedicated cache base', () => {
    // home-rw is writable: it must get the dedicated cache too, else its PMs
    // poison the operator's real ~/.cache / ~/.npm (its $HOME subpath allow
    // exposes them; the redirect env steers PMs to the Forja base).
    setCachePersistenceOverride(true);
    expect(buildSbplProfile('home-rw', '/work/proj', '/home/op')).toContain(ALLOW);
  });

  test('ORDERING — the cache write-allow precedes the credential denies (last-match-wins)', () => {
    setCachePersistenceOverride(true);
    const profile = buildSbplProfile('cwd-rw', '/work/proj', '/home/op');
    const allowIdx = profile.indexOf(ALLOW);
    const denyIdx = profile.indexOf('(deny file-read* (subpath "/home/op/.ssh"))');
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  test('buildSandboxExecArgv (ON) — env -i carries the redirect vars (incl. Maven flag form)', () => {
    setCachePersistenceOverride(true);
    const argv = buildSandboxExecArgv({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['bash', '-s'],
      env: { PATH: '/usr/bin' },
      realpath: (p) => p,
    });
    expect(argv).toContain(`XDG_CACHE_HOME=${PERSIST_BASE}/xdg`);
    expect(argv).toContain(`npm_config_cache=${PERSIST_BASE}/npm`);
    expect(argv).toContain(`MAVEN_ARGS=-Dmaven.repo.local=${PERSIST_BASE}/maven`);
  });

  test('buildSandboxExecArgv (ON, home-rw) — env -i carries the redirect vars', () => {
    // The load-bearing half for home-rw: without the redirect, PMs write the
    // real host caches the writable $HOME exposes.
    setCachePersistenceOverride(true);
    const argv = buildSandboxExecArgv({
      profile: 'home-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['bash', '-s'],
      env: { PATH: '/usr/bin' },
      realpath: (p) => p,
    });
    expect(argv).toContain(`XDG_CACHE_HOME=${PERSIST_BASE}/xdg`);
    expect(argv).toContain(`npm_config_cache=${PERSIST_BASE}/npm`);
  });

  test('buildSandboxExecArgv (ON, ro) — redirect vars present (reads Forja cache RO), but SBPL has no write-allow', () => {
    // Coherence parity with the Linux runner: ro resolves the SAME Forja
    // cache a writable command writes (no host-vs-Forja split by profile),
    // reading it RO (sandbox allows reads by default). It still gets NO SBPL
    // write-allow (asserted above) — read-only, no persistent write.
    setCachePersistenceOverride(true);
    const argv = buildSandboxExecArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['bash', '-s'],
      env: { PATH: '/usr/bin' },
      realpath: (p) => p,
    });
    expect(argv).toContain(`XDG_CACHE_HOME=${PERSIST_BASE}/xdg`);
    expect(argv).toContain(`GOMODCACHE=${PERSIST_BASE}/go/mod`);
  });

  test('buildSandboxExecArgv (OFF) — no redirect vars in env -i', () => {
    const argv = buildSandboxExecArgv({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['bash', '-s'],
      env: { PATH: '/usr/bin' },
      realpath: (p) => p,
    });
    expect(argv.some((a) => a.startsWith('XDG_CACHE_HOME='))).toBe(false);
  });
});

// Project read floor (profile isolation) — macOS parity with the Linux runner's
// foreign-dir tmpfs overlay.
describe('buildSbplProfile — profile read floor (foreign .forja/ deny)', () => {
  test('under FORJA_PROFILE: denies read+write of <cwd>/.forja but NOT the active <cwd>/.forja-<profile>', () => {
    const prev = process.env.FORJA_PROFILE;
    process.env.FORJA_PROFILE = 'dev';
    try {
      const profile = buildSbplProfile('cwd-rw', '/work/proj', '/home/op');
      // The operator's REAL project state is denied (read + write).
      expect(profile).toContain('(deny file-read* (subpath "/work/proj/.forja"))');
      expect(profile).toContain('(deny file-write* (subpath "/work/proj/.forja"))');
      // The dev session's OWN dir is NOT denied — it must read its own state.
      expect(profile).not.toContain('(deny file-read* (subpath "/work/proj/.forja-dev"))');
    } finally {
      if (prev === undefined) delete process.env.FORJA_PROFILE;
      else process.env.FORJA_PROFILE = prev;
    }
  });

  test('no profile ⇒ no foreign .forja deny (the canonical dir IS the session)', () => {
    const prev = process.env.FORJA_PROFILE;
    delete process.env.FORJA_PROFILE;
    try {
      const profile = buildSbplProfile('cwd-rw', '/work/proj', '/home/op');
      expect(profile).not.toContain('(deny file-read* (subpath "/work/proj/.forja"))');
    } finally {
      if (prev !== undefined) process.env.FORJA_PROFILE = prev;
    }
  });
});
