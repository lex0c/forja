import { describe, expect, test } from 'bun:test';
import { buildBwrapArgv } from '../../src/permissions/sandbox-runner.ts';

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
