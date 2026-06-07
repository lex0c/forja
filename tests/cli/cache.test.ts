import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.ts';
import { runCacheClear } from '../../src/cli/cache.ts';

describe('runCacheClear', () => {
  let dir = '';
  const lines: string[] = [];
  const out = (l: string): void => {
    lines.push(l);
  };

  const seed = (): void => {
    dir = mkdtempSync(join(tmpdir(), 'forja-cache-clear-'));
    mkdirSync(join(dir, 'cache', 'npm'), { recursive: true });
    writeFileSync(join(dir, 'cache', 'npm', 'a.bin'), Buffer.alloc(2048));
    mkdirSync(join(dir, 'tmp', 'sessions', 's1'), { recursive: true });
    writeFileSync(join(dir, 'tmp', 'sessions', 's1', 'x'), 'hi');
    lines.length = 0;
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('dry-run reports size + file count and removes nothing', () => {
    seed();
    const code = runCacheClear({ force: false, json: false, out, cacheDir: dir });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'cache', 'npm', 'a.bin'))).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain(dir);
    expect(text).toContain('dry-run');
    expect(text).toContain('file(s)');
  });

  test('--force removes the cache/ subtree but PRESERVES tmp/ (live session binds)', () => {
    seed();
    const code = runCacheClear({ force: true, json: false, out, cacheDir: dir });
    expect(code).toBe(0);
    // cache/ gone...
    expect(existsSync(join(dir, 'cache'))).toBe(false);
    // ...but the live session /tmp bind source survives — THIS is the fix:
    // clearing the dependency cache must not delete an active session's
    // bwrap /tmp source out from under it.
    expect(existsSync(join(dir, 'tmp', 'sessions', 's1', 'x'))).toBe(true);
    expect(lines.join('\n')).toContain('removed');
  });

  test('json dry-run reports the cache/ subtree only (tmp/ excluded), removed:false', () => {
    seed();
    runCacheClear({ force: false, json: true, out, cacheDir: dir });
    const obj = JSON.parse(lines[0] as string);
    // the cache/ subtree, not the root — tmp/ is neither counted nor cleared
    expect(obj.dir).toBe(join(dir, 'cache'));
    expect(obj.bytes).toBeGreaterThanOrEqual(2048); // cache/npm/a.bin
    expect(obj.files).toBe(1); // only a.bin; the tmp/ file is excluded
    expect(obj.removed).toBe(false);
  });

  test('json --force reports removed:true', () => {
    seed();
    runCacheClear({ force: true, json: true, out, cacheDir: dir });
    expect(JSON.parse(lines[0] as string).removed).toBe(true);
  });

  test('missing cache dir is a no-op (0 bytes), not an error', () => {
    const code = runCacheClear({
      force: true,
      json: false,
      out,
      cacheDir: '/nonexistent/forja-cache-x',
    });
    expect(code).toBe(0);
  });
});

describe('parseArgs — cache clear', () => {
  test('cache clear parses --force + --json', () => {
    const r = parseArgs(['cache', 'clear', '--force', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.cache).toEqual({ verb: 'clear', force: true, json: true });
  });

  test('bare cache clear → dry-run defaults', () => {
    const r = parseArgs(['cache', 'clear']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.cache).toEqual({ verb: 'clear', force: false, json: false });
  });

  test('cache without verb → usage error', () => {
    expect(parseArgs(['cache']).ok).toBe(false);
  });

  test('cache <unknown verb> → error', () => {
    expect(parseArgs(['cache', 'bogus']).ok).toBe(false);
  });

  test('cache clear --bogus → flag error', () => {
    expect(parseArgs(['cache', 'clear', '--bogus']).ok).toBe(false);
  });
});
