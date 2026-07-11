import { describe, expect, test } from 'bun:test';
import { detectRedosShape } from '../../src/sanitize/regex.ts';

describe('detectRedosShape', () => {
  describe('accepts safe shapes', () => {
    test.each([
      ['plain literal', 'READY'],
      ['anchored literal', '^READY$'],
      ['alternation without outer quantifier', 'error|warn|info'],
      ['simple character class', '[a-zA-Z0-9_]+'],
      ['single-level quantifier', 'a+'],
      ['bounded repeat under threshold', 'a{1,16}'],
      ['nested group without inner unbounded', '(foo)+'],
      ['escaped meta in literal', '\\(a\\+\\)\\+'],
      ['lookahead', '(?=foo)bar'],
      ['non-capturing single-level', '(?:abc)+'],
    ])('%s — %s', (_, pattern) => {
      expect(detectRedosShape(pattern)).toBeNull();
    });
  });

  describe('rejects catastrophic-backtracking shapes', () => {
    test('nested unbounded: (a+)+', () => {
      const result = detectRedosShape('(a+)+');
      expect(result?.code).toBe('nested_unbounded_quantifier');
    });

    test('nested unbounded: (a*)*', () => {
      expect(detectRedosShape('(a*)*')?.code).toBe('nested_unbounded_quantifier');
    });

    test('nested unbounded: (.+)*', () => {
      expect(detectRedosShape('(.+)*')?.code).toBe('nested_unbounded_quantifier');
    });

    test('nested unbounded: (\\d+)+', () => {
      expect(detectRedosShape('(\\d+)+')?.code).toBe('nested_unbounded_quantifier');
    });

    test('nested unbounded: classic (a+)+b', () => {
      expect(detectRedosShape('(a+)+b')?.code).toBe('nested_unbounded_quantifier');
    });

    test('two-level nested: ((a+))+', () => {
      expect(detectRedosShape('((a+))+')?.code).toBe('nested_unbounded_quantifier');
    });

    test('two-level nested: ((a))+ with outer quantifier', () => {
      expect(detectRedosShape('((a)+)+')?.code).toBe('nested_unbounded_quantifier');
    });

    test('two-level nested with surrounding chars: (x(a+)y)+', () => {
      expect(detectRedosShape('(x(a+)y)+')?.code).toBe('nested_unbounded_quantifier');
    });

    test('two-level nested with inner star: ((a)*)+', () => {
      expect(detectRedosShape('((a)*)+')?.code).toBe('nested_unbounded_quantifier');
    });
  });

  describe('rejects alternation in repeated group', () => {
    test('(a|a)*', () => {
      expect(detectRedosShape('(a|a)*')?.code).toBe('alternation_in_repeated_group');
    });

    test('(a|ab)+', () => {
      expect(detectRedosShape('(a|ab)+')?.code).toBe('alternation_in_repeated_group');
    });

    test('(a|aa){30,}b — unbounded upper on alt group', () => {
      // Same catastrophic shape as (a|aa)+b. Pre-fix only `[+*]`
      // after the alt group was caught; brace quantifiers with
      // large/unbounded counts slipped through and could hang
      // the harness for seconds on a non-matching input like
      // `'a'.repeat(60) + 'c'`.
      expect(detectRedosShape('(a|aa){30,}b')?.code).toBe('alternation_in_repeated_group');
    });

    test('(a|aa){50} — exact-count above threshold', () => {
      expect(detectRedosShape('(a|aa){50}')?.code).toBe('alternation_in_repeated_group');
    });

    test('(a|ab){10,100} — bounded but upper exceeds threshold', () => {
      expect(detectRedosShape('(a|ab){10,100}')?.code).toBe('alternation_in_repeated_group');
    });

    test('multi-group: benign prefix does NOT mask catastrophic alt-bounded later', () => {
      // matchAll on ALT_IN_BOUNDED_GROUP — first match is fine
      // (small bounds), second match is the catastrophic one.
      // Without iteration, pre-fix bypass.
      expect(detectRedosShape('(x|y){1,2}(a|aa){100,}')?.code).toBe(
        'alternation_in_repeated_group',
      );
    });

    test('admits (a|b){1,5} — small bounded count', () => {
      // Both bounds under MAX_BOUNDED_REPEAT; not exponential.
      expect(detectRedosShape('(a|b){1,5}')).toBeNull();
    });

    test('admits (a|b){3} — small exact count', () => {
      expect(detectRedosShape('(a|b){3}')).toBeNull();
    });
  });

  describe('rejects large bounded repeats on quantified groups', () => {
    test('(a+){50,}', () => {
      expect(detectRedosShape('(a+){50,}')?.code).toBe('large_bounded_repeat_on_group');
    });

    test('(a+){1,100}', () => {
      expect(detectRedosShape('(a+){1,100}')?.code).toBe('large_bounded_repeat_on_group');
    });

    test('admits modest bounded repeats', () => {
      // (a+){1,16} stays under MAX_BOUNDED_REPEAT and is rejected
      // by the OTHER guard (nested unbounded), which is fine —
      // the outer (a+) is still pathological. This test pins
      // that the bounded-repeat detector itself doesn't fire on
      // small upper limits.
      const rejection = detectRedosShape('(a+){1,16}');
      expect(rejection?.code).not.toBe('large_bounded_repeat_on_group');
    });

    test('rejects a catastrophic bounded group hidden behind a benign one', () => {
      // Pre-fix bypass: `match` returned the first match only, so a
      // benign `(a+){1,2}` prefix would mask the catastrophic
      // `(b+){100,100}` that follows. The fix uses `matchAll` and
      // walks every quantified group; this test pins the iteration.
      // The pattern is also caught by NESTED_UNBOUNDED first
      // (because `(a+){1,2}` matches the regex `\([^()]*[+*][^()]*\)[+*]`
      // — `{1,2}` is `[+*]`? no, `{` is literal). Let's use a shape
      // that ONLY trips the bounded-repeat detector for both groups:
      // (\d){1,2}(b+){100,100} — the first group has no inner
      // quantifier so NESTED_UNBOUNDED skips it; the second triggers
      // BOUNDED_REPEAT_ON_GROUP on its body's `+`.
      const rejection = detectRedosShape('(\\d){1,2}(b+){100,100}');
      expect(rejection?.code).toBe('large_bounded_repeat_on_group');
    });

    test('rejects when bad bounded group is in the middle of the pattern', () => {
      // Defense-in-depth: the bad group is neither first nor last —
      // detector must walk the whole pattern, not just the head or
      // tail.
      const rejection = detectRedosShape('foo (\\d){1,2}(b+){50,}(\\w){1,3} bar');
      expect(rejection?.code).toBe('large_bounded_repeat_on_group');
    });

    test('accepts when every bounded group is below threshold', () => {
      // Multi-group safe pattern: every quantified group under
      // MAX_BOUNDED_REPEAT. Detector iterates all matches, finds
      // none above threshold, returns null.
      const rejection = detectRedosShape('(\\d+){1,5}(\\w+){1,10}(.+){1,3}');
      expect(rejection?.code).not.toBe('large_bounded_repeat_on_group');
    });

    test('accepts exact-count `{n}` on a quantified body when n is small', () => {
      // `(a+){5}` is bounded to 5 outer iterations of `a+` — outer
      // count fixed, no exponential search space. Pre-fix this
      // collapsed undefined upper to Infinity and rejected. Post-
      // fix `{n}` means exactly n, so upper = lower = 5 < 32 ⇒ OK.
      expect(detectRedosShape('(a+){5}')?.code).not.toBe('large_bounded_repeat_on_group');
      expect(detectRedosShape('(\\d+){10}')?.code).not.toBe('large_bounded_repeat_on_group');
      expect(detectRedosShape('(\\w+){32}')?.code).not.toBe('large_bounded_repeat_on_group');
    });

    test('rejects exact-count `{n}` when n exceeds threshold', () => {
      // `(a+){50}` is bounded but the bound itself exceeds the
      // threshold — still a problem (50 outer iterations × inner
      // backtrack is too much work in the worst case).
      expect(detectRedosShape('(a+){50}')?.code).toBe('large_bounded_repeat_on_group');
      expect(detectRedosShape('(\\d+){100}')?.code).toBe('large_bounded_repeat_on_group');
    });

    test('still rejects `{n,}` unbounded upper as catastrophic', () => {
      // `(a+){1,}` is the unbounded shape — upper Infinity > 32 ⇒
      // reject. This is the case the pre-fix code WAS catching
      // correctly; the test pins the contract survives the
      // undefined-vs-empty distinction the fix introduces.
      expect(detectRedosShape('(a+){1,}')?.code).toBe('large_bounded_repeat_on_group');
      expect(detectRedosShape('(\\d+){5,}')?.code).toBe('large_bounded_repeat_on_group');
    });

    test('accepts `{n,m}` when both bounds are below threshold', () => {
      // `(a+){5,10}` — outer iterations bounded to a small range,
      // safe. Pin the explicit bounded-bounded case which the pre-
      // fix code already handled correctly.
      expect(detectRedosShape('(a+){5,10}')?.code).not.toBe('large_bounded_repeat_on_group');
      expect(detectRedosShape('(\\d+){1,32}')?.code).not.toBe('large_bounded_repeat_on_group');
    });
  });

  describe('rejects oversized patterns', () => {
    test('over 1024 bytes', () => {
      const huge = 'a'.repeat(1500);
      const result = detectRedosShape(huge);
      expect(result?.code).toBe('pattern_too_long');
      expect(result?.message).toContain('1024');
    });

    test('exactly at threshold passes', () => {
      const onLimit = 'a'.repeat(1024);
      expect(detectRedosShape(onLimit)).toBeNull();
    });
  });

  describe('rejection includes diagnostic message', () => {
    test('message names the offending shape category', () => {
      const result = detectRedosShape('(x+)+');
      expect(result).not.toBeNull();
      expect(result?.message).toContain('repeated group');
    });
  });
});
