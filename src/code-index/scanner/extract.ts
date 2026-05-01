// Extract `IndexSymbol[]` and `Import[]` from a parsed
// tree-sitter Tree. The queries module identifies high-level
// constructs and captures their definition nodes; this module
// walks each captured node to pull the name, signature, and
// position into the domain types.
//
// Strategy choice (see queries.ts header): keep the query
// strings simple — capture the def node, do node-walking
// here. Trade-off: slightly more JS code, but query strings
// are far more readable AND grammar-specific extraction
// quirks (e.g. method visibility via accessibility_modifier
// child) live in one place where they're easy to test.
//
// Visibility rules:
//   - Top-level decl wrapped in `export_statement` → 'export'
//   - Method with `accessibility_modifier` child → that modifier
//     ('public' / 'private' / etc.). Bare TS methods default
//     to 'public' in the language; we surface that explicitly.
//   - Otherwise → 'internal' (top-level, not exported) or
//     'unknown' (we couldn't classify, e.g. const inside an
//     export-from re-export).

import type { Import, IndexSymbol, SymbolKind, SymbolVisibility } from '../types.ts';
import type { SupportedLanguage } from './language.ts';
import { compileQuery } from './parser.ts';
import { queryFor } from './queries.ts';

// Structural view of the tree-sitter native node API — only
// the fields/methods this module actually touches. Avoids `any`
// while staying decoupled from the upstream type surface.
// Fields are declared optional so the type tolerates the (rare)
// case where a future grammar version emits an exotic node that
// doesn't expose the full method set; defensive `?? []` and
// `typeof ... === 'function'` checks below stay meaningful.
interface SyntaxNode {
  type: string;
  text: string;
  parent: SyntaxNode | null;
  namedChildren?: SyntaxNode[];
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childForFieldName?: (name: string) => SyntaxNode | null;
}

export interface ExtractResult {
  symbols: Omit<IndexSymbol, 'id'>[];
  imports: Omit<Import, 'id' | 'sourceFile' | 'targetPath'>[];
}

// Build a fully-qualified name for a method by joining its
// enclosing class name. `<file>:Class.method`. Only one level
// of nesting — TS allows nested classes but they're rare and
// the FQN can resolve via parent_symbol_id chains downstream.
const buildFqn = (filePath: string, parentName: string | null, name: string): string =>
  parentName !== null ? `${filePath}:${parentName}.${name}` : `${filePath}:${name}`;

// Find a named child by field name. tree-sitter exposes
// `childForFieldName` which returns the node bound to a named
// field in the grammar. Returns null when the field is absent
// — common for anonymous functions etc.
const fieldNode = (node: SyntaxNode, fieldName: string): SyntaxNode | null => {
  if (typeof node.childForFieldName === 'function') {
    const child = node.childForFieldName(fieldName);
    return child === null ? null : child;
  }
  return null;
};

// Visibility resolution. Three signals are checked, in order:
//   1. Method accessibility modifiers (TS-only) → public/private/etc
//   2. Direct `export_statement` parent (e.g. `export function foo`)
//   3. Named-export clauses elsewhere in the program — e.g.
//      `function foo() {}` ... `export { foo }` — collected ahead
//      of time and passed in as `exportedNames`. Re-exports of
//      the form `export { x } from "./other"` do NOT contribute,
//      since their `x` refers to a foreign module's binding, not
//      a local symbol.
//
// Methods don't appear in named-export clauses (you can only
// export top-level bindings), so `symbolName` and `exportedNames`
// are unused on the method path.
const resolveVisibility = (
  defNode: SyntaxNode,
  symbolName: string | null,
  exportedNames: ReadonlySet<string>,
): SymbolVisibility => {
  if (defNode.type === 'method_definition' || defNode.type === 'public_field_definition') {
    for (const child of defNode.namedChildren ?? []) {
      if (child.type === 'accessibility_modifier') {
        const text = child.text;
        if (text === 'public' || text === 'private') return text;
        if (text === 'protected') return 'internal';
      }
    }
    // ECMAScript hash-private methods (`#secret()`) carry no
    // accessibility_modifier — privacy is conveyed syntactically
    // through a `private_property_identifier` name node. Detect
    // by inspecting the `name` field's type.
    const nameNode = fieldNode(defNode, 'name');
    if (nameNode !== null && nameNode.type === 'private_property_identifier') {
      return 'private';
    }
    return 'public';
  }
  if (defNode.parent !== null && defNode.parent.type === 'export_statement') {
    return 'export';
  }
  if (symbolName !== null && exportedNames.has(symbolName)) {
    return 'export';
  }
  return 'internal';
};

