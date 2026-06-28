import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_WRITABLE_CACHE_DIRS,
  normalizeCacheDir,
  sanitizeWritableCacheDirs,
} from '../../src/permissions/sandbox-cache-dirs.ts';

describe('DEFAULT_WRITABLE_CACHE_DIRS', () => {
  test('covers go/node/python/.NET/rust/ruby/jvm/dart/swift caches, all home-relative; binaries never masked', () => {
    expect(DEFAULT_WRITABLE_CACHE_DIRS).toEqual([
      '.cache',
      'go/pkg/mod',
      '.npm',
      '.nuget/packages',
      '.local/share/NuGet',
      '.cargo/registry',
      '.gem',
      '.bundle',
      '.gradle',
      '.m2',
      '.local/share/pnpm/store',
      '.bun/install/cache',
      '.pub-cache',
      '.swiftpm',
    ]);
    for (const dir of DEFAULT_WRITABLE_CACHE_DIRS) {
      expect(dir.startsWith('/')).toBe(false);
      expect(dir.includes('..')).toBe(false);
    }
    // Cache dirs are subdir-SCOPED when the blanket dir holds a binary AND a clean
    // static cache subdir exists (cargo/pnpm/bun → the binary stays execable). Where
    // the cache layout forces a blanket mount (`.gem`'s user-bin path is version-
    // dynamic; `.pub-cache` stages at the root), the dir is masked whole and any
    // user-installed tool bins under it are intentionally hidden inside the sandbox.
    expect(DEFAULT_WRITABLE_CACHE_DIRS).toContain('.cargo/registry');
    expect(DEFAULT_WRITABLE_CACHE_DIRS).not.toContain('.cargo'); // keeps ~/.cargo/bin
    expect(DEFAULT_WRITABLE_CACHE_DIRS).toContain('.local/share/pnpm/store');
    expect(DEFAULT_WRITABLE_CACHE_DIRS).not.toContain('.local/share/pnpm'); // keeps pnpm bin + global bins
    expect(DEFAULT_WRITABLE_CACHE_DIRS).toContain('.bun/install/cache');
    expect(DEFAULT_WRITABLE_CACHE_DIRS).not.toContain('.bun'); // keeps ~/.bun/bin
    // ~/.dotnet may be the SDK install (dotnet-install.sh + PATH=$HOME/.dotnet); masking it would hide
    // the dotnet binary. Relocated via the DOTNET_CLI_HOME redirect (sandbox-cache-env) instead.
    expect(DEFAULT_WRITABLE_CACHE_DIRS).not.toContain('.dotnet');
    // `~/.rustup` stays masked via HIDE_PATHS_DIRS — never a writable cache dir.
    expect(DEFAULT_WRITABLE_CACHE_DIRS).not.toContain('.rustup');
  });
});

describe('normalizeCacheDir', () => {
  test('keeps clean home-relative paths', () => {
    expect(normalizeCacheDir('.cache')).toBe('.cache');
    expect(normalizeCacheDir('go/pkg/mod')).toBe('go/pkg/mod');
  });
  test('normalizes `.` and redundant separators', () => {
    expect(normalizeCacheDir('./.cache')).toBe('.cache');
    expect(normalizeCacheDir('go//pkg/./mod')).toBe('go/pkg/mod');
    expect(normalizeCacheDir('foo/')).toBe('foo');
  });
  test('rejects (→ null) the dangerous / empty shapes', () => {
    expect(normalizeCacheDir('.')).toBeNull(); // would be $HOME itself
    expect(normalizeCacheDir('./')).toBeNull();
    expect(normalizeCacheDir('')).toBeNull();
    expect(normalizeCacheDir('   ')).toBeNull();
    expect(normalizeCacheDir('/etc')).toBeNull(); // absolute
    expect(normalizeCacheDir('../etc')).toBeNull(); // parent escape
    expect(normalizeCacheDir('a/../../b')).toBeNull();
    expect(normalizeCacheDir('bad\0name')).toBeNull(); // NUL
    expect(normalizeCacheDir(42)).toBeNull(); // non-string
    expect(normalizeCacheDir(null)).toBeNull();
  });
  test('allows `..` as a substring but not as a segment', () => {
    // `..foo` / `foo..bar` / `...` are valid dir names, not parent refs.
    expect(normalizeCacheDir('..foo')).toBe('..foo');
    expect(normalizeCacheDir('foo..bar')).toBe('foo..bar');
    expect(normalizeCacheDir('...')).toBe('...');
  });
});

describe('sanitizeWritableCacheDirs', () => {
  test('keeps clean entries; wasArray true', () => {
    const r = sanitizeWritableCacheDirs(['.cache', 'go/pkg/mod', '.cargo']);
    expect(r.dirs).toEqual(['.cache', 'go/pkg/mod', '.cargo']);
    expect(r.warnings).toEqual([]);
    expect(r.wasArray).toBe(true);
  });

  test('non-array → empty + warning + wasArray false', () => {
    const r = sanitizeWritableCacheDirs('.cache');
    expect(r.dirs).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.wasArray).toBe(false);
  });

  test('drops absolute / parent-escape / empty / NUL / non-string, keeps the rest', () => {
    const r = sanitizeWritableCacheDirs(['/etc', '../escape', '', 'bad\0n', 42, '.cache']);
    expect(r.dirs).toEqual(['.cache']);
    expect(r.warnings.length).toBe(5);
    expect(r.wasArray).toBe(true);
  });

  test('an array whose entries are ALL invalid → dirs empty but wasArray true', () => {
    const r = sanitizeWritableCacheDirs(['/usr', '../etc']);
    expect(r.dirs).toEqual([]);
    expect(r.wasArray).toBe(true);
    expect(r.warnings.length).toBe(2);
  });

  test('a literal empty array → dirs empty, wasArray true, no warnings', () => {
    const r = sanitizeWritableCacheDirs([]);
    expect(r.dirs).toEqual([]);
    expect(r.wasArray).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('de-dupes after normalization (first wins)', () => {
    const r = sanitizeWritableCacheDirs(['.cache', './.cache', '.cache']);
    expect(r.dirs).toEqual(['.cache']);
  });
});
