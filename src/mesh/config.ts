// [mesh] section loader — same shape as the config.toml section loaders
// (memory/budget), via loadTomlSection. Fail-soft: a bad value warns and falls
// back to the default; the loader clamps to ABSOLUTE_MESH_LIMITS so a typo'd
// config can't lift the mesh past the ceilings. See docs/spec/MESH.md §10.

import { basename, join } from 'node:path';
import { loadTomlSection } from '../config/section.ts';
import {
  ABSOLUTE_MESH_LIMITS,
  ALIAS_MAX,
  ALIAS_RE,
  DEFAULT_MESH_CONFIG,
  type MeshConfig,
} from './types.ts';

export interface LoadedMeshConfig {
  config: MeshConfig;
  warnings: string[];
}

export interface LoadMeshConfigInput {
  cwd: string;
  // Test seam (mirrors the mcp loader): override the config.toml path.
  // null ⇒ no file (defaults); undefined ⇒ resolve from cwd.
  configPathOverride?: string | null;
}

const MESH_KEYS = new Set(['alias', 'max_message_bytes']);

const clampInt = (
  v: unknown,
  def: number,
  max: number,
  key: string,
  warnings: string[],
): number => {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    warnings.push(`[mesh] ${key} must be a positive integer; using ${def}`);
    return def;
  }
  if (v > max) {
    warnings.push(`[mesh] ${key}=${v} exceeds the ceiling ${max}; clamped`);
    return max;
  }
  return v;
};

export const loadMeshConfig = (input: LoadMeshConfigInput): LoadedMeshConfig => {
  const warnings: string[] = [];
  const config: MeshConfig = { ...DEFAULT_MESH_CONFIG };

  const path =
    input.configPathOverride === undefined
      ? join(input.cwd, '.forja', 'config.toml')
      : input.configPathOverride;

  const res = loadTomlSection(path, 'mesh', 'mesh');
  if (res.kind === 'invalid') warnings.push(res.warning);
  if (res.kind !== 'found') return { config, warnings };

  const section = res.section;
  for (const key of Object.keys(section)) {
    if (!MESH_KEYS.has(key)) warnings.push(`[mesh] unknown key '${key}' ignored`);
  }

  const alias = section.alias;
  if (alias !== undefined) {
    if (typeof alias !== 'string' || !ALIAS_RE.test(alias) || alias.length > ALIAS_MAX) {
      warnings.push(
        `[mesh] alias must be a lowercase word (≤${ALIAS_MAX} chars); deriving from repo`,
      );
    } else {
      config.alias = alias;
    }
  }
  config.maxMessageBytes = clampInt(
    section.max_message_bytes,
    DEFAULT_MESH_CONFIG.maxMessageBytes,
    ABSOLUTE_MESH_LIMITS.maxMessageBytes,
    'max_message_bytes',
    warnings,
  );

  return { config, warnings };
};

// Resolve the effective alias: explicit config alias, else the repo-root
// basename sanitized to the alias grammar (falls back to `forja`).
export const resolveAlias = (config: MeshConfig, repoRoot: string): string => {
  if (config.alias !== null) return config.alias;
  const sanitized = basename(repoRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z]+/, '');
  const trimmed = sanitized.slice(0, ALIAS_MAX);
  return trimmed.length > 0 ? trimmed : 'forja';
};
