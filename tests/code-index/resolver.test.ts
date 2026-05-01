import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';

// resolver.test.ts pins the post-scan import target_path
// resolution. The pipeline calls `resolveImports` at the end of
// every scan; tests below exercise it through the public
// CodeIndex.scan path so we get the integrated behavior, not
// just the raw helper.

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('resolveImports', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-resolver-'));
    idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
  });

  afterEach(() => {
    idx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('resolves explicit-extension imports (./foo.ts) directly', async () => {
    // Bun/ESM-style codebases often write the extension into
    // the import string: `import { x } from './foo.ts'`. The
    // resolver tried APPENDING extensions before, so it would
    // attempt `./foo.ts.ts` and miss. Pin the bare-path-first
    // resolution so this canonical pattern works.
    writeFile(root, 'src/util.ts', 'export const v = 1;');
    writeFile(root, 'src/page.ts', `import { v } from "./util.ts";`);
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.targetPath).toBe('src/util.ts');
  });

  test('resolves explicit-extension imports up-tree (../shared.ts)', async () => {
    writeFile(root, 'src/a/feature.ts', 'import { shared } from "../shared.ts";');
    writeFile(root, 'src/shared.ts', 'export const shared = 1;');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/a/feature.ts');
    expect(imports[0]?.targetPath).toBe('src/shared.ts');
  });

  test('resolves a relative import to a sibling .ts file', async () => {
    writeFile(root, 'src/auth.ts', 'import { Token } from "./types";');
    writeFile(root, 'src/types.ts', 'export type Token = string;');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/auth.ts');
    expect(imports.length).toBe(1);
    expect(imports[0]?.targetModule).toBe('./types');
    expect(imports[0]?.targetPath).toBe('src/types.ts');
    expect(imports[0]?.isExternal).toBe(false);
  });

  test('resolves to .tsx when both .ts and .tsx are absent (extension order)', async () => {
    writeFile(root, 'src/Button.tsx', 'export function Button() {}');
    writeFile(root, 'src/page.ts', 'import { Button } from "./Button";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.targetPath).toBe('src/Button.tsx');
  });

  test('prefers .ts over .js when both exist', async () => {
    // Order in RESOLUTION_EXTENSIONS: ts/tsx/mts/cts before
    // js/jsx/mjs/cjs. Pin that contract so a future reorder
    // doesn't silently change resolution semantics.
    writeFile(root, 'src/util.ts', 'export const v = 1;');
    writeFile(root, 'src/util.js', 'export const v = 2;');
    writeFile(root, 'src/page.ts', 'import { v } from "./util";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.targetPath).toBe('src/util.ts');
  });

  test('resolves directory imports via index file fallback', async () => {
    // Node / bundlers / tsc resolve `import './lib'` to
    // `./lib/index.ts` when no `./lib.ts` exists. Pin that
    // fallback.
    writeFile(root, 'src/lib/index.ts', 'export const v = 1;');
    writeFile(root, 'src/page.ts', 'import { v } from "./lib";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.targetPath).toBe('src/lib/index.ts');
  });

  test('resolves parent-directory imports (`../`)', async () => {
    writeFile(root, 'src/a/feature.ts', 'import { shared } from "../shared";');
    writeFile(root, 'src/shared.ts', 'export const shared = 1;');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/a/feature.ts');
    expect(imports[0]?.targetPath).toBe('src/shared.ts');
  });

  test('leaves target_path null when relative target does not exist', async () => {
    writeFile(root, 'src/page.ts', 'import { x } from "./missing";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.targetPath).toBeNull();
    expect(imports[0]?.isExternal).toBe(false);
  });

  test('leaves target_path null for external imports', async () => {
    writeFile(root, 'src/page.ts', 'import React from "react";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.targetPath).toBeNull();
    expect(imports[0]?.isExternal).toBe(true);
  });

  test('rejects parent-traversal that escapes the project root', async () => {
    writeFile(root, 'src/page.ts', 'import { x } from "../../../escape";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    // The escape can't resolve to an indexed row; target_path
    // stays null. Critical: the resolver must not produce a
    // path with leading `..` segments.
    expect(imports[0]?.targetPath).toBeNull();
  });

  test('idempotent across re-scans (already-resolved rows untouched)', async () => {
    writeFile(root, 'src/auth.ts', 'import { Token } from "./types";');
    writeFile(root, 'src/types.ts', 'export type Token = string;');
    await idx.scan({ respectGitignore: false });
    const first = idx.importsOf('src/auth.ts')[0]?.targetPath;
    expect(first).toBe('src/types.ts');
    // Re-scan: same content, same hash, but resolver runs again.
    await idx.scan({ respectGitignore: false });
    const second = idx.importsOf('src/auth.ts')[0]?.targetPath;
    expect(second).toBe('src/types.ts');
  });

  test('resolves cross-language imports (.ts → .js sibling)', async () => {
    // A .ts file importing a .js sibling is legal (TS allows
    // `allowJs`-style mixes; bundlers always do). The resolver
    // tries the .js extension on the same loop and finds it.
    writeFile(root, 'src/legacy.js', 'export const v = 1;');
    writeFile(root, 'src/page.ts', 'import { v } from "./legacy";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.targetPath).toBe('src/legacy.js');
  });

  test('absolute `/`-prefix imports stay unresolved (current behavior)', async () => {
    // Pinning current behavior, NOT desired behavior. The
    // extractor classifies `/foo` as is_external=false (not a
    // bare specifier), and the resolver's joinAndNormalize
    // strips the leading slash and treats `/foo` as relative
    // to source dir. In practice that rarely matches an
    // indexed row, so the result is target_path=null. A
    // future polish slice can either:
    //   - mark `/`-prefix as external in the extractor, OR
    //   - anchor the resolver at projectRoot for `/`-prefix.
    // Until then, this test guards against the silent change.
    writeFile(root, '/dummy.ts', '');
    writeFile(root, 'src/page.ts', 'import { x } from "/abs/path";');
    await idx.scan({ respectGitignore: false });
    const imports = idx.importsOf('src/page.ts');
    expect(imports[0]?.isExternal).toBe(false);
    expect(imports[0]?.targetPath).toBeNull();
  });

  test('dependentsOf returns importing files once target_path is resolved', async () => {
    // Pre-resolver, dependentsOf was always empty (target_path
    // was always null). This pins that the resolver wires up
    // the reverse-graph query.
    writeFile(root, 'src/auth.ts', 'export const auth = 1;');
    writeFile(root, 'src/login.ts', 'import { auth } from "./auth";');
    writeFile(root, 'src/logout.ts', 'import { auth } from "./auth";');
    await idx.scan({ respectGitignore: false });
    const dependents = idx.dependentsOf('src/auth.ts');
    expect(dependents.sort()).toEqual(['src/login.ts', 'src/logout.ts']);
  });
});

describe('resolveReferences', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-resolverefs-'));
    idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
  });

  afterEach(() => {
    idx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('binds a reference to a globally-unique symbol name', async () => {
    writeFile(
      root,
      'src/auth.ts',
      `
export function login() { return true; }
export function start() {
  login();
}
      `.trim(),
    );
    await idx.scan({ respectGitignore: false });
    const login = idx.getSymbol('login');
    expect(login.length).toBe(1);
    const refs = idx.findReferences(login[0]?.id ?? -1);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]?.targetSymbolName).toBe('login');
    expect(refs[0]?.targetSymbolId).toBe(login[0]?.id ?? null);
  });

  test('leaves ambiguous-name references unresolved', async () => {
    // Same name in two classes → two FQNs → ambiguous; resolver
    // skips. find_references_by_name still works (string match).
    writeFile(
      root,
      'src/svc.ts',
      `
export class A {
  start() { return 'A'; }
}
export class B {
  start() { return 'B'; }
}
export function run(a: A, b: B) {
  a.start();
  b.start();
}
      `.trim(),
    );
    await idx.scan({ respectGitignore: false });
    // start references — resolver bound 0 because two FQNs exist.
    const byName = idx.findReferencesByName('start');
    expect(byName.length).toBe(2);
    expect(byName.every((r) => r.targetSymbolId === null)).toBe(true);
  });

  test('overload group with single FQN resolves to the implementation', async () => {
    // `function poly` × N signatures + impl all share FQN
    // `<file>:poly`. Resolver picks the impl (largest span).
    writeFile(
      root,
      'src/over.ts',
      `
export function poly(x: string): string;
export function poly(x: number): number;
export function poly(x: string | number): string | number {
  return x;
}
export function caller() {
  poly('x');
}
      `.trim(),
    );
    await idx.scan({ respectGitignore: false });
    const byName = idx.findReferencesByName('poly');
    expect(byName.length).toBe(1);
    // Resolver bound it to the impl.
    expect(byName[0]?.targetSymbolId).not.toBeNull();
  });

  test('binds a cross-file reference (caller and callee in different files)', async () => {
    // The canonical use case: caller in one file, callee in
    // another. Reference resolution must walk the global symbol
    // set, not just the file's own symbols.
    writeFile(root, 'src/auth.ts', 'export function login() { return true; }');
    writeFile(
      root,
      'src/page.ts',
      `
import { login } from './auth';
export function bootstrap() {
  login();
}
      `.trim(),
    );
    await idx.scan({ respectGitignore: false });
    const login = idx.getSymbol('login');
    expect(login.length).toBe(1);
    expect(login[0]?.filePath).toBe('src/auth.ts');
    const refs = idx.findReferences(login[0]?.id ?? -1);
    // The call site is in src/page.ts, but the bound symbol is
    // in src/auth.ts.
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]?.sourceFile).toBe('src/page.ts');
    expect(refs[0]?.targetSymbolId).toBe(login[0]?.id ?? null);
  });

  test('idempotent across re-scans (already-resolved refs untouched)', async () => {
    writeFile(
      root,
      'src/x.ts',
      `
export function ping() {}
export function caller() { ping(); }
      `.trim(),
    );
    await idx.scan({ respectGitignore: false });
    const ping = idx.getSymbol('ping');
    const refsFirst = idx.findReferences(ping[0]?.id ?? -1);
    expect(refsFirst.length).toBe(1);
    await idx.scan({ respectGitignore: false });
    const ping2 = idx.getSymbol('ping');
    const refsSecond = idx.findReferences(ping2[0]?.id ?? -1);
    expect(refsSecond.length).toBe(1);
  });

  test('zero candidates results in zero resolved (empty DB no-op)', async () => {
    // Empty project — no symbols, no references. resolveReferences
    // should return cleanly without touching tables.
    const result = await idx.scan({ respectGitignore: false });
    expect(result.referencesResolved).toBe(0);
    expect(result.referencesInserted).toBe(0);
  });
});
