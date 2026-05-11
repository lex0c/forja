// Fuzz target: §15.4 line 1117 "glob compiler (random byte
// strings → no panic, no OOB)". Exercises `matchPath` with
// pattern + path + cwd triples drawn from a glob-biased random
// distribution (slice 66).
//
// Invariant: for ANY input triple, `matchPath` returns a plain
// boolean. No throws, no undefined/NaN, no out-of-bounds in the
// compiled regex pipeline. The matcher is responsible for
// rejecting malformed patterns gracefully — usually by treating
// them as literals.
//
// Why glob-biased generation: pure-ASCII random rarely produces
// meaningful glob structure (no `*`, no `**`, no brackets), so
// the matcher's special-case branches stay uncovered. The bias
// in `randGlobChar` puts roughly 40% of generated chars in the
// metacharacter set, which statistically triggers nested
// patterns, unbalanced brackets, and edge-case combinations.

import { matchPath } from '../../permissions/matcher.ts';
import type { FuzzTarget } from '../index.ts';
import { randGlobString, randInt } from '../random.ts';

export interface GlobFuzzInput {
  pattern: string;
  target: string;
  cwd: string;
}

export const globFuzzTarget: FuzzTarget<GlobFuzzInput> = {
  name: 'glob',
  generate: (rng) => {
    // Lengths chosen to cover empty, short, medium, and
    // pathological-but-bounded inputs. 128 is enough to surface
    // O(n²) compiler bugs without blowing up wall-clock per
    // iteration.
    const patternLen = randInt(rng, 0, 64);
    const targetLen = randInt(rng, 0, 128);
    const cwdLen = randInt(rng, 1, 32);
    return {
      pattern: randGlobString(rng, patternLen),
      target: randGlobString(rng, targetLen),
      // cwd is usually an absolute path in production; bias the
      // first char toward `/` to match real usage.
      cwd: `/${randGlobString(rng, cwdLen - 1)}`,
    };
  },
  format: (input) =>
    `pattern=${JSON.stringify(input.pattern)} target=${JSON.stringify(input.target)} cwd=${JSON.stringify(input.cwd)}`,
  run: (input) => {
    const result = matchPath(input.pattern, input.target, input.cwd);
    // Type invariant: matchPath must return a plain boolean. The
    // `typeof` check catches: (a) the matcher throwing
    // (try/catch upstream catches that — we never reach here),
    // (b) the matcher returning undefined on an unhandled branch,
    // (c) NaN from arithmetic somewhere in the compile pipeline.
    if (typeof result !== 'boolean') {
      throw new Error(
        `matchPath returned non-boolean: typeof=${typeof result}, value=${String(result)}`,
      );
    }
  },
};
