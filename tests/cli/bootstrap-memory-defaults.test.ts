// Boot-time integration for memory governance defaults (Slice Q).
//
// Asserts:
//   - Fresh repo (no `.agent/`, no user config) boots with both
//     detectors resolved=ON via the hardcoded default.
//   - `HarnessConfig.memorySemanticVerify` + `memoryConflictDetect`
//     reflect the precedence chain (CLI > project > user > default).
//   - `memorySemanticVerifySource` provenance is `'default' |
//     'cli' | 'project-config' | 'user-config'`.
//   - First-boot stderr banner fires once per machine (marker file
//     gate); `--json` mode suppresses it; explicit CLI flag or any
//     config layer touching either key suppresses it.
//   - Banner marker dir defaults to `~/.local/share/forja/` but can
//     be overridden / disabled via `BootstrapInput.governanceBanner
//     MarkerDir` for CI determinism.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../../src/cli/bootstrap.ts';
import type { Provider } from '../../src/providers/index.ts';

let workdir: string;
let dbPath: string;
let markerDir: string;
let originalKey: string | undefined;
let originalXdg: string | undefined;
let stderrChunks: string[];
let originalStderrWrite: typeof process.stderr.write;

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

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-bootstrap-mem-'));
  dbPath = join(workdir, 'sessions.db');
  markerDir = join(workdir, 'marker');
  originalKey = process.env.ANTHROPIC_API_KEY;
  // Pin XDG_CONFIG_HOME to workdir so the loader looks for the
  // user-layer config at `<workdir>/agent/config.toml` (which we
  // never create) instead of the developer's real ~/.config.
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = workdir;
  captureStderr();
});

afterEach(() => {
  restoreStderr();
  rmSync(workdir, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

describe('bootstrap: memory governance defaults', () => {
  test('fresh repo: detectors default ON via the default source', async () => {
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memorySemanticVerify).toBe(true);
    expect(config.memoryConflictDetect).toBe(true);
    expect(config.memorySemanticVerifySource).toBe('default');
    expect(config.memoryConflictDetectSource).toBe('default');
    db.close();
  });

  test('first boot emits banner; second boot stays silent (marker gate)', async () => {
    const args = {
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    } as const;
    const first = await bootstrap(args);
    first.db.close();
    expect(stderrJoined()).toContain('governance LLM detectors enabled by default');
    expect(existsSync(join(markerDir, '.governance-banner-shown'))).toBe(true);
    // Second boot: marker exists -> banner stays silent.
    stderrChunks = [];
    const second = await bootstrap({
      ...args,
      dbPath: join(workdir, 'sessions2.db'),
    });
    second.db.close();
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
  });

  test('--json mode suppresses banner even on first boot', async () => {
    const { db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
      json: true,
    });
    db.close();
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    // Marker not written when banner was suppressed pre-write — but
    // the gate evaluates suppression BEFORE the marker check, so
    // no marker file should appear either.
    expect(existsSync(join(markerDir, '.governance-banner-shown'))).toBe(false);
  });

  test('explicit CLI override suppresses banner + bumps source to "cli"', async () => {
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
      memorySemanticVerify: false,
    });
    expect(config.memorySemanticVerify).toBe(false);
    expect(config.memorySemanticVerifySource).toBe('cli');
    // conflict still defaults — but the "both from default" gate
    // fails because verify is from CLI, so banner is suppressed.
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    db.close();
  });

  test('project config disabling verify suppresses banner + sets source', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[memory]
verify_semantic_llm = false
conflict_detect_llm = true
`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memorySemanticVerify).toBe(false);
    expect(config.memorySemanticVerifySource).toBe('project-config');
    // conflict_detect_llm = true is explicit in project config —
    // source is 'project-config', not 'default', so banner gate
    // (both-from-default) fails and stays silent.
    expect(config.memoryConflictDetect).toBe(true);
    expect(config.memoryConflictDetectSource).toBe('project-config');
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    db.close();
  });

  test('user config disabling conflict suppresses banner + sets source', async () => {
    // XDG_CONFIG_HOME points at workdir -> user-layer file lives at
    // <workdir>/agent/config.toml (see userConfigPath in
    // src/critique/config-loader.ts).
    mkdirSync(join(workdir, 'agent'), { recursive: true });
    writeFileSync(
      join(workdir, 'agent', 'config.toml'),
      `[memory]
conflict_detect_llm = false
`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memoryConflictDetect).toBe(false);
    expect(config.memoryConflictDetectSource).toBe('user-config');
    // verify still on; banner suppressed because conflict isn't from default.
    expect(config.memorySemanticVerify).toBe(true);
    expect(config.memorySemanticVerifySource).toBe('default');
    expect(stderrJoined()).not.toContain('governance LLM detectors enabled by default');
    db.close();
  });

  test('project wins over user when both touch verify', async () => {
    mkdirSync(join(workdir, 'agent'), { recursive: true });
    writeFileSync(
      join(workdir, 'agent', 'config.toml'),
      `[memory]
verify_semantic_llm = true
`,
    );
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent', 'config.toml'),
      `[memory]
verify_semantic_llm = false
`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: markerDir,
    });
    expect(config.memorySemanticVerify).toBe(false);
    expect(config.memorySemanticVerifySource).toBe('project-config');
    db.close();
  });

  test('marker dir = null disables marker entirely (banner re-fires)', async () => {
    const args = {
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      governanceBannerMarkerDir: null,
    } as const;
    const first = await bootstrap(args);
    first.db.close();
    expect(stderrJoined()).toContain('governance LLM detectors enabled by default');
    stderrChunks = [];
    const second = await bootstrap({ ...args, dbPath: join(workdir, 'sessions2.db') });
    second.db.close();
    // Marker dir disabled -> banner fires every boot.
    expect(stderrJoined()).toContain('governance LLM detectors enabled by default');
  });
});
