import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArgs,
  parseArgs,
  resolveIds,
  runBuild,
  sourcemapName,
  targetSourcemapName,
} from '../../scripts/build-targets.ts';
import { TARGETS } from '../../scripts/targets.ts';
import { targetById } from './_helpers.ts';

describe('parseArgs', () => {
  test('default produces all targets, minify on, sourcemap on', () => {
    const p = parseArgs([]);
    expect(p.ids).toEqual([]);
    expect(p.distDir).toBe('dist');
    expect(p.entry).toBe('src/cli/index.ts');
    expect(p.minify).toBe(true);
    expect(p.sourcemap).toBe(true);
  });

  test('--target accumulates ids', () => {
    const p = parseArgs(['--target=linux-x64', '--target=darwin-arm64']);
    expect(p.ids).toEqual(['linux-x64', 'darwin-arm64']);
  });

  test('--no-minify and --no-sourcemap toggle off', () => {
    const p = parseArgs(['--no-minify', '--no-sourcemap']);
    expect(p.minify).toBe(false);
    expect(p.sourcemap).toBe(false);
  });

  test('--dist and --entry override defaults', () => {
    const p = parseArgs(['--dist=out', '--entry=src/foo.ts']);
    expect(p.distDir).toBe('out');
    expect(p.entry).toBe('src/foo.ts');
  });
});

describe('buildArgs', () => {
  test('emits --compile, --target, --outfile, --minify, --sourcemap=external', () => {
    const t = targetById('linux-x64');
    const args = buildArgs(t, {
      distDir: 'dist',
      entry: 'src/cli/index.ts',
      minify: true,
      sourcemap: true,
    });
    expect(args).toContain('--compile');
    expect(args).toContain('--target=bun-linux-x64-modern');
    expect(args).toContain('--minify');
    expect(args).toContain('--sourcemap=external');
    expect(args).toContain('--outfile=dist/agent-linux-x64');
  });

  test('omits --minify and --sourcemap when disabled', () => {
    const t = targetById('windows-x64');
    const args = buildArgs(t, {
      distDir: 'out',
      entry: 'src/cli/index.ts',
      minify: false,
      sourcemap: false,
    });
    expect(args).not.toContain('--minify');
    expect(args.find((a) => a.startsWith('--sourcemap'))).toBeUndefined();
    expect(args).toContain('--outfile=out/agent-windows-x64.exe');
  });
});

