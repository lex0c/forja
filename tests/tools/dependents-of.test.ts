import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { dependentsOfTool } from '../../src/tools/builtin/dependents-of.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('dependents_of tool', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-deps-'));
    writeFile(root, 'src/auth.ts', 'export const auth = 1;');
    writeFile(root, 'src/login.ts', 'import { auth } from "./auth";');
    writeFile(
      root,
      'src/logout.ts',
      `import { auth } from "./auth";
import { login } from "./login";`,
    );
    writeFile(root, 'src/main.ts', 'import { logout } from "./logout";');
    idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
  });

  afterEach(() => {
    idx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('returns direct dependents (hops=1 default)', async () => {
    const r = await dependentsOfTool.execute(
      { path: 'src/auth.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    const paths = r.dependents.map((d) => d.path).sort();
    expect(paths).toEqual(['src/login.ts', 'src/logout.ts']);
    expect(r.dependents.every((d) => d.hops === 1)).toBe(true);
    expect(r.truncated).toBe(false);
  });

  test('imported_names surface so the model knows WHAT each dependent uses', async () => {
    const r = await dependentsOfTool.execute(
      { path: 'src/auth.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.dependents[0]?.imported_names).toEqual(['auth']);
  });

  test('hops walks transitively (one edge per dependency edge)', async () => {
    // Graph: auth ← login, auth ← logout, login ← logout, logout ← main.
    // BFS at hops=2 emits per-edge rows: a file may show up
    // multiple times if it imports more than one node already
    // in the BFS frontier (logout depends on both auth and
    // login, so it appears at hops=1 AND hops=2).
    // Verify via min-hop-per-path semantics: each path's
    // shortest distance from auth.
    const r = await dependentsOfTool.execute(
      { path: 'src/auth.ts', hops: 2 },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    const minHops = r.dependents.reduce<Map<string, number>>((acc, d) => {
      const cur = acc.get(d.path);
      acc.set(d.path, cur === undefined ? d.hops : Math.min(cur, d.hops));
      return acc;
    }, new Map());
    expect(minHops.get('src/login.ts')).toBe(1);
    expect(minHops.get('src/logout.ts')).toBe(1);
    expect(minHops.get('src/main.ts')).toBe(2);
  });

  test('returns empty when the file has no dependents', async () => {
    const r = await dependentsOfTool.execute(
      { path: 'src/main.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.dependents).toEqual([]);
  });

  test('rejects out-of-range hops', async () => {
    const r = await dependentsOfTool.execute(
      { path: 'src/auth.ts', hops: 99 },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('skips self-import edges from cyclic dependencies', async () => {
    // Cycle: a.ts ↔ b.ts (each imports the other). Without the
    // self-edge guard, dependents_of(a, hops=2) would emit
    // `a.ts` itself as a transitive dependent of itself
    // (a → b → a). The guard suppresses that nonsense edge.
    writeFile(root, 'src/a.ts', 'import { b } from "./b";');
    writeFile(root, 'src/b.ts', 'import { a } from "./a";');
    await idx.scan({ respectGitignore: false });
    const r = await dependentsOfTool.execute(
      { path: 'src/a.ts', hops: 2 },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    // b appears (direct dependent) but a never does (would be
    // self-edge via cycle).
    expect(r.dependents.find((d) => d.path === 'src/a.ts')).toBeUndefined();
    expect(r.dependents.find((d) => d.path === 'src/b.ts')).toBeDefined();
  });

  test('returns index.unavailable when CodeIndex absent', async () => {
    const r = await dependentsOfTool.execute({ path: 'src/auth.ts' }, makeCtx({ cwd: root }));
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('index.unavailable');
  });
});
