// Runs Forja's eval suites against a set of models and APPENDS one row per
// (run, model) to evals/ranking/results.csv — measured, not claimed (the "eval
// is load-bearing" principle). CSV (not a rendered doc) so charts / pivots /
// summaries are built downstream; append-only so no run is ever lost. The latest
// raw batch also lands in evals/ranking/results.json for debugging / re-ingest.
//
// A ranking is multi-dimensional on purpose: a per-suite pass-rate matrix feeds
// the weighted COMPOSITE, while efficiency/trust signals — avg steps, cross-round
// stability, unfinished rate, latency, cost — sit BESIDE it as separate axes
// (passing efficiently ≠ passing). One run = one comparable batch (shared
// run_ts + harness_commit); the history is the SEQUENCE of batches, so filter on
// run_ts for apples-to-apples — don't mix harness versions in one comparison.
//
// Modes:
//   bun run scripts/model-ranking.ts            run the battery, append to CSV
//   RANKING_INGEST=1 bun run ...                append an existing results.json to the CSV (no re-run)

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { executeCase, summarize } from '../src/evals/executor.ts';
import { loadEvalCase } from '../src/evals/loader.ts';
import type { EvalCaseResult } from '../src/evals/types.ts';

// --- Battery config -------------------------------------------------------
// The full ranking set. RANKING_MODELS="id,id" runs a SUBSET — e.g. to add a new
// model without re-running the rest. A subset batch stays comparable to the others
// as long as harness_commit matches (the unit of comparability), just under a
// different run_ts.
//
// All cloud. Local small models proved non-viable on this bench/hardware and were
// retired: qwen2.5-coder:7b emits no native tool_calls via Ollama (1 step, never
// executes → 2%); llama3.1:8b drives the loop but is too slow (~180s to read one
// file → every case times out → 2%). Ollama Cloud serves no model under ~20B, so
// gpt-oss:20b is the smallest agent that actually completes the battery.
const ALL_MODELS: readonly string[] = [
  'ollama/glm-5.2',
  'ollama/devstral-2:123b',
  'ollama/qwen3-coder-next',
  'ollama/qwen3-coder:480b',
  'ollama/gpt-oss:20b',
];
const MODELS: readonly string[] = process.env.RANKING_MODELS
  ? process.env.RANKING_MODELS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : ALL_MODELS;

// Per-suite repeat: small suites repeat for variance; regression (43 cases)
// already has a stable N at repeat 1. RANKING_REPEAT overrides the small ones.
const SMALL_REPEAT = Number(process.env.RANKING_REPEAT ?? '2');
const SUITES: ReadonlyArray<{ name: string; dir: string; weight: number; repeat: number }> = [
  { name: 'smoke', dir: 'evals/smoke', weight: 1, repeat: SMALL_REPEAT },
  { name: 'edit-format', dir: 'evals/edit-format', weight: 2, repeat: SMALL_REPEAT },
  { name: 'regression', dir: 'evals/regression', weight: 2, repeat: 1 },
];

const PER_CASE_TIMEOUT_MS = Number(process.env.RANKING_TIMEOUT_MS ?? '180000');
const CSV_PATH = resolve('evals/ranking/results.csv');
const JSON_PATH = resolve('evals/ranking/results.json');

// --- Run + aggregate ------------------------------------------------------
interface SuiteResult {
  passRate: number;
  passed: number;
  runs: number;
  stepsAvg: number;
  exhaustRate: number;
  costAvgUsd: number;
  cacheReadSum: number;
  cacheWriteSum: number;
  promptTokenSum: number;
  unmetered: boolean;
  p50DurationMs: number;
  stableCases: number;
  multiRoundCases: number;
}
interface ModelRow {
  model: string;
  suites: Record<string, SuiteResult>;
  composite: number;
  stepsAvg: number;
  exhaustRate: number;
  stability: number | null;
  p50DurationMs: number;
  costPerBatteryUsd: number;
  cacheReadRate: number | null;
  unmetered: boolean;
}
interface Provenance {
  generated_at: string;
  run_ts: string;
  harness_commit: string;
  suites: typeof SUITES;
  models: readonly string[];
  rows: ModelRow[];
}

const discoverCases = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(ya?ml)$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
};

const p50 = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? 0;
};

// A run that didn't finish cleanly — flailed to the step cap, was cut off,
// errored, or never produced a harness result at all. A setup failure (missing
// API key, bootstrap throw, early timeout) produces NO harness result, so its
// status is UNDEFINED — that's the unfinished signal. Deliberately NOT keyed on
// `failure`: a run that completed but merely overspent its declared maxCostUsd
// keeps a real status (e.g. 'done') AND a "cost exceeded" failure — it reached
// the expect phase, so it belongs to pass/cost, not reliability. High rate =
// unreliable in the loop, independent of pass/fail.
export const unfinished = (r: EvalCaseResult): boolean =>
  r.status === undefined ||
  r.status === 'exhausted' ||
  r.status === 'interrupted' ||
  r.status === 'error';

