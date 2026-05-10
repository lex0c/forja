import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, parseArgs, runBuild } from '../../scripts/build-targets.ts';
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

  test('removes pre-existing asset before spawning the build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forja-build-'));
    try {
      const stale = join(dir, 'agent-linux-x64');
      writeFileSync(stale, 'old');
      let observedExisted = false;
      const fakeSpawn = () => {
        // Bun would normally produce the file; we just observe that
        // the orchestrator wiped the stale copy before the spawn ran.
        try {
          // statSync would throw for a missing file
          require('node:fs').statSync(stale);
          observedExisted = true;
        } catch {
          observedExisted = false;
        }
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
      expect(observedExisted).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
