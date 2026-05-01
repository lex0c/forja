import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/code-index/index.ts';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { readSymbolTool } from '../../src/tools/builtin/read-symbol.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const writeFile = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
};

describe('read_symbol tool', () => {
  let root: string;
  let idx: CodeIndex;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'forja-readsym-'));
    writeFile(
      root,
      'src/auth.ts',
      'export function login(user: string): boolean {\n  return user.length > 0;\n}\n',
    );
    writeFile(root, 'src/util.ts', 'export const X = 1;\n');
    writeFile(root, 'src/dup.ts', 'export function helper() { return 1; }\n');
    writeFile(root, 'src/dup2.ts', 'export function helper() { return 2; }\n');
    idx = await CodeIndex.init({ projectRoot: root, dbOverride: openMemoryDb() });
    await idx.scan({ respectGitignore: false });
  });

  afterEach(() => {
    idx.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('returns the symbol body for a unique match', async () => {
    const r = await readSymbolTool.execute(
      { symbol: 'login' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.symbol.name).toBe('login');
    expect(r.symbol.kind).toBe('function');
    expect(r.symbol.file).toBe('src/auth.ts');
    expect(r.source).toContain('export function login');
    expect(r.source).toContain('return user.length > 0;');
    expect(r.signature).toContain('user: string');
    expect(r.symbol.line_range.start).toBe(1);
    expect(r.symbol.line_range.end).toBeGreaterThanOrEqual(r.symbol.line_range.start);
  });

  test('returns symbol.ambiguous when name appears in multiple files', async () => {
    const r = await readSymbolTool.execute(
      { symbol: 'helper' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('symbol.ambiguous');
    expect(r.details?.candidates).toBeDefined();
    const cands = r.details?.candidates as Array<{ file: string }>;
    expect(cands.map((c) => c.file).sort()).toEqual(['src/dup.ts', 'src/dup2.ts']);
  });

  test('disambiguates with `file` when symbol is ambiguous', async () => {
    const r = await readSymbolTool.execute(
      { symbol: 'helper', file: 'src/dup.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.source).toContain('return 1');
  });

  test('returns symbol.not_found when name does not match', async () => {
    const r = await readSymbolTool.execute(
      { symbol: 'nonexistent' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('symbol.not_found');
  });

  test('returns index.unavailable when CodeIndex absent on context', async () => {
    const r = await readSymbolTool.execute({ symbol: 'login' }, makeCtx({ cwd: root }));
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('index.unavailable');
  });

  test('rejects empty symbol name', async () => {
    const r = await readSymbolTool.execute({ symbol: '' }, makeCtx({ codeIndex: idx, cwd: root }));
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('tool.invalid_arg');
  });

  test('accepts an absolute file path and converts to project-relative', async () => {
    const r = await readSymbolTool.execute(
      { symbol: 'helper', file: join(root, 'src/dup.ts') },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.source).toContain('return 1');
  });

  test('FQN selects a specific method without needing `file:`', async () => {
    // Two classes in the same file with same-named methods.
    // FQN lookup pinpoints one without ambiguity. The
    // extractor emits FQN as `<file>:Class.method`.
    writeFile(
      root,
      'src/two-classes.ts',
      `
export class A {
  start() { return 'A'; }
}
export class B {
  start() { return 'B'; }
}
`.trim(),
    );
    await idx.scan({ respectGitignore: false });
    const r = await readSymbolTool.execute(
      { symbol: 'src/two-classes.ts:B.start' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.symbol.fqn).toBe('src/two-classes.ts:B.start');
    expect(r.source).toContain("return 'B'");
  });

  test('FQN with `file:` arg works (file is redundant but tolerated)', async () => {
    writeFile(root, 'src/extra.ts', 'export function ping() {}');
    await idx.scan({ respectGitignore: false });
    const r = await readSymbolTool.execute(
      { symbol: 'src/extra.ts:ping', file: 'src/extra.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    expect(r.symbol.name).toBe('ping');
  });

  test('FQN miss falls through to name-based lookup', async () => {
    // A bare name with a colon ("type:name" pattern from some
    // codebases) shouldn't get stuck on the FQN path. If the
    // FQN lookup returns zero rows, fall through to name. Here
    // the colon in the input doesn't match any FQN, so we end
    // up at name lookup which also misses → not_found.
    const r = await readSymbolTool.execute(
      { symbol: 'bogus:thing' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('symbol.not_found');
  });

  test('same-name methods in different classes within one file remain ambiguous', async () => {
    // Two classes in the same file, each with a `start` method:
    // file+kind+name match but FQNs differ (`A.start` vs
    // `B.start`). The dedup heuristic must NOT collapse them —
    // doing so would silently return one body and hide the
    // ambiguity from the caller. The tool surfaces
    // symbol.ambiguous and the model picks via the parent
    // class (slice 4.3.3 will populate parent_symbol_id and a
    // future tool surface can take a `class:` arg; for now,
    // the model uses the candidates list to read both via
    // separate calls).
    writeFile(
      root,
      'src/two-classes.ts',
      `
export class A {
  start() { return 'A'; }
}
export class B {
  start() { return 'B'; }
}
`.trim(),
    );
    await idx.scan({ respectGitignore: false });
    const r = await readSymbolTool.execute(
      { symbol: 'start', file: 'src/two-classes.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('symbol.ambiguous');
    const cands = r.details?.candidates as Array<{ file: string; line: number }>;
    expect(cands.length).toBe(2);
    // Both candidates point at src/two-classes.ts, distinct lines.
    expect(cands.every((c) => c.file === 'src/two-classes.ts')).toBe(true);
    expect(cands[0]?.line).not.toBe(cands[1]?.line);
  });

  test('TS function overloads dedupe to the implementation (largest line span)', async () => {
    // Multiple `function_declaration` nodes for the same name +
    // file (overload signatures + implementation). Without
    // dedup, the result is incorrectly classified as ambiguous
    // even with `file:` set. The tool picks the largest-span
    // candidate (the implementation has a body; signatures are
    // 1-line declarations).
    writeFile(
      root,
      'src/overloaded.ts',
      `
export function poly(x: string): string;
export function poly(x: number): number;
export function poly(x: string | number): string | number {
  return x;
}
`.trim(),
    );
    await idx.scan({ respectGitignore: false });
    const r = await readSymbolTool.execute(
      { symbol: 'poly', file: 'src/overloaded.ts' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(false);
    if (isToolError(r)) return;
    // Implementation body present; signatures are single-line.
    expect(r.source).toContain('return x;');
  });

  test('surfaces permission.denied when fs.read policy denies the resolved file', async () => {
    const denyAll = (): { kind: 'deny'; reason: string } => ({
      kind: 'deny',
      reason: 'test: deny everything',
    });
    const r = await readSymbolTool.execute(
      { symbol: 'login' },
      makeCtx({ codeIndex: idx, cwd: root, permissionCheck: denyAll }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('permission.denied');
    expect(r.error_message).toContain('deny everything');
  });

  test('treats `confirm` decision as a block (no UI available in self-gate)', async () => {
    // The harness owns the confirmFn; a tool's self-gate has no
    // way to prompt the operator. Letting `confirm` fall through
    // would silently bypass the operator's intent. Match the
    // monitor / wait_for pattern: any non-allow blocks.
    const askConfirm = (): { kind: 'confirm'; prompt: string; reason: string } => ({
      kind: 'confirm',
      prompt: 'Read auth.ts?',
      reason: 'test: matched confirm rule',
    });
    const r = await readSymbolTool.execute(
      { symbol: 'login' },
      makeCtx({ codeIndex: idx, cwd: root, permissionCheck: askConfirm }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('permission.denied');
    expect(r.details?.decision).toBe('confirm');
  });

  test('harness pre-call gate allows the tool (regression for #1)', () => {
    // Pre-fix, read_symbol was metadata.category='fs.read'.
    // The harness called engine.check('read_symbol', 'fs.read',
    // { symbol, file }) which routed to checkPath →
    // resolveFsTarget → null (no `args.path`) → deny. Tool
    // never ran. Post-fix, category='misc' lets the harness
    // pre-gate pass; the tool then self-gates against the
    // resolved path (covered by the deny test above).
    expect(readSymbolTool.metadata.category).toBe('misc');
    const eng = createPermissionEngine({ defaults: { mode: 'strict' }, tools: {} }, { cwd: root });
    // What the harness does pre-call. With category='misc', the
    // engine returns allow without needing a tool-specific rule.
    const decision = eng.check(readSymbolTool.name, readSymbolTool.metadata.category, {
      symbol: 'login',
    });
    expect(decision.kind).toBe('allow');
  });

  test('surfaces fs.read_failed when index references a missing file (stale index)', async () => {
    rmSync(join(root, 'src/auth.ts'));
    // Index still has the row; file is gone — surface stale-index hint.
    const r = await readSymbolTool.execute(
      { symbol: 'login' },
      makeCtx({ codeIndex: idx, cwd: root }),
    );
    expect(isToolError(r)).toBe(true);
    if (!isToolError(r)) return;
    expect(r.error_code).toBe('fs.read_failed');
    expect(r.error_message).toContain('agent --code-index scan');
  });
});
