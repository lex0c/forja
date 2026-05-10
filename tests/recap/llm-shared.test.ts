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
const makeMockProvider = (output: string): Provider => {
  const caps: ProviderCapabilities = {
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
  const usage: UsageInfo = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  return {
    id: 'mock/m',
    family: 'anthropic',
    capabilities: caps,
    generate: async function* (): AsyncIterable<StreamEvent> {},
    generateConstrained: async (): Promise<ConstrainedResult> => ({ output, usage }),
    countTokens: async () => 0,
  };
};

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
