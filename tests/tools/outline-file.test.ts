import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { outlineFileTool } from '../../src/tools/builtin/outline-file.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('outline_file tool', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-outline-'));
    writeFile(
      root,
      'src/auth.ts',
      `
import { Token } from "./types";
import * as fs from "fs";

export function login(user: string): boolean { return true; }
function helper() { return 1; }
export class Auth {
  public check(): boolean { return false; }
  private secret(): void {}
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

  test('returns only public/exported symbols by default', async () => {
    const r = await outlineFileTool.execute(
      { path: 'src/auth.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    const names = r.symbols.map((s) => s.name).sort();
    // login (export), Auth (export class), check (public method);
    // helper (internal) and secret (private) excluded.
    expect(names).toEqual(['Auth', 'check', 'login']);
  });

  test('includes internal/private symbols when include_internal=true', async () => {
    const r = await outlineFileTool.execute(
      { path: 'src/auth.ts', include_internal: true },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    const names = r.symbols.map((s) => s.name).sort();
    expect(names).toContain('helper');
    expect(names).toContain('secret');
  });

  test('reports loc and a one-line imports summary', async () => {
    const r = await outlineFileTool.execute(
      { path: 'src/auth.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.loc).toBeGreaterThan(0);
    // 2 imports total: ./types (local), fs (external).
    expect(r.imports_summary).toContain('2 sources');
    expect(r.imports_summary).toContain('1 local');
    expect(r.imports_summary).toContain('1 external');
  });

  test('returns fs.not_found for a path not in the index', async () => {
    const r = await outlineFileTool.execute(
      { path: 'src/missing.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('fs.not_found');
  });

  test('returns index.unavailable when CodeIndex absent', async () => {
    const r = await outlineFileTool.execute({ path: 'src/auth.ts' }, makeCtx({ cwd: root }));
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('index.unavailable');
  });

  test('lines are 1-indexed for editor parity', async () => {
    const r = await outlineFileTool.execute(
      { path: 'src/auth.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    for (const s of r.symbols) {
      expect(s.line).toBeGreaterThanOrEqual(1);
    }
  });

  test('methods carry their parent class name', async () => {
    const r = await outlineFileTool.execute(
      { path: 'src/auth.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    const check = r.symbols.find((s) => s.name === 'check');
    expect(check?.parent).toBe('Auth');
  });
});
