import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { type BootstrapInput, bootstrap } from '../cli/bootstrap.ts';
import { type HarnessEvent, type HarnessResult, runAgent } from '../harness/index.ts';
import type { EvalCase, EvalCaseResult, EvalSummary, ExpectationOutcome } from './types.ts';

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
  toolName: string;
  args: Record<string, unknown>;
}

interface CompactionRecord {
  strategy: 'llm' | 'fallback' | 'skipped';
}

// Default project policy injected when the case (or its fixture)
// doesn't ship one. Evals run autonomously — there's no operator
// to confirm tool calls, so strict mode would dead-end every
// `read_file`/`write_file`/`bash`. Plan-mode block stays
// independent: it lives at the harness layer and fires regardless
// of policy. Cases that want stricter rules drop their own
// `.agent/permissions.yaml` via `setup.files` or `fixture`.
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

const setupCwd = (caseDef: EvalCase): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-eval-'));
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
  // Drop a default permissions.yaml only when the case+fixture
  // didn't provide one. Checking after fixture+files copy lets
  // either source override the default.
  const policyPath = join(dir, '.agent/permissions.yaml');
  if (!existsSync(policyPath)) {
    mkdirSync(join(dir, '.agent'), { recursive: true });
    writeFileSync(policyPath, DEFAULT_EVAL_POLICY_YAML);
  }
  return dir;
};

const evaluateExpectations = (
  caseDef: EvalCase,
  cwd: string,
  result: HarnessResult | undefined,
  invocations: ToolInvocation[],
  outputText: string,
  compactions: CompactionRecord[],
): ExpectationOutcome[] => {
  const calledTools = new Set(invocations.map((i) => i.toolName));
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
    }
  });
};

export const executeCase = async (
  caseDef: EvalCase,
  options: ExecuteOptions = {},
): Promise<EvalCaseResult> => {
  const startedAt = Date.now();
  const invocations: ToolInvocation[] = [];
  const compactions: CompactionRecord[] = [];
  let outputText = '';

  let cwd: string | undefined;
  let result: HarnessResult | undefined;
  let failure: string | undefined;

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

  try {
    cwd = setupCwd(caseDef);

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
      ...(caseDef.plan === true ? { plan: true } : {}),
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
            },
          }
        : {}),
      signal: controller.signal,
      ...(options.bootstrapOverride ?? {}),
    };

    const { config, db } = bootstrap(bootstrapInput);
    try {
      const cfg = {
        ...config,
        onEvent: (e: HarnessEvent) => {
          if (e.type === 'tool_invoking') {
            invocations.push({ toolName: e.toolName, args: e.args });
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
      db.close();
    }
  } catch (e) {
    failure = e instanceof Error ? e.message || e.name || String(e) : String(e);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
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
      : evaluateExpectations(caseDef, cwd, result, invocations, outputText, compactions);

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
    if (result.detail !== undefined) out.detail = result.detail;
  }
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
