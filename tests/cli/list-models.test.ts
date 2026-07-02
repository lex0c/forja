import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runListModelsCli } from '../../src/cli/list-models.ts';
import { CANONICAL_MODEL_PROVIDERS } from '../../src/providers/seed-catalog.ts';
import { seedModelCatalog } from '../helpers/seed-catalog.ts';

// The handler takes an explicit `env`, so we build an isolated one
// (temp HOME + XDG_CONFIG_HOME → the catalog path) instead of mutating
// process.env. The same env drives both the catalog read AND the
// api_key_env readiness lookup, so we can pin which models are "ready"
// by which key vars we set. We seed the canonical catalog (the exact
// bytes `forja init` writes) to exercise the real on-disk read path.

// Provider key envs we clear so readiness is deterministic — only the
// ones we explicitly set below count as ready.
const PROVIDER_KEY_ENVS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'OLLAMA_API_KEY',
  'OPENROUTER_API_KEY',
];

let xdgRoot: string;
let baseEnv: NodeJS.ProcessEnv;
let outBuf: string;
let errBuf: string;

const out = (s: string): void => {
  outBuf += s;
};
const err = (s: string): void => {
  errBuf += s;
};

beforeEach(() => {
  xdgRoot = mkdtempSync(join(tmpdir(), 'forja-list-models-'));
  baseEnv = { ...process.env };
  baseEnv.HOME = xdgRoot;
  baseEnv.XDG_CONFIG_HOME = join(xdgRoot, '.config');
  delete baseEnv.FORJA_PROFILE;
  for (const k of PROVIDER_KEY_ENVS) delete baseEnv[k];
  outBuf = '';
  errBuf = '';
});

afterEach(() => {
  rmSync(xdgRoot, { recursive: true, force: true });
});

describe('runListModelsCli — plain', () => {
  test('renders the catalog: default starred, readiness driven by env, unmetered label', () => {
    // Only Anthropic gets a key → only anthropic rows read as `ready`.
    baseEnv.ANTHROPIC_API_KEY = 'sk-test-anthropic';
    seedModelCatalog(baseEnv);

    const code = runListModelsCli({ json: false, env: baseEnv, out, err });
    expect(code).toBe(0);

    const lines = outBuf.split('\n');
    const header = lines[0] ?? '';
    expect(header).toContain('MODEL');
    expect(header).toContain('PRICE/1M (in/out)');
    expect(header).toContain('STATUS');

    // Default model is starred and, with its key set, ready.
    const opusLine = lines.find((l) => l.startsWith('anthropic/claude-opus-4-8'));
    expect(opusLine).toBeDefined();
    expect(opusLine).toContain('*');
    expect(opusLine).toMatch(/\bready\b/);

    // A model whose key we did NOT set reports the missing var by name.
    const openaiLine = lines.find((l) => l.startsWith('openai/'));
    expect(openaiLine).toBeDefined();
    expect(openaiLine).toContain('needs OPENAI_API_KEY');

    // Local Ollama needs no key → ready (local); we do not probe the daemon.
    expect(lines.some((l) => l.includes('ready (local)'))).toBe(true);

    // Ollama Cloud is unmetered → honest label, never a misleading $0.
    expect(lines.some((l) => l.includes('unmetered'))).toBe(true);

    // Legend explains the star.
    expect(outBuf).toContain('* default model');
    expect(errBuf).toBe('');
  });
});

describe('runListModelsCli — json (NDJSON)', () => {
  test('one object per model + a summary line; fields reflect env', () => {
    baseEnv.ANTHROPIC_API_KEY = 'sk-test-anthropic';
    seedModelCatalog(baseEnv);

    const code = runListModelsCli({ json: true, env: baseEnv, out, err });
    expect(code).toBe(0);

    const lines = outBuf.trim().split('\n');
    const summary = JSON.parse(lines[lines.length - 1] ?? '{}');
    const models = lines.slice(0, -1).map((l) => JSON.parse(l));

    // Every catalog entry is emitted, plus the summary line.
    expect(models.length).toBe(CANONICAL_MODEL_PROVIDERS.length);
    expect(summary.count).toBe(models.length);
    expect(summary.ready_count).toBe(models.filter((m) => m.ready).length);

    const opus = models.find((m) => m.id === 'anthropic/claude-opus-4-8');
    expect(opus).toBeDefined();
    expect(opus.default).toBe(true);
    expect(opus.ready).toBe(true);
    // Pricing is per-1M (the stored cost_per_1k_* value is actually /1M).
    expect(typeof opus.cost_per_1m_input).toBe('number');
    expect(opus.cost_per_1m_input).toBeGreaterThan(0);

    // Unset key → not ready, and the env var name is surfaced.
    const openai = models.find((m) => m.family === 'openai');
    expect(openai).toBeDefined();
    expect(openai.ready).toBe(false);
    expect(openai.api_key_env).toBe('OPENAI_API_KEY');

    // Ollama Cloud carries the unmetered flag and a base_url.
    const unmetered = models.find((m) => m.unmetered === true);
    expect(unmetered).toBeDefined();
    expect(unmetered.base_url).toBe('https://ollama.com');

    // Local Ollama has no key env at all → ready, api_key_env omitted.
    const localOllama = models.find((m) => m.family === 'ollama' && m.api_key_env === undefined);
    expect(localOllama).toBeDefined();
    expect(localOllama.ready).toBe(true);
  });
});

describe('runListModelsCli — missing catalog', () => {
  test('no catalog file → exit 1 with a `forja init` hint, nothing on stdout', () => {
    // No seedModelCatalog() call: the XDG dir has no model_providers.json.
    const code = runListModelsCli({ json: false, env: baseEnv, out, err });
    expect(code).toBe(1);
    expect(outBuf).toBe('');
    expect(errBuf).toContain('forja init');
  });
});
