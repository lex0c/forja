// Operator-owned model catalog: file I/O + validation (catalog-io) and
// registry construction / factory wiring (catalog-file).
//
// The catalog file (`~/.config/forja/model_providers.json`) is the
// runtime source of truth; these tests pin the fail-soft contract
// (absent/corrupt → error; bad entry → warn+skip; dup id → first wins)
// and the family→adapter wiring (capabilities + base_url + api_key_env).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildRegistryFromEntries,
  createDefaultRegistry,
  lazyModelRegistry,
  loadModelRegistry,
} from '../../src/providers/catalog-file.ts';
import {
  CATALOG_VERSION,
  isSupportedFamily,
  loadModelProvidersFile,
  modelProvidersPath,
  serializeModelProviders,
} from '../../src/providers/catalog-io.ts';
import { resolveProviderFromId } from '../../src/providers/resolve.ts';
import { CANONICAL_MODEL_PROVIDERS } from '../../src/providers/seed-catalog.ts';
import type { ModelProviderEntry, ProviderCapabilities } from '../../src/providers/types.ts';

const VALID_CAPS: ProviderCapabilities = {
  tools: 'native',
  cache: false,
  vision: false,
  streaming: true,
  constrained: 'json_mode',
  context_window: 32_768,
  output_max_tokens: 8_192,
  cost_per_1k_input: 0,
  cost_per_1k_output: 0,
  notes: ['test model'],
};

