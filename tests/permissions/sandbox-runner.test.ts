import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setWritableCacheDirsOverride } from '../../src/permissions/sandbox-cache-dirs.ts';
import { setCachePersistenceOverride } from '../../src/permissions/sandbox-cache-env.ts';
import { isSandboxProfile } from '../../src/permissions/sandbox-plan.ts';
import {
  __resetSandboxMaskFileCacheForTest,
  buildBwrapArgv,
  maybeWrapSandboxArgv,
} from '../../src/permissions/sandbox-runner.ts';
import { forjaCachePersistBase } from '../../src/storage/paths.ts';

const INNER = ['bash', '-c', 'echo hi'] as const;
const CWD = '/work/proj';
const HOME = '/home/op';
// Deterministic stand-in for the empty-regular-file mask source (prod
// uses a session-cached file via ensureSandboxMaskFile); pin it so the
// argv assertions don't depend on the runner's data dir / create a file.
const MASK = '/forja-mask-empty';

// Defensive isolation: the persistence toggles are PROCESS-GLOBAL modules
// (sandbox-cache-env / sandbox-cache-dirs) and `bun test` shares modules
// across files. Other files that run bootstrap() set them — with default-ON,
// bootstrap sets cachePersistence=true — and a leaked override would corrupt
// the argv-shape assertions here that assume the default (off). Reset both
// before EVERY test; the persistent-cache / dev-cache describes set their own
// values in their own hooks/bodies (which run after this top-level one).
beforeEach(() => {
  setCachePersistenceOverride(undefined);
  setWritableCacheDirsOverride(undefined);
});

describe('buildBwrapArgv — host profile (passthrough)', () => {
  test('host returns innerArgv unchanged', () => {
    const argv = buildBwrapArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
    });
    expect(argv).toContain('--bind');
    expect(argv).not.toContain('--unshare-net');
    // pid still unshared.
    expect(argv).toContain('--unshare-pid');
  });
});

// True iff argv contains the adjacent pair `--tmpfs <target>`.
const hasTmpfs = (argv: readonly string[], target: string): boolean => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--tmpfs' && argv[i + 1] === target) return true;
  }
  return false;
};

const tmpfsIndex = (argv: readonly string[], target: string): number => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--tmpfs' && argv[i + 1] === target) return i;
  }
  return -1;
};

describe('buildBwrapArgv — writable dev-cache carve-out', () => {
  // The carve-out resolves explicit option > module-level override >
  // DEFAULT. Reset the override around each test so the default-path
  // cases aren't polluted by another test (here or in another file
  // sharing the module) leaving an override set.
  beforeEach(() => setWritableCacheDirsOverride(undefined));
  afterEach(() => setWritableCacheDirsOverride(undefined));

  // The runner only emits `--tmpfs` for cache dirs that EXIST on the
  // host (bwrap can't mkdir a mountpoint under the read-only base). The
  // builder defaults to real `existsSync`; these argv-shape tests pin a
  // deterministic probe so they don't depend on the runner's home.
  const EXISTS_ALL = (): boolean => true;

  test('cwd-rw mounts a tmpfs over each default cache dir (under home)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
    });
    for (const target of [`${HOME}/.cache`, `${HOME}/go/pkg/mod`, `${HOME}/.npm`]) {
      expect(hasTmpfs(argv, target)).toBe(true);
    }
    // `.cargo` is NOT in the default (it masks the rustup cargo binary).
    expect(hasTmpfs(argv, `${HOME}/.cargo`)).toBe(false);
  });

  test('cwd-rw-net also gets the carve-out', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw-net',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
    });
    expect(hasTmpfs(argv, `${HOME}/.cache`)).toBe(true);
  });

  test('ro does NOT get the cache carve-out (writes nothing)', () => {
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
    });
    // The only tmpfs on ro is the common `/tmp`; no home-relative caches.
    expect(hasTmpfs(argv, `${HOME}/.cache`)).toBe(false);
    expect(hasTmpfs(argv, `${HOME}/.npm`)).toBe(false);
  });

  test('home-rw DOES get the cache carve-out, AFTER the $HOME bind', () => {
    // Bug fix: home-rw binds the real $HOME RW, so without the carve-out its
    // package managers write the operator's REAL ~/.cache / ~/.npm. The tmpfs
    // masks must come AFTER the $HOME bind (else the bind re-exposes them),
    // and the credential overlays after that.
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
    });
    expect(hasTmpfs(argv, `${HOME}/.cache`)).toBe(true);
    expect(hasTmpfs(argv, `${HOME}/.npm`)).toBe(true);
    // ordering: $HOME bind < cache tmpfs mask < credential overlay.
    const homeBind = bindPairIndex(argv, HOME, HOME);
    const cacheMask = tmpfsIndex(argv, `${HOME}/.cache`);
    const credMask = tmpfsIndex(argv, `${HOME}/.ssh`);
    expect(homeBind).toBeGreaterThanOrEqual(0);
    expect(cacheMask).toBeGreaterThan(homeBind);
    expect(credMask).toBeGreaterThan(cacheMask);
  });

  test('EXISTENCE GATE: an absent cache dir is skipped (no spawn-abort)', () => {
    // Critical: bwrap aborts the WHOLE spawn if asked to --tmpfs an
    // absent path under the read-only base. The runner must skip absent
    // dirs, not emit them. With nothing existing, NO cache tmpfs appears.
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => false,
    });
    expect(hasTmpfs(argv, `${HOME}/.cache`)).toBe(false);
    expect(hasTmpfs(argv, `${HOME}/go/pkg/mod`)).toBe(false);
    expect(hasTmpfs(argv, `${HOME}/.npm`)).toBe(false);
    // Only existing dirs are carved out — mix: ~/.cache exists, ~/.npm not.
    const partial = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: (p) => p === `${HOME}/.cache`,
    });
    expect(hasTmpfs(partial, `${HOME}/.cache`)).toBe(true);
    expect(hasTmpfs(partial, `${HOME}/.npm`)).toBe(false);
  });

  test('an entry of "." is rejected — never masks the entire $HOME', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
      writableCacheDirs: ['.', './', 'foo/..'],
    });
    // None of these normalize to a real subdir; the home itself must NOT
    // become a tmpfs mountpoint.
    expect(hasTmpfs(argv, HOME)).toBe(false);
    expect(hasTmpfs(argv, `${HOME}/`)).toBe(false);
  });

  test('override list replaces the default set verbatim', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
      writableCacheDirs: ['.cache/custom'],
    });
    expect(hasTmpfs(argv, `${HOME}/.cache/custom`)).toBe(true);
    // Defaults are NOT also mounted.
    expect(hasTmpfs(argv, `${HOME}/go/pkg/mod`)).toBe(false);
    expect(hasTmpfs(argv, `${HOME}/.npm`)).toBe(false);
  });

  test('empty override disables the carve-out entirely', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
      writableCacheDirs: [],
    });
    expect(hasTmpfs(argv, `${HOME}/.cache`)).toBe(false);
  });

  test('defensively skips absolute / parent-escape entries (no arbitrary tmpfs)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
      writableCacheDirs: ['/etc', '../../etc', 'a/../../b', 'ok'],
    });
    // No tmpfs lands outside home; only the clean `ok` entry mounts.
    expect(argv).not.toContain('/etc');
    expect(hasTmpfs(argv, `${HOME}/ok`)).toBe(true);
  });

  test('cache tmpfs sits AFTER --ro-bind / / and BEFORE the cwd bind + credential overlay', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      writableCacheDirs: ['.cargo'],
      // Both the .cargo cache dir AND its credential file "exist" so the
      // cache tmpfs and the hide-file overlay both emit.
      pathExists: (p) => p === `${HOME}/.cargo` || p === `${HOME}/.cargo/credentials.toml`,
      maskFileSource: MASK,
    });
    const cargoTmpfs = argv.indexOf(`${HOME}/.cargo`);
    const cwdBind = argv.indexOf('--bind');
    const credOverlay = argv.indexOf(`${HOME}/.cargo/credentials.toml`);
    // After the base ro-bind (so the cache dir is WRITABLE, not re-masked).
    const baseRoBind = argv.indexOf('--ro-bind');
    expect(baseRoBind).toBeGreaterThanOrEqual(0);
    expect(cargoTmpfs).toBeGreaterThan(baseRoBind);
    // Before the cwd bind (cwd stays writable even if a cache dir
    // contained it) and before the credential overlay (a cache entry can
    // never un-mask a hidden credential — last mount wins).
    expect(cwdBind).toBeGreaterThan(cargoTmpfs);
    expect(credOverlay).toBeGreaterThan(cargoTmpfs);
    expect(argv[credOverlay - 1]).toBe(MASK);
    expect(argv[credOverlay - 2]).toBe('--ro-bind');
  });

  test('the bootstrap override is consulted when no explicit option is passed', () => {
    setWritableCacheDirsOverride(['.cache/onlythis']);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
    });
    expect(hasTmpfs(argv, `${HOME}/.cache/onlythis`)).toBe(true);
    // The default set is NOT also applied — the override replaced it.
    expect(hasTmpfs(argv, `${HOME}/go/pkg/mod`)).toBe(false);
  });

  test('an explicit empty override disables the carve-out (tri-state preserved)', () => {
    setWritableCacheDirsOverride([]);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
    });
    expect(hasTmpfs(argv, `${HOME}/.cache`)).toBe(false);
  });

  test('explicit option wins over the override', () => {
    setWritableCacheDirsOverride(['.cache/fromoverride']);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: EXISTS_ALL,
      writableCacheDirs: ['.cache/fromoption'],
    });
    expect(hasTmpfs(argv, `${HOME}/.cache/fromoption`)).toBe(true);
    expect(hasTmpfs(argv, `${HOME}/.cache/fromoverride`)).toBe(false);
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
      realpath: (p) => p,
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
      const argv = buildBwrapArgv({
        profile,
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: (p) => p,
      });
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
      realpath: (p) => p,
    });
    const dashIdx = argv.indexOf('--');
    expect(argv.slice(dashIdx + 1)).toEqual(innerArgv);
  });

  test('empty innerArgv throws (programmer bug, fail loud)', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'ro',
        cwd: CWD,
        home: HOME,
        innerArgv: [],
        env: {},
        realpath: (p) => p,
      }),
    ).toThrow('innerArgv must not be empty');
  });
});

