import { describe, expect, test } from 'bun:test';
import { runFuzz } from '../../src/fuzz/index.ts';
import { globFuzzTarget } from '../../src/fuzz/targets/glob.ts';

describe('globFuzzTarget — spec §15.4 line 1117', () => {
  // The headline invariant: matchPath returns a boolean for ANY
  // glob-shaped random input. Slice 66 runs 2000 iterations as
  // the suite gate; CI can crank this to 10⁹ via a separate
  // runner script (spec line 1122 target). 2000 is enough to
  // catch crashes that fire at >0.05% rate while keeping the
  // suite under 2s.
  test('2000 iterations with glob-biased input produce no crashes', () => {
    const r = runFuzz({ target: globFuzzTarget, iterations: 2000, seed: 1 });
    if (r.crashes.length > 0) {
      // Render the first crash so the operator sees the seed +
      // input that broke the matcher. Reproduces deterministically
      // by running with `seed = crash.seed, iterations = 1`.
      const first = r.crashes[0];
      if (first !== undefined) {
        throw new Error(
          `globFuzzTarget crashed ${r.crashes.length}/${r.iterations} times. First crash: seed=${first.seed}, ${first.inputDisplay}, error=${first.error}`,
        );
      }
    }
    expect(r.crashes).toHaveLength(0);
  });

  test('format renders pattern + target + cwd as a single-line key=value', () => {
    const input = {
      pattern: '*',
      target: '/etc/passwd',
      cwd: '/work',
    };
    const formatted = globFuzzTarget.format(input);
    expect(formatted).toContain('pattern=');
    expect(formatted).toContain('target=');
    expect(formatted).toContain('cwd=');
    // JSON.stringify ensures special chars don't break the line.
    expect(formatted).toBe('pattern="*" target="/etc/passwd" cwd="/work"');
  });

  test('format handles non-printable / quote-containing inputs safely', () => {
    const input = {
      pattern: 'a"b\nc',
      target: '\x00\x01',
      cwd: '/',
    };
    const formatted = globFuzzTarget.format(input);
    // JSON.stringify escapes the control chars + quote so the
    // output stays single-line + parseable.
    expect(formatted).toContain('"a\\"b\\nc"');
    expect(formatted).not.toContain('\n'); // no actual newline
  });

  test('generate produces deterministic input per seed', () => {
    // Same seed → same input. This is the reproducibility contract
    // that lets operators replay a CI crash from seed metadata.
    const r1 = runFuzz({ target: globFuzzTarget, iterations: 1, seed: 12345 });
    const r2 = runFuzz({ target: globFuzzTarget, iterations: 1, seed: 12345 });
    expect(r1.crashes.length).toBe(0);
    expect(r2.crashes.length).toBe(0);
    // The same seed produces the same input within `generate`; we
    // can't observe it directly without a crash, so test via a
    // capturing wrapper.
    const seen: string[] = [];
    runFuzz({
      target: {
        ...globFuzzTarget,
        run: (input) => {
          seen.push(globFuzzTarget.format(input));
          globFuzzTarget.run(input);
        },
      },
      iterations: 1,
      seed: 12345,
    });
    runFuzz({
      target: {
        ...globFuzzTarget,
        run: (input) => {
          seen.push(globFuzzTarget.format(input));
          globFuzzTarget.run(input);
        },
      },
      iterations: 1,
      seed: 12345,
    });
    expect(seen[0]).toBe(seen[1]);
  });
});
