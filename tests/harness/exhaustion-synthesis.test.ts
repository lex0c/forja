import { describe, expect, test } from 'bun:test';
import {
  buildSynthesisMessages,
  buildSynthesisRequest,
  EXHAUSTION_DIRECTIVE,
  endsWithSettledAnswer,
} from '../../src/harness/exhaustion-synthesis.ts';
import type { HarnessConfig, RunBudget } from '../../src/harness/types.ts';
import type { ProviderMessage } from '../../src/providers/index.ts';

// The pure decision/shape helpers of the exhaustion synthesis — where the
// trickiest edge cases hide (the settled-answer gate and the directive append
// were both real bugs). The orchestration is covered by loop.test.ts integration
// tests; these enumerate message shapes exhaustively without spinning up runAgent.

describe('endsWithSettledAnswer', () => {
  test('false on an empty history (nothing to settle)', () => {
    expect(endsWithSettledAnswer([])).toBe(false);
  });

  test('false when the LAST message is a user turn (trailing tool_results ⇒ unconsumed)', () => {
    expect(endsWithSettledAnswer([{ role: 'user', content: 'q' }])).toBe(false);
    expect(
      endsWithSettledAnswer([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
      ]),
    ).toBe(false);
  });

  test('true when the last assistant carries non-empty text (string or block)', () => {
    expect(endsWithSettledAnswer([{ role: 'assistant', content: 'done' }])).toBe(true);
    expect(
      endsWithSettledAnswer([{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }]),
    ).toBe(true);
  });

  test('true for a text-PLUS-tool_use assistant as the last message (has text)', () => {
    // This is settled ONLY because no tool_results trail it; the preamble bug is
    // the OTHER shape (tested above) where tool_results are appended after it.
    expect(
      endsWithSettledAnswer([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'here it is' },
            { type: 'tool_use', id: 't', name: 'x', input: {} },
          ],
        },
      ]),
    ).toBe(true);
  });

  test('false when the last assistant has only whitespace / no text block', () => {
    expect(endsWithSettledAnswer([{ role: 'assistant', content: '   ' }])).toBe(false);
    expect(
      endsWithSettledAnswer([{ role: 'assistant', content: [{ type: 'text', text: '  ' }] }]),
    ).toBe(false);
    expect(
      endsWithSettledAnswer([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      ]),
    ).toBe(false);
  });

  test('false when the last assistant is reasoning-only (no text answer)', () => {
    expect(
      endsWithSettledAnswer([
        { role: 'assistant', content: [{ type: 'reasoning', provider: 'anthropic', data: {} }] },
      ]),
    ).toBe(false);
  });
});

describe('buildSynthesisMessages', () => {
  test('merges the directive into a trailing user STRING (no double-user turn)', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'q' }];
    const out = buildSynthesisMessages(messages, 'DIR');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: 'user', content: 'q\n\nDIR' });
  });

  test('appends a text block to a trailing user ARRAY', () => {
    const lastContent = [{ type: 'tool_result' as const, tool_use_id: 't', content: 'r' }];
    const messages: ProviderMessage[] = [{ role: 'user', content: lastContent }];
    const out = buildSynthesisMessages(messages, 'DIR');
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't', content: 'r' },
      { type: 'text', text: 'DIR' },
    ]);
  });

  test('pushes a fresh user turn when the last message is an assistant', () => {
    const messages: ProviderMessage[] = [{ role: 'assistant', content: 'partial' }];
    const out = buildSynthesisMessages(messages, 'DIR');
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'user', content: 'DIR' });
  });

  test('pushes a single user turn for an empty history', () => {
    const out = buildSynthesisMessages([], 'DIR');
    expect(out).toEqual([{ role: 'user', content: 'DIR' }]);
  });

  test('does NOT mutate the input (ephemeral directive)', () => {
    const lastContent = [{ type: 'text' as const, text: 'q' }];
    const messages: ProviderMessage[] = [{ role: 'user', content: lastContent }];
    buildSynthesisMessages(messages, 'DIR');
    expect(messages).toHaveLength(1);
    expect(lastContent).toHaveLength(1); // original block array untouched
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'q' }] });
  });
});

describe('buildSynthesisRequest', () => {
  const makeConfig = (over: Partial<HarnessConfig> = {}): HarnessConfig =>
    ({
      provider: { id: 'test/model', capabilities: { output_max_tokens: 4096 } },
      ...over,
    }) as unknown as HarnessConfig;
  const budget = {} as RunBudget; // maxOutputTokensPerCall undefined ⇒ cap

  test('NEVER carries tools — the load-bearing difference', () => {
    const req = buildSynthesisRequest(
      makeConfig(),
      budget,
      [{ role: 'user', content: 'q' }],
      undefined,
    );
    expect('tools' in req).toBe(false);
    expect(req.model).toBe('test/model');
    expect(req.max_tokens).toBe(4096);
  });

  test('omits the sampling/determinism axes the config does not set', () => {
    const req = buildSynthesisRequest(makeConfig(), budget, [], undefined);
    for (const k of [
      'temperature',
      'top_p',
      'thinking_budget',
      'effort',
      'seed_in_eval',
      'system',
    ]) {
      expect(k in req).toBe(false);
    }
  });

  test('mirrors the sampling/determinism axes the config DOES set', () => {
    const config = makeConfig({
      systemPrompt: 'sys',
      temperature: 0.5,
      topP: 0.9,
      thinkingBudget: 1000,
      seedInEval: true,
    });
    const req = buildSynthesisRequest(config, budget, [{ role: 'user', content: 'q' }], 'high');
    expect('tools' in req).toBe(false);
    expect(req.temperature).toBe(0.5);
    expect(req.top_p).toBe(0.9);
    expect(req.thinking_budget).toBe(1000);
    expect(req.seed_in_eval).toBe(true);
    expect(req.effort).toBe('high');
    expect(req.system).toBe('sys');
  });
});

describe('EXHAUSTION_DIRECTIVE', () => {
  test('forbids tools and demands a final answer with explicit gaps', () => {
    expect(EXHAUSTION_DIRECTIVE).toContain('may not call any more tools');
    expect(EXHAUSTION_DIRECTIVE).toContain('did not get to check');
  });
});