// Pre-scan the program for top-level export statements that
// re-name local symbols, and collect the local identifiers they
// expose. Two forms are covered:
//
//   1. `export { foo, bar as baz }` — named export clauses.
//      The LOCAL identifier (the `name` field of each
//      export_specifier) is what flips to 'export'; `baz` is
//      a foreign-facing alias and isn't a local symbol.
//
//   2. `export default foo` (and `export = foo`) — default
//      exports of an existing identifier. The export_statement
//      has the identifier as a direct named child rather than
//      wrapping a declaration. Declarations exported inline
//      (`export default function foo() {}`) are already handled
//      by the wrapped-parent check in resolveVisibility, so we
//      do NOT need to revisit declaration children here.
//
// Re-exports with a `source` field (`export { x } from "./other"`)
// are skipped — their names refer to a foreign module's
// exports, not local symbols.
const collectLocalExportedNames = (root: SyntaxNode): Set<string> => {
  const names = new Set<string>();
  for (const child of root.namedChildren ?? []) {
    if (child.type !== 'export_statement') continue;
    if (fieldNode(child, 'source') !== null) continue;
    for (const inner of child.namedChildren ?? []) {
      if (inner.type === 'export_clause') {
        for (const spec of inner.namedChildren ?? []) {
          if (spec.type !== 'export_specifier') continue;
          const localName = fieldNode(spec, 'name');
          if (localName !== null) names.add(localName.text);
        }
      } else if (inner.type === 'identifier') {
        // `export default foo` / `export = foo` — direct
        // identifier reference. Inline declarations
        // (`export default function foo() {}`) appear as
        // function_declaration / class_declaration children
        // and don't take this branch; they're picked up via
        // the `defNode.parent.type === 'export_statement'`
        // check in resolveVisibility.
        names.add(inner.text);
      }
    }
  }
  return names;
};

// Build a compact one-line signature for a function/method.
// Source text minus the body. Truncates at 200 chars to keep
// the column bounded — very long signatures with massive
// generics get a `…` suffix and full text is recoverable via
// `read_file` (slice 4.3.2's read_symbol tool falls back when
// signature is truncated).
const buildSignature = (node: SyntaxNode): string | null => {
  const params = fieldNode(node, 'parameters');
  const returnType = fieldNode(node, 'return_type');
  if (params === null) return null;
  const sig = `${params.text}${returnType !== null ? returnType.text : ''}`
    .replace(/\s+/g, ' ')
    .trim();
  if (sig.length > 200) return `${sig.slice(0, 199)}…`;
  return sig;
};

// Map capture name to symbol kind. The name field is `name`
// for every kind below; const declarations follow a separate
// path (see `extractConstSymbols`) because they expand into
// multiple symbols per declaration.
const symbolDescriptor: Record<string, { kind: SymbolKind }> = {
  'symbol.fn': { kind: 'function' },
  'symbol.class': { kind: 'class' },
  'symbol.method': { kind: 'method' },
  'symbol.iface': { kind: 'interface' },
  'symbol.type': { kind: 'type' },
  'symbol.enum': { kind: 'enum' },
};

// Walk up to find an enclosing class declaration. Used to
// stamp method symbols with their parent class name (for FQN
// + the future parent_symbol_id link). Returns the class's
// type_identifier text or null when the method is not inside
// a class (rare — orphan method_definition can appear in
// object literal shorthand for some grammars).
const enclosingClassName = (node: SyntaxNode): string | null => {
  let cur = node.parent;
  while (cur !== null) {
    if (cur.type === 'class_declaration') {
      const nameNode = fieldNode(cur, 'name');
      return nameNode !== null ? nameNode.text : null;
    }
    cur = cur.parent;
  }
  return null;
};