describe('maybeWrapSandboxArgv — per-spawn-site consume primitive', () => {
  test('omitted profile → returns innerArgv (no wrap)', () => {
    const argv = maybeWrapSandboxArgv({ cwd: CWD, innerArgv: INNER, realpath: (p) => p });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('host profile → returns innerArgv even on Linux', () => {
    const argv = maybeWrapSandboxArgv({
      profile: 'host',
      cwd: CWD,
      innerArgv: INNER,
      realpath: (p) => p,
    });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('returned array is a defensive copy (caller mutation safe)', () => {
    const argv = maybeWrapSandboxArgv({ cwd: CWD, innerArgv: INNER, realpath: (p) => p });
    argv.push('mutated');
    const argv2 = maybeWrapSandboxArgv({ cwd: CWD, innerArgv: INNER, realpath: (p) => p });
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
      realpath: (p) => p,
    });
    if (bwrapInstalled && onLinux) {
      // Slice 154 (review): argv[0] is the resolved absolute path.
      // On Linux the canonical /usr/bin/bwrap wins if present;
      // otherwise the PATH-resolved fallback applies.
      expect(argv[0]).toMatch(/bwrap$/);
      // Slice 175 (review): inner argv[0] (bare `bash`) is now
      // canonicalized to an absolute path BEFORE the wrap, so the
      // kernel-side execve inside the sandbox doesn't re-walk
      // $PATH and pick a writable-mount shim. Assert the final
      // three argv elements via the absolute-bash regex; legacy
      // tail-shape `['bash', '-c', 'echo hi']` was pre-slice 175.
      const tail = argv.slice(-3);
      expect(tail[0]).toMatch(/\/bash$/);
      expect(tail[1]).toBe('-c');
      expect(tail[2]).toBe('echo hi');
    } else {
      expect(argv).toEqual(['bash', '-c', 'echo hi']);
    }
  });

  // Test seams added in slice 48: pin a darwin scenario from a
  // Linux runner. Production callers leave platform/which undefined.
  describe('platform dispatch (slice 48 seams)', () => {
    test('darwin + sandbox-exec available → wraps via sandbox-exec + env -i clearenv (slice 162)', () => {
      // Slice 162 (review — env scrub allowlist parity on macOS).
      // Pre-slice the argv was `['sandbox-exec', '-p', profile,
      // 'bash', '-c', 'echo hi']` — no userland clearenv, sandbox-exec
      // inherited the spawner's env verbatim. Post-slice the inner
      // argv is wrapped with `/usr/bin/env -i KEY=VAL ... --` so
      // only the SANDBOX_SAFE_ENV_VARS allowlist values present in
      // the env reach the inner bash.
      const argv = maybeWrapSandboxArgv({
        profile: 'cwd-rw',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        // Pin a minimal env so the assertion below is deterministic.
        env: { PATH: '/usr/bin:/bin', HOME: '/home/test', UNSAFE_TOKEN: 'leak' },
        platform: 'darwin',
        which: (name) => (name === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : null),
        // Slice 154: pin exists() so canonical-first hits /usr/bin/sandbox-exec
        // deterministically regardless of host filesystem.
        exists: (p) => p === '/usr/bin/sandbox-exec',
        realpath: (p) => p,
      });
      // Slice 154 (review): argv[0] is the absolute resolved path.
      expect(argv[0]).toBe('/usr/bin/sandbox-exec');
      expect(argv[1]).toBe('-p');
      // Profile string is the third element; contains the SBPL
      // version + the cwd writable subpath.
      expect(argv[2]).toContain('(version 1)');
      expect(argv[2]).toContain('(allow file-write* (subpath "/work/proj"))');
      // Slice 162: argv[3] is the canonical /usr/bin/env path
      // (PATH-shim resistance, mirrors slice 154's pattern).
      expect(argv[3]).toBe('/usr/bin/env');
      expect(argv[4]).toBe('-i');
      // env -i assignments. Only allowlisted vars present in env.
      // UNSAFE_TOKEN must NOT appear — that's the slice 162 fix.
      const innerStart = argv.indexOf('--');
      expect(innerStart).toBeGreaterThan(4);
      const envAssignments = argv.slice(5, innerStart);
      expect(envAssignments).toContain('PATH=/usr/bin:/bin');
      expect(envAssignments).toContain('HOME=/home/test');
      expect(envAssignments.some((a) => a.startsWith('UNSAFE_TOKEN='))).toBe(false);
      // After `--` the original innerArgv.
      expect(argv.slice(innerStart + 1)).toEqual(['bash', '-c', 'echo hi']);
    });

    // Slice 175 (review — sandbox escape P1, PATH-walk hijack).
    // Bare `innerArgv[0]` (e.g. `bash`) lets the kernel's execve
    // inside the sandbox re-walk $PATH at exec time. cwd-rw makes
    // cwd writable, and if cwd happens to be on PATH a prior
    // sandboxed call could plant a `bash` shim there; the next
    // call's bare `bash` would resolve to the shim. Wrapper now
    // pins innerArgv[0] to an absolute path AT WRAP TIME using
    // the OUTER process's $PATH (trusted by the operator). The
    // sandboxed exec sees `/bin/bash`, no $PATH walk, no shim.
    test('inner argv[0] is canonicalized to absolute path before wrap (slice 175)', () => {
      const argv = maybeWrapSandboxArgv({
        profile: 'cwd-rw',
        cwd: CWD,
        home: HOME,
        innerArgv: ['bash', '-s'], // bare; would be PATH-resolved inside sandbox
        env: { PATH: '/usr/bin:/bin' },
        platform: 'linux',
        which: (name) => {
          if (name === 'bwrap') return '/usr/bin/bwrap';
          if (name === 'bash') return '/bin/bash'; // operator's canonical bash
          return null;
        },
        exists: (p) => p === '/usr/bin/bwrap',
        realpath: (p) => p,
      });
      // bwrap argv ends with `-- <inner>`. The first inner element
      // must be the absolute /bin/bash, not the bare name.
      const sepIdx = argv.indexOf('--');
      expect(sepIdx).toBeGreaterThan(0);
      expect(argv[sepIdx + 1]).toBe('/bin/bash');
      expect(argv[sepIdx + 2]).toBe('-s');
    });

    test('inner argv[0] already absolute is passed through unchanged (slice 175)', () => {
      // If the caller already gave an absolute path, the canonicalizer
      // shouldn't double-resolve or alter it.
      const argv = maybeWrapSandboxArgv({
        profile: 'cwd-rw',
        cwd: CWD,
        home: HOME,
        innerArgv: ['/opt/custom/bash', '-s'],
        env: { PATH: '/usr/bin:/bin' },
        platform: 'linux',
        which: (name) => {
          if (name === 'bwrap') return '/usr/bin/bwrap';
          return null;
        },
        exists: (p) => p === '/usr/bin/bwrap',
        realpath: (p) => p,
      });
      const sepIdx = argv.indexOf('--');
      expect(argv[sepIdx + 1]).toBe('/opt/custom/bash');
    });

    test('inner argv[0] unresolvable falls back to original (slice 175 — best-effort)', () => {
      // If which() can't resolve the bare name, we keep the original
      // argv and let the sandboxed exec fail loudly rather than
      // silently picking up whatever the kernel resolves first.
      const argv = maybeWrapSandboxArgv({
        profile: 'cwd-rw',
        cwd: CWD,
        home: HOME,
        innerArgv: ['some-tool-that-doesnt-exist', 'arg'],
        env: { PATH: '/usr/bin:/bin' },
        platform: 'linux',
        which: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
        exists: (p) => p === '/usr/bin/bwrap',
        realpath: (p) => p,
      });
      const sepIdx = argv.indexOf('--');
      // Argv pinned literally; no synthetic absolute path invented.
      expect(argv[sepIdx + 1]).toBe('some-tool-that-doesnt-exist');
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
      realpath: (p) => p,
    });
    expect(argv).toEqual([...INNER]);
  });

  test('undefined profile passes through (no-sandbox-requested shape)', () => {
    const argv = maybeWrapSandboxArgv({
      cwd: CWD,
      innerArgv: INNER,
      platform: 'linux',
      realpath: (p) => p,
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
        realpath: (p) => p,
      }),
    ).toThrow(/unknown profile 'attacker'/);
  });

  test('error message lists every supported profile', () => {
    try {
      maybeWrapSandboxArgv({
        profile: 'nope',
        cwd: CWD,
        innerArgv: INNER,
        realpath: (p) => p,
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
        realpath: (p) => p,
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
    // Canonical file list — masked via an empty-regular-file overlay
    // (NOT /dev/null: a char device breaks git/npm config readers).
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.netrc`);
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.docker/config.json`);
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.npmrc`);
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.pypirc`);
    // Slice 149 (review): gitconfig (executable hooks) + cargo
    // credentials.toml (crates.io API token).
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.gitconfig`);
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.cargo/credentials.toml`);
  };

  test('ro profile emits hide_paths flags', () => {
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      // Pin every credential path "present" so these tests assert the
      // masking CONTRACT, decoupled from the runner's real home. The
      // existence-gating behavior has its own describe below.
      pathExists: () => true,
      maskFileSource: MASK,
    });
    expectHidePaths(argv);
  });

  test('cwd-rw profile emits hide_paths flags', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
      maskFileSource: MASK,
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
      realpath: (p) => p,
      pathExists: () => true,
      maskFileSource: MASK,
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
      realpath: (p) => p,
      pathExists: () => true,
      maskFileSource: MASK,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
      pathExists: () => true,
      maskFileSource: MASK,
    });
    const argvStr = argv.join(' ');
    expect(argvStr).toContain('--tmpfs /Users/devloper/.ssh');
    expect(argvStr).toContain(`--ro-bind ${MASK} /Users/devloper/.netrc`);
  });
});