describe('runBuild', () => {
  test('invokes spawn once per target with correct args, returns statuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      const calls: { cmd: string; args: readonly string[] }[] = [];
      const fakeSpawn = (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args });
        return { status: 0 };
      };
      const results = runBuild({
        distDir: dir,
        entry: 'src/cli/index.ts',
        minify: true,
        sourcemap: true,
        ids: ['linux-x64', 'darwin-arm64'],
        spawn: fakeSpawn,
      });
      expect(results.length).toBe(2);
      expect(calls.length).toBe(2);
      expect(calls[0]?.cmd).toBe('bun');
      expect(calls[0]?.args).toContain('--target=bun-linux-x64-modern');
      expect(calls[1]?.args).toContain('--target=bun-darwin-arm64');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('builds every target when ids is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      const calls: number[] = [];
      const fakeSpawn = () => {
        calls.push(1);
        return { status: 0 };
      };
      runBuild({
        distDir: dir,
        entry: 'src/cli/index.ts',
        minify: true,
        sourcemap: true,
        ids: [],
        spawn: fakeSpawn,
      });
      expect(calls.length).toBe(TARGETS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes pre-existing asset and per-target sourcemap before spawning the build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      const stale = join(dir, 'agent-linux-x64');
      const staleMap = join(dir, 'agent-linux-x64.map');
      writeFileSync(stale, 'old');
      writeFileSync(staleMap, 'old-map');
      let assetExistedAtSpawn = true;
      let mapExistedAtSpawn = true;
      const fakeSpawn = () => {
        assetExistedAtSpawn = existsSync(stale);
        mapExistedAtSpawn = existsSync(staleMap);
        writeFileSync(stale, 'new');
        return { status: 0 };
      };
      runBuild({
        distDir: dir,
        entry: 'src/cli/index.ts',
        minify: true,
        sourcemap: true,
        ids: ['linux-x64'],
        spawn: fakeSpawn,
      });
      expect(assetExistedAtSpawn).toBe(false);
      expect(mapExistedAtSpawn).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('renames the entry-derived sourcemap to a per-target name after each build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      const fakeSpawn = () => {
        // Emulate Bun's --compile --sourcemap=external: writes BOTH
        // the binary and an `index.js.map` (entry-derived name) into
        // the outdir. Without the rename, the next target's build
        // would clobber this file.
        writeFileSync(join(dir, 'agent-linux-x64'), 'binary-A');
        writeFileSync(join(dir, 'index.js.map'), 'map-A');
        return { status: 0 };
      };
      runBuild({
        distDir: dir,
        entry: 'src/cli/index.ts',
        minify: true,
        sourcemap: true,
        ids: ['linux-x64'],
        spawn: fakeSpawn,
      });
      // Original entry-derived name gone; per-target name present.
      expect(existsSync(join(dir, 'index.js.map'))).toBe(false);
      const renamed = join(dir, 'agent-linux-x64.map');
      expect(existsSync(renamed)).toBe(true);
      expect(statSync(renamed).size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips the sourcemap rename when --no-sourcemap is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      const fakeSpawn = () => {
        writeFileSync(join(dir, 'agent-linux-x64'), 'binary');
        // No sourcemap emitted under --no-sourcemap.
        return { status: 0 };
      };
      runBuild({
        distDir: dir,
        entry: 'src/cli/index.ts',
        minify: true,
        sourcemap: false,
        ids: ['linux-x64'],
        spawn: fakeSpawn,
      });
      expect(existsSync(join(dir, 'agent-linux-x64.map'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not rename when the build failed (status !== 0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      const fakeSpawn = () => {
        // Simulate a build that wrote the sourcemap before erroring.
        writeFileSync(join(dir, 'index.js.map'), 'partial');
        return { status: 2 };
      };
      runBuild({
        distDir: dir,
        entry: 'src/cli/index.ts',
        minify: true,
        sourcemap: true,
        ids: ['linux-x64'],
        spawn: fakeSpawn,
      });
      // The orphan map stays where Bun left it; no per-target rename
      // happens for a failed build (the failure path is what the
      // operator inspects).
      expect(existsSync(join(dir, 'index.js.map'))).toBe(true);
      expect(existsSync(join(dir, 'agent-linux-x64.map'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveIds', () => {
  test('resolves every TARGETS entry when ids is empty', () => {
    expect(resolveIds([]).length).toBe(TARGETS.length);
  });

  test('preserves the supplied order', () => {
    const out = resolveIds(['darwin-arm64', 'linux-x64']);
    expect(out.map((t) => t.id)).toEqual(['darwin-arm64', 'linux-x64']);
  });

  test('throws on unknown id (no silent drop)', () => {
    // The critical guarantee: a typoed --target=lnux-x64 would
    // otherwise produce a "built 0 target(s)" exit-0 success and
    // mask the operator's mistake in CI.
    expect(() => resolveIds(['lnux-x64'])).toThrow(/unknown target.*lnux-x64/);
    expect(() => resolveIds(['linux-x64', 'plan9-mips'])).toThrow(/plan9-mips/);
  });
});

describe('runBuild error propagation', () => {
  test('throws (not silent-drop) when ids contains an unknown target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      let spawned = false;
      const fakeSpawn = () => {
        spawned = true;
        return { status: 0 };
      };
      expect(() =>
        runBuild({
          distDir: dir,
          entry: 'src/cli/index.ts',
          minify: true,
          sourcemap: true,
          ids: ['linux-x64', 'mystery-arch'],
          spawn: fakeSpawn,
        }),
      ).toThrow(/mystery-arch/);
      // Critical: no build was started — the validation must happen
      // before any target's spawn, not after a partial run.
      expect(spawned).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sourcemap name helpers', () => {
  test('sourcemapName follows Bun --compile convention', () => {
    expect(sourcemapName('src/cli/index.ts')).toBe('index.js.map');
    expect(sourcemapName('src/foo.ts')).toBe('foo.js.map');
  });

  test('targetSourcemapName uses the asset name + .map', () => {
    expect(targetSourcemapName(targetById('linux-x64'))).toBe('agent-linux-x64.map');
    expect(targetSourcemapName(targetById('windows-x64'))).toBe('agent-windows-x64.exe.map');
  });
});
