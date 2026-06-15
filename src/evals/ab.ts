import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type ExecuteOptions, executeCase } from './executor.ts';
import { loadEvalCase } from './loader.ts';
import type { EvalCase, EvalCaseResult } from './types.ts';

// Phase 4 — reasoning-replay A/B runner.
//
// Runs an eval target K times with FORJA_<PROVIDER>_REASONING_REPLAY OFF, then K
// times with it ON, and reports the pass-rate / cost / step deltas per provider.
// This is the GATE the #25 revert asked for: replay flips a default only on a
// measurable positive delta on a long-horizon eval; zero delta keeps it OFF (the
// #25 disposition, now migration-free so the abstraction stays dormant at
// near-zero cost). The runner only MEASURES — it never flips a default itself.

// The env flag is read by the provider factory at construction; `executeCase`
// builds a fresh provider per run, so flipping the flag around an arm is enough.
const REPLAY_FLAG: Record<string, string> = {
  anthropic: 'FORJA_ANTHROPIC_REASONING_REPLAY',
  openai: 'FORJA_OPENAI_REASONING_REPLAY',
};

// Resolve the replay flag a model's provider family honors. Only Anthropic and
// OpenAI wire reasoning replay today; anything else has no flag to flip and the
// A/B would compare two identical arms — fail loud instead.
export const flagForModel = (modelId: string): string => {
  const family = modelId.split('/')[0] ?? '';
  const flag = REPLAY_FLAG[family];
  if (flag === undefined) {
    throw new Error(
      `reasoning-replay A/B is only defined for anthropic/* and openai/* models; got '${modelId}'`,
    );
  }
  return flag;
};

export interface ArmStats {
  arm: 'off' | 'on';
  total: number;
  passCount: number;
  passRate: number; // [0, 1]
  costAvg: number;
  stepsAvg: number;
  durationAvg: number;
}

// Pure aggregation over an arm's runs — unit-testable without any provider.
export const aggregateArm = (arm: 'off' | 'on', runs: readonly EvalCaseResult[]): ArmStats => {
  const total = runs.length;
  const passCount = runs.filter((r) => r.passed).length;
  const div = total === 0 ? 1 : total;
  const sum = (sel: (r: EvalCaseResult) => number): number => runs.reduce((a, r) => a + sel(r), 0);
  return {
    arm,
    total,
    passCount,
    passRate: total === 0 ? 0 : passCount / total,
    costAvg: sum((r) => r.costUsd) / div,
    stepsAvg: sum((r) => r.steps) / div,
    durationAvg: sum((r) => r.durationMs) / div,
  };
};

export interface AbDelta {
  passRate: number; // on - off, in [-1, 1]
  costAvg: number;
  stepsAvg: number;
}

export const deltaOf = (off: ArmStats, on: ArmStats): AbDelta => ({
  passRate: on.passRate - off.passRate,
  costAvg: on.costAvg - off.costAvg,
  stepsAvg: on.stepsAvg - off.stepsAvg,
});

export interface AbResult {
  flag: string;
  repeat: number;
  caseCount: number;
  off: ArmStats;
  on: ArmStats;
  delta: AbDelta;
}

// Flip an env flag for the duration of an async batch, restoring the prior value
// (including the unset case) afterward — even on throw.
const withFlag = async <T>(flag: string, on: boolean, fn: () => Promise<T>): Promise<T> => {
  const prev = process.env[flag];
  if (on) process.env[flag] = '1';
  else delete process.env[flag];
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[flag];
    else process.env[flag] = prev;
  }
};

export type ArmRunHook = (
  arm: 'off' | 'on',
  round: number,
  caseDef: EvalCase,
  result: EvalCaseResult,
) => void;

const runArm = async (
  arm: 'off' | 'on',
  cases: readonly EvalCase[],
  repeat: number,
  execute: ExecuteOptions,
  onRun?: ArmRunHook,
): Promise<EvalCaseResult[]> => {
  const runs: EvalCaseResult[] = [];
  for (let round = 1; round <= repeat; round++) {
    for (const c of cases) {
      const r = await executeCase(c, execute);
      runs.push(r);
      onRun?.(arm, round, c, r);
    }
  }
  return runs;
};

export interface RunAbOptions {
  cases: EvalCase[];
  flag: string;
  repeat: number;
  // Base execute options (model id / provider override / timeout). The flag is
  // layered on top per arm.
  execute?: ExecuteOptions;
  onRun?: ArmRunHook;
}