// Regression — hide_paths mount-realizability gate. A `--tmpfs` /
// `--ro-bind /dev/null` overlay mounts OVER its target; for an ABSENT
// target under the read-only `--ro-bind / /` base, bwrap first tries
// to `mkdir` the mountpoint and fails with EROFS ("Can't mkdir
// <path>: Read-only file system"), aborting the ENTIRE spawn before
// the inner command runs. Few hosts have every credential dir/file
// present, so pre-gate this broke sandbox-enforced spawn-broker calls
// almost everywhere (the build smoke only exercised the NON-bwrap
// worker path, so it never surfaced). The runner now emits a mask
// only when the target exists OR its parent is writable in-profile.
describe('buildBwrapArgv — hide_paths existence gate (EROFS regression)', () => {
  test('cwd-rw-net: absent credential dir is NOT masked (would EROFS)', () => {
    // The common case: host has ~/.ssh but not ~/.aws.
    const present = new Set(['/home/op/.ssh']);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw-net',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: (p) => present.has(p),
    });
    const argvStr = argv.join(' ');
    // Present → masked.
    expect(argvStr).toContain('--tmpfs /home/op/.ssh');
    // Absent + cwd (/work/proj) is NOT under home → home stays
    // read-only → skip so bwrap never attempts the failing mkdir.
    expect(argvStr).not.toContain('--tmpfs /home/op/.aws');
    expect(argvStr).not.toContain('--tmpfs /home/op/.gnupg');
  });

  test('cwd-rw: absent credential FILE is NOT masked (would EROFS)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => false,
    });
    const argvStr = argv.join(' ');
    expect(argvStr).not.toContain('/home/op/.gitconfig');
    expect(argvStr).not.toContain('/home/op/.cargo/credentials.toml');
  });

  test('ro: all-absent host emits NO hide_paths overlays but keeps base flags', () => {
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => false,
    });
    const argvStr = argv.join(' ');
    // No credential overlays at all.
    expect(argvStr).not.toContain('/home/op/.ssh');
    expect(argvStr).not.toContain('/home/op/.aws');
    expect(argvStr).not.toContain('/dev/null /home/op/.netrc');
    // Base sandbox shape untouched — common --tmpfs /tmp + inner cmd.
    expect(argvStr).toContain('--tmpfs /tmp');
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([...INNER]);
  });

  test('home-rw: absent paths STILL masked (writable parent → create-and-plant defense)', () => {
    // home-rw binds $HOME read-WRITE, so bwrap CAN create the
    // mountpoint for an absent target — AND the create-and-plant
    // write-tampering vector (~/.gitconfig core.sshCommand RCE,
    // ~/.config/forja/permissions.yaml policy tamper) is live. Mask
    // regardless of host existence.
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => false,
      maskFileSource: MASK,
    });
    const argvStr = argv.join(' ');
    expect(argvStr).toContain('--tmpfs /home/op/.ssh');
    expect(argvStr).toContain('--tmpfs /home/op/.config/forja');
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.gitconfig`);
  });

  test('cwd-rw: absent target UNDER the writable cwd is masked', () => {
    // Edge: operator launched from $HOME, so hide_paths land under
    // the writable cwd bind. bwrap can create the mountpoint there
    // even when absent, and cwd being writable makes create-and-plant
    // applicable — so mask.
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: HOME,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => false,
    });
    const argvStr = argv.join(' ');
    expect(argvStr).toContain('--tmpfs /home/op/.ssh');
  });

  test('omitting pathExists falls back to the real filesystem without throwing', () => {
    // No seam → node:fs.existsSync. Just assert the wrap is still
    // well-formed; absent host creds simply produce fewer overlays.
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
    });
    expect(argv[0]).toBe('bwrap');
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([...INNER]);
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
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
        realpath: (p) => p,
        // Relocated data dir exists on the host (the real
        // protect-worthy case); were it absent the gate would skip it
        // to avoid the read-only-parent mkdir EROFS.
        pathExists: () => true,
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

  test('XDG_DATA_HOME relocated but ABSENT: extra overlay SKIPPED (EROFS guard, review gap)', () => {
    // The relocated data dir lives OUTSIDE home, so on home-rw it sits
    // under the read-only base bind. When it does NOT exist on the host,
    // emitting `--tmpfs /tmp/data/forja` would make bwrap mkdir the
    // mountpoint under a read-only parent → EROFS, aborting the spawn. The
    // gate (pathExists=false AND not under a writable root) skips it; the
    // canonical home-relative overlay (under the writable home) stays.
    process.env.XDG_DATA_HOME = '/tmp/data';
    try {
      const argv = buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/work/proj',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
        realpath: (p) => p,
        pathExists: () => false,
      });
      const argvStr = argv.join(' ');
      expect(argvStr).not.toContain('--tmpfs /tmp/data/forja');
      expect(argvStr).toContain('--tmpfs /home/op/.local/share/forja');
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
        realpath: (p) => p,
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

  test('XDG_DATA_HOME set to a RELATIVE path: extra overlay skipped (review fix)', () => {
    // Pre-review-fix: defaultDataDir() returned `relative/forja`,
    // which the branch unconditionally pushed as `--tmpfs
    // relative/forja` — an invalid bwrap mount target that crashed
    // sandboxed executions at spawn time. Per XDG spec, relative
    // values SHOULD be ignored; the home-relative `.local/share/forja`
    // is still masked by the HIDE_PATHS_DIRS loop, so the operator
    // remains protected without the bwrap error.
    process.env.XDG_DATA_HOME = 'relative/path';
    try {
      const argv = buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/work/proj',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
        realpath: (p) => p,
      });
      // No --tmpfs argument should carry the relative path.
      const relativeTmpfs = argv.some(
        (v, i) => v === '--tmpfs' && (argv[i + 1] ?? '').startsWith('relative/'),
      );
      expect(relativeTmpfs).toBe(false);
      // Canonical home-relative overlay still present (defense in
      // depth — the operator's data dir at .local/share/forja is
      // still masked even though XDG was malformed).
      expect(argv.join(' ')).toContain('--tmpfs /home/op/.local/share/forja');
    } finally {
      restoreEnv();
    }
  });

  test('XDG_DATA_HOME = "./local-data": relative-prefix variant also skipped', () => {
    // Cover the `./` and `../` shapes too — defaultDataDir would
    // produce `./local-data/forja` (still relative); the absolute
    // guard rejects it. No bwrap-crashing tmpfs target lands in argv.
    process.env.XDG_DATA_HOME = './local-data';
    try {
      const argv = buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/work/proj',
        home: '/home/op',
        innerArgv: INNER,
        env: {},
        realpath: (p) => p,
      });
      const relativeTmpfs = argv.some((v, i) => {
        const next = argv[i + 1] ?? '';
        return v === '--tmpfs' && !next.startsWith('/') && next.length > 0;
      });
      expect(relativeTmpfs).toBe(false);
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
      realpath: (p) => p,
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
      realpath: (p) => p,
      // Relocated config dirs exist on the host (the real case worth
      // masking); absent they'd be skipped to avoid the EROFS mkdir.
      pathExists: () => true,
      maskFileSource: MASK,
    });
    const argvStr = argv.join(' ');
    // Canonical home-relative overlays still present (defense
    // against process-env override at runtime).
    expect(argvStr).toContain('--tmpfs /home/op/.config/gcloud');
    expect(argvStr).toContain('--tmpfs /home/op/.config/azure');
    expect(argvStr).toContain('--tmpfs /home/op/.config/op');
    expect(argvStr).toContain('--tmpfs /home/op/.config/sops');
    expect(argvStr).toContain('--tmpfs /home/op/.config/forja');
    expect(argvStr).toContain('--tmpfs /home/op/.config/forja');
    // Plus the XDG-relocated overlays, one per .config/* entry.
    expect(argvStr).toContain('--tmpfs /srv/conf/gcloud');
    expect(argvStr).toContain('--tmpfs /srv/conf/azure');
    expect(argvStr).toContain('--tmpfs /srv/conf/op');
    expect(argvStr).toContain('--tmpfs /srv/conf/sops');
    expect(argvStr).toContain('--tmpfs /srv/conf/forja');
    // FILES under .config/* (NuGet/Composer auth) must ALSO be masked at the
    // relocated path, not only home-relative (#2 review fix). Without it, a
    // relocated XDG_CONFIG_HOME left the real registry-token files readable.
    expect(argvStr).toContain(`--ro-bind ${MASK} /home/op/.config/NuGet/NuGet.Config`);
    expect(argvStr).toContain(`--ro-bind ${MASK} /srv/conf/NuGet/NuGet.Config`);
    expect(argvStr).toContain(`--ro-bind ${MASK} /srv/conf/composer/auth.json`);
  });

  test('XDG_CONFIG_HOME equal to home-relative default: no duplicate overlays', () => {
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: INNER,
      env: { XDG_CONFIG_HOME: '/home/op/.config' },
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      const argv = buildBwrapArgv({
        profile,
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: (p) => p,
      });
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
      realpath: (p) => p,
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
      const argv = buildBwrapArgv({
        profile,
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: (p) => p,
      });
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
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
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
      realpath: (p) => p,
    });
    expect(argv).toContain('--clearenv');
    const setenvCount = argv.filter((v) => v === '--setenv').length;
    expect(setenvCount).toBe(0);
  });
});

