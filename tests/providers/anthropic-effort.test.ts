import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  anthropicThinkingParam,
  createAnthropicProvider,
} from '../../src/providers/anthropic/index.ts';
import type { RawAnthropicEvent } from '../../src/providers/anthropic/stream.ts';
import type { GenerateRequest, ProviderCapabilities } from '../../src/providers/types.ts';

const adaptiveCaps = { supports_adaptive_thinking: true } as unknown as ProviderCapabilities;
const legacyCaps = {} as unknown as ProviderCapabilities;

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 4096,
  ...over,
});

describe('anthropicThinkingParam', () => {
  test('adaptive model: a legacy budget>0 engages adaptive and DROPS budget_tokens', () => {
    expect(anthropicThinkingParam(req({ thinking_budget: 5000 }), adaptiveCaps)).toEqual({
      thinking: { type: 'adaptive' },
    });
  });

  test('adaptive model: effort alone does NOT engage thinking (only an explicit budget does)', () => {
    // Effort must not turn thinking on by itself — with the default
    // effort='high' that would force extended thinking onto every run
    // and 400 on Sonnet 4.6 when combined with a temperature/top_p
    // override. effort still rides output_config.effort separately.
    expect(anthropicThinkingParam(req({ effort: 'high' }), adaptiveCaps)).toEqual({});
  });

  test('adaptive model: neither budget nor effort → no thinking block', () => {
    expect(anthropicThinkingParam(req(), adaptiveCaps)).toEqual({});
  });

  test('legacy model: budget>0 → enabled + budget_tokens', () => {
    expect(anthropicThinkingParam(req({ thinking_budget: 3000 }), legacyCaps)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 3000 },
    });
  });

  test('legacy model: budget 0 → no thinking block (disable-via-zero)', () => {
    expect(anthropicThinkingParam(req({ thinking_budget: 0 }), legacyCaps)).toEqual({});
  });

  test('legacy model: effort alone does NOT force thinking (output_config carries effort)', () => {
    expect(anthropicThinkingParam(req({ effort: 'max' }), legacyCaps)).toEqual({});
  });

  test('explicit thinking_budget 0 disables thinking even when effort is set (adaptive)', () => {
    // disable-via-zero is an explicit "no thinking"; effort must not
    // resurrect it.
    expect(
      anthropicThinkingParam(req({ thinking_budget: 0, effort: 'high' }), adaptiveCaps),
    ).toEqual({});
  });
});

// Integration: capture the params the adapter hands to the SDK.
const fakeClient = (capture: { params?: Record<string, unknown> }): Anthropic =>
  ({
    messages: {
      stream: (params: Record<string, unknown>) => {
        capture.params = params;
        return (async function* (): AsyncGenerator<RawAnthropicEvent> {
          yield { type: 'message_start', message: { id: 'm1' } };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          };
          yield { type: 'message_stop' };
        })();
      },
    },
  }) as unknown as Anthropic;

const drain = async (
  provider: ReturnType<typeof createAnthropicProvider>,
  r: GenerateRequest,
): Promise<void> => {
  for await (const _ of provider.generate(r)) {
    // discard events; we only care about the captured request
  }
};

describe('anthropic adapter request assembly (effort + adaptive migration)', () => {
  test('opus-4-7 (adaptive): effort → output_config.effort + thinking adaptive, no budget_tokens', async () => {
    const cap: { params?: Record<string, unknown> } = {};
    const provider = createAnthropicProvider('claude-opus-4-7', { client: fakeClient(cap) });
    await drain(
      provider,
      req({ model: 'claude-opus-4-7', effort: 'high', thinking_budget: 5000, max_tokens: 8000 }),
    );
    expect(cap.params?.output_config).toEqual({ effort: 'high' });
    expect(cap.params?.thinking).toEqual({ type: 'adaptive' });
  });

  test('haiku-4-5 (legacy, no reasoning-effort cap): enabled+budget_tokens, output_config NOT emitted', async () => {
    const cap: { params?: Record<string, unknown> } = {};
    const provider = createAnthropicProvider('claude-haiku-4-5', { client: fakeClient(cap) });
    await drain(
      provider,
      req({ model: 'claude-haiku-4-5', effort: 'low', thinking_budget: 2000, max_tokens: 8000 }),
    );
    expect(cap.params?.thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
    // haiku-4-5 has no supports_reasoning_effort → effort dropped (no 400 risk).
    expect(cap.params?.output_config).toBeUndefined();
  });

  test('no effort, no budget → neither field present', async () => {
    const cap: { params?: Record<string, unknown> } = {};
    const provider = createAnthropicProvider('claude-opus-4-7', { client: fakeClient(cap) });
    await drain(provider, req({ model: 'claude-opus-4-7', max_tokens: 8000 }));
    expect(cap.params?.output_config).toBeUndefined();
    expect(cap.params?.thinking).toBeUndefined();
  });

  test('sonnet-4-6: default effort + temperature does NOT engage thinking (sampling+thinking 400 guard)', async () => {
    // Regression: bootstrap defaults effort='high'; Sonnet 4.6 is
    // adaptive AND accepts sampling, so engaging thinking from effort
    // would emit `thinking` alongside `temperature` → HTTP 400. effort
    // must ride only output_config here, leaving thinking off so a
    // deterministic (temperature:0) run stays valid.
    const cap: { params?: Record<string, unknown> } = {};
    const provider = createAnthropicProvider('claude-sonnet-4-6', { client: fakeClient(cap) });
    await drain(
      provider,
      req({ model: 'claude-sonnet-4-6', effort: 'high', temperature: 0, max_tokens: 8000 }),
    );
    expect(cap.params?.thinking).toBeUndefined(); // no thinking from effort alone
    expect(cap.params?.output_config).toEqual({ effort: 'high' }); // effort still applied
    expect(cap.params?.temperature).toBe(0); // sampling preserved → no conflict
  });
});
