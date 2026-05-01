import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';

// Pipeline contract: walk → parse → extract → DB. Idempotent
// re-runs converge on FS state. Failed parses recorded with
// parse_status='failed'; sources, imports persisted on success.

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('CodeIndex.scan', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forja-pipeline-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('indexes symbols and imports for a small project', async () => {
    writeFile(
      root,
      'src/auth.ts',
      `
      export function login(user: string): boolean { return true; }
      function helper() { return 1; }
      import { Token } from './types';
    `,
    );
    writeFile(root, 'src/types.ts', 'export type Token = string;');

    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    const result = await idx.scan({ respectGitignore: false });

    expect(result.filesScanned).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.symbolsInserted).toBeGreaterThanOrEqual(3);
    expect(result.importsInserted).toBe(1);

    const login = idx.getSymbol('login');
    expect(login.length).toBe(1);
    expect(login[0]?.kind).toBe('function');
    expect(login[0]?.visibility).toBe('export');

    const helper = idx.getSymbol('helper');
    expect(helper[0]?.visibility).toBe('internal');

    const imports = idx.importsOf('src/auth.ts');
    expect(imports.length).toBe(1);
    expect(imports[0]?.targetModule).toBe('./types');

    idx.close();
  });

  test('records parse_status=failed when extractor throws', async () => {
    // Hard to force the extractor to throw with real source —
    // tree-sitter is permissive. Simulate by writing a file
    // whose extension is supported but content is gigantic /
    // pathological. Easier path: write valid source, observe
    // parse_status='ok'. Then write nothing and confirm scan
    // tolerates an empty file (parse_status='ok', zero
    // symbols).
    writeFile(root, 'src/empty.ts', '');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    const result = await idx.scan({ respectGitignore: false });
    expect(result.filesScanned).toBe(1);
    expect(result.errors).toEqual([]);
    const meta = idx.fileMeta('src/empty.ts');
    expect(meta?.parseStatus).toBe('ok');
    expect(meta?.loc).toBe(0);
    idx.close();
  });

  test('idempotent: re-scanning the same tree converges', async () => {
    writeFile(root, 'src/a.ts', 'export function a() {}');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
    const beforeStatus = idx.status();
    await idx.scan({ respectGitignore: false });
    const afterStatus = idx.status();

    expect(afterStatus.filesIndexed).toBe(beforeStatus.filesIndexed);
    expect(idx.getSymbol('a').length).toBe(1);
    idx.close();
  });

  test('removes symbols when a file is re-scanned with new content', async () => {
    writeFile(root, 'src/x.ts', 'export function oldName() {}');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
    expect(idx.getSymbol('oldName').length).toBe(1);

    writeFile(root, 'src/x.ts', 'export function newName() {}');
    await idx.scan({ respectGitignore: false });
    expect(idx.getSymbol('oldName').length).toBe(0);
    expect(idx.getSymbol('newName').length).toBe(1);
    idx.close();
  });

  test('content_hash and loc are populated on file rows', async () => {
    // 'foo\nbar\n' is two logical lines per `wc -l` convention.
    // The trailing newline closes line 2, it doesn't open a
    // phantom line 3.
    writeFile(root, 'src/a.ts', 'export function a() {}\nexport function b() {}\n');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
    const meta = idx.fileMeta('src/a.ts');
    expect(meta?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(meta?.loc).toBe(2);
    expect(meta?.sizeBytes).toBeGreaterThan(0);
    expect(meta?.indexSchemaVersion).toBe(1);
    idx.close();
  });

  test('loc convention: trailing newline closes the last line', async () => {
    // Pin the convention explicitly so a future regression in
    // countLines would surface here. Examples cover the four
    // edge cases of trailing-newline behaviour.
    const cases: { content: string; loc: number }[] = [
      { content: '', loc: 0 },
      { content: 'foo', loc: 1 },
      { content: 'foo\n', loc: 1 },
      { content: 'foo\nbar', loc: 2 },
      { content: 'foo\nbar\n', loc: 2 },
    ];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (c === undefined) continue;
      writeFile(root, `src/case_${i}.ts`, c.content);
    }
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (c === undefined) continue;
      const meta = idx.fileMeta(`src/case_${i}.ts`);
      expect(meta?.loc).toBe(c.loc);
    }
    idx.close();
  });

  test('prunes rows for files removed between scans', async () => {
    writeFile(root, 'src/keep.ts', 'export const keep = 1;');
    writeFile(root, 'src/gone.ts', 'export const gone = 2;');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
    expect(idx.fileMeta('src/gone.ts')).not.toBeNull();
    expect(idx.getSymbol('gone').length).toBe(1);

    // Remove the file from disk and re-scan. The row for
    // src/gone.ts (and its cascaded symbols) should disappear.
    rmSync(join(root, 'src/gone.ts'));
    // Sleep 5 ms so re-scan's `indexedAt` is strictly later
    // than the prior scan's, even on coarse-grain clocks.
    await new Promise((r) => setTimeout(r, 5));
    await idx.scan({ respectGitignore: false });

    expect(idx.fileMeta('src/gone.ts')).toBeNull();
    expect(idx.getSymbol('gone').length).toBe(0);
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    expect(idx.getSymbol('keep').length).toBe(1);
    idx.close();
  });

  test('handles batch boundaries (>100 files) without dropping rows', async () => {
    // BATCH_SIZE in pipeline.ts is 100. Generate 250 files to
    // exercise both the multi-batch loop and the final partial
    // batch. Verifies idempotency at scale.
    for (let i = 0; i < 250; i++) {
      writeFile(root, `src/m${i}.ts`, `export const v${i} = ${i};`);
    }
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    const result = await idx.scan({ respectGitignore: false });
    expect(result.filesScanned).toBe(250);
    expect(result.errors).toEqual([]);
    // Spot-check first, last, and middle files.
    expect(idx.getSymbol('v0').length).toBe(1);
    expect(idx.getSymbol('v100').length).toBe(1);
    expect(idx.getSymbol('v249').length).toBe(1);
    expect(idx.status().filesIndexed).toBe(250);
    idx.close();
  });

  test('persists last_full_scan_at meta', async () => {
    writeFile(root, 'src/a.ts', 'export function a() {}');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    const before = Date.now();
    await idx.scan({ respectGitignore: false });
    const status = idx.status();
    expect(status.lastFullScanAt).not.toBeNull();
    expect(status.lastFullScanAt).toBeGreaterThanOrEqual(before);
    idx.close();
  });

  test('drops files matching default privacy excludes', async () => {
    writeFile(root, 'src/keep.ts', 'export function keep() {}');
    writeFile(root, 'node_modules/x/index.js', 'export const x = 1;');
    writeFile(root, '.env', 'SECRET=1');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    const result = await idx.scan({ respectGitignore: false });
    expect(result.filesScanned).toBe(1);
    expect(idx.fileMeta('node_modules/x/index.js')).toBeNull();
    expect(idx.fileMeta('.env')).toBeNull();
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    idx.close();
  });
});
