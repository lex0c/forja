// Bash AST entry-point for the permission engine. Wraps
// `web-tree-sitter` + the `tree-sitter-bash` grammar (vendored at
// `src/permissions/grammars/tree-sitter-bash.wasm`) into a
// synchronous parse interface backed by an async one-time init.
//
// Design per `docs/spec/TREE_SITTER.md` and
// `docs/spec/TREE_SITTER_SHELL.md`:
//
//   1. Tree-sitter is the entry-point, NOT the authority. The
//      resolver walks the AST against a whitelist of nodes; anything
//      outside the whitelist is `Refuse` with a specific reason
//      (`TREE_SITTER_SHELL.md §9`).
//   2. Init is async (Wasm runtime + grammar load), parse is sync
//      after init. Bootstrap (`bootstrapPermissionEngine`) calls
//      `initBashParser()` once during the `validating-chain` phase;
//      `engine.check()` stays synchronous because the parser is
//      already warm.
//   3. Grammar wasm is vendored in-tree, not fetched at runtime.
//      The release pipeline (`bun build --compile`) embeds it
//      deterministically via Bun's `import … with { type: 'file' }`
//      attribute: the import resolves to a runtime path that points
//      at the on-disk file in dev mode and at the embedded asset in
//      compiled binaries. `Bun.file(path).bytes()` reads either case
//      without branching, so the same code path is used in dev and
//      release. No `node:fs` / `fileURLToPath` shenanigans.

import { Language, Parser } from 'web-tree-sitter';
// The web-tree-sitter package ships an emscripten-built engine
// wasm next to its JS entry; the runtime loader resolves it via
// `import.meta.url + 'web-tree-sitter.wasm'`. Under `bun build
// --compile`, the package's JS gets bundled into the binary but
// the wasm sibling is NOT auto-embedded — the import here forces
// Bun to register it as an asset and rewrite the path to point at
// the embedded `/$bunfs/root/...` location. Without this, the
// compiled binary aborts at `Parser.init()` with
// `ENOENT: /$bunfs/root/web-tree-sitter.wasm`.
import engineWasmPath from 'web-tree-sitter/web-tree-sitter.wasm' with { type: 'file' };
import wasmFilePath from './grammars/tree-sitter-bash.wasm' with { type: 'file' };

let cachedParser: Parser | null = null;
let initInFlight: Promise<Parser> | null = null;

// One-time async setup. Idempotent: parallel callers receive the
// same in-flight promise; subsequent calls after success return
// the cached parser without re-loading the wasm. Tests can pass
// `wasmBytes` directly to bypass the filesystem lookup (e.g. when
// running under an in-memory fs).
export interface InitBashParserOptions {
  wasmBytes?: Uint8Array;
}

export const initBashParser = async (options: InitBashParserOptions = {}): Promise<Parser> => {
  if (cachedParser !== null) return cachedParser;
  if (initInFlight !== null) return initInFlight;
  initInFlight = (async () => {
    // `locateFile` tells emscripten where to read the engine wasm
    // from. In dev / test (running under `bun run`), `engineWasmPath`
    // resolves to the node_modules copy; in a compiled binary it's
    // rewritten by Bun to the embedded `/$bunfs/root/...` path. Both
    // cases route through the same code — no #ifdef branch.
    await Parser.init({ locateFile: () => engineWasmPath });
    const bytes = options.wasmBytes ?? (await Bun.file(wasmFilePath).bytes());
    const Bash = await Language.load(bytes);
    const parser = new Parser();
    parser.setLanguage(Bash);
    cachedParser = parser;
    return parser;
  })();
  try {
    return await initInFlight;
  } finally {
    initInFlight = null;
  }
};

// Sync access for callers that already invoked `initBashParser`.
// Throws if init hasn't run — the engine's bootstrap is the only
// caller and ensures init completes before `check()` runs.
export const getBashParser = (): Parser => {
  if (cachedParser === null) {
    throw new Error(
      'bash-parser: initBashParser() has not completed yet — call from bootstrap before first check()',
    );
  }
  return cachedParser;
};

// Reset cached state. Used by tests that want to exercise init
// failure paths or hot-swap a fixture wasm. Not part of the
// production surface — the engine never resets mid-session.
export const __resetBashParserForTest = (): void => {
  cachedParser = null;
  initInFlight = null;
};

// Convenience parse helper. Returns the root node directly so
// callers don't have to remember to keep the tree alive — the
// resolver only needs the node graph. `null` return indicates a
// parse failure (rare; tree-sitter is error-recovering and almost
// always produces a tree). Callers should treat null as Refuse.
import type { Node, Tree } from 'web-tree-sitter';

// Defensive timeout ceiling on tree-sitter parse (slice 110, R2
// #204). Spec-side concern: tree-sitter's error recovery is
// usually fast, but pathological adversarial input (deeply
// recursive shapes with unbalanced delimiters, malformed
// here-docs, or carefully crafted Unicode sequences that confuse
// the LR(1) state machine) can drive parsing into a slow path
// that approaches O(N²) or worse. A 5 s cap is well above any
// legitimate bash command size (operator-typed commands typically
// parse sub-millisecond; even a 100 KB script parses in <100 ms
// on modern hardware) and well below "operator notices the hang"
// thresholds.
//
// Implementation: `parser.parse(source, oldTree, { progressCallback })`
// — web-tree-sitter calls the callback periodically during parse.
// Returning `true` cancels parsing (the parse returns `null`).
// We track the cancellation reason via a closure flag so the
// caller can distinguish "timeout" (throw) from "parse failure"
// (null) — the bash resolver maps the throw to `parser unavailable
// (bash-parser: parse timeout ...)` and null to `parser produced
// no tree`, so audit triage sees the right cause.
const PARSE_TIMEOUT_MS = 5_000;

export const parseBash = (source: string): { tree: Tree; root: Node } | null => {
  const parser = getBashParser();
  const startMs = Date.now();
  let timedOut = false;
  const tree = parser.parse(source, undefined, {
    progressCallback: (() => {
      if (Date.now() - startMs > PARSE_TIMEOUT_MS) {
        timedOut = true;
        return true;
      }
      return false;
    }) as never, // ParseOptions types `=> void` but docs + parse return-null behavior treat `true` as cancel.
  });
  if (timedOut) {
    // Reset the parser — without this, the cancelled parse
    // leaves the parser in a paused state and the NEXT call
    // resumes from where the last one left off (per the
    // `Parser#reset` doc-comment in web-tree-sitter.d.ts:194-202).
    // We want every parse call to be independent.
    parser.reset();
    throw new Error(
      `bash-parser: parse timeout after ${PARSE_TIMEOUT_MS}ms (input length=${source.length})`,
    );
  }
  if (tree === null) return null;
  return { tree, root: tree.rootNode };
};
