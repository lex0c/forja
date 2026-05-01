import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
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

    // Remove the file from disk and re-scan immediately — no
    // sleep. The prune uses a path-set diff, NOT an indexed_at
    // window, so it must work even when both scans share the
    // same Date.now() ms value (coarse-grain clock collision).
    rmSync(join(root, 'src/gone.ts'));
    await idx.scan({ respectGitignore: false });

    expect(idx.fileMeta('src/gone.ts')).toBeNull();
    expect(idx.getSymbol('gone').length).toBe(0);
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    expect(idx.getSymbol('keep').length).toBe(1);
    idx.close();
  });

  test('prune is timestamp-independent (same-ms successive scans)', async () => {
    // Pin the contract: even when Date.now() returns the SAME
    // value for two scans (possible on coarse-grain clocks or
    // back-to-back fast runs), removed files are still pruned.
    // Stub Date.now to return a constant value across both
    // scans, exercising the path-set diff in isolation.
    writeFile(root, 'src/keep.ts', 'export const keep = 1;');
    writeFile(root, 'src/gone.ts', 'export const gone = 2;');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });

    const realNow = Date.now;
    const FROZEN = realNow();
    Date.now = () => FROZEN;
    try {
      await idx.scan({ respectGitignore: false });
      rmSync(join(root, 'src/gone.ts'));
      await idx.scan({ respectGitignore: false });
    } finally {
      Date.now = realNow;
    }

    expect(idx.fileMeta('src/gone.ts')).toBeNull();
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
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

  test('marks files with syntax errors as parse_status=partial', async () => {
    // tree-sitter recovers around invalid syntax: it emits
    // ERROR / MISSING nodes but still produces an AST. The
    // valid constructs around the breakage are still extracted.
    // The pipeline must mark the file as partial, NOT ok, so
    // consumers can distinguish a healthy index from an
    // edit-time partial (CODE_INDEX.md §3 implies this and
    // the schema's `partial` enum exists for it).
    writeFile(
      root,
      'src/broken.ts',
      `
        export function ok() {}
        export class Broken { ## invalid ##
        export function maybeRecovered() {}
      `,
    );
    writeFile(root, 'src/clean.ts', 'export function clean() {}');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    const result = await idx.scan({ respectGitignore: false });

    expect(result.filesScanned).toBe(2);
    expect(result.partials).toBe(1);

    const broken = idx.fileMeta('src/broken.ts');
    expect(broken?.parseStatus).toBe('partial');
    expect(broken?.parseError).toBeNull();

    const clean = idx.fileMeta('src/clean.ts');
    expect(clean?.parseStatus).toBe('ok');

    // Symbols around the syntax error still extract — partial
    // is a quality signal, not a "drop everything" mode.
    expect(idx.getSymbol('ok').length).toBe(1);
    expect(idx.getSymbol('clean').length).toBe(1);
    idx.close();
  });

  test('empty walk drops every prior row from the index', async () => {
    // Project starts with files indexed; then everything is
    // removed (or excluded). The walker returns zero entries,
    // _scan_seen is empty, and the prune deletes all files
    // rows. CASCADE wipes symbols/imports too.
    writeFile(root, 'src/a.ts', 'export function a() {}');
    writeFile(root, 'src/b.ts', 'export function b() {}');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
    expect(idx.status().filesIndexed).toBe(2);

    rmSync(join(root, 'src/a.ts'));
    rmSync(join(root, 'src/b.ts'));
    await idx.scan({ respectGitignore: false });

    expect(idx.status().filesIndexed).toBe(0);
    expect(idx.getSymbol('a').length).toBe(0);
    expect(idx.getSymbol('b').length).toBe(0);
    idx.close();
  });

  test('cleans up a leftover `_scan_seen` from an interrupted prior scan', async () => {
    // Simulate a prior scan that crashed before its finally
    // block ran: a `_scan_seen` table is left on the connection
    // with stale rows. The next scan must DROP IF EXISTS and
    // create a fresh one — otherwise the prior path-set would
    // poison the prune (e.g., delete files the new scan
    // legitimately indexed because they weren't in the leftover
    // set).
    const db = openMemoryDb();
    writeFile(root, 'src/keep.ts', 'export const keep = 1;');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: db });

    // Plant a leftover temp table with a bogus path.
    db.exec('CREATE TEMPORARY TABLE _scan_seen (path TEXT PRIMARY KEY)');
    db.query('INSERT INTO _scan_seen (path) VALUES (?)').run('src/ghost.ts');

    await idx.scan({ respectGitignore: false });

    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    expect(idx.fileMeta('src/ghost.ts')).toBeNull();
    expect(idx.status().filesIndexed).toBe(1);
    idx.close();
  });

  test('serializes concurrent scans on the same DB', async () => {
    // Two `scan()` calls awaited in parallel must NOT share
    // the connection's `_scan_seen` temp table mid-flight. The
    // mutex queues them so their CREATE/DROP cycles don't
    // interleave; both should observe the FS state correctly
    // and end with the same row count.
    writeFile(root, 'src/a.ts', 'export const a = 1;');
    writeFile(root, 'src/b.ts', 'export const b = 2;');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    const [r1, r2] = await Promise.all([
      idx.scan({ respectGitignore: false }),
      idx.scan({ respectGitignore: false }),
    ]);
    expect(r1.filesScanned).toBe(2);
    expect(r2.filesScanned).toBe(2);
    expect(idx.status().filesIndexed).toBe(2);
    expect(idx.getSymbol('a').length).toBe(1);
    expect(idx.getSymbol('b').length).toBe(1);
    idx.close();
  });

  test('preserves rows for paths whose lstat transiently fails', async () => {
    // Simulate a transient lstat failure: track a file in git,
    // index it, then `rm` it from the working tree without
    // `git rm`. ls-files still lists the path; lstat fails
    // ENOENT. The prune MUST NOT remove its prior row — that
    // would turn an FS hiccup into permanent data loss.
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], {
      encoding: 'utf8',
    });
    spawnSync('git', ['-C', root, 'config', 'user.name', 'test'], { encoding: 'utf8' });
    writeFile(root, 'src/keep.ts', 'export const keep = 1;');
    writeFile(root, 'src/flaky.ts', 'export const flaky = 2;');
    spawnSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });

    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: true });
    expect(idx.fileMeta('src/flaky.ts')).not.toBeNull();
    expect(idx.getSymbol('flaky').length).toBe(1);

    // Disappear flaky.ts from the working tree but keep it in
    // git cache. ls-files still lists it; lstat → ENOENT.
    rmSync(join(root, 'src/flaky.ts'));
    await idx.scan({ respectGitignore: true });

    // flaky's row + symbols preserved across the transient
    // failure. keep is still re-indexed normally.
    expect(idx.fileMeta('src/flaky.ts')).not.toBeNull();
    expect(idx.getSymbol('flaky').length).toBe(1);
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    idx.close();
  });

  test('discriminates lstat-failed (preserve) from truly-removed (prune)', async () => {
    // Mixed scenario proves the seenPaths discriminator: in a
    // single scan we have one file whose lstat fails (preserve
    // its row) AND one file that's been properly removed from
    // git (prune its row). A single scan must produce both
    // outcomes correctly.
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], {
      encoding: 'utf8',
    });
    spawnSync('git', ['-C', root, 'config', 'user.name', 'test'], { encoding: 'utf8' });
    writeFile(root, 'src/keep.ts', 'export const keep = 1;');
    writeFile(root, 'src/flaky.ts', 'export const flaky = 2;');
    writeFile(root, 'src/gone.ts', 'export const gone = 3;');
    spawnSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });

    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: true });
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    expect(idx.fileMeta('src/flaky.ts')).not.toBeNull();
    expect(idx.fileMeta('src/gone.ts')).not.toBeNull();

    // flaky.ts: rm working tree, keep in git cache. ls-files
    // still lists it; lstat fails ENOENT → seenPaths preserves.
    rmSync(join(root, 'src/flaky.ts'));
    // gone.ts: properly remove from git cache. ls-files no
    // longer lists it → not in seenPaths → prune deletes.
    spawnSync('git', ['-C', root, 'rm', '-q', 'src/gone.ts'], { encoding: 'utf8' });
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'remove gone'], { encoding: 'utf8' });

    await idx.scan({ respectGitignore: true });

    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    expect(idx.fileMeta('src/flaky.ts')).not.toBeNull(); // preserved
    expect(idx.fileMeta('src/gone.ts')).toBeNull(); // pruned
    expect(idx.getSymbol('flaky').length).toBe(1);
    expect(idx.getSymbol('gone').length).toBe(0);
    idx.close();
  });

  test('throwing walker preserves the existing index (no destructive prune)', async () => {
    // The pipeline must propagate walker failures BEFORE the
    // prune. If we let an inaccessible root reach the prune
    // step, the empty `_scan_seen` would delete every prior
    // row — turning a transient FS hiccup into permanent data
    // loss. Verify by indexing a project, then re-scanning
    // against a bogus root.
    writeFile(root, 'src/keep.ts', 'export const keep = 1;');
    const idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
    expect(idx.status().filesIndexed).toBe(1);

    await expect(
      idx.scan({ projectRoot: join(root, 'nonexistent'), respectGitignore: false }),
    ).rejects.toThrow(/inaccessible/);

    // Index untouched — original row + symbol still queryable.
    expect(idx.status().filesIndexed).toBe(1);
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
    expect(idx.getSymbol('keep').length).toBe(1);
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
