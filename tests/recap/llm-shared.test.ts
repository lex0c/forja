import { describe, expect, test } from 'bun:test';
import type {
  ConstrainedResult,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  UsageInfo,
} from '../../src/providers/types.ts';
import { renderViaLlm } from '../../src/recap/llm-shared.ts';

// Minimal mock provider — returns a fixed JSON payload so the
// orchestrator's parse / validate / fidelity / template path runs
// to the concision check without renderer-specific scaffolding.
const makeMockProvider = (
  output: string,
  options: { usage?: UsageInfo; caps?: ProviderCapabilities } = {},
): Provider => {
  const caps: ProviderCapabilities = options.caps ?? {
    tools: 'native',
    cache: 'server_5min',
    vision: false,
    streaming: true,
    constrained: 'tools',
    context_window: 200_000,
    output_max_tokens: 4_096,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [],
  };
  const usage: UsageInfo = options.usage ?? {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
  };
  return {
    id: 'mock/m',
    family: 'anthropic',
    capabilities: caps,
    generate: async function* (): AsyncIterable<StreamEvent> {},
    generateConstrained: async (): Promise<ConstrainedResult> => ({ output, usage }),
    countTokens: async () => 0,
  };
};

const billedCaps = (): ProviderCapabilities => ({
  tools: 'native',
  cache: 'server_5min',
  vision: false,
  streaming: true,
  constrained: 'tools',
  context_window: 200_000,
  output_max_tokens: 4_096,
  cost_per_1k_input: 1.0,
  cost_per_1k_output: 5.0,
  notes: [],
});

const billedUsage = (): UsageInfo => ({
  input: 1_000,
  output: 200,
  cache_read: 0,
  cache_creation: 0,
});

interface Stub {
  schemaVersion: 'stub-v1';
}

const STUB_VALUE: Stub = { schemaVersion: 'stub-v1' };
const STUB_JSON_SCHEMA = {
  type: 'object',
  properties: { schemaVersion: { type: 'string', const: 'stub-v1' } },
  required: ['schemaVersion'],
} as const;
const VALIDATE_OK = (): { ok: boolean; errors: string[] } => ({ ok: true, errors: [] });
const FIDELITY_OK = (): { ok: boolean; errors: string[] } => ({ ok: true, errors: [] });

