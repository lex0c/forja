// Proactive-recall default-ON calibration harness (MEMORY.md §4.4 P5 follow-up).
//
// The deterministic eval (`evals/memory/proactive/`) pins the MECHANISM. This
// pins the VALUE question the flag's default-ON decision hinges on: against a
// target model, what does proactive injection (floor=1.0, topK=3) buy — and
// does it ever cost?
//
// Method: A/B the SAME scenario with the flag ON vs OFF (everything else equal),
// via `executeCase` + `bootstrapOverride`. Each scenario seeds a project memory
// whose BODY holds an answer the model can't derive (a custom command, region,
// convention); the index (name+hook) is visible in BOTH arms, but the body is
// not. So:
//   - flag OFF: the model must call `memory_read` to fetch the body (a tool
//     round-trip) — or fail if it doesn't bother.
//   - flag ON: the body is injected into the turn tail; the model can answer
//     with NO tool call.
// We therefore measure BOTH correctness (did it answer right?) and efficiency
// (how many steps?). For a tool-using model the win is steps saved; for a model
// that won't reach for the tool, the win is correctness. The noise scenario asks
// something unrelated — the floor must keep the memory out, so ON must not
// regress steps or correctness.
//
//   bun run scripts/proactive-calibration.ts <model-id> [repeat] [name-filter]
//
// Reads OLLAMA_API_KEY / ANTHROPIC_API_KEY from .env (Bun auto-loads it).

import { executeCase } from '../src/evals/executor.ts';
import type { EvalCase } from '../src/evals/types.ts';

const MODEL = process.argv[2];
const REPEAT = Number(process.argv[3] ?? '1');
const FILTER = process.argv[4];

if (MODEL === undefined || MODEL.length === 0) {
  console.error('usage: bun run scripts/proactive-calibration.ts <model-id> [repeat] [name-filter]');
  process.exit(1);
}

interface Scenario {
  name: string;
  kind: 'useful' | 'noise';
  memName: string;
  memDescription: string;
  memBody: string;
  prompt: string;
  expectPattern: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'build-command',
    kind: 'useful',
    memName: 'build-command',
    memDescription: 'the project build command',
    memBody:
      'The build command for this repository is `make forja-turbo`. Never use npm, bun, or `make build` directly — only `make forja-turbo` produces a correct binary.',
    prompt: 'What exact shell command builds this project? Reply with just the command.',
    expectPattern: 'make forja-turbo',
  },
  {
    name: 'deploy-region',
    kind: 'useful',
    memName: 'deploy-region',
    memDescription: 'the production deploy region',
    memBody:
      'Production deploys for this project go to the af-south-1 region ONLY. (Staging uses eu-west-2; never deploy production anywhere else.)',
    prompt: 'Which cloud region does production deploy to here? Reply with just the region code.',
    expectPattern: 'af-south-1',
  },
  {
    // FACTUAL recall (asks the value) — the use case the "not as instructions"
    // framing does NOT discourage. (The generative "apply this convention"
    // variant was dropped: it's penalized by the anti-injection framing, a
    // separate design axis from floor/topK recall quality.)
    name: 'error-prefix-ask',
    kind: 'useful',
    memName: 'error-prefix',
    memDescription: 'error message convention',
    memBody:
      'Every user-facing error message in this codebase MUST start with the literal prefix `FORJA_ERR:` followed by a space, then the description.',
    prompt:
      'What exact prefix must every error message in this codebase start with? Reply with just the prefix.',
    expectPattern: 'FORJA_ERR:',
  },
  {
    name: 'noise-arithmetic',
    kind: 'noise',
    memName: 'build-command',
    memDescription: 'the project build command',
    memBody: 'The build command for this repository is `make forja-turbo`.',
    prompt: 'What is 17 multiplied by 3? Reply with just the number.',
    expectPattern: '51',
  },
];

// Detectors OFF: the default-ON verify/conflict schedulers try to spawn a
// subagent mid-run (crashes under the eval harness) and add cost/noise
// orthogonal to what we're measuring.
const CONFIG_TOML = '[memory]\nverify_semantic_llm = false\nconflict_detect_llm = false\noverride_detect_llm = false\n';

