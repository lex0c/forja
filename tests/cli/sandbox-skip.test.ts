// Slice 91 — §13.5 sandbox_skip marker. Tests cover:
//   - path resolution (XDG_CONFIG_HOME + HOME fallback);
//   - hasSandboxSkip exists/missing branches;
//   - createSandboxSkip first-create vs already-present idempotency;
//   - marker file content shape (version + timestamp).

import { describe, expect, test } from 'bun:test';
import { createSandboxSkip, hasSandboxSkip, sandboxSkipPath } from '../../src/cli/sandbox-skip.ts';

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
  test('returns true when the file exists', () => {
    const r = hasSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      exists: (p) => p === '/cfg/forja/sandbox_skip',
    });
    expect(r).toBe(true);
  });

  test('returns false when the file is absent', () => {
    const r = hasSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      exists: () => false,
    });
    expect(r).toBe(false);
  });
});

describe('createSandboxSkip — happy path', () => {
  test('writes the marker when absent + reports created:true', () => {
    const captured: { path: string | null; content: string | null; dir: string | null } = {
      path: null,
      content: null,
      dir: null,
    };
    const r = createSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      exists: () => false,
      ensureDir: (d) => {
        captured.dir = d;
      },
      write: (p, c) => {
        captured.path = p;
        captured.content = c;
      },
      now: () => Date.UTC(2026, 4, 11, 12, 0, 0),
      engineVersion: '1.2.3',
    });
    expect(r.created).toBe(true);
    expect(r.path).toBe('/cfg/forja/sandbox_skip');
    expect(captured.dir).toBe('/cfg/forja');
    expect(captured.path).toBe('/cfg/forja/sandbox_skip');
    expect(captured.content).toContain('# forja sandbox_skip marker');
    expect(captured.content).toContain('2026-05-11T12:00:00.000Z');
    expect(captured.content).toContain('1.2.3');
    expect(captured.content).toContain('--i-know-what-im-doing');
  });

  test('content body warns that runtime enforcement is unchanged', () => {
    const captured: { content: string | null } = { content: null };
    createSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      exists: () => false,
      ensureDir: () => {},
      write: (_p, c) => {
        captured.content = c;
      },
      now: () => 0,
      engineVersion: '0',
    });
    expect(captured.content).toContain('Does NOT bypass engine enforcement');
  });
});

describe('createSandboxSkip — idempotency', () => {
  test('returns created:false + skips ensureDir/write when marker already present', () => {
    let ensureDirCalled = false;
    let writeCalled = false;
    const r = createSandboxSkip({
      env: { XDG_CONFIG_HOME: '/cfg' },
      exists: () => true, // marker present
      ensureDir: () => {
        ensureDirCalled = true;
      },
      write: () => {
        writeCalled = true;
      },
    });
    expect(r.created).toBe(false);
    expect(r.path).toBe('/cfg/forja/sandbox_skip');
    expect(ensureDirCalled).toBe(false);
    expect(writeCalled).toBe(false);
  });
});