export interface RunAbOutput {
  result: AbResult;
  offRuns: EvalCaseResult[];
  onRuns: EvalCaseResult[];
}

// Run both arms (OFF baseline first, then ON) and aggregate. The OFF arm runs
// with the flag explicitly UNSET so a flag already exported in the operator's
// shell can't contaminate the baseline.
export const runAbComparison = async (opts: RunAbOptions): Promise<RunAbOutput> => {
  const execute = opts.execute ?? {};
  const offRuns = await withFlag(opts.flag, false, () =>
    runArm('off', opts.cases, opts.repeat, execute, opts.onRun),
  );
  const onRuns = await withFlag(opts.flag, true, () =>
    runArm('on', opts.cases, opts.repeat, execute, opts.onRun),
  );
  const off = aggregateArm('off', offRuns);
  const on = aggregateArm('on', onRuns);
  return {
    result: {
      flag: opts.flag,
      repeat: opts.repeat,
      caseCount: opts.cases.length,
      off,
      on,
      delta: deltaOf(off, on),
    },
    offRuns,
    onRuns,
  };
};

// One-line, factual verdict. Deliberately conservative: ON must be STRICTLY
// better on pass-rate to be called a candidate, mirroring the gate rule (flip a
// default only on a measurable positive delta). Ties / regressions keep OFF.
export const verdictLine = (r: AbResult): string => {
  const pp = (r.delta.passRate * 100).toFixed(1);
  if (r.delta.passRate > 0) {
    return `replay ON improved pass-rate by ${pp}pp (${r.off.passCount}/${r.off.total} → ${r.on.passCount}/${r.on.total}) — candidate for flipping ${r.flag} default; confirm with a larger K and a live wire smoke before flipping.`;
  }
  if (r.delta.passRate < 0) {
    return `replay ON regressed pass-rate by ${pp}pp — keep ${r.flag} default OFF.`;
  }
  return `no pass-rate delta (${r.on.passCount}/${r.on.total} both arms) — keep ${r.flag} default OFF (the #25 disposition); a longer chain or larger K may be needed to surface a signal.`;
};

// ---- CLI ----

const discoverCases = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(ya?ml)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
};

export interface AbCliArgs {
  target: string;
  modelId: string;
  repeat: number;
  perCaseTimeoutMs?: number;
  // Extended-thinking budget (tokens). REQUIRED for a meaningful Anthropic A/B:
  // the adapter only emits signed thinking blocks when thinking_budget > 0, so
  // without it the OFF and ON arms are identical (nothing captured to replay) and
  // the run would report a false "no delta". Ignored by OpenAI (it uses
  // reasoning.effort), so harmless to set on the default cross-provider command.
  thinkingBudget?: number;
}

const expectValue = (argv: readonly string[], i: number, flag: string): string => {
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('-')) throw new Error(`${flag} requires a value`);
  return next;
};

export const parseArgs = (argv: readonly string[]): AbCliArgs => {
  let target = 'evals/long-horizon';
  let modelId: string | undefined;
  let repeat = 5;
  let perCaseTimeoutMs: number | undefined;
  let thinkingBudget: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') {
      modelId = expectValue(argv, i, '--model');
      i += 1;
      continue;
    }
    if (a === '--repeat') {
      const v = Number(expectValue(argv, i, '--repeat'));
      i += 1;
      if (!Number.isInteger(v) || v < 1) throw new Error('--repeat must be a positive integer');
      repeat = v;
      continue;
    }
    if (a === '--timeout-ms') {
      const v = Number(expectValue(argv, i, '--timeout-ms'));
      i += 1;
      if (!Number.isFinite(v) || v <= 0) throw new Error('--timeout-ms must be a positive number');
      perCaseTimeoutMs = v;
      continue;
    }
    if (a === '--thinking-budget') {
      const v = Number(expectValue(argv, i, '--thinking-budget'));
      i += 1;
      if (!Number.isInteger(v) || v < 1) {
        throw new Error('--thinking-budget must be a positive integer');
      }
      thinkingBudget = v;
      continue;
    }
    if (a !== undefined && !a.startsWith('-')) {
      target = a;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  if (modelId === undefined) {
    throw new Error('--model is required (the A/B needs a real provider to flip the replay flag)');
  }
  const result: AbCliArgs = { target, modelId, repeat };
  if (perCaseTimeoutMs !== undefined) result.perCaseTimeoutMs = perCaseTimeoutMs;
  if (thinkingBudget !== undefined) result.thinkingBudget = thinkingBudget;
  return result;
};