// Forja-internal control-plane env (e.g. `FORJA_BROKER_WORKER=1`)
// has to survive `--clearenv` — without it the compiled-binary
// self-exec path falls back to normal CLI parsing inside the
// sandboxed inner. `passthroughEnv` plumbs the entries through as
// additional `--setenv` flags AFTER the safe-list loop.
describe('buildBwrapArgv — passthroughEnv (forja control plane)', () => {
  test('passthroughEnv entries emit --setenv after the safe-list loop', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: { PATH: '/usr/bin' },
      passthroughEnv: { FORJA_BROKER_WORKER: '1' },
      realpath: (p) => p,
    });
    const setenvAt = (key: string, value: string): boolean => {
      for (let i = 0; i < argv.length - 2; i++) {
        if (argv[i] === '--setenv' && argv[i + 1] === key && argv[i + 2] === value) return true;
      }
      return false;
    };
    expect(setenvAt('PATH', '/usr/bin')).toBe(true);
    expect(setenvAt('FORJA_BROKER_WORKER', '1')).toBe(true);
    // The passthrough --setenv lands AFTER the safe-list loop, so
    // bwrap's last-setenv-wins semantics let a colliding passthrough
    // key override a safe-list value (see next test).
    const pathIdx = argv.findIndex(
      (v, i) => v === '--setenv' && argv[i + 1] === 'PATH' && argv[i + 2] === '/usr/bin',
    );
    const fbwIdx = argv.findIndex(
      (v, i) => v === '--setenv' && argv[i + 1] === 'FORJA_BROKER_WORKER' && argv[i + 2] === '1',
    );
    expect(pathIdx).toBeGreaterThan(-1);
    expect(fbwIdx).toBeGreaterThan(pathIdx);
  });

  test('passthroughEnv key colliding with safe-list wins (last --setenv wins)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: { PATH: '/usr/bin' },
      passthroughEnv: { PATH: '/forja/bin' },
      realpath: (p) => p,
    });
    const pathSetenvs: string[] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === '--setenv' && argv[i + 1] === 'PATH') pathSetenvs.push(argv[i + 2] as string);
    }
    expect(pathSetenvs).toEqual(['/usr/bin', '/forja/bin']);
  });

  test('passthroughEnv with NUL in value is skipped (same defense as safe-list)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      passthroughEnv: { FORJA_BROKER_WORKER: '1', BAD: 'a\0b' },
      realpath: (p) => p,
    });
    const setenvKeys: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--setenv') setenvKeys.push(argv[i + 1] as string);
    }
    expect(setenvKeys).toContain('FORJA_BROKER_WORKER');
    expect(setenvKeys).not.toContain('BAD');
  });

  test('passthroughEnv with NUL or = in key is skipped (argv-injection defense)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      passthroughEnv: {
        GOOD: 'ok',
        'BAD\0KEY': 'x',
        'BAD=KEY': 'y',
        '': 'empty',
      },
      realpath: (p) => p,
    });
    const setenvKeys: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--setenv') setenvKeys.push(argv[i + 1] as string);
    }
    expect(setenvKeys).toContain('GOOD');
    expect(setenvKeys).not.toContain('BAD\0KEY');
    expect(setenvKeys).not.toContain('BAD=KEY');
    expect(setenvKeys).not.toContain('');
  });

  test('passthroughEnv omitted → no extra --setenv beyond safe-list', () => {
    const baseline = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: { PATH: '/usr/bin' },
      realpath: (p) => p,
    });
    const baselineSetenvKeys: string[] = [];
    for (let i = 0; i < baseline.length - 1; i++) {
      if (baseline[i] === '--setenv') baselineSetenvKeys.push(baseline[i + 1] as string);
    }
    expect(baselineSetenvKeys).not.toContain('FORJA_BROKER_WORKER');
  });
});

