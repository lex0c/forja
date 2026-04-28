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
}

const parseArgs = (argv: readonly string[]): CliArgs => {
  let target = 'evals/smoke';
  let modelId: string | undefined;
  let perCaseTimeoutMs: number | undefined;
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
    if (a !== undefined && !a.startsWith('-')) {
      target = a;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  const result: CliArgs = { target };
  if (modelId !== undefined) result.modelId = modelId;
  if (perCaseTimeoutMs !== undefined) result.perCaseTimeoutMs = perCaseTimeoutMs;
  return result;
};

// Each case emits one NDJSON line on stdout (machine-readable);
// human progress + summary go to stderr. Mirrors the CLI's
// stdout-is-pure invariant.
const emitCaseLine = (result: EvalCaseResult): void => {
  const failedExpectations = result.expectations
    .filter((e) => !e.passed)
    .map((e) => ({ expectation: e.expectation, detail: e.detail ?? '' }));
  const line = {
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
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const emitSummaryLine = (summary: EvalSummary): void => {
  const line = { type: 'eval_summary', ...summary };
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const writeProgress = (caseDef: EvalCase, idx: number, total: number): void => {
  process.stderr.write(`[${idx + 1}/${total}] ${caseDef.name} ... `);
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

  const results: EvalCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (c === undefined) continue;
    writeProgress(c, i, cases.length);
    const r = await executeCase(c, opts);
    writeOutcome(r);
    emitCaseLine(r);
    results.push(r);
  }

  const summary = summarize(results);
  emitSummaryLine(summary);
  writeSummary(summary);

  // Exit code mirrors the test convention: 0 = all pass, 1 = any
  // case failed. Spec §16 calls for hard regression gating and
  // this is the hook CI will use.
  return summary.failed === 0 ? 0 : 1;
};

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