const emit = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const fmtArm = (s: ArmStats): string =>
  `${s.passCount}/${s.total} (${(s.passRate * 100).toFixed(1)}%)  steps~${s.stepsAvg.toFixed(1)}  $${s.costAvg.toFixed(4)}/run`;

export const main = async (argv: readonly string[]): Promise<number> => {
  let parsed: AbCliArgs;
  let flag: string;
  try {
    parsed = parseArgs(argv);
    flag = flagForModel(parsed.modelId);
  } catch (e) {
    process.stderr.write(`forja eval:ab: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const target = resolve(parsed.target);
  let cases: EvalCase[];
  try {
    const stat = statSync(target);
    const paths = stat.isDirectory() ? discoverCases(target) : [target];
    if (paths.length === 0) {
      process.stderr.write(`forja eval:ab: no eval cases found under ${target}\n`);
      return 1;
    }
    cases = paths.map((p) => loadEvalCase(p));
  } catch (e) {
    process.stderr.write(`forja eval:ab: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  if (parsed.repeat < 5) {
    process.stderr.write(
      `forja eval:ab: warning — K=${parsed.repeat} is low signal; use --repeat 10+ before trusting a delta.\n`,
    );
  }
  // Anthropic only emits signed thinking blocks when thinking_budget > 0, so an
  // Anthropic A/B with no budget captures nothing — both arms are identical and
  // the run reports a FALSE "no delta". Refuse to run that misleading comparison.
  if (
    flag === 'FORJA_ANTHROPIC_REASONING_REPLAY' &&
    (parsed.thinkingBudget === undefined || parsed.thinkingBudget <= 0)
  ) {
    process.stderr.write(
      'forja eval:ab: Anthropic reasoning replay needs --thinking-budget <tokens> (> 0) to engage thinking; without it no signed thinking blocks are produced and the OFF/ON arms are identical (a false "no delta"). Re-run with e.g. --thinking-budget 2048.\n',
    );
    return 1;
  }
  process.stderr.write(
    `A/B reasoning replay: ${parsed.modelId} (${flag}), ${cases.length} case(s) × ${parsed.repeat} round(s) per arm${
      parsed.thinkingBudget !== undefined ? `, thinking_budget=${parsed.thinkingBudget}` : ''
    }\n`,
  );

  const execute: ExecuteOptions = {
    bootstrapOverride: {
      modelId: parsed.modelId,
      ...(parsed.thinkingBudget !== undefined ? { thinkingBudget: parsed.thinkingBudget } : {}),
    },
  };
  if (parsed.perCaseTimeoutMs !== undefined) execute.perCaseTimeoutMs = parsed.perCaseTimeoutMs;

  const { result } = await runAbComparison({
    cases,
    flag,
    repeat: parsed.repeat,
    execute,
    onRun: (arm, round, c, r) => {
      emit({
        type: 'ab_run',
        arm,
        round,
        name: c.name,
        passed: r.passed,
        steps: r.steps,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        status: r.status,
        exitReason: r.exitReason,
        // Surface the provider/diagnostic message on failure so a regression
        // (e.g. a replay 400) is debuggable from the NDJSON without a re-run.
        ...(r.failure !== undefined ? { failure: r.failure } : {}),
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
      });
      const tag = r.passed ? 'pass' : 'fail';
      process.stderr.write(`  [${arm} ${round}/${parsed.repeat}] ${c.name} ... ${tag}\n`);
    },
  });

  emit({ type: 'ab_arm', ...result.off });
  emit({ type: 'ab_arm', ...result.on });
  emit({ type: 'ab_result', ...result });

  const verdict = verdictLine(result);
  process.stderr.write('\n');
  process.stderr.write(`  OFF: ${fmtArm(result.off)}\n`);
  process.stderr.write(`  ON : ${fmtArm(result.on)}\n`);
  process.stderr.write(`\n${verdict}\n`);

  // Measurement tool, not a gate: exit 0 whenever the comparison completed,
  // regardless of which arm won. CI gating on pass-rate lives in `eval:*`.
  return 0;
};

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
