import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCritiqueConfig,
  projectConfigPath,
  userConfigPath,
} from '../../src/critique/config-loader.ts';
import { DEFAULT_CRITIQUE_CONFIG } from '../../src/critique/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import type { ModelEntry, ModelRegistry } from '../../src/providers/registry.ts';

// Stub registry for the model-resolution tests. Captures the
// factory-options the loader passes through and produces a Provider
// whose id matches the requested model — the loader doesn't call
// `generate`, so we don't need a real provider implementation.
const stubRegistry = (knownModels: readonly string[]): ModelRegistry => {
  const factoryCalls: { id: string; opts: unknown }[] = [];
  const map = new Map<string, ModelEntry>();
  const stubCaps = {
    tools: 'native' as const,
    cache: false as const,
    vision: false,
    streaming: true,
    constrained: 'tools' as const,
    context_window: 100_000,
    output_max_tokens: 4096,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [] as string[],
  };
  for (const id of knownModels) {
    map.set(id, {
      id,
      family: 'anthropic',
      modelName: id.split('/')[1] ?? id,
      capabilities: stubCaps,
      factory: (opts) => {
        factoryCalls.push({ id, opts });
        return {
          id,
          family: 'anthropic',
          capabilities: stubCaps,
          async *generate() {
            // Stub never called by the loader — yield to satisfy
            // the AsyncIterable contract without a useYield lint
            // suppression.
            yield* [];
          },
          generateConstrained: () => Promise.reject(new Error('stub')),
          countTokens: () => Promise.resolve(0),
        } as unknown as Provider;
      },
    });
  }
  const reg: ModelRegistry = {
    register() {},
    get: (id) => map.get(id) ?? null,
    list: () => Array.from(map.values()),
    has: (id) => map.has(id),
  };
  return Object.assign(reg, { __factoryCalls: factoryCalls });
};

const makeTempCwd = (): string => mkdtempSync(join(tmpdir(), 'forja-critique-cfg-'));

describe('userConfigPath / projectConfigPath', () => {
  test('XDG_CONFIG_HOME wins when set + absolute', () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' })).toBe(
      '/xdg/agent/config.toml',
    );
  });

  test('falls back to $HOME/.config when XDG is missing', () => {
    expect(userConfigPath({ HOME: '/home/u' })).toBe('/home/u/.config/agent/config.toml');
  });

  test('non-absolute XDG falls through to HOME-based path', () => {
    // Non-absolute XDG_CONFIG_HOME is treated as if the var were
    // unset (security: a relative XDG could shadow user files via
    // path traversal). Falls through to $HOME/.config.
    expect(userConfigPath({ XDG_CONFIG_HOME: 'rel/path', HOME: '/home/u' })).toBe(
      '/home/u/.config/agent/config.toml',
    );
  });

  test('projectConfigPath always derivable from cwd', () => {
    expect(projectConfigPath('/repo')).toBe('/repo/.agent/config.toml');
  });
});

describe('loadCritiqueConfig — empty layers', () => {
  test('no files anywhere → defaults + no warnings', () => {
    const cwd = makeTempCwd();
    try {
      const reg = stubRegistry([]);
      // Use HOME pointing at an empty tmp dir so the user-layer
      // file doesn't exist either.
      const home = mkdtempSync(join(tmpdir(), 'forja-critique-home-'));
      try {
        const result = loadCritiqueConfig({
          cwd,
          registry: reg,
          env: { HOME: home },
        });
        // Read defaults from the constant rather than hardcoding —
        // a future calibration that bumps threshold (e.g.
        // post-real-eval to 0.85) shouldn't require this test
        // to update separately.
        expect(result.config.mode).toBe(DEFAULT_CRITIQUE_CONFIG.mode);
        expect(result.config.threshold).toBe(DEFAULT_CRITIQUE_CONFIG.threshold);
        expect(result.config.maxOverheadMs).toBe(DEFAULT_CRITIQUE_CONFIG.maxOverheadMs);
        expect(result.critiqueProvider).toBeNull();
        expect(result.warnings).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadCritiqueConfig — project layer', () => {
  test('reads [critique] from <cwd>/.agent/config.toml', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
mode = "on_writes"
threshold = 0.85
max_overhead_ms = 5000
prompt_version = "v2"
`,
      );
      const reg = stubRegistry([]);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/nope-no-home-here' },
      });
      expect(result.config.mode).toBe('on_writes');
      expect(result.config.threshold).toBe(0.85);
      expect(result.config.maxOverheadMs).toBe(5000);
      expect(result.config.promptVersion).toBe('v2');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('accepts camelCase aliases (maxOverheadMs / promptVersion)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
mode = "always"
maxOverheadMs = 1500
promptVersion = "v1.1"
`,
      );
      const reg = stubRegistry([]);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/none' },
      });
      expect(result.config.maxOverheadMs).toBe(1500);
      expect(result.config.promptVersion).toBe('v1.1');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadCritiqueConfig — layer merge (project overrides user)', () => {
  test('project field overrides same field from user', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-critique-home-'));
    try {
      mkdirSync(join(home, '.config', 'agent'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'agent', 'config.toml'),
        `
[critique]
mode = "on_writes"
threshold = 0.6
`,
      );
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
threshold = 0.9
`,
      );
      const reg = stubRegistry([]);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: home },
      });
      // Project overrides threshold but inherits mode from user.
      expect(result.config.mode).toBe('on_writes');
      expect(result.config.threshold).toBe(0.9);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loadCritiqueConfig — validation warnings', () => {
  test('invalid mode is rejected with warning, falls back to default', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
mode = "everywhere"
`,
      );
      const reg = stubRegistry([]);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/none' },
      });
      expect(result.config.mode).toBe('off');
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain("mode='everywhere'");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('out-of-range threshold rejected with warning', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
threshold = 1.7
`,
      );
      const reg = stubRegistry([]);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/none' },
      });
      expect(result.config.threshold).toBe(DEFAULT_CRITIQUE_CONFIG.threshold);
      expect(result.warnings[0]).toContain('threshold=1.7');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('malformed TOML produces warning, falls back to defaults', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(join(cwd, '.agent', 'config.toml'), 'this is = not valid toml [\n');
      const reg = stubRegistry([]);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/none' },
      });
      expect(result.config.mode).toBe('off');
      expect(result.warnings[0]).toContain('TOML parse failed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadCritiqueConfig — model resolution', () => {
  test('known model resolves to a critic provider', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
mode = "always"
model = "anthropic/haiku-4-5"
`,
      );
      const reg = stubRegistry(['anthropic/haiku-4-5']);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/none' },
      });
      expect(result.critiqueProvider).not.toBeNull();
      expect(result.critiqueProvider?.id).toBe('anthropic/haiku-4-5');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown model surfaces warning + null provider', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
model = "anthropic/imaginary-future-model"
`,
      );
      const reg = stubRegistry(['anthropic/haiku-4-5']);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/none' },
      });
      expect(result.critiqueProvider).toBeNull();
      expect(result.warnings[0]).toContain('imaginary-future-model');
      expect(result.warnings[0]).toContain('not a known model');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
