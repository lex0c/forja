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
