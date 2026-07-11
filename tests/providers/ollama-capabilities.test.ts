import { describe, expect, test } from 'bun:test';
import { OLLAMA_CAPS, OLLAMA_MODEL_NAMES } from '../../src/providers/ollama/capabilities.ts';

describe('OLLAMA_CAPS catalog', () => {
  test('exposes the curated set and OLLAMA_MODEL_NAMES matches the keys', () => {
    // gpt-oss:20b moved to the Ollama Cloud tier (OLLAMA_CLOUD_CAPS), leaving 6 local entries.
    expect(OLLAMA_MODEL_NAMES).toHaveLength(6);
    expect([...OLLAMA_MODEL_NAMES].sort()).toEqual(Object.keys(OLLAMA_CAPS).sort());
  });

  test('every entry is local-honest and well-formed', () => {
    for (const c of Object.values(OLLAMA_CAPS)) {
      expect(c.tools).toBe('native');
      expect(c.cache).toBe(false);
      expect(c.vision).toBe(false);
      expect(c.streaming).toBe(true);
      expect(c.constrained).toBe('json_mode');
      expect(c.cost_per_1k_input).toBe(0);
      expect(c.cost_per_1k_output).toBe(0);
      // No dialect — /api/chat applies the model's own template.
      expect(c.prompt_template_dialect).toBeUndefined();
      expect(c.context_window).toBeGreaterThan(0);
      expect(c.output_max_tokens).toBeGreaterThan(0);
      expect(c.notes.length).toBeGreaterThan(0);
    }
  });

  test('only thinking-capable families advertise reasoning effort', () => {
    for (const [name, c] of Object.entries(OLLAMA_CAPS)) {
      const isThinking = name.startsWith('qwen3:') || name.startsWith('gpt-oss');
      expect(c.supports_reasoning_effort ?? false).toBe(isThinking);
    }
  });
});
