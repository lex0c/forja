import { afterEach, describe, expect, test } from 'bun:test';
import { extractFromSource } from '../../src/code-index/scanner/extract.ts';
import { detectLanguage } from '../../src/code-index/scanner/language.ts';
import { __resetParserCacheForTests, parseSource } from '../../src/code-index/scanner/parser.ts';

// Slice 4.3.1.a tests: parser core. Cover language detection,
// parse + query roundtrip on real TS/JS fixtures, extraction
// produces expected IndexSymbol[] / Import[] structures.
// Walker, DB writes, CLI surface are slice 4.3.1.b/c.

afterEach(() => {
  // Caches are process-scoped by design; we don't reset between
  // tests except in the cache-isolation test below. Most cases
  // are robust to cache reuse.
});

describe('detectLanguage', () => {
  test('maps TS extensions correctly', () => {
    expect(detectLanguage('src/auth.ts')).toBe('typescript');
    expect(detectLanguage('src/auth.mts')).toBe('typescript');
    expect(detectLanguage('src/auth.cts')).toBe('typescript');
    expect(detectLanguage('src/auth.tsx')).toBe('tsx');
  });

  test('maps JS extensions correctly', () => {
    expect(detectLanguage('src/auth.js')).toBe('javascript');
    expect(detectLanguage('src/auth.jsx')).toBe('javascript');
    expect(detectLanguage('src/auth.mjs')).toBe('javascript');
    expect(detectLanguage('src/auth.cjs')).toBe('javascript');
  });

  test('case-insensitive on extension', () => {
    expect(detectLanguage('Auth.TS')).toBe('typescript');
    expect(detectLanguage('Component.TSX')).toBe('tsx');
  });

  test('returns null for unsupported extensions', () => {
    expect(detectLanguage('README.md')).toBeNull();
    expect(detectLanguage('config.toml')).toBeNull();
    expect(detectLanguage('script.py')).toBeNull();
    expect(detectLanguage('.env')).toBeNull();
    expect(detectLanguage('Makefile')).toBeNull();
  });

  test('returns null for files without extension', () => {
    expect(detectLanguage('Dockerfile')).toBeNull();
    expect(detectLanguage('LICENSE')).toBeNull();
  });
});

