import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEMORY_CONFIG,
  loadCritiqueConfig,
  loadMemoryConfig,
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
      // Use a known version so this test stays focused on the
      // camelCase-alias parsing path; version validity is covered
      // by the unknown-prompt_version test in the validation
      // describe block below.
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
mode = "always"
maxOverheadMs = 1500
promptVersion = "v1"
`,
      );
      const reg = stubRegistry([]);
      const result = loadCritiqueConfig({
        cwd,
        registry: reg,
        env: { HOME: '/none' },
      });
      expect(result.config.maxOverheadMs).toBe(1500);
      expect(result.config.promptVersion).toBe('v1');
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

  test('non-string mode (e.g. mode = true) emits a warning, not silent fallback', async () => {
    // The previous behavior: `typeof !== 'string'` skipped the
    // entire block, no warning, mode stayed at default 'off'.
    // Operator who typo'd `mode = true` (forgot quotes) saw NO
    // signal that critique was disabled. Bootstrap path advertises
    // critiqueWarnings on stderr; this test pins that the parser
    // contributes one for present-but-wrong-type values.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
mode = true
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.config.mode).toBe(DEFAULT_CRITIQUE_CONFIG.mode);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('mode=true');
      expect(result.warnings[0]).toContain('must be a string');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-number threshold emits a warning', async () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
threshold = "high"
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.config.threshold).toBe(DEFAULT_CRITIQUE_CONFIG.threshold);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('threshold=');
      expect(result.warnings[0]).toContain('finite number');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-number max_overhead_ms emits a warning naming the snake key', async () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
max_overhead_ms = "fast"
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.config.maxOverheadMs).toBe(DEFAULT_CRITIQUE_CONFIG.maxOverheadMs);
      expect(result.warnings).toHaveLength(1);
      // The warning names the actual key the operator typed, not
      // the camelCase alias — matches the operator's mental model.
      expect(result.warnings[0]).toContain('max_overhead_ms=');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-string prompt_version emits a warning', async () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
prompt_version = 5
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('prompt_version=5');
      expect(result.warnings[0]).toContain('must be a string');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown prompt_version (typo) emits a warning listing known versions', async () => {
    // Operator typed `prompt_version = "v9999"` thinking it's a
    // valid version. Without this warning, the loader accepts the
    // string, the engine silently falls back to default at runtime,
    // and the audit row records the resolved default — leaving NO
    // signal anywhere about the typo. The warning at boot is the
    // operator's only chance to catch it.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
prompt_version = "v9999"
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.config.promptVersion).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("'v9999'");
      expect(result.warnings[0]).toContain('not a known prompt version');
      // Lists the known versions so the operator can pick one.
      expect(result.warnings[0]).toContain('v1');
      expect(result.warnings[0]).toContain('v2');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('known prompt_version is accepted without warning', async () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
prompt_version = "v1"
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.config.promptVersion).toBe('v1');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-string model emits a warning', async () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
model = false
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.critiqueProvider).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('model=false');
      expect(result.warnings[0]).toContain('must be a string');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('empty-string model emits a warning (not silent skip)', async () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[critique]
model = ""
`,
      );
      const result = loadCritiqueConfig({
        cwd,
        registry: stubRegistry([]),
        env: { HOME: '/none' },
      });
      expect(result.critiqueProvider).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('model is empty');
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

// ────────────────────────────────────────────────────────────────────
// MEMORY CONFIG (Slice Q — default-ON inversion + per-project opt-out)
// Same TOML file as [critique]; [memory] section.

