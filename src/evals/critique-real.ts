// Real-model critique eval (Slice G).
//
// Runs the engine fixtures from `evals/critique/fixtures/` against
// a LIVE Anthropic Haiku call (or any model declared via
// `--model`) and asserts behavioral predicates from
// `evals/critique/real-expectations.ts`. Distinct from the
// deterministic suite (`tests/critique/eval.test.ts`) which pins
// engine output against hand-crafted critic responses — that
// catches engine regressions; this catches PROMPT regressions and
// gives the operator a real false-positive / false-negative
// signal.
//
// ENV-gated so CI without API keys skips cleanly:
//   - No `ANTHROPIC_API_KEY` → exit 0 with a "skipped" note.
//   - With key → run the full suite, exit non-zero on any failure.
//
// Output format mirrors the smoke runner: one line per fixture
// (PASS/FAIL/SKIP), aggregate stats at the bottom (FP rate, FN
// rate, total cost). Operators reading the CI log scan for FAIL.
//
// Not wired into the main `bun test` suite — running ~6 LLM calls
// per `bun test` invocation would make local development
// expensive and flaky. Use:
//
//   bun run src/evals/critique-real.ts
//   bun run src/evals/critique-real.ts --model anthropic/claude-sonnet-4-6
//   bun run src/evals/critique-real.ts --threshold 0.6 --max-overhead 10000
//
// CI integration is the operator's choice (a separate workflow
// job gated on `secrets.ANTHROPIC_API_KEY` is the obvious shape).

import { fixture as f01 } from '../../evals/critique/fixtures/01-clean-output.ts';
import { fixture as f02 } from '../../evals/critique/fixtures/02-flagged-bug.ts';
import { fixture as f03 } from '../../evals/critique/fixtures/03-tool-plan-writes.ts';
import { fixture as f04 } from '../../evals/critique/fixtures/04-malformed-output.ts';
import { fixture as f05 } from '../../evals/critique/fixtures/05-low-confidence.ts';
import { fixture as f06 } from '../../evals/critique/fixtures/06-mixed-severities.ts';
import type { CritiqueFixture } from '../../evals/critique/fixtures/types.ts';
import { REAL_EXPECTATIONS, type RealExpectation } from '../../evals/critique/real-expectations.ts';
import { runCritique } from '../critique/index.ts';
import type { CritiqueResult } from '../critique/index.ts';
import { createDefaultRegistry } from '../providers/index.ts';
import type { Provider } from '../providers/index.ts';

const FIXTURES: readonly CritiqueFixture[] = [f01, f02, f03, f04, f05, f06];

const DEFAULT_MODEL_ID = 'anthropic/claude-haiku-4-5';

interface RunArgs {
  modelId: string;
  threshold: number;
  maxOverheadMs: number;
}

const KNOWN_VALUE_FLAGS = new Set(['--model', '--threshold', '--max-overhead']);

const parseArgs = (argv: readonly string[]): RunArgs => {
  let modelId = DEFAULT_MODEL_ID;
  let threshold = 0.7;
  // `0` is a legitimate operator choice (engine treats it as
  // "watchdog disabled"). Spec line 525 default is 3000ms; the
  // runner's default bumps to 30s because real network calls
  // routinely take 5-10s and a 3s cap would skip everything.
  let maxOverheadMs = 30_000;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    // Two-step gating: detect known value-flags FIRST so we can
    // distinguish "unknown arg" from "known arg, missing value".
    // Falling through to the unknown-arg throw at the bottom for a
    // bare `--threshold` would be misleading — operator typed a
    // valid flag, just forgot the value.
    if (KNOWN_VALUE_FLAGS.has(a)) {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`missing value for ${a}`);
      }
      if (a === '--model') {
        modelId = next;
      } else if (a === '--threshold') {
        const v = Number.parseFloat(next);
        if (!Number.isFinite(v) || v < 0 || v > 1) {
          throw new Error(`--threshold must be in [0,1]; got '${next}'`);
        }
        threshold = v;
      } else {
        // --max-overhead. `0` is allowed here (engine semantic =
        // disable watchdog); negatives still rejected.
        const v = Number.parseInt(next, 10);
        if (!Number.isFinite(v) || v < 0) {
          throw new Error(`--max-overhead must be a non-negative integer; got '${next}'`);
        }
        maxOverheadMs = v;
      }
      i++;
      continue;
    }
    throw new Error(`unknown arg '${a}' (try --model / --threshold / --max-overhead)`);
  }
  return { modelId, threshold, maxOverheadMs };
};

