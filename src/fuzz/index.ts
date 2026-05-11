// Fuzz harness — PERMISSION_ENGINE.md §15.4 (lines 1114-1122).
//
// Production-ready checklist line 1289 demands "Fuzz harness 10⁹
// iterations sem crash novo entre releases". This module ships
// the infrastructure: a deterministic, target-agnostic runner
// that exercises a `FuzzTarget` with seeded inputs and reports
// crashes with full reproducibility metadata.
//
// Spec line 1117-1120 enumerates the four required targets:
//   - glob compiler        (random byte strings → no panic, no OOB)
//   - bash resolver        (random shell snippets → no panic;
//                           always Conservative or Refuse on weird
//                           inputs)
//   - policy parser        (random TOML → no crash)
//   - hash chain verify    (corrupted rows → state=refusing, no panic)
//
// Slice 66 ships the harness + the glob target. Bash / policy /
// chain targets land in follow-up slices.
//
// Reproducibility contract: every crash report includes the
// `seed` that produced it. An operator can re-run the harness
// with that exact seed and deterministically reproduce the
// failing input. Without this, fuzz crashes would be
// non-actionable.

import { mulberry32 } from './random.ts';

// A crash detected by the harness — either an explicit throw
// from the target, or an invariant violation the target's `run`
// function expressed as a thrown error.
export interface FuzzCrash<I> {
  // Iteration index within this run (0-based). Useful for
  // narrowing down WHEN a crash occurred in a long run.
  iteration: number;
  // Per-iteration seed = `baseSeed + iteration`. Re-running with
  // this seed reproduces the failing input deterministically.
  seed: number;
  // The raw input that triggered the crash. Tests inspect this
  // directly; CI logs render via `inputDisplay`.
  input: I;
  // Human-readable rendering of `input` for crash reports —
  // matches the target's `format()` output. Safe to print in
  // CI logs (no binary noise; structured key=value pairs).
  inputDisplay: string;
  // Error message from the target's throw. Stack frame not
  // captured here — operators reading CI logs care about the
  // failure shape, not the implementation backtrace.
  error: string;
}

export interface FuzzResult<I> {
  iterations: number;
  crashes: readonly FuzzCrash<I>[];
  durationMs: number;
  // The base seed used. Echo in run summaries so a reproducible
  // re-run is one command away.
  baseSeed: number;
}

// A fuzz target is the contract between the harness and the
// code-under-test. Targets self-validate invariants: if the
// target's `run` returns successfully WITHOUT throwing, the
// iteration is considered a pass. Any throw — whether from the
// code-under-test or from the target's own assertions — is a
// crash.
//
// `generate` is deterministic per `rng` state, so the harness
// can guarantee that "seed N" always produces the same input
// regardless of when or where the harness runs.
export interface FuzzTarget<I> {
  name: string;
  generate(rng: () => number): I;
  format(input: I): string;
  run(input: I): void;
}

export interface FuzzRunOptions<I> {
  target: FuzzTarget<I>;
  iterations: number;
  // Starting seed. The harness derives per-iteration seeds as
  // `seed + iteration`. Defaults to `Date.now()` for ad-hoc runs;
  // CI passes a fixed seed for stable cross-run comparison.
  seed?: number;
  // Called on every crash AS IT HAPPENS. Default: aggregate into
  // the result. Tests use this to capture crashes mid-run; CI
  // wrappers use it to stream crash reports to stderr without
  // waiting for the full run to finish.
  onCrash?: (crash: FuzzCrash<I>) => void;
  // Wall-clock seam for tests. Production: Date.now(); tests pin
  // a fixed-delta function so `durationMs` is deterministic.
  now?: () => number;
}

export const runFuzz = <I>(options: FuzzRunOptions<I>): FuzzResult<I> => {
  const now = options.now ?? Date.now;
  // Default seed flows through the `now` seam so tests can pin a
  // fully-deterministic harness (seed + duration both stable).
  // Production: now() === Date.now() so the default seed is wall-
  // clock-derived as the operator expects.
  const baseSeed = options.seed ?? now();
  const startMs = now();
  const crashes: FuzzCrash<I>[] = [];
  for (let i = 0; i < options.iterations; i++) {
    const seed = (baseSeed + i) >>> 0;
    const rng = mulberry32(seed);
    let input: I;
    try {
      input = options.target.generate(rng);
    } catch (e) {
      // Generator itself threw — record as a crash with a
      // synthetic inputDisplay since we have no input to format.
      const crash: FuzzCrash<I> = {
        iteration: i,
        seed,
        input: undefined as unknown as I,
        inputDisplay: '<generator threw>',
        error: `generator: ${e instanceof Error ? e.message : String(e)}`,
      };
      crashes.push(crash);
      options.onCrash?.(crash);
      continue;
    }
    try {
      options.target.run(input);
    } catch (e) {
      const crash: FuzzCrash<I> = {
        iteration: i,
        seed,
        input,
        inputDisplay: options.target.format(input),
        error: e instanceof Error ? e.message : String(e),
      };
      crashes.push(crash);
      options.onCrash?.(crash);
    }
  }
  return {
    iterations: options.iterations,
    crashes,
    durationMs: now() - startMs,
    baseSeed,
  };
};
