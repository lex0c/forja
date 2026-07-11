import { describe, expect, test } from 'bun:test';
import { createOllamaProvider } from '../../src/providers/ollama/index.ts';
import { probeOllama } from '../../src/providers/ollama/probe.ts';
import type { GenerateRequest, StreamEvent } from '../../src/providers/types.ts';

// Opt-in integration smoke against a REAL Ollama daemon. Hermetic CI skips it
// (the env var is unset). Run locally with a recent Ollama + a pulled catalog
// model:
//
//   FORJA_OLLAMA_INTEGRATION=1 bun test tests/providers/ollama-integration.test.ts
//
// Override the model with FORJA_OLLAMA_INTEGRATION_MODEL (default
// qwen2.5-coder:14b) and the host with FORJA_OLLAMA_BASE_URL.
const RUN = process.env.FORJA_OLLAMA_INTEGRATION === '1';
const MODEL = process.env.FORJA_OLLAMA_INTEGRATION_MODEL ?? 'qwen2.5-coder:14b';
const BASE = process.env.FORJA_OLLAMA_BASE_URL ?? 'http://localhost:11434';

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
  max_tokens: 64,
  ...over,
});

// `describe.skip` (not skipIf) for a value the type defs guarantee exists.
const suite = RUN ? describe : describe.skip;

suite('ollama integration (real daemon)', () => {
  test('daemon is reachable and the target model is pulled', async () => {
    const probe = await probeOllama(BASE);
    expect(probe.reachable).toBe(true);
    expect(probe.models ?? []).toContain(MODEL);
  });

  test('generate streams text and closes with a stop event', async () => {
    const provider = createOllamaProvider(MODEL, { baseUrl: BASE });
    const ev = await collect(
      provider.generate(req({ messages: [{ role: 'user', content: 'Reply with exactly: hi' }] })),
    );
    expect(ev[0]?.kind).toBe('start');
    expect(ev.some((e) => e.kind === 'text_delta')).toBe(true);
    expect(ev.at(-1)?.kind).toBe('stop');
  });

  test('generateConstrained returns schema-shaped JSON', async () => {
    const provider = createOllamaProvider(MODEL, { baseUrl: BASE });
    const out = await provider.generateConstrained({
      model: MODEL,
      messages: [{ role: 'user', content: 'Pick a color.' }],
      max_tokens: 64,
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
});
