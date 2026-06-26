import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEMORY_CONFIG,
  loadBudgetConfig,
  loadEffortConfig,
  loadMemoryConfig,
  loadProvidersConfig,
  loadRecapConfig,
  loadSandboxConfig,
  projectConfigPath,
  userConfigPath,
} from '../../src/config/loaders.ts';
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

const makeTempCwd = (): string => mkdtempSync(join(tmpdir(), 'forja-config-cfg-'));

describe('userConfigPath / projectConfigPath', () => {
  test('XDG_CONFIG_HOME wins when set + absolute', () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' })).toBe(
      '/xdg/forja/config.toml',
    );
  });

  test('falls back to $HOME/.config when XDG is missing', () => {
    expect(userConfigPath({ HOME: '/home/u' })).toBe('/home/u/.config/forja/config.toml');
  });

  test('non-absolute XDG falls through to HOME-based path', () => {
    // Non-absolute XDG_CONFIG_HOME is treated as if the var were
    // unset (security: a relative XDG could shadow user files via
    // path traversal). Falls through to $HOME/.config.
    expect(userConfigPath({ XDG_CONFIG_HOME: 'rel/path', HOME: '/home/u' })).toBe(
      '/home/u/.config/forja/config.toml',
    );
  });

  test('projectConfigPath always derivable from cwd', () => {
    expect(projectConfigPath('/repo')).toBe('/repo/.forja/config.toml');
  });
});

// ────────────────────────────────────────────────────────────────────
// MEMORY CONFIG (Slice Q — default-ON inversion + per-project opt-out)
// Shared config.toml; [memory] section.

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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'forja', 'config.toml'),
        `
[memory]
override_detect_llm = true
`,
      );
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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

describe('loadMemoryConfig — proactive_inject (§4.4)', () => {
  test('absent → defaults ON (true) + hadField false, detectors unaffected', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-mem-home-'));
    try {
      const result = loadMemoryConfig({ cwd, env: { HOME: home } });
      // §4.4 default ON after the calibration gate cleared.
      expect(result.config.proactiveInject).toBe(true);
      expect(result.config.proactiveInject).toBe(DEFAULT_MEMORY_CONFIG.proactiveInject);
      expect(result.userHadField.proactiveInject).toBe(false);
      expect(result.projectHadField.proactiveInject).toBe(false);
      // Detectors also ON by default.
      expect(result.config.verifySemanticLlm).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('project [memory] proactive_inject = true → resolved true + projectHadField true', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), '\n[memory]\nproactive_inject = true\n');
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.proactiveInject).toBe(true);
      expect(result.projectHadField.proactiveInject).toBe(true);
      // Detectors untouched by the proactive key.
      expect(result.config.verifySemanticLlm).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('camelCase alias proactiveInject accepted', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), '\n[memory]\nproactiveInject = true\n');
      const result = loadMemoryConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.proactiveInject).toBe(true);
      expect(result.projectHadField.proactiveInject).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('user enables, project disables → project wins (precedence)', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-mem-home-'));
    try {
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'forja', 'config.toml'),
        '\n[memory]\nproactive_inject = true\n',
      );
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), '\n[memory]\nproactive_inject = false\n');
      const result = loadMemoryConfig({ cwd, env: { HOME: home } });
      expect(result.config.proactiveInject).toBe(false);
      expect(result.userHadField.proactiveInject).toBe(true);
      expect(result.projectHadField.proactiveInject).toBe(true);
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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(join(home, '.config', 'forja', 'config.toml'), 'not = valid = toml\n');
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'forja', 'config.toml'),
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
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'forja', 'config.toml'),
        `
[memory]
verify_semantic_llm = true
`,
      );
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
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

