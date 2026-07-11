import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// The launcher shim is a standalone CJS executable (no extension) shipped
// verbatim to npm. It guards its run path with `require.main === module`,
// so requiring it here loads only the exported pure helpers without
// spawning anything.
const require = createRequire(import.meta.url);
const shim = require(resolve(import.meta.dir, '../../npm/launcher/bin/forja')) as {
  targetId: (platform: string, arch: string) => string | null;
  platformPackage: (platform: string, arch: string) => string | null;
  resolveBinary: (
    platform: string,
    arch: string,
    resolve: (id: string) => string,
  ) => { pkg?: string; binPath?: string; error?: string };
  forwardedSignals: (platform: string) => string[];
};

describe('targetId', () => {
  test('maps supported platform/arch tuples to target ids', () => {
    expect(shim.targetId('linux', 'x64')).toBe('linux-x64');
    expect(shim.targetId('linux', 'arm64')).toBe('linux-arm64');
    expect(shim.targetId('darwin', 'x64')).toBe('darwin-x64');
    expect(shim.targetId('darwin', 'arm64')).toBe('darwin-arm64');
    // win32 (process.platform) maps to the `windows` target-id segment.
    expect(shim.targetId('win32', 'x64')).toBe('windows-x64');
  });

  test('returns null for unsupported platform or arch', () => {
    expect(shim.targetId('freebsd', 'x64')).toBeNull();
    expect(shim.targetId('linux', 'ia32')).toBeNull();
    expect(shim.targetId('sunos', 'sparc')).toBeNull();
  });
});

describe('platformPackage', () => {
  test('builds the scoped per-platform package name', () => {
    expect(shim.platformPackage('darwin', 'arm64')).toBe('@lex0c/forja-darwin-arm64');
    expect(shim.platformPackage('win32', 'x64')).toBe('@lex0c/forja-windows-x64');
  });

  test('null for unsupported', () => {
    expect(shim.platformPackage('aix', 'ppc64')).toBeNull();
  });
});

describe('resolveBinary', () => {
  test('resolves the binary path via the injected resolver', () => {
    let asked = '';
    const fakeResolve = (id: string): string => {
      asked = id;
      return `/opt/node_modules/${id}`;
    };
    const r = shim.resolveBinary('linux', 'x64', fakeResolve);
    expect(asked).toBe('@lex0c/forja-linux-x64/bin/forja');
    expect(r.pkg).toBe('@lex0c/forja-linux-x64');
    expect(r.binPath).toBe('/opt/node_modules/@lex0c/forja-linux-x64/bin/forja');
    expect(r.error).toBeUndefined();
  });

  test('appends .exe on windows', () => {
    let asked = '';
    const fakeResolve = (id: string): string => {
      asked = id;
      return `/c/${id}`;
    };
    shim.resolveBinary('win32', 'x64', fakeResolve);
    expect(asked).toBe('@lex0c/forja-windows-x64/bin/forja.exe');
  });

  test('reports a missing platform package (require.resolve throws)', () => {
    const throwingResolve = (): string => {
      throw new Error('Cannot find module');
    };
    const r = shim.resolveBinary('linux', 'x64', throwingResolve);
    expect(r.binPath).toBeUndefined();
    expect(r.pkg).toBe('@lex0c/forja-linux-x64');
    expect(r.error).toMatch(/not installed/);
  });

  test('reports an unsupported platform without a package', () => {
    const r = shim.resolveBinary('freebsd', 'x64', () => '/never');
    expect(r.pkg).toBeUndefined();
    expect(r.binPath).toBeUndefined();
    expect(r.error).toMatch(/unsupported platform/);
  });
});

describe('forwardedSignals', () => {
  test('excludes SIGQUIT/SIGHUP on Windows (libuv can reject registering them)', () => {
    const win = shim.forwardedSignals('win32');
    expect(win).not.toContain('SIGQUIT');
    expect(win).not.toContain('SIGHUP');
    // Ctrl-C still forwards.
    expect(win).toContain('SIGINT');
  });

  test('forwards the full POSIX set on unix platforms', () => {
    expect(shim.forwardedSignals('linux')).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
    expect(shim.forwardedSignals('darwin')).toContain('SIGQUIT');
  });
});
