import { describe, expect, test } from 'bun:test';
import { detectSandboxAvailability } from '../../src/permissions/sandbox-availability.ts';

describe('detectSandboxAvailability', () => {
  test('linux + bwrap present → available, tool=bwrap', () => {
    const r = detectSandboxAvailability({
      platform: 'linux',
      which: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
    });
    expect(r.available).toBe(true);
    expect(r.tool).toBe('bwrap');
    expect(r.reason).toBe('');
  });

  test('linux + bwrap missing → unavailable with operator hint', () => {
    const r = detectSandboxAvailability({
      platform: 'linux',
      which: () => null,
    });
    expect(r.available).toBe(false);
    expect(r.tool).toBeNull();
    expect(r.reason).toContain('bwrap binary not found');
    expect(r.reason).toContain('bubblewrap');
  });

  test('darwin + sandbox-exec present → available, tool=sandbox-exec', () => {
    const r = detectSandboxAvailability({
      platform: 'darwin',
      which: (name) => (name === 'sandbox-exec' ? '/usr/sbin/sandbox-exec' : null),
    });
    expect(r.available).toBe(true);
    expect(r.tool).toBe('sandbox-exec');
  });

  test('darwin + sandbox-exec missing → unavailable', () => {
    const r = detectSandboxAvailability({
      platform: 'darwin',
      which: () => null,
    });
    expect(r.available).toBe(false);
    expect(r.tool).toBeNull();
    expect(r.reason).toContain('sandbox-exec');
  });

  test('windows → unavailable (v2 unsupported)', () => {
    const r = detectSandboxAvailability({
      platform: 'win32',
      which: () => null,
    });
    expect(r.available).toBe(false);
    expect(r.tool).toBeNull();
    expect(r.reason).toContain('not supported');
    expect(r.reason).toContain('win32');
  });

  test('windows does not even probe `which`', () => {
    // Defense: we don't want a future code path to accidentally
    // call `which('bwrap')` on Windows, then misinterpret some WSL
    // shim. The probe is platform-gated.
    let probed = false;
    const r = detectSandboxAvailability({
      platform: 'win32',
      which: () => {
        probed = true;
        return '/probably/wsl/shim/bwrap';
      },
    });
    expect(r.available).toBe(false);
    expect(probed).toBe(false);
  });

  test('unknown platform → unavailable with platform-named reason', () => {
    const r = detectSandboxAvailability({
      platform: 'aix' as NodeJS.Platform,
      which: () => null,
    });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('aix');
  });
});
