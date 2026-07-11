import { describe, expect, test } from 'bun:test';
import { runFuzz } from '../../src/fuzz/index.ts';
import { chainFuzzTarget } from '../../src/fuzz/targets/chain.ts';

describe('chainFuzzTarget — spec §15.4 line 1120', () => {
  // Headline invariant: 200 iterations of seed-tamper-verify
  // produce zero crashes. The chain target is slower than glob /
  // policy because each iteration opens a fresh in-memory SQLite
  // DB, runs migrations, and seeds 1-20 rows — ~10ms per
  // iteration. 200 iterations completes in ~2s, well under the
  // 5s bun:test per-test budget. The CI nightly runner can
  // crank to 10⁵+ via separate orchestration; the harness API
  // doesn't change.
  test('200 iterations of seed+tamper+verify produce no crashes', () => {
    const r = runFuzz({ target: chainFuzzTarget, iterations: 200, seed: 1 });
    if (r.crashes.length > 0) {
      const first = r.crashes[0];
      if (first !== undefined) {
        throw new Error(
          `chainFuzzTarget crashed ${r.crashes.length}/${r.iterations} times. First: seed=${first.seed}, ${first.inputDisplay}, error=${first.error}`,
        );
      }
    }
    expect(r.crashes).toHaveLength(0);
  });

  test('format renders all input fields readably', () => {
    const formatted = chainFuzzTarget.format({
      rowCount: 5,
      tamperKind: 'update_field',
      rowIndex: 2,
      fieldIndex: 1,
      payload: 'tampered',
    });
    expect(formatted).toBe(
      'rowCount=5 tamperKind=update_field rowIndex=2 fieldIndex=1 payload="tampered"',
    );
  });

  test('format escapes payload with embedded quotes / newlines', () => {
    const formatted = chainFuzzTarget.format({
      rowCount: 1,
      tamperKind: 'insert_forged',
      rowIndex: 0,
      fieldIndex: 0,
      payload: 'a"b\nc',
    });
    expect(formatted).toContain('payload="a\\"b\\nc"');
    expect(formatted).not.toContain('\n'); // no actual newline
  });

  test('generate produces deterministic input per seed (replay contract)', () => {
    const seen: string[] = [];
    const wrap = () => ({
      ...chainFuzzTarget,
      run: (input: Parameters<typeof chainFuzzTarget.run>[0]) => {
        seen.push(chainFuzzTarget.format(input));
        chainFuzzTarget.run(input);
      },
    });
    runFuzz({ target: wrap(), iterations: 1, seed: 9999 });
    runFuzz({ target: wrap(), iterations: 1, seed: 9999 });
    expect(seen[0]).toBe(seen[1]);
  });

  test('all three tamper kinds are exercised across 200 iterations', () => {
    // Sanity check that the generator's distribution actually
    // mixes the three tamper kinds. A bug in the rng draw would
    // produce only one kind; here we verify all three appear in
    // a 200-iteration sample.
    const seen = new Set<string>();
    const wrap = () => ({
      ...chainFuzzTarget,
      run: (input: Parameters<typeof chainFuzzTarget.run>[0]) => {
        seen.add(input.tamperKind);
        // Skip the actual chain work to keep the test fast.
      },
    });
    runFuzz({ target: wrap(), iterations: 200, seed: 1 });
    expect(seen.has('update_field')).toBe(true);
    expect(seen.has('insert_forged')).toBe(true);
    expect(seen.has('delete_row')).toBe(true);
  });

  test('update_field tamper does not crash run() (chain integrity preserved at the invariant layer)', () => {
    // Direct invocation — bypass the harness so we can assert on
    // run() not throwing. tool_name is in the hash payload, so
    // the chain will break and verifyChain returns ok:false; the
    // target's invariant is "no throw + valid VerifyResult shape",
    // both of which hold.
    const input = {
      rowCount: 3,
      tamperKind: 'update_field' as const,
      rowIndex: 1,
      fieldIndex: 0, // 'tool_name' field — in the hash payload
      payload: 'tampered-tool',
    };
    expect(() => chainFuzzTarget.run(input)).not.toThrow();
  });
});
