// self-SWE-bench corpus runner (Docker orchestrator). Runs each model over the curated corpus
// (evals/swe-bench/corpus.json) as EPHEMERAL CONTAINERS PER TASK: the buggy parent tree + the
// failing test are materialized and mounted at /task, the compiled forja binary (the full agent
// loop) fixes src/ in ONE container, then — after the host re-materializes the canonical test
// surface from commit C (anti-cheat: discard any agent edits to tests/ or runner config) — a SECOND
// container runs `bun test` to verify the OUTCOME. The answer repo is NEVER present (no .git/corpus/
// gold) and egress is locked to the model host alone (see evals/swe-bench/docker/). Appends per-task
// rows to evals/swe-bench/results.csv and writes per-task debug logs under evals/swe-bench/logs/<run>/.
//
// The prompt is the FAILING TEST only — never the commit message / BACKLOG (that would leak the fix).
// Model support mirrors the ranking: the host's model_providers.json is mounted, `--models` selects.
//
// Run: bun run scripts/swe-bench-run.ts --models ollama/devstral-2:123b[,anthropic/claude-opus-4-8]
//      [--tier N] [--limit N] [--id <sha>] [--max-steps N] [--timeout MS] [--no-build]
// The agent binary is rebuilt (`bun run build`) every run so a stale dist/ never bakes an old agent
// into the image; --no-build skips that when dist/ is known-current (repeated runs of one build).

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  allowHostsFor,
  apiKeyEnvsFor,
  loadCatalogEntries,
  parseMetrics,
  scoreResult,
} from '../src/evals/swe-bench/runner-core.ts';
import {
  gitToplevel,
  materializeSweWorkspace,
  restoreSweTests,
} from '../src/evals/swe-bench/workspace.ts';

interface Task {
  id: string;
  commit: string;
  subject: string;
  kind: 'bug' | 'feature';
  testFiles: string[];
  srcFiles: string[];
  tier: 1 | 2 | 3;
  passToPass?: string[];
}

const IMAGE = 'forja-swe-bench';
const NETWORK = 'forja-swe-egress';
const PROXY = 'forja-swe-proxy';
const PROXY_PORT = 8889;
// The verifier container only runs `bun test` (no agent loop), so it needs far less than the
// per-task agent budget. A fixed cap keeps a hung test from holding a task open for the full
// per-task timeout.
const VERIFY_TIMEOUT = 180_000;
const catalogPath = join(userInfo().homedir, '.config', 'forja', 'model_providers.json');

const repoRoot = gitToplevel(process.cwd());
const corpus: Task[] = JSON.parse(
  readFileSync(join(repoRoot, 'evals/swe-bench/corpus.json'), 'utf8'),
);

const argv = process.argv.slice(2);
let models: string[] = ['ollama/devstral-2:123b'];
let limit: number | undefined;
let tier: number | undefined;
let id: string | undefined;
let maxSteps = 40;
let perTaskTimeout = 900_000;
let noBuild = false;
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
  if (a === '--models')
    models = (argv[++i] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  else if (a === '--model') models = [argv[++i] ?? models[0]];
  else if (a === '--limit') limit = intArg(argv[++i], '--limit');
  else if (a === '--tier') tier = intArg(argv[++i], '--tier');
  else if (a === '--id') id = argv[++i];
  else if (a === '--max-steps') maxSteps = intArg(argv[++i], '--max-steps');
  else if (a === '--timeout') perTaskTimeout = intArg(argv[++i], '--timeout');
  else if (a === '--no-build') noBuild = true;
  else {
    process.stderr.write(`swe-bench-run: unknown flag '${a}'\n`);
    process.exit(1);
  }
}
if (models.length === 0) {
  process.stderr.write('swe-bench-run: --models needs at least one model id\n');
  process.exit(1);
}