describe('loadRecapConfig', () => {
  const writeProjectRecap = (cwd: string, body: string): void => {
    mkdirSync(join(cwd, '.forja'), { recursive: true });
    writeFileSync(join(cwd, '.forja', 'config.toml'), body);
  };

  test('returns empty config + no warnings when no [recap] section', () => {
    const cwd = makeTempCwd();
    try {
      const result = loadRecapConfig({ cwd, registry: stubRegistry([]), env: { HOME: '/none' } });
      expect(result.config.renderModel).toBeUndefined();
      expect(result.config.enabled).toBeUndefined();
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reads render_model + enabled and validates render_model against the registry', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectRecap(
        cwd,
        '[recap]\nrender_model = "anthropic/claude-haiku-4-5"\nenabled = false\n',
      );
      const reg = stubRegistry(['anthropic/claude-haiku-4-5']);
      const result = loadRecapConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.renderModel).toBe('anthropic/claude-haiku-4-5');
      expect(result.config.enabled).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown render_model warns and is ignored', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectRecap(cwd, '[recap]\nrender_model = "anthropic/typo"\n');
      const reg = stubRegistry(['anthropic/claude-haiku-4-5']);
      const result = loadRecapConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.renderModel).toBeUndefined();
      expect(result.warnings[0]).toContain('not a known model');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-boolean enabled warns and is ignored', () => {
    const cwd = makeTempCwd();
    try {
      writeProjectRecap(cwd, '[recap]\nenabled = "yes"\n');
      const result = loadRecapConfig({ cwd, registry: stubRegistry([]), env: { HOME: '/none' } });
      expect(result.config.enabled).toBeUndefined();
      expect(result.warnings[0]).toContain('must be a boolean');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadProvidersConfig', () => {
  test('returns null model when no layer declared [providers]', () => {
    const cwd = makeTempCwd();
    try {
      const reg = stubRegistry([]);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.model).toBeUndefined();
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reads [providers].model from project config and validates against the registry', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[providers]
model = "anthropic/claude-opus-4-7"
`,
      );
      const reg = stubRegistry(['anthropic/claude-opus-4-7']);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.model).toBe('anthropic/claude-opus-4-7');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('BOM-prefixed project config still yields [providers].model (regression)', () => {
    // A config.toml a Windows editor saved with a UTF-8 BOM must NOT read
    // as empty — otherwise the boot reader ignores the pinned model and
    // falls back to DEFAULT_MODEL. loadTomlSection strips the BOM, so the
    // model an operator pinned (incl. a `--model <same>` that left the BOM
    // in place via the `unchanged` short-circuit) resolves on next boot.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        '﻿[providers]\nmodel = "anthropic/claude-opus-4-7"\n',
      );
      const reg = stubRegistry(['anthropic/claude-opus-4-7']);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.model).toBe('anthropic/claude-opus-4-7');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown model id warns and degrades to null (caller falls back to DEFAULT_MODEL)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[providers]
model = "anthropic/typo-model"
`,
      );
      const reg = stubRegistry(['anthropic/claude-opus-4-7']);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.model).toBeUndefined();
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('not a known model');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-string model warns and ignores', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[providers]
model = 42
`,
      );
      const reg = stubRegistry(['anthropic/claude-opus-4-7']);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.model).toBeUndefined();
      expect(result.warnings[0]).toContain('must be a string');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('empty model string warns and ignores', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[providers]
model = ""
`,
      );
      const reg = stubRegistry(['anthropic/claude-opus-4-7']);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.model).toBeUndefined();
      expect(result.warnings[0]).toContain('is empty');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('project overrides user', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-providers-home-'));
    try {
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'forja', 'config.toml'),
        '[providers]\nmodel = "anthropic/claude-haiku-4-5"\n',
      );
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        '[providers]\nmodel = "anthropic/claude-opus-4-7"\n',
      );
      const reg = stubRegistry(['anthropic/claude-haiku-4-5', 'anthropic/claude-opus-4-7']);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: home } });
      expect(result.config.model).toBe('anthropic/claude-opus-4-7');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('[providers] not a table warns and degrades', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), 'providers = "oops"\n');
      const reg = stubRegistry([]);
      const result = loadProvidersConfig({ cwd, registry: reg, env: { HOME: '/none' } });
      expect(result.config.model).toBeUndefined();
      expect(result.warnings[0]).toContain('not a table');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadBudgetConfig', () => {
  test('returns empty config when no layer declared [budget]', () => {
    const cwd = makeTempCwd();
    try {
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config).toEqual({});
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reads all six [budget] keys from project config', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
max_steps = 50
max_cost_usd = 0.5
max_wall_clock_ms = 60000
max_step_stall_ms = 30000
compaction_threshold = 0.8
compaction_preserve_tail = 5
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config).toEqual({
        maxSteps: 50,
        maxCostUsd: 0.5,
        maxWallClockMs: 60000,
        maxStepStallMs: 30000,
        compactionThreshold: 0.8,
        compactionPreserveTail: 5,
      });
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('integer fields reject non-integer values', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
max_steps = 200.5
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.maxSteps).toBeUndefined();
      expect(result.warnings[0]).toContain('must be an integer');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('float fields accept decimals (compaction_threshold = 0.65)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_threshold = 0.65
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionThreshold).toBe(0.65);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('compaction_max_tokens parses as a positive integer; out-of-range is rejected', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      // The operator-facing knob that was eval-only before: a real config now
      // raises the compaction summary cap.
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_max_tokens = 4096
`,
      );
      const ok = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(ok.config.compactionMaxTokens).toBe(4096);
      expect(ok.warnings).toEqual([]);

      // 0 is below the min (1) — a 0-token summary is degenerate.
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_max_tokens = 0
`,
      );
      const bad = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(bad.config.compactionMaxTokens).toBeUndefined();
      expect(bad.warnings[0]).toContain('out of range');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('compaction_threshold = 0 accepted (compact every step, lower endpoint)', () => {
    // Endpoint pin: a future tightening to (0, 1) open interval
    // would forbid the legitimate "always compact" sentinel — the
    // runtime treats `usagePct >= 0` as always true.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_threshold = 0
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionThreshold).toBe(0);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('compaction_threshold = 1 accepted (effectively disable, upper endpoint)', () => {
    // Endpoint pin: `usagePct >= 1` never fires in practice
    // (context-window math doesn't reach exactly 100%), so 1.0 is
    // the natural "disable compaction" sentinel.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_threshold = 1
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionThreshold).toBe(1);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('compaction_relevance = false parses (production opt-out for the relevance pre-pass)', () => {
    // The pre-pass is default-ON (DEFAULT_BUDGET.compactionRelevance); this is
    // the CLI opt-out. Before this key was wired it was silently ignored —
    // only eval YAML could disable it.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_relevance = false
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionRelevance).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('compaction_trigger_refine = true parses (experimental opt-in for the #3 refine)', () => {
    // Default-OFF in DEFAULT_BUDGET; this is the config opt-in so an operator (or
    // a measurement run) can enable the experimental real-tokenizer trigger refine.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_trigger_refine = true
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionTriggerRefine).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-boolean compaction_relevance warns and is ignored (fail-soft)', () => {
    // The common footgun is quoting the bool (`"false"`), which TOML parses as
    // a string. Reject it loudly rather than silently treating it as truthy.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_relevance = "false"
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionRelevance).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('must be a boolean'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('camelCase compactionRelevance is accepted (no snake key present)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compactionRelevance = false
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionRelevance).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('both compaction_relevance spellings: snake_case wins and the conflict warns', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_relevance = false
compactionRelevance = true
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionRelevance).toBe(false); // snake wins
      expect(result.warnings.some((w) => w.includes('snake_case wins, camelCase ignored'))).toBe(
        true,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('max_step_stall_ms = 0 accepted (runtime opt-out for the per-step watchdog)', () => {
    // Runtime contract (`src/harness/abortable.ts:68`): `stallMs
    // <= 0` disables the per-step watchdog entirely — yields the
    // source verbatim with no timer. Operators running long
    // steady-streaming provider calls legitimately need to opt
    // out. The validator's min must match the runtime semantic;
    // otherwise config can't express what the engine supports.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
max_step_stall_ms = 0
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.maxStepStallMs).toBe(0);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('max_steps = 0 still rejected (no documented disable semantic)', () => {
    // Sibling pin: max_steps and max_wall_clock_ms keep min=1 since
    // 0 there means "abort immediately", not "no cap". Operator who
    // types 0 expecting "unlimited" gets a warning, not a session
    // that aborts on turn 1.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
max_steps = 0
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.maxSteps).toBeUndefined();
      expect(result.warnings[0]).toContain('out of range');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('out-of-range values warn and ignore (max_cost_usd = -1)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
max_cost_usd = -1
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.maxCostUsd).toBeUndefined();
      expect(result.warnings[0]).toContain('out of range');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('out-of-range compaction_threshold = 1.5 warns', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
compaction_threshold = 1.5
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.compactionThreshold).toBeUndefined();
      expect(result.warnings[0]).toContain('out of range');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-number value warns (max_steps = "200")', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
max_steps = "200"
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.maxSteps).toBeUndefined();
      expect(result.warnings[0]).toContain('must be a finite number');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('declares both snake_case and camelCase → warning, snake wins', () => {
    // Mirror of the existing dual-key warning in the other
    // config loaders. Operator who writes both flavors gets a
    // diagnostic naming both keys; snake_case is the spec-canonical
    // form and its value lands.
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
max_steps = 100
maxSteps = 200
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.maxSteps).toBe(100); // snake wins
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('declares both max_steps and maxSteps');
      expect(result.warnings[0]).toContain('snake_case wins');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('accepts camelCase aliases (maxSteps, maxCostUsd, ...)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(
        join(cwd, '.forja', 'config.toml'),
        `
[budget]
maxSteps = 75
maxCostUsd = 1.5
`,
      );
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config.maxSteps).toBe(75);
      expect(result.config.maxCostUsd).toBe(1.5);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('project overrides user per-key (user max_steps=300, project max_cost_usd=2)', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-budget-home-'));
    try {
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(join(home, '.config', 'forja', 'config.toml'), '[budget]\nmax_steps = 300\n');
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), '[budget]\nmax_cost_usd = 2\n');
      const result = loadBudgetConfig({ cwd, env: { HOME: home } });
      // Per-key merge: user's max_steps survives because project
      // didn't touch it; project's max_cost_usd lands.
      expect(result.config.maxSteps).toBe(300);
      expect(result.config.maxCostUsd).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('[budget] not a table warns', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), 'budget = 42\n');
      const result = loadBudgetConfig({ cwd, env: { HOME: '/none' } });
      expect(result.config).toEqual({});
      expect(result.warnings[0]).toContain('not a table');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadEffortConfig', () => {
  test('no [effort] → undefined effort (bootstrap applies DEFAULT_EFFORT)', () => {
    const cwd = makeTempCwd();
    try {
      const result = loadEffortConfig({ cwd, env: { HOME: '/none' } });
      expect(result.effort).toBeUndefined();
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('reads [effort].level from project config', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), '[effort]\nlevel = "low"\n');
      const result = loadEffortConfig({ cwd, env: { HOME: '/none' } });
      expect(result.effort).toBe('low');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('level is case-insensitive (matches /effort)', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), '[effort]\nlevel = "High"\n');
      const result = loadEffortConfig({ cwd, env: { HOME: '/none' } });
      expect(result.effort).toBe('high');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown level warns and is ignored', () => {
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      // `ultra` is not a ForjaEffort (the ladder is low|medium|high|xhigh|max).
      writeFileSync(join(cwd, '.forja', 'config.toml'), '[effort]\nlevel = "ultra"\n');
      const result = loadEffortConfig({ cwd, env: { HOME: '/none' } });
      expect(result.effort).toBeUndefined();
      expect(result.warnings[0]).toContain('must be one of');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('project level overrides user', () => {
    const cwd = makeTempCwd();
    const home = mkdtempSync(join(tmpdir(), 'forja-effort-home-'));
    try {
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(join(home, '.config', 'forja', 'config.toml'), '[effort]\nlevel = "low"\n');
      mkdirSync(join(cwd, '.forja'), { recursive: true });
      writeFileSync(join(cwd, '.forja', 'config.toml'), '[effort]\nlevel = "max"\n');
      const result = loadEffortConfig({ cwd, env: { HOME: home } });
      expect(result.effort).toBe('max');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loadSandboxConfig — [sandbox] writable_cache_dirs', () => {
  const writeProject = (cwd: string, toml: string): void => {
    mkdirSync(join(cwd, '.forja'), { recursive: true });
    writeFileSync(join(cwd, '.forja', 'config.toml'), toml);
  };

  test('absent section → no override (undefined), no warnings', () => {
    const cwd = makeTempCwd();
    try {
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.writableCacheDirs).toBeUndefined();
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('valid list is kept verbatim', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\nwritable_cache_dirs = [".cache", "go/pkg/mod"]\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.writableCacheDirs).toEqual(['.cache', 'go/pkg/mod']);
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('explicit empty array is preserved (disables the carve-out)', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\nwritable_cache_dirs = []\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.writableCacheDirs).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unsafe entries (absolute / parent-escape) are dropped with warnings; valid kept', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\nwritable_cache_dirs = ["/etc", "../escape", ".cache"]\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.writableCacheDirs).toEqual(['.cache']);
      expect(r.warnings.length).toBe(2);
      // Warning carries the source/path prefix for operator triage.
      expect(r.warnings.every((w) => w.includes('config ('))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-array value → falls back to DEFAULT (undefined) + warning, NOT disabled', () => {
    // A type error (string instead of array) must NOT collapse to the
    // carve-out-disabled `[]` sentinel — that would silently break builds
    // over a typo. Fail-soft contract: leave the field unset → DEFAULT.
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\nwritable_cache_dirs = ".cache"\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.writableCacheDirs).toBeUndefined();
      expect(r.warnings.length).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('array with ALL entries invalid → falls back to DEFAULT (undefined), warns each', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\nwritable_cache_dirs = ["/usr", "../etc"]\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      // Not `[]` (that's reserved for a LITERAL empty array = disable).
      expect(r.config.writableCacheDirs).toBeUndefined();
      expect(r.warnings.length).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('project layer overrides user layer', () => {
    const home = mkdtempSync(join(tmpdir(), 'forja-sbx-home-'));
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'forja', 'config.toml'),
        '[sandbox]\nwritable_cache_dirs = [".npm"]\n',
      );
      writeProject(cwd, '[sandbox]\nwritable_cache_dirs = [".cargo"]\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: home } });
      expect(r.config.writableCacheDirs).toEqual(['.cargo']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loadSandboxConfig — [sandbox] cache_persistence + shared_tmp', () => {
  const writeProject = (cwd: string, toml: string): void => {
    mkdirSync(join(cwd, '.forja'), { recursive: true });
    writeFileSync(join(cwd, '.forja', 'config.toml'), toml);
  };

  test('absent → both undefined (default off), no warnings', () => {
    const cwd = makeTempCwd();
    try {
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.cachePersistence).toBeUndefined();
      expect(r.config.sharedTmp).toBeUndefined();
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('cache_persistence=true / shared_tmp=true are parsed', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\ncache_persistence = true\nshared_tmp = true\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.cachePersistence).toBe(true);
      expect(r.config.sharedTmp).toBe(true);
      expect(r.warnings).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('explicit false is preserved (not collapsed to undefined)', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\ncache_persistence = false\nshared_tmp = false\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.cachePersistence).toBe(false);
      expect(r.config.sharedTmp).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-boolean → ignored with warning (stays undefined → off)', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\ncache_persistence = "yes"\nshared_tmp = 1\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.cachePersistence).toBeUndefined();
      expect(r.config.sharedTmp).toBeUndefined();
      expect(r.warnings.length).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('coexists with writable_cache_dirs', () => {
    const cwd = makeTempCwd();
    try {
      writeProject(cwd, '[sandbox]\nwritable_cache_dirs = [".npm"]\ncache_persistence = true\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: '/none' } });
      expect(r.config.writableCacheDirs).toEqual(['.npm']);
      expect(r.config.cachePersistence).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The `??` merge must let an explicit project `false` beat a user
  // `true` (false is not nullish) — project-wins AND tri-state together.
  test('project explicit false beats user true', () => {
    const home = mkdtempSync(join(tmpdir(), 'forja-sbx2-home-'));
    const cwd = makeTempCwd();
    try {
      mkdirSync(join(home, '.config', 'forja'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'forja', 'config.toml'),
        '[sandbox]\ncache_persistence = true\n',
      );
      writeProject(cwd, '[sandbox]\ncache_persistence = false\n');
      const r = loadSandboxConfig({ cwd, env: { HOME: home } });
      expect(r.config.cachePersistence).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
