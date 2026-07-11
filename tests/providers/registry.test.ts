import { describe, expect, test } from 'bun:test';
import { ANTHROPIC_MODEL_NAMES } from '../../src/providers/anthropic/capabilities.ts';
import { createDefaultRegistry } from '../../src/providers/catalog-file.ts';
import { GOOGLE_MODEL_NAMES } from '../../src/providers/google/capabilities.ts';
import {
  OLLAMA_CLOUD_MODEL_NAMES,
  OLLAMA_MODEL_NAMES,
} from '../../src/providers/ollama/capabilities.ts';
import { OPENAI_MODEL_NAMES } from '../../src/providers/openai/capabilities.ts';
import { OPENROUTER_MODEL_NAMES } from '../../src/providers/openrouter/capabilities.ts';
import { createRegistry, type ModelEntry } from '../../src/providers/registry.ts';

const dummyEntry = (id: string): ModelEntry => ({
  id,
  family: 'anthropic',
  modelName: id.replace(/^anthropic\//, ''),
  capabilities: {
    tools: 'native',
    cache: 'server_5min',
    vision: true,
    streaming: true,
    constrained: 'tools',
    context_window: 200_000,
    output_max_tokens: 64_000,
    cost_per_1k_input: 1,
    cost_per_1k_output: 1,
    notes: [],
  },
  factory: () => {
    throw new Error('not used');
  },
});

describe('createRegistry', () => {
  test('starts empty', () => {
    const reg = createRegistry();
    expect(reg.list()).toEqual([]);
  });

  test('register stores an entry; get retrieves it', () => {
    const reg = createRegistry();
    const entry = dummyEntry('anthropic/test-model');
    reg.register(entry);
    expect(reg.get('anthropic/test-model')).toBe(entry);
    expect(reg.has('anthropic/test-model')).toBe(true);
  });

  test('get returns null for unknown id', () => {
    const reg = createRegistry();
    expect(reg.get('unknown')).toBeNull();
    expect(reg.has('unknown')).toBe(false);
  });

  test('register throws on duplicate id', () => {
    const reg = createRegistry();
    reg.register(dummyEntry('anthropic/dup'));
    expect(() => reg.register(dummyEntry('anthropic/dup'))).toThrow(/already registered/);
  });

  test('list returns all entries', () => {
    const reg = createRegistry();
    reg.register(dummyEntry('anthropic/a'));
    reg.register(dummyEntry('anthropic/b'));
    expect(reg.list()).toHaveLength(2);
    expect(
      reg
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['anthropic/a', 'anthropic/b']);
  });
});

describe('createDefaultRegistry', () => {
  test('contains the M1 Anthropic lineup', () => {
    const reg = createDefaultRegistry();
    expect(reg.has('anthropic/claude-opus-4-7')).toBe(true);
    expect(reg.has('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(reg.has('anthropic/claude-haiku-4-5')).toBe(true);
  });

  test('contains the Gemini lineup', () => {
    const reg = createDefaultRegistry();
    expect(reg.has('google/gemini-2.5-pro')).toBe(true);
    expect(reg.has('google/gemini-2.5-flash')).toBe(true);
    expect(reg.has('google/gemini-2.5-flash-lite')).toBe(true);
  });

  test('contains the OpenAI lineup', () => {
    const reg = createDefaultRegistry();
    expect(reg.has('openai/gpt-4o')).toBe(true);
    expect(reg.has('openai/gpt-4o-mini')).toBe(true);
  });

  test('contains the Ollama lineup', () => {
    const reg = createDefaultRegistry();
    expect(reg.has('ollama/qwen2.5-coder:14b')).toBe(true);
    expect(reg.has('ollama/glm-5.2')).toBe(true);
    expect(reg.has('ollama/gpt-oss:20b')).toBe(true);
  });

  test('every model in each caps table is registered exactly once', () => {
    const reg = createDefaultRegistry();
    for (const modelName of ANTHROPIC_MODEL_NAMES) {
      expect(reg.has(`anthropic/${modelName}`)).toBe(true);
    }
    for (const modelName of GOOGLE_MODEL_NAMES) {
      expect(reg.has(`google/${modelName}`)).toBe(true);
    }
    for (const modelName of OPENAI_MODEL_NAMES) {
      expect(reg.has(`openai/${modelName}`)).toBe(true);
    }
    for (const modelName of OLLAMA_MODEL_NAMES) {
      expect(reg.has(`ollama/${modelName}`)).toBe(true);
    }
    for (const modelName of OLLAMA_CLOUD_MODEL_NAMES) {
      expect(reg.has(`ollama/${modelName}`)).toBe(true);
    }
    for (const modelName of OPENROUTER_MODEL_NAMES) {
      expect(reg.has(`openrouter/${modelName}`)).toBe(true);
    }
    expect(reg.list()).toHaveLength(
      ANTHROPIC_MODEL_NAMES.length +
        GOOGLE_MODEL_NAMES.length +
        OPENAI_MODEL_NAMES.length +
        OLLAMA_MODEL_NAMES.length +
        OLLAMA_CLOUD_MODEL_NAMES.length +
        OPENROUTER_MODEL_NAMES.length,
    );
  });

  test('Anthropic entry: factory builds a provider with matching capabilities', () => {
    const reg = createDefaultRegistry();
    const entry = reg.get('anthropic/claude-sonnet-4-6');
    expect(entry).not.toBeNull();
    if (entry === null) return;
    const provider = entry.factory({ apiKey: 'sk-test' });
    expect(provider.id).toBe(entry.id);
    expect(provider.family).toBe('anthropic');
    expect(provider.capabilities).toEqual(entry.capabilities);
  });

  test('Google entry: factory builds a provider with matching capabilities', () => {
    const reg = createDefaultRegistry();
    const entry = reg.get('google/gemini-2.5-flash');
    expect(entry).not.toBeNull();
    if (entry === null) return;
    const provider = entry.factory({ apiKey: 'k-test' });
    expect(provider.id).toBe(entry.id);
    expect(provider.family).toBe('google');
    expect(provider.capabilities).toEqual(entry.capabilities);
  });

  test('OpenAI entry: factory builds a provider with matching capabilities', () => {
    const reg = createDefaultRegistry();
    const entry = reg.get('openai/gpt-4o-mini');
    expect(entry).not.toBeNull();
    if (entry === null) return;
    const provider = entry.factory({ apiKey: 'sk-test' });
    expect(provider.id).toBe(entry.id);
    expect(provider.family).toBe('openai');
    expect(provider.capabilities).toEqual(entry.capabilities);
  });

  test('Ollama entry: factory builds a provider with no API key (local)', () => {
    const reg = createDefaultRegistry();
    const entry = reg.get('ollama/qwen2.5-coder:14b');
    expect(entry).not.toBeNull();
    if (entry === null) return;
    const provider = entry.factory();
    expect(provider.id).toBe(entry.id);
    expect(provider.family).toBe('ollama');
    expect(provider.capabilities).toEqual(entry.capabilities);
  });

  test('all cloud default entries can be instantiated with just an apiKey', () => {
    const reg = createDefaultRegistry();
    for (const entry of reg.list()) {
      expect(() => entry.factory({ apiKey: 'k-test' })).not.toThrow();
    }
  });
});
