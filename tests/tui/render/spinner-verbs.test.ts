import { describe, expect, test } from 'bun:test';
import {
  COGNITIVE_VERB_POOL,
  OUTPUT_VERB_POOL,
  pickCognitiveVerb,
  pickOutputVerb,
} from '../../../src/tui/render/spinner-verbs.ts';

// Pool composition is the public contract: a verb leaves the pool
// → operators see a different label; a verb joins → distribution
// shifts. Pin both pools verbatim so any addition / reorder / typo
// surfaces at PR review.

describe('spinner verb pools', () => {
  test('COGNITIVE_VERB_POOL is the research-lab cluster (5 verbs, ordered)', () => {
    expect(COGNITIVE_VERB_POOL).toEqual([
      'Modeling',
      'Synthesizing',
      'Deriving',
      'Correlating',
      'Evaluating',
    ]);
  });

  test('OUTPUT_VERB_POOL is the Forge OS cluster (5 verbs, ordered)', () => {
    expect(OUTPUT_VERB_POOL).toEqual(['Forging', 'Tempering', 'Hardening', 'Smelting', 'Shaping']);
  });

  test('pools do not overlap — each verb belongs to one phase only', () => {
    // Cognitive vs output is a semantic split (the model is
    // reasoning vs producing). Overlap would let the same verb
    // surface for both states and dilute the distinction.
    const intersection = COGNITIVE_VERB_POOL.filter((v) => OUTPUT_VERB_POOL.includes(v));
    expect(intersection).toEqual([]);
  });
});

describe('pickCognitiveVerb', () => {
  test('returns a verb from the cognitive pool', () => {
    expect(COGNITIVE_VERB_POOL).toContain(pickCognitiveVerb('msg_01ABC'));
    expect(COGNITIVE_VERB_POOL).toContain(pickCognitiveVerb(''));
    expect(COGNITIVE_VERB_POOL).toContain(pickCognitiveVerb('unknown-1234567890'));
  });

  test('is deterministic for the same seed (no flicker within a turn)', () => {
    // The chip ticks every ~150ms; the picker MUST return the
    // same verb on every call within a turn so the operator
    // doesn't see "Modeling… → Synthesizing… → Deriving…"
    // strobe across consecutive frames.
    const seed = 'msg_01StableBrandID';
    const a = pickCognitiveVerb(seed);
    const b = pickCognitiveVerb(seed);
    const c = pickCognitiveVerb(seed);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('different seeds can pick different verbs (distribution check)', () => {
    // Sample many synthetic ids — should hit at least 2 distinct
    // verbs (probability of all 100 colliding to one verb out of 5
    // is (1/5)^99, vanishingly small with even a weak hash).
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(pickCognitiveVerb(`msg_${i}`));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('pickOutputVerb', () => {
  test('returns a verb from the output pool', () => {
    expect(OUTPUT_VERB_POOL).toContain(pickOutputVerb('msg_01ABC'));
    expect(OUTPUT_VERB_POOL).toContain(pickOutputVerb(''));
  });

  test('is deterministic for the same seed', () => {
    const seed = 'msg_01OutputStableID';
    expect(pickOutputVerb(seed)).toBe(pickOutputVerb(seed));
  });

  test('different seeds can pick different verbs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(pickOutputVerb(`msg_${i}`));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('cross-pool independence (per-pool salt)', () => {
  test('cognitive and output indices for the same seed are decoupled', () => {
    // Without per-pool salting both pickers would hit the same
    // index in pools of equal size; with salts the two indices
    // are independent. Sample 100 ids and count how often the
    // two indices match. Pure coincidence rate is 1/5 (~20%);
    // a busted salt would push it to 100% (every seed couples
    // the verbs by position).
    let coupled = 0;
    for (let i = 0; i < 100; i++) {
      const seed = `msg_${i}`;
      const cognitiveIdx = COGNITIVE_VERB_POOL.indexOf(pickCognitiveVerb(seed));
      const outputIdx = OUTPUT_VERB_POOL.indexOf(pickOutputVerb(seed));
      if (cognitiveIdx === outputIdx) coupled += 1;
    }
    // 100% coupling indicates the salt isn't applied. Threshold
    // is generous: with proper independence the expected match
    // rate is ~20% for 5x5 pools; we accept anything below 60%
    // as "decoupled enough" (well above the all-coincide
    // failure mode, leaves room for normal hash variance).
    expect(coupled).toBeLessThan(60);
  });
});
