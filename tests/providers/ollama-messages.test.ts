import { describe, expect, test } from 'bun:test';
import { OLLAMA_CAPS } from '../../src/providers/ollama/capabilities.ts';
import {
  DEFAULT_OLLAMA_NUM_CTX,
  effortToThink,
  ollamaOptions,
  toOllamaMessages,
  toOllamaTools,
} from '../../src/providers/ollama/messages.ts';
import { deriveSeedFromRequest } from '../../src/providers/seed.ts';
import type { GenerateRequest, ProviderToolDef } from '../../src/providers/types.ts';

const caps = (name: string) => {
  const c = OLLAMA_CAPS[name];
  if (c === undefined) {
    throw new Error(`missing caps for ${name}`);
  }
  return c;
};
const CODER = caps('qwen2.5-coder:14b'); // no thinking, 32K window
const THINKER = caps('qwen3:8b'); // thinking
const BIG = caps('mistral-nemo:12b'); // 128K window

const req = (over: Partial<GenerateRequest>): GenerateRequest => ({
  model: 'qwen2.5-coder:14b',
  messages: [],
  max_tokens: 1024,
  ...over,
});

describe('toOllamaMessages', () => {
  test('emits system from req.system first', () => {
    const out = toOllamaMessages(
      req({ system: 'be terse', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(out[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('flattens systemSegments when present', () => {
    const out = toOllamaMessages(
      req({
        system: 'a\n\nb',
        systemSegments: [
          { id: 'stable', text: 'a' },
          { id: 'memory', text: 'b' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(out[0]).toEqual({ role: 'system', content: 'a\n\nb' });
  });

  test('no system message when system is absent', () => {
    const out = toOllamaMessages(req({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  test('assistant text + tool_use → content + tool_calls with object args', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'let me read it' },
              { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } },
            ],
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'let me read it',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }],
    });
  });

  test('tool_result uses block.name as tool_name', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'x', name: 'grep', content: 'm' }],
          },
        ],
      }),
    );
    expect(out[0]).toEqual({ role: 'tool', content: 'm', tool_name: 'grep' });
  });

  test('tool_result without a name → tool_name omitted (Ollama correlates positionally)', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'body' }],
          },
        ],
      }),
    );
    expect(out[0]).toEqual({ role: 'tool', content: 'body' });
  });

  test('failed tool_result is flagged inline (Ollama has no is_error field)', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'x',
                name: 'read_file',
                content: 'ENOENT',
                is_error: true,
              },
            ],
          },
        ],
      }),
    );
    expect(out[0]).toEqual({
      role: 'tool',
      content: '[tool error] ENOENT',
      tool_name: 'read_file',
    });
  });

  test('multiple tool_results in one message → multiple role:tool messages', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'a', name: 'one', content: '1' },
              { type: 'tool_result', tool_use_id: 'b', name: 'two', content: '2' },
            ],
          },
        ],
      }),
    );
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.tool_name)).toEqual(['one', 'two']);
  });

  test('reasoning blocks are dropped', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', provider: 'ollama', data: { x: 1 } },
              { type: 'text', text: 'done' },
            ],
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: 'assistant', content: 'done' });
  });

  test('reasoning block → message.thinking when replay is on', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', provider: 'ollama', data: { thinking: 'let me think' } },
              { type: 'text', text: 'answer' },
              { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
            ],
          },
        ],
      }),
      true,
    );
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'answer',
      thinking: 'let me think',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }],
    });
  });

  test('reasoning block dropped when replay is off (default)', () => {
    const out = toOllamaMessages(
      req({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', provider: 'ollama', data: { thinking: 'x' } },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
    );
    expect(out[0]).toEqual({ role: 'assistant', content: 'answer' });
  });
});

describe('toOllamaTools', () => {
  test('maps ProviderToolDef → OpenAI-style function tool', () => {
    const tools: ProviderToolDef[] = [
      {
        name: 'read_file',
        description: 'read',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
    expect(toOllamaTools(tools)).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'read',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
  });

  test('undefined when there are no tools', () => {
    expect(toOllamaTools(undefined)).toBeUndefined();
    expect(toOllamaTools([])).toBeUndefined();
  });
});

describe('effortToThink', () => {
  test('thinking model + requested effort → true', () => {
    expect(effortToThink(req({ effort: 'high' }), THINKER)).toBe(true);
  });
  test('thinking model + no effort → undefined (model default)', () => {
    expect(effortToThink(req({}), THINKER)).toBeUndefined();
  });
  test('non-thinking model → undefined even with effort', () => {
    expect(effortToThink(req({ effort: 'high' }), CODER)).toBeUndefined();
  });
  test('thinking_budget 0 disables think even with effort set', () => {
    expect(effortToThink(req({ effort: 'high', thinking_budget: 0 }), THINKER)).toBe(false);
  });
  test('positive thinking_budget enables think without effort', () => {
    expect(effortToThink(req({ thinking_budget: 512 }), THINKER)).toBe(true);
  });
});

describe('ollamaOptions', () => {
  test('sets num_ctx to the model window (within the cap) and num_predict to max_tokens', () => {
    const o = ollamaOptions(req({ max_tokens: 2048 }), CODER);
    expect(o.num_ctx).toBe(CODER.context_window);
    expect(o.num_predict).toBe(2048);
  });
  test('caps num_ctx at DEFAULT_OLLAMA_NUM_CTX for large-window models', () => {
    expect(BIG.context_window).toBeGreaterThan(DEFAULT_OLLAMA_NUM_CTX);
    const o = ollamaOptions(req({}), BIG);
    expect(o.num_ctx).toBe(DEFAULT_OLLAMA_NUM_CTX);
  });
  test('numCtx override wins over both the window and the cap', () => {
    const o = ollamaOptions(req({}), BIG, 200_000);
    expect(o.num_ctx).toBe(200_000);
  });
  test('maps temperature, top_p, stop, and the request-derived eval seed', () => {
    const r = req({ temperature: 0.2, top_p: 0.9, stop_sequences: ['</end>'], seed_in_eval: true });
    const o = ollamaOptions(r, CODER);
    expect(o.temperature).toBe(0.2);
    expect(o.top_p).toBe(0.9);
    expect(o.stop).toEqual(['</end>']);
    expect(o.seed).toBe(deriveSeedFromRequest(r));
  });
  test('omits optional sampling fields when unset', () => {
    const o = ollamaOptions(req({}), CODER);
    expect('temperature' in o).toBe(false);
    expect('top_p' in o).toBe(false);
    expect('stop' in o).toBe(false);
    expect('seed' in o).toBe(false);
  });
});
