import { describe, expect, test } from 'bun:test';
import { deriveSeedFromRequest } from '../../src/providers/seed.ts';
import type { GenerateRequest } from '../../src/providers/types.ts';

const baseReq = (overrides: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: 'mock/m',
  messages: [{ role: 'user', content: 'q' }],
  max_tokens: 4,
  ...overrides,
});

describe('deriveSeedFromRequest', () => {
  test('produces an int32-range value (negative or positive)', () => {
    // The shared helper feeds OpenAI (any number) AND Google
    // (int32 — max 2^31 - 1). Pin the strictest range so a
    // future helper change that drifts back to uint32 is caught
    // before the SDK silently rejects the seed on Gemini.
    const seed = deriveSeedFromRequest(baseReq());
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(-2_147_483_648);
    expect(seed).toBeLessThanOrEqual(2_147_483_647);
  });

  test('same conversation surface yields the same seed (replay determinism)', () => {
    expect(deriveSeedFromRequest(baseReq())).toBe(deriveSeedFromRequest(baseReq()));
  });

  test('different system prompt changes the seed', () => {
    const a = deriveSeedFromRequest(baseReq({ system: 'be brief' }));
    const b = deriveSeedFromRequest(baseReq({ system: 'be verbose' }));
    expect(a).not.toBe(b);
  });

  test('different message content changes the seed', () => {
    const a = deriveSeedFromRequest(baseReq({ messages: [{ role: 'user', content: 'one' }] }));
    const b = deriveSeedFromRequest(baseReq({ messages: [{ role: 'user', content: 'two' }] }));
    expect(a).not.toBe(b);
  });

  test('appending a message (step boundary) changes the seed', () => {
    // Within a multi-step run, each step's request includes a
    // longer message history. The seed must vary so seeded
    // generation does not collapse to repetitive output.
    const step1 = deriveSeedFromRequest(
      baseReq({
        messages: [{ role: 'user', content: 'q' }],
      }),
    );
    const step2 = deriveSeedFromRequest(
      baseReq({
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'follow-up' },
        ],
      }),
    );
    expect(step2).not.toBe(step1);
  });

  test('changes in non-conversation fields do NOT affect the seed', () => {
    // Sampling knobs (temperature, top_p), token caps, and
    // tools are NOT part of the conversation surface — varying
    // them while keeping system+messages fixed should not
    // change the seed. (Eval rigs that pin temperature: 0 want
    // the same trajectory regardless of stop_sequences fiddling.)
    const a = deriveSeedFromRequest(baseReq({ system: 'fixed', temperature: 0, max_tokens: 4 }));
    const b = deriveSeedFromRequest(
      baseReq({ system: 'fixed', temperature: 0.7, max_tokens: 100 }),
    );
    expect(a).toBe(b);
  });
});
