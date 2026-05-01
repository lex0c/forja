import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { findReferencesTool } from '../../src/tools/builtin/find-references.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('find_references tool', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-findrefs-'));
    writeFile(
      root,
      'src/auth.ts',
      `
export function login() { return true; }
export class Auth {}
      `.trim(),
    );
    writeFile(
      root,
      'src/page.ts',
      `
import { login, Auth } from './auth';
export class AdminAuth extends Auth {}
export function bootstrap() {
  login();
  login();
}
      `.trim(),
    );
    idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
  });

  afterEach(() => {
    idx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('returns call sites with surrounding text (1-indexed lines)', async () => {
    const r = await findReferencesTool.execute(
      { symbol: 'login' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    const calls = r.references.filter((h) => h.kind === 'call');
    expect(calls.length).toBe(2);
    expect(calls[0]?.file).toBe('src/page.ts');
    expect(calls[0]?.line).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.surrounding_text).toContain('login()');
  });

  test('returns extends references for a class with subclasses', async () => {
    const r = await findReferencesTool.execute(
      { symbol: 'Auth' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    const ext = r.references.find((h) => h.kind === 'extends');
    expect(ext?.file).toBe('src/page.ts');
    expect(ext?.surrounding_text).toContain('extends Auth');
  });

  test('ref_kind filter narrows to a single category', async () => {
    const r = await findReferencesTool.execute(
      { symbol: 'Auth', ref_kind: 'extends' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.references.every((h) => h.kind === 'extends')).toBe(true);
  });

  test('FQN selects a specific symbol', async () => {
    const r = await findReferencesTool.execute(
      { symbol: 'src/auth.ts:login' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.references.length).toBeGreaterThan(0);
  });

  test('returns symbol.not_found for unknown name', async () => {
    const r = await findReferencesTool.execute(
      { symbol: 'nonexistent' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('symbol.not_found');
  });

  test('returns symbol.ambiguous for bare name in multiple files', async () => {
    writeFile(root, 'src/dup1.ts', 'export function helper() { return 1; }');
    writeFile(root, 'src/dup2.ts', 'export function helper() { return 2; }');
    await idx.scan({ respectGitignore: false });
    const r = await findReferencesTool.execute(
      { symbol: 'helper' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('symbol.ambiguous');
  });

  test('rejects invalid ref_kind', async () => {
    const r = await findReferencesTool.execute(
      // biome-ignore lint/suspicious/noExplicitAny: deliberate bad arg
      { symbol: 'login', ref_kind: 'bogus' as any },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('returns index.unavailable when CodeIndex absent', async () => {
    const r = await findReferencesTool.execute({ symbol: 'login' }, makeCtx({ cwd: root }));
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('index.unavailable');
  });

  test('emits hits with text_unavailable when fs.read policy denies the file', async () => {
    // Self-gate denial must NOT silently drop the hit — the
    // model needs to know the reference exists even without
    // surrounding context. Otherwise refactor decisions like
    // "only 3 callers exist" can be silently wrong.
    const denyPage = (
      _name: string,
      _cat: string,
      a: { path?: string },
    ): { kind: 'allow'; reason?: string } | { kind: 'deny'; reason: string } =>
      typeof a.path === 'string' && a.path.endsWith('page.ts')
        ? { kind: 'deny', reason: 'test: page.ts denied' }
        : { kind: 'allow' };
    const r = await findReferencesTool.execute(
      { symbol: 'login' },
      makeCtx({ codeIndex: idx, cwd: root, permissionCheck: denyPage }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    // login is called twice in page.ts; both hits surface with
    // text_unavailable=permission_denied and empty
    // surrounding_text.
    const calls = r.references.filter((h) => h.kind === 'call');
    expect(calls.length).toBe(2);
    expect(calls.every((h) => h.text_unavailable === 'permission_denied')).toBe(true);
    expect(calls.every((h) => h.surrounding_text === '')).toBe(true);
  });

  test('exercises the resolved (target_symbol_id) lookup path', async () => {
    // login is globally unique → resolver bound the call refs
    // to its symbol id. Confirm the byId path returns the same
    // hits as the byName path produces. Regression guard: if
    // the resolver were silently broken, byId would return
    // empty and the merged output would still match (covered
    // by byName), so the test verifies the byId path directly.
    const login = idx.getSymbol('login');
    expect(login.length).toBe(1);
    const byId = idx.findReferences(login[0]?.id ?? -1);
    const byName = idx.findReferencesByName('login');
    expect(byId.length).toBeGreaterThan(0);
    expect(byId.length).toBe(byName.length);
    expect(byId.every((r) => r.targetSymbolId === login[0]?.id)).toBe(true);
  });

  test('ref_kind=import filter returns empty (extractor does not yet emit import refs)', async () => {
    // Documented gap: the extractor does NOT yet capture
    // ref_kind='import'. Pin the current behavior so a future
    // extractor change populating these refs surfaces here.
    const r = await findReferencesTool.execute(
      { symbol: 'login', ref_kind: 'import' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.references).toEqual([]);
  });
});