describe('loadMemoryConfig — empty layers', () => {
  test('no files anywhere → defaults (all three true) + no warnings + all hadField false', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-mem-home-'));
    try {
      const result = loadMemoryConfig({ cwd, env: { HOME: home } });
      expect(result.config.verifySemanticLlm).toBe(DEFAULT_MEMORY_CONFIG.verifySemanticLlm);
      expect(result.config.conflictDetectLlm).toBe(DEFAULT_MEMORY_CONFIG.conflictDetectLlm);
      expect(result.config.overrideDetectLlm).toBe(DEFAULT_MEMORY_CONFIG.overrideDetectLlm);
      expect(result.config.verifySemanticLlm).toBe(true);
      expect(result.config.conflictDetectLlm).toBe(true);
      expect(result.config.overrideDetectLlm).toBe(true);
      expect(result.userHadField.verifySemanticLlm).toBe(false);
      expect(result.userHadField.conflictDetectLlm).toBe(false);
      expect(result.userHadField.overrideDetectLlm).toBe(false);
      expect(result.projectHadField.verifySemanticLlm).toBe(false);
      expect(result.projectHadField.conflictDetectLlm).toBe(false);
      expect(result.projectHadField.overrideDetectLlm).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loadMemoryConfig — override_detect_llm (S3.5)', () => {
  test('project [memory] override_detect_llm = false → resolved false + hadField true', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
override_detect_llm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.overrideDetectLlm).toBe(false);
      expect(result.projectHadField.overrideDetectLlm).toBe(true);
      // Other two stay at default.
      expect(result.config.verifySemanticLlm).toBe(true);
      expect(result.config.conflictDetectLlm).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('camelCase alias overrideDetectLlm accepted', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
overrideDetectLlm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.overrideDetectLlm).toBe(false);
      expect(result.projectHadField.overrideDetectLlm).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('snake + camel both present emits dual-key warning; snake wins', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
override_detect_llm = false
overrideDetectLlm = true
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.overrideDetectLlm).toBe(false);
      expect(
        result.warnings.some(
          (w) => w.includes('override_detect_llm') && w.includes('overrideDetectLlm'),
        ),
      ).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('user + project override fields merge with project winning', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-mem-home-'));
    try {
      mkdirSync(join(home, '.config', 'agent'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'agent', 'config.toml'),
        `
[memory]
override_detect_llm = true
`,
      );
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
override_detect_llm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: home } });
      expect(result.config.overrideDetectLlm).toBe(false);
      expect(result.userHadField.overrideDetectLlm).toBe(true);
      expect(result.projectHadField.overrideDetectLlm).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loadMemoryConfig — project layer', () => {
  test('project [memory] verify_semantic_llm = false → resolved false + projectHadField true (banner-suppress signal)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
verify_semantic_llm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.verifySemanticLlm).toBe(false);
      expect(result.config.conflictDetectLlm).toBe(true);
      expect(result.projectHadField.verifySemanticLlm).toBe(true);
      expect(result.projectHadField.conflictDetectLlm).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('camelCase aliases (verifySemanticLlm) parsed equivalently', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
verifySemanticLlm = false
conflictDetectLlm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.verifySemanticLlm).toBe(false);
      expect(result.config.conflictDetectLlm).toBe(false);
      expect(result.projectHadField.verifySemanticLlm).toBe(true);
      expect(result.projectHadField.conflictDetectLlm).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadMemoryConfig — validation warnings', () => {
  test('non-boolean value → warning + skip + default retained + hadField false (banner-eligible)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
verify_semantic_llm = "no"
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      // Bad value → ignored → default retained.
      expect(result.config.verifySemanticLlm).toBe(true);
      // hadField stays false → banner still fires (operator never
      // explicitly set the field).
      expect(result.projectHadField.verifySemanticLlm).toBe(false);
      expect(
        result.warnings.some((w) => w.includes('verify_semantic_llm') && w.includes('boolean')),
      ).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('dual-key (snake + camel for same field) emits warning; snake wins', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
verify_semantic_llm = false
verifySemanticLlm = true
conflict_detect_llm = true
conflictDetectLlm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      // snake_case wins for both.
      expect(result.config.verifySemanticLlm).toBe(false);
      expect(result.config.conflictDetectLlm).toBe(true);
      // Two dual-key warnings (one per field).
      const dualKeyWarnings = result.warnings.filter((w) =>
        w.includes('snake_case wins, camelCase ignored'),
      );
      expect(dualKeyWarnings.length).toBe(2);
      expect(dualKeyWarnings.some((w) => w.includes('verify_semantic_llm'))).toBe(true);
      expect(dualKeyWarnings.some((w) => w.includes('conflict_detect_llm'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('single-spelling files do NOT emit dual-key warning', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
verify_semantic_llm = false
conflictDetectLlm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.verifySemanticLlm).toBe(false);
      expect(result.config.conflictDetectLlm).toBe(false);
      expect(result.warnings.some((w) => w.includes('snake_case wins, camelCase ignored'))).toBe(
        false,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('malformed TOML in user → warning, project still parses cleanly', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-mem-home-'));
    try {
      mkdirSync(join(home, '.config', 'agent'), { recursive: true });
      writeFileSync(join(home, '.config', 'agent', 'config.toml'), 'not = valid = toml\n');
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
conflict_detect_llm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: home } });
      expect(result.warnings.some((w) => w.toLowerCase().includes('toml parse failed'))).toBe(true);
      expect(result.config.conflictDetectLlm).toBe(false);
      expect(result.config.verifySemanticLlm).toBe(true); // default retained
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loadMemoryConfig — layer merge (project overrides user)', () => {
  test('user disable + project absent → resolved false, userHadField true (banner-suppress signal)', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-mem-home-'));
    try {
      mkdirSync(join(home, '.config', 'agent'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'agent', 'config.toml'),
        `
[memory]
verify_semantic_llm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: home } });
      expect(result.config.verifySemanticLlm).toBe(false);
      expect(result.userHadField.verifySemanticLlm).toBe(true);
      expect(result.projectHadField.verifySemanticLlm).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('user true + project false → project wins (resolved false)', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-mem-home-'));
    try {
      mkdirSync(join(home, '.config', 'agent'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'agent', 'config.toml'),
        `
[memory]
verify_semantic_llm = true
`,
      );
      mkdirSync(join(cwd, '.agent'), { recursive: true });
      writeFileSync(
        join(cwd, '.agent', 'config.toml'),
        `
[memory]
verify_semantic_llm = false
`,
      );
      const result = loadMemoryConfig({ cwd, env: { HOME: home } });
      expect(result.config.verifySemanticLlm).toBe(false); // project wins
      expect(result.userHadField.verifySemanticLlm).toBe(true);
      expect(result.projectHadField.verifySemanticLlm).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
