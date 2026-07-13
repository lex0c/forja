import { describe, expect, test } from 'bun:test';
import type { GenerateRequest, ProviderMessage, StreamEvent } from '../../src/providers/types.ts';
import { createXaiProvider } from '../../src/providers/xai/index.ts';

// Opt-in integration smoke against the REAL xAI API (api.x.ai) — the end-to-end
// check the mocked unit tests can't give: real SSE shape, tool-call round-trip,
// usage accounting, and Grok's reasoning behavior. Hermetic CI skips it (the env
// var / key are unset). Run locally with a funded key:
//
//   FORJA_XAI_INTEGRATION=1 XAI_API_KEY=xai-... \
//     bun test tests/providers/xai-integration.test.ts
//
// Override the model with FORJA_XAI_INTEGRATION_MODEL (default grok-4.5). This
// suite is the standing gate for the two adapter assumptions a live run settled
// (2026-07-13): that xAI Chat Completions accepts tools+reasoning_effort
// together (unlike OpenAI's reasoning models, which need /v1/responses), and
// that grok-4.5 accepts temperature/top_p despite always reasoning.
const KEY = process.env.XAI_API_KEY;
const MODEL = process.env.FORJA_XAI_INTEGRATION_MODEL ?? 'grok-4.5';
// Both the opt-in flag AND a key are required — skip (not fail) when either is
// absent, so a flag set without a key doesn't throw at factory time.
const RUN = process.env.FORJA_XAI_INTEGRATION === '1' && KEY !== undefined && KEY.length > 0;

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) {
    out.push(e);
  }
  return out;
};

const req = (over: Partial<GenerateRequest>): GenerateRequest => ({
  model: MODEL,
  messages: [],
  max_tokens: 256,
  ...over,
});

// `describe.skip` (not skipIf) for a value the type defs guarantee exists.
const suite = RUN ? describe : describe.skip;

suite('xai integration (real API)', () => {
  // RUN guarantees KEY is a non-empty string; cast past the optional type.
  const provider = () => createXaiProvider(MODEL, { apiKey: KEY as string });

  test('generate streams text, usage, and a stop event', async () => {
    const ev = await collect(
      provider().generate(req({ messages: [{ role: 'user', content: 'Reply with exactly: hi' }] })),
    );
    expect(ev[0]?.kind).toBe('start');
    expect(ev.some((e) => e.kind === 'text_delta')).toBe(true);
    const usage = ev.find((e) => e.kind === 'usage');
    // Usage must arrive on the real wire (we rely on it for cost telemetry).
    expect(usage).toBeDefined();
    if (usage?.kind === 'usage') {
      expect(usage.usage.input).toBeGreaterThan(0);
      expect(usage.usage.output).toBeGreaterThan(0);
    }
    expect(ev.at(-1)?.kind).toBe('stop');
  });

  test('tool-call cycle WITH reasoning_effort:high (the tools+effort combo) round-trips', async () => {
    const p = provider();
    const tools = [
      {
        name: 'get_time',
        description: 'Get the current time in a given city.',
        input_schema: {
          type: 'object' as const,
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ];
    // effort:'high' + tools together is the assumption that motivated a separate
    // family (OpenAI reasoning models 400 on this combo in Chat Completions).
    const ev1 = await collect(
      p.generate(
        req({
          tools,
          effort: 'high',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'What time is it in Paris? Use the get_time tool.' }],
        }),
      ),
    );
    // No stream error (a rejected tools+effort combo would surface as a 4xx throw
    // or an error event, not a tool call).
    expect(ev1.some((e) => e.kind === 'error')).toBe(false);
    const start = ev1.find((e) => e.kind === 'tool_use_start');
    const stop = ev1.find((e) => e.kind === 'tool_use_stop');
    expect(start?.kind).toBe('tool_use_start');
    expect(stop?.kind).toBe('tool_use_stop');
    if (start?.kind !== 'tool_use_start' || stop?.kind !== 'tool_use_stop') return;
    expect(typeof start.name).toBe('string');

    // Round-trip the tool result and confirm the model produces a final answer.
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'What time is it in Paris? Use the get_time tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: start.id, name: start.name, input: stop.final_args }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: start.id, content: '14:30 CET' }],
      },
    ];
    const ev2 = await collect(
      p.generate(req({ tools, effort: 'high', max_tokens: 512, messages })),
    );
    expect(ev2.some((e) => e.kind === 'text_delta')).toBe(true);
    expect(ev2.at(-1)?.kind).toBe('stop');
  });

  test('accepts temperature/top_p on the always-reasoning model (no 400)', async () => {
    // grok-4.5 always reasons; the review left sampling ON (no supports_sampling:
    // false). A 400 would throw here; a clean completion confirms the decision.
    const ev = await collect(
      provider().generate(
        req({
          temperature: 0.2,
          top_p: 0.9,
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        }),
      ),
    );
    expect(ev.some((e) => e.kind === 'error')).toBe(false);
    expect(ev.at(-1)?.kind).toBe('stop');
  });

  test('generateConstrained returns schema-shaped JSON', async () => {
    const out = await provider().generateConstrained({
      model: MODEL,
      messages: [{ role: 'user', content: 'Pick a color.' }],
      max_tokens: 256,
      output_schema: {
        type: 'object',
        properties: { color: { type: 'string' } },
        required: ['color'],
      },
      output_schema_name: 'color_choice',
    });
    const parsed = JSON.parse(out.output) as { color?: unknown };
    expect(typeof parsed.color).toBe('string');
    expect(out.usage.output).toBeGreaterThanOrEqual(0);
  });

  test('reasoning_content surfaces as thinking_delta but never a reasoning replay block', async () => {
    const ev = await collect(
      provider().generate(
        req({
          effort: 'high',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'Is 9.11 bigger than 9.9? Think, then answer.' }],
        }),
      ),
    );
    expect(ev.at(-1)?.kind).toBe('stop');
    // Chat Completions has no reasoning-input slot, so the adapter emits thinking
    // for the UI but NEVER a `reasoning` block (replaysReasoning: false). This is
    // the deliberate divergence from the Anthropic/OpenRouter adapters.
    expect(ev.some((e) => e.kind === 'reasoning')).toBe(false);
  });
});
