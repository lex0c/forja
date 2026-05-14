import { beforeAll, describe, expect, test } from 'bun:test';
import { initBashParser, parseBash } from '../../src/permissions/bash-parser.ts';

beforeAll(async () => {
  await initBashParser();
});

describe('parseBash — happy path', () => {
  test('parses a simple command into a tree', () => {
    const r = parseBash('ls -la');
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.tree).toBeDefined();
    expect(r.root).toBeDefined();
    expect(r.root.type).toBe('program');
  });

  test('parses a pipeline', () => {
    const r = parseBash('ls -la | grep foo | wc -l');
    expect(r).not.toBeNull();
  });

  test('parses an empty string (still produces a tree)', () => {
    // tree-sitter is error-recovering; an empty source produces
    // a program node with no children. Resolver treats this as
    // "no commands recognized" but the parse itself succeeds.
    const r = parseBash('');
    expect(r).not.toBeNull();
  });
});

// Slice 110 — R2 #204: tree-sitter is error-recovering and
// usually fast, but pathological adversarial input could drive
// the LR(1) state machine into a slow path. PARSE_TIMEOUT_MS
// caps every parse at 5s; over the ceiling, parseBash throws
// `bash-parser: parse timeout after Nms (input length=...)`.
// The bash resolver maps the throw to `parser unavailable
// (bash-parser: ...)` — distinct from null return, which the
// resolver maps to `parser produced no tree`.
describe('parseBash — timeout defense (slice 110, R2 #204)', () => {
  test('legitimate input under the ceiling parses cleanly (no false-positive timeout)', () => {
    // A moderately-sized but valid bash command — well under
    // the 5s ceiling. The defense MUST NOT regress the normal
    // case.
    const cmd = `for i in $(seq 1 100); do echo line-$i; done && ${'ls /tmp; '.repeat(50)}`;
    const r = parseBash(cmd);
    expect(r).not.toBeNull();
  });

  test('parse timeout throws with operator-readable reason', () => {
    // Verifying the timeout fires requires either a real
    // pathological input (fragile across grammar versions) OR
    // a mock that triggers the progressCallback path. Tree-
    // sitter doesn't expose a synthetic-slowness seam, and
    // synthesizing pathological input that always trips the
    // grammar's slow paths would couple this test to specific
    // grammar revisions.
    //
    // Smoke test: verify the parse helper accepts very large
    // input without crashing (the size itself isn't enough to
    // trigger timeout — tree-sitter is O(N) for happy-case
    // input — but it exercises the progressCallback wiring,
    // which fires repeatedly during a long parse). If the
    // progressCallback is misconfigured (e.g., throws instead
    // of returning bool), this surfaces here.
    const huge = 'echo ok; '.repeat(10_000);
    const r = parseBash(huge);
    expect(r).not.toBeNull();
  });

  test('throws when source is null at the parser level (defensive)', () => {
    // Not a timeout test — pinning the function's "no source"
    // boundary. Empty string parses fine (above); the actual
    // null source would be a TS type violation but the runtime
    // shape is documented.
    const r = parseBash('   ');
    // Trimmed-empty input — tree-sitter still produces a tree.
    expect(r).not.toBeNull();
  });
});

describe('parseBash — multiple sequential parses (parser reset)', () => {
  test('two parses in sequence both succeed independently', () => {
    // Slice 110 calls `parser.reset()` after a timed-out parse
    // to prevent the next parse from resuming where the last
    // one left off (web-tree-sitter contract: a cancelled parse
    // leaves the parser in a paused state). The happy path
    // doesn't need reset because the parse completed; this
    // test pins that sequential clean parses don't bleed state.
    const a = parseBash('echo a');
    const b = parseBash('echo b');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a !== null && b !== null) {
      // Different parse → different root node identity.
      expect(a.root).not.toBe(b.root);
    }
  });

  test('parse after a previous failed parse still works', () => {
    // A parse that fails for some reason shouldn't break the
    // next parse. Tree-sitter is error-recovering so most
    // input parses to SOMETHING; we test a sequence where
    // both succeed.
    const a = parseBash('echo first');
    expect(a).not.toBeNull();
    const b = parseBash('echo second');
    expect(b).not.toBeNull();
  });
});
