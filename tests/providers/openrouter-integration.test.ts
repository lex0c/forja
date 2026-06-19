import { describe, expect, test } from 'bun:test';
import { createOpenRouterProvider } from '../../src/providers/openrouter/index.ts';
import type { GenerateRequest, ProviderMessage, StreamEvent } from '../../src/providers/types.ts';

// Opt-in integration smoke against the REAL OpenRouter API — the end-to-end
// check the mocked unit tests can't give: real SSE shape, tool-call round-trip,
// usage accounting, reasoning. Hermetic CI skips it (the env var / key are
// unset). Run locally with credits on the key:
//
//   FORJA_OPENROUTER_INTEGRATION=1 OPENROUTER_API_KEY=sk-or-... \
//     bun test tests/providers/openrouter-integration.test.ts
//
// Override the model with FORJA_OPENROUTER_INTEGRATION_MODEL (default
// deepseek/deepseek-v3.2 — cheap, native tools, reasoning-capable).
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.FORJA_OPENROUTER_INTEGRATION_MODEL ?? 'deepseek/deepseek-v3.2';
// Both the opt-in flag AND a key are required — skip (not fail) when either is
// absent, so a flag set without a key doesn't throw at factory time.
const RUN = process.env.FORJA_OPENROUTER_INTEGRATION === '1' && KEY !== undefined && KEY.length > 0;

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

suite('openrouter integration (real API)', () => {
  // RUN guarantees KEY is a non-empty string; cast past the optional type.
  const provider = () => createOpenRouterProvider(MODEL, { apiKey: KEY as string });

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

  test('tool-call cycle: model requests a tool, then completes after the result', async () => {
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
    const ev1 = await collect(
      p.generate(
        req({
          tools,
          messages: [{ role: 'user', content: 'What time is it in Paris? Use the get_time tool.' }],
        }),
      ),
    );
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
    const ev2 = await collect(p.generate(req({ tools, messages })));
    expect(ev2.some((e) => e.kind === 'text_delta')).toBe(true);
    expect(ev2.at(-1)?.kind).toBe('stop');
  });

  test('generateConstrained returns schema-shaped JSON', async () => {
    const out = await provider().generateConstrained({
      model: MODEL,
      messages: [{ role: 'user', content: 'Pick a color.' }],
      max_tokens: 128,
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

  test('reasoning-capable model emits a reasoning trace under effort', async () => {
    const ev = await collect(
      provider().generate(
        req({
          effort: 'low',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'Is 9.11 bigger than 9.9? Think, then answer.' }],
        }),
      ),
    );
    // Reasoning is best-effort per model/provider; assert the turn completes and,
    // when the trace is present, that both surfaces (live + replay block) appear.
    expect(ev.at(-1)?.kind).toBe('stop');
    const hasThinking = ev.some((e) => e.kind === 'thinking_delta');
    if (hasThinking) {
      expect(ev.some((e) => e.kind === 'reasoning')).toBe(true);
    }
  });
});