const buildCase = (s: Scenario): EvalCase => ({
  name: s.name,
  sourcePath: `/virtual/proactive-calibration/${s.name}.ts`,
  prompt: s.prompt,
  setup: {
    files: {
      '.forja/config.toml': CONFIG_TOML,
      [`.forja/memory/local/${s.memName}.md`]: `---\nname: ${s.memName}\ndescription: ${s.memDescription}\ntype: project\nsource: user_explicit\n---\n\n${s.memBody}\n`,
      '.forja/memory/local/MEMORY.md': `# Memory index\n\n- [${s.memDescription}](${s.memName}.md) — ${s.memDescription}\n`,
    },
  },
  expect: [{ kind: 'output_contains', pattern: s.expectPattern }],
  budget: { maxSteps: 4 },
});

const runArm = async (caseDef: EvalCase, on: boolean) =>
  executeCase(caseDef, {
    bootstrapOverride: { modelId: MODEL, memoryProactiveInject: on },
    perCaseTimeoutMs: 90_000,
  });

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

console.error(`\nProactive calibration — model=${MODEL} repeat=${REPEAT} (floor=1.0 topK=3)`);
console.error('A = proactive ON, B = proactive OFF; steps = mean. Body is index-hidden,');
console.error('so B must memory_read to answer (a round-trip A avoids).\n');
console.error(`${pad('scenario', 18)} ${pad('kind', 7)} ${pad('A pass', 7)} ${pad('A steps', 8)} ${pad('B pass', 7)} ${pad('B steps', 8)} verdict`);

for (const s of SCENARIOS) {
  if (FILTER !== undefined && !s.name.includes(FILTER)) continue;
  const caseDef = buildCase(s);
  let passA = 0;
  let passB = 0;
  let stepsA = 0;
  let stepsB = 0;
  let costA = 0;
  let costB = 0;
  let tokA = 0;
  let tokB = 0;
  let note = '';
  for (let r = 0; r < REPEAT; r++) {
    const a = await runArm(caseDef, true);
    const b = await runArm(caseDef, false);
    if (a.passed) passA++;
    if (b.passed) passB++;
    stepsA += a.steps;
    stepsB += b.steps;
    costA += a.costUsd;
    costB += b.costUsd;
    tokA += (a.usage?.input ?? 0) + (a.usage?.output ?? 0);
    tokB += (b.usage?.input ?? 0) + (b.usage?.output ?? 0);
    if (a.failure !== undefined) note = `errA=${a.failure}`;
    else if (b.failure !== undefined) note = `errB=${b.failure}`;
  }
  const avgA = (stepsA / REPEAT).toFixed(1);
  const avgB = (stepsB / REPEAT).toFixed(1);
  let verdict: string;
  if (s.kind === 'useful') {
    if (passA > passB) verdict = 'helps: correctness';
    else if (passA === passB && stepsA < stepsB) verdict = 'helps: fewer steps (B searches)';
    else if (passA === passB) verdict = 'no measurable effect';
    else verdict = 'HURTS: correctness ✗';
  } else {
    verdict = passA >= passB && stepsA <= stepsB + 0.001 ? 'no harm ✓' : 'HURTS ✗';
  }
  console.error(
    `${pad(s.name, 18)} ${pad(s.kind, 7)} ${pad(`${passA}/${REPEAT}`, 7)} ${pad(avgA, 8)} ${pad(`${passB}/${REPEAT}`, 7)} ${pad(avgB, 8)} ${verdict}${note ? `  [${note}]` : ''}`,
  );
  const dTok = tokB > 0 ? `${(((tokA - tokB) / tokB) * 100).toFixed(0)}%` : 'n/a';
  const dCost = costB > 0 ? `${(((costA - costB) / costB) * 100).toFixed(0)}%` : 'n/a';
  console.error(
    `${pad('', 26)}tokens A:${Math.round(tokA / REPEAT)} B:${Math.round(tokB / REPEAT)} (ΔA ${dTok})  cost A:$${(costA / REPEAT).toFixed(5)} B:$${(costB / REPEAT).toFixed(5)} (ΔA ${dCost})`,
  );
}
console.error('');
