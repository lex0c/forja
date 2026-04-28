import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ExecuteOptions, executeCase, summarize } from './executor.ts';
import { loadEvalCase } from './loader.ts';
import type { EvalCase, EvalCaseResult, EvalSummary } from './types.ts';

// Discover all *.yaml/*.yml files under a directory tree. The
// runner stays uncoupled from any naming convention beyond
// extension; nested folders by tier (`smoke/`, `regression/`)
// are caller's choice.
const discoverCases = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(ya?ml)$/i.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
};

interface CliArgs {
  // Either a directory of YAML cases or a single YAML file. When
  // omitted, defaults to `evals/smoke` relative to cwd.
  target: string;
  modelId?: string;
  perCaseTimeoutMs?: number;
  // Number of rounds — each round runs every case once. When >1,
  // the runner reports per-case variance (pass count, cost range)
  // alongside aggregate stats. Used to validate stability of the
  // smoke baseline before declaring it "trusted." Round-major
  // ordering means later rounds may benefit from prompt-cache
  // hits; that's intentional — it shows real-world cost behavior.
  repeat: number;
}

const parseArgs = (argv: readonly string[]): CliArgs => {
  let target = 'evals/smoke';
  let modelId: string | undefined;
  let perCaseTimeoutMs: number | undefined;
  let repeat = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') {
      modelId = argv[++i];
      continue;
    }
    if (a === '--timeout-ms') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      perCaseTimeoutMs = v;
      continue;
    }
    if (a === '--repeat') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) {
        throw new Error('--repeat must be a positive integer');
      }
      repeat = v;
      continue;
    }
    if (a !== undefined && !a.startsWith('-')) {
      target = a;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  const result: CliArgs = { target, repeat };
  if (modelId !== undefined) result.modelId = modelId;
  if (perCaseTimeoutMs !== undefined) result.perCaseTimeoutMs = perCaseTimeoutMs;
  return result;
};

interface CaseAggregate {
  name: string;
  sourcePath: string;
  runs: EvalCaseResult[];
}

const aggregateLine = (agg: CaseAggregate): Record<string, unknown> => {
  const passCount = agg.runs.filter((r) => r.passed).length;
  const costs = agg.runs.map((r) => r.costUsd);
  const durations = agg.runs.map((r) => r.durationMs);
  return {
    type: 'eval_case_aggregate',
    name: agg.name,
    sourcePath: agg.sourcePath,
    runs: agg.runs.length,
    passCount,
    failCount: agg.runs.length - passCount,
    costMin: Math.min(...costs),
    costMax: Math.max(...costs),
    costAvg: costs.reduce((a, b) => a + b, 0) / costs.length,
    durationMinMs: Math.min(...durations),
    durationMaxMs: Math.max(...durations),
  };
};

