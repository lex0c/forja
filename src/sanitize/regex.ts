// Heuristic rejection of regex shapes prone to catastrophic
// backtracking. JS has no per-match timeout; a pattern like
// `(a+)+b` against a non-matching input freezes the event loop
// for seconds or longer. Defense is shape rejection at compile
// time. The heuristic is intentionally conservative — false
// positives (rejecting a benign pattern) are recoverable because
// the caller can surface the rejection and the model can retry
// with a tamer shape; false negatives (admitting an exponential
// pattern) freeze the harness.
//
// Detected shapes:
//   - Nested unbounded quantifier: `(a+)+`, `(a*)*`, `(.+)*`, `(\d+)+`.
//   - Large bounded outer quantifier on a repeated body: `(a+){10,}`.
//   - Alternation inside a repeated group: `(a|a)*`, `(a|ab)+`.
//
// Not detected (caller responsibility / accepted risk):
//   - Deeply nested groups beyond two levels (the inner-group
//     scanner is single-level by design to keep the heuristic
//     readable and fast).
//   - Backreferences with quantifiers (`(\w+)\1+`) — rare in
//     model-emitted patterns, separately guarded by total-length
//     cap.

const MAX_PATTERN_BYTES = 1024;
const MAX_BOUNDED_REPEAT = 32;

const NESTED_UNBOUNDED = /\([^()]*[+*][^()]*\)[+*]/;
// Two-level variant: an outer (...)+/* whose body contains an
// inner (...) group that itself has an unbounded quantifier
// (either inside the inner body, or on the inner group itself).
// Catches `((a+))+`, `(x(a+)y)+`, `((a)+)+`, `((a)*)+` — shapes
// the single-level NESTED_UNBOUNDED misses because its `[^()]*`
// segments cannot bridge inner parens. Three levels deep is
// rare enough that the `pattern_too_long` cap (1024 bytes) is
// the practical defense.
const NESTED_UNBOUNDED_TWO_LEVEL =
  /\([^()]*\([^()]*[+*][^()]*\)[^()]*\)[+*]|\([^()]*\([^()]*\)[+*][^()]*\)[+*]/;
const ALT_IN_REPEATED_GROUP = /\([^()]*\|[^()]*\)[+*]/;
const BOUNDED_REPEAT_ON_GROUP = /\([^()]*[+*][^()]*\)\{(\d+)(?:,(\d*))?\}/;

export interface RegexShapeRejection {
  readonly code:
    | 'pattern_too_long'
    | 'nested_unbounded_quantifier'
    | 'alternation_in_repeated_group'
    | 'large_bounded_repeat_on_group';
  readonly message: string;
}

export const detectRedosShape = (pattern: string): RegexShapeRejection | null => {
  if (pattern.length > MAX_PATTERN_BYTES) {
    return {
      code: 'pattern_too_long',
      message: `pattern exceeds ${MAX_PATTERN_BYTES} bytes (got ${pattern.length})`,
    };
  }

  if (NESTED_UNBOUNDED.test(pattern) || NESTED_UNBOUNDED_TWO_LEVEL.test(pattern)) {
    return {
      code: 'nested_unbounded_quantifier',
      message:
        'pattern contains a repeated group whose body is itself unbounded (shapes like `(a+)+` or `((a+))+`); JS regex has no timeout, so this is rejected at compile time to avoid event-loop stalls',
    };
  }

  if (ALT_IN_REPEATED_GROUP.test(pattern)) {
    return {
      code: 'alternation_in_repeated_group',
      message:
        'pattern contains alternation inside a repeated group (shapes like `(a|ab)+`); overlapping branches cause exponential backtracking',
    };
  }

  const boundedMatch = pattern.match(BOUNDED_REPEAT_ON_GROUP);
  if (boundedMatch) {
    const lower = Number.parseInt(boundedMatch[1] ?? '0', 10);
    const upperRaw = boundedMatch[2];
    const upper =
      upperRaw === undefined || upperRaw === ''
        ? Number.POSITIVE_INFINITY
        : Number.parseInt(upperRaw, 10);
    if (lower > MAX_BOUNDED_REPEAT || upper > MAX_BOUNDED_REPEAT) {
      return {
        code: 'large_bounded_repeat_on_group',
        message: `pattern repeats a quantified group more than ${MAX_BOUNDED_REPEAT} times; large bounded repeats on '(a+){n,}'-shaped bodies are exponential the same way unbounded repeats are`,
      };
    }
  }

  return null;
};
