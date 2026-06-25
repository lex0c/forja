// bootstrap: `--model` model-pin autosave (BootstrapInput.persistModelPin).
//
// Asserts the wiring + the guards that keep the autosave from firing on
// the wrong paths:
//   - persistModelPin + a real --model resolution writes [providers].model.
//   - providerOverride (test/dev/subagent injection) is NEVER persisted.
//   - persistModelPin absent (the headless `forja recap` bootstrap shape:
//     it passes modelId WITHOUT the flag) writes nothing.
//   - --json suppresses the success stderr line but still writes the pin.
//   - an already-pinned id is a no-op (compare-before-write: no churn).
//
// Real model resolution (no providerOverride) needs the anthropic factory
// to construct, which only requires the API-key env var to be PRESENT —
// bootstrap never generates, so no network call happens with the dummy.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../../src/cli/bootstrap.ts';
import { projectDirName } from '../../src/config/app-namespace.ts';
import { setWritableCacheDirsOverride } from '../../src/permissions/sandbox-cache-dirs.ts';
import { setCachePersistenceOverride } from '../../src/permissions/sandbox-cache-env.ts';
import type { Provider } from '../../src/providers/index.ts';
import { seedModelCatalog } from '../helpers/seed-catalog.ts';

const PINNED = 'anthropic/claude-haiku-4-5';

const mockProvider: Provider = {
  id: 'mock/m',
  family: 'anthropic',
  capabilities: {
    tools: 'native',
    cache: false,
    vision: false,
    streaming: true,
    constrained: 'tools',
    context_window: 1000,
    output_max_tokens: 100,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [],
  },
  // biome-ignore lint/correctness/useYield: never reaches yield
  async *generate() {
    throw new Error('not used');
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
};

let workdir: string;
let dbPath: string;
let markerDir: string;
let configPath: string;
let stderrChunks: string[];
let originalStderrWrite: typeof process.stderr.write;
let originalKey: string | undefined;
let originalXdg: string | undefined;
let originalXdgCache: string | undefined;

const captureStderr = () => {
  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
};
const restoreStderr = () => {
  process.stderr.write = originalStderrWrite;
};
const stderrJoined = () => stderrChunks.join('');

const baseArgs = () =>
  ({
    prompt: 'hi',
    cwd: workdir,
    dbPath,
    enterprisePolicyPath: null,
    userPolicyPath: null,
    governanceBannerMarkerDir: markerDir,
  }) as const;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-model-pin-'));
  dbPath = join(workdir, 'sessions.db');
  markerDir = join(workdir, 'marker');
  configPath = join(workdir, projectDirName(), 'config.toml');
  originalKey = process.env.ANTHROPIC_API_KEY;
  // Present-but-dummy: lets the anthropic factory construct (bootstrap
  // never generates, so no request is made with it).
  process.env.ANTHROPIC_API_KEY = 'test-key';
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = workdir;
  originalXdgCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = workdir;
  seedModelCatalog();
  captureStderr();
});

afterEach(() => {
  restoreStderr();
  setCachePersistenceOverride(undefined);
  setWritableCacheDirsOverride(undefined);
  rmSync(workdir, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCache;
});

describe('bootstrap: --model autosave', () => {
  test('persistModelPin + real --model resolution writes the pin silently', async () => {
    const { db } = await bootstrap({ ...baseArgs(), modelId: PINNED, persistModelPin: true });
    db.close();
    expect(existsSync(configPath)).toBe(true);
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as {
      providers: { model: string };
    };
    expect(parsed.providers.model).toBe(PINNED);
    // A successful pin is silent — no boot-time chatter in the TUI.
    expect(stderrJoined()).not.toContain('pinned model');
  });

  test('providerOverride injection is NEVER persisted (subagent/test safety)', async () => {
    const { db } = await bootstrap({
      ...baseArgs(),
      modelId: PINNED,
      persistModelPin: true,
      providerOverride: mockProvider,
    });
    db.close();
    expect(existsSync(configPath)).toBe(false);
  });

  test('modelId WITHOUT persistModelPin writes nothing (recap-path opt-in gate)', async () => {
    // The headless `forja recap` bootstrap passes modelId but not the
    // flag — it must not mutate the operator's committed config.
    const { db } = await bootstrap({ ...baseArgs(), modelId: PINNED });
    db.close();
    expect(existsSync(configPath)).toBe(false);
  });

  test('writes the pin in --json mode without polluting stderr', async () => {
    const { db } = await bootstrap({
      ...baseArgs(),
      modelId: PINNED,
      persistModelPin: true,
      json: true,
    });
    db.close();
    expect(existsSync(configPath)).toBe(true);
    expect(stderrJoined()).not.toContain('pinned model');
  });

  test('already-pinned id is a no-op: file untouched, no announcement', async () => {
    mkdirSync(join(workdir, projectDirName()), { recursive: true });
    const original = `# operator comment
[providers]
model = "${PINNED}"
`;
    writeFileSync(configPath, original);
    const { db } = await bootstrap({ ...baseArgs(), modelId: PINNED, persistModelPin: true });
    db.close();
    // Comment survives ⇒ no round-trip rewrite happened.
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(stderrJoined()).not.toContain('pinned model');
  });

  test('a boot that aborts after model resolution does NOT pin (deferred write)', async () => {
    // A malformed enterprise policy throws in preflightPermissionEngine —
    // a boot-blocking failure AFTER --model resolves. The pin is deferred
    // to the end of a successful bootstrap, so a boot that never started
    // must NOT have rewritten the committed config.
    const badPolicy = join(workdir, 'bad-policy.yaml');
    writeFileSync(badPolicy, 'defaults: { mode: [unterminated\n');
    await expect(
      bootstrap({
        ...baseArgs(),
        modelId: PINNED,
        persistModelPin: true,
        enterprisePolicyPath: badPolicy,
      }),
    ).rejects.toThrow();
    expect(existsSync(configPath)).toBe(false);
  });
});
