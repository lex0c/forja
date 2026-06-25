// Operator-facing config loaders for the per-project
// `.forja/config.toml` sections that share the same fail-soft,
// two-layer (user + project) posture: [memory], [providers], [budget],
// [effort], [audit], [sandbox]. AGENTIC_CLI.md §2.1.1.
//
// Most sections here are NOT security-sensitive. The exception is
// `[sandbox] writable_cache_dirs`, which feeds the bwrap argv — so its
// loader SANITIZES every entry (`sanitizeWritableCacheDirs`: reject
// absolute / `..` paths) before it can become a `--tmpfs` target. A
// malformed value is dropped + warned, never trusted.
//
// Layering (for every section): project overrides user, both override
// the code-side defaults. Per-field merge — a project file that tweaks
// a single key leaves the rest to the next layer down. A malformed
// value warns + falls back to the default rather than aborting boot.
//
// Shared file/parse/section plumbing lives in `src/config/section.ts`
// (`loadTomlSection`); path resolution in `src/config/paths.ts`.

import { FORJA_EFFORT_LEVELS, type ForjaEffort } from '../harness/effort.ts';
import { sanitizeWritableCacheDirs } from '../permissions/sandbox-cache-dirs.ts';
import type { ModelRegistry } from '../providers/registry.ts';
import { projectConfigPath, userConfigPath } from './paths.ts';
import { loadTomlSection } from './section.ts';

// Re-export shared path helpers so import sites can pull config paths
// from the same module as the loaders. New code may also import from
// `src/config/paths.ts` directly.
export { projectConfigPath, userConfigPath };

// ────────────────────────────────────────────────────────────────────
// MEMORY DETECTOR CONFIG (Slice Q — invert S11/S13 default to ON)
//
// Same TOML file (`.forja/config.toml`), same user+project precedence,
// same fail-soft parse posture as the other sections here. Reuses
// `userConfigPath` / `projectConfigPath` / `loadTomlSection` plumbing.

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
  // tie. When BOTH spellings are present the camelCase value is
  // silently dropped — emit a warning so the operator can see which
  // value is authoritative (B-M1 hardening).
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
// DEFAULT_MODEL). Fail-soft posture shared with the other sections.

export interface ProvidersConfigKeys {
  // Fully-qualified model id, e.g. "anthropic/claude-opus-4-7".
  // Absent (rather than `null`) when no layer declared the field —
  // matches the per-field-optional convention used by
  // BudgetConfigKeys. Bootstrap consumes via `?? DEFAULT_MODEL` so
  // both undefined and null would work, but the optional shape keeps
  // the field shape consistent across loaders.
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

// Validate a `[section].field = "<model-id>"` value against the
// registry. Returns the id when valid; otherwise returns a fail-soft
// warning (string-type / empty / not-in-registry) and no value. The
// shared ladder behind both `[providers].model` and
// `[recap].render_model` — `label` is the `[section].field` prefix
// the message names (e.g. `[providers].model`).
const validateModelIdField = (
  raw: unknown,
  opts: { label: string; source: string; path: string | null; registry: ModelRegistry },
): { value?: string; warning?: string } => {
  const prefix = `${opts.source} config (${opts.path}): ${opts.label}`;
  if (typeof raw !== 'string') {
    return { warning: `${prefix} must be a string (got ${typeof raw}); ignoring` };
  }
  if (raw.length === 0) {
    return { warning: `${prefix} is empty; ignoring` };
  }
  if (opts.registry.get(raw) === null) {
    const known = opts.registry
      .list()
      .map((e) => e.id)
      .join(', ');
    return { warning: `${prefix}='${raw}' is not a known model; ignoring. Known: ${known}` };
  }
  return { value: raw };
};

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
    const r = validateModelIdField(p.model, { label: '[providers].model', source, path, registry });
    if (r.warning !== undefined) warnings.push(r.warning);
    if (r.value !== undefined) layer.model = r.value;
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
// RECAP CONFIG (RECAP.md §8.2 render model + §3.2/§3.3 master switch)
//
// `[recap]` exposes two operator knobs:
//   - `render_model` — model id for the LLM render of `/recap`
//     (pr/changelog/slack/terse/human). Default stays the session's
//     own provider; a `--model` slash flag overrides per-call.
//     Validated against the registry so a bad id warns at boot and
//     is ignored (render falls back to the session provider) rather
//     than failing silently at render time.
//   - `enabled` — master switch (default `true`). When `false`, the
//     three automatic / cost surfaces are suppressed: session-end +
//     Alt+R auto-display (§3.3), resume auto-rehydrate (§3.2), and
//     LLM render (every `/recap` stays deterministic). The `/recap`
//     command itself stays usable.
//
// Resolution mirrors [providers]: CLI flag (`--no-recap`) > project
// [recap] > user [recap] > default. Per-key merge.

export interface RecapConfigKeys {
  renderModel?: string;
  enabled?: boolean;
}

export interface LoadedRecapConfig {
  config: RecapConfigKeys;
  userPath: string | null;
  projectPath: string;
  warnings: string[];
}

interface PartialRecapLayer {
  renderModel?: string;
  enabled?: boolean;
}

const parseRecapLayer = (
  path: string | null,
  source: string,
  registry: ModelRegistry,
): { layer: PartialRecapLayer; warnings: string[] } => {
  const layer: PartialRecapLayer = {};
  const warnings: string[] = [];
  const section = loadTomlSection(path, 'recap', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { layer, warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { layer, warnings };
  }
  const r = section.section;
  if (r.render_model !== undefined) {
    const v = validateModelIdField(r.render_model, {
      label: '[recap].render_model',
      source,
      path,
      registry,
    });
    if (v.warning !== undefined) warnings.push(v.warning);
    if (v.value !== undefined) layer.renderModel = v.value;
  }
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') {
      warnings.push(
        `${source} config (${path}): [recap].enabled must be a boolean (got ${typeof r.enabled}); ignoring`,
      );
    } else {
      layer.enabled = r.enabled;
    }
  }
  return { layer, warnings };
};

