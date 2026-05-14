import { describe, expect, test } from 'bun:test';
import {
  acquireSandboxTmpdir,
  detectSandboxAvailability,
  resolveSandboxBinary,
} from '../../src/permissions/sandbox-availability.ts';

// Slice 154 (review — PATH-shim resistance): the detection +
// resolution probe is hardened with a canonical-first lookup
// (/usr/bin/<tool> before $PATH walk) plus a stat-check on the
// PATH-resolved fallback. Tests pass deterministic stat / exists
// seams so the suite doesn't depend on the host having bwrap
// at /usr/bin or NOT having it — both paths are exercised.

// Helper: default stat-clean (root-owned, no non-owner write).
const cleanStat = (): { uid: number; mode: number } => ({ uid: 0, mode: 0o755 });

describe('detectSandboxAvailability', () => {
  test('linux + canonical /usr/bin/bwrap present → trustLevel canonical', () => {
    const r = detectSandboxAvailability({
      platform: 'linux',
      which: () => '/usr/bin/bwrap',
      stat: cleanStat,
      exists: (p) => p === '/usr/bin/bwrap',
      isExecutable: (p) => p === '/usr/bin/bwrap',
    });
    expect(r.available).toBe(true);
    expect(r.tool).toBe('bwrap');
    expect(r.path).toBe('/usr/bin/bwrap');
    expect(r.trustLevel).toBe('canonical');
    expect(r.trustWarnings).toEqual([]);
    expect(r.reason).toBe('');
  });

  test('linux + bwrap missing everywhere → unavailable with operator hint', () => {
    const r = detectSandboxAvailability({
      platform: 'linux',
      which: () => null,
      stat: () => null,
      exists: () => false,
    });
    expect(r.available).toBe(false);
    expect(r.tool).toBeNull();
    expect(r.path).toBeNull();
    expect(r.trustLevel).toBe('absent');
    expect(r.reason).toContain('bwrap binary not found');
    expect(r.reason).toContain('bubblewrap');
  });

  test('darwin + canonical /usr/bin/sandbox-exec present → trustLevel canonical', () => {
    // Mock isExecutable alongside exists so the test isn't dependent
    // on the host actually having /usr/bin/sandbox-exec installed
    // (e.g., this test runs on Linux CI where the file is absent).
    const r = detectSandboxAvailability({
      platform: 'darwin',
      which: () => '/usr/bin/sandbox-exec',
      stat: cleanStat,
      exists: (p) => p === '/usr/bin/sandbox-exec',
      isExecutable: (p) => p === '/usr/bin/sandbox-exec',
    });
    expect(r.available).toBe(true);
    expect(r.tool).toBe('sandbox-exec');
    expect(r.path).toBe('/usr/bin/sandbox-exec');
    expect(r.trustLevel).toBe('canonical');
  });

  test('darwin + sandbox-exec missing → unavailable', () => {
    const r = detectSandboxAvailability({
      platform: 'darwin',
      which: () => null,
      stat: () => null,
      exists: () => false,
    });
    expect(r.available).toBe(false);
    expect(r.tool).toBeNull();
    expect(r.path).toBeNull();
    expect(r.reason).toContain('sandbox-exec');
  });

  test('windows → unavailable (v2 unsupported)', () => {
    const r = detectSandboxAvailability({
      platform: 'win32',
      which: () => null,
      stat: () => null,
      exists: () => false,
    });
    expect(r.available).toBe(false);
    expect(r.tool).toBeNull();
    expect(r.path).toBeNull();
    expect(r.reason).toContain('not supported');
    expect(r.reason).toContain('win32');
  });

  test('windows does not even probe `which` or filesystem', () => {
    // Defense: we don't want a future code path to accidentally
    // call `which('bwrap')` on Windows, then misinterpret some WSL
    // shim. The probe is platform-gated.
    let whichProbed = false;
    let existsProbed = false;
    const r = detectSandboxAvailability({
      platform: 'win32',
      which: () => {
        whichProbed = true;
        return '/probably/wsl/shim/bwrap';
      },
      stat: cleanStat,
      exists: () => {
        existsProbed = true;
        return true;
      },
    });
    expect(r.available).toBe(false);
    expect(whichProbed).toBe(false);
    expect(existsProbed).toBe(false);
  });

  test('unknown platform → unavailable with platform-named reason', () => {
    const r = detectSandboxAvailability({
      platform: 'aix' as NodeJS.Platform,
      which: () => null,
      stat: () => null,
      exists: () => false,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('aix');
  });
});

// Slice 154 (review): resolveSandboxBinary is the canonical-first
// resolver used by both detectSandboxAvailability AND the runtime
// spawn path. Tests cover: canonical wins; PATH-resolved fallback
// with clean stat; PATH-resolved with non-root owner warning;
// PATH-resolved with world-writable warning; non-absolute path
// rejected.
describe('resolveSandboxBinary — canonical-first + stat-check (slice 154)', () => {
  test('canonical /usr/bin/bwrap exists → trustLevel canonical, no warnings', () => {
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/some/other/path/bwrap', // would lose to canonical
      stat: cleanStat,
      exists: (p) => p === '/usr/bin/bwrap',
      isExecutable: (p) => p === '/usr/bin/bwrap',
    });
    expect(r.path).toBe('/usr/bin/bwrap');
    expect(r.trustLevel).toBe('canonical');
    expect(r.trustWarnings).toEqual([]);
  });

  test('canonical missing → PATH-resolved with clean stat: trustLevel path-resolved + non-canonical warning', () => {
    // Nix install at /nix/store/...-bubblewrap/bin/bwrap, root-owned,
    // mode 0o755. Operator workflow that works but isn't canonical.
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/nix/store/abc-bubblewrap/bin/bwrap',
      stat: () => ({ uid: 0, mode: 0o755 }),
      exists: () => false, // canonical absent
    });
    expect(r.path).toBe('/nix/store/abc-bubblewrap/bin/bwrap');
    expect(r.trustLevel).toBe('path-resolved');
    expect(r.trustWarnings.length).toBe(1);
    expect(r.trustWarnings[0]).toContain('using non-canonical');
    expect(r.trustWarnings[0]).toContain('canonical is /usr/bin/bwrap');
  });

  test('PATH-resolved with non-root owner → trustWarning includes owner', () => {
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/home/op/.local/bin/bwrap',
      stat: () => ({ uid: 1000, mode: 0o755 }),
      exists: () => false,
    });
    expect(r.path).toBe('/home/op/.local/bin/bwrap');
    expect(r.trustLevel).toBe('path-resolved');
    expect(r.trustWarnings.some((w) => w.includes('not owned by root'))).toBe(true);
    expect(r.trustWarnings.some((w) => w.includes('uid=1000'))).toBe(true);
  });

  test('PATH-resolved with world-writable mode → trustWarning includes mode', () => {
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/tmp/evilbin/bwrap',
      stat: () => ({ uid: 0, mode: 0o777 }),
      exists: () => false,
    });
    expect(r.path).toBe('/tmp/evilbin/bwrap');
    expect(r.trustLevel).toBe('path-resolved');
    expect(r.trustWarnings.some((w) => w.includes('world-writable'))).toBe(true);
  });

  test('PATH-resolved with group-writable → trustWarning includes group-writable', () => {
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/opt/group/bwrap',
      stat: () => ({ uid: 0, mode: 0o775 }),
      exists: () => false,
    });
    expect(r.trustLevel).toBe('path-resolved');
    expect(r.trustWarnings.some((w) => w.includes('group-writable'))).toBe(true);
  });

  test('PATH-resolved with stat failure → trustWarning includes stat failure', () => {
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/some/path/bwrap',
      stat: () => null, // simulate stat throwing internally
      exists: () => false,
    });
    expect(r.path).toBe('/some/path/bwrap');
    expect(r.trustLevel).toBe('path-resolved');
    expect(r.trustWarnings.some((w) => w.includes('stat() failed'))).toBe(true);
  });

  test('which returns non-absolute path → treated as absent', () => {
    // Defensive: a non-absolute path from a hostile `which` shim
    // (which itself could be PATH-shimmed!) can't be trusted as
    // a resolved binary location.
    const r = resolveSandboxBinary('bwrap', {
      which: () => 'relative/path/bwrap',
      stat: cleanStat,
      exists: () => false,
    });
    expect(r.path).toBeNull();
    expect(r.trustLevel).toBe('absent');
  });

  test('which returns null → absent', () => {
    const r = resolveSandboxBinary('bwrap', {
      which: () => null,
      stat: cleanStat,
      exists: () => false,
    });
    expect(r.path).toBeNull();
    expect(r.trustLevel).toBe('absent');
  });
});