// Special case for `lexical_declaration` (const/let). The
// query captures the lexical_declaration node, but the actual
// "name" lives in each child `variable_declarator`. A single
// `const a = 1, b = 2;` declares two symbols. We expand here.
//
// Visibility is resolved per-binding, not per-declaration: in
// `const a = 1, b = 2;` followed by `export { a }`, only `a`
// is exported. The wrapped-export case (`export const x = 1`)
// applies to every binding in the same declaration.
const extractConstSymbols = (
  defNode: SyntaxNode,
  filePath: string,
  exportedNames: ReadonlySet<string>,
): Omit<IndexSymbol, 'id'>[] => {
  const out: Omit<IndexSymbol, 'id'>[] = [];
  for (const child of defNode.namedChildren ?? []) {
    if (child.type !== 'variable_declarator') continue;
    const nameNode = fieldNode(child, 'name');
    if (nameNode === null) continue;
    // Skip destructuring patterns (`const { a } = obj`) — the
    // `name` field on those is an object_pattern / array_pattern,
    // not an identifier. Could expand to capture each binding,
    // but rare at module scope and adds complexity. Spec §1.1
    // says symbols = top-level constants; skipping pattern
    // bindings is acceptable for v1.
    if (nameNode.type !== 'identifier') continue;
    const visibility = resolveVisibility(defNode, nameNode.text, exportedNames);
    // Position uses the variable_declarator span (the binding
    // itself) rather than the enclosing lexical_declaration,
    // so multi-binding declarations like `const a = 1, b = 2`
    // produce distinct coordinates per symbol — otherwise both
    // would share the whole-statement range and "go to symbol"
    // navigation would always jump to the first binding.
    out.push({
      filePath,
      name: nameNode.text,
      fqn: buildFqn(filePath, null, nameNode.text),
      kind: 'const',
      visibility,
      signature: null,
      startLine: child.startPosition.row,
      startCol: child.startPosition.column,
      endLine: child.endPosition.row,
      endCol: child.endPosition.column,
      parentSymbolId: null,
    });
  }
  return out;
};

// Extract one IndexSymbol from a non-const def node. Returns
// null when the name is missing (e.g., anonymous function
// expression — shouldn't appear in our queries since we only
// match `function_declaration`, but defensive).
const extractGenericSymbol = (
  captureName: string,
  defNode: SyntaxNode,
  filePath: string,
  exportedNames: ReadonlySet<string>,
): Omit<IndexSymbol, 'id'> | null => {
  const desc = symbolDescriptor[captureName];
  if (desc === undefined) return null;
  const nameNode = fieldNode(defNode, 'name');
  if (nameNode === null) return null;
  const parentClassName = desc.kind === 'method' ? enclosingClassName(defNode) : null;
  const visibility = resolveVisibility(defNode, nameNode.text, exportedNames);
  const signature =
    desc.kind === 'function' || desc.kind === 'method' ? buildSignature(defNode) : null;
  return {
    filePath,
    name: nameNode.text,
    fqn: buildFqn(filePath, parentClassName, nameNode.text),
    kind: desc.kind,
    visibility,
    signature,
    startLine: defNode.startPosition.row,
    startCol: defNode.startPosition.column,
    endLine: defNode.endPosition.row,
    endCol: defNode.endPosition.column,
    parentSymbolId: null,
  };
};