// Fraction of prompt tokens served from a cache read — the cache-hit signal.
// Returns null (→ blank CSV cell) when the provider never cached this battery (no
// read OR write activity), so a no-cache model reads as "n/a", not "0% hit". The
// 0/0 guard keeps an all-setup-failure battery (no usage at all) null too.
export const cacheReadRate = (
  totalRead: number,
  totalWrite: number,
  totalPrompt: number,
): number | null =>
  totalRead + totalWrite > 0 && totalPrompt > 0 ? totalRead / totalPrompt : null;

const runSuite = async (modelId: string, dir: string, repeat: number): Promise<SuiteResult> => {
  // The ranking measures the MODEL, so it skips `evaluates: harness` cases —
  // permissions, hooks, compaction, postures — whose outcome is the same across
  // models (they belong to CI's harness regression, which runs the full tree).
  const cases = discoverCases(resolve(dir))
    .map(loadEvalCase)
    .filter((c) => c.evaluates !== 'harness');
  const all: EvalCaseResult[] = [];
  const byCase = new Map<string, EvalCaseResult[]>();
  for (let round = 1; round <= repeat; round++) {
    for (const c of cases) {
      process.stderr.write(`  [${modelId}] ${c.name} (round ${round}/${repeat}) ... `);
      const r = await executeCase(c, {
        bootstrapOverride: { modelId },
        perCaseTimeoutMs: PER_CASE_TIMEOUT_MS,
      });
      process.stderr.write(`${r.passed ? 'pass' : 'fail'} (${r.durationMs}ms)\n`);
      all.push(r);
      const arr = byCase.get(c.sourcePath) ?? [];
      arr.push(r);
      byCase.set(c.sourcePath, arr);
    }
  }
  const s = summarize(all);
  let stableCases = 0;
  let multiRoundCases = 0;
  for (const runs of byCase.values()) {
    if (runs.length < 2) continue;
    multiRoundCases += 1;
    const first = runs[0]?.passed;
    if (runs.every((r) => r.passed === first)) stableCases += 1;
  }
  const n = Math.max(all.length, 1);
  return {
    passRate: s.passRate,
    passed: s.passed,
    runs: all.length,
    stepsAvg: all.reduce((a, r) => a + r.steps, 0) / n,
    exhaustRate: all.filter((r) => unfinished(r)).length / n,
    costAvgUsd: all.reduce((a, r) => a + r.costUsd, 0) / n,
    cacheReadSum: all.reduce((a, r) => a + (r.usage?.cache_read ?? 0), 0),
    cacheWriteSum: all.reduce((a, r) => a + (r.usage?.cache_creation ?? 0), 0),
    promptTokenSum: all.reduce(
      (a, r) => a + (r.usage ? r.usage.input + r.usage.cache_read + r.usage.cache_creation : 0),
      0,
    ),
    unmetered: all.some((r) => r.unmetered === true),
    p50DurationMs: p50(all.map((r) => r.durationMs)),
    stableCases,
    multiRoundCases,
  };
};

// --- CSV (append-only) ----------------------------------------------------
export const CSV_COLUMNS: readonly string[] = [
  'run_date',
  'run_ts',
  'harness_commit',
  'model',
  'composite',
  ...SUITES.map((s) => s.name),
  'steps_avg',
  'stability',
  'unfinished_rate',
  'p50_ms',
  'cost_usd',
  'cache_read_rate',
];

const num = (x: number, dp: number): string => x.toFixed(dp);

const csvRow = (
  r: ModelRow,
  prov: Pick<Provenance, 'generated_at' | 'run_ts' | 'harness_commit'>,
): string =>
  [
    prov.generated_at,
    prov.run_ts,
    prov.harness_commit,
    r.model,
    num(r.composite, 4),
    ...SUITES.map((s) => {
      const sr = r.suites[s.name];
      return sr ? num(sr.passRate, 4) : '';
    }),
    num(r.stepsAvg, 2),
    r.stability === null ? '' : num(r.stability, 4),
    num(r.exhaustRate, 4),
    String(Math.round(r.p50DurationMs)),
    r.unmetered ? '' : num(r.costPerBatteryUsd, 6),
    r.cacheReadRate === null ? '' : num(r.cacheReadRate, 4),
  ].join(',');

// Re-map a historical row (parsed by its OLD header) onto the current column set,
// filling '' for columns the old schema lacked. Keeps the file well-formed when a
// column is added — old runs get a blank cell, never a width mismatch.
export const remapRow = (oldHeader: string, row: string): string => {
  const oldCols = oldHeader.split(',');
  const cells = row.split(',');
  const byName = new Map(oldCols.map((c, i) => [c, cells[i] ?? '']));
  return CSV_COLUMNS.map((c) => byName.get(c) ?? '').join(',');
};

