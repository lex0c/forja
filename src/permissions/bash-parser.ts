// Bash AST entry-point for the permission engine. Wraps
// `web-tree-sitter` + the `tree-sitter-bash` grammar (vendored at
// `src/permissions/grammars/tree-sitter-bash.wasm`) into a
// synchronous parse interface backed by an async one-time init.
//
// Design:
//
//   1. Tree-sitter is the entry-point, NOT the authority. The
//      resolver walks the AST against a whitelist of nodes;
//      anything outside the whitelist is `Refuse` with a specific
//      reason.
//   2. Init is async (Wasm runtime + grammar load), parse is sync
//      after init. Bootstrap calls `initBashParser()` once during
//      the `validating-chain` phase; `engine.check()` stays
//      synchronous because the parser is already warm.
//   3. Grammar wasm is vendored in-tree, not fetched at runtime.
//      The release pipeline (`bun build --compile`) embeds it
//      deterministically via Bun's
//      `import … with { type: 'file' }` attribute: the import
//      resolves to a runtime path that points at the on-disk file
//      in dev mode and at the embedded asset in compiled
//      binaries. `Bun.file(path).bytes()` reads either case
//      without branching.

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

// Defensive timeout ceiling on tree-sitter parse. Tree-sitter's
// error recovery is usually fast, but pathological adversarial
// input (deeply recursive shapes with unbalanced delimiters,
// malformed here-docs, or carefully crafted Unicode sequences
// that confuse the LR(1) state machine) can drive parsing into a
// slow path approaching O(N²) or worse.
//
// Threat sizing: Bun runs JS single-threaded; every parse blocks
// the engine. An adversary planting N pathological inputs (prompt
// injection in an .agent file, a compromised subagent) burns
// N×TIMEOUT_MS of engine wall-clock before each refuse. A 5s cap
// (pre-slice) put a 10-call attack at ~50s of frozen engine; the
// 1500ms cap below puts it at ~15s. Either is unacceptable as a
// sustained vector — hence the rate-limit guard below.
//
// 1500ms is still 100×+ over the legitimate ceiling: operator-typed
// commands parse sub-millisecond, the 100KB-script worst case
// measured at <100ms on commodity hardware. The cap exists only to
// stop pathological inputs, not to bound legitimate work.
//
// Implementation: `parser.parse(source, oldTree, { progressCallback })`
// — web-tree-sitter calls the callback periodically during parse.
// Returning `true` cancels parsing (the parse returns `null`).
// We track the cancellation reason via a closure flag so the
// caller can distinguish "timeout" (throw) from "parse failure"
// (null) — the bash resolver maps the throw to `parser unavailable
// (bash-parser: parse timeout ...)` and null to `parser produced
// no tree`, so audit triage sees the right cause.
const PARSE_TIMEOUT_MS = 1_500;

// Rate-limit window for parse timeouts. After
// RATE_LIMIT_MAX_TIMEOUTS timeouts within RATE_LIMIT_WINDOW_MS,
// subsequent parses refuse immediately without invoking the
// grammar. Without this, an adversary feeding pathological inputs
// keeps the engine consuming TIMEOUT_MS per call — the rate-limit
// collapses the attack cost to "first 3 calls cost time, the rest
// are free refuses" + a documented audit trail of when the limit
// kicked in.
//
// 30s window matches the typical span of a model's tool-call burst
// (one assistant turn rarely emits more than a handful of bash
// calls). 3 timeouts is loose enough that a single bad input doesn't
// trip the limit but tight enough that the attack cost drops fast.
//
// State is module-scoped (process-wide). The engine is also
// process-wide so this matches the threat boundary; a subagent
// inheriting the parent's process inherits the same counter. Tests
// reset via `__resetBashParserRateLimitForTest`.
const RATE_LIMIT_WINDOW_MS = 30_000;
const RATE_LIMIT_MAX_TIMEOUTS = 3;
const recentTimeoutsAtMs: number[] = [];

// Drop entries older than the rate-limit window. Called BEFORE the
// rate-limit gate check on every parseBash entry so a stale entry
// doesn't keep blocking long after the attack stopped. Timeout
// recording is append-only; the next call's eviction compacts.
const evictExpiredTimeouts = (nowMs: number): void => {
  while (recentTimeoutsAtMs.length > 0) {
    const head = recentTimeoutsAtMs[0];
    if (head === undefined || nowMs - head <= RATE_LIMIT_WINDOW_MS) break;
    recentTimeoutsAtMs.shift();
  }
};

// Test seam. Production callers (engine bootstrap) never need to
// touch this; tests that want to exercise either the rate-limit
// path or the post-limit recovery path use it to reset the buffer.
export const __resetBashParserRateLimitForTest = (): void => {
  recentTimeoutsAtMs.length = 0;
};

// Test seam. Tree-sitter doesn't expose a synthetic-slowness seam
// (the legitimate parse-timeout path needs adversarial input that
// would couple tests to specific grammar revisions), so the rate-
// limit logic is exercised by directly seeding timeouts. Tests
// pass an explicit timestamp to control window-eviction semantics.
export const __pushTimeoutForTest = (timestampMs: number): void => {
  recentTimeoutsAtMs.push(timestampMs);
};

// Observable getter for the current timeout count within the
// window. Exported so a future failure-event emitter (or doctor
// command) can surface the parser's saturation state without
// reaching into the module's internals.
export const getRecentParseTimeoutCount = (): number => {
  evictExpiredTimeouts(Date.now());
  return recentTimeoutsAtMs.length;
};

export const parseBash = (source: string): { tree: Tree; root: Node } | null => {
  const parser = getBashParser();
  const startMs = Date.now();
  // Rate-limit gate. Run BEFORE parser.parse so a saturated
  // window short-circuits without spending any tree-sitter time.
  // Eviction happens here so a window that fully expired sees
  // the counter reset on the first post-window call.
  evictExpiredTimeouts(startMs);
  if (recentTimeoutsAtMs.length >= RATE_LIMIT_MAX_TIMEOUTS) {
    throw new Error(
      `bash-parser: rate-limited (${recentTimeoutsAtMs.length} parse timeouts in last ${RATE_LIMIT_WINDOW_MS}ms)`,
    );
  }
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
    // Record this timeout in the rolling window. The buffer is
    // append-only within the window; evictExpiredTimeouts above
    // already cleared stale entries.
    recentTimeoutsAtMs.push(Date.now());
    throw new Error(
      `bash-parser: parse timeout after ${PARSE_TIMEOUT_MS}ms (input length=${source.length})`,
    );
  }
  if (tree === null) return null;
  return { tree, root: tree.rootNode };
};
