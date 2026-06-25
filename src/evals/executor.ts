import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { type BootstrapInput, bootstrap } from '../cli/bootstrap.ts';
import {
  type CompactionStrategy,
  type HarnessEvent,
  type HarnessResult,
  runAgent,
} from '../harness/index.ts';
import { maybeWrapSandboxArgv } from '../permissions/sandbox-runner.ts';
import { closeDb } from '../storage/db.ts';
import { BUILTIN_TOOLS, createFetchUrlTool } from '../tools/builtin/index.ts';
import { type ToolRegistry, createToolRegistry } from '../tools/index.ts';
import type {
  EvalCase,
  EvalCaseResult,
  EvalHttpResponse,
  EvalSummary,
  ExpectationOutcome,
} from './types.ts';

// TEST-NET-3 (RFC 5737) — a public, non-routable address that passes the
// SSRF blocklist. The stubbed DNS resolves every host to it.
const STUB_RESOLVED_IP = '203.0.113.1';

// Make fetch_url hermetic for a case declaring `setup.httpStub`. An earlier
// version swapped `globalThis.fetch`, but the DNS-rebinding fix means
// fetch_url resolves the host, validates the IP, and connects to a PINNED IP
// URL with the real host in the Host header — so a global-fetch swap keyed on
// the request URL never matches, and the real DNS lookup of a reserved `.test`
// host fails first. Instead, inject the tool's deps directly: a `lookup` that
// returns STUB_RESOLVED_IP (so resolve+validate passes) and a `fetch` that
// maps the pinned request back to the ORIGINAL url (via the Host header) to
// find the canned response. Returns a fresh registry with the stubbed
// fetch_url swapped in; every other tool is the real builtin, and the
// provider's own API calls go through the untouched global fetch. Exported for
// direct unit testing.
export const buildFetchStubRegistry = (stub: Record<string, EvalHttpResponse>): ToolRegistry => {
  const fetchImpl = (input: string | URL, init?: RequestInit): Promise<Response> => {
    let pinned: URL;
    try {
      pinned = new URL(String(input));
    } catch {
      return Promise.reject(new Error(`eval httpStub: invalid request URL ${String(input)}`));
    }
    // The socket goes to the pinned IP; the original host rides the Host header.
    const host = new Headers(init?.headers).get('host') ?? pinned.host;
    const originalUrl = `${pinned.protocol}//${host}${pinned.pathname}${pinned.search}`;
    const canned = stub[originalUrl];
    if (canned === undefined) {
      return Promise.reject(new Error(`eval httpStub: no canned response for ${originalUrl}`));
    }
    return Promise.resolve(
      new Response(canned.body, {
        status: canned.status ?? 200,
        headers: { 'content-type': canned.contentType ?? 'text/html; charset=utf-8' },
      }),
    );
  };
  const lookupImpl = async (): Promise<{ address: string; family: number }[]> => [
    { address: STUB_RESOLVED_IP, family: 4 },
  ];
  const fetchTool = createFetchUrlTool({ fetchImpl, lookupImpl });
  const registry = createToolRegistry();
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool.name === 'fetch_url' ? fetchTool : tool);
  }
  return registry;
};

// Test seam: caller can pre-build a provider (mock for unit tests,
// real-from-registry for the smoke runner). Mirrors the `bootstrap`
// provider override.
export interface ExecuteOptions {
  // Required when no real API key is available — tests pass a mock
  // provider, smoke runner pulls from the registry. When omitted,
  // bootstrap uses the default model + env-derived API key.
  bootstrapOverride?: Partial<BootstrapInput>;
  // External signal to abort the run. Each case derives its own
  // child controller so a per-case timeout can fire independently;
  // if the parent aborts, all cases see the abort.
  signal?: AbortSignal;
  // Hard wall clock per case. Default 60s; smoke tier should stay
  // well under per spec §16. Triggers `aborted` on the harness.
  perCaseTimeoutMs?: number;
}

