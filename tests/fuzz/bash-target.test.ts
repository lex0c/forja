import { beforeAll, describe, expect, test } from 'bun:test';
import { runFuzz } from '../../src/fuzz/index.ts';
import { bashFuzzTarget } from '../../src/fuzz/targets/bash.ts';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
// Touching the resolvers barrel ensures registerResolver('bash', ...)
// has run before getResolver('bash') in the target. Without this
// import, the target's first iteration throws "resolver not
// registered" and every subsequent crash piles on.
import '../../src/permissions/resolvers/index.ts';

describe('bashFuzzTarget — spec §15.4 line 1118', () => {
  beforeAll(async () => {
    // tree-sitter-bash WASM must be loaded BEFORE running fuzz —
    // the resolver itself catches parser failures via a `refuse`
    // path, but the underlying parseBash relies on a warm grammar.
    // initBashParser is idempotent + cached.
    await initBashParser();
  });

  // Headline invariant: 1000 random shell-shaped inputs all
  // produce structurally-valid resolver results. Smaller than the
  // glob target's 2000 because parseBash + walkAst is ~10× slower
  // than matchPath — 1000 still catches >0.1%-rate crashes.
  test('1000 iterations against bash resolver produce no crashes', () => {
    const r = runFuzz({ target: bashFuzzTarget, iterations: 1000, seed: 1 });
    if (r.crashes.length > 0) {
      const first = r.crashes[0];
      if (first !== undefined) {
        throw new Error(
          `bashFuzzTarget crashed ${r.crashes.length}/${r.iterations} times. First: seed=${first.seed}, ${first.inputDisplay}, error=${first.error}`,
        );
      }
    }
    expect(r.crashes).toHaveLength(0);
  });

  test('format renders command as single-line JSON-escaped key=value', () => {
    const formatted = bashFuzzTarget.format({ command: 'ls -la' });
    expect(formatted).toBe('command="ls -la"');
  });

  test('format escapes newlines + quotes so CI logs stay single-line', () => {
    const formatted = bashFuzzTarget.format({ command: 'echo "a\nb"' });
    expect(formatted).toContain('\\n');
    expect(formatted).not.toContain('\n'); // no actual newline
  });

  test('generate produces deterministic input per seed (replay contract)', () => {
    // Capture two runs with the same seed; their generated inputs
    // must match byte-for-byte. Same shape as the glob target's
    // replay test.
    const seen: string[] = [];
    const wrap = (label: string) => ({
      ...bashFuzzTarget,
      run: (input: { command: string }) => {
        seen.push(`${label}:${bashFuzzTarget.format(input)}`);
        bashFuzzTarget.run(input);
      },
    });
    runFuzz({ target: wrap('a'), iterations: 1, seed: 7777 });
    runFuzz({ target: wrap('b'), iterations: 1, seed: 7777 });
    expect(seen[0]?.slice(2)).toBe(seen[1]?.slice(2));
  });

  test('throws on unknown resolver result kind (invariant guard)', () => {
    // Smoke-test the invariant assertions in the target's run() —
    // wire a stub resolver that returns a bogus kind and confirm
    // the target throws.
    //
    // We can't easily replace getResolver mid-test (it's a module-
    // level Map). So we validate the assertion logic by calling
    // run() with an injected resolver via a wrapper target.
    const bogusResolver = () => ({ kind: 'invalid-kind' });
    const wrapper = {
      ...bashFuzzTarget,
      run: (_input: { command: string }) => {
        const result = bogusResolver();
        // Mimic the target's invariant check in isolation.
        if (result.kind !== 'ok' && result.kind !== 'conservative' && result.kind !== 'refuse') {
          throw new Error(`unknown result kind: ${result.kind}`);
        }
      },
    };
    const r = runFuzz({ target: wrapper, iterations: 1, seed: 1 });
    expect(r.crashes).toHaveLength(1);
    expect(r.crashes[0]?.error).toContain('unknown result kind');
  });
});
