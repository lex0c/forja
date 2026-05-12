// Slice 91 — §13.5 sandbox_skip marker. Tests cover:
//   - path resolution (XDG_CONFIG_HOME + HOME fallback);
//   - hasSandboxSkip exists/missing branches;
//   - createSandboxSkip first-create vs already-present idempotency;
//   - marker file content shape (version + timestamp).
//
// Slice 122 (R9 P0 #23/#24/#45) additions:
//   - hasSandboxSkip refuses symlinks at the marker path
//     (pre-slice existsSync followed symlinks → trivial bypass);
//   - createSandboxSkip refuses symlinks + non-regular files at
//     the marker path (pre-slice TOCTOU between existsSync and
//     writeFileSync allowed substitution);
//   - createSandboxSkip uses mode 0600 for the file and 0700
//     for the parent dir (pre-slice 0644 / 0755 leaked the
//     marker's presence to other users on multi-tenant hosts);
//   - createSandboxSkip propagates EEXIST / ELOOP from the
//     atomic open instead of silently overwriting.

import { describe, expect, test } from 'bun:test';
import type { Stats } from 'node:fs';
import { createSandboxSkip, hasSandboxSkip, sandboxSkipPath } from '../../src/cli/sandbox-skip.ts';

// Build a stat-like object with the booleans the production
// code calls. Tests pass these into the `lstat` fs seam.
const fakeStat = (kind: 'file' | 'symlink' | 'dir' | 'other'): Stats => {
  return {
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    isDirectory: () => kind === 'dir',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as Stats;
};

const enoent = (): never => {
  const e = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  e.code = 'ENOENT';
  throw e;
};

describe('sandboxSkipPath', () => {
  test('uses $XDG_CONFIG_HOME when set', () => {
    const path = sandboxSkipPath({ XDG_CONFIG_HOME: '/custom/cfg' });
    expect(path).toBe('/custom/cfg/forja/sandbox_skip');
  });

  test('falls back to $HOME/.config when XDG_CONFIG_HOME missing', () => {
    const path = sandboxSkipPath({ HOME: '/home/op', XDG_CONFIG_HOME: undefined });
    expect(path).toBe('/home/op/.config/forja/sandbox_skip');
  });

  test('empty XDG_CONFIG_HOME treated as missing', () => {
    const path = sandboxSkipPath({ XDG_CONFIG_HOME: '', HOME: '/home/op' });
    expect(path).toBe('/home/op/.config/forja/sandbox_skip');
  });
});

describe('hasSandboxSkip', () => {
  test('returns true when the file exists as a regular file', () => {
    const r = hasSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      fs: { lstat: () => fakeStat('file') },
    });
    expect(r).toBe(true);
  });

  test('returns false when lstat throws ENOENT', () => {
    const r = hasSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      fs: { lstat: enoent },
    });
    expect(r).toBe(false);
  });

  // Slice 122 (R9 P0 #23): pre-slice `existsSync` followed
  // symlinks, returning true for `ln -s /dev/null
  // ~/.config/forja/sandbox_skip`. An attacker who can plant
  // that symlink silences the first-boot prompt without the
  // operator ever running `--i-know-what-im-doing`. lstat
  // detects the symlink and we return false.
  test('returns false when the path is a symlink (no follow)', () => {
    const r = hasSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      fs: { lstat: () => fakeStat('symlink') },
    });
    expect(r).toBe(false);
  });

  test('returns false when the path is a directory', () => {
    // A dir at the marker path doesn't count as marker-present.
    const r = hasSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      fs: { lstat: () => fakeStat('dir') },
    });
    expect(r).toBe(false);
  });

  test('non-ENOENT lstat errors propagate (EACCES etc. should NOT silently report absent)', () => {
    expect(() =>
      hasSandboxSkip({
        env: { XDG_CONFIG_HOME: '/cfg' },
        fs: {
          lstat: () => {
            const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            e.code = 'EACCES';
            throw e;
          },
        },
      }),
    ).toThrow(/EACCES/);
  });
});