// Review fix: a canonical /usr/bin/<tool> that exists but is NOT
// executable for the current user (mode stripped, ACL deny, owner
// mismatch) used to be returned as `canonical` because the branch
// only probed existence. Every wrapped spawn then failed with
// EACCES even when `which()` could resolve a working binary
// elsewhere on PATH. The fix gates the canonical branch behind an
// executability probe (defaults to `accessSync(p, X_OK)`); when
// that fails, the resolver falls through to the PATH lookup.
describe('resolveSandboxBinary — canonical fall-through when not executable (review fix)', () => {
  test('canonical exists but not executable + PATH resolves → falls through to path-resolved', () => {
    // Operator's /usr/bin/bwrap has mode 0o644 (or ACL deny);
    // /home/op/.nix-profile/bin/bwrap is a clean working install.
    // Resolver should pick the working one with the appropriate
    // path-resolved warning.
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/home/op/.nix-profile/bin/bwrap',
      stat: cleanStat,
      exists: (p) => p === '/usr/bin/bwrap', // canonical exists
      isExecutable: () => false, // but not usable
    });
    expect(r.path).toBe('/home/op/.nix-profile/bin/bwrap');
    expect(r.trustLevel).toBe('path-resolved');
    expect(r.trustWarnings.some((w) => w.includes('using non-canonical'))).toBe(true);
  });

  test('canonical exists but not executable + no PATH fallback → absent', () => {
    // Worst case: canonical broken, no working bwrap elsewhere.
    // Operator gets an honest "absent" answer instead of a fake
    // "canonical" that fails at every spawn.
    const r = resolveSandboxBinary('bwrap', {
      which: () => null,
      stat: cleanStat,
      exists: (p) => p === '/usr/bin/bwrap',
      isExecutable: () => false,
    });
    expect(r.path).toBeNull();
    expect(r.trustLevel).toBe('absent');
  });

  test('canonical exists AND executable → canonical (sanity, fix preserves existing behavior)', () => {
    const r = resolveSandboxBinary('bwrap', {
      which: () => '/usr/bin/bwrap',
      stat: cleanStat,
      exists: () => true,
      isExecutable: () => true,
    });
    expect(r.path).toBe('/usr/bin/bwrap');
    expect(r.trustLevel).toBe('canonical');
  });

  test('detectSandboxAvailability surfaces fall-through trust marker', () => {
    // The same fall-through visible through the higher-level
    // detector — operator-visible `path-resolved` instead of
    // misleading `canonical`.
    const r = detectSandboxAvailability({
      platform: 'linux',
      which: () => '/usr/local/bin/bwrap',
      stat: cleanStat,
      exists: (p) => p === '/usr/bin/bwrap',
      isExecutable: () => false,
    });
    expect(r.available).toBe(true);
    expect(r.path).toBe('/usr/local/bin/bwrap');
    expect(r.trustLevel).toBe('path-resolved');
    expect(r.trustWarnings.length).toBeGreaterThan(0);
  });
});

