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

import { projectConfigPath, userConfigPath } from '../config/paths.ts';
import { loadTomlSection } from '../config/section.ts';
import type { Provider } from '../providers/index.ts';
import type { ModelRegistry } from '../providers/registry.ts';
import { KNOWN_CRITIQUE_PROMPT_VERSIONS } from './prompt.ts';
import { type CritiqueConfig, type CritiqueMode, DEFAULT_CRITIQUE_CONFIG } from './types.ts';

// Re-export shared path helpers so existing import sites (critique/
// index.ts, tests/critique/config-loader.test.ts, etc.) keep working
// without churn. New code should prefer importing from
// `src/config/paths.ts` directly.
export { projectConfigPath, userConfigPath };

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
// individual field, not the whole layer). Shared file/parse/section
// plumbing lives in `src/config/section.ts` (`loadTomlSection`).
const parseLayer = (path: string | null, source: string): ParseResult => {
  const layer: PartialCritiqueLayer = {};
  const warnings: string[] = [];
  const section = loadTomlSection(path, 'critique', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { layer, warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { layer, warnings };
  }
  const c = section.section;

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
  const section = loadTomlSection(path, 'memory', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { layer, warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { layer, warnings };
  }
  const m = section.section;

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

// ────────────────────────────────────────────────────────────────────
// PROVIDERS CONFIG (AGENTIC_CLI.md §2.1.1)
//
// `[providers] model = "..."` pins the executor model per-project.
// Resolution chain (bootstrap consumes via `loadProvidersConfig`):
//
//   CLI flag (--model)  >  project [providers].model
//                       >  user    [providers].model
//                       >  DEFAULT_MODEL (in bootstrap.ts)
//
// Unknown model id ⇒ warning + null (the caller falls back to
// DEFAULT_MODEL). Same fail-soft posture as [critique].model.

export interface ProvidersConfigKeys {
  // Fully-qualified model id, e.g. "anthropic/claude-opus-4-7".
  // Absent (rather than `null`) when no layer declared the field —
  // matches the per-field-optional convention used by
  // BudgetConfigKeys and CritiqueConfig.promptVersion. Bootstrap
  // consumes via `?? DEFAULT_MODEL` so both undefined and null
  // would work, but the optional shape keeps the field shape
  // consistent across loaders.
  model?: string;
}

export interface LoadedProvidersConfig {
  config: ProvidersConfigKeys;
  userPath: string | null;
  projectPath: string;
  warnings: string[];
}

interface PartialProvidersLayer {
  model?: string;
}

const parseProvidersLayer = (
  path: string | null,
  source: string,
  registry: ModelRegistry,
): { layer: PartialProvidersLayer; warnings: string[] } => {
  const layer: PartialProvidersLayer = {};
  const warnings: string[] = [];
  const section = loadTomlSection(path, 'providers', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { layer, warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { layer, warnings };
  }
  const p = section.section;
  if (p.model !== undefined) {
    if (typeof p.model !== 'string') {
      warnings.push(
        `${source} config (${path}): [providers].model must be a string (got ${typeof p.model}); ignoring`,
      );
    } else if (p.model.length === 0) {
      warnings.push(`${source} config (${path}): [providers].model is empty; ignoring`);
    } else if (registry.get(p.model) === null) {
      warnings.push(
        `${source} config (${path}): [providers].model='${p.model}' is not a known model; ignoring. Known: ${registry
          .list()
          .map((e) => e.id)
          .join(', ')}`,
      );
    } else {
      layer.model = p.model;
    }
  }
  return { layer, warnings };
};

export interface LoadProvidersConfigInput {
  cwd: string;
  registry: ModelRegistry;
  env?: NodeJS.ProcessEnv;
}

export const loadProvidersConfig = (input: LoadProvidersConfigInput): LoadedProvidersConfig => {
  const env = input.env ?? process.env;
  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(input.cwd);

  const userResult = parseProvidersLayer(userPath, 'user', input.registry);
  const projectResult = parseProvidersLayer(projectPath, 'project', input.registry);
  const warnings: string[] = [...userResult.warnings, ...projectResult.warnings];

  // Per-field merge — project overrides user. Only one field today
  // (`model`), but the merge shape stays consistent with the other
  // loaders so a future `[providers].api_key_env` etc. drops in
  // without restructuring. Field omitted entirely when no layer
  // declared it (matches BudgetConfigKeys convention).
  const config: ProvidersConfigKeys = {};
  const resolvedModel = projectResult.layer.model ?? userResult.layer.model;
  if (resolvedModel !== undefined) config.model = resolvedModel;

  return { config, userPath, projectPath, warnings };
};

// ────────────────────────────────────────────────────────────────────
// BUDGET CONFIG (AGENTIC_CLI.md §2.1.1)
//
// `[budget]` overrides DEFAULT_BUDGET per-project. Resolution chain
// mirrors [providers]:
//
//   CLI flag  >  project [budget].<key>
//             >  user    [budget].<key>
//             >  DEFAULT_BUDGET.<key> in src/harness/types.ts
//
// Per-key merge — a layer that only sets `max_cost_usd` leaves
// the other fields to the next layer down. Validators reject
// out-of-range / wrong-type values with a warning + ignore
// (same fail-soft posture as [critique] / [memory]).

export interface BudgetConfigKeys {
  maxSteps?: number;
  maxCostUsd?: number;
  maxWallClockMs?: number;
  maxStepStallMs?: number;
  compactionThreshold?: number;
  compactionPreserveTail?: number;
}

export interface LoadedBudgetConfig {
  config: BudgetConfigKeys;
  userPath: string | null;
  projectPath: string;
  warnings: string[];
}

interface PartialBudgetLayer extends BudgetConfigKeys {}

// Integer-valued budget keys with sanity-check ranges.
//
// The max values are deliberately permissive — they catch "the
// operator typed a wildly wrong number" (negative cost, 10x the
// realistic upper bound) without forbidding legitimate use cases.
// DEFAULT_BUDGET (in src/harness/types.ts) sits well inside each
// range. Each ceiling is justified inline:
//
//   max_steps: 1M — runaway-loop backstop; a long refactor at 1k
//     steps is plausible, anything >>1k means the loop never
//     converges. 1M is "obviously a typo" rather than "tight cap".
//   max_wall_clock_ms: 24h — overnight CI runs are legitimate;
//     anything beyond a day is operator error.
//   max_step_stall_ms: 1h — single step taking >1h to produce
//     output is "stuck" by any reasonable definition; the default
//     of 90s is what catches genuine hangs.
//   compaction_preserve_tail: 1000 — preserving more than 1k
//     turns verbatim defeats the purpose of compaction.
const BUDGET_INT_KEYS: ReadonlyArray<{
  snake: string;
  camel: keyof BudgetConfigKeys;
  min: number;
  max: number;
}> = [
  { snake: 'max_steps', camel: 'maxSteps', min: 1, max: 1_000_000 },
  { snake: 'max_wall_clock_ms', camel: 'maxWallClockMs', min: 1, max: 24 * 60 * 60 * 1000 },
  { snake: 'max_step_stall_ms', camel: 'maxStepStallMs', min: 1, max: 60 * 60 * 1000 },
  // compactionPreserveTail = 0 is intentional (aggressive
  // compaction: drop everything except the system prompt) — the
  // min is 0, not 1.
  { snake: 'compaction_preserve_tail', camel: 'compactionPreserveTail', min: 0, max: 1000 },
];

// Float-valued budget keys. Same sanity-check posture as integers.
//
//   max_cost_usd: 1M — pathological-typo guard; real budgets are
//     orders of magnitude below. min=0 admits "no spend allowed"
//     as a legitimate lockdown shape (matches the engine's
//     `> 0` cost-cap semantic in harness/types.ts:491).
//   compaction_threshold: [0, 1] — fraction of the context window;
//     out of [0,1] is mathematically meaningless.
const BUDGET_FLOAT_KEYS: ReadonlyArray<{
  snake: string;
  camel: keyof BudgetConfigKeys;
  min: number;
  max: number;
}> = [
  { snake: 'max_cost_usd', camel: 'maxCostUsd', min: 0, max: 1_000_000 },
  { snake: 'compaction_threshold', camel: 'compactionThreshold', min: 0, max: 1 },
];

const parseBudgetLayer = (
  path: string | null,
  source: string,
): { layer: PartialBudgetLayer; warnings: string[] } => {
  const layer: PartialBudgetLayer = {};
  const warnings: string[] = [];
  const section = loadTomlSection(path, 'budget', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { layer, warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { layer, warnings };
  }
  const b = section.section;

  const readNumber = (
    snake: string,
    camel: keyof BudgetConfigKeys,
    min: number,
    max: number,
    isInteger: boolean,
  ): void => {
    const snakeRaw = b[snake];
    const camelRaw = b[camel];
    // Mirror the dual-key warning convention from [critique] /
    // [memory]: if the operator declares BOTH spellings, snake_case
    // wins (TOML idiom is snake_case + spec convention) and the
    // camelCase value is dropped. Surface the conflict so the
    // operator can audit which value is authoritative.
    if (snakeRaw !== undefined && camelRaw !== undefined) {
      warnings.push(
        `${source} config (${path}): [budget] declares both ${snake} and ${camel}; snake_case wins, camelCase ignored`,
      );
    }
    const v = snakeRaw ?? camelRaw;
    if (v === undefined) return;
    const keyUsed = snakeRaw !== undefined ? snake : camel;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      warnings.push(
        `${source} config (${path}): [budget].${keyUsed}=${JSON.stringify(v)} must be a finite number; ignoring`,
      );
      return;
    }
    if (isInteger && !Number.isInteger(v)) {
      warnings.push(
        `${source} config (${path}): [budget].${keyUsed}=${v} must be an integer; ignoring`,
      );
      return;
    }
    if (v < min || v > max) {
      warnings.push(
        `${source} config (${path}): [budget].${keyUsed}=${v} out of range [${min}, ${max}]; ignoring`,
      );
      return;
    }
    (layer as Record<string, number>)[camel] = v;
  };

  for (const { snake, camel, min, max } of BUDGET_INT_KEYS)
    readNumber(snake, camel, min, max, true);
  for (const { snake, camel, min, max } of BUDGET_FLOAT_KEYS)
    readNumber(snake, camel, min, max, false);

  return { layer, warnings };
};

export interface LoadBudgetConfigInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export const loadBudgetConfig = (input: LoadBudgetConfigInput): LoadedBudgetConfig => {
  const env = input.env ?? process.env;
  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(input.cwd);

  const userResult = parseBudgetLayer(userPath, 'user');
  const projectResult = parseBudgetLayer(projectPath, 'project');
  const warnings: string[] = [...userResult.warnings, ...projectResult.warnings];

  // Per-key merge — project wins on conflict, undefined leaves the
  // next layer (or DEFAULT_BUDGET) to fill in. Bootstrap is
  // responsible for the DEFAULT_BUDGET merge, mirroring how
  // critique/memory don't pre-merge defaults here.
  const config: BudgetConfigKeys = { ...userResult.layer, ...projectResult.layer };

  return { config, userPath, projectPath, warnings };
};