let workdir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-catalog-'));
  // loadModelProvidersFile takes an explicit env, so no process.env
  // mutation — the resolved path is `<workdir>/forja/model_providers.json`.
  env = { XDG_CONFIG_HOME: workdir };
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// Write raw bytes to the resolved catalog path for `env`.
const writeCatalog = (raw: string): void => {
  const path = modelProvidersPath(env);
  if (path === null) throw new Error('no path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
};

const entry = (over: Partial<ModelProviderEntry> = {}): ModelProviderEntry => ({
  id: 'ollama/qwen3:14b',
  family: 'ollama',
  model_name: 'qwen3:14b',
  capabilities: VALID_CAPS,
  ...over,
});

const catalogJson = (models: unknown[]): string =>
  JSON.stringify({ version: CATALOG_VERSION, models });

describe('lazyModelRegistry — deferred catalog read for nested overrides', () => {
  test('does not read the catalog at construction (defer)', () => {
    let errs = 0;
    // Empty workdir ⇒ loadModelRegistry would throw, but construction must not.
    lazyModelRegistry(() => {
      errs += 1;
    }, env);
    expect(errs).toBe(0);
  });

  test('degrades to an empty registry on load failure (no throw)', () => {
    const msgs: string[] = [];
    const reg = lazyModelRegistry((m) => msgs.push(m), env);
    expect(reg.get('ollama/qwen3:14b')).toBeNull();
    expect(reg.list()).toEqual([]);
    expect(msgs.length).toBeGreaterThan(0);
  });

  test('attempts the load once and caches the degraded result', () => {
    let errs = 0;
    const reg = lazyModelRegistry(() => {
      errs += 1;
    }, env);
    reg.get('x');
    reg.list();
    reg.has('y');
    expect(errs).toBe(1);
  });

  test('serves the real catalog when present (loaded on first use)', () => {
    writeCatalog(catalogJson([entry()]));
    let errs = 0;
    const reg = lazyModelRegistry(() => {
      errs += 1;
    }, env);
    expect(reg.get('ollama/qwen3:14b')?.id).toBe('ollama/qwen3:14b');
    expect(errs).toBe(0);
  });
});

describe('loadModelProvidersFile — hard errors (init mandatory)', () => {
  test('absent file → error pointing at forja init', () => {
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('forja init');
  });

  test('no derivable config dir → error', () => {
    const r = loadModelProvidersFile({});
    expect(r.ok).toBe(false);
  });

  test('invalid JSON → error mentioning re-init', () => {
    writeCatalog('{ not json');
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--force=model_providers');
  });

  test('top level not an object → error', () => {
    writeCatalog('[]');
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(false);
  });

  test('models not an array → error', () => {
    writeCatalog(JSON.stringify({ version: 1, models: {} }));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(false);
  });

  test('zero valid entries → error', () => {
    writeCatalog(catalogJson([{ id: 'bogus' }]));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no valid models');
  });
});

describe('loadModelProvidersFile — per-entry fail-soft', () => {
  test('valid entry loads', () => {
    writeCatalog(catalogJson([entry()]));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]?.id).toBe('ollama/qwen3:14b');
      expect(r.warnings).toHaveLength(0);
    }
  });

  test('unsupported family → warn + skip, valid sibling survives', () => {
    writeCatalog(
      catalogJson([
        entry({ id: 'mistral/x', family: 'mistral' as never, model_name: 'x' }),
        entry(),
      ]),
    );
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(1);
      expect(r.warnings[0]).toContain('family must be one of');
    }
  });

  test('id not equal family/model_name → warn + skip', () => {
    writeCatalog(catalogJson([entry({ id: 'ollama/mismatch' }), entry()]));
    const r = loadModelProvidersFile(env);
    if (r.ok) expect(r.warnings[0]).toContain('id must equal');
  });

  test('invalid api_key_env → warn + skip', () => {
    writeCatalog(
      catalogJson([
        entry({ id: 'openai/m', family: 'openai', model_name: 'm', api_key_env: 'bad-name!' }),
        entry(),
      ]),
    );
    const r = loadModelProvidersFile(env);
    if (r.ok) expect(r.warnings[0]).toContain('api_key_env');
  });

  test('incomplete capabilities → warn + skip naming the field', () => {
    const broken = { ...entry(), capabilities: { tools: 'native' } };
    writeCatalog(catalogJson([broken, entry()]));
    const r = loadModelProvidersFile(env);
    if (r.ok) expect(r.warnings[0]).toContain('vision must be a boolean');
  });

  test('non-positive token counts and negative prices → warn + skip', () => {
    const negWindow = entry({
      id: 'ollama/a',
      model_name: 'a',
      capabilities: { ...VALID_CAPS, context_window: -1 },
    });
    const zeroOutput = entry({
      id: 'ollama/b',
      model_name: 'b',
      capabilities: { ...VALID_CAPS, output_max_tokens: 0 },
    });
    const negCost = entry({
      id: 'ollama/c',
      model_name: 'c',
      capabilities: { ...VALID_CAPS, cost_per_1k_input: -0.5 },
    });
    writeCatalog(catalogJson([negWindow, zeroOutput, negCost, entry()]));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Only the valid default entry survives the three bad ones.
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]?.id).toBe('ollama/qwen3:14b');
      const w = r.warnings.join(' ');
      expect(w).toContain('context_window must be a positive integer');
      expect(w).toContain('output_max_tokens must be a positive integer');
      expect(w).toContain('cost_per_1k_input must be a non-negative number');
    }
  });

  test('non-positive / non-integer num_ctx → warn + skip', () => {
    const zero = entry({ id: 'ollama/a', model_name: 'a', num_ctx: 0 });
    const frac = entry({ id: 'ollama/b', model_name: 'b', num_ctx: 1.5 });
    writeCatalog(catalogJson([zero, frac, entry()]));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]?.id).toBe('ollama/qwen3:14b');
      expect(r.warnings.join(' ')).toContain('num_ctx must be a positive integer');
    }
  });

  test('a valid num_ctx loads onto the entry', () => {
    writeCatalog(catalogJson([entry({ num_ctx: 131_072 })]));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries[0]?.num_ctx).toBe(131_072);
  });

  test('duplicate id → warn + first wins', () => {
    writeCatalog(
      catalogJson([entry(), entry({ capabilities: { ...VALID_CAPS, context_window: 1 } })]),
    );
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]?.capabilities.context_window).toBe(32_768);
      expect(r.warnings[0]).toContain('duplicate id');
    }
  });
});