export interface LoadRecapConfigInput {
  cwd: string;
  registry: ModelRegistry;
  env?: NodeJS.ProcessEnv;
}

export const loadRecapConfig = (input: LoadRecapConfigInput): LoadedRecapConfig => {
  const env = input.env ?? process.env;
  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(input.cwd);
  const userResult = parseRecapLayer(userPath, 'user', input.registry);
  const projectResult = parseRecapLayer(projectPath, 'project', input.registry);
  const warnings = [...userResult.warnings, ...projectResult.warnings];

  // Per-key merge — project overrides user.
  const config: RecapConfigKeys = {};
  const resolvedModel = projectResult.layer.renderModel ?? userResult.layer.renderModel;
  if (resolvedModel !== undefined) config.renderModel = resolvedModel;
  const resolvedEnabled = projectResult.layer.enabled ?? userResult.layer.enabled;
  if (resolvedEnabled !== undefined) config.enabled = resolvedEnabled;

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
// (same fail-soft posture as [memory] / [providers]).

export interface BudgetConfigKeys {
  maxSteps?: number;
  maxCostUsd?: number;
  maxWallClockMs?: number;
  maxStepStallMs?: number;
  compactionThreshold?: number;
  compactionPreserveTail?: number;
  compactionMaxTokens?: number;
  compactionRelevance?: boolean;
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
//   compaction_max_tokens: 64_000 — the compaction summary's token cap; a
//     summary larger than this rivals the window it exists to shrink. The
//     default (1024, in src/harness/types.ts via compaction.ts) sits far below.
//
// Min values differ per key by documented disable semantics:
//   - max_step_stall_ms: 0 is the runtime "disable watchdog"
//     sentinel (`src/harness/abortable.ts:68` — `stallMs <= 0`
//     yields the source verbatim with no timer). Operators with
//     long-running steady-streaming providers legitimately need
//     this. Min=1 would force `runtime !== config` divergence.
//   - compaction_preserve_tail: 0 is the "aggressive compaction"
//     mode (drop everything except the system prompt).
//   - max_steps / max_wall_clock_ms: 0 means "abort immediately",
//     not "no cap" — no documented opt-out semantic, so min=1
//     guards against a footgun where the operator types 0
//     expecting "no limit".
const BUDGET_INT_KEYS: ReadonlyArray<{
  snake: string;
  camel: keyof BudgetConfigKeys;
  min: number;
  max: number;
}> = [
  { snake: 'max_steps', camel: 'maxSteps', min: 1, max: 1_000_000 },
  { snake: 'max_wall_clock_ms', camel: 'maxWallClockMs', min: 1, max: 24 * 60 * 60 * 1000 },
  // min=0: `stallMs <= 0` disables the per-step watchdog in
  // `harness/abortable.ts` (runtime contract). Without min=0,
  // config could not express the documented opt-out.
  { snake: 'max_step_stall_ms', camel: 'maxStepStallMs', min: 0, max: 60 * 60 * 1000 },
  // min=0: aggressive compaction — drop everything except the
  // system prompt.
  { snake: 'compaction_preserve_tail', camel: 'compactionPreserveTail', min: 0, max: 1000 },
  // Override for the compaction summary's max_tokens (absent ⇒ the 1024 default
  // in compaction.ts). Raise it for a dense session whose structured summary
  // truncates at the cap. min=1: a 0-token summary is degenerate (no body →
  // fallback); max=64_000 is the "obviously a typo" ceiling above.
  { snake: 'compaction_max_tokens', camel: 'compactionMaxTokens', min: 1, max: 64_000 },
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

// Boolean-valued budget keys. The relevance compaction pre-pass is default-ON
// (DEFAULT_BUDGET.compactionRelevance in src/harness/types.ts); this is the
// operator's CLI opt-out — `[budget] compaction_relevance = false` disables the
// BM25 pre-pass so it can never elide a tool_result the operator needs kept
// verbatim. Without this key the default would be uncontrollable from config.
const BUDGET_BOOL_KEYS: ReadonlyArray<{
  snake: string;
  camel: keyof BudgetConfigKeys;
}> = [{ snake: 'compaction_relevance', camel: 'compactionRelevance' }];

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
    // If the operator declares BOTH spellings, snake_case wins
    // (TOML idiom + spec convention) and the camelCase value is
    // dropped. Surface the conflict so the operator can audit which
    // value is authoritative.
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

  // Same snake/camel-conflict + fail-soft posture as readNumber, for booleans.
  const readBoolean = (snake: string, camel: keyof BudgetConfigKeys): void => {
    const snakeRaw = b[snake];
    const camelRaw = b[camel];
    if (snakeRaw !== undefined && camelRaw !== undefined) {
      warnings.push(
        `${source} config (${path}): [budget] declares both ${snake} and ${camel}; snake_case wins, camelCase ignored`,
      );
    }
    const v = snakeRaw ?? camelRaw;
    if (v === undefined) return;
    const keyUsed = snakeRaw !== undefined ? snake : camel;
    if (typeof v !== 'boolean') {
      warnings.push(
        `${source} config (${path}): [budget].${keyUsed}=${JSON.stringify(v)} must be a boolean; ignoring`,
      );
      return;
    }
    (layer as Record<string, boolean>)[camel] = v;
  };

  for (const { snake, camel, min, max } of BUDGET_INT_KEYS)
    readNumber(snake, camel, min, max, true);
  for (const { snake, camel, min, max } of BUDGET_FLOAT_KEYS)
    readNumber(snake, camel, min, max, false);
  for (const { snake, camel } of BUDGET_BOOL_KEYS) readBoolean(snake, camel);

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
  // responsible for the DEFAULT_BUDGET merge, mirroring how memory
  // doesn't pre-merge defaults here.
  const config: BudgetConfigKeys = { ...userResult.layer, ...projectResult.layer };

  return { config, userPath, projectPath, warnings };
};

// ────────────────────────────────────────────────────────────────────
// EFFORT CONFIG (TOKEN_TUNING.md §4)
//
// `[effort] level` is the operator's PERSISTENT default effort level,
// mirroring how `[budget]` works: config sets the default; the
// `/effort` slash command overrides it in-session (in memory).
// Resolution:
//
//   project [effort].level > user [effort].level > DEFAULT_EFFORT
//
// A dedicated `[effort]` table on purpose — NOT `[sampling]`, which the
// spec reserves for per-provider sub-tables (`[sampling.thinking]`,
// `[sampling.openai_reasoning]`, …) where `effort` means the
// OpenAI-specific reasoning level, not Forja's unified level.
// DEFAULT_EFFORT ('high') is applied by bootstrap, not here — same as
// the loader leaving the DEFAULT_BUDGET merge to bootstrap. Fail-soft +
// case-insensitive (matches `/effort`): an unknown level warns and is
// ignored (falls through to the next layer / default).

export interface LoadedEffortConfig {
  // Configured level, or undefined when neither layer set a valid one
  // (bootstrap then applies DEFAULT_EFFORT).
  effort?: ForjaEffort;
  userPath: string | null;
  projectPath: string;
  warnings: string[];
}

const parseEffortLayer = (
  path: string | null,
  source: string,
): { effort?: ForjaEffort; warnings: string[] } => {
  const warnings: string[] = [];
  const section = loadTomlSection(path, 'effort', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { warnings };
  }
  const raw = section.section.level;
  if (raw === undefined) return { warnings };
  // Case-insensitive — mirror the `/effort` command's `.toLowerCase()`
  // so config.toml and the slash command accept the same vocabulary.
  const normalized = typeof raw === 'string' ? raw.toLowerCase() : raw;
  if (
    typeof normalized !== 'string' ||
    !(FORJA_EFFORT_LEVELS as readonly string[]).includes(normalized)
  ) {
    warnings.push(
      `${source} config (${path}): [effort].level=${JSON.stringify(raw)} must be one of ${FORJA_EFFORT_LEVELS.join('|')}; ignoring`,
    );
    return { warnings };
  }
  return { effort: normalized as ForjaEffort, warnings };
};

export interface LoadEffortConfigInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export const loadEffortConfig = (input: LoadEffortConfigInput): LoadedEffortConfig => {
  const env = input.env ?? process.env;
  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(input.cwd);
  const userResult = parseEffortLayer(userPath, 'user');
  const projectResult = parseEffortLayer(projectPath, 'project');
  const warnings = [...userResult.warnings, ...projectResult.warnings];
  // project wins; undefined leaves bootstrap to apply DEFAULT_EFFORT.
  const effort = projectResult.effort ?? userResult.effort;
  return { ...(effort !== undefined ? { effort } : {}), userPath, projectPath, warnings };
};

// ────────────────────────────────────────────────────────────────────
// SANDBOX CONFIG (SECURITY_GUIDELINE.md §8.1 — writable dev-cache)
//
// `[sandbox] writable_cache_dirs` overrides the $HOME-relative cache
// dirs the cwd-rw / cwd-rw-net sandbox profiles expose as fresh
// writable tmpfs mounts, so build toolchains can write their caches
// (otherwise $HOME is read-only and `go build` / `cargo` / … fail with
// EROFS). Unlike the other sections this one touches a SECURITY surface,
// so values are SANITIZED (`sanitizeWritableCacheDirs`): every entry
// must be a clean $HOME-relative path (no leading `/`, no `..`) or it's
// dropped with a warning — a malformed entry can never `--tmpfs` an
// arbitrary path. Absent → bootstrap leaves the runner to apply
// DEFAULT_WRITABLE_CACHE_DIRS; an explicit empty array disables the
// carve-out.

export interface SandboxConfigKeys {
  // Omitted when no layer declared `writable_cache_dirs` (→ runner
  // default). An explicit `[]` is preserved (carve-out off).
  writableCacheDirs?: string[];
  // Persistent build/dep cache in a Forja-dedicated dir
  // (`~/.cache/forja/cache`, never the host's real cache). Tri-state:
  // `undefined` → DEFAULT (see DEFAULT_CACHE_PERSISTENCE); `false` →
  // explicit opt-out; `true` → on. See `sandbox-cache-env.ts`.
  cachePersistence?: boolean;
  // Per-session persistent `/tmp` (bind a session-scoped dir onto /tmp).
  // Tri-state: `undefined` → DEFAULT (see DEFAULT_SHARED_TMP); `false` →
  // explicit opt-out; `true` → on.
  sharedTmp?: boolean;
}

// Default posture for the two persistence toggles when NO config layer
// declares them. The operator set these ON as the baseline: with no
// `[sandbox]` config, build/dep caches persist across spawns and `/tmp` is
// per-session. An explicit `cache_persistence = false` / `shared_tmp =
// false` opts out. The loader stays tri-state (returns `undefined` when
// absent); these defaults are applied by the CONSUMERS that set the runtime
// overrides (bootstrap + subagent-child), mirroring how
// `writable_cache_dirs` resolves its DEFAULT at the runner, not the loader.
export const DEFAULT_CACHE_PERSISTENCE = true;
export const DEFAULT_SHARED_TMP = true;

export interface LoadedSandboxConfig {
  config: SandboxConfigKeys;
  userPath: string | null;
  projectPath: string;
  warnings: string[];
}

const parseSandboxLayer = (
  path: string | null,
  source: string,
): { layer: SandboxConfigKeys; warnings: string[] } => {
  const layer: SandboxConfigKeys = {};
  const warnings: string[] = [];
  const section = loadTomlSection(path, 'sandbox', source);
  if (section.kind === 'absent' || section.kind === 'no-section') return { layer, warnings };
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { layer, warnings };
  }
  const s = section.section;
  if (s.writable_cache_dirs !== undefined) {
    const raw = s.writable_cache_dirs;
    const { dirs, warnings: w } = sanitizeWritableCacheDirs(raw);
    for (const msg of w) warnings.push(`${source} config (${path}): ${msg}`);
    // Tri-state, fail-soft. Only a LITERAL empty array disables the
    // carve-out. A type error (not an array) or an array whose entries
    // were ALL rejected falls back to DEFAULT (leave the field unset) per
    // this loader's "malformed → default" contract — never silently
    // disable the carve-out and break the operator's builds over a typo
    // (`writable_cache_dirs = ".cache"` instead of `[".cache"]`).
    if (Array.isArray(raw) && raw.length === 0) {
      layer.writableCacheDirs = [];
    } else if (dirs.length > 0) {
      layer.writableCacheDirs = dirs;
    }
  }
  // Opt-in persistence toggles. Snake_case only (matches this section's
  // `writable_cache_dirs`); non-boolean → warn + ignore (leaves the field
  // unset → runner stays ephemeral). Default-off is the safe posture.
  if (s.cache_persistence !== undefined) {
    if (typeof s.cache_persistence !== 'boolean') {
      warnings.push(
        `${source} config (${path}): [sandbox].cache_persistence must be a boolean; ignoring`,
      );
    } else {
      layer.cachePersistence = s.cache_persistence;
    }
  }
  if (s.shared_tmp !== undefined) {
    if (typeof s.shared_tmp !== 'boolean') {
      warnings.push(`${source} config (${path}): [sandbox].shared_tmp must be a boolean; ignoring`);
    } else {
      layer.sharedTmp = s.shared_tmp;
    }
  }
  return { layer, warnings };
};

export interface LoadSandboxConfigInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export const loadSandboxConfig = (input: LoadSandboxConfigInput): LoadedSandboxConfig => {
  const env = input.env ?? process.env;
  const userPath = userConfigPath(env);
  const projectPath = projectConfigPath(input.cwd);
  const userResult = parseSandboxLayer(userPath, 'user');
  const projectResult = parseSandboxLayer(projectPath, 'project');
  const warnings = [...userResult.warnings, ...projectResult.warnings];
  // project wins; undefined leaves bootstrap to apply the runner
  // default. An explicit `[]` is a real value (carve-out disabled), so
  // we check `!== undefined` rather than truthiness.
  const resolved = projectResult.layer.writableCacheDirs ?? userResult.layer.writableCacheDirs;
  const config: SandboxConfigKeys = {};
  if (resolved !== undefined) config.writableCacheDirs = resolved;
  // `??` preserves both the tri-state AND project-wins: an explicit
  // project `false` beats a user `true` (false is not nullish), and an
  // unset project falls through to the user layer.
  const cachePersistence =
    projectResult.layer.cachePersistence ?? userResult.layer.cachePersistence;
  if (cachePersistence !== undefined) config.cachePersistence = cachePersistence;
  const sharedTmp = projectResult.layer.sharedTmp ?? userResult.layer.sharedTmp;
  if (sharedTmp !== undefined) config.sharedTmp = sharedTmp;
  return { config, userPath, projectPath, warnings };
};
