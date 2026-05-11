import { describe, expect, test } from 'bun:test';
import { type FuzzCrash, type FuzzTarget, runFuzz } from '../../src/fuzz/index.ts';

// Minimal target that NEVER throws — used as the "happy-path"
// fixture. Input is a single number drawn from rng, format
// renders it, run is a no-op.
const noopTarget: FuzzTarget<number> = {
  name: 'noop',
  generate: (rng) => Math.floor(rng() * 1000),
  format: (input) => `n=${input}`,
  run: () => {},
};

// Target that throws on every iteration — pins crash-detection
// + report-shape behavior.
const alwaysThrowsTarget: FuzzTarget<number> = {
  name: 'always-throws',
  generate: (rng) => Math.floor(rng() * 1000),
  format: (input) => `n=${input}`,
  run: (input) => {
    throw new Error(`synthetic crash at ${input}`);
  },
};

// Target where generate() itself throws on certain rng draws.
// Verifies the harness handles generator failures separately
// from run() failures.
const generatorThrowsTarget: FuzzTarget<number> = {
  name: 'gen-throws',
  generate: () => {
    throw new Error('generator exploded');
  },
  format: (input) => `n=${input}`,
  run: () => {},
};

describe('runFuzz harness — basic shape', () => {
  test('runs N iterations + returns empty crashes on clean target', () => {
    const r = runFuzz({ target: noopTarget, iterations: 50, seed: 1 });
    expect(r.iterations).toBe(50);
    expect(r.crashes).toHaveLength(0);
    expect(r.baseSeed).toBe(1);
  });

  test('aggregates every crash when target always throws', () => {
    const r = runFuzz({ target: alwaysThrowsTarget, iterations: 10, seed: 1 });
    expect(r.crashes).toHaveLength(10);
    // Each crash has the iteration index + seed + formatted input.
    for (let i = 0; i < 10; i++) {
      const c = r.crashes[i];
      expect(c).toBeDefined();
      if (c === undefined) continue;
      expect(c.iteration).toBe(i);
      expect(c.seed).toBe((1 + i) >>> 0);
      expect(c.inputDisplay).toMatch(/^n=\d+/);
      expect(c.error).toMatch(/^synthetic crash at \d+$/);
    }
  });

  test('generator throws record as crashes with synthetic inputDisplay', () => {
    const r = runFuzz({ target: generatorThrowsTarget, iterations: 3, seed: 1 });
    expect(r.crashes).toHaveLength(3);
    for (const c of r.crashes) {
      expect(c.error).toMatch(/^generator:/);
      expect(c.inputDisplay).toBe('<generator threw>');
    }
  });
});

describe('runFuzz harness — determinism', () => {
  test('same seed → same crash sequence (reproducibility contract)', () => {
    // Half-crashes target: throws for even rng draws, passes for
    // odd. With fixed seed both runs must produce identical
    // crashes at identical iteration indices.
    const halfTarget: FuzzTarget<number> = {
      name: 'half',
      generate: (rng) => Math.floor(rng() * 100),
      format: (input) => `n=${input}`,
      run: (input) => {
        if (input % 2 === 0) throw new Error(`even ${input}`);
      },
    };
    const r1 = runFuzz({ target: halfTarget, iterations: 30, seed: 42 });
    const r2 = runFuzz({ target: halfTarget, iterations: 30, seed: 42 });
    expect(r1.crashes.length).toBe(r2.crashes.length);
    for (let i = 0; i < r1.crashes.length; i++) {
      const c1 = r1.crashes[i];
      const c2 = r2.crashes[i];
      expect(c1).toBeDefined();
      expect(c2).toBeDefined();
      if (c1 === undefined || c2 === undefined) continue;
      expect(c2.iteration).toBe(c1.iteration);
      expect(c2.seed).toBe(c1.seed);
      expect(c2.input).toBe(c1.input);
      expect(c2.error).toBe(c1.error);
    }
  });

  test('different seeds → different input sequences', () => {
    const inputs1: number[] = [];
    const t1: FuzzTarget<number> = {
      name: 't',
      generate: (rng) => {
        const n = Math.floor(rng() * 1_000_000);
        inputs1.push(n);
        return n;
      },
      format: (input) => `n=${input}`,
      run: () => {},
    };
    runFuzz({ target: t1, iterations: 20, seed: 100 });
    const inputs2: number[] = [];
    const t2: FuzzTarget<number> = {
      ...t1,
      generate: (rng) => {
        const n = Math.floor(rng() * 1_000_000);
        inputs2.push(n);
        return n;
      },
    };
    runFuzz({ target: t2, iterations: 20, seed: 999 });
    // At least one input must differ (the spaces would have to
    // collide perfectly across 20 mulberry32 draws to fail).
    expect(inputs1).not.toEqual(inputs2);
  });
});

describe('runFuzz harness — seams', () => {
  test('default seed uses now() seam', () => {
    const r = runFuzz({
      target: noopTarget,
      iterations: 1,
      now: () => 12345,
    });
    // When seed is omitted, baseSeed = now() at run start.
    expect(r.baseSeed).toBe(12345);
  });

  test('onCrash callback invoked once per crash as they happen', () => {
    const calls: FuzzCrash<number>[] = [];
    const r = runFuzz({
      target: alwaysThrowsTarget,
      iterations: 5,
      seed: 1,
      onCrash: (c) => calls.push(c),
    });
    expect(calls).toHaveLength(5);
    // Same crash list as the aggregated result.
    expect(calls).toEqual([...r.crashes]);
  });

  test('durationMs is the delta between now() at start + end', () => {
    let calls = 0;
    const r = runFuzz({
      target: noopTarget,
      iterations: 10,
      seed: 1,
      // First call → start (returns 1000). Second call → end
      // (returns 1250). Delta = 250ms.
      now: () => {
        calls++;
        return calls === 1 ? 1000 : 1250;
      },
    });
    expect(r.durationMs).toBe(250);
  });
});
