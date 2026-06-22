// Pure, side-effect-free core of the swe-bench corpus runner (scripts/swe-bench-run.ts): catalog
// resolution (egress host + api_key_env), agent-log metric parsing, and result scoring. Extracted so
// it is UNIT-TESTABLE — the runner script itself runs the bench on import (no import.meta.main guard),
// and each of these three classes of logic has already shipped a forwarded bug. The catalog functions
// take parsed ENTRIES (not a path) so a test injects fixtures instead of reading the operator's real
// catalog.
import { readFileSync } from 'node:fs';

// The provider prefix of a model id (the part before the first '/') maps to the host its traffic goes
// to — the egress allowlist the sidecar proxy enforces. Seeded openrouter/* and google/* entries ship
// with NO base_url (the adapter uses its own default endpoint), so the host must come from here.
export const PROVIDER_HOST: Record<string, string> = {
  ollama: 'ollama.com',
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
  google: 'generativelanguage.googleapis.com',
};

export interface CatalogEntry {
  id: string;
  base_url?: string;
  api_key_env?: string;
}

// Parse the mounted model catalog (model_providers.json). A missing/malformed file → [] (the caller's
// allowHostsFor then throws with a clearer per-model message).
export const loadCatalogEntries = (catalogPath: string): CatalogEntry[] => {
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as { models?: CatalogEntry[] };
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`swe-bench-run: could not parse catalog ${catalogPath} (${msg})\n`);
    return [];
  }
};

// The egress allowlist is EXACTLY the selected models' hosts. Per model: prefer the catalog entry's
// base_url hostname; else the provider-family default (PROVIDER_HOST). If NEITHER yields a host, THROW
// — opening egress for only the resolvable models would let an unresolved model's tasks fail with a
// masked network error, so a missing host is a loud configuration error.
export const allowHostsFor = (modelIds: string[], entries: CatalogEntry[]): string[] => {
  const hosts = new Set<string>();
  for (const m of modelIds) {
    // The model MUST exist in the catalog: the in-container forja resolves models STRICTLY from the
    // mounted model_providers.json, so a typo'd id (or an empty/malformed catalog) that still matched a
    // provider-family default below would pass this gate, then fail EVERY task in-container — wasting
    // the whole sweep on per-task failures instead of one loud config error before the bench starts.
    const entry = entries.find((e) => e.id === m);
    if (entry === undefined) {
      throw new Error(
        `swe-bench-run: model '${m}' is not in the catalog (model_providers.json) — forja resolves ` +
          `models strictly from it in-container, so the run would fail every task. Add the entry, or ` +
          `fix the --models id (a typo, or did the catalog parse to []?).`,
      );
    }
    let host: string | undefined;
    const baseUrl = entry.base_url;
    if (baseUrl !== undefined && baseUrl !== '') {
      try {
        host = new URL(baseUrl).hostname;
      } catch {
        // Fall through to PROVIDER_HOST below if base_url is malformed.
      }
    }
    if (host === undefined) host = PROVIDER_HOST[m.split('/')[0] ?? ''];
    if (host === undefined || host === '') {
      throw new Error(
        `swe-bench-run: no egress host for model '${m}' — no base_url in the catalog and no ` +
          `default for provider '${m.split('/')[0] ?? ''}'`,
      );
    }
    hosts.add(host);
  }
  if (hosts.size === 0)
    throw new Error(`swe-bench-run: no known egress host for models ${modelIds.join(', ')}`);
  return [...hosts];
};

// The distinct api_key_env of the selected models — forwarded into each container so the in-container
// forja can construct the provider. Entries with no key (a keyless local) are skipped; a model absent
// from the catalog already fails loudly in allowHostsFor.
export const apiKeyEnvsFor = (modelIds: string[], entries: CatalogEntry[]): string[] => {
  const envs = new Set<string>();
  for (const m of modelIds) {
    const env = entries.find((e) => e.id === m)?.api_key_env;
    if (env !== undefined && env !== '') envs.add(env);
  }
  return [...envs];
};