// The model receives the failing test as the spec — nothing from the commit/BACKLOG.
const promptFor = (t: Task): string => {
  const cmd = `bun test ${t.testFiles.join(' ')}`;
  return `One or more tests in this repository are failing. Run \`${cmd}\` to see the failure, then fix the SOURCE under src/ so the test(s) pass. Do NOT edit the test files — they specify the required behavior. You are done when \`${cmd}\` exits 0.`;
};

const sh = (cmd: string[], soft = false): string => {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  if (!r.success && !soft) {
    throw new Error(
      `swe-bench-run: \`${cmd.join(' ')}\` failed: ${r.stderr.toString().trim().slice(-300)}`,
    );
  }
  return r.stdout.toString();
};

// `docker logs` writes the container's stdout to ITS stdout and the container's stderr to ITS stderr;
// the proxy logs ("listening", ALLOW/DENY) go to stderr, so capture BOTH or they're invisible.
const dockerLogs = (name: string, tail?: number): string => {
  const cmd =
    tail !== undefined
      ? ['docker', 'logs', '--tail', String(tail), name]
      : ['docker', 'logs', name];
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  return r.stdout.toString() + r.stderr.toString();
};

// Build the bench image: the compiled binary (built on demand) + the manifest go into the docker
// context; the multi-stage Dockerfile bakes the deps + the Go proxy. Context files are cleaned after.
const buildImage = (rebuild: boolean): void => {
  const dist = join(repoRoot, 'dist');
  // ALWAYS rebuild the agent binary before baking, unless --no-build. A stale dist/ binary (from an
  // earlier commit, or source changed without rebuilding) would bake an OLD agent into the image while
  // the corpus + deps are current — corrupting pass rates in a way that looks like model behavior, not
  // a stale harness. --no-build is the escape hatch for repeated runs of an already-current dist/.
  if (rebuild) {
    process.stderr.write(
      'swe-bench-run: building the linux-x64 agent binary (`bun run build`)...\n',
    );
    const b = Bun.spawnSync({
      cmd: ['bun', 'run', 'build'],
      cwd: repoRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (!b.success) throw new Error('swe-bench-run: `bun run build` failed');
  }
  const binary = existsSync(dist)
    ? readdirSync(dist).find((f) => /^forja-[\d.]+-linux-x64$/.test(f))
    : undefined;
  if (binary === undefined)
    throw new Error(
      `swe-bench-run: no linux-x64 binary in dist/${rebuild ? ' after build' : ' (--no-build set — run `bun run build` first)'}`,
    );
  const ctx = join(repoRoot, 'evals/swe-bench/docker');
  copyFileSync(join(dist, binary), join(ctx, 'forja'));
  copyFileSync(join(repoRoot, 'package.json'), join(ctx, 'package.json'));
  copyFileSync(join(repoRoot, 'bun.lock'), join(ctx, 'bun.lock'));
  process.stderr.write('swe-bench-run: docker build...\n');
  try {
    sh(['docker', 'build', '-t', IMAGE, ctx]);
  } finally {
    for (const f of ['forja', 'package.json', 'bun.lock']) rmSync(join(ctx, f), { force: true });
  }
};

// The selected models' catalog entries — egress hosts AND api_key_env both derive from these (the
// pure resolvers live in runner-core, where they're unit-tested). Read once; passed to both.
const catalogEntries = loadCatalogEntries(catalogPath);
const apiKeyEnvs = apiKeyEnvsFor(models, catalogEntries);

// The sidecar: an --internal network (no direct egress) + the proxy (the only egress, allowlisting
// the model hosts). Shared across all tasks in the run.
const ensureSidecar = (allowHosts: string[]): void => {
  teardownSidecar();
  sh(['docker', 'network', 'create', '--internal', NETWORK]);
  sh([
    'docker',
    'run',
    '-d',
    '--name',
    PROXY,
    '--network',
    NETWORK,
    '-e',
    `EGRESS_ALLOW=${allowHosts.join(',')}`,
    '--entrypoint',
    '/usr/local/bin/egress-proxy',
    IMAGE,
  ]);
  // Give the proxy (only) internet via the default `bridge` network. Soft: a daemon configured
  // without a `bridge` network would throw here, but the proxy still needs egress, so warn loudly
  // rather than abort — the readiness poll below fails clearly if the proxy ends up with no route.
  const bridge = Bun.spawnSync({
    cmd: ['docker', 'network', 'connect', 'bridge', PROXY],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!bridge.success) {
    const detail = bridge.stderr.toString().trim().slice(-200);
    process.stderr.write(
      `swe-bench-run: could not connect proxy to the 'bridge' network (${detail}); the proxy may have no egress — check the daemon has a default bridge network\n`,
    );
  }
  // Poll WITH a delay — the container start (image layers + namespace) takes a few seconds; a tight
  // no-delay loop burns its iterations before the proxy logs "listening" and gives up too early.
  for (let i = 0; i < 60; i++) {
    if (dockerLogs(PROXY).includes('listening')) return;
    Bun.sleepSync(250);
  }
  throw new Error('swe-bench-run: egress proxy did not come up');
};
const teardownSidecar = (): void => {
  sh(['docker', 'rm', '-f', PROXY], true);
  sh(['docker', 'network', 'rm', NETWORK], true);
};

// Egress preflight — before spending a corpus run, prove the sidecar egress is BOTH working (each model
// host is reachable through the proxy via bun fetch, the real provider client) AND locked (github is
// blocked). A Bun that stopped honoring HTTPS_PROXY, or a network/proxy misconfig, would otherwise fail
// EVERY task silently (0 steps / timeout) and score as model incapacity — corrupting the benchmark with
// no visible error. One throwaway container per distinct host runs the entrypoint's FORJA_NET_TEST.
const preflightEgress = (hosts: string[]): void => {
  for (const host of hosts) {
    process.stderr.write(`swe-bench-run: egress preflight (${host})...\n`);
    const r = Bun.spawnSync({
      cmd: [
        'docker',
        'run',
        '--rm',
        '--network',
        NETWORK,
        '-e',
        `HTTPS_PROXY=http://${PROXY}:${PROXY_PORT}`,
        '-e',
        'FORJA_NET_TEST=1',
        '-e',
        `FORJA_NET_TEST_HOST=${host}`,
        IMAGE,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    });
    process.stderr.write(r.stdout.toString() + r.stderr.toString());
    if (!r.success) {
      throw new Error(
        `swe-bench-run: egress preflight FAILED for ${host} (see the NET lines above) — aborting before the corpus. A network-broken run would score every task as model incapacity; fix the sidecar proxy / network and retry.`,
      );
    }
  }
};

interface Row {
  model: string;
  id: string;
  tier: number;
  kind: string;
  passed: boolean;
  regressed: boolean;
  status: string;
  exitReason: string;
  steps: number;
  durationMs: number;
  inputTok: number;
  outputTok: number;
  costUsd: number;
  unmetered: boolean;
  toolCalls: number;
  toolErrors: number;
}

const readExit = (path: string): number | undefined => {
  if (!existsSync(path)) return undefined;
  const n = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isNaN(n) ? undefined : n;
};

const runTask = (model: string, t: Task, logDir: string): Row => {
  const work = mkdtempSync(join(tmpdir(), `swe-${t.id}-`));
  // Wrap the whole body: a throw between materialize and the pass-cleanup would otherwise orphan
  // the temp workspace (the caller's try/catch can't see `work`). Best-effort rm on throw, swallow
  // EPERM (the agent container may have left root-owned files if it never chmodded), then rethrow.
  try {
    return runTaskInner(model, t, logDir, work);
  } catch (e) {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // Orphan rather than mask the original error — the caller logs the throw + records an error row.
    }
    throw e;
  }
};

const runTaskInner = (model: string, t: Task, logDir: string, work: string): Row => {
  const { testPaths } = materializeSweWorkspace({ commit: t.commit, repoRoot, cwd: work });

  const dest = join(logDir, model.replace(/[/:]/g, '_'), t.id);
  mkdirSync(dest, { recursive: true });

  // The common `docker run` args (mounts, proxy, API keys) are identical across phases; only the
  // phase-specific FORJA_*/ORACLE_*/PASS_TO_PASS env differs. `dockerRun` runs one container with a
  // given phase env + timeout and returns the spawn result (so the caller reads exit/timeout).
  const dockerRun = (phaseEnv: string[], timeoutMs: number) => {
    const dockerArgv = [
      'docker',
      'run',
      '--rm',
      '--network',
      NETWORK,
      '-v',
      `${work}:/task`,
      '-v',
      `${catalogPath}:/root/.config/forja/model_providers.json:ro`,
      '-e',
      `HTTPS_PROXY=http://${PROXY}:${PROXY_PORT}`,
      '-e',
      `HTTP_PROXY=http://${PROXY}:${PROXY_PORT}`,
      // Forward the api_key_env of EVERY selected model (read from the catalog), not a fixed list — a
      // google/openrouter/custom entry uses GOOGLE_API_KEY / OPENROUTER_API_KEY / a gateway key, and a
      // missing one fails provider construction inside the container.
      ...apiKeyEnvs.flatMap((k) => ['-e', k]),
      ...phaseEnv,
      IMAGE,
    ];
    return Bun.spawnSync({ cmd: dockerArgv, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
  };

  // PHASE 1 — the agent, in its OWN container. SWE_SKIP_VERIFY=1 makes the entrypoint run the agent
  // and exit BEFORE the verifier (the host restores the canonical test surface in between).
  const agentStart = Date.now();
  const agentRun = dockerRun(
    [
      '-e',
      `FORJA_PROMPT=${promptFor(t)}`,
      '-e',
      `FORJA_MODEL=${model}`,
      '-e',
      `FORJA_MAX_STEPS=${maxSteps}`,
      '-e',
      'SWE_SKIP_VERIFY=1',
    ],
    perTaskTimeout,
  );
  const agentMs = Date.now() - agentStart;
  const agentTimedOut = agentRun.exitedDueToTimeout === true;
  // The agent container writes /task/.agent_error when forja exits with a non-normal code (a startup /
  // provider error — unresolvable model, unset api_key_env, mid-loop crash). That is a HARNESS error,
  // not a model attempt: skip restore + verify and score it `error`, never a 0-step task "failure".
  const agentErrorFile = join(work, '.agent_error');
  const agentError = existsSync(agentErrorFile);
  if (agentError) {
    process.stderr.write(
      `swe-bench-run: ${t.id} — forja exited abnormally (code ${readFileSync(agentErrorFile, 'utf8').trim()}) before a normal finish; scoring HARNESS ERROR, not a model failure. If this repeats the config is broken (unset key / bad model id) — abort and fix.\n`,
    );
  }

  // Preserve the agent log NOW — the metrics (the done-line) live in it, and the verifier container
  // would overwrite /task/.run.log. Prefer the in-volume log; fall back to the captured streams.
  const runLog = join(work, '.run.log');
  const agentLog = existsSync(runLog)
    ? readFileSync(runLog, 'utf8')
    : agentRun.stdout.toString() + agentRun.stderr.toString();
  writeFileSync(join(dest, 'run.log'), agentLog);

  // PHASE 2 — host restore (anti-cheat). Re-materialize the canonical tests/ + runner config from C,
  // discarding any agent edits, so only the model's src/ changes can make the oracle pass. The agent
  // container chmodded /task world-writable on exit, so this non-root host CAN rm tests/ + re-extract.
  // Skipped on a timeout (the workspace is incomplete / chmod may not have run).
  let restoreFailed = false;
  if (!agentTimedOut && !agentError) {
    try {
      restoreSweTests({ commit: t.commit, repoRoot, cwd: work, testPaths });
    } catch (e) {
      restoreFailed = true;
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`swe-bench-run: test-surface restore for ${t.id} failed: ${msg}\n`);
    }
  }

  // PHASE 3 — the verifier, in a SEPARATE container, on the restored tree. No FORJA_PROMPT (so the
  // entrypoint skips the agent) and no SWE_SKIP_VERIFY (so it runs the verifier). Skipped if the
  // agent timed out or the restore failed — there's nothing trustworthy to score.
  let oracle: number | undefined;
  let p2p: number | undefined;
  if (!agentTimedOut && !restoreFailed && !agentError) {
    dockerRun(
      [
        '-e',
        `ORACLE_TESTS=${t.testFiles.join(' ')}`,
        ...(t.passToPass?.length ? ['-e', `PASS_TO_PASS=${t.passToPass.join(' ')}`] : []),
      ],
      VERIFY_TIMEOUT,
    );
    if (existsSync(runLog)) copyFileSync(runLog, join(dest, 'verify.log'));
    oracle = readExit(join(work, '.result'));
    p2p = readExit(join(work, '.p2p'));
  }
  writeFileSync(join(dest, 'proxy.log'), dockerLogs(PROXY, 200));

  // Score from the verifier's oracle + PASS_TO_PASS exit codes (pure + unit-tested in runner-core).
  const { passed, regressed, status } = scoreResult({
    oracle,
    p2p,
    expectsP2P: (t.passToPass?.length ?? 0) > 0,
    agentTimedOut,
    restoreFailed,
    agentError,
  });
  // Metrics come from the AGENT log (the done-line) — the verifier container has no agent summary.
  const m = parseMetrics(agentLog);
  const durationMs = agentMs;

  // Retain the workspace (the agent's actual src edits) when something went wrong; clean it on a pass.
  // The container runs as root, so the entrypoint chmods /task world-writable before exit to let this
  // (non-root) host unlink it. Tolerate a residual EPERM (e.g. a timeout that skipped the chmod) so a
  // cleanup failure never aborts the run — retain + note the path instead.
  if (passed) {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `swe-bench-run: cleanup of ${work} failed (${msg.slice(0, 120)}); retained\n`,
      );
      writeFileSync(join(dest, 'workspace-path.txt'), work);
    }
  } else writeFileSync(join(dest, 'workspace-path.txt'), work);

  return {
    model,
    id: t.id,
    tier: t.tier,
    kind: t.kind,
    passed,
    regressed,
    status,
    exitReason: m.reason,
    steps: m.steps,
    durationMs,
    inputTok: m.inputTok,
    outputTok: m.outputTok,
    costUsd: m.costUsd,
    unmetered: m.unmetered,
    toolCalls: m.toolCalls,
    toolErrors: m.toolErrors,
  };
};

// --- run ---------------------------------------------------------------------

let tasks = corpus;
if (tier !== undefined) tasks = tasks.filter((t) => t.tier === tier);
if (id !== undefined) tasks = tasks.filter((t) => t.id.startsWith(id ?? ''));
if (limit !== undefined) tasks = tasks.slice(0, limit);

const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const logDir = join(repoRoot, 'evals/swe-bench/logs', runId);
mkdirSync(logDir, { recursive: true });

process.stderr.write(
  `swe-bench-run: ${models.length} model(s) × ${tasks.length}/${corpus.length} task(s) ` +
    `(maxSteps ${maxSteps}, per-task ${Math.round(perTaskTimeout / 1000)}s) → logs ${logDir}\n`,
);
if (!existsSync(catalogPath)) {
  process.stderr.write(`swe-bench-run: model catalog not found at ${catalogPath}\n`);
  process.exit(1);
}

buildImage(!noBuild);

const rows: Row[] = [];
try {
  const allowHosts = allowHostsFor(models, catalogEntries);
  ensureSidecar(allowHosts);
  preflightEgress(allowHosts); // abort loudly if egress is broken/leaky BEFORE spending the corpus
  for (const model of models) {
    process.stderr.write(`\n=== ${model} ===\n`);
    for (const t of tasks) {
      process.stderr.write(`  [${t.id}] tier${t.tier} ${t.kind} ${t.subject.slice(0, 42)} ... `);
      // One task's failure (docker hiccup, parse error, cleanup EPERM) must not abort the whole run —
      // record an error row and move on so a 50-task sweep always finishes + writes its CSV.
      let row: Row;
      try {
        row = runTask(model, t, logDir);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`runTask threw: ${msg.slice(0, 200)}\n`);
        row = {
          model,
          id: t.id,
          tier: t.tier,
          kind: t.kind,
          passed: false,
          regressed: false,
          status: 'error',
          exitReason: 'harness-error',
          steps: 0,
          durationMs: 0,
          inputTok: 0,
          outputTok: 0,
          costUsd: 0,
          unmetered: false,
          toolCalls: 0,
          toolErrors: 0,
        };
      }
      rows.push(row);
      const verdict = row.passed
        ? 'PASS'
        : row.regressed
          ? 'REGRESSED'
          : row.status === 'ok'
            ? 'fail'
            : row.status.toUpperCase();
      process.stderr.write(
        `${verdict} (${row.steps} steps, ${Math.round(row.durationMs / 1000)}s, ${row.outputTok / 1000}k out tok)\n`,
      );
    }
  }
} finally {
  teardownSidecar();
}

// Append per-task rows (CSV accumulates across runs/models; header written once).
const csvPath = join(repoRoot, 'evals', 'swe-bench', 'results.csv');
if (!existsSync(csvPath)) {
  writeFileSync(
    csvPath,
    'model,id,tier,kind,passed,regressed,status,exit_reason,steps,duration_ms,input_tokens,output_tokens,cost_usd,unmetered,tool_calls,tool_errors\n',
  );
}
// Minimal RFC-4180 quoting: a value that contains a comma, double-quote, or newline is wrapped in
// double-quotes with internal quotes doubled; anything else is emitted raw. The string fields
// (model id, status, exit_reason) are the realistic source of a stray comma.
const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
appendFileSync(
  csvPath,
  `${rows
    .map((r) =>
      [
        csvCell(r.model),
        csvCell(r.id),
        csvCell(r.tier),
        csvCell(r.kind),
        csvCell(r.passed ? 1 : 0),
        csvCell(r.regressed ? 1 : 0),
        csvCell(r.status),
        csvCell(r.exitReason),
        csvCell(r.steps),
        csvCell(r.durationMs),
        csvCell(r.inputTok),
        csvCell(r.outputTok),
        csvCell(r.costUsd.toFixed(4)),
        csvCell(r.unmetered ? 1 : 0),
        csvCell(r.toolCalls),
        csvCell(r.toolErrors),
      ].join(','),
    )
    .join('\n')}\n`,
);

// Per-model, per-tier summary.
for (const model of models) {
  const mr = rows.filter((r) => r.model === model);
  if (mr.length === 0) continue;
  const passed = mr.filter((r) => r.passed).length;
  const regressed = mr.filter((r) => r.regressed).length;
  const outTok = mr.reduce((s, r) => s + r.outputTok, 0);
  const cost = mr.reduce((s, r) => s + r.costUsd, 0);
  const avgSec = mr.reduce((s, r) => s + r.durationMs, 0) / mr.length / 1000;
  const effort = mr.some((r) => r.unmetered)
    ? `${Math.round(outTok / 1000)}k out tok`
    : `$${cost.toFixed(2)}`;
  process.stderr.write(
    `\n=== ${model}: ${passed}/${mr.length} (${Math.round((100 * passed) / mr.length)}%)  ` +
      `${regressed ? `${regressed} regressed  ` : ''}${effort}  avg ${avgSec.toFixed(0)}s/task ===\n`,
  );
  for (const tr of [1, 2, 3] as const) {
    const tt = mr.filter((r) => r.tier === tr);
    if (tt.length)
      process.stderr.write(`  tier${tr}: ${tt.filter((r) => r.passed).length}/${tt.length}\n`);
  }
}
process.stderr.write(
  `\nappended ${rows.length} row(s) → evals/swe-bench/results.csv · logs → ${logDir}\n`,
);
