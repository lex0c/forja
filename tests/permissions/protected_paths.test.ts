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
    expect(t.systemDeny).toEqual(['/proc', '/sys', '/boot']);
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