// Each case emits one NDJSON line on stdout (machine-readable);
// human progress + summary go to stderr. Mirrors the CLI's
// stdout-is-pure invariant. The optional `run` field tags lines
// emitted under --repeat so consumers can re-aggregate.
const emitCaseLine = (result: EvalCaseResult, run?: { index: number; total: number }): void => {
  const failedExpectations = result.expectations
    .filter((e) => !e.passed)
    .map((e) => ({ expectation: e.expectation, detail: e.detail ?? '' }));
  const line: Record<string, unknown> = {
    type: 'eval_case',
    name: result.name,
    sourcePath: result.sourcePath,
    passed: result.passed,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    steps: result.steps,
    usageComplete: result.usageComplete,
    status: result.status,
    exitReason: result.exitReason,
    failure: result.failure,
    failedExpectations,
  };
  if (run !== undefined) {
    line.run = run.index;
    line.totalRuns = run.total;
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const emitAggregateLine = (agg: CaseAggregate): void => {
  process.stdout.write(`${JSON.stringify(aggregateLine(agg))}\n`);
};

const emitSummaryLine = (summary: EvalSummary): void => {
  const line = { type: 'eval_summary', ...summary };
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const writeProgress = (
  caseDef: EvalCase,
  idx: number,
  total: number,
  run?: { index: number; total: number },
): void => {
  const tag = run === undefined ? '' : ` (run ${run.index}/${run.total})`;
  process.stderr.write(`[${idx + 1}/${total}]${tag} ${caseDef.name} ... `);
};

const writeOutcome = (result: EvalCaseResult): void => {
  const tag = result.passed ? 'pass' : 'fail';
  const cost = result.costUsd > 0 ? ` $${result.costUsd.toFixed(4)}` : '';
  process.stderr.write(`${tag} (${result.durationMs}ms${cost})\n`);
  if (!result.passed) {
    if (result.failure !== undefined) {
      process.stderr.write(`  ! ${result.failure}\n`);
    }
    for (const e of result.expectations) {
      if (!e.passed && e.detail !== undefined) {
        process.stderr.write(`  - ${e.detail}\n`);
      }
    }
  }
};

const writeVariance = (aggregates: readonly CaseAggregate[]): void => {
  process.stderr.write('\nper-case stability:\n');
  for (const agg of aggregates) {
    const passes = agg.runs.filter((r) => r.passed).length;
    const total = agg.runs.length;
    const costs = agg.runs.map((r) => r.costUsd);
    const min = Math.min(...costs);
    const max = Math.max(...costs);
    const flag = passes === total ? ' ' : '!';
    process.stderr.write(
      `  ${flag} ${passes}/${total}  $${min.toFixed(4)}–$${max.toFixed(4)}  ${agg.name}\n`,
    );
  }
};

const writeSummary = (summary: EvalSummary): void => {
  const pct = (summary.passRate * 100).toFixed(1);
  process.stderr.write('\n');
  process.stderr.write(
    `${summary.passed}/${summary.total} passed (${pct}%) — total $${summary.totalCostUsd.toFixed(4)}, ${summary.totalDurationMs}ms\n`,
  );
  if (summary.p50CostUsd !== undefined) {
    process.stderr.write(`p50 cost: $${summary.p50CostUsd.toFixed(4)}\n`);
  }
};

export const main = async (argv: readonly string[]): Promise<number> => {
  let parsed: CliArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`forja eval: ${msg}\n`);
    return 1;
  }

  const target = resolve(parsed.target);
  let casePaths: string[];
  try {
    const stat = statSync(target);
    casePaths = stat.isDirectory() ? discoverCases(target) : [target];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`forja eval: ${msg}\n`);
    return 1;
  }

  if (casePaths.length === 0) {
    process.stderr.write(`forja eval: no eval cases found under ${target}\n`);
    return 1;
  }

  const cases = casePaths.map((p) => loadEvalCase(p));
  const opts: ExecuteOptions = {};
  if (parsed.perCaseTimeoutMs !== undefined) opts.perCaseTimeoutMs = parsed.perCaseTimeoutMs;
  if (parsed.modelId !== undefined) {
    opts.bootstrapOverride = { modelId: parsed.modelId };
  }

  // Round-major ordering: every case runs once per round. Lets
  // later rounds benefit from prompt-cache hits the way real
  // production traffic would; case-major would understate cost
  // by serving back-to-back identical prompts to a cold cache.
  const aggregates = new Map<string, CaseAggregate>();
  const allResults: EvalCaseResult[] = [];

  for (let round = 1; round <= parsed.repeat; round++) {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (c === undefined) continue;
      const runMeta = parsed.repeat > 1 ? { index: round, total: parsed.repeat } : undefined;
      writeProgress(c, i, cases.length, runMeta);
      const r = await executeCase(c, opts);
      writeOutcome(r);
      emitCaseLine(r, runMeta);
      allResults.push(r);
      const agg = aggregates.get(c.sourcePath) ?? {
        name: c.name,
        sourcePath: c.sourcePath,
        runs: [],
      };
      agg.runs.push(r);
      aggregates.set(c.sourcePath, agg);
    }
  }

  const aggList = [...aggregates.values()];
  if (parsed.repeat > 1) {
    for (const agg of aggList) emitAggregateLine(agg);
  }

  const summary = summarize(allResults);
  emitSummaryLine(summary);
  writeSummary(summary);

  if (parsed.repeat > 1) writeVariance(aggList);

  // Exit code mirrors the test convention: 0 = all pass, 1 = any
  // case failed. Spec §16 calls for hard regression gating and
  // this is the hook CI will use.
  return summary.failed === 0 ? 0 : 1;
};

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
