// self-SWE-bench corpus runner (docs/TODO.md Phase 2, task #10). Runs a model over the curated
// corpus (evals/swe-bench/corpus.json): each task materializes the buggy parent tree + the failing
// test (setup.swe), the model fixes src/ to make the test pass, and a SANDBOXED `bun test` verifies
// the OUTCOME. Reports per-tier pass rate and appends per-task rows to evals/swe-bench/results.csv.
//
// The prompt is the FAILING TEST only — never the commit message / BACKLOG (that would leak the fix).
//
// Anti-cheat gates IN PLACE: the AGENT runs network-off (denyNetwork — curl/git-clone of the gold
// in the public repo can't reach the network) and the full test surface (tests/ tree + runner config
// + .env) is restored from C before the verifier. NOT yet gated: PASS_TO_PASS / overfit — a model
// can hard-code the VISIBLE oracle's inputs, so a passing task isn't proof of a general fix until #9
// (PASS_TO_PASS + withhold the oracle). docs/TODO.md anti-cheat gates.
//
// Run: bun run scripts/swe-bench-run.ts --model ollama/devstral-2:123b [--tier N] [--limit N]
//      [--id <sha>] [--max-steps N] [--timeout MS]

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeCase } from '../src/evals/executor.ts';
import { gitToplevel } from '../src/evals/swe-bench/workspace.ts';
import type { EvalCase } from '../src/evals/types.ts';

interface Task {
  id: string;
  commit: string;
  subject: string;
  kind: 'bug' | 'feature';
  testFiles: string[];
  srcFiles: string[];
  tier: 1 | 2 | 3;
  // Sibling tests that pass at C — the fix must keep them green (anti-cheat #9 PASS_TO_PASS).
  passToPass?: string[];
}

const repoRoot = gitToplevel(process.cwd());
const corpus: Task[] = JSON.parse(
  readFileSync(join(repoRoot, 'evals/swe-bench/corpus.json'), 'utf8'),
);

const argv = process.argv.slice(2);
let model = 'ollama/devstral-2:123b';
let limit: number | undefined;
let tier: number | undefined;
let id: string | undefined;
let maxSteps = 40;
let perTaskTimeout = 900_000;
// Parse an integer flag value or FAIL LOUD — a bad/missing value must not silently become NaN
// (which would select 0 tasks, abort every case at t=0, or uncap the step budget).
const intArg = (raw: string | undefined, flag: string): number => {
  const n = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(n)) {
    process.stderr.write(`swe-bench-run: ${flag} needs an integer, got '${raw ?? ''}'\n`);
    process.exit(1);
  }
  return n;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') model = argv[++i] ?? model;
  else if (a === '--limit') limit = intArg(argv[++i], '--limit');
  else if (a === '--tier') tier = intArg(argv[++i], '--tier');
  else if (a === '--id') id = argv[++i];
  else if (a === '--max-steps') maxSteps = intArg(argv[++i], '--max-steps');
  else if (a === '--timeout') perTaskTimeout = intArg(argv[++i], '--timeout');
  else {
    process.stderr.write(`swe-bench-run: unknown flag '${a}'\n`);
    process.exit(1);
  }
}

// The model receives the failing test as the spec — nothing from the commit/BACKLOG.
const promptFor = (t: Task): string => {
  const cmd = `bun test ${t.testFiles.join(' ')}`;
  return `One or more tests in this repository are failing. Run \`${cmd}\` to see the failure, then fix the SOURCE under src/ so the test(s) pass. Do NOT edit the test files — they specify the required behavior. You are done when \`${cmd}\` exits 0.`;
};

const toCase = (t: Task): EvalCase => {
  // OUTCOME oracle: the gold test, run sandboxed (cwd-rw, network off, failClosed).
  const caseExpect: EvalCase['expect'] = [
    {
      kind: 'command_succeeds',
      command: `bun test ${t.testFiles.join(' ')}`,
      sandboxed: true,
      timeoutMs: 180_000,
    },
  ];
  // PASS_TO_PASS (#9): the fix must keep sibling tests green — catches a fix that overfits the
  // visible oracle but breaks other callers. Second expectation ⇒ r.passed needs BOTH.
  if (t.passToPass?.length) {
    caseExpect.push({
      kind: 'command_succeeds',
      command: `bun test ${t.passToPass.join(' ')}`,
      sandboxed: true,
      timeoutMs: 180_000,
    });
  }
  return {
    name: `swe/${t.id}`,
    sourcePath: `corpus/${t.id}.json`,
    prompt: promptFor(t),
    setup: { swe: { commit: t.commit } },
    budget: { maxSteps },
    expect: caseExpect,
  };
};

let tasks = corpus;
if (tier !== undefined) tasks = tasks.filter((t) => t.tier === tier);
if (id !== undefined) tasks = tasks.filter((t) => t.id.startsWith(id ?? ''));
if (limit !== undefined) tasks = tasks.slice(0, limit);

process.stderr.write(
  `swe-bench-run: ${model} over ${tasks.length}/${corpus.length} task(s) ` +
    `(maxSteps ${maxSteps}, per-task ${Math.round(perTaskTimeout / 1000)}s)\n`,
);

