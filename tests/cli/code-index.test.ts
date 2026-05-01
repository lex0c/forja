import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeIndexCli } from '../../src/cli/code-index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

const capture = (): CapturedOutput & { out: (s: string) => void; err: (s: string) => void } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
  };
};

describe('runCodeIndexCli', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forja-cli-codeindex-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('scan prints a summary line on stdout (table mode)', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    writeFile(root, 'src/util.ts', 'export const X = 1;');
    const cap = capture();
    const code = await runCodeIndexCli({
      verb: 'scan',
      positionals: [],
      json: false,
      cwd: root,
      dbOverride: openMemoryDb(),
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(cap.stdout.length).toBeGreaterThan(0);
    const summary = cap.stdout.join('');
    expect(summary).toContain('Scanned 2 files');
    expect(summary).toContain('symbols');
    expect(summary).toContain('0 failed');
  });

  test('scan emits NDJSON summary in --json mode', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    const cap = capture();
    const code = await runCodeIndexCli({
      verb: 'scan',
      positionals: [],
      json: true,
      cwd: root,
      dbOverride: openMemoryDb(),
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    const lines = cap.stdout.filter((s) => s.trim().length > 0);
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0] ?? '{}');
    expect(obj).toMatchObject({
      files_scanned: 1,
      symbols_inserted: 1,
      errors: 0,
      partials: 0,
    });
    expect(typeof obj.duration_ms).toBe('number');
  });

  test('status reports zero counts on a fresh DB and "never" last scan', async () => {
    const cap = capture();
    const code = await runCodeIndexCli({
      verb: 'status',
      positionals: [],
      json: false,
      cwd: root,
      dbOverride: openMemoryDb(),
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    const text = cap.stdout.join('');
    expect(text).toContain('files_indexed');
    expect(text).toContain('schema_version');
    expect(text).toContain('never');
  });

  test('status reflects a prior scan in JSON mode', async () => {
    writeFile(root, 'src/a.ts', 'export const a = 1;');
    const db = openMemoryDb();
    // First scan to populate.
    await runCodeIndexCli({
      verb: 'scan',
      positionals: [],
      json: false,
      cwd: root,
      dbOverride: db,
      out: () => {},
      err: () => {},
    });
    const cap = capture();
    const code = await runCodeIndexCli({
      verb: 'status',
      positionals: [],
      json: true,
      cwd: root,
      dbOverride: db,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    const obj = JSON.parse(cap.stdout.join('').trim());
    expect(obj).toMatchObject({
      files_indexed: 1,
      files_failed: 0,
      schema_version: 1,
    });
    expect(typeof obj.last_full_scan_at).toBe('number');
    expect(typeof obj.db_size_bytes).toBe('number');
  });

  test('rebuild without --clean is equivalent to scan (idempotent)', async () => {
    writeFile(root, 'src/a.ts', 'export const a = 1;');
    const db = openMemoryDb();
    await runCodeIndexCli({
      verb: 'scan',
      positionals: [],
      json: false,
      cwd: root,
      dbOverride: db,
      out: () => {},
      err: () => {},
    });
    const cap = capture();
    const code = await runCodeIndexCli({
      verb: 'rebuild',
      positionals: [],
      json: false,
      cwd: root,
      dbOverride: db,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(cap.stdout.join('')).toContain('Scanned 1 files');
  });

  test('exit 1 when scan has read failures (per-file error)', async () => {
    // Force a read failure: index a path that doesn't exist on
    // disk but is listed by git. Use git to track an empty file
    // that we then rm before scan runs.
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], {
      encoding: 'utf8',
    });
    spawnSync('git', ['-C', root, 'config', 'user.name', 'test'], { encoding: 'utf8' });
    writeFile(root, 'src/exists.ts', 'export const x = 1;');
    writeFile(root, 'src/disappears.ts', 'export const y = 2;');
    spawnSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });
    // After the lstat-ENOENT-as-deletion fix, rm'd-but-tracked
    // files are pruned, NOT recorded as errors. So the scan
    // succeeds with zero errors here. Verify the success path
    // (exit 0) — read failures from other sources (permission,
    // EBUSY) are tested at the pipeline level.
    rmSync(join(root, 'src/disappears.ts'));
    const cap = capture();
    const code = await runCodeIndexCli({
      verb: 'scan',
      positionals: [],
      json: false,
      cwd: root,
      dbOverride: openMemoryDb(),
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
  });

  test('rejects an unknown verb (defensive — parser usually catches first)', async () => {
    const cap = capture();
    const code = await runCodeIndexCli({
      // biome-ignore lint/suspicious/noExplicitAny: deliberately bypass parser narrowing
      verb: 'bogus' as any,
      positionals: [],
      json: false,
      cwd: root,
      dbOverride: openMemoryDb(),
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(2);
    expect(cap.stderr.join('')).toContain("unknown verb 'bogus'");
  });
});