interface ToolInvocation {
  toolUseId: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface ToolDecisionRecord {
  toolUseId: string;
  kind: 'allow' | 'confirm' | 'deny';
}

interface CompactionRecord {
  strategy: CompactionStrategy;
}

// Default project policy injected when the case (or its fixture)
// doesn't ship one. Evals run autonomously — there's no operator
// to confirm tool calls, so strict mode would dead-end every
// `read_file`/`write_file`/`bash`. Cases that want stricter rules
// drop their own `.forja/permissions.yaml` via `setup.files` or
// `fixture`.
const DEFAULT_EVAL_POLICY_YAML = `defaults:
  mode: bypass
`;

// Refuse setup.files paths that would write outside the eval
// workspace. Eval YAML is shareable (CI, gist links, registry);
// `../../../etc/cron.d/payload` or `/tmp/exfil` would happily
// land via the previous `join(dir, relPath)` if relPath was
// crafted to escape. `resolve(dir, relPath)` collapses `..`
// segments and absolute prefixes; we then prove containment
// against the resolved sandbox root before writing.
const containsPath = (parent: string, child: string): boolean => {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (resolvedChild === resolvedParent) return true;
  return resolvedChild.startsWith(resolvedParent + sep);
};

// Eval sandbox cwd lives under `~/.cache/forja-eval/`, NOT the OS
// tmpdir, because the runtime sandbox (`src/permissions/sandbox-runner.ts`)
// adds `--tmpfs /tmp` to its `ro` profile — that overlays the host's
// /tmp with an empty tmpfs inside the sandbox, masking any eval
// workspace that was created there. Tools running in `ro`
// (`grep`, `glob`, `read_file` defaults) would see an empty
// directory and return zero results, silently failing every case
// that relies on a fixture or `setup.files`. The home cache dir sits
// under the `--ro-bind / /` mount and is visible to read-only tools;
// the `cwd-rw` profile re-binds it writably for write tools. The OS
// tmpdir is still preferred for the per-run DB path because that's
// only consumed by the test process (no sandbox traversal).
//
// Resolution order (`resolveEvalCacheRoot` below — exported for unit
// tests to exercise each branch without process-env churn):
//
//   1. `FORJA_EVAL_CACHE_DIR` env var — operator escape hatch for
//      constrained environments (read-only home in some k8s pods,
//      distroless containers running as non-root with no writable
//      HOME, NFS read-only home mounts, macOS sandbox profiles
//      restricting home access). Point it at any writable path the
//      sandbox can see — must NOT be under /tmp for the reason
//      above.
//   2. `~/.cache/forja-eval/` — the default for normal dev + CI
//      environments where HOME is writable.
//   3. `tmpdir()` — degraded fallback only when HOME is empty AND
//      no override is set. Fixture-backed cases will SILENTLY
//      return zero matches inside the sandbox because of the /tmp
//      masking; the run starts cleanly instead of crashing at
//      import time, but operators landing here should set
//      `FORJA_EVAL_CACHE_DIR` to escape the degradation.
//
// `setupCwd` wraps `mkdirSync(EVAL_CACHE_ROOT, ...)` in a try/catch
// to convert EACCES/ENOTDIR/ENOSPC into a clear actionable error
// that names the path AND surfaces the env-var escape hatch —
// the bare `mkdirSync` throw was a generic Node error that gave
// the operator no path to recovery.
export const resolveEvalCacheRoot = (env: NodeJS.ProcessEnv, home: string): string => {
  const override = env.FORJA_EVAL_CACHE_DIR;
  if (override !== undefined && override.length > 0) return override;
  if (home.length > 0) return join(home, '.cache', 'forja-eval');
  return tmpdir();
};

const EVAL_CACHE_ROOT = resolveEvalCacheRoot(process.env, homedir());

interface SetupResult {
  dir: string;
}

const setupCwd = (caseDef: EvalCase): SetupResult => {
  try {
    mkdirSync(EVAL_CACHE_ROOT, { recursive: true });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(
      `eval setup: cannot create cache root at ${EVAL_CACHE_ROOT} (${cause}). Set FORJA_EVAL_CACHE_DIR to a writable path outside /tmp (the runtime sandbox masks /tmp; see comment in src/evals/executor.ts).`,
    );
  }
  const dir = mkdtempSync(join(EVAL_CACHE_ROOT, 'case-'));
  if (caseDef.setup?.fixture !== undefined) {
    const caseDir = dirname(caseDef.sourcePath);
    // Boundary: fixture must resolve under the parent of the
    // case file's directory. Allows reaching sibling dirs
    // (`../fixtures/foo` — our own smoke layout) but refuses
    // climbing further (`../../..`) or jumping out entirely
    // via absolute paths (`/etc`). Loader-level check rejects
    // absolute paths at parse time; this guard catches `..`
    // traversal escapes and protects programmatic EvalCase
    // construction that bypasses the loader.
    const boundary = dirname(caseDir);
    const src = resolve(caseDir, caseDef.setup.fixture);
    if (!containsPath(boundary, src)) {
      throw new Error(
        `eval setup.fixture '${caseDef.setup.fixture}' escapes the case boundary (${boundary})`,
      );
    }
    if (!existsSync(src)) {
      throw new Error(`fixture not found: ${src}`);
    }
    cpSync(src, dir, { recursive: true });
  }
  if (caseDef.setup?.files !== undefined) {
    for (const [relPath, body] of Object.entries(caseDef.setup.files)) {
      const target = resolve(dir, relPath);
      if (!containsPath(dir, target)) {
        throw new Error(`eval setup.files path '${relPath}' escapes the eval workspace`);
      }
      const targetDir = dirname(target);
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
      writeFileSync(target, body);
    }
  }
  // git work-tree init for tools that require a repo (git_apply_patch). Done
  // after fixture+files so the tree has the case's content. Fails loud — a
  // silent miss would make a gitInit case dead-end on git.not_a_repo and look
  // like a tool failure.
  if (caseDef.setup?.gitInit === true) {
    const r = Bun.spawnSync({
      cmd: ['git', 'init', '-q'],
      cwd: dir,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    if (!r.success) {
      throw new Error(
        `eval setup.gitInit: 'git init' failed in ${dir} (is git installed?): ${r.stderr.toString().trim()}`,
      );
    }
  }
  // Drop a default permissions.yaml only when the case+fixture
  // didn't provide one. Checking after fixture+files copy lets
  // either source override the default.
  //
  // CANONICAL `.forja/` — NOT profile-aware. Eval cases author their
  // fixtures/setup.files against `.forja/permissions.yaml`, and the run is made
  // hermetic w.r.t. FORJA_PROFILE in `executeCase` (it clears the env so
  // bootstrap reads here too). Routing this through `projectDirName()` would
  // look for `.forja-<profile>/` under a dev-profile shell, miss the case's
  // policy, and silently run the default — experiments against the wrong policy.
  const policyPath = join(dir, '.forja', 'permissions.yaml');
  if (!existsSync(policyPath)) {
    mkdirSync(join(dir, '.forja'), { recursive: true });
    writeFileSync(policyPath, DEFAULT_EVAL_POLICY_YAML);
  }
  return { dir };
};

// `command_succeeds` default timeout — generous for `bun test <file>` + `bun run typecheck`
// (the self-SWE-bench verifiers); a case overrides via `timeout_ms`. After it elapses the
// command is killed and the expectation FAILS (a hung verifier is a fail, not a hang).
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

const evaluateExpectations = (
  caseDef: EvalCase,
  cwd: string,
  result: HarnessResult | undefined,
  invocations: ToolInvocation[],
  outputText: string,
  compactions: CompactionRecord[],
  decisions: ToolDecisionRecord[],
): ExpectationOutcome[] => {
  const calledTools = new Set(invocations.map((i) => i.toolName));
  // Stitch decisions back to tool names via toolUseId. The
  // harness emits `tool_invoking` (carries name + id) before
  // `tool_decided` (carries id + decision); the executor records
  // both, then we join here. Using ids beats positional matching
  // because failed invocations (unknown tool, no decision emitted)
  // would otherwise misalign the index.
  const idToName = new Map(invocations.map((i) => [i.toolUseId, i.toolName]));
  const denialsByTool = new Set<string>();
  for (const d of decisions) {
    if (d.kind !== 'deny') continue;
    const name = idToName.get(d.toolUseId);
    if (name !== undefined) denialsByTool.add(name);
  }
  return caseDef.expect.map((expectation): ExpectationOutcome => {
    switch (expectation.kind) {
      case 'tool_called': {
        const passed = calledTools.has(expectation.tool);
        return {
          expectation,
          passed,
          ...(passed
            ? {}
            : {
                detail: `tool '${expectation.tool}' was not called (called: ${[...calledTools].join(', ') || '<none>'})`,
              }),
        };
      }
      case 'tool_not_called': {
        const passed = !calledTools.has(expectation.tool);
        return {
          expectation,
          passed,
          ...(passed ? {} : { detail: `tool '${expectation.tool}' was called` }),
        };
      }
      case 'tool_denied': {
        const passed = denialsByTool.has(expectation.tool);
        if (passed) return { expectation, passed };
        const seen = [...denialsByTool].join(', ') || '<no denies>';
        if (!calledTools.has(expectation.tool)) {
          return {
            expectation,
            passed: false,
            detail: `tool '${expectation.tool}' was never invoked, so no deny could fire (denied tools: ${seen})`,
          };
        }
        return {
          expectation,
          passed: false,
          detail: `tool '${expectation.tool}' was invoked but allowed (denied tools: ${seen})`,
        };
      }
      case 'file_exists': {
        const target = resolve(cwd, expectation.path);
        if (!containsPath(cwd, target)) {
          return {
            expectation,
            passed: false,
            detail: `file '${expectation.path}' escapes the eval workspace`,
          };
        }
        const passed = existsSync(target);
        return {
          expectation,
          passed,
          ...(passed ? {} : { detail: `file '${expectation.path}' does not exist` }),
        };
      }
      case 'file_not_exists': {
        const target = resolve(cwd, expectation.path);
        if (!containsPath(cwd, target)) {
          return {
            expectation,
            passed: false,
            detail: `file '${expectation.path}' escapes the eval workspace`,
          };
        }
        const passed = !existsSync(target);
        return {
          expectation,
          passed,
          ...(passed ? {} : { detail: `file '${expectation.path}' exists but should not` }),
        };
      }
      case 'file_contains': {
        const target = resolve(cwd, expectation.path);
        if (!containsPath(cwd, target)) {
          return {
            expectation,
            passed: false,
            detail: `file '${expectation.path}' escapes the eval workspace`,
          };
        }
        if (!existsSync(target)) {
          return {
            expectation,
            passed: false,
            detail: `file '${expectation.path}' does not exist`,
          };
        }
        const body = readFileSync(target, 'utf8');
        const passed = body.includes(expectation.pattern);
        return {
          expectation,
          passed,
          ...(passed
            ? {}
            : {
                detail: `file '${expectation.path}' does not contain pattern '${expectation.pattern}'`,
              }),
        };
      }
      case 'file_not_contains': {
        const target = resolve(cwd, expectation.path);
        if (!containsPath(cwd, target)) {
          return {
            expectation,
            passed: false,
            detail: `file '${expectation.path}' escapes the eval workspace`,
          };
        }
        if (!existsSync(target)) {
          return {
            expectation,
            passed: false,
            detail: `file '${expectation.path}' does not exist`,
          };
        }
        const body = readFileSync(target, 'utf8');
        const passed = !body.includes(expectation.pattern);
        return {
          expectation,
          passed,
          ...(passed
            ? {}
            : {
                detail: `file '${expectation.path}' still contains pattern '${expectation.pattern}'`,
              }),
        };
      }
      case 'status': {
        if (result === undefined) {
          return { expectation, passed: false, detail: 'run did not produce a result' };
        }
        const passed = result.status === expectation.status;
        return {
          expectation,
          passed,
          ...(passed
            ? {}
            : { detail: `status was '${result.status}', expected '${expectation.status}'` }),
        };
      }
      case 'exit_reason': {
        if (result === undefined) {
          return { expectation, passed: false, detail: 'run did not produce a result' };
        }
        const passed = result.reason === expectation.reason;
        return {
          expectation,
          passed,
          ...(passed
            ? {}
            : { detail: `exit reason was '${result.reason}', expected '${expectation.reason}'` }),
        };
      }
      case 'output_contains': {
        const passed = outputText.includes(expectation.pattern);
        return {
          expectation,
          passed,
          ...(passed
            ? {}
            : { detail: `assistant output did not contain '${expectation.pattern}'` }),
        };
      }
      case 'min_steps': {
        const steps = result?.steps ?? 0;
        const passed = steps >= expectation.count;
        return {
          expectation,
          passed,
          ...(passed
            ? {}
            : { detail: `ran ${steps} step(s), expected at least ${expectation.count}` }),
        };
      }
      case 'compaction_triggered': {
        const matching =
          expectation.strategy === undefined
            ? compactions
            : compactions.filter((c) => c.strategy === expectation.strategy);
        const passed = matching.length >= expectation.minCount;
        if (passed) return { expectation, passed };
        const seen = compactions.map((c) => c.strategy).join(', ') || '<none>';
        const target =
          expectation.strategy === undefined
            ? `≥ ${expectation.minCount} compaction(s)`
            : `≥ ${expectation.minCount} compaction(s) with strategy='${expectation.strategy}'`;
        return {
          expectation,
          passed,
          detail: `expected ${target}, observed strategies: [${seen}]`,
        };
      }
      case 'command_succeeds': {
        // Runs AFTER the agent, in the workspace it edited. The command STRING is trusted
        // eval-author config — NEVER model-controlled, so `sh -c` carries no injection risk.
        // But the command EXECUTES the files in the workspace, which the agent (a model under
        // eval) wrote. `sandboxed` wraps it in the `cwd-rw` profile: the host FS is read-VISIBLE
        // (--ro-bind / /), but only the cwd is WRITABLE, the network is off, and --clearenv drops
        // *_KEY/*_TOKEN — so model-authored code can't WRITE outside the workspace, reach the network,
        // or read a key from env. Load-bearing here (else: ACE with the runner's full env / FS / network
        // on the eval host). It can still READ the host FS, so this is write + network + key isolation,
        // NOT read isolation — a secret it reads can only land back in the cwd it already owns. Hermetic
        // author-authored commands leave it off.
        const timeoutMs = expectation.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        try {
          const innerArgv = ['sh', '-c', expectation.command];
          // failClosed:true so a host with NO sandbox tool FAILS the verifier (caught below)
          // instead of silently running model-authored code unsandboxed with the runner's full
          // env/FS — the gate must not fail OPEN. With bwrap present, --clearenv + the
          // SAFE_ENV_VARS allowlist drop *_KEY/*_TOKEN, so no separate env scrub is needed.
          // The wrap is inside the try so a fail-closed throw fails THIS expectation, not the
          // run; `r` declared here keeps the narrow `stdout:'pipe'` overload (Buffers, never
          // undefined — annotating it widens back to the union).
          const argv =
            expectation.sandboxed === true
              ? maybeWrapSandboxArgv({ profile: 'cwd-rw', cwd, innerArgv, failClosed: true })
              : innerArgv;
          const r = Bun.spawnSync({
            cmd: argv,
            cwd,
            timeout: timeoutMs,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          if (r.success) return { expectation, passed: true };
          const tail = (b: { toString(): string }): string =>
            b.toString().trim().split('\n').slice(-10).join('\n');
          // SIGTERM is the signal Bun's `timeout` kills with → label it a timeout. Any OTHER
          // signal (SIGSEGV / SIGKILL / SIGABRT) is the command crashing on its own, possibly
          // well within budget — report the signal, not a timeout that never elapsed.
          const why =
            r.signalCode === 'SIGTERM'
              ? `timed out after ${timeoutMs}ms (SIGTERM)`
              : r.signalCode != null
                ? `killed by ${r.signalCode}`
                : `exit ${r.exitCode}`;
          const logTail = tail(r.stderr) || tail(r.stdout);
          return {
            expectation,
            passed: false,
            detail: `command '${expectation.command}' failed (${why})${logTail ? `\n${logTail}` : ''}`,
          };
        } catch (e) {
          // Either the spawn could not START (no `sh` on PATH — a Windows host without Git
          // Bash / WSL) OR a `sandboxed` verifier failed closed (no sandbox tool on the host).
          // Fail THIS expectation; don't let the throw crash the whole case.
          return {
            expectation,
            passed: false,
            detail: `command '${expectation.command}' could not start: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
    }
  });
};

export const executeCase = async (
  caseDef: EvalCase,
  options: ExecuteOptions = {},
): Promise<EvalCaseResult> => {
  const startedAt = Date.now();
  const invocations: ToolInvocation[] = [];
  const decisions: ToolDecisionRecord[] = [];
  const compactions: CompactionRecord[] = [];
  let outputText = '';

  let cwd: string | undefined;
  let result: HarnessResult | undefined;
  let failure: string | undefined;
  // Captured from the resolved provider (config is scoped to the try below): an
  // unmetered tier reports $0 from computeCost, which the ranking must show as
  // blank, not free.
  let unmetered = false;

  // Per-case timeout: chained off the caller's signal so a parent
  // abort still cancels in-flight work. The timer is cleared in
  // finally so a fast pass doesn't leak handles.
  const timeoutMs = options.perCaseTimeoutMs ?? 60_000;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (options.signal?.aborted === true) {
    controller.abort();
  } else {
    options.signal?.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Pin OpenAI reasoning replay OFF for eval determinism: it now defaults ON and
  // is NOT gated by the `thinkingBudget: 0` pin below (that only disables Anthropic
  // thinking), so an OpenAI eval would otherwise replay reasoning items and drift
  // the baseline. Only default it when unset — the reasoning-replay A/B sets the
  // flag explicitly per arm (via the runner) and must win. Restored in `finally`.
  // (Anthropic replay needs no pin: with thinking off in evals there's nothing to
  // replay.)
  const prevOpenaiReplay = process.env.FORJA_OPENAI_REASONING_REPLAY;
  if (prevOpenaiReplay === undefined) process.env.FORJA_OPENAI_REASONING_REPLAY = '0';

  // Evals are HERMETIC w.r.t. FORJA_PROFILE. Cases author fixtures against the
  // canonical `.forja/`, and both the default-policy write (setupCwd) and the
  // policy read (bootstrap, below) resolve their project dir from
  // process.env.FORJA_PROFILE. A dev running evals from a `--profile dev` shell
  // would otherwise resolve `.forja-dev/`, miss the case's `.forja/` policy, and
  // silently run against the default — experiments on the wrong policy. Clear it
  // for the case (the eval DB is a temp file, unaffected); restored in finally.
  const prevProfile = process.env.FORJA_PROFILE;
  if (prevProfile !== undefined) delete process.env.FORJA_PROFILE;

  try {
    const setup = setupCwd(caseDef);
    cwd = setup.dir;

    const dbPath = join(cwd, '.forja-eval-sessions.db');
    const bootstrapInput: BootstrapInput = {
      prompt: caseDef.prompt,
      cwd,
      dbPath,
      // Tests pass a mock provider via override; the smoke runner
      // passes a real model id. When neither is supplied, bootstrap
      // falls through to the default model and will need ANTHROPIC_API_KEY.
      enterprisePolicyPath: null,
      userPolicyPath: null,
      // Default temperature 0 makes evals deterministic. Cases or
      // callers can override via `bootstrapOverride.temperature`
      // when stochasticity is the property under test.
      temperature: 0,
      // Thinking now defaults ON in production, but evals pin it OFF
      // (disable-via-zero) for reproducible pass/fail — thinking adds reasoning
      // variance and, on adaptive models, strips the temperature pin above. A
      // case/override that sets `thinkingBudget` (e.g. the reasoning-replay A/B)
      // wins via the bootstrapOverride spread below.
      thinkingBudget: 0,
      ...(caseDef.setup?.approvalPosture !== undefined
        ? { approvalPosture: caseDef.setup.approvalPosture }
        : {}),
      ...(caseDef.budget !== undefined
        ? {
            budget: {
              ...(caseDef.budget.maxSteps !== undefined
                ? { maxSteps: caseDef.budget.maxSteps }
                : {}),
              ...(caseDef.budget.compactionThreshold !== undefined
                ? { compactionThreshold: caseDef.budget.compactionThreshold }
                : {}),
              ...(caseDef.budget.compactionPreserveTail !== undefined
                ? { compactionPreserveTail: caseDef.budget.compactionPreserveTail }
                : {}),
              ...(caseDef.budget.compactionRelevance !== undefined
                ? { compactionRelevance: caseDef.budget.compactionRelevance }
                : {}),
              ...(caseDef.budget.compactionMaxTokens !== undefined
                ? { compactionMaxTokens: caseDef.budget.compactionMaxTokens }
                : {}),
            },
          }
        : {}),
      signal: controller.signal,
      ...(options.bootstrapOverride ?? {}),
    };

    const { config, db } = await bootstrap(bootstrapInput);
    unmetered = config.provider.capabilities.unmetered === true;
    // Hermetic HTTP stub (setup.httpStub): swap in a fetch_url whose DNS +
    // fetch are stubbed (the post-pinning tool can't be stubbed via the global
    // fetch — see buildFetchStubRegistry). No global mutation; the provider's
    // own API calls use the untouched global fetch.
    const httpStub = caseDef.setup?.httpStub;
    try {
      const cfg = {
        ...config,
        ...(httpStub !== undefined ? { toolRegistry: buildFetchStubRegistry(httpStub) } : {}),
        onEvent: (e: HarnessEvent) => {
          if (e.type === 'tool_invoking') {
            invocations.push({ toolUseId: e.toolUseId, toolName: e.toolName, args: e.args });
            return;
          }
          if (e.type === 'tool_decided') {
            decisions.push({ toolUseId: e.toolUseId, kind: e.decision.kind });
            return;
          }
          // tool_finished.denied catches denial paths the engine
          // alone doesn't model: confirm_no (engine returned
          // confirm, user said no) and hook block (engine
          // returned allow, PreToolUse hook refused). Without
          // this branch, an eval `tool_denied` expectation
          // would silently fail for those paths even though the
          // tool truly did not run.
          if (e.type === 'tool_finished' && e.denied === true) {
            decisions.push({ toolUseId: e.toolUseId, kind: 'deny' });
            return;
          }
          if (e.type === 'compaction_finished') {
            compactions.push({ strategy: e.strategy });
            return;
          }
          if (e.type === 'provider_event' && e.event.kind === 'text_delta') {
            outputText += e.event.text;
          }
        },
      };
      result = await runAgent(cfg);
    } finally {
      closeDb(db);
    }
  } catch (e) {
    failure = e instanceof Error ? e.message || e.name || String(e) : String(e);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
    if (prevOpenaiReplay === undefined) delete process.env.FORJA_OPENAI_REASONING_REPLAY;
    if (prevProfile !== undefined) process.env.FORJA_PROFILE = prevProfile;
  }

  // Evaluate expectations BEFORE cleanup so file_exists/file_contains
  // can still see the run's filesystem mutations. Cleanup happens
  // in the second finally below.
  const expectations =
    cwd === undefined || failure !== undefined
      ? caseDef.expect.map(
          (expectation): ExpectationOutcome => ({
            expectation,
            passed: false,
            detail: failure ?? 'setup failed',
          }),
        )
      : evaluateExpectations(caseDef, cwd, result, invocations, outputText, compactions, decisions);

  if (cwd !== undefined) {
    rmSync(cwd, { recursive: true, force: true });
  }

  const costUsd = result?.costUsd ?? 0;
  const steps = result?.steps ?? 0;
  const usageComplete = result?.usageComplete ?? false;

  // Budget cost check: run can succeed on every expectation but
  // still fail the case if it overspent. Budget is a hard cap per
  // spec §16; passing it would give us a green dashboard while the
  // bill grew.
  const overBudget =
    caseDef.budget?.maxCostUsd !== undefined && costUsd > caseDef.budget.maxCostUsd;
  const allPassed = expectations.every((o) => o.passed);
  const passed = failure === undefined && allPassed && !overBudget;

  const out: EvalCaseResult = {
    name: caseDef.name,
    sourcePath: caseDef.sourcePath,
    passed,
    durationMs: Date.now() - startedAt,
    costUsd,
    steps,
    usageComplete,
    expectations,
  };
  if (result !== undefined) {
    out.status = result.status;
    out.exitReason = result.reason;
    out.usage = result.usage;
    if (result.detail !== undefined) out.detail = result.detail;
  }
  if (unmetered) out.unmetered = true;
  if (failure !== undefined) {
    out.failure = failure;
  } else if (overBudget) {
    out.failure = `cost ${costUsd.toFixed(4)} exceeded budget ${caseDef.budget?.maxCostUsd?.toFixed(4)}`;
  }
  return out;
};

const median = (xs: readonly number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] ?? 0;
    const hi = sorted[mid] ?? 0;
    return (lo + hi) / 2;
  }
  return sorted[mid];
};

export const summarize = (results: readonly EvalCaseResult[]): EvalSummary => {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const costs = results.map((r) => r.costUsd);
  const p50 = median(costs);
  const totalCostUsd = costs.reduce((a, b) => a + b, 0);
  const totalDurationMs = results.reduce((a, r) => a + r.durationMs, 0);
  const summary: EvalSummary = {
    total,
    passed,
    failed: total - passed,
    passRate: total === 0 ? 0 : passed / total,
    totalCostUsd,
    totalDurationMs,
  };
  if (p50 !== undefined) summary.p50CostUsd = p50;
  return summary;
};
