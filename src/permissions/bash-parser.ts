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
    await Parser.init();
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

export const parseBash = (source: string): { tree: Tree; root: Node } | null => {
  const parser = getBashParser();
  const tree = parser.parse(source);
  if (tree === null) return null;
  return { tree, root: tree.rootNode };
};
