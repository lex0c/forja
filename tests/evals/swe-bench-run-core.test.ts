import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentRunIsInfraFailure,
  allowHostsFor,
  apiKeyEnvsFor,
  type CatalogEntry,
  costForModel,
  loadCatalogEntries,
  parseMetrics,
  parseNumstat,
  scoreResult,
} from '../../src/evals/swe-bench/runner-core.ts';
import type { ProviderCapabilities } from '../../src/providers/types.ts';

// Pure core of scripts/swe-bench-run.ts. The runner script runs the bench on import (no
// import.meta.main guard), so its host/key/score/metric logic — each of which has shipped a forwarded
// bug — was untestable until extracted here. These tests inject catalog fixtures, never the real one.

describe('scoreResult', () => {
  const s = (
    oracle: number | undefined,
    p2p: number | undefined,
    expectsP2P: boolean,
    agentTimedOut = false,
    restoreFailed = false,
    agentError = false,
  ) => scoreResult({ oracle, p2p, expectsP2P, agentTimedOut, restoreFailed, agentError });

  test('no PASS_TO_PASS, oracle passes → passed/ok', () => {
    expect(s(0, undefined, false)).toEqual({ passed: true, regressed: false, status: 'ok' });
  });
  test('PASS_TO_PASS present and passing → passed/ok', () => {
    expect(s(0, 0, true)).toEqual({ passed: true, regressed: false, status: 'ok' });
  });
  test('a sibling regressed (p2p != 0) → not passed, regressed, ok', () => {
    expect(s(0, 1, true)).toEqual({ passed: false, regressed: true, status: 'ok' });
  });
  // The forwarded bug: a task that EXPECTS a p2p result but the verifier produced none (killed after
  // .result, before .p2p) must be an ERROR — never a silent pass on an unchecked regression.
  test('expects p2p but none produced → error, not a silent pass', () => {
    expect(s(0, undefined, true)).toEqual({ passed: false, regressed: false, status: 'error' });
  });
  test('oracle fails → not passed', () => {
    expect(s(1, 0, true)).toEqual({ passed: false, regressed: false, status: 'ok' });
  });
  test('agent timed out (verifier skipped → oracle undefined) → timeout, not passed', () => {
    expect(s(undefined, undefined, true, true)).toEqual({
      passed: false,
      regressed: false,
      status: 'timeout',
    });
  });
  test('restore failed (verifier skipped) → error', () => {
    expect(s(undefined, undefined, true, false, true)).toEqual({
      passed: false,
      regressed: false,
      status: 'error',
    });
  });
  // A forja startup/provider error (unresolvable model, unset api_key_env, mid-loop crash) must score
  // as a harness error — NOT a 0-step "model failure" that corrupts the benchmark as incapacity.
  test('a forja startup/provider error (agentError) → error, never a scored model failure', () => {
    expect(s(undefined, undefined, true, false, false, true)).toEqual({
      passed: false,
      regressed: false,
      status: 'error',
    });
  });
});

describe('agentRunIsInfraFailure', () => {
  const f = (success: boolean, timedOut: boolean, wroteError: boolean) =>
    agentRunIsInfraFailure({ success, timedOut, wroteError });
  // The forwarded bug: `docker run` dies before the entrypoint (daemon / mount / image / startup) — no
  // .agent_error, no timeout, just a non-success exit. Must read as INFRA, not a 0-step model attempt.
  test('docker run failed, no timeout, no .agent_error → infra failure', () => {
    expect(f(false, false, false)).toBe(true);
  });
  test('a normal success is not infra', () => {
    expect(f(true, false, false)).toBe(false);
  });
  test('a timeout is owned by the timeout path, not infra', () => {
    expect(f(false, true, false)).toBe(false);
  });
  test('an entrypoint-written .agent_error is owned by the agentError path, not infra', () => {
    expect(f(false, false, true)).toBe(false);
  });
});