describe('maybeWrapSandboxArgv — passthroughEnv plumbing', () => {
  test('linux: forwards passthroughEnv into the bwrap --setenv tail', () => {
    const argv = maybeWrapSandboxArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: ['/usr/bin/forja'],
      env: { PATH: '/usr/bin' },
      passthroughEnv: { FORJA_BROKER_WORKER: '1' },
      platform: 'linux',
      which: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
      exists: (p) => p === '/usr/bin/bwrap',
      realpath: (p) => p,
    });
    const fbwIdx = argv.findIndex(
      (v, i) => v === '--setenv' && argv[i + 1] === 'FORJA_BROKER_WORKER' && argv[i + 2] === '1',
    );
    expect(fbwIdx).toBeGreaterThan(-1);
    // And it lands inside the bwrap arg section (before the `--`
    // separator), not in the inner argv.
    const sepIdx = argv.indexOf('--');
    expect(fbwIdx).toBeLessThan(sepIdx);
  });
});

// Slice 155 (review — symlink canonicalization for cwd guard).
// The literal-string `cwd.startsWith(hiddenAbs)` check pre-slice
// could be bypassed via a symlink like `/tmp/work → ~/.ssh/audit/`.
// `realpath()` resolves the symlink before the guard runs; the
// resolved canonical target either still bypasses the hide_paths
// check (legitimate workflow) or hits it as the canonical hidden
// path (and the existing guard refuses cleanly).
describe('buildBwrapArgv — symlink canonicalization (slice 155)', () => {
  test('symlink cwd pointing to hide_paths dir → refused after realpath', () => {
    // Simulate: /tmp/work is a symlink to /home/op/.ssh/audit.
    // realpath() returns the canonical target; the hide_paths
    // check then sees a path INSIDE .ssh and refuses.
    expect(() =>
      buildBwrapArgv({
        profile: 'home-rw',
        cwd: '/tmp/work',
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: (p) => (p === '/tmp/work' ? '/home/op/.ssh/audit' : p),
      }),
    ).toThrow(/inside hide_paths dir/);
  });

  test('symlink cwd pointing outside hide_paths → accepted with canonical path', () => {
    // /tmp/work → /var/build/project. Canonical target is outside
    // any hide_paths dir, so build succeeds with the canonical
    // path used as --chdir + --bind.
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: '/tmp/work',
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => (p === '/tmp/work' ? '/var/build/project' : p),
    });
    const argvStr = argv.join(' ');
    expect(argvStr).toContain('--bind /var/build/project /var/build/project');
    expect(argvStr).toContain('--chdir /var/build/project');
    // The original symlink path does NOT appear — the kernel exec'd
    // path is canonical.
    expect(argvStr).not.toContain('/tmp/work');
  });

  test('non-symlink cwd: realpath returns same path → no change in argv', () => {
    // realpath of a non-symlink is the path itself. argv must
    // reflect the same shape as pre-slice for the common case.
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: '/work/proj',
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
    });
    const argvStr = argv.join(' ');
    expect(argvStr).toContain('--bind /work/proj /work/proj');
    expect(argvStr).toContain('--chdir /work/proj');
  });

  test('broken symlink (ENOENT) → refused with clear message', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'cwd-rw',
        cwd: '/tmp/dangling',
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: () => {
          const e = new Error('ENOENT') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        },
      }),
    ).toThrow(/does not exist.*broken symlink/);
  });

  test('symlink cycle (ELOOP) → refused with clear message', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'cwd-rw',
        cwd: '/tmp/cycle',
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: () => {
          const e = new Error('ELOOP') as NodeJS.ErrnoException;
          e.code = 'ELOOP';
          throw e;
        },
      }),
    ).toThrow(/symlink chain loops/);
  });

  test('EACCES on ancestor → refused with permission-denied message', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'cwd-rw',
        cwd: '/restricted/work',
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: () => {
          const e = new Error('EACCES') as NodeJS.ErrnoException;
          e.code = 'EACCES';
          throw e;
        },
      }),
    ).toThrow(/permission denied/);
  });

  test('ENOTDIR on ancestor → refused with not-a-directory message', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'cwd-rw',
        cwd: '/etc/passwd/subdir',
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: () => {
          const e = new Error('ENOTDIR') as NodeJS.ErrnoException;
          e.code = 'ENOTDIR';
          throw e;
        },
      }),
    ).toThrow(/not a directory/);
  });

  test('unknown realpath error → refused with diagnostic', () => {
    expect(() =>
      buildBwrapArgv({
        profile: 'cwd-rw',
        cwd: '/some/path',
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: () => {
          const e = new Error('arbitrary failure') as NodeJS.ErrnoException;
          e.code = 'EWHATEVER';
          throw e;
        },
      }),
    ).toThrow(/cannot be canonicalized/);
  });
});