// Pull the run's metrics from the AGENT log. forja's done-line, e.g.
// "[done/done] 12 steps · 1109ms · tokens 7141/431 · unmetered" (or "· $0.0123" when metered), carries
// exit_reason/steps/tokens/cost. The metrics MUST come from the done-line alone: tool/test output
// earlier in the log also matches `[\w+/` and `\d+ steps`, so a whole-log scan would grab the FIRST
// such occurrence. Locate the done-line as the LAST line with a `[<class>/<reason>]` marker AND a step
// count — matching ANY class (done|error|exhausted and growing), not an allow-list that would silently
// miss e.g. `[exhausted/maxSteps]`. tool_calls/tool_errors ARE counted over the whole log (harness
// fluency — how cleanly the model drove the loop, not just whether it passed). Defaults are 0.
export const parseMetrics = (
  log: string,
): {
  reason: string;
  steps: number;
  inputTok: number;
  outputTok: number;
  unmetered: boolean;
  costUsd: number;
  toolCalls: number;
  toolErrors: number;
} => {
  let doneLine: string | undefined;
  for (const line of log.split('\n')) {
    if (/\[\w+\/\w+\][^\n]*\bsteps\b/.test(line)) doneLine = line;
  }
  const scope = doneLine ?? log;
  // exit_reason is the REASON half after the slash (`maxSteps`, `degenerateLoop`), NOT the class before
  // it (`exhausted`, `error`) — capturing the class collapses distinct budget/error exits into one bucket.
  const reason = scope.match(/\[\w+\/(\w+)\]/)?.[1] ?? '';
  const steps = Number(scope.match(/(\d+)\s+steps\b/)?.[1] ?? 0);
  const tk = scope.match(/tokens\s+(\d+)\/(\d+)/);
  const inputTok = Number(tk?.[1] ?? 0);
  const outputTok = Number(tk?.[2] ?? 0);
  const unmetered = /·\s*unmetered/.test(scope);
  const costUsd = Number(scope.match(/·\s*\$([\d.]+)/)?.[1] ?? 0);
  // Counted over the WHOLE log (not the done-line): tool calls (`→ tool`) and failed/denied results
  // (`✗ tool`). Two models can share a pass rate yet differ sharply in how cleanly they drive the loop.
  const toolCalls = (log.match(/^[ \t]*→ \w+/gm) ?? []).length;
  const toolErrors = (log.match(/^[ \t]*✗ \w+/gm) ?? []).length;
  return { reason, steps, inputTok, outputTok, unmetered, costUsd, toolCalls, toolErrors };
};

export interface ScoreInput {
  oracle: number | undefined;
  p2p: number | undefined;
  expectsP2P: boolean;
  agentTimedOut: boolean;
  restoreFailed: boolean;
  // forja exited with a non-normal code (not done/exhausted) — a startup/provider error (unresolvable
  // model, unset api_key_env) or a mid-loop crash. The agent did NOT produce a trustworthy attempt.
  agentError: boolean;
}

// Score a task from the verifier's oracle + PASS_TO_PASS exit codes. A task with a PASS_TO_PASS set
// MUST produce a .p2p exit code; a MISSING one (verifier killed / timed out after .result but before
// .p2p) means the regression check never ran — an ERROR, NOT a silent pass. Only a task with no
// siblings defaults the regression check to "passed". A `regressed` requires the check to have RUN
// and a sibling to have actually broken (not merely been skipped).
export const scoreResult = (
  i: ScoreInput,
): { passed: boolean; regressed: boolean; status: string } => {
  const oraclePassed = i.oracle === 0;
  const p2pMissing = i.expectsP2P && i.p2p === undefined;
  const p2pPassed = i.expectsP2P ? i.p2p === 0 : true;
  const regressed = oraclePassed && i.expectsP2P && i.p2p !== undefined && i.p2p !== 0;
  const passed = oraclePassed && p2pPassed;
  const status = i.agentTimedOut
    ? 'timeout'
    : i.agentError || i.restoreFailed || p2pMissing
      ? 'error'
      : i.oracle === undefined
        ? 'error'
        : 'ok';
  return { passed, regressed, status };
};