describe('costForModel', () => {
  const caps = (c: Partial<ProviderCapabilities>): ProviderCapabilities =>
    c as ProviderCapabilities;
  const entries: CatalogEntry[] = [
    {
      id: 'anthropic/claude-opus-4-8',
      capabilities: caps({
        cost_per_1k_input: 5,
        cost_per_1k_output: 25,
        cost_per_1k_cached_input: 0.5,
        cost_per_1k_cache_write: 6.25,
      }),
    },
    { id: 'ollama/glm-5.2', capabilities: caps({ unmetered: true }) },
  ];
  const usage = (input: number, output: number, cache_read: number, cache_creation: number) => ({
    input,
    output,
    cache_read,
    cache_creation,
  });

  // The forwarded bug: a maxSteps runaway logs $0 on its done-line but cache-wrote millions of tokens.
  // costForModel prices it from the RECORDED usage, never trusting the $0 — else the cost chart undercounts.
  test('abnormal-terminal usage (done-line would log $0) is still priced from tokens', () => {
    const cost = costForModel('anthropic/claude-opus-4-8', usage(0, 0, 468496, 2851992), entries);
    expect(cost).toBeCloseTo((468496 * 0.5 + 2851992 * 6.25) / 1_000_000, 4);
  });
  test('a fully-priced turn sums input + output + cache-read + cache-write', () => {
    const cost = costForModel('anthropic/claude-opus-4-8', usage(1000, 2000, 3000, 4000), entries);
    expect(cost).toBeCloseTo((1000 * 5 + 2000 * 25 + 3000 * 0.5 + 4000 * 6.25) / 1_000_000, 6);
  });
  test('an unmetered model is 0 (untracked, not a real $0)', () => {
    expect(costForModel('ollama/glm-5.2', usage(1000, 2000, 3000, 4000), entries)).toBe(0);
  });
  test('a model absent from the catalog is 0 (cannot price it)', () => {
    expect(costForModel('openai/ghost', usage(1000, 2000, 3000, 4000), entries)).toBe(0);
  });
});

describe('allowHostsFor', () => {
  const entries: CatalogEntry[] = [
    { id: 'openrouter/deepseek/deepseek-r1', api_key_env: 'OPENROUTER_API_KEY' },
    { id: 'google/gemini-2.5-flash', api_key_env: 'GOOGLE_API_KEY' },
    {
      id: 'ollama/qwen3-coder:480b',
      base_url: 'https://ollama.com',
      api_key_env: 'OLLAMA_API_KEY',
    },
  ];

  test('seeded openrouter/google (no base_url) resolve via the provider-family default', () => {
    expect(allowHostsFor(['openrouter/deepseek/deepseek-r1'], entries)).toEqual(['openrouter.ai']);
    expect(allowHostsFor(['google/gemini-2.5-flash'], entries)).toEqual([
      'generativelanguage.googleapis.com',
    ]);
  });
  test("an entry's base_url wins over the family default", () => {
    expect(allowHostsFor(['ollama/qwen3-coder:480b'], entries)).toEqual(['ollama.com']);
  });
  test('distinct hosts across models, no dupes', () => {
    expect(
      allowHostsFor(['openrouter/deepseek/deepseek-r1', 'google/gemini-2.5-flash'], entries).sort(),
    ).toEqual(['generativelanguage.googleapis.com', 'openrouter.ai']);
  });
  test('a model absent from the catalog THROWS (loud config error, not a wasted sweep)', () => {
    // not in `entries` → fails BEFORE host resolution (the in-container forja couldn't resolve it either)
    expect(() => allowHostsFor(['mystery/model'], entries)).toThrow(/not in the catalog/);
  });
  test('a CATALOGUED model with an unknown provider prefix and no base_url THROWS (no egress host)', () => {
    const e: CatalogEntry[] = [{ id: 'mystery/model', api_key_env: 'K' }];
    expect(() => allowHostsFor(['mystery/model'], e)).toThrow(/no egress host/);
  });
});

