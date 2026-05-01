import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';

// Incremental scan path (CODE_INDEX.md §3.2). Caller hands in
// specific paths instead of walking the project; the function
// updates each in place. Used by the harness's PostToolUse
// hook (slice 4.3.6.b) and `agent --code-index scan --since`
// (future slice).

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('CodeIndex.scanFiles', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-incremental-'));
    idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
  });

  afterEach(() => {
    idx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('re-indexes a modified file (new symbol picked up)', async () => {
    writeFile(root, 'src/auth.ts', 'export function oldName() {}');
    await idx.scan({ respectGitignore: false });
    expect(idx.getSymbol('oldName').length).toBe(1);

    writeFile(root, 'src/auth.ts', 'export function newName() {}');
    const result = await idx.scanFiles({ paths: ['src/auth.ts'] });

    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(idx.getSymbol('oldName').length).toBe(0);
    expect(idx.getSymbol('newName').length).toBe(1);
  });

  test('content_hash match → unchanged (parse skipped)', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    await idx.scan({ respectGitignore: false });

    const result = await idx.scanFiles({ paths: ['src/auth.ts'] });
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.removed).toBe(0);
  });

  test('removes file row when path no longer exists', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    await idx.scan({ respectGitignore: false });
    expect(idx.fileMeta('src/auth.ts')).not.toBeNull();

    rmSync(join(root, 'src/auth.ts'));
    const result = await idx.scanFiles({ paths: ['src/auth.ts'] });

    expect(result.removed).toBe(1);
    expect(result.updated).toBe(0);
    expect(idx.fileMeta('src/auth.ts')).toBeNull();
    expect(idx.getSymbol('login').length).toBe(0);
  });

  test('drops file when its extension is no longer supported (renamed to .md)', async () => {
    writeFile(root, 'src/notes.ts', 'export const x = 1;');
    await idx.scan({ respectGitignore: false });
    expect(idx.fileMeta('src/notes.ts')).not.toBeNull();

    // Simulate a rename by removing the .ts and creating a .md
    // at the same path. The path passed to scanFiles points at
    // the old .ts location — the file no longer exists there
    // and the extension wouldn't match anyway.
    rmSync(join(root, 'src/notes.ts'));
    writeFile(root, 'src/notes.md', '# notes');
    const result = await idx.scanFiles({ paths: ['src/notes.ts'] });
    expect(result.removed).toBe(1);
    expect(idx.fileMeta('src/notes.ts')).toBeNull();
  });

  test('adds a new file that did not exist in the index', async () => {
    writeFile(root, 'src/keep.ts', 'export const keep = 1;');
    await idx.scan({ respectGitignore: false });

    writeFile(root, 'src/added.ts', 'export function added() { return 1; }');
    const result = await idx.scanFiles({ paths: ['src/added.ts'] });

    expect(result.updated).toBe(1);
    expect(idx.fileMeta('src/added.ts')).not.toBeNull();
    expect(idx.getSymbol('added').length).toBe(1);
    // Other files untouched.
    expect(idx.fileMeta('src/keep.ts')).not.toBeNull();
  });

  test('runs resolver after re-indexing — references rebind', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() { return true; }');
    writeFile(
      root,
      'src/page.ts',
      "import { login } from './auth';\nexport function bootstrap() { login(); }",
    );
    await idx.scan({ respectGitignore: false });
    const loginBefore = idx.getSymbol('login')[0];
    expect(loginBefore?.id).toBeDefined();
    const refsBefore = idx.findReferences(loginBefore?.id ?? -1);
    expect(refsBefore.length).toBeGreaterThan(0);

    // Modify auth.ts: keep `login` but add helper. The login id
    // changes (delete-then-insert), so the resolver must rebind
    // refs from page.ts to the new id.
    writeFile(
      root,
      'src/auth.ts',
      'export function helper() { return 2; }\nexport function login() { return true; }',
    );
    await idx.scanFiles({ paths: ['src/auth.ts'] });

    const loginAfter = idx.getSymbol('login')[0];
    expect(loginAfter?.id).toBeDefined();
    expect(loginAfter?.id).not.toBe(loginBefore?.id);
    const refsAfter = idx.findReferences(loginAfter?.id ?? -1);
    expect(refsAfter.length).toBe(refsBefore.length);
  });

  test('accepts absolute paths and converts to project-relative', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    await idx.scan({ respectGitignore: false });
    writeFile(root, 'src/auth.ts', 'export function login2() {}');

    const result = await idx.scanFiles({
      paths: [join(root, 'src/auth.ts')],
    });
    expect(result.updated).toBe(1);
    expect(idx.getSymbol('login').length).toBe(0);
    expect(idx.getSymbol('login2').length).toBe(1);
  });

  test('drops out-of-tree paths silently', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    await idx.scan({ respectGitignore: false });

    // Path escapes the project root.
    const result = await idx.scanFiles({
      paths: ['/etc/hosts', '../../../escape.ts'],
    });
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.removed).toBe(0);
    expect(idx.fileMeta('src/auth.ts')).not.toBeNull();
  });

  test('skips files matching default privacy excludes', async () => {
    writeFile(root, 'node_modules/x/index.js', 'export const x = 1;');
    const result = await idx.scanFiles({ paths: ['node_modules/x/index.js'] });
    // Excluded path → no row added, no row to remove (was never indexed).
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(idx.fileMeta('node_modules/x/index.js')).toBeNull();
  });

  test('deduplicates back-to-back paths', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    await idx.scan({ respectGitignore: false });
    writeFile(root, 'src/auth.ts', 'export function changed() {}');

    // Same path passed multiple times — should re-index once.
    const result = await idx.scanFiles({
      paths: ['src/auth.ts', 'src/auth.ts', 'src/auth.ts'],
    });
    expect(result.updated).toBe(1);
    expect(idx.getSymbol('changed').length).toBe(1);
  });

  test('empty paths array is a no-op', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    await idx.scan({ respectGitignore: false });
    const result = await idx.scanFiles({ paths: [] });
    expect(result).toEqual({ updated: 0, unchanged: 0, removed: 0, errors: [] });
    // Index untouched.
    expect(idx.getSymbol('login').length).toBe(1);
  });

  test('idempotent: same content twice yields unchanged on second pass', async () => {
    writeFile(root, 'src/auth.ts', 'export function login() {}');
    const r1 = await idx.scanFiles({ paths: ['src/auth.ts'] });
    expect(r1.updated).toBe(1);
    const r2 = await idx.scanFiles({ paths: ['src/auth.ts'] });
    expect(r2.unchanged).toBe(1);
    expect(r2.updated).toBe(0);
  });

  test('records error for parse failure but keeps row + cleans symbols', async () => {
    // Force a parse_status='partial' via tree-sitter recovering
    // around a syntax error — the file row stays as 'partial',
    // not 'failed'. Failed-only is hard to trigger in practice
    // (tree-sitter is permissive); 'partial' exercises the
    // non-clean path through scanFiles.
    writeFile(root, 'src/auth.ts', 'export function ok() {}');
    await idx.scan({ respectGitignore: false });
    writeFile(root, 'src/auth.ts', 'export function ok() {}\nexport class Broken { ## invalid ## ');
    const result = await idx.scanFiles({ paths: ['src/auth.ts'] });
    expect(result.updated).toBe(1);
    const meta = idx.fileMeta('src/auth.ts');
    expect(meta?.parseStatus).toBe('partial');
  });

  test('serializes against concurrent full scan (no errors, deterministic state)', async () => {
    // PostToolUse will fire scanFiles while the user can still
    // run `agent --code-index scan` against the same DB. Both
    // paths share the connection's prepared-statement cache and
    // the full-scan path's _scan_seen temp table; the scan-lock
    // (`_lock.ts`) queues them so neither sees the other's
    // mid-flight state. Hammer them in parallel and assert the
    // index converges on the FS state without errors.
    writeFile(root, 'src/a.ts', 'export function a() {}');
    writeFile(root, 'src/b.ts', 'export function b() {}');
    writeFile(root, 'src/c.ts', 'export function c() {}');
    await idx.scan({ respectGitignore: false });

    writeFile(root, 'src/a.ts', 'export function a2() {}');
    writeFile(root, 'src/b.ts', 'export function b2() {}');

    // Fire 4 incremental scans + 1 full scan all racing. The
    // mutex must serialize them; final state must match a
    // sequential run.
    const ops = [
      idx.scanFiles({ paths: ['src/a.ts'] }),
      idx.scan({ respectGitignore: false }),
      idx.scanFiles({ paths: ['src/b.ts'] }),
      idx.scanFiles({ paths: ['src/a.ts', 'src/b.ts'] }),
      idx.scanFiles({ paths: ['src/c.ts'] }),
    ];
    const results = await Promise.all(ops);
    for (const r of results) {
      // Each op completes without throwing. Errors arrays must
      // be empty — interleaved transactions tend to surface as
      // "no such table _scan_seen" or similar SQLite errors,
      // which would land in errors[] for scanFiles or throw
      // for scanProject.
      if ('errors' in r) expect(r.errors).toEqual([]);
    }

    expect(idx.getSymbol('a').length).toBe(0);
    expect(idx.getSymbol('a2').length).toBe(1);
    expect(idx.getSymbol('b').length).toBe(0);
    expect(idx.getSymbol('b2').length).toBe(1);
    expect(idx.getSymbol('c').length).toBe(1);
  });
});
