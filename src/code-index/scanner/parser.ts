// Parser surface — wraps `tree-sitter` native bindings into a
// per-language cached interface. Slice 4.3.1.a uses this only
// for synchronous parse + query; the scanner pipeline (4.3.1.b)
// will call `parseSource` per file walked from disk.
//
// Parser instances are reused per language: tree-sitter parsers
// are lightweight but do hold internal allocators; reusing
// avoids the per-parse setup cost (a few hundred microseconds
// adds up over thousand-file scans). The cache is process-
// scoped — released only when the process exits.
//
// Query objects are also cached per (language, query-source)
// tuple. Compiling an S-expression query is non-trivial
// (~1-5ms for a moderately-complex query), and we run the same
// query across every file in a scan, so caching is worthwhile.

import { createRequire } from 'node:module';
import { type SupportedLanguage, getGrammar } from './language.ts';

const require = createRequire(import.meta.url);

// `tree-sitter` is CommonJS; we lazy-require to defer the
// native binding load until first parse. Callers that only
// touch the Query API skeleton from slice 4.3.0 don't need
// this module.
// Tree-sitter's native module exports a Parser constructor +
// Query class. The native types aren't fully expressible in
// TS without `any` for the parser instances (they expose
// dozens of methods we don't need to enumerate). We type the
// MODULE shape with `unknown` returns and cast at the few
// call sites where a concrete shape matters.
type TreeSitterModule = {
  new (): unknown;
  Query: new (lang: unknown, source: string) => unknown;
};

let cachedTreeSitter: TreeSitterModule | null = null;

const treeSitter = (): TreeSitterModule => {
  if (cachedTreeSitter !== null) return cachedTreeSitter;
  cachedTreeSitter = require('tree-sitter') as TreeSitterModule;
  return cachedTreeSitter;
};

// Minimal structural types for the parser/query instances we
// actually call. The native module exposes much more; we
// declare only what we touch. Cast at construction.
//
// `parse` accepts either a raw string OR a chunking callback.
// We use the callback form because the native binding's
// string overload bails with "Invalid argument" on inputs
// larger than ~32 KiB — a hard limit not obviously documented.
// The callback form streams the source in chunks and has no
// such limit.
type ParserInstance = {
  setLanguage(lang: unknown): void;
  parse(input: string | ((index: number) => string)): unknown;
};

// Parser cache per language. Reusing avoids per-parse setup
// cost (roughly 100-500µs per cold parse vs ~50µs warm).
const parserCache = new Map<SupportedLanguage, ParserInstance>();

const getParser = (language: SupportedLanguage): ParserInstance => {
  const cached = parserCache.get(language);
  if (cached !== undefined) return cached;
  const Parser = treeSitter();
  const parser = new Parser() as ParserInstance;
  parser.setLanguage(getGrammar(language));
  parserCache.set(language, parser);
  return parser;
};

// Parse a source string into a tree-sitter Tree. Returns the
// rootNode-bearing object the rest of the pipeline (queries,
// extraction) operates on. Caller MUST keep the source string
// alive while the tree is in use — node.text fields slice from
// the original string.
//
// Errors during parse don't throw. Tree-sitter is permissive:
// invalid syntax produces a tree with `ERROR` nodes scattered
// at the broken positions. Caller (the scanner) decides whether
// to flag the file `partial`/`failed` based on `tree.rootNode.hasError`.
//
// Returns `unknown` because the native Tree shape has dozens
// of methods we don't enumerate; consumers (extract.ts) cast
// via the local `SyntaxNode = any` alias when walking nodes.
// Chunk size for the function-form parse callback, measured in
// JS string units (UTF-16 code units, NOT bytes — for ASCII
// source the two coincide; for non-BMP characters they diverge).
// 4 KiB amortizes JS↔native round-trips while staying
// comfortably under any per-call buffer limit. Tree-sitter
// stitches chunks internally and doesn't care about the
// boundary, EXCEPT that we must not split a UTF-16 surrogate
// pair: high+low halves of one Unicode code point need to
// arrive together or the UTF-8 encoding crossing the native
// boundary would corrupt that character.
const PARSE_CHUNK_SIZE = 4096;

export const parseSource = (source: string, language: SupportedLanguage): unknown => {
  const parser = getParser(language);
  // Function-form input: avoids the ~32 KiB string-overload
  // limit in the native binding (`Invalid argument` thrown by
  // larger files like 35 KiB+ source modules).
  return parser.parse((index: number) => {
    if (index >= source.length) return '';
    let end = Math.min(index + PARSE_CHUNK_SIZE, source.length);
    // Don't split a surrogate pair across chunks. If the last
    // code unit of the chunk is a high surrogate (0xD800-0xDBFF),
    // extend by one so its trailing low surrogate joins it.
    const lastCode = source.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff && end < source.length) {
      end += 1;
    }
    return source.slice(index, end);
  });
};

// Query cache. Key: `${language}::${querySource}`. Tree-sitter
// Query objects are bound to a specific Language AND a query
// source string; mixing them across languages produces a
// runtime error inside the native binding. Composite keying
// keeps lookups fast (Map operations are O(1)) and prevents
// accidental cross-language reuse.
const queryCache = new Map<string, unknown>();

export const compileQuery = (language: SupportedLanguage, source: string): unknown => {
  const key = `${language}::${source}`;
  const cached = queryCache.get(key);
  if (cached !== undefined) return cached;
  const Parser = treeSitter();
  const grammar = getGrammar(language);
  const query = new Parser.Query(grammar, source);
  queryCache.set(key, query);
  return query;
};

// Reset all caches. Test seam — production shouldn't call this;
// the caches survive the process. Tests that want a clean
// state (e.g., to verify parser reinit doesn't corrupt) can
// invoke before each case.
export const __resetParserCacheForTests = (): void => {
  parserCache.clear();
  queryCache.clear();
  cachedTreeSitter = null;
};
