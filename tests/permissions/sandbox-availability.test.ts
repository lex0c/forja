import { describe, expect, test } from 'bun:test';
import {
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
    const r = detectSandboxAvailability({
      platform: 'darwin',
      which: () => '/usr/bin/sandbox-exec',
      stat: cleanStat,
      exists: (p) => p === '/usr/bin/sandbox-exec',
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