describe('apiKeyEnvsFor', () => {
  const entries: CatalogEntry[] = [
    { id: 'openrouter/x', api_key_env: 'OPENROUTER_API_KEY' },
    { id: 'google/y', api_key_env: 'GOOGLE_API_KEY' },
    { id: 'local/keyless' }, // no api_key_env → skipped
  ];
  test('collects the distinct api_key_env of the selected models', () => {
    expect(apiKeyEnvsFor(['openrouter/x', 'google/y'], entries).sort()).toEqual([
      'GOOGLE_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
  });
  test('skips a keyless entry and a model absent from the catalog', () => {
    expect(apiKeyEnvsFor(['local/keyless', 'not/in/catalog'], entries)).toEqual([]);
  });
  test('dedupes a shared key', () => {
    const e: CatalogEntry[] = [
      { id: 'a/1', api_key_env: 'K' },
      { id: 'a/2', api_key_env: 'K' },
    ];
    expect(apiKeyEnvsFor(['a/1', 'a/2'], e)).toEqual(['K']);
  });
});

describe('parseMetrics', () => {
  test('reads the done-line: reason/steps/tokens/cost', () => {
    const m = parseMetrics('noise\n[done/done] 12 steps · 1109ms · tokens 7141/431 · $0.0123\n');
    expect(m).toMatchObject({ reason: 'done', steps: 12, inputTok: 7141, outputTok: 431 });
    expect(m.costUsd).toBe(0.0123);
    expect(m.unmetered).toBe(false);
  });
  test('the REASON half (not the class) of a non-clean exit + the unmetered flag', () => {
    const m = parseMetrics('[exhausted/maxSteps] 40 steps · 5s · tokens 100/50 · unmetered\n');
    expect(m.reason).toBe('maxSteps'); // the half AFTER the slash, not "exhausted"
    expect(m.unmetered).toBe(true);
    expect(m.costUsd).toBe(0);
  });
  test('the LAST done-line wins over earlier tool output that also matches', () => {
    const log =
      '→ bash {"command":"echo [fake/line] 99 steps"}\n  ✓ bash\n[done/done] 3 steps · 10ms · tokens 5/5 · unmetered\n';
    expect(parseMetrics(log).steps).toBe(3);
  });
  test('counts tool calls (→) and errors (✗) over the whole log', () => {
    const log =
      '→ bash {}\n  ✓ bash (5ms)\n→ read_file {}\n  ✓ read_file (1ms)\n→ edit_file {}\n  ✗ edit_file (2ms)\n[done/done] 3 steps · tokens 1/1 · unmetered\n';
    const m = parseMetrics(log);
    expect(m.toolCalls).toBe(3);
    expect(m.toolErrors).toBe(1);
  });
  test('no done-line → all defaults', () => {
    expect(parseMetrics('no summary here\n')).toEqual({
      reason: '',
      steps: 0,
      inputTok: 0,
      outputTok: 0,
      cacheRead: 0,
      cacheCreation: 0,
      unmetered: false,
      costUsd: 0,
      toolCalls: 0,
      toolErrors: 0,
    });
  });
  test('reads the cache segment (read/creation) when present', () => {
    const m = parseMetrics(
      '[done/done] 19 steps · 173660ms · tokens 387616/8398 · cache 350000/12000 · $0.1234\n',
    );
    expect(m).toMatchObject({ inputTok: 387616, outputTok: 8398 });
    expect(m.cacheRead).toBe(350000);
    expect(m.cacheCreation).toBe(12000);
    expect(m.costUsd).toBe(0.1234);
  });
  test('an OLD done-line without a cache segment defaults cache to 0', () => {
    const m = parseMetrics('[done/done] 12 steps · 1109ms · tokens 7141/431 · unmetered\n');
    // tokens/steps/cost still parse; the absent cache segment is not mistaken
    // for the token figures.
    expect(m).toMatchObject({ steps: 12, inputTok: 7141, outputTok: 431, unmetered: true });
    expect(m.cacheRead).toBe(0);
    expect(m.cacheCreation).toBe(0);
  });
});

describe('loadCatalogEntries', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  test('parses a catalog file into its models array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swe-cat-'));
    temps.push(dir);
    const p = join(dir, 'model_providers.json');
    writeFileSync(p, JSON.stringify({ models: [{ id: 'a/b', api_key_env: 'K' }] }));
    expect(loadCatalogEntries(p)).toEqual([{ id: 'a/b', api_key_env: 'K' }]);
  });
  test('a missing/malformed file → [] (the caller throws a clearer per-model error)', () => {
    expect(loadCatalogEntries('/no/such/catalog.json')).toEqual([]);
  });
});

describe('parseNumstat', () => {
  test('sums added + deleted across a file', () => {
    expect(parseNumstat('23\t1\tsrc/skills/lifecycle.ts\n')).toEqual({ files: 1, lines: 24 });
  });
  test('counts multiple files', () => {
    expect(parseNumstat('5\t0\ta.ts\n2\t3\tb.ts\n')).toEqual({ files: 2, lines: 10 });
  });
  test('a binary file counts as a changed file but 0 lines', () => {
    expect(parseNumstat('-\t-\tx.bin\n')).toEqual({ files: 1, lines: 0 });
  });
  test('blank / non-numstat lines are skipped', () => {
    expect(parseNumstat('\nwarning: foo\n4\t1\tc.ts\n')).toEqual({ files: 1, lines: 5 });
  });
  test('empty input maps to zero', () => {
    expect(parseNumstat('')).toEqual({ files: 0, lines: 0 });
  });
});
