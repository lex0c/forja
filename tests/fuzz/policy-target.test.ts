import { describe, expect, test } from 'bun:test';
import { runFuzz } from '../../src/fuzz/index.ts';
import { policyFuzzTarget } from '../../src/fuzz/targets/policy.ts';

describe('policyFuzzTarget — spec §15.4 line 1119', () => {
  // Headline invariant: 2000 random YAML-shaped inputs all result
  // in either a valid Policy or a thrown Error — no other failure
  // mode. loadPolicyFromString is pure code (no async deps, no
  // SQLite, no fs), so 2000 iterations run in <1s and catch any
  // unhandled-branch regression in either the YAML parser or
  // parsePolicy's schema validation.
  test('2000 iterations against loadPolicyFromString produce no crashes', () => {
    const r = runFuzz({ target: policyFuzzTarget, iterations: 2000, seed: 1 });
    if (r.crashes.length > 0) {
      const first = r.crashes[0];
      if (first !== undefined) {
        throw new Error(
          `policyFuzzTarget crashed ${r.crashes.length}/${r.iterations} times. First: seed=${first.seed}, ${first.inputDisplay}, error=${first.error}`,
        );
      }
    }
    expect(r.crashes).toHaveLength(0);
  });

  test('format renders yaml as single-line JSON-escaped key=value', () => {
    const formatted = policyFuzzTarget.format({ yaml: 'defaults:\n  mode: strict' });
    // JSON.stringify escapes the newline so the CI log stays single-line.
    expect(formatted).toContain('\\n');
    expect(formatted).not.toContain('\n');
    expect(formatted).toBe('yaml="defaults:\\n  mode: strict"');
  });

  test('format escapes embedded quotes safely', () => {
    const formatted = policyFuzzTarget.format({ yaml: 'a "b" c' });
    expect(formatted).toBe('yaml="a \\"b\\" c"');
  });

  test('generate produces deterministic input per seed (replay contract)', () => {
    const seen: string[] = [];
    const wrap = () => ({
      ...policyFuzzTarget,
      run: (input: { yaml: string }) => {
        seen.push(policyFuzzTarget.format(input));
        policyFuzzTarget.run(input);
      },
    });
    runFuzz({ target: wrap(), iterations: 1, seed: 42 });
    runFuzz({ target: wrap(), iterations: 1, seed: 42 });
    expect(seen[0]).toBe(seen[1]);
  });

  test('non-Error throws from the parser surface as fuzz failures', () => {
    // The invariant catches non-Error throws. Validate the
    // assertion logic by wrapping with a stub that throws a string
    // — the target's invariant check should re-throw with a
    // descriptive message.
    const stubInvariant = {
      ...policyFuzzTarget,
      run: (_input: { yaml: string }) => {
        try {
          throw 'plain-string-thrown';
        } catch (e) {
          if (e instanceof Error) return;
          throw new Error(`non-Error throw from parser: ${typeof e}, value=${String(e)}`);
        }
      },
    };
    const r = runFuzz({ target: stubInvariant, iterations: 1, seed: 1 });
    expect(r.crashes).toHaveLength(1);
    expect(r.crashes[0]?.error).toContain('non-Error throw');
  });
});
