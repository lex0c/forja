// Tree-sitter S-expression queries for symbol + import
// extraction. Per-language strings; the parser module compiles
// + caches them once per process.
//
// Strategy: queries are deliberately simple — they identify
// the high-level construct (function, class, method, etc.)
// and capture its definition node as `@symbol.def`. The
// extractor then walks the captured node to pull out the name,
// signature, line range, visibility (via parent type), and
// parent symbol (for methods inside classes). This keeps the
// query strings readable AND moves grammar-specific quirks
// into the extractor where they're easier to test.
//
// Capture name conventions:
//   @symbol.fn       — function_declaration
//   @symbol.class    — class_declaration
//   @symbol.method   — method_definition (inside class_body)
//   @symbol.iface    — interface_declaration (TS only)
//   @symbol.type     — type_alias_declaration (TS only)
//   @symbol.enum     — enum_declaration (TS only)
//   @symbol.const    — lexical_declaration with `const`
//   @import.stmt     — import_statement (extractor walks for names + source)
//   @import.require  — `require('module')` call_expression (CJS interop)

// ---------- TypeScript ----------

// All declaration captures are anchored to `(program ...)` —
// either bare or wrapped in `export_statement`. The index is
// strictly module-level: a function/class/const declared inside
// another function or block is intentionally NOT captured.
// Methods are the one exception: anchored to `class_body`, so
// only class methods make it (object-literal shorthand methods
// produce `method_definition` too in some grammars; restricting
// to class_body excludes them).
//
// The tree-sitter Query parser is whitespace-tolerant; the
// leading newline + indentation are cosmetic.
export const TS_QUERY = `
(program (function_declaration) @symbol.fn)
(program (export_statement (function_declaration) @symbol.fn))

(program (class_declaration) @symbol.class)
(program (export_statement (class_declaration) @symbol.class))

;; Methods must trace a direct path from program through a
;; top-level class_declaration to satisfy module-level scope.
;; Anchoring on class_body alone would also match classes
;; nested inside function bodies / other local scopes — those
;; class declarations are filtered out at the class capture, so
;; their methods would surface as orphans.
(program (class_declaration (class_body (method_definition) @symbol.method)))
(program (export_statement (class_declaration (class_body (method_definition) @symbol.method))))

(program (interface_declaration) @symbol.iface)
(program (export_statement (interface_declaration) @symbol.iface))

(program (type_alias_declaration) @symbol.type)
(program (export_statement (type_alias_declaration) @symbol.type))

(program (enum_declaration) @symbol.enum)
(program (export_statement (enum_declaration) @symbol.enum))

;; lexical_declaration covers both 'const' and 'let'; we only
;; emit symbols for const (the extractor labels them
;; kind='const'). Anchoring on the anonymous "const" keyword
;; token filters out 'let' bindings — only const declarations
;; carry that token in this position.
(program (lexical_declaration "const") @symbol.const)
(program (export_statement (lexical_declaration "const") @symbol.const))

(import_statement) @import.stmt

;; CommonJS interop: capture every call_expression whose
;; function identifier is "require". Unscoped (matches anywhere
;; in the program — lazy-load require inside functions is a
;; real CJS pattern and a real edge in the import graph). The
;; #eq? predicate keeps the match cost bounded; without it,
;; every call_expression in the file would match and the
;; extractor would have to filter every one. The extractor
;; ALSO checks function.text === "require" defensively in case
;; a tree-sitter binding silently ignores predicates.
((call_expression
  function: (identifier) @_fn
  arguments: (arguments . (string)))
 (#eq? @_fn "require")) @import.require
`;

// TSX (JSX-augmented TypeScript) shares every relevant
// declaration kind with TypeScript proper. The grammars are
// distinct because parsing rules differ on `<` (type arg vs
// JSX element), but the AST node types we care about are the
// same. Reusing the TS query is correct.
export const TSX_QUERY = TS_QUERY;

// ---------- JavaScript ----------

// JS lacks `interface`, `type`, and `enum` declarations. The
// rest mirrors TS — same module-level anchoring.
export const JS_QUERY = `
(program (function_declaration) @symbol.fn)
(program (export_statement (function_declaration) @symbol.fn))

(program (class_declaration) @symbol.class)
(program (export_statement (class_declaration) @symbol.class))

;; Methods anchored at module scope — see TS_QUERY for rationale.
(program (class_declaration (class_body (method_definition) @symbol.method)))
(program (export_statement (class_declaration (class_body (method_definition) @symbol.method))))

;; const-only — see TS_QUERY for rationale.
(program (lexical_declaration "const") @symbol.const)
(program (export_statement (lexical_declaration "const") @symbol.const))

(import_statement) @import.stmt

;; CJS require — see TS_QUERY for rationale.
((call_expression
  function: (identifier) @_fn
  arguments: (arguments . (string)))
 (#eq? @_fn "require")) @import.require
`;

import type { SupportedLanguage } from './language.ts';

export const queryFor = (language: SupportedLanguage): string => {
  switch (language) {
    case 'typescript':
      return TS_QUERY;
    case 'tsx':
      return TSX_QUERY;
    case 'javascript':
      return JS_QUERY;
  }
};
