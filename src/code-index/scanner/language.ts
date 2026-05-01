// Language detection + grammar registry. Maps file paths /
// extensions to a logical language name AND the tree-sitter
// grammar object the parser binds to.
//
// Scope of slice 4.3.1.a: TypeScript (.ts/.mts/.cts), TSX
// (.tsx), and JavaScript (.js/.jsx/.mjs/.cjs). Spec §1.3 lists
// Python/Go/Rust/Java/etc. for v1, but each grammar adds
// install weight (~200KB-1MB native binary) and a parser-init
// cost. Ship TS/JS first; expand per-grammar in slice 4.3.4.
//
// Native deps: `tree-sitter-typescript` exports `{ typescript,
// tsx }`; `tree-sitter-javascript` exports the JS grammar
// directly (default export). Both are CommonJS, so we
// `createRequire` from this ESM module.

import { createRequire } from 'node:module';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);

// Lazy import to avoid loading native bindings at module init —
// the storage repos and Query API skeleton (slice 4.3.0) don't
// need the parser, and tests that don't touch the scanner
// shouldn't pay the load cost.
//
// Grammar objects are opaque to us (the parser binding consumes
// them by reference); typing as `unknown` keeps callers honest
// about the shape they cannot inspect.

let cachedGrammars: { typescript: unknown; tsx: unknown; javascript: unknown } | null = null;

const loadGrammars = (): {
  typescript: unknown;
  tsx: unknown;
  javascript: unknown;
} => {
  if (cachedGrammars !== null) return cachedGrammars;
  // CommonJS imports — the packages ship `bindings/node` as
  // their main, which loads the prebuilt .node binary for the
  // current platform.
  const ts = require('tree-sitter-typescript');
  const js = require('tree-sitter-javascript');
  cachedGrammars = {
    typescript: ts.typescript,
    tsx: ts.tsx,
    javascript: js,
  };
  return cachedGrammars;
};

// Logical language names follow the spec §2.1 enum convention
// — lowercase, hyphen-free. The `languages.language` column in
// the `files` table stores these strings literally.
export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript';

// Map an absolute or relative path to a supported language, or
// null when the file's extension isn't covered by the v1
// grammars. Caller (the scanner walker) drops null-language
// files from the indexable set — no fallback to regex
// (CODE_INDEX.md §0 princípio 4: "Per-language, sem fallback
// de regex").
//
// Extension is the only signal in slice 4.3.1.a. Shebang sniffing
// (e.g. `#!/usr/bin/env python` for `script` files without
// `.py` extension) is deferred — the typical TS/JS project
// always uses extensions.
export const detectLanguage = (path: string): SupportedLanguage | null => {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    default:
      return null;
  }
};

// Resolve the tree-sitter grammar object for a given logical
// language name. Throws on unknown names — callers should pre-
// filter via `detectLanguage` so we never hit that path.
export const getGrammar = (language: SupportedLanguage): unknown => {
  const grammars = loadGrammars();
  switch (language) {
    case 'typescript':
      return grammars.typescript;
    case 'tsx':
      return grammars.tsx;
    case 'javascript':
      return grammars.javascript;
  }
};
