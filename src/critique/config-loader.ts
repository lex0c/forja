// Operator-facing config loader for self-critique (AGENTIC_CLI.md
// §5.4 lines 519-526). Reads `[critique]` from `config.toml` in two
// layers:
//   1. user:    `~/.config/agent/config.toml` (XDG-honoring, mirrors
//               `userHooksPath` in src/hooks/paths.ts)
//   2. project: `<cwd>/.agent/config.toml` (per-repo, tracked by
//               git when the operator chooses to commit it)
//
// Project overrides user (later layer wins). No enterprise layer in
// Slice C — `[critique]` is opt-in and not security-sensitive (the
// engine is fail-soft per Slice A's guarantees), so the
// hooks-style three-layer hierarchy would be overkill. Add it later
// if a regulated environment needs to lock the mode.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Provider } from '../providers/index.ts';
import type { ModelRegistry } from '../providers/registry.ts';
import { type CritiqueConfig, type CritiqueMode, DEFAULT_CRITIQUE_CONFIG } from './types.ts';

// Resolved config + (optional) critique provider. Bootstrap fans
// these out into HarnessConfig.critique and HarnessConfig.critiqueProvider.
export interface LoadedCritiqueConfig {
  // Merged config (defaults + user layer + project layer). Always
  // present — when no file declared `[critique]`, this is just
  // `DEFAULT_CRITIQUE_CONFIG`.
  config: CritiqueConfig;
  // Resolved critic provider when the config carried a `model =
  // "..."` field that resolved against the registry. Null when no
  // model was declared OR the model id was unknown — the caller
  // (bootstrap) leaves `critiqueProvider` unset so the executor's
  // own provider is reused (per Slice A's fallback in loop.ts).
  critiqueProvider: Provider | null;
  // Per-layer paths consulted; null when the layer was absent or
  // the OS-side env didn't yield a candidate. Audit / debug surface.
  userPath: string | null;
  projectPath: string;
  // Warnings collected during parse. Operator sees these on stderr
  // at boot. Empty when the load was clean. Non-fatal: a malformed
  // `[critique]` block degrades to defaults rather than aborting
  // the run.
  warnings: string[];
}

// User-layer path. Mirrors `userHooksPath` in src/hooks/paths.ts —
// XDG_CONFIG_HOME wins when set + absolute, else `$HOME/.config`.
// Returns null on a stripped-down env where neither yields a usable
// absolute path; the loader treats null as "no user file".
export const userConfigPath = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) {
    return join(xdg, 'agent', 'config.toml');
  }
  const home = env.HOME ?? homedir();
  if (home.length === 0 || !isAbsolute(home)) return null;
  return join(home, '.config', 'agent', 'config.toml');
};

// Project-layer path. Always derivable from cwd; loader treats
// absent file as empty layer.
export const projectConfigPath = (cwd: string): string => join(cwd, '.agent', 'config.toml');

const VALID_MODES: ReadonlySet<string> = new Set(['off', 'on_writes', 'always']);

interface PartialCritiqueLayer {
  mode?: CritiqueMode;
  threshold?: number;
  maxOverheadMs?: number;
  promptVersion?: string;
  model?: string;
}

interface ParseResult {
  layer: PartialCritiqueLayer;
  warnings: string[];
}