// Extract the import structure from an `import_statement`
// node. Tree-sitter's import_statement has:
//   - `source` field → string node containing the module specifier
//   - 0 or 1 `import_clause` children covering one of:
//     - named_imports → `{ a, b as c }`
//     - namespace_import → `* as ns`
//     - identifier (default) → `defaultName`
//   - or no clause → side-effect-only `import "x"`
const extractImport = (
  defNode: SyntaxNode,
): Omit<Import, 'id' | 'sourceFile' | 'targetPath'> | null => {
  const sourceNode = fieldNode(defNode, 'source');
  if (sourceNode === null) return null;
  // The string node has a `string_fragment` child with the
  // raw module text (without quotes).
  let targetModule: string | null = null;
  for (const child of sourceNode.namedChildren ?? []) {
    if (child.type === 'string_fragment') {
      targetModule = child.text;
      break;
    }
  }
  if (targetModule === null) return null;

  const importedNames: string[] = [];
  // Walk import_clause for the imported binding shapes.
  for (const child of defNode.namedChildren ?? []) {
    if (child.type !== 'import_clause') continue;
    for (const inner of child.namedChildren ?? []) {
      if (inner.type === 'identifier') {
        // Default import: `import foo from "bar"`
        importedNames.push('default');
      } else if (inner.type === 'namespace_import') {
        // Namespace import: `import * as ns from "bar"` —
        // record as '*' (the canonical sigil) per spec §2.1.
        importedNames.push('*');
      } else if (inner.type === 'named_imports') {
        for (const spec of inner.namedChildren ?? []) {
          if (spec.type !== 'import_specifier') continue;
          // import_specifier has a `name` field (the source
          // export name) and optionally an `alias` field
          // (the local binding). For the audit, we record the
          // source export name — that's what cross-file
          // resolution will match against.
          const nameNode = fieldNode(spec, 'name');
          if (nameNode !== null) importedNames.push(nameNode.text);
        }
      }
    }
  }

  // External-vs-local heuristic: relative paths (`.`/`..`) are
  // local; everything else (`react`, `@scope/pkg`,
  // `node:fs`) is external. Path resolution to a concrete
  // file (`./auth` → `src/auth.ts`) is the import resolver's
  // job in slice 4.3.3 — for now we record the raw spec.
  const isExternal = !(
    targetModule.startsWith('./') ||
    targetModule.startsWith('../') ||
    targetModule.startsWith('/')
  );

  return {
    targetModule,
    importedNames,
    isExternal,
  };
};

// Public surface: parse the source, run the language's query,
// extract structured symbols + imports. Caller (the scanner
// pipeline in slice 4.3.1.b) provides the project-relative
// `filePath` since it's threaded into every output row.
//
// `parseFn` returns `unknown` (tree-sitter's Tree shape isn't
// enumerated in our typings); we cast to a minimal structural
// view of what we touch — `rootNode` is the only field we
// pull out, and the query runs against its node-shape.
type TreeShape = { rootNode: SyntaxNode };
type QueryShape = {
  matches(node: SyntaxNode): { captures: { name: string; node: SyntaxNode }[] }[];
};

export const extractFromSource = (
  source: string,
  language: SupportedLanguage,
  filePath: string,
  parseFn: (src: string, lang: SupportedLanguage) => unknown,
): ExtractResult => {
  const tree = parseFn(source, language) as TreeShape;
  const query = compileQuery(language, queryFor(language)) as QueryShape;
  const matches = query.matches(tree.rootNode);
  // Pre-scan once per file: list of names that appear in
  // top-level `export { ... }` clauses. Used by
  // `resolveVisibility` to flip otherwise-internal symbols to
  // 'export' when they're re-exported by name.
  const exportedNames = collectLocalExportedNames(tree.rootNode);

  const symbols: Omit<IndexSymbol, 'id'>[] = [];
  const imports: Omit<Import, 'id' | 'sourceFile' | 'targetPath'>[] = [];

  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === 'symbol.const') {
        symbols.push(...extractConstSymbols(capture.node, filePath, exportedNames));
      } else if (capture.name === 'import.stmt') {
        const imp = extractImport(capture.node);
        if (imp !== null) imports.push(imp);
      } else if (capture.name in symbolDescriptor) {
        const sym = extractGenericSymbol(capture.name, capture.node, filePath, exportedNames);
        if (sym !== null) symbols.push(sym);
      }
    }
  }

  return { symbols, imports };
};