// Slice 157 (review — phase 2 of macOS /tmp isolation). The helper
// pre-creates a per-CLI-run tmpdir on darwin so production callers
// can scope the SBPL allow-rule (phase 1) WITHOUT each callsite
// re-implementing mkdir + cleanup. Tests pin the platform via the
// seam and inject mkdir/rm spies to assert call shape without
// touching the host's /tmp.
describe('acquireSandboxTmpdir — slice 157 per-CLI-run scope', () => {
  test('non-darwin: returns no-op shape (linux already isolated via --tmpfs /tmp)', () => {
    let mkdirCalls = 0;
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-LINUX',
      platform: 'linux',
      mkdir: () => {
        mkdirCalls += 1;
      },
    });
    expect(result.tmpdir).toBeUndefined();
    expect(mkdirCalls).toBe(0);
    // cleanup is a no-op but must be callable.
    result.cleanup();
    result.cleanup();
  });

  test('non-darwin (win32): also no-op shape', () => {
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-WIN',
      platform: 'win32',
    });
    expect(result.tmpdir).toBeUndefined();
  });

  test('darwin happy path: mkdir(0o700, recursive) called with /tmp/forja-sb-<sessionId>', () => {
    const calls: { path: string; opts: { recursive: true; mode: number } }[] = [];
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-DARWIN',
      platform: 'darwin',
      mkdir: (path, opts) => {
        calls.push({ path, opts });
      },
      rm: () => {},
    });
    expect(result.tmpdir).toBe('/tmp/forja-sb-sess-DARWIN');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/tmp/forja-sb-sess-DARWIN');
    expect(calls[0]?.opts.recursive).toBe(true);
    expect(calls[0]?.opts.mode).toBe(0o700);
  });

  test('darwin mkdir failure: warn invoked, tmpdir falls back to undefined', () => {
    const warnings: string[] = [];
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-FAIL',
      platform: 'darwin',
      mkdir: () => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
      warn: (m) => {
        warnings.push(m);
      },
    });
    expect(result.tmpdir).toBeUndefined();
    expect(warnings).toHaveLength(1);
    // Warning message names the path, the error code, and the
    // graceful-fallback intent so the operator sees the full
    // diagnostic.
    expect(warnings[0]).toContain('/tmp/forja-sb-sess-FAIL');
    expect(warnings[0]).toContain('EACCES');
    expect(warnings[0]).toContain('falling back');
    // cleanup is still callable.
    result.cleanup();
  });

  test('darwin mkdir failure without warn callback: silent fallback (no crash)', () => {
    // Defensive: callers may not wire a warn channel (tests, headless
    // SDK invocations). Helper must not crash when warn is undefined.
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-NOWARN',
      platform: 'darwin',
      mkdir: () => {
        throw new Error('nope');
      },
    });
    expect(result.tmpdir).toBeUndefined();
  });

  test('darwin cleanup: rm invoked with recursive + force', () => {
    const rmCalls: { path: string; opts: { recursive: true; force: true } }[] = [];
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-RM',
      platform: 'darwin',
      mkdir: () => {},
      rm: (path, opts) => {
        rmCalls.push({ path, opts });
      },
    });
    result.cleanup();
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0]?.path).toBe('/tmp/forja-sb-sess-RM');
    expect(rmCalls[0]?.opts.recursive).toBe(true);
    expect(rmCalls[0]?.opts.force).toBe(true);
  });

  test('darwin cleanup is idempotent — second call is no-op', () => {
    let rmCalls = 0;
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-IDEMP',
      platform: 'darwin',
      mkdir: () => {},
      rm: () => {
        rmCalls += 1;
      },
    });
    result.cleanup();
    result.cleanup();
    result.cleanup();
    expect(rmCalls).toBe(1);
  });

  test('darwin cleanup swallows rm errors (best-effort)', () => {
    // The directory may already be gone — concurrent cleanup, or the
    // operator nuked it. rm throwing must not crash the cleanup path.
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-RMFAIL',
      platform: 'darwin',
      mkdir: () => {},
      rm: () => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    });
    // Should not throw.
    expect(() => result.cleanup()).not.toThrow();
  });

  test('darwin mkdir EEXIST is silently absorbed by recursive=true (idempotent across re-runs)', () => {
    // node:fs mkdir with recursive=true does NOT throw on EEXIST.
    // We model that by having the spy NOT throw — same as the real
    // call. The helper sees no error and returns the tmpdir.
    const result = acquireSandboxTmpdir({
      sessionId: 'sess-EXIST',
      platform: 'darwin',
      mkdir: () => {
        // Simulate "directory already there" — recursive=true silences
        // it at the libuv layer.
      },
      rm: () => {},
    });
    expect(result.tmpdir).toBe('/tmp/forja-sb-sess-EXIST');
  });
});