interface Row {
  id: string;
  tier: number;
  kind: string;
  passed: boolean;
  status: string;
  exitReason: string;
  steps: number;
  durationMs: number;
  inputTok: number;
  outputTok: number;
  costUsd: number;
  unmetered: boolean;
  // Oracle passed but a PASS_TO_PASS sibling regressed — overfit/collateral, visible separately.
  regressed: boolean;
}
const rows: Row[] = [];
for (const t of tasks) {
  process.stderr.write(`  [${t.id}] tier${t.tier} ${t.kind} ${t.subject.slice(0, 42)} ... `);
  try {
    const r = await executeCase(toCase(t), {
      bootstrapOverride: { modelId: model },
      perCaseTimeoutMs: perTaskTimeout,
    });
    // regressed = oracle (expectation 0) passed but the PASS_TO_PASS sibling set (expectation 1)
    // failed. No passToPass ⇒ only one expectation ⇒ never regressed.
    const oraclePassed = r.expectations[0]?.passed ?? false;
    const p2pPassed = r.expectations.length > 1 ? (r.expectations[1]?.passed ?? false) : true;
    const regressed = oraclePassed && !p2pPassed;
    rows.push({
      id: t.id,
      tier: t.tier,
      kind: t.kind,
      passed: r.passed,
      status: r.status ?? '?',
      exitReason: r.exitReason ?? '',
      steps: r.steps,
      durationMs: r.durationMs,
      inputTok: r.usage?.input ?? 0,
      outputTok: r.usage?.output ?? 0,
      costUsd: r.costUsd,
      unmetered: r.unmetered ?? false,
      regressed,
    });
    process.stderr.write(
      `${r.passed ? 'PASS' : regressed ? 'REGRESSED' : 'fail'} (${r.steps} steps, ` +
        `${Math.round(r.durationMs / 1000)}s, ${(r.usage?.output ?? 0) / 1000}k out tok, ${r.status})\n`,
    );
  } catch (e) {
    rows.push({
      id: t.id,
      tier: t.tier,
      kind: t.kind,
      passed: false,
      status: 'error',
      exitReason: 'error',
      steps: 0,
      durationMs: 0,
      inputTok: 0,
      outputTok: 0,
      costUsd: 0,
      unmetered: false,
      regressed: false,
    });
    process.stderr.write(`ERROR ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// Append per-task rows (CSV accumulates across runs/models; header written once).
const dir = join(repoRoot, 'evals', 'swe-bench');
mkdirSync(dir, { recursive: true });
const csvPath = join(dir, 'results.csv');
if (!existsSync(csvPath)) {
  writeFileSync(
    csvPath,
    'model,id,tier,kind,passed,regressed,status,exit_reason,steps,duration_ms,input_tokens,output_tokens,cost_usd,unmetered\n',
  );
}
appendFileSync(
  csvPath,
  `${rows
    .map(
      (r) =>
        `${model},${r.id},${r.tier},${r.kind},${r.passed ? 1 : 0},${r.regressed ? 1 : 0},${r.status},${r.exitReason},${r.steps},${r.durationMs},${r.inputTok},${r.outputTok},${r.costUsd.toFixed(4)},${r.unmetered ? 1 : 0}`,
    )
    .join('\n')}\n`,
);

const byTier: Record<number, { n: number; pass: number }> = {
  1: { n: 0, pass: 0 },
  2: { n: 0, pass: 0 },
  3: { n: 0, pass: 0 },
};
for (const r of rows) {
  const bucket = byTier[r.tier];
  if (bucket === undefined) continue; // malformed corpus tier — don't crash the post-run summary
  bucket.n++;
  if (r.passed) bucket.pass++;
}
const passed = rows.filter((r) => r.passed).length;
const regressedCount = rows.filter((r) => r.regressed).length;
const cost = rows.reduce((s, r) => s + r.costUsd, 0);
const outTok = rows.reduce((s, r) => s + r.outputTok, 0);
const avgSec = rows.length ? rows.reduce((s, r) => s + r.durationMs, 0) / rows.length / 1000 : 0;
const unmetered = rows.some((r) => r.unmetered);
// For unmetered providers (Ollama Cloud) USD is $0 — report output tokens + wall-clock instead.
const effort = unmetered ? `${Math.round(outTok / 1000)}k out tok` : `$${cost.toFixed(2)}`;
process.stderr.write(
  `\n=== ${model}: ${passed}/${rows.length} (${rows.length ? Math.round((100 * passed) / rows.length) : 0}%)  ` +
    `${regressedCount ? `${regressedCount} regressed (oracle ok, sibling broke)  ` : ''}${effort}  avg ${avgSec.toFixed(0)}s/task ===\n`,
);
for (const tr of [1, 2, 3] as const) {
  if (byTier[tr].n) process.stderr.write(`  tier${tr}: ${byTier[tr].pass}/${byTier[tr].n}\n`);
}
process.stderr.write(`appended ${rows.length} row(s) → evals/swe-bench/results.csv\n`);