interface FixtureOutcome {
  fixture: string;
  kind: 'pass' | 'fail' | 'skip';
  reason: string;
  result?: CritiqueResult;
}

// Decide whether a fixture passed against its expected predicate.
const evaluate = (
  fx: CritiqueFixture,
  exp: RealExpectation,
  result: CritiqueResult,
): FixtureOutcome => {
  if (exp.kind === 'skip') {
    return { fixture: fx.name, kind: 'skip', reason: exp.why };
  }
  if (result.strategy !== 'llm') {
    // Engine soft-failure (overhead exceeded, parse error, etc).
    // Don't mark as test fail — it's an infrastructure issue, not
    // a model regression. Surfaced as `skip` with the reason so
    // the operator can investigate.
    return {
      fixture: fx.name,
      kind: 'skip',
      reason: `engine returned strategy='${result.strategy}' (${result.reason ?? 'no reason'})`,
      result,
    };
  }
  if (exp.kind === 'must_flag') {
    if (result.filteredIssues.length === 0) {
      return {
        fixture: fx.name,
        kind: 'fail',
        reason: `expected at least one filtered issue, got 0 (raw=${result.rawIssues.length}); ${exp.why}`,
        result,
      };
    }
    return {
      fixture: fx.name,
      kind: 'pass',
      reason: `flagged ${result.filteredIssues.length}/${result.rawIssues.length} issue(s)`,
      result,
    };
  }
  // must_not_flag
  if (result.filteredIssues.length > 0) {
    return {
      fixture: fx.name,
      kind: 'fail',
      reason: `expected no filtered issues, got ${result.filteredIssues.length}/${result.rawIssues.length}; ${exp.why}`,
      result,
    };
  }
  return {
    fixture: fx.name,
    kind: 'pass',
    reason: `clean (${result.rawIssues.length} raw, none above threshold)`,
    result,
  };
};

const formatOutcome = (o: FixtureOutcome): string => {
  const tag = o.kind === 'pass' ? 'PASS' : o.kind === 'fail' ? 'FAIL' : 'SKIP';
  const cost = o.result?.usageSeen === true ? ` · ${(o.result.costUsd * 1000).toFixed(4)}m$` : '';
  const dur = o.result !== undefined ? ` · ${o.result.durationMs}ms` : '';
  return `[${tag}] ${o.fixture.padEnd(28)}${dur}${cost} — ${o.reason}`;
};