describe('buildBwrapArgv — production credential-file mask source (no seam)', () => {
  test('binds an empty REGULAR 0600 file (not /dev/null) under the data dir', () => {
    // Closes the review gap: every file-mask test pins `maskFileSource`,
    // so the real `ensureSandboxMaskFile` path — the actual git/npm fix —
    // was untested (a revert to `/dev/null` would have passed). Drive it
    // via a pinned $XDG_DATA_HOME temp dir so the real home is untouched.
    const tmp = mkdtempSync(`${tmpdir()}/forja-mask-test-`);
    const origXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmp;
    __resetSandboxMaskFileCacheForTest();
    try {
      const argv = buildBwrapArgv({
        profile: 'cwd-rw',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        env: {},
        realpath: (p) => p,
        pathExists: () => true,
        // NO maskFileSource — exercise the production ensureSandboxMaskFile.
      });
      const i = argv.findIndex(
        (v, idx) => v === '--ro-bind' && argv[idx + 2] === '/home/op/.netrc',
      );
      expect(i).toBeGreaterThanOrEqual(0);
      const src = argv[i + 1] as string;
      expect(src).not.toBe('/dev/null');
      expect(src.endsWith('/forja/sandbox-mask-empty')).toBe(true);
      const st = statSync(src);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBe(0);
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      if (origXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdg;
      __resetSandboxMaskFileCacheForTest();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Opt-in persistence: cache_persistence + shared_tmp (this slice) ──

const hasSetenvFlag = (argv: readonly string[], key: string, value: string): boolean => {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--setenv' && argv[i + 1] === key && argv[i + 2] === value) return true;
  }
  return false;
};
const bindPairIndex = (argv: readonly string[], src: string, dst: string): number => {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--bind' && argv[i + 1] === src && argv[i + 2] === dst) return i;
  }
  return -1;
};

const roBindPairIndex = (argv: readonly string[], src: string, dst: string): number => {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === '--ro-bind' && argv[i + 1] === src && argv[i + 2] === dst) return i;
  }
  return -1;
};

describe('buildBwrapArgv — persistent cache (cache_persistence; runner gate)', () => {
  // Pin XDG_CACHE_HOME to <HOME>/.cache so forjaCachePersistBase() lands at
  // <HOME>/.cache/forja/cache — NESTED under the `.cache` tmpfs carve-out,
  // exactly like production with XDG unset. Lets us assert the punch-through
  // ordering for real. Reset BOTH module overrides around each test.
  let origXdgCache: string | undefined;
  beforeEach(() => {
    origXdgCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = `${HOME}/.cache`;
    setCachePersistenceOverride(undefined);
    setWritableCacheDirsOverride(undefined);
  });
  afterEach(() => {
    setCachePersistenceOverride(undefined);
    setWritableCacheDirsOverride(undefined);
    if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origXdgCache;
  });

  const PERSIST_BASE = `${HOME}/.cache/forja/cache`;

  // The RUNNER is gated on the explicit override (undefined → off): a
  // defensive posture so any path that forgot to set it stays ephemeral.
  // Production resolves the default (ON) at bootstrap/subagent, NOT here.
  test('no override set → runner stays ephemeral (no redirect env, no persistent bind)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
    });
    expect(bindPairIndex(argv, PERSIST_BASE, PERSIST_BASE)).toBe(-1);
    expect(argv.includes('XDG_CACHE_HOME')).toBe(false);
    expect(argv.includes('MAVEN_ARGS')).toBe(false);
  });

  test('ON (cwd-rw) — injects redirect env (incl. the Maven flag form) + persistent bind', () => {
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
    });
    expect(hasSetenvFlag(argv, 'XDG_CACHE_HOME', `${PERSIST_BASE}/xdg`)).toBe(true);
    expect(hasSetenvFlag(argv, 'GOMODCACHE', `${PERSIST_BASE}/go/mod`)).toBe(true);
    expect(hasSetenvFlag(argv, 'npm_config_cache', `${PERSIST_BASE}/npm`)).toBe(true);
    expect(hasSetenvFlag(argv, 'MAVEN_ARGS', `-Dmaven.repo.local=${PERSIST_BASE}/maven`)).toBe(
      true,
    );
    expect(bindPairIndex(argv, PERSIST_BASE, PERSIST_BASE)).toBeGreaterThanOrEqual(0);
  });

  test('ON + profile=ro — redirect env + READ-ONLY cache re-bind, but NO writable bind/mask', () => {
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
    });
    // ro resolves the SAME Forja cache a writable command writes (coherence:
    // no more host-cache-vs-Forja-cache split by profile) via the redirect env.
    // It gets a READ-ONLY re-bind of persistBase so the cache stays reachable
    // even when it nests under a re-mounted path (e.g. $XDG_CACHE_HOME under
    // /tmp) — but NO writable `--bind` and NO host-cache tmpfs mask, so `ro`
    // never gains persistent write.
    expect(hasSetenvFlag(argv, 'XDG_CACHE_HOME', `${PERSIST_BASE}/xdg`)).toBe(true);
    expect(hasSetenvFlag(argv, 'GOMODCACHE', `${PERSIST_BASE}/go/mod`)).toBe(true);
    expect(roBindPairIndex(argv, PERSIST_BASE, PERSIST_BASE)).toBeGreaterThanOrEqual(0);
    expect(bindPairIndex(argv, PERSIST_BASE, PERSIST_BASE)).toBe(-1); // not WRITABLE
    // no host-cache tmpfs mask either (that lives in pushCacheCarveOut)
    expect(argv.indexOf(`${HOME}/.cache`)).toBe(-1);
  });

  test('ON + profile=ro, persistBase absent — no cache re-bind (graceful, redirect still set)', () => {
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: (p) => p !== PERSIST_BASE, // everything exists except the base
    });
    // Existence-gated like the writable bind: absent base → no re-bind (bwrap
    // would otherwise abort on a missing source), redirect env still injected.
    expect(hasSetenvFlag(argv, 'XDG_CACHE_HOME', `${PERSIST_BASE}/xdg`)).toBe(true);
    expect(roBindPairIndex(argv, PERSIST_BASE, PERSIST_BASE)).toBe(-1);
  });

  test('ON + profile=ro — cache re-bind sits AFTER the /tmp mount, BEFORE the credential overlay', () => {
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      maskFileSource: MASK,
      pathExists: () => true, // /tmp mount (base) + persistBase + .netrc all present
    });
    const tmpMount = argv.indexOf('/tmp'); // the `--tmpfs /tmp` baseline pair
    const roBind = roBindPairIndex(argv, PERSIST_BASE, PERSIST_BASE);
    const credOverlay = argv.indexOf(`${HOME}/.netrc`);
    expect(tmpMount).toBeGreaterThanOrEqual(0);
    expect(roBind).toBeGreaterThan(tmpMount); // re-bind punches through the /tmp re-mount
    expect(credOverlay).toBeGreaterThan(roBind); // credential overlay still wins
  });

  test('ON + home-rw — persist bind + redirect, after the $HOME bind', () => {
    // home-rw is a writable profile: it must get the dedicated cache too,
    // else its PMs poison the real host caches the $HOME bind exposes.
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'home-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
    });
    const persistBind = bindPairIndex(argv, PERSIST_BASE, PERSIST_BASE);
    const homeBind = bindPairIndex(argv, HOME, HOME);
    expect(persistBind).toBeGreaterThanOrEqual(0);
    expect(persistBind).toBeGreaterThan(homeBind); // bind punches through after $HOME
    expect(argv.includes('XDG_CACHE_HOME')).toBe(true); // redirect env injected
  });

  test('ON but persistBase absent — redirect still injected, bind skipped (graceful degrade)', () => {
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: (p) => p !== PERSIST_BASE, // everything exists except the base
    });
    expect(hasSetenvFlag(argv, 'XDG_CACHE_HOME', `${PERSIST_BASE}/xdg`)).toBe(true);
    expect(bindPairIndex(argv, PERSIST_BASE, PERSIST_BASE)).toBe(-1);
  });

  test('ORDERING: persist bind AFTER the .cache tmpfs, BEFORE cwd bind + credential overlay', () => {
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      maskFileSource: MASK,
      pathExists: () => true, // .cache carve-out + persistBase + .netrc all present
    });
    const cacheTmpfs = argv.indexOf(`${HOME}/.cache`);
    const persistBind = bindPairIndex(argv, PERSIST_BASE, PERSIST_BASE);
    const cwdBind = bindPairIndex(argv, CWD, CWD);
    const credOverlay = argv.indexOf(`${HOME}/.netrc`);
    expect(cacheTmpfs).toBeGreaterThanOrEqual(0);
    expect(persistBind).toBeGreaterThan(cacheTmpfs);
    expect(cwdBind).toBeGreaterThan(persistBind);
    expect(credOverlay).toBeGreaterThan(persistBind);
  });

  test('caller passthrough (FORJA_BROKER_WORKER) coexists with the redirect env', () => {
    setCachePersistenceOverride(true);
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
      passthroughEnv: { FORJA_BROKER_WORKER: '1' },
    });
    expect(hasSetenvFlag(argv, 'FORJA_BROKER_WORKER', '1')).toBe(true);
    expect(hasSetenvFlag(argv, 'XDG_CACHE_HOME', `${PERSIST_BASE}/xdg`)).toBe(true);
  });
});

