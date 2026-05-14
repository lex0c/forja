// Deterministic PRNG used by the fuzz harness. Same seed → same
// sequence, so a crash recorded with `seed=N` reproduces by re-
// running the harness with that exact seed. This is the core
// reproducibility contract — without it, fuzz crashes would be
// non-actionable ("the harness crashed once at 03:14:15 last
// Tuesday, good luck").
//
// `mulberry32` is the algorithm: fast, ~5ns per call, period
// 2^32. Adequate for fuzz testing: we want statistical coverage
// across the input space, not cryptographic randomness. The
// per-iteration seed is derived as `baseSeed + iteration` so a
// 10^9-iteration run uses 10^9 distinct seeds before wrapping.

// Mulberry32 — public-domain PRNG. State fits in a 32-bit integer;
// the returned function produces a uniform float in [0, 1).
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Inclusive integer in [min, max]. Both endpoints reachable.
export const randInt = (rng: () => number, min: number, max: number): number => {
  return Math.floor(rng() * (max - min + 1)) + min;
};

// Random printable ASCII char (codes 32-126).
export const randAsciiChar = (rng: () => number): string => {
  return String.fromCharCode(randInt(rng, 32, 126));
};

// Random ASCII string of exact `length` characters.
export const randAsciiString = (rng: () => number, length: number): string => {
  let s = '';
  for (let i = 0; i < length; i++) s += randAsciiChar(rng);
  return s;
};

// Random glob-shaped string biased toward characters that exercise
// the matcher's parser (wildcards, brackets, slashes). Used by the
// glob fuzz target instead of pure-ASCII random — pure random
// rarely produces meaningful glob structure, so the matcher's
// special-case branches stay uncovered. This biases toward edge
// cases the matcher must handle.
export const randGlobChar = (rng: () => number): string => {
  // ~40% of chars are special glob metas; ~60% are alphanumeric.
  // Distribution chosen so a length-20 string statistically has
  // 6-8 specials, which is enough to trigger nested patterns.
  const roll = rng();
  if (roll < 0.05) return '*';
  if (roll < 0.1) return '?';
  if (roll < 0.15) return '/';
  if (roll < 0.2) return '[';
  if (roll < 0.25) return ']';
  if (roll < 0.3) return '!';
  if (roll < 0.35) return '\\';
  if (roll < 0.4) return '{';
  return randAsciiChar(rng);
};

export const randGlobString = (rng: () => number, length: number): string => {
  let s = '';
  for (let i = 0; i < length; i++) s += randGlobChar(rng);
  return s;
};
