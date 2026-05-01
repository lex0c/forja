import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { importsOfTool } from '../../src/tools/builtin/imports-of.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('imports_of tool', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-importsof-'));
    writeFile(
      root,
      'src/auth.ts',
      `
import { Token } from "./types";
import * as fs from "fs";
import React from "react";
const cjs = require("./util");
`.trim(),
    );
    idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
  });

  afterEach(() => {
    idx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('returns direct imports with names + isExternal flag', async () => {
    const r = await importsOfTool.execute(
      { path: 'src/auth.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.imports.length).toBe(4);
    expect(r.truncated).toBe(false);

    const types = r.imports.find((i) => i.target_module === './types');
    expect(types?.is_external).toBe(false);
    expect(types?.names).toEqual(['Token']);

    const fsImp = r.imports.find((i) => i.target_module === 'fs');
    expect(fsImp?.is_external).toBe(true);
    expect(fsImp?.names).toEqual(['*']);

    const react = r.imports.find((i) => i.target_module === 'react');
    expect(react?.names).toEqual(['default']);

    const cjs = r.imports.find((i) => i.target_module === './util');
    expect(cjs?.names).toEqual(['default']);
  });

  test('rejects out-of-range hops', async () => {
    const r = await importsOfTool.execute(
      { path: 'src/auth.ts', hops: 99 },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('hops > 1 returns at least the direct edges (target_path null pre-resolver)', async () => {
    // Until the reference resolver runs (slice 4.3.3),
    // target_path stays null on every row so the BFS can't
    // descend. The direct edges still come back; the API
    // shape doesn't change once resolution lands.
    const r = await importsOfTool.execute(
      { path: 'src/auth.ts', hops: 3 },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.imports.length).toBe(4);
    for (const imp of r.imports) {
      expect(imp.target_path).toBeNull();
    }
  });

  test('returns an empty list (not an error) for a file with no imports', async () => {
    writeFile(root, 'src/lonely.ts', 'export const x = 1;');
    await idx.scan({ respectGitignore: false });
    const r = await importsOfTool.execute(
      { path: 'src/lonely.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.imports).toEqual([]);
  });

  test('returns index.unavailable when CodeIndex absent', async () => {
    const r = await importsOfTool.execute({ path: 'src/auth.ts' }, makeCtx({ cwd: root }));
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('index.unavailable');
  });
});