describe('buildBwrapArgv — per-session /tmp (shared_tmp / sessionTmpDir)', () => {
  const SESSION_TMP = `${HOME}/.cache/forja/tmp/sessions/sess-1`;

  test('default (no sessionTmpDir) — /tmp stays a fresh tmpfs', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
    });
    expect(hasTmpfs(argv, '/tmp')).toBe(true);
    expect(bindPairIndex(argv, SESSION_TMP, '/tmp')).toBe(-1);
  });

  test('sessionTmpDir set — /tmp becomes a bind of the session dir (tmpfs replaced in place)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
      sessionTmpDir: SESSION_TMP,
    });
    expect(hasTmpfs(argv, '/tmp')).toBe(false);
    expect(bindPairIndex(argv, SESSION_TMP, '/tmp')).toBeGreaterThanOrEqual(0);
  });

  test('maybeWrapSandboxArgv (linux) maps the tmpdir option to the /tmp bind', () => {
    const argv = maybeWrapSandboxArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      platform: 'linux',
      which: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
      exists: (p) => p === '/usr/bin/bwrap',
      realpath: (p) => p,
      pathExists: () => true,
      tmpdir: SESSION_TMP,
    });
    expect(hasTmpfs(argv, '/tmp')).toBe(false);
    expect(bindPairIndex(argv, SESSION_TMP, '/tmp')).toBeGreaterThanOrEqual(0);
  });

  test('read-only profile (ro) ALSO binds sessionTmpDir — /tmp coherent across the session', () => {
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
      sessionTmpDir: SESSION_TMP,
    });
    // shared_tmp is per-session, not per-profile: a read-only `cat /tmp/x`
    // (which resolves to `ro`) must see what a prior writable `touch
    // /tmp/x` wrote. The bind applies to every profile, and TMPDIR=/tmp is
    // forced so mktemp/tempfile land in the session dir. `ro` already had a
    // writable baseline tmpfs /tmp, so this grants no new access — only
    // coherence.
    expect(hasTmpfs(argv, '/tmp')).toBe(false);
    expect(bindPairIndex(argv, SESSION_TMP, '/tmp')).toBeGreaterThanOrEqual(0);
    expect(hasSetenvFlag(argv, 'TMPDIR', '/tmp')).toBe(true);
  });

  test('ro WITHOUT sessionTmpDir (shared_tmp off) keeps the fresh per-spawn tmpfs', () => {
    const argv = buildBwrapArgv({
      profile: 'ro',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      realpath: (p) => p,
      pathExists: () => true,
    });
    expect(hasTmpfs(argv, '/tmp')).toBe(true);
    expect(bindPairIndex(argv, SESSION_TMP, '/tmp')).toBe(-1);
    expect(hasSetenvFlag(argv, 'TMPDIR', '/tmp')).toBe(false);
  });

  test('writable profile + /tmp bind forces TMPDIR=/tmp (passthrough overrides host TMPDIR)', () => {
    const argv = buildBwrapArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      // Host TMPDIR points elsewhere; the forced TMPDIR=/tmp must win.
      env: { TMPDIR: '/var/tmp' },
      realpath: (p) => p,
      pathExists: () => true,
      sessionTmpDir: SESSION_TMP,
    });
    expect(bindPairIndex(argv, SESSION_TMP, '/tmp')).toBeGreaterThanOrEqual(0);
    expect(hasSetenvFlag(argv, 'TMPDIR', '/tmp')).toBe(true);
    // The safe-list emits the host TMPDIR (=/var/tmp) first; the forced
    // /tmp is emitted later via passthrough, so bwrap last-wins → /tmp.
    const idxHost = argv.findIndex(
      (v, i) => v === '--setenv' && argv[i + 1] === 'TMPDIR' && argv[i + 2] === '/var/tmp',
    );
    const idxTmp = argv.findIndex(
      (v, i) => v === '--setenv' && argv[i + 1] === 'TMPDIR' && argv[i + 2] === '/tmp',
    );
    expect(idxHost).toBeGreaterThanOrEqual(0);
    expect(idxTmp).toBeGreaterThan(idxHost);
  });
});

