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
import { KNOWN_CRITIQUE_PROMPT_VERSIONS } from './prompt.ts';
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

  // Format a value defensively for inclusion in a warning string.
  // JSON.stringify handles objects/arrays/null without throwing on
  // common shapes; the fallback is `String(v)` for the unlikely
  // case of a value that JSON refuses (BigInt, function, circular
  // reference). Operators reading the warning need to recognize
  // what they typed — `mode=true` reads better as "true" than as
  // "[object Object]".
  const fmtBad = (v: unknown): string => {
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  };

  // Validate `mode` only when it's PRESENT in the TOML. A missing
  // field falls through to the default — that's not a misconfig.
  // But a present field with a wrong type (`mode = true`, `mode =
  // 1`, `mode = ["always"]`) used to silently reset to default,
  // which the bootstrap path advertises warnings for and operators
  // expected. Now: any present-but-wrong value emits a warning
  // pointing at the exact field.
  if (c.mode !== undefined) {
    if (typeof c.mode !== 'string') {
      warnings.push(
        `${source} config (${path}): [critique].mode=${fmtBad(c.mode)} must be a string (off|on_writes|always); ignoring`,
      );
    } else if (!VALID_MODES.has(c.mode)) {
      warnings.push(
        `${source} config (${path}): [critique].mode='${c.mode}' is invalid (must be off|on_writes|always); ignoring`,
      );
    } else {
      layer.mode = c.mode as CritiqueMode;
    }
  }

  if (c.threshold !== undefined) {
    if (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold)) {
      warnings.push(
        `${source} config (${path}): [critique].threshold=${fmtBad(c.threshold)} must be a finite number in [0,1]; ignoring`,
      );
    } else if (c.threshold < 0 || c.threshold > 1) {
      warnings.push(
        `${source} config (${path}): [critique].threshold=${c.threshold} out of range [0,1]; ignoring`,
      );
    } else {
      layer.threshold = c.threshold;
    }
  }

  // Accept either snake_case (`max_overhead_ms`, spec §5.4) or
  // camelCase (`maxOverheadMs`, harness API). The TOML convention
  // is snake_case but accepting both lets operators copy-paste from
  // either the spec or the API docs without churn. snake wins on
  // tie (canonical per spec); operator who declared both with
  // different values typed a bug we surface separately.
  const snakeOverhead = c.max_overhead_ms;
  const camelOverhead = c.maxOverheadMs;
  const overhead = snakeOverhead ?? camelOverhead;
  const overheadKey = snakeOverhead !== undefined ? 'max_overhead_ms' : 'maxOverheadMs';
  if (overhead !== undefined) {
    if (typeof overhead !== 'number' || !Number.isFinite(overhead)) {
      warnings.push(
        `${source} config (${path}): [critique].${overheadKey}=${fmtBad(overhead)} must be a non-negative finite number; ignoring`,
      );
    } else if (overhead < 0) {
      warnings.push(
        `${source} config (${path}): [critique].${overheadKey}=${overhead} must be non-negative; ignoring`,
      );
    } else {
      layer.maxOverheadMs = overhead;
    }
  }

  // Same dual-key tolerance for prompt_version / promptVersion.
  const snakePV = c.prompt_version;
  const camelPV = c.promptVersion;
  const promptVersion = snakePV ?? camelPV;
  const pvKey = snakePV !== undefined ? 'prompt_version' : 'promptVersion';
  if (promptVersion !== undefined) {
    if (typeof promptVersion !== 'string') {
      warnings.push(
        `${source} config (${path}): [critique].${pvKey}=${fmtBad(promptVersion)} must be a string; ignoring`,
      );
    } else if (promptVersion.length === 0) {
      warnings.push(`${source} config (${path}): [critique].${pvKey} is empty; ignoring`);
    } else if (!KNOWN_CRITIQUE_PROMPT_VERSIONS.has(promptVersion)) {
      // Unknown version (typo or unshipped). Engine falls back to
      // the default at runtime, but without surfacing the typo
      // here the operator only finds out by digging through audit
      // rows — which themselves now point at the resolved
      // (default) version, hiding the misconfig further. Warn at
      // boot so the typo is visible in stderr.
      const known = [...KNOWN_CRITIQUE_PROMPT_VERSIONS].sort().join(', ');
      warnings.push(
        `${source} config (${path}): [critique].${pvKey}='${promptVersion}' is not a known prompt version (known: ${known}); ignoring`,
      );
    } else {
      layer.promptVersion = promptVersion;
    }
  }

  if (c.model !== undefined) {
    if (typeof c.model !== 'string') {
      warnings.push(
        `${source} config (${path}): [critique].model=${fmtBad(c.model)} must be a string (e.g. 'anthropic/claude-haiku-4-5'); ignoring`,
      );
    } else if (c.model.length === 0) {
      warnings.push(`${source} config (${path}): [critique].model is empty; ignoring`);
    } else {
      layer.model = c.model;
    }
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

// ────────────────────────────────────────────────────────────────────
// MEMORY DETECTOR CONFIG (Slice Q — invert S11/S13 default to ON)
//
// Same TOML file (`.agent/config.toml`), same user+project precedence,
// same fail-soft parse posture as [critique] above. Lives here (and
// not in `src/memory/config-loader.ts`) to reuse `userConfigPath` /
// `projectConfigPath` / fail-soft warnings + Bun.TOML.parse plumbing
// — adding a sibling file would duplicate ~50 lines for no payoff.
// TODO: when a third config consumer surfaces, split into
// `src/config/loader.ts` and re-export from both feature modules.

export interface MemoryConfigKeys {
  // S11 LLM-judge `verify_failed` detector.
  verifySemanticLlm: boolean;
  // S13 LLM-judge `conflict_detected` detector.
  conflictDetectLlm: boolean;
  // S3 LLM-judge `user_override_repeated` detector.
  overrideDetectLlm: boolean;
}

// Inverted default since Slice Q (post-S13) and extended to S3 in
// the S3.5 slice: all three LLM-judge detectors are ON unless an
// operator-or-config layer explicitly disables them. The boot
// banner in bootstrap.ts surfaces this on first-run so an upgrading
// operator isn't surprised when proposals start landing.
export const DEFAULT_MEMORY_CONFIG: MemoryConfigKeys = {
  verifySemanticLlm: true,
  conflictDetectLlm: true,
  overrideDetectLlm: true,
};

// Provenance signal for the boot banner. `false` means the field was
// ABSENT from the layer (default applies); `true` means the layer
// explicitly declared a value (banner suppressed). Distinct from the
// resolved boolean — an operator setting `= true` deliberately should
// still suppress the banner even though the resolved value matches
// the default.
export interface MemoryConfigPresence {
  verifySemanticLlm: boolean;
  conflictDetectLlm: boolean;
  overrideDetectLlm: boolean;
}

export interface LoadedMemoryConfig {
  config: MemoryConfigKeys;
  // Source provenance per field — boot uses these to suppress the
  // first-run banner when ANY layer explicitly named the field.
  userHadField: MemoryConfigPresence;
  projectHadField: MemoryConfigPresence;
  userPath: string | null;
  projectPath: string;
  warnings: string[];
}

interface PartialMemoryLayer {
  verifySemanticLlm?: boolean;
  conflictDetectLlm?: boolean;
  overrideDetectLlm?: boolean;
  hadVerifyField: boolean;
  hadConflictField: boolean;
  hadOverrideField: boolean;
}

const parseMemoryLayer = (
  path: string | null,
  source: string,
): { layer: PartialMemoryLayer; warnings: string[] } => {
  const layer: PartialMemoryLayer = {
    hadVerifyField: false,
    hadConflictField: false,
    hadOverrideField: false,
  };
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
  const section = top.memory;
  if (section === undefined) return { layer, warnings };
  if (section === null || typeof section !== 'object') {
    warnings.push(`${source} config (${path}): [memory] is not a table`);
    return { layer, warnings };
  }
  const m = section as Record<string, unknown>;

  const fmtBad = (v: unknown): string => {
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  };

  // Accept snake_case (TOML idiom) AND camelCase (matches the
  // HarnessConfig field stems, copy-paste friendly). snake wins on
  // tie. Mirror of the [critique] dual-key tolerance above. When
  // BOTH spellings are present the camelCase value is silently
  // dropped — emit a warning so the operator can see which value
  // is authoritative (B-M1 hardening).
  const snakeVerify = m.verify_semantic_llm;
  const camelVerify = m.verifySemanticLlm;
  if (snakeVerify !== undefined && camelVerify !== undefined) {
    warnings.push(
      `${source} config (${path}): [memory] declares both verify_semantic_llm and verifySemanticLlm; snake_case wins, camelCase ignored`,
    );
  }
  const verifyVal = snakeVerify ?? camelVerify;
  const verifyKey = snakeVerify !== undefined ? 'verify_semantic_llm' : 'verifySemanticLlm';
  if (verifyVal !== undefined) {
    if (typeof verifyVal !== 'boolean') {
      warnings.push(
        `${source} config (${path}): [memory].${verifyKey}=${fmtBad(verifyVal)} must be a boolean; ignoring`,
      );
    } else {
      layer.verifySemanticLlm = verifyVal;
      layer.hadVerifyField = true;
    }
  }

  const snakeConflict = m.conflict_detect_llm;
  const camelConflict = m.conflictDetectLlm;
  if (snakeConflict !== undefined && camelConflict !== undefined) {
    warnings.push(
      `${source} config (${path}): [memory] declares both conflict_detect_llm and conflictDetectLlm; snake_case wins, camelCase ignored`,
    );
  }
  const conflictVal = snakeConflict ?? camelConflict;
  const conflictKey = snakeConflict !== undefined ? 'conflict_detect_llm' : 'conflictDetectLlm';
  if (conflictVal !== undefined) {
    if (typeof conflictVal !== 'boolean') {
      warnings.push(
        `${source} config (${path}): [memory].${conflictKey}=${fmtBad(conflictVal)} must be a boolean; ignoring`,
      );
    } else {
      layer.conflictDetectLlm = conflictVal;
      layer.hadConflictField = true;
    }
  }

  // S3 — override_detect_llm. Same shape as verify + conflict.
  const snakeOverride = m.override_detect_llm;
  const camelOverride = m.overrideDetectLlm;
  if (snakeOverride !== undefined && camelOverride !== undefined) {
    warnings.push(
      `${source} config (${path}): [memory] declares both override_detect_llm and overrideDetectLlm; snake_case wins, camelCase ignored`,
    );
  }
  const overrideVal = snakeOverride ?? camelOverride;
  const overrideKey = snakeOverride !== undefined ? 'override_detect_llm' : 'overrideDetectLlm';
  if (overrideVal !== undefined) {
    if (typeof overrideVal !== 'boolean') {
      warnings.push(
        `${source} config (${path}): [memory].${overrideKey}=${fmtBad(overrideVal)} must be a boolean; ignoring`,
      );
    } else {
      layer.overrideDetectLlm = overrideVal;
      layer.hadOverrideField = true;
    }
  }

  return { layer, warnings };
};

export interface LoadMemoryConfigInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export const loadMemoryConfig = (input: LoadMemoryConfigInput): LoadedMemoryConfig => {
  const env = input.env ?? process.env;
  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(input.cwd);

  const userResult = parseMemoryLayer(userPath, 'user');
  const projectResult = parseMemoryLayer(projectPath, 'project');
  const warnings: string[] = [...userResult.warnings, ...projectResult.warnings];

  // Per-field merge (project overrides user). A project file that
  // only sets `verify_semantic_llm = false` leaves `conflictDetectLlm`
  // to inherit from user or default.
  const config: MemoryConfigKeys = {
    verifySemanticLlm:
      projectResult.layer.verifySemanticLlm ??
      userResult.layer.verifySemanticLlm ??
      DEFAULT_MEMORY_CONFIG.verifySemanticLlm,
    conflictDetectLlm:
      projectResult.layer.conflictDetectLlm ??
      userResult.layer.conflictDetectLlm ??
      DEFAULT_MEMORY_CONFIG.conflictDetectLlm,
    overrideDetectLlm:
      projectResult.layer.overrideDetectLlm ??
      userResult.layer.overrideDetectLlm ??
      DEFAULT_MEMORY_CONFIG.overrideDetectLlm,
  };

  return {
    config,
    userHadField: {
      verifySemanticLlm: userResult.layer.hadVerifyField,
      conflictDetectLlm: userResult.layer.hadConflictField,
      overrideDetectLlm: userResult.layer.hadOverrideField,
    },
    projectHadField: {
      verifySemanticLlm: projectResult.layer.hadVerifyField,
      conflictDetectLlm: projectResult.layer.hadConflictField,
      overrideDetectLlm: projectResult.layer.hadOverrideField,
    },
    userPath,
    projectPath,
    warnings,
  };
};