// Append one row per model. The CSV accumulates every run forever (filter on
// run_ts downstream for a batch). When a column was added since the file was last
// written, migrate the historical rows onto the new header first so every row has
// the same width — no run is lost; old runs just get a blank cell for the new one.
const appendCsv = (prov: Provenance): void => {
  mkdirSync(dirname(CSV_PATH), { recursive: true });
  const header = CSV_COLUMNS.join(',');
  const body = `${prov.rows.map((r) => csvRow(r, prov)).join('\n')}\n`;
  if (!existsSync(CSV_PATH)) {
    writeFileSync(CSV_PATH, `${header}\n${body}`);
  } else {
    const lines = readFileSync(CSV_PATH, 'utf-8').split('\n');
    const oldHeader = lines[0] ?? '';
    if (oldHeader === header) {
      appendFileSync(CSV_PATH, body);
    } else {
      const migrated = lines
        .slice(1)
        .filter((l) => l.length > 0)
        .map((l) => remapRow(oldHeader, l));
      const prefix = migrated.length > 0 ? `${migrated.join('\n')}\n` : '';
      writeFileSync(CSV_PATH, `${header}\n${prefix}${body}`);
      process.stderr.write(
        `Migrated CSV to ${CSV_COLUMNS.length} columns; ${migrated.length} historical row(s) repadded\n`,
      );
    }
  }
  process.stderr.write(`Appended ${prov.rows.length} row(s) to ${CSV_PATH}\n`);
};

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

const main = async (): Promise<void> => {
  // Ingest: append an existing results.json to the CSV without re-running the
  // evals (e.g. to fold a batch that was produced by an earlier script version).
  if (process.env.RANKING_INGEST === '1') {
    const prov = JSON.parse(readFileSync(JSON_PATH, 'utf-8')) as Partial<Provenance>;
    const generated_at = prov.generated_at ?? new Date().toISOString().slice(0, 10);
    appendCsv({
      generated_at,
      run_ts: prov.run_ts ?? generated_at,
      harness_commit: prov.harness_commit ?? 'unknown',
      suites: SUITES,
      models: prov.models ?? [],
      rows: prov.rows ?? [],
    });
    return;
  }

  const commit =
    new TextDecoder()
      .decode(Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout)
      .trim() || 'unknown';
  const runTs = new Date().toISOString();
  const runDate = runTs.slice(0, 10);
  const totalWeight = SUITES.reduce((a, s) => a + s.weight, 0);

  const rows: ModelRow[] = [];
  for (const model of MODELS) {
    process.stderr.write(`\n=== ${model} ===\n`);
    const suites: Record<string, SuiteResult> = {};
    for (const suite of SUITES) suites[suite.name] = await runSuite(model, suite.dir, suite.repeat);

    const get = (name: string): SuiteResult | undefined => suites[name];
    const composite =
      SUITES.reduce((a, s) => a + (get(s.name)?.passRate ?? 0) * s.weight, 0) / totalWeight;
    const totalRuns = SUITES.reduce((a, s) => a + (get(s.name)?.runs ?? 0), 0) || 1;
    const stepsAvg =
      SUITES.reduce((a, s) => a + (get(s.name)?.stepsAvg ?? 0) * (get(s.name)?.runs ?? 0), 0) /
      totalRuns;
    const exhaustRate =
      SUITES.reduce((a, s) => a + (get(s.name)?.exhaustRate ?? 0) * (get(s.name)?.runs ?? 0), 0) /
      totalRuns;
    const stableSum = SUITES.reduce((a, s) => a + (get(s.name)?.stableCases ?? 0), 0);
    const multiSum = SUITES.reduce((a, s) => a + (get(s.name)?.multiRoundCases ?? 0), 0);
    const costPerBattery = SUITES.reduce(
      (a, s) => a + (get(s.name)?.costAvgUsd ?? 0) * (get(s.name)?.runs ?? 0),
      0,
    );
    const totalCacheRead = SUITES.reduce((a, s) => a + (get(s.name)?.cacheReadSum ?? 0), 0);
    const totalCacheWrite = SUITES.reduce((a, s) => a + (get(s.name)?.cacheWriteSum ?? 0), 0);
    const totalPrompt = SUITES.reduce((a, s) => a + (get(s.name)?.promptTokenSum ?? 0), 0);
    const unmetered = SUITES.some((s) => get(s.name)?.unmetered === true);
    rows.push({
      model,
      suites,
      composite,
      stepsAvg,
      exhaustRate,
      stability: multiSum > 0 ? stableSum / multiSum : null,
      p50DurationMs: p50(Object.values(suites).map((sr) => sr.p50DurationMs)),
      costPerBatteryUsd: costPerBattery,
      cacheReadRate: cacheReadRate(totalCacheRead, totalCacheWrite, totalPrompt),
      unmetered,
    });
  }
  rows.sort((a, b) => b.composite - a.composite);

  const prov: Provenance = {
    generated_at: runDate,
    run_ts: runTs,
    harness_commit: commit,
    suites: SUITES,
    models: MODELS,
    rows,
  };
  mkdirSync(dirname(JSON_PATH), { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(prov, null, 2)}\n`);
  appendCsv(prov);

  for (const [i, r] of rows.entries()) {
    process.stderr.write(`  ${i + 1}. ${r.model.padEnd(26)} composite ${pct(r.composite)}\n`);
  }
};

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (e) => {
      process.stderr.write(`model-ranking: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exit(1);
    },
  );
}