describe('renderViaLlm — concision line-count check', () => {
  test('output at exactly the cap (with trailing newline) is OK', async () => {
    // Regression: pre-fix `split('\n').length` overcounted by 1
    // whenever the template emitted its standard trailing newline,
    // so an output that exactly met the cap was misclassified as
    // a concision violation. Templates canonically end with `\n`
    // (file pipes need it); the helper must not penalize that.
    const result = await renderViaLlm<Stub>({
      provider: makeMockProvider(JSON.stringify(STUB_VALUE)),
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      // Three real lines + trailing newline = canonical template
      // shape. Cap matches exactly. Pre-fix lineCount=4, violation.
      // Post-fix lineCount=3, ok.
      template: () => 'one\ntwo\nthree\n',
      maxOutputLines: 3,
    });
    expect(result.ok).toBe(true);
  });

  test('output exceeding the cap is still rejected', async () => {
    // Sanity: the fix must not regress real overflow. 4 real lines
    // with a cap of 3 stays a violation regardless of trailing
    // newline handling.
    const result = await renderViaLlm<Stub>({
      provider: makeMockProvider(JSON.stringify(STUB_VALUE)),
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      template: () => 'one\ntwo\nthree\nfour\n',
      maxOutputLines: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('concision-violation');
    expect(result.detail).toContain('4 lines');
    expect(result.detail).toContain('limit 3');
  });

  test('internal blank lines DO count toward the cap', async () => {
    // A blank line in the middle of the output consumes a row
    // visually (in the operator's terminal / file). The fix only
    // strips the SINGLE trailing newline; internal `\n\n` stays
    // counted as a blank line. Cap = 2, body = "one\n\ntwo\n"
    // (real lines: "one", "", "two" → 3) → violation.
    const result = await renderViaLlm<Stub>({
      provider: makeMockProvider(JSON.stringify(STUB_VALUE)),
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      template: () => 'one\n\ntwo\n',
      maxOutputLines: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('concision-violation');
    expect(result.detail).toContain('3 lines');
  });

  test('output without trailing newline is counted directly', async () => {
    // Defensive: if a future template ever omits the trailing
    // newline (unusual but allowed), the count must still match
    // the real line count without an off-by-one in the OTHER
    // direction (under-counting).
    const result = await renderViaLlm<Stub>({
      provider: makeMockProvider(JSON.stringify(STUB_VALUE)),
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      template: () => 'one\ntwo',
      maxOutputLines: 2,
    });
    expect(result.ok).toBe(true);
  });
});

describe('renderViaLlm — usage propagation on post-call failure', () => {
  // Regression: pre-fix the orchestrator dropped `usage` on every
  // post-call check failure (parse / schema / fidelity /
  // concision), so callers fell back to deterministic and the
  // audit row recorded zero cost — silent under-reporting on
  // every malformed-but-billed response. Pin the four reasons
  // here so any future refactor that drops `usage` from one of
  // the failure variants surfaces immediately.
  test('invalid-json carries usage and costUsd', async () => {
    const provider = makeMockProvider('not-json-at-all', {
      usage: billedUsage(),
      caps: billedCaps(),
    });
    const result = await renderViaLlm<Stub>({
      provider,
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      template: () => 'x',
      maxOutputLines: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid-json');
    expect(result.usage).toEqual(billedUsage());
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('schema-violation carries usage and costUsd', async () => {
    const provider = makeMockProvider(JSON.stringify(STUB_VALUE), {
      usage: billedUsage(),
      caps: billedCaps(),
    });
    const result = await renderViaLlm<Stub>({
      provider,
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: () => ({ ok: false, errors: ['nope'] }),
      fidelityCheck: FIDELITY_OK,
      template: () => 'x',
      maxOutputLines: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('schema-violation');
    expect(result.usage).toEqual(billedUsage());
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('fidelity-mismatch carries usage and costUsd', async () => {
    const provider = makeMockProvider(JSON.stringify(STUB_VALUE), {
      usage: billedUsage(),
      caps: billedCaps(),
    });
    const result = await renderViaLlm<Stub>({
      provider,
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: () => ({ ok: false, errors: ['hallucinated'] }),
      template: () => 'x',
      maxOutputLines: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('fidelity-mismatch');
    expect(result.usage).toEqual(billedUsage());
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('concision-violation carries usage and costUsd', async () => {
    const provider = makeMockProvider(JSON.stringify(STUB_VALUE), {
      usage: billedUsage(),
      caps: billedCaps(),
    });
    const result = await renderViaLlm<Stub>({
      provider,
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      template: () => 'one\ntwo\nthree\n',
      maxOutputLines: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('concision-violation');
    expect(result.usage).toEqual(billedUsage());
    expect(result.costUsd).toBeGreaterThan(0);
  });

  test('capability-missing has NO usage (pre-call failure, no bill)', async () => {
    const provider = makeMockProvider(JSON.stringify(STUB_VALUE), {
      caps: { ...billedCaps(), constrained: false },
    });
    const result = await renderViaLlm<Stub>({
      provider,
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      template: () => 'x',
      maxOutputLines: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('capability-missing');
    expect(result.usage).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });

  test('provider-error has NO usage (pre-call failure, request never landed)', async () => {
    const provider: Provider = {
      ...makeMockProvider(JSON.stringify(STUB_VALUE)),
      generateConstrained: () => Promise.reject(new Error('rate limited')),
    };
    const result = await renderViaLlm<Stub>({
      provider,
      prompt: { system: '', user: '' },
      schemaName: 'stub_render',
      jsonSchema: STUB_JSON_SCHEMA,
      validate: VALIDATE_OK,
      fidelityCheck: FIDELITY_OK,
      template: () => 'x',
      maxOutputLines: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider-error');
    expect(result.usage).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
  });
});
