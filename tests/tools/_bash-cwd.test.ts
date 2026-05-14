// Slice 160 (review): unit tests for the shared bash cwd
// resolve+validate helper. Integration coverage (the bash and
// bash_background tools actually refusing model-supplied cwd
// outside session) lives in bash-broker.test.ts and
// bash-background.test.ts; this file pins the helper's semantics
// independently so a refactor can't silently shift them.

import { describe, expect, test } from 'bun:test';
import { resolveAndValidateBashCwd } from '../../src/tools/builtin/_bash-cwd.ts';

describe('resolveAndValidateBashCwd', () => {
  test('undefined argsCwd → returns sessionCwd as-is', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: undefined,
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe('/work/proj');
  });

  test('relative argsCwd resolves against sessionCwd (subdir → allowed)', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: 'sub/dir',
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe('/work/proj/sub/dir');
  });

  test('absolute argsCwd inside sessionCwd → allowed', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: '/work/proj/inner',
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe('/work/proj/inner');
  });

  test('argsCwd === sessionCwd → allowed (equal == within subtree)', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: '/work/proj',
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe('/work/proj');
  });

  test('absolute argsCwd OUTSIDE sessionCwd refuses with subtree message', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: '/etc',
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('outside session subtree');
      expect(r.error).toContain('/etc');
      expect(r.error).toContain('/work/proj');
    }
  });

  test('relative argsCwd with `..` escape outside sessionCwd refuses', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: '../other-project',
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('outside session subtree');
  });

  test('multi-segment `..` escape refuses', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: 'sub/../../escape',
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(false);
  });

  test('symlink inside sessionCwd → canonical path allowed', () => {
    // Symlink /work/proj/link → /work/proj/real/dir. Canonical
    // resolves into the same subtree → allowed.
    const realpath = (p: string): string => {
      if (p === '/work/proj/link') return '/work/proj/real/dir';
      if (p === '/work/proj') return '/work/proj';
      return p;
    };
    const r = resolveAndValidateBashCwd({
      argsCwd: '/work/proj/link',
      sessionCwd: '/work/proj',
      realpath,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe('/work/proj/real/dir');
  });

  test('symlink ESCAPING sessionCwd refuses (canonical points outside)', () => {
    // The original threat shape inverted at the tool-handler layer.
    // /work/proj/escape → /etc. Looks within subtree literally, but
    // canonicalization detects the actual target.
    const realpath = (p: string): string => {
      if (p === '/work/proj/escape') return '/etc';
      if (p === '/work/proj') return '/work/proj';
      return p;
    };
    const r = resolveAndValidateBashCwd({
      argsCwd: '/work/proj/escape',
      sessionCwd: '/work/proj',
      realpath,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('outside session subtree');
      // Error message names the CANONICAL path so the operator
      // sees the actual target, not the misleading symlink path.
      expect(r.error).toContain('/etc');
    }
  });

  test('realpath ENOENT on proposed path → falls back to resolved form', () => {
    // Model provides a non-existent path. realpath throws; helper
    // falls back to the resolved form. Subtree check still runs.
    const realpath = (p: string): string => {
      if (p === '/work/proj') return '/work/proj';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const r = resolveAndValidateBashCwd({
      argsCwd: 'will-be-created',
      sessionCwd: '/work/proj',
      realpath,
    });
    // Path doesn't exist but is INSIDE the session — allow. Spawn
    // will fail later with ENOENT, which is the right operator
    // signal.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe('/work/proj/will-be-created');
  });

  test('realpath ENOENT + escape → still refuses on resolved form', () => {
    // Belt and suspenders: even when realpath can't canonicalize,
    // the literal-resolved path is checked. `../outside` still
    // refuses without ever needing realpath to succeed.
    const realpath = (p: string): string => {
      if (p === '/work/proj') return '/work/proj';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const r = resolveAndValidateBashCwd({
      argsCwd: '../outside',
      sessionCwd: '/work/proj',
      realpath,
    });
    expect(r.ok).toBe(false);
  });

  test('realpath ENOENT on BOTH sides → falls back to literal compare', () => {
    // Defensive: even the session cwd's realpath might fail (very
    // rare — only if the dir was deleted underneath us mid-run).
    // Helper falls back to literal compare; subtree check still
    // returns sane results.
    const realpath = (_: string): string => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const inside = resolveAndValidateBashCwd({
      argsCwd: 'inner',
      sessionCwd: '/work/proj',
      realpath,
    });
    expect(inside.ok).toBe(true);
    const outside = resolveAndValidateBashCwd({
      argsCwd: '/etc',
      sessionCwd: '/work/proj',
      realpath,
    });
    expect(outside.ok).toBe(false);
  });

  test('NUL byte in argsCwd refuses with explicit message (pre-realpath)', () => {
    const r = resolveAndValidateBashCwd({
      argsCwd: 'sub\0evil',
      sessionCwd: '/work/proj',
      realpath: (p) => p,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('NUL byte');
    }
  });

  test('darwin firmlink-style canonical mismatch (separate roots) refuses', () => {
    // macOS: `/tmp` firmlinks to `/private/tmp`. If session resolves
    // to `/private/var/folders/x` but proposed resolves to `/var/x`
    // (or vice versa), node:path.relative returns an ABSOLUTE path.
    // The check refuses — different roots are outside each other's
    // subtree.
    const realpath = (p: string): string => {
      if (p === '/private/var/folders/x') return '/private/var/folders/x';
      if (p === '/var/x') return '/var/x';
      return p;
    };
    const r = resolveAndValidateBashCwd({
      argsCwd: '/var/x',
      sessionCwd: '/private/var/folders/x',
      realpath,
    });
    expect(r.ok).toBe(false);
  });
});
