// The subagent child env preserves provider key vars through the
// credential scrub: the built-in vendor vars always, PLUS a custom
// catalog model's non-built-in api_key_env when selected — else the
// child rebuilding from the spawn-time snapshot dies "API key required"
// (scrubEnv strips every credential-shaped var by default).

import { describe, expect, test } from 'bun:test';
import { buildSubagentChildEnv } from '../../src/subagents/spawn-factory.ts';

describe('buildSubagentChildEnv', () => {
  test('preserves the selected model custom api_key_env scrubEnv would strip', () => {
    const env = { FORJA_VLLM_KEY: 'sk-vllm', PATH: '/usr/bin', OTHER_SECRET: 'x' };
    const out = buildSubagentChildEnv(env, 'FORJA_VLLM_KEY');
    expect(out.FORJA_VLLM_KEY).toBe('sk-vllm');
    expect(out.PATH).toBe('/usr/bin');
    // A DIFFERENT credential-shaped var is not the model's key → stripped.
    expect(out.OTHER_SECRET).toBeUndefined();
  });

  test('without apiKeyEnv, a credential-shaped custom var is stripped', () => {
    const out = buildSubagentChildEnv({ FORJA_VLLM_KEY: 'sk-vllm', PATH: '/usr/bin' });
    expect(out.FORJA_VLLM_KEY).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  test('built-in provider key vars always survive (no apiKeyEnv needed)', () => {
    const out = buildSubagentChildEnv({ ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai' });
    expect(out.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(out.OPENAI_API_KEY).toBe('sk-oai');
  });

  test('a built-in apiKeyEnv is not double-added (still preserved)', () => {
    const out = buildSubagentChildEnv({ ANTHROPIC_API_KEY: 'sk-ant' }, 'ANTHROPIC_API_KEY');
    expect(out.ANTHROPIC_API_KEY).toBe('sk-ant');
  });

  test('preserves catalog credential vars for grandchild model overrides', () => {
    // The child's OWN model uses VENDOR_A_KEY; a grandchild playbook may
    // override to a model whose custom key is GRANDCHILD_KEY. Both must survive
    // this boundary so a coordinator child can authenticate the grandchild
    // model — otherwise GRANDCHILD_KEY is scrubbed here and gone before the
    // nested factory reads it. An unrelated credential-shaped var still strips.
    const env = {
      VENDOR_A_KEY: 'sk-a',
      GRANDCHILD_KEY: 'sk-gc',
      UNRELATED_SECRET: 'sk-x',
      PATH: '/usr/bin',
    };
    const out = buildSubagentChildEnv(env, 'VENDOR_A_KEY', ['VENDOR_A_KEY', 'GRANDCHILD_KEY']);
    expect(out.VENDOR_A_KEY).toBe('sk-a');
    expect(out.GRANDCHILD_KEY).toBe('sk-gc');
    expect(out.UNRELATED_SECRET).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  test('catalog vars are preserved even with no own apiKeyEnv', () => {
    const out = buildSubagentChildEnv({ GRANDCHILD_KEY: 'sk-gc', OTHER_SECRET: 'x' }, undefined, [
      'GRANDCHILD_KEY',
    ]);
    expect(out.GRANDCHILD_KEY).toBe('sk-gc');
    expect(out.OTHER_SECRET).toBeUndefined();
  });
});