describe('extractFromSource — TypeScript', () => {
  test('top-level exported function', () => {
    const src = 'export function login(user: string): boolean { return true; }';
    const { symbols } = extractFromSource(src, 'typescript', 'src/auth.ts', parseSource);
    expect(symbols.length).toBe(1);
    expect(symbols[0]).toMatchObject({
      name: 'login',
      kind: 'function',
      visibility: 'export',
      filePath: 'src/auth.ts',
      fqn: 'src/auth.ts:login',
    });
    expect(symbols[0]?.signature).toContain('user: string');
    expect(symbols[0]?.signature).toContain('boolean');
  });

  test('non-exported function classifies as internal', () => {
    const src = 'function helper() { return 1; }';
    const { symbols } = extractFromSource(src, 'typescript', 'src/util.ts', parseSource);
    expect(symbols[0]?.visibility).toBe('internal');
  });

  test('class with methods + accessibility modifiers', () => {
    const src = `
      export class Auth {
        public login(): void {}
        private secret(): string { return ""; }
        check() { return false; }
      }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/auth.ts', parseSource);
    const classSym = symbols.find((s) => s.kind === 'class');
    expect(classSym?.name).toBe('Auth');
    expect(classSym?.visibility).toBe('export');
    const methods = symbols.filter((s) => s.kind === 'method');
    expect(methods.length).toBe(3);
    expect(methods.find((m) => m.name === 'login')?.visibility).toBe('public');
    expect(methods.find((m) => m.name === 'secret')?.visibility).toBe('private');
    // Bare method (no modifier) defaults to 'public' per TS semantics.
    expect(methods.find((m) => m.name === 'check')?.visibility).toBe('public');
  });

  test('method FQN includes class name', () => {
    const src = `
      class Auth {
        check(): boolean { return false; }
      }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/auth.ts', parseSource);
    const method = symbols.find((s) => s.kind === 'method' && s.name === 'check');
    expect(method?.fqn).toBe('src/auth.ts:Auth.check');
  });

  test('interface, type, enum declarations', () => {
    const src = `
      export interface User { id: string; }
      export type Token = string;
      export enum Status { Ok, Err }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/types.ts', parseSource);
    expect(symbols.find((s) => s.kind === 'interface')?.name).toBe('User');
    expect(symbols.find((s) => s.kind === 'type')?.name).toBe('Token');
    expect(symbols.find((s) => s.kind === 'enum')?.name).toBe('Status');
  });

  test('top-level const declarations', () => {
    const src = 'export const MAX = 3;\nconst LOCAL = 1;';
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    const consts = symbols.filter((s) => s.kind === 'const');
    expect(consts.length).toBe(2);
    expect(consts.find((c) => c.name === 'MAX')?.visibility).toBe('export');
    expect(consts.find((c) => c.name === 'LOCAL')?.visibility).toBe('internal');
  });

  test('top-level `let` declarations are excluded (const-only)', () => {
    // `lexical_declaration` covers both `const` and `let`; the
    // query filters via the anonymous "const" keyword token.
    // Module-level `let` bindings would be misclassified as
    // kind='const' if we captured every lexical_declaration, so
    // we drop them. `var` uses `variable_declaration` (a
    // different node type) and is already not captured.
    const src = `
      export const STABLE = 1;
      export let mutable = 2;
      let alsoMutable = 3;
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    const consts = symbols.filter((s) => s.kind === 'const');
    expect(consts.map((c) => c.name)).toEqual(['STABLE']);
  });

  test('multi-binding const expands to one symbol per binding', () => {
    const src = 'export const a = 1, b = 2;';
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    const consts = symbols.filter((s) => s.kind === 'const');
    expect(consts.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });

  test('destructuring patterns are skipped (not split into bindings)', () => {
    // Out of scope for v1 — `const { a } = obj` produces no
    // symbols because the name field is an object_pattern,
    // not an identifier. Documenting via test.
    const src = 'export const { a, b } = obj;';
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    expect(symbols.filter((s) => s.kind === 'const').length).toBe(0);
  });

  test('inner-function consts not indexed (module-scope only)', () => {
    const src = `
      function outer() {
        const INNER = 1;
        return INNER;
      }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    // Only the function itself should be a symbol; INNER is
    // function-scoped and not a top-level const.
    expect(symbols.filter((s) => s.kind === 'const').length).toBe(0);
    expect(symbols.filter((s) => s.kind === 'function').length).toBe(1);
  });

  test('nested function declarations are not indexed (module-scope only)', () => {
    // Anchoring `function_declaration` to `(program ...)` in
    // queries.ts: only `outer` makes it; `inner` is function-
    // scoped and should not pollute the index.
    const src = `
      export function outer() {
        function inner() { return 1; }
        return inner();
      }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    const fns = symbols.filter((s) => s.kind === 'function');
    expect(fns.map((f) => f.name)).toEqual(['outer']);
  });

  test('nested class declarations are not indexed (module-scope only)', () => {
    // Same scope rule as functions — nested class declarations
    // inside a method body don't make it. Critical: their
    // methods must also be excluded, otherwise we'd emit
    // orphan method symbols whose enclosing class isn't in
    // the index.
    const src = `
      export class Outer {
        run() {
          class Local {
            innerMethod() {}
          }
          return Local;
        }
      }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    const classes = symbols.filter((s) => s.kind === 'class');
    expect(classes.map((c) => c.name)).toEqual(['Outer']);
    const methods = symbols.filter((s) => s.kind === 'method');
    // Only `run` (Outer's method) is indexed; `innerMethod`
    // on the nested Local class is dropped along with Local.
    expect(methods.map((m) => m.name)).toEqual(['run']);
  });

  test('methods of function-local classes are not indexed', () => {
    // Pure function-scoped class — no enclosing top-level class
    // at all. Currently neither the class nor its methods may
    // appear in the index.
    const src = `
      export function build() {
        class Local {
          step() {}
          static helper() {}
        }
        return new Local();
      }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    expect(symbols.filter((s) => s.kind === 'class').length).toBe(0);
    expect(symbols.filter((s) => s.kind === 'method').length).toBe(0);
    expect(symbols.filter((s) => s.kind === 'function').map((f) => f.name)).toEqual(['build']);
  });

  test('static method visibility resolves via accessibility modifier', () => {
    // `static` alone (no accessibility modifier) defaults to
    // 'public'. `private static` resolves to 'private' via the
    // accessibility_modifier child — `static` doesn't shadow.
    const src = `
      export class Counter {
        static plain() {}
        private static secret() {}
      }
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    const plain = symbols.find((s) => s.kind === 'method' && s.name === 'plain');
    const secret = symbols.find((s) => s.kind === 'method' && s.name === 'secret');
    expect(plain?.visibility).toBe('public');
    expect(secret?.visibility).toBe('private');
  });

  test('start/end lines reflect 0-indexed tree-sitter rows', () => {
    const src = `
export function login() {
  return true;
}
`;
    const { symbols } = extractFromSource(src, 'typescript', 'src/c.ts', parseSource);
    // First newline is line 0; `export function` starts on line 1.
    expect(symbols[0]?.startLine).toBe(1);
    expect(symbols[0]?.endLine).toBe(3);
  });
});

describe('extractFromSource — Imports', () => {
  test('named imports', () => {
    const src = 'import { login, logout } from "./auth";';
    const { imports } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    expect(imports.length).toBe(1);
    expect(imports[0]).toMatchObject({
      targetModule: './auth',
      isExternal: false,
    });
    expect(imports[0]?.importedNames).toEqual(['login', 'logout']);
  });

  test('default import recorded as `default`', () => {
    const src = 'import React from "react";';
    const { imports } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    expect(imports[0]).toMatchObject({
      targetModule: 'react',
      isExternal: true,
    });
    expect(imports[0]?.importedNames).toEqual(['default']);
  });

  test('namespace import recorded as `*`', () => {
    const src = 'import * as ns from "./util";';
    const { imports } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    expect(imports[0]?.importedNames).toEqual(['*']);
  });

  test('side-effect-only import has empty names', () => {
    const src = 'import "./polyfill";';
    const { imports } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    expect(imports[0]).toMatchObject({
      targetModule: './polyfill',
      importedNames: [],
    });
  });

  test('mixed default + named import', () => {
    const src = 'import React, { useState } from "react";';
    const { imports } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    // Both bindings recorded.
    expect(imports[0]?.importedNames.sort()).toEqual(['default', 'useState']);
  });

  test('isExternal heuristic — relative vs bare specifier', () => {
    const cases: { src: string; external: boolean }[] = [
      { src: 'import "./local";', external: false },
      { src: 'import "../sibling";', external: false },
      { src: 'import "/absolute";', external: false },
      { src: 'import "react";', external: true },
      { src: 'import "@scope/pkg";', external: true },
      { src: 'import "node:fs";', external: true },
    ];
    for (const c of cases) {
      const { imports } = extractFromSource(c.src, 'typescript', 'src/x.ts', parseSource);
      expect(imports[0]?.isExternal).toBe(c.external);
    }
  });

  test('aliased imports use the source export name', () => {
    // import_specifier has `name` (source) and optional `alias`
    // (local). The audit records the source name — what
    // cross-file resolution matches against.
    const src = 'import { login as signIn } from "./auth";';
    const { imports } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    expect(imports[0]?.importedNames).toEqual(['login']);
  });

  test('type-only imports (`import type { X }`) extract names', () => {
    // TS `import type` produces an import_statement whose
    // import_clause carries a `type` keyword. The named_imports
    // shape inside is unchanged, so the extractor still pulls
    // the name(s). The fact that the import is type-only is
    // not currently surfaced (could be a future field on
    // `Import`); this test pins the current behavior.
    const src = 'import type { User } from "./types";';
    const { imports } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    expect(imports[0]).toMatchObject({
      targetModule: './types',
      isExternal: false,
    });
    expect(imports[0]?.importedNames).toEqual(['User']);
  });
});

describe('extractFromSource — JavaScript', () => {
  test('JS function + class + const without TS-only kinds', () => {
    const src = `
      export function login() {}
      export class Auth { check() {} }
      export const MAX = 3;
      import { foo } from "./bar";
    `;
    const { symbols, imports } = extractFromSource(src, 'javascript', 'src/auth.js', parseSource);
    expect(symbols.find((s) => s.kind === 'function')?.name).toBe('login');
    expect(symbols.find((s) => s.kind === 'class')?.name).toBe('Auth');
    expect(symbols.find((s) => s.kind === 'method')?.name).toBe('check');
    expect(symbols.find((s) => s.kind === 'const')?.name).toBe('MAX');
    // No interface/type/enum in JS.
    expect(symbols.find((s) => s.kind === 'interface')).toBeUndefined();
    expect(symbols.find((s) => s.kind === 'type')).toBeUndefined();
    expect(imports.length).toBe(1);
  });
});

describe('extractFromSource — TSX', () => {
  test('TSX parses JSX-bearing component definitions', () => {
    const src = `
      export function Button(props: { label: string }) {
        return <button>{props.label}</button>;
      }
    `;
    const { symbols } = extractFromSource(src, 'tsx', 'src/Button.tsx', parseSource);
    expect(symbols.length).toBe(1);
    expect(symbols[0]).toMatchObject({
      name: 'Button',
      kind: 'function',
      visibility: 'export',
    });
  });
});

describe('extractFromSource — invalid syntax', () => {
  test('partial parse yields what it can (best-effort)', () => {
    // tree-sitter is permissive: invalid syntax emits ERROR
    // nodes but valid constructs BEFORE the breakage still
    // extract. Constructs after may or may not survive
    // depending on how far the recovery skips. We assert the
    // weak property: at least the pre-error `ok` function
    // makes it. Constructs after the breakage are best-effort
    // — if they appear too, fine; if not, no regression.
    const src = `
      export function ok() {}
      export class Broken { ## invalid ##
      export function maybeRecovered() {}
    `;
    const { symbols } = extractFromSource(src, 'typescript', 'src/x.ts', parseSource);
    const fns = symbols.filter((s) => s.kind === 'function');
    expect(fns.map((f) => f.name)).toContain('ok');
  });
});

describe('parser cache', () => {
  test('parserCache reuse — second parse of same language is fast and correct', () => {
    const src1 = 'export function a() {}';
    const src2 = 'export function b() {}';
    const r1 = extractFromSource(src1, 'typescript', 'a.ts', parseSource);
    const r2 = extractFromSource(src2, 'typescript', 'b.ts', parseSource);
    expect(r1.symbols[0]?.name).toBe('a');
    expect(r2.symbols[0]?.name).toBe('b');
  });

  test('cache reset cleanly re-initializes parser + queries', () => {
    extractFromSource('export function a() {}', 'typescript', 'a.ts', parseSource);
    __resetParserCacheForTests();
    const r = extractFromSource('export function b() {}', 'typescript', 'b.ts', parseSource);
    expect(r.symbols[0]?.name).toBe('b');
  });
});
