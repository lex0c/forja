import { describe, expect, test } from 'bun:test';
import {
  buildSandboxExecArgv,
  buildSbplProfile,
} from '../../src/permissions/sandbox-runner-macos.ts';

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

  test('file-read* always granted (read-only baseline)', () => {
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(allow file-read*)');
    }
  });

  test('/tmp + /private/tmp + /private/var/folders writable in every profile', () => {
    // Matches Linux's --tmpfs /tmp. macOS's TMPDIR routes through
    // /private/var/folders; both forms allowed so mktemp /
    // NSTemporaryDirectory work.
    for (const p of ['ro', 'cwd-rw', 'cwd-rw-net', 'home-rw'] as const) {
      const profile = buildSbplProfile(p, '/work/proj', '/home/op');
      expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
      expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
      expect(profile).toContain('(allow file-write* (subpath "/private/var/folders"))');
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
    });
    expect(argv).toEqual(['bash', '-c', 'echo hi']);
  });

  test('ro profile wraps with sandbox-exec -p <profile>', () => {
    const argv = buildSandboxExecArgv({
      profile: 'ro',
      cwd: '/work/proj',
      home: '/home/op',
      innerArgv: ['ls', '-la'],
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
      }),
    ).toThrow(/must not be empty/);
  });
});