describe('registry construction + factory wiring', () => {
  test('buildRegistryFromEntries resolves an ollama model with overridden caps + base_url', () => {
    const reg = buildRegistryFromEntries([
      entry({
        base_url: 'http://localhost:9999',
        capabilities: { ...VALID_CAPS, context_window: 12_345 },
      }),
    ]);
    const got = reg.get('ollama/qwen3:14b');
    expect(got?.capabilities.context_window).toBe(12_345);
    const resolved = resolveProviderFromId(reg, 'ollama/qwen3:14b');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.provider.id).toBe('ollama/qwen3:14b');
  });

  test('per-entry num_ctx flows to the ollama factory and bypasses the 32K cap', () => {
    // A 256K-capacity entry with NO num_ctx clamps to the default 32K cap
    // (VRAM protection) — the served window the harness budgets against.
    const capped = buildRegistryFromEntries([
      entry({ capabilities: { ...VALID_CAPS, context_window: 262_144 } }),
    ])
      .get('ollama/qwen3:14b')
      ?.factory();
    expect(capped?.capabilities.context_window).toBe(32_768);

    // The SAME entry WITH a per-entry num_ctx serves that window instead —
    // the cloud-window fix (a remote host has no local VRAM to protect).
    const widened = buildRegistryFromEntries([
      entry({ num_ctx: 131_072, capabilities: { ...VALID_CAPS, context_window: 262_144 } }),
    ])
      .get('ollama/qwen3:14b')
      ?.factory();
    expect(widened?.capabilities.context_window).toBe(131_072);
  });

  test('ollama cloud entry: a { client } override does NOT bypass the missing-key guard', () => {
    // Ollama authenticates via a bearer header (apiKey/env), not an SDK client —
    // createOllamaProvider has no client param. A client override satisfies the guard for
    // SDK families, but for an ollama entry it would otherwise instantiate a key-requiring
    // cloud model with no Authorization header, so the guard must still demand a key.
    const key = 'FORJA_TEST_OLLAMA_KEY_XYZ';
    const prior = process.env[key];
    delete process.env[key]; // env key UNSET
    try {
      const ollama = buildRegistryFromEntries([
        entry({
          id: 'ollama/cloud-x',
          family: 'ollama',
          model_name: 'cloud-x',
          api_key_env: key,
          base_url: 'https://ollama.com',
        }),
      ]).get('ollama/cloud-x');
      // The bug: a client override let this construct unauthenticated. Now it throws.
      expect(() => ollama?.factory({ client: {} })).toThrow(/API key required/);
      // An injected apiKey DOES satisfy it — it becomes the bearer header.
      expect(() => ollama?.factory({ apiKey: 'sk-bearer' })).not.toThrow();
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  test('api_key_env is read from the named env var for the openai adapter', () => {
    const key = 'FORJA_TEST_OPENAI_KEY_XYZ';
    const prior = process.env[key];
    process.env[key] = 'sk-test-123';
    try {
      const reg = buildRegistryFromEntries([
        entry({
          id: 'openai/gpt-x',
          family: 'openai',
          model_name: 'gpt-x',
          api_key_env: key,
          base_url: 'http://localhost:9',
          capabilities: { ...VALID_CAPS, constrained: 'tools' },
        }),
      ]);
      // Factory builds the SDK client without throwing → key resolved.
      const resolved = resolveProviderFromId(reg, 'openai/gpt-x');
      expect(resolved.ok).toBe(true);
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  test('a configured-but-empty api_key_env FAILS instead of leaking the vendor default key', () => {
    // Entry points at a third-party endpoint and names a custom key var
    // that is UNSET, while the real vendor key IS present. The factory
    // must refuse — not fall back to OPENAI_API_KEY and ship it to the
    // catalog's base_url.
    const customVar = 'FORJA_TEST_VLLM_KEY_UNSET';
    delete process.env[customVar];
    const priorOpenai = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-real-vendor-key';
    try {
      const reg = buildRegistryFromEntries([
        entry({
          id: 'openai/vllm',
          family: 'openai',
          model_name: 'vllm',
          api_key_env: customVar,
          base_url: 'https://third-party.example',
          capabilities: { ...VALID_CAPS, constrained: 'tools' },
        }),
      ]);
      const resolved = resolveProviderFromId(reg, 'openai/vllm');
      expect(resolved.ok).toBe(false);
      // Narrow by `kind` (a type guard) so `.message` is accessible.
      if (!resolved.ok && resolved.kind === 'factory-error') {
        expect(resolved.message).toContain(customVar);
        // Recognizable as a missing-key failure (recap stub-fallback gate).
        expect(resolved.message).toContain('API key required');
      } else {
        throw new Error(`expected factory-error, got ${JSON.stringify(resolved)}`);
      }
    } finally {
      if (priorOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorOpenai;
    }
  });

  test('factory stamps the source catalog entry on the provider (snapshot provenance)', () => {
    // The subagent spawn path reads provider.catalogEntry to snapshot it
    // onto subagent_runs (migration 076), so a spawned child rebuilds the
    // SAME provider instead of re-reading a possibly-edited catalog file.
    const e = entry({ base_url: 'http://h:1' });
    const provider = buildRegistryFromEntries([e]).get('ollama/qwen3:14b')?.factory();
    expect(provider?.catalogEntry).toEqual(e);
  });

  test('ollama: an injected opts.apiKey becomes the Authorization header (cloud auth)', async () => {
    // A cloud entry names an UNSET api_key_env (hasKey=false); a programmatic caller
    // injects apiKey, satisfying the missing-key guard. Ollama auths via a header (no
    // SDK apiKey field), so the injected key MUST map to Authorization — else the
    // provider ships unauthenticated and the first /api/chat 401s.
    const unsetVar = 'FORJA_TEST_OLLAMA_KEY_UNSET';
    delete process.env[unsetVar];
    let auth: string | null | undefined;
    const fetchFn = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      auth = new Headers(init?.headers).get('authorization');
      return new Response('{"done":true}\n', {
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }) as unknown as typeof fetch;

    const provider = buildRegistryFromEntries([
      entry({ api_key_env: unsetVar, base_url: 'https://ollama.com' }),
    ])
      .get('ollama/qwen3:14b')
      ?.factory({ apiKey: 'injected-key', fetch: fetchFn });
    if (provider === undefined) throw new Error('provider not built');

    try {
      // Drain to fire the request; the header is captured on the fetch call, so
      // the minimal response's stream shape is irrelevant to the assertion.
      for await (const _ev of provider.generate({
        model: 'qwen3:14b',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
      })) {
        // no-op
      }
    } catch {
      // stream content is not under test
    }
    expect(auth).toBe('Bearer injected-key');
  });

  test('isSupportedFamily recognizes only the shipped adapters', () => {
    // The subagent child gates a persisted snapshot on this before
    // rebuilding, so a corrupt unsupported family falls back to the file.
    for (const f of ['anthropic', 'openai', 'ollama', 'google', 'openrouter']) {
      expect(isSupportedFamily(f)).toBe(true);
    }
    for (const f of ['mistral', 'llama_cpp', 'bogus', '']) {
      expect(isSupportedFamily(f)).toBe(false);
    }
  });

  test('loadModelRegistry throws when the file is absent', () => {
    expect(() => loadModelRegistry(env)).toThrow('forja init');
  });

  test('loadModelRegistry builds from a valid file', () => {
    writeCatalog(catalogJson([entry()]));
    const { registry, warnings } = loadModelRegistry(env);
    expect(registry.has('ollama/qwen3:14b')).toBe(true);
    expect(warnings).toHaveLength(0);
  });
});

describe('seed catalog + serialization', () => {
  test('createDefaultRegistry exposes the built-in families', () => {
    const reg = createDefaultRegistry();
    const ids = reg.list().map((e) => e.id);
    expect(ids).toContain('anthropic/claude-opus-4-8');
    expect(ids.some((id) => id.startsWith('openai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('ollama/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('google/'))).toBe(true);
    // OpenRouter ids carry two slashes (openrouter/<vendor>/<model>).
    expect(ids.some((id) => id.startsWith('openrouter/'))).toBe(true);
  });

  test('every seed entry has an id of the form family/model_name', () => {
    for (const e of CANONICAL_MODEL_PROVIDERS) {
      expect(e.id).toBe(`${e.family}/${e.model_name}`);
    }
  });

  test('serialize → write → load round-trips the seed', () => {
    writeCatalog(serializeModelProviders(CANONICAL_MODEL_PROVIDERS));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(CANONICAL_MODEL_PROVIDERS.length);
      expect(r.warnings).toHaveLength(0);
    }
  });

  test('serialize → load round-trips a per-entry num_ctx + base_url', () => {
    const e = entry({ base_url: 'https://ollama.com', num_ctx: 131_072 });
    writeCatalog(serializeModelProviders([e]));
    const r = loadModelProvidersFile(env);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries[0]?.num_ctx).toBe(131_072);
      expect(r.entries[0]?.base_url).toBe('https://ollama.com');
    }
  });

  test('seed ships the curated Ollama Cloud tier with base_url + api_key_env + num_ctx', () => {
    const cloud = CANONICAL_MODEL_PROVIDERS.filter(
      (e) => e.family === 'ollama' && e.base_url === 'https://ollama.com',
    );
    expect(cloud.map((e) => e.id).sort()).toEqual([
      'ollama/deepseek-v4-pro:cloud',
      'ollama/devstral-2:123b',
      'ollama/glm-5.2',
      'ollama/gpt-oss:20b',
      'ollama/kimi-k2.7-code:cloud',
      'ollama/qwen3-coder-next',
      'ollama/qwen3-coder:480b',
    ]);
    for (const e of cloud) {
      expect(e.api_key_env).toBe('OLLAMA_API_KEY');
      // num_ctx is derived per model from its real capacity (NOT a flat 131K cap),
      // so the host serves the full declared window instead of truncating early.
      expect(e.num_ctx).toBe(e.capabilities.context_window);
      expect(e.capabilities.tools).toBe('native');
      // Hosted = unmetered (billed by subscription/GPU-time, not per token).
      expect(e.capabilities.unmetered).toBe(true);
    }
  });
});