// Parse one TOML file's `[critique]` section into a partial layer
// object. Robust against absent file (treated as empty), missing
// section (also empty), and bad values (warning + skip the
// individual field, not the whole layer).
const parseLayer = (path: string | null, source: string): ParseResult => {
  const layer: PartialCritiqueLayer = {};
  const warnings: string[] = [];
  if (path === null) return { layer, warnings };
  if (!existsSync(path)) return { layer, warnings };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    warnings.push(
      `${source} config (${path}) could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { layer, warnings };
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch (err) {
    warnings.push(
      `${source} config (${path}) TOML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { layer, warnings };
  }
  if (parsed === null || typeof parsed !== 'object') return { layer, warnings };
  const top = parsed as Record<string, unknown>;
  const section = top.critique;
  if (section === undefined) return { layer, warnings };
  if (section === null || typeof section !== 'object') {
    warnings.push(`${source} config (${path}): [critique] is not a table`);
    return { layer, warnings };
  }
  const c = section as Record<string, unknown>;

  if (typeof c.mode === 'string') {
    if (VALID_MODES.has(c.mode)) {
      layer.mode = c.mode as CritiqueMode;
    } else {
      warnings.push(
        `${source} config (${path}): [critique].mode='${c.mode}' is invalid (must be off|on_writes|always); ignoring`,
      );
    }
  }
  if (typeof c.threshold === 'number' && Number.isFinite(c.threshold)) {
    if (c.threshold >= 0 && c.threshold <= 1) {
      layer.threshold = c.threshold;
    } else {
      warnings.push(
        `${source} config (${path}): [critique].threshold=${c.threshold} out of range [0,1]; ignoring`,
      );
    }
  }
  // Accept either snake_case (`max_overhead_ms`, spec §5.4) or
  // camelCase (`maxOverheadMs`, harness API). The TOML convention
  // is snake_case but accepting both lets operators copy-paste from
  // either the spec or the API docs without churn.
  const overhead = c.max_overhead_ms ?? c.maxOverheadMs;
  if (typeof overhead === 'number' && Number.isFinite(overhead)) {
    if (overhead >= 0) {
      layer.maxOverheadMs = overhead;
    } else {
      warnings.push(
        `${source} config (${path}): [critique].max_overhead_ms=${overhead} must be non-negative; ignoring`,
      );
    }
  }
  // Same dual-key tolerance for prompt_version / promptVersion.
  const promptVersion = c.prompt_version ?? c.promptVersion;
  if (typeof promptVersion === 'string' && promptVersion.length > 0) {
    layer.promptVersion = promptVersion;
  }
  if (typeof c.model === 'string' && c.model.length > 0) {
    layer.model = c.model;
  }
  return { layer, warnings };
};

// Top-level loader. Builds the resolved config, resolves the model
// against the registry when declared, and surfaces warnings.
export interface LoadCritiqueConfigInput {
  cwd: string;
  registry: ModelRegistry;
  env?: NodeJS.ProcessEnv;
  // Provider factory options forwarded to `entry.factory()`. The
  // executor's bootstrap omits this (uses defaults); the critic
  // path inherits the same shape so a single API key surface is
  // enough for both. Undefined ⇒ factory() called with no args.
  factoryOptions?: unknown;
}

export const loadCritiqueConfig = (input: LoadCritiqueConfigInput): LoadedCritiqueConfig => {
  const env = input.env ?? process.env;
  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(input.cwd);

  const userResult = parseLayer(userPath, 'user');
  const projectResult = parseLayer(projectPath, 'project');
  const warnings: string[] = [...userResult.warnings, ...projectResult.warnings];

  // Layer merge: project overrides user, both override defaults.
  // Per-field merge (not whole-object) so a project file that only
  // tweaks `threshold` keeps the user-level mode in effect.
  const merged: PartialCritiqueLayer = { ...userResult.layer, ...projectResult.layer };

  const config: CritiqueConfig = {
    mode: merged.mode ?? DEFAULT_CRITIQUE_CONFIG.mode,
    threshold: merged.threshold ?? DEFAULT_CRITIQUE_CONFIG.threshold,
    maxOverheadMs: merged.maxOverheadMs ?? DEFAULT_CRITIQUE_CONFIG.maxOverheadMs,
    ...(merged.promptVersion !== undefined ? { promptVersion: merged.promptVersion } : {}),
  };

  // Resolve the model against the registry when declared. An
  // unknown id surfaces as a warning + null provider — the loop
  // falls back to the executor's provider (Slice A's fallback at
  // loop.ts where `critiqueProvider ?? config.provider`).
  let critiqueProvider: Provider | null = null;
  if (merged.model !== undefined) {
    const entry = input.registry.get(merged.model);
    if (entry === null) {
      warnings.push(
        `[critique].model='${merged.model}' is not a known model; falling back to the executor provider. Known: ${input.registry
          .list()
          .map((e) => e.id)
          .join(', ')}`,
      );
    } else {
      try {
        critiqueProvider = entry.factory(input.factoryOptions);
      } catch (err) {
        warnings.push(
          `[critique].model='${merged.model}' factory failed: ${err instanceof Error ? err.message : String(err)}; falling back to the executor provider`,
        );
      }
    }
  }

  return {
    config,
    critiqueProvider,
    userPath,
    projectPath,
    warnings,
  };
};