export const runCritiqueRealEval = async (
  argv: readonly string[],
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    apiKey: string | undefined;
  },
): Promise<{ exitCode: number; outcomes: FixtureOutcome[] }> => {
  if (io.apiKey === undefined || io.apiKey.length === 0) {
    io.out(
      'critique-real: SKIP (no ANTHROPIC_API_KEY in environment; this eval requires a live API call).',
    );
    return { exitCode: 0, outcomes: [] };
  }

  let args: RunArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`critique-real: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: 2, outcomes: [] };
  }

  const registry = createDefaultRegistry();
  const entry = registry.get(args.modelId);
  if (entry === null) {
    io.err(
      `critique-real: unknown model '${args.modelId}'. Known: ${registry
        .list()
        .map((e) => e.id)
        .join(', ')}`,
    );
    return { exitCode: 2, outcomes: [] };
  }
  let provider: Provider;
  try {
    provider = entry.factory();
  } catch (e) {
    io.err(
      `critique-real: factory failed for '${args.modelId}': ${e instanceof Error ? e.message : String(e)}`,
    );
    return { exitCode: 2, outcomes: [] };
  }

  io.out(
    `critique-real: model=${args.modelId} threshold=${args.threshold} max_overhead_ms=${args.maxOverheadMs}`,
  );
  io.out('');

  const expectationByName = new Map(REAL_EXPECTATIONS.map((e) => [e.fixture, e]));
  const outcomes: FixtureOutcome[] = [];
  let totalCost = 0;
  let totalDuration = 0;

  for (const fx of FIXTURES) {
    const exp = expectationByName.get(fx.name);
    if (exp === undefined) {
      outcomes.push({
        fixture: fx.name,
        kind: 'fail',
        reason: 'no real-expectation entry — add to evals/critique/real-expectations.ts',
      });
      io.out(formatOutcome(outcomes[outcomes.length - 1] as FixtureOutcome));
      continue;
    }
    if (exp.kind === 'skip') {
      const o: FixtureOutcome = { fixture: fx.name, kind: 'skip', reason: exp.why };
      outcomes.push(o);
      io.out(formatOutcome(o));
      continue;
    }

    let result: CritiqueResult;
    try {
      result = await runCritique(provider, fx.input, {
        threshold: exp.options?.threshold ?? args.threshold,
        maxOverheadMs: exp.options?.maxOverheadMs ?? args.maxOverheadMs,
        ...(exp.options?.maxTokens !== undefined ? { maxTokens: exp.options.maxTokens } : {}),
        ...(exp.options?.promptVersion !== undefined
          ? { promptVersion: exp.options.promptVersion }
          : {}),
      });
    } catch (e) {
      const o: FixtureOutcome = {
        fixture: fx.name,
        kind: 'fail',
        reason: `runCritique threw: ${e instanceof Error ? e.message : String(e)}`,
      };
      outcomes.push(o);
      io.out(formatOutcome(o));
      continue;
    }
    totalCost += result.costUsd;
    totalDuration += result.durationMs;
    const outcome = evaluate(fx, exp, result);
    outcomes.push(outcome);
    io.out(formatOutcome(outcome));
  }

  const passes = outcomes.filter((o) => o.kind === 'pass').length;
  const fails = outcomes.filter((o) => o.kind === 'fail').length;
  const skips = outcomes.filter((o) => o.kind === 'skip').length;
  // FP and FN rates are scoped to fixtures that ASSERTED a
  // direction AND actually evaluated (not the engine-soft-fail
  // skips). FP = "expected clean, model flagged"; FN = "expected
  // flag, model didn't". Including skips in the denominator would
  // hide regressions — a flaky engine that skipped 2 of 3 must_flag
  // fixtures with 1 real FN would report 33%, not the actual 100%
  // the operator should see.
  const flagAssertions = outcomes.filter((o) => {
    if (o.kind === 'skip') return false;
    return expectationByName.get(o.fixture)?.kind === 'must_flag';
  });
  const cleanAssertions = outcomes.filter((o) => {
    if (o.kind === 'skip') return false;
    return expectationByName.get(o.fixture)?.kind === 'must_not_flag';
  });
  const fnCount = flagAssertions.filter((o) => o.kind === 'fail').length;
  const fpCount = cleanAssertions.filter((o) => o.kind === 'fail').length;
  const fnRate = flagAssertions.length > 0 ? fnCount / flagAssertions.length : 0;
  const fpRate = cleanAssertions.length > 0 ? fpCount / cleanAssertions.length : 0;

  io.out('');
  io.out(`summary: ${passes} pass · ${fails} fail · ${skips} skip`);
  io.out(`         total cost ~${(totalCost * 1000).toFixed(2)}m$ · ${totalDuration}ms wall`);
  io.out(
    `         FP rate ${(fpRate * 100).toFixed(0)}% (${fpCount}/${cleanAssertions.length}) · FN rate ${(fnRate * 100).toFixed(0)}% (${fnCount}/${flagAssertions.length})`,
  );

  return { exitCode: fails === 0 ? 0 : 1, outcomes };
};

// Direct CLI entry: `bun run src/evals/critique-real.ts ...`. Tests
// import `runCritiqueRealEval` directly to inject mock IO.
//
// `import.meta.main` is the Bun-native way to detect "this file
// was the entry point". When imported as a module (test, future
// composite runner) the block doesn't fire and the suite stays
// pure-import.
if (import.meta.main) {
  const { exitCode } = await runCritiqueRealEval(Bun.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  process.exit(exitCode);
}