describe('maybeWrapSandboxArgv — fail-closed on mid-session sandbox loss', () => {
  test('failClosed + non-host profile + tool gone → throws (mid-session loss)', () => {
    expect(() =>
      maybeWrapSandboxArgv({
        profile: 'cwd-rw',
        cwd: CWD,
        home: HOME,
        innerArgv: INNER,
        env: {},
        platform: 'linux',
        which: () => null, // bwrap vanished mid-session
        exists: () => false, // canonical /usr/bin/bwrap gone too
        realpath: (p) => p,
        failClosed: true,
      }),
    ).toThrow(/unavailable mid-session/);
  });

  test('without failClosed → graceful passthrough (never-had host)', () => {
    const argv = maybeWrapSandboxArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      platform: 'linux',
      which: () => null,
      exists: () => false,
      realpath: (p) => p,
      // failClosed omitted → default; keeps the degraded passthrough
    });
    expect(argv).toEqual([...INNER]);
  });

  test('failClosed but host profile → no throw (host returns early)', () => {
    const argv = maybeWrapSandboxArgv({
      profile: 'host',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      platform: 'linux',
      which: () => null,
      exists: () => false,
      realpath: (p) => p,
      failClosed: true,
    });
    expect(argv).toEqual([...INNER]);
  });

  test('failClosed but tool STILL available → wraps normally (no throw)', () => {
    const argv = maybeWrapSandboxArgv({
      profile: 'cwd-rw',
      cwd: CWD,
      home: HOME,
      innerArgv: INNER,
      env: {},
      platform: 'linux',
      which: (n) => (n === 'bwrap' ? '/usr/bin/bwrap' : null),
      exists: (p) => p === '/usr/bin/bwrap',
      realpath: (p) => p,
      pathExists: () => true,
      failClosed: true,
    });
    expect(argv[0]).toBe('/usr/bin/bwrap');
  });
});

// End-to-end cross-profile coherence against REAL bwrap. The argv-shape tests
// above prove the flags; these prove the OBSERVABLE behavior the flags buy: a
// writable command (cwd-rw) and a read-only command (ro) in the same session
// see the SAME /tmp and the SAME persistent cache — the exact bug the gate
// removal fixed (write under one profile, read under another). Linux-only and
// gated on a real `bwrap`; the shape tests cover macOS + non-bwrap hosts.
//
// `/var/tmp` (FHS-mandated, NOT masked by the sandbox) hosts the scratch dirs:
// `/tmp` is replaced by the session bind (splice) so a sessTmp there is fine,
// but the cache base must live OUTSIDE `/tmp` — under `--tmpfs /tmp` (no
// shared_tmp) a cache base in `/tmp` is masked and the write never reaches the
// host (verified: that exact arrangement silently loses the write).
const E2E_UNAVAILABLE =
  process.platform !== 'linux' || Bun.which('bwrap') === null || !existsSync('/var/tmp');

describe.skipIf(E2E_UNAVAILABLE)(
  'buildBwrapArgv — E2E cross-profile coherence (real bwrap)',
  () => {
    const E2E_HOME = homedir();
    const E2E_CWD = process.cwd();
    let cacheRoot: string;
    let sessTmp: string;
    let origXdgCache: string | undefined;

    const run = async (
      profile: 'ro' | 'cwd-rw',
      inner: string[],
      sessionTmpDir?: string,
    ): Promise<{ code: number; out: string; err: string }> => {
      const argv = buildBwrapArgv({
        profile,
        cwd: E2E_CWD,
        home: E2E_HOME,
        innerArgv: inner,
        env: {},
        realpath: (p) => p,
        pathExists: (p) => existsSync(p),
        ...(sessionTmpDir !== undefined ? { sessionTmpDir } : {}),
      });
      const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
      const code = await proc.exited;
      const out = (await new Response(proc.stdout).text()).trim();
      const err = (await new Response(proc.stderr).text()).trim();
      return { code, out, err };
    };

    beforeEach(() => {
      origXdgCache = process.env.XDG_CACHE_HOME;
      cacheRoot = mkdtempSync('/var/tmp/forja-e2e-xdg-');
      // forjaCachePersistBase() honors XDG_CACHE_HOME → <cacheRoot>/forja/cache.
      process.env.XDG_CACHE_HOME = cacheRoot;
      sessTmp = mkdtempSync('/var/tmp/forja-e2e-tmp-');
      setCachePersistenceOverride(true);
      setWritableCacheDirsOverride(undefined);
      // Pre-create the Forja cache base so the cwd-rw `--bind` passes the
      // existence gate (bootstrap host-creates it in production).
      mkdirSync(join(forjaCachePersistBase(), 'xdg'), { recursive: true });
    });

    afterEach(() => {
      setCachePersistenceOverride(undefined);
      setWritableCacheDirsOverride(undefined);
      if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdgCache;
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(sessTmp, { recursive: true, force: true });
    });

    test('shared /tmp: a file written under cwd-rw is read back under ro (same session dir)', async () => {
      const w = await run(
        'cwd-rw',
        ['bash', '-c', 'printf hi > /tmp/probe.txt && echo ok'],
        sessTmp,
      );
      expect(w.code).toBe(0);
      const r = await run('ro', ['bash', '-c', 'cat /tmp/probe.txt'], sessTmp);
      expect(r.code).toBe(0);
      expect(r.out).toBe('hi');
    });

    test('persistent cache: a file written under cwd-rw is read back under ro (same Forja cache)', async () => {
      const w = await run('cwd-rw', [
        'bash',
        '-c',
        'printf v1 > "$XDG_CACHE_HOME/dep.txt" && echo ok',
      ]);
      expect(w.code).toBe(0);
      const r = await run('ro', ['bash', '-c', 'cat "$XDG_CACHE_HOME/dep.txt"']);
      expect(r.code).toBe(0);
      expect(r.out).toBe('v1');
    });

    test('ro keeps the cache read-only: writing the redirected cache fails (EROFS)', async () => {
      const r = await run('ro', ['bash', '-c', 'echo x > "$XDG_CACHE_HOME/dep.txt"']);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('Read-only file system');
    });

    test('REGRESSION: $XDG_CACHE_HOME UNDER /tmp — cwd-rw write still read back under ro', async () => {
      // The config the review caught: `forjaCacheDir()` honors an absolute
      // $XDG_CACHE_HOME, so the cache base can sit UNDER /tmp — which the
      // sandbox re-mounts (fresh tmpfs here, no shared_tmp). Without ro's
      // read-only re-bind, ro sees an empty /tmp and the cwd-rw write is
      // invisible (the exact cross-profile split the redirect should close).
      const tmpXdg = mkdtempSync('/tmp/forja-e2e-xdgtmp-');
      try {
        process.env.XDG_CACHE_HOME = tmpXdg; // forjaCachePersistBase() → tmpXdg/forja/cache
        mkdirSync(join(forjaCachePersistBase(), 'xdg'), { recursive: true });
        const w = await run('cwd-rw', [
          'bash',
          '-c',
          'printf vT > "$XDG_CACHE_HOME/dep.txt" && echo ok',
        ]);
        expect(w.code).toBe(0);
        const r = await run('ro', ['bash', '-c', 'cat "$XDG_CACHE_HOME/dep.txt"']);
        expect(r.code).toBe(0);
        expect(r.out).toBe('vT');
      } finally {
        rmSync(tmpXdg, { recursive: true, force: true });
      }
    });
  },
);