describe('createSandboxSkip — happy path', () => {
  test('writes the marker when absent + reports created:true with correct path/mode', () => {
    const captured: {
      mkdirPath: string | null;
      mkdirMode: number | null;
      filePath: string | null;
      content: string | null;
      fileMode: number | null;
    } = {
      mkdirPath: null,
      mkdirMode: null,
      filePath: null,
      content: null,
      fileMode: null,
    };
    const r = createSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      fs: {
        lstat: enoent,
        mkdir: (p, mode) => {
          captured.mkdirPath = p;
          captured.mkdirMode = mode;
        },
        createExclusive: (p, c, mode) => {
          captured.filePath = p;
          captured.content = c;
          captured.fileMode = mode;
        },
      },
      now: () => Date.UTC(2026, 4, 11, 12, 0, 0),
      engineVersion: '1.2.3',
    });
    expect(r.created).toBe(true);
    expect(r.path).toBe('/cfg/forja/sandbox_skip');
    expect(captured.mkdirPath).toBe('/cfg/forja');
    // Slice 122 (R9 P0 #24): parent dir must be 0700 — owner-only.
    expect(captured.mkdirMode).toBe(0o700);
    expect(captured.filePath).toBe('/cfg/forja/sandbox_skip');
    // Slice 122 (R9 P0 #24): marker file must be 0600 — owner read/write.
    expect(captured.fileMode).toBe(0o600);
    expect(captured.content).toContain('# forja sandbox_skip marker');
    expect(captured.content).toContain('2026-05-11T12:00:00.000Z');
    expect(captured.content).toContain('1.2.3');
    expect(captured.content).toContain('--i-know-what-im-doing');
  });

  test('content body warns that runtime enforcement is unchanged', () => {
    const captured: { content: string | null } = { content: null };
    createSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      fs: {
        lstat: enoent,
        mkdir: () => {},
        createExclusive: (_p, c) => {
          captured.content = c;
        },
      },
      now: () => 0,
      engineVersion: '0',
    });
    expect(captured.content).toContain('Does NOT bypass engine enforcement');
  });
});

describe('createSandboxSkip — idempotency', () => {
  test('returns created:false + skips mkdir/createExclusive when marker already present', () => {
    let mkdirCalled = false;
    let writeCalled = false;
    const r = createSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      fs: {
        lstat: () => fakeStat('file'),
        mkdir: () => {
          mkdirCalled = true;
        },
        createExclusive: () => {
          writeCalled = true;
        },
      },
    });
    expect(r.created).toBe(false);
    expect(r.path).toBe('/cfg/forja/sandbox_skip');
    expect(mkdirCalled).toBe(false);
    expect(writeCalled).toBe(false);
  });
});

// Slice 122 — R9 P0 #45: TOCTOU between existsSync + writeFileSync.
// Pre-slice an attacker could plant a symlink AFTER existsSync
// said "absent" and BEFORE writeFileSync ran; writeFileSync then
// followed the symlink to the attacker's chosen target. The
// atomic O_EXCL | O_NOFOLLOW open closes this window — but only
// if (a) the path-is-symlink case at lstat time refuses to
// proceed and (b) the createExclusive call uses the right flags.
describe('createSandboxSkip — symlink attack defense (slice 122)', () => {
  test('refuses when the marker path is occupied by a symlink', () => {
    let writeCalled = false;
    expect(() =>
      createSandboxSkip({
        env: { XDG_CONFIG_HOME: '/cfg' },
        fs: {
          lstat: () => fakeStat('symlink'),
          mkdir: () => {},
          createExclusive: () => {
            writeCalled = true;
          },
        },
      }),
    ).toThrow(/not a regular file/);
    // The attacker-controlled write target was NEVER reached.
    expect(writeCalled).toBe(false);
  });

  test('refuses when the marker path is occupied by a directory', () => {
    expect(() =>
      createSandboxSkip({
        env: { XDG_CONFIG_HOME: '/cfg' },
        fs: {
          lstat: () => fakeStat('dir'),
          mkdir: () => {},
          createExclusive: () => {},
        },
      }),
    ).toThrow(/not a regular file/);
  });

  test('createExclusive failing with ELOOP propagates (symlink planted post-lstat)', () => {
    // The TOCTOU window: lstat says ENOENT, then before
    // createExclusive runs an attacker plants a symlink. The
    // production createExclusive opens with O_NOFOLLOW so the
    // syscall fails with ELOOP; we propagate that error rather
    // than silently following the link.
    expect(() =>
      createSandboxSkip({
        env: { XDG_CONFIG_HOME: '/cfg' },
        fs: {
          lstat: enoent,
          mkdir: () => {},
          createExclusive: () => {
            const e = new Error('ELOOP: too many symbolic links') as NodeJS.ErrnoException;
            e.code = 'ELOOP';
            throw e;
          },
        },
      }),
    ).toThrow(/ELOOP/);
  });

  test('createExclusive failing with EEXIST propagates (race condition)', () => {
    // If a concurrent forja process (or attacker) created the
    // marker between our lstat and our open, EEXIST surfaces.
    // We propagate rather than silently overwrite via a fallback.
    expect(() =>
      createSandboxSkip({
        env: { XDG_CONFIG_HOME: '/cfg' },
        fs: {
          lstat: enoent,
          mkdir: () => {},
          createExclusive: () => {
            const e = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
            e.code = 'EEXIST';
            throw e;
          },
        },
      }),
    ).toThrow(/EEXIST/);
  });

  test('non-ENOENT lstat error during create-time check propagates', () => {
    expect(() =>
      createSandboxSkip({
        env: { XDG_CONFIG_HOME: '/cfg' },
        fs: {
          lstat: () => {
            const e = new Error('EACCES') as NodeJS.ErrnoException;
            e.code = 'EACCES';
            throw e;
          },
          mkdir: () => {},
          createExclusive: () => {},
        },
      }),
    ).toThrow(/EACCES/);
  });
});
