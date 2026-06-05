import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { formatCapability, parseCapability } from '../permissions/capabilities.ts';
import { EMBEDDED_BUILTINS, PROTECTED_BUILTIN_NAMES } from './builtin/index.ts';
import { BUILTIN_AGENTS_DIR, projectAgentsDir, userAgentsDir } from './paths.ts';
import { TOOL_RESTRICTION_SHAPE } from './restrictions.ts';
import type {
  ContextRecipe,
  IncludeRepoMap,
  PhaseDef,
  SamplingOverride,
  StepReflection,
  SubagentBudget,
  SubagentDefinition,
  SubagentIsolation,
  SubagentScope,
  ToolRestrictionRules,
  ToolRestrictions,
} from './types.ts';

// Spec §11.1 + PLAYBOOKS.md §1.1: definitions are `.md` files with a
// YAML frontmatter block delimited by `---` lines. The body below the
// frontmatter is the system prompt. We refuse anything malformed at
// the file level — a typo in `name` or a missing budget should NOT
// silently land as a no-op subagent that the runtime later rejects
// with a confusing tool-error.

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

const FRONTMATTER_DELIM = '---';

// Note on tool capability validation: the loader is REGISTRY-AGNOSTIC
// — it doesn't know which tools the harness has wired or what their
// metadata says. Validation that depends on tool capabilities (write
// detection for the worktree-blocking rule) lives in
// `validate.ts` and runs at bootstrap (against the loaded registry)
// AND at runtime (in `runSubagent`'s child-registry construction).
// Earlier we hardcoded a name list here, which silently let any
// newly-registered writing tool slip through.

interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

// Split on the leading `---` block. We require the file to START with
// the delimiter so a stray `---` mid-document doesn't get parsed as a
// frontmatter terminator (markdown commonly uses `---` for section
// breaks; a body-only file with such a break would otherwise produce
// surprising results).
const splitFrontmatter = (content: string, sourcePath: string): ParsedFile => {
  const normalized = content.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== FRONTMATTER_DELIM) {
    throw new Error(`subagent ${sourcePath}: missing leading '---' frontmatter delimiter`);
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error(`subagent ${sourcePath}: unterminated frontmatter (missing closing '---')`);
  }
  const frontmatterText = lines.slice(1, endIdx).join('\n');
  const body = lines
    .slice(endIdx + 1)
    .join('\n')
    .trim();
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(frontmatterText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`subagent ${sourcePath}: malformed YAML frontmatter: ${msg}`);
  }
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error(`subagent ${sourcePath}: frontmatter must be a YAML mapping`);
  }
  return { frontmatter: frontmatter as Record<string, unknown>, body };
};

const requireString = (fm: Record<string, unknown>, key: string, sourcePath: string): string => {
  const v = fm[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`subagent ${sourcePath}: '${key}' must be a non-empty string`);
  }
  return v;
};

// Validate a tools[] frontmatter field. Rejects:
//   - non-string entries (loader contract)
//   - empty / whitespace-only strings (`tools: [""]` shape)
//   - strings with leading/trailing whitespace (`tools: ["read_file "]`)
//   - duplicate entries (`tools: ["echo", "echo"]`)
//
// Each refusal carries the offending index in the array so the
// author can locate the typo without diff'ing the file. Pulling
// these checks forward to load time prevents a definition error
// from surfacing mid-run as a generic `tool.exception` from the
// `task` tool, which costs a tool-error slot and is harder to
// diagnose than a source-aware bootstrap-time error.
const requireToolNameArray = (
  fm: Record<string, unknown>,
  key: string,
  sourcePath: string,
): string[] => {
  const v = fm[key];
  if (!Array.isArray(v)) {
    throw new Error(`subagent ${sourcePath}: '${key}' must be an array of strings`);
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < v.length; i++) {
    const entry = v[i];
    if (typeof entry !== 'string') {
      throw new Error(
        `subagent ${sourcePath}: '${key}[${i}]' must be a string (got ${typeof entry})`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error(`subagent ${sourcePath}: '${key}[${i}]' must be a non-empty tool name`);
    }
    if (entry !== entry.trim()) {
      throw new Error(
        `subagent ${sourcePath}: '${key}[${i}]' has leading or trailing whitespace (got ${JSON.stringify(entry)})`,
      );
    }
    const priorIndex = seen.get(entry);
    if (priorIndex !== undefined) {
      throw new Error(
        `subagent ${sourcePath}: '${key}' lists '${entry}' twice (index ${priorIndex} and index ${i})`,
      );
    }
    seen.set(entry, i);
  }
  return v as string[];
};

const parseBudget = (raw: unknown, sourcePath: string): SubagentBudget => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'budget' must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  const maxSteps = r.max_steps;
  const maxCost = r.max_cost_usd;
  const maxWall = r.max_wall_clock_ms;
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new Error(`subagent ${sourcePath}: 'budget.max_steps' must be a positive integer`);
  }
  // Strict `> 0`. `>= 0` alone admits Infinity (YAML `.inf`),
  // which silently disables the spend cap. `0` is also
  // rejected: a zero-cost subagent is an escape hatch that
  // bypasses the cross-subagent budget gate (spec
  // ORCHESTRATION.md §3.5), since a 0-estimate spawn always
  // passes the `projected = spent + 0 > cap` check unless
  // `spent` already crossed cap. Every accepted definition
  // must declare a real positive ceiling. NaN is rejected by
  // `Number.isFinite`.
  if (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost <= 0) {
    throw new Error(
      `subagent ${sourcePath}: 'budget.max_cost_usd' must be a finite positive number`,
    );
  }
  if (
    maxWall !== undefined &&
    (typeof maxWall !== 'number' || !Number.isInteger(maxWall) || maxWall <= 0)
  ) {
    throw new Error(
      `subagent ${sourcePath}: 'budget.max_wall_clock_ms' must be a positive integer`,
    );
  }
  return {
    maxSteps,
    maxCostUsd: maxCost,
    ...(typeof maxWall === 'number' ? { maxWallClockMs: maxWall } : {}),
  };
};

// ---------------------------------------------------------------------------
// Playbook surface validators (`PLAYBOOKS.md` §1.1).
//
// Each parser below validates one frontmatter field and returns the
// normalized typed shape. All fields are optional — absence yields
// `undefined`, which the consumer slices interpret as "no override
// declared". A present-but-malformed field always throws a
// source-aware error at load time; consumer slices can therefore
// trust their inputs without revalidating shape.
// ---------------------------------------------------------------------------

// Slash command name auto-registered by the playbook (`PLAYBOOKS.md`
// §1.4). Must be kebab-case so `/<slash>` is well-formed and so the
// registry's exact-match lookup matches what the user types. Slice 3
// wires the registration; slice 1 only validates shape.
const parseSlash = (raw: unknown, sourcePath: string): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`subagent ${sourcePath}: 'slash' must be a non-empty string`);
  }
  if (!KEBAB_RE.test(raw)) {
    throw new Error(`subagent ${sourcePath}: 'slash' must be kebab-case (got '${raw}')`);
  }
  return raw;
};

// One-line auto-delegation hint surfaced in the discovery table the
// principal agent reads at session start (`PLAYBOOKS.md` §1.4). Slice
// 2 truncates / pages this when the registry exceeds the table cap;
// slice 1 only refuses empty / whitespace-only.
const parseWhenToUse = (raw: unknown, sourcePath: string): string | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`subagent ${sourcePath}: 'when_to_use' must be a non-empty string`);
  }
  return raw;
};

// Output schema declared by the playbook (`PLAYBOOKS.md` §1.2). The
// loader is schema-agnostic — slice 8 will render this into the
// child's system prompt and validate the terminal assistant turn
// against it. Authors use either an inline shorthand
// (`summary: string`, `findings: [...]`) or full JSON Schema
// (`{ type: object, properties: {...} }`). Both pass through the
// same passthrough — the loader only enforces "this is a YAML
// mapping", not the dialect.
const parseOutputSchema = (
  raw: unknown,
  sourcePath: string,
): Record<string, unknown> | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'output_schema' must be a YAML mapping`);
  }
  return raw as Record<string, unknown>;
};

// Reference document paths the playbook may consult on demand
// (`PLAYBOOKS.md` §1.1). Slice 7 injects this list into the child's
// system prompt under a "References (read on demand)" block; the
// child reads them lazily via the standard `read_file` tool. Slice
// 1 validates that every entry is a non-empty string with no
// surrounding whitespace — silently trimming would mask author
// typos like `references: [" OPSEC.md"]`. Duplicates are rejected
// because the slice-7 block lists each entry once and a duplicate
// would visibly repeat.
const parseReferences = (raw: unknown, sourcePath: string): string[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'references' must be an array of strings`);
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string') {
      throw new Error(
        `subagent ${sourcePath}: 'references[${i}]' must be a string (got ${typeof entry})`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error(`subagent ${sourcePath}: 'references[${i}]' must be a non-empty path`);
    }
    if (entry !== entry.trim()) {
      throw new Error(
        `subagent ${sourcePath}: 'references[${i}]' has leading or trailing whitespace (got ${JSON.stringify(entry)})`,
      );
    }
    const prior = seen.get(entry);
    if (prior !== undefined) {
      throw new Error(
        `subagent ${sourcePath}: 'references' lists '${entry}' twice (index ${prior} and index ${i})`,
      );
    }
    seen.set(entry, i);
  }
  return raw as string[];
};

// Validate a string-array field nested inside a tool_restrictions
// rule (e.g. `bash.allow`). Same shape rules as the top-level
// `tools[]` validator: non-empty strings, no surrounding whitespace,
// no duplicates. Used for every list entry inside a restriction
// rule (`allow`, `deny`, `allow_paths`, `deny_paths`). The error
// path is fully-qualified (`tool_restrictions.bash.allow[2]`) so
// authors can locate the typo without diff'ing the file.
const requireRestrictionPatternArray = (
  raw: unknown,
  sourcePath: string,
  fieldPath: string,
): string[] => {
  if (!Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: '${fieldPath}' must be an array of strings`);
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string') {
      throw new Error(
        `subagent ${sourcePath}: '${fieldPath}[${i}]' must be a string (got ${typeof entry})`,
      );
    }
    if (entry.length === 0) {
      throw new Error(`subagent ${sourcePath}: '${fieldPath}[${i}]' must be a non-empty pattern`);
    }
    // Surrounding whitespace is always a typo: the matcher does
    // literal-position glob comparison (no input/pattern
    // normalization on the path side), so an entry like
    // ' src/**' or 'src/** ' could not possibly match any path
    // that write_file / edit_file would resolve. Refuse at load
    // so authors see the cause source-aware instead of debugging
    // why an allow / deny rule never triggers. Internal
    // whitespace stays valid — bash command patterns
    // legitimately contain spaces (`git diff *`).
    if (entry !== entry.trim()) {
      throw new Error(
        `subagent ${sourcePath}: '${fieldPath}[${i}]' has surrounding whitespace (${JSON.stringify(entry)}); patterns are matched literally and a padded entry would never trigger`,
      );
    }
    const prior = seen.get(entry);
    if (prior !== undefined) {
      throw new Error(
        `subagent ${sourcePath}: '${fieldPath}' lists ${JSON.stringify(entry)} twice (index ${prior} and index ${i})`,
      );
    }
    seen.set(entry, i);
  }
  return raw as string[];
};

// Normalize one tool_restrictions entry from its YAML surface into
// the canonical `ToolRestrictionRules` shape consumed by slice 5.
//
// Accepted YAML surfaces (`PLAYBOOKS.md` §1.1):
//
//   - `bash: [glob1, glob2]`            — list shorthand, becomes
//                                          `{ allow: [glob1, glob2] }`.
//   - `bash:`                            — mapping form.
//        `allow: [...]` / `deny: [...]`     Direct synonyms of the
//                                           canonical fields.
//        `allow_patterns: [...]`            Synonym of `allow`. The
//                                           threat-model / perf
//                                           playbooks use this name
//                                           interchangeably.
//        `allow_paths: [...]` /             Path-shape variants for
//        `deny_paths: [...]`                tools whose argv is a
//                                           path (`write_file`,
//                                           `edit_file`).
//
// Mixing `allow` and `allow_patterns` on the same rule is rejected
// (one-of-each guard) so an author who accidentally specified both
// gets a clear refusal rather than a silent merge that hides one.
//
// Unknown keys throw — a typo like `allows: [...]` would otherwise
// silently drop the rule and slice 5 would enforce nothing on the
// tool. The cost of "fail loud" is one author-time edit; the cost
// of silence is a runaway shell command in production.
const parseToolRestrictionRule = (
  raw: unknown,
  sourcePath: string,
  toolName: string,
): ToolRestrictionRules => {
  // List-shorthand form: `bash: [glob, glob]`. Whole list becomes
  // the `allow` set; nothing else can be declared on that rule.
  if (Array.isArray(raw)) {
    const allow = requireRestrictionPatternArray(raw, sourcePath, `tool_restrictions.${toolName}`);
    const out: ToolRestrictionRules = { allow };
    enforceRestrictionShape(out, toolName, sourcePath);
    return out;
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      `subagent ${sourcePath}: 'tool_restrictions.${toolName}' must be an array of patterns or a mapping`,
    );
  }
  const r = raw as Record<string, unknown>;
  const knownKeys = new Set(['allow', 'deny', 'allow_patterns', 'allow_paths', 'deny_paths']);
  for (const key of Object.keys(r)) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `subagent ${sourcePath}: 'tool_restrictions.${toolName}' has unknown key '${key}' (allowed: ${Array.from(knownKeys).sort().join(', ')})`,
      );
    }
  }
  if (r.allow !== undefined && r.allow_patterns !== undefined) {
    throw new Error(
      `subagent ${sourcePath}: 'tool_restrictions.${toolName}' cannot declare both 'allow' and 'allow_patterns' (they are synonyms; pick one)`,
    );
  }
  const out: ToolRestrictionRules = {};
  if (r.allow !== undefined) {
    out.allow = requireRestrictionPatternArray(
      r.allow,
      sourcePath,
      `tool_restrictions.${toolName}.allow`,
    );
  } else if (r.allow_patterns !== undefined) {
    out.allow = requireRestrictionPatternArray(
      r.allow_patterns,
      sourcePath,
      `tool_restrictions.${toolName}.allow_patterns`,
    );
  }
  if (r.deny !== undefined) {
    out.deny = requireRestrictionPatternArray(
      r.deny,
      sourcePath,
      `tool_restrictions.${toolName}.deny`,
    );
  }
  if (r.allow_paths !== undefined) {
    out.allowPaths = requireRestrictionPatternArray(
      r.allow_paths,
      sourcePath,
      `tool_restrictions.${toolName}.allow_paths`,
    );
  }
  if (r.deny_paths !== undefined) {
    out.denyPaths = requireRestrictionPatternArray(
      r.deny_paths,
      sourcePath,
      `tool_restrictions.${toolName}.deny_paths`,
    );
  }
  enforceRestrictionShape(out, toolName, sourcePath);
  return out;
};

// Shape compatibility gate. The runtime maps each tool to either
// `bash` (matched by command-string) or `path` (matched by target
// path) via `TOOL_RESTRICTION_SHAPE` in `restrictions.ts`. The
// loader accepts arbitrary key combinations, but at runtime
// `enforceBashRestriction` only consults `allow`/`deny` and
// `enforcePathRestriction` only consults `allowPaths`/`denyPaths`
// — so a playbook that wrote `tool_restrictions.write_file.allow:
// ["src/**"]` would parse fine and then enforce nothing at runtime,
// leaving writes effectively unrestricted. Refuse at load with a
// directional hint so the author moves the rule to the right
// field rather than discovering the silent bypass in production.
//
// Tools NOT in `TOOL_RESTRICTION_SHAPE` (forward-compat for future
// tools that the loader accepts but the runtime does not gate)
// pass through untouched — the restriction is inert anyway, so
// refusing here would punish the author for the loader's
// permissiveness elsewhere.
const enforceRestrictionShape = (
  rules: ToolRestrictionRules,
  toolName: string,
  sourcePath: string,
): void => {
  const shape = TOOL_RESTRICTION_SHAPE[toolName];
  if (shape === undefined) return;
  if (shape === 'bash') {
    if (rules.allowPaths !== undefined || rules.denyPaths !== undefined) {
      const offending = rules.allowPaths !== undefined ? 'allow_paths' : 'deny_paths';
      const replacement = rules.allowPaths !== undefined ? 'allow' : 'deny';
      throw new Error(
        `subagent ${sourcePath}: 'tool_restrictions.${toolName}.${offending}' is path-shape but ${toolName} is gated by command-string match — use '${replacement}' (or move the rule to a path-shape tool like write_file / edit_file)`,
      );
    }
  } else {
    if (rules.allow !== undefined || rules.deny !== undefined) {
      const offending = rules.allow !== undefined ? 'allow' : 'deny';
      const replacement = rules.allow !== undefined ? 'allow_paths' : 'deny_paths';
      throw new Error(
        `subagent ${sourcePath}: 'tool_restrictions.${toolName}.${offending}' is command-shape but ${toolName} is gated by target path — use '${replacement}' (or move the rule to a bash-shape tool like bash / bash_background)`,
      );
    }
  }
};

const parseToolRestrictions = (raw: unknown, sourcePath: string): ToolRestrictions | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'tool_restrictions' must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  const out: ToolRestrictions = {};
  for (const toolName of Object.keys(r)) {
    out[toolName] = parseToolRestrictionRule(r[toolName], sourcePath, toolName);
  }
  return out;
};

// Sampling overrides per playbook (`PLAYBOOKS.md` §1.1, defaults in
// `TOKEN_TUNING.md` §9). Validates every range a provider expects:
//
//   - temperature ∈ [0, 2]
//   - top_p ∈ (0, 1]
//   - max_tokens — positive integer
//   - thinking_budget — non-negative integer (0 = disabled)
//   - seed_in_eval — boolean
//
// Unknown keys throw so a typo (`temprature: 0.2`) doesn't silently
// fall back to provider defaults at runtime.
const parseSampling = (raw: unknown, sourcePath: string): SamplingOverride | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'sampling' must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  const knownKeys = new Set([
    'temperature',
    'top_p',
    'max_tokens',
    'thinking_budget',
    'seed_in_eval',
  ]);
  for (const key of Object.keys(r)) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `subagent ${sourcePath}: 'sampling.${key}' is not a recognized option (allowed: ${Array.from(knownKeys).sort().join(', ')})`,
      );
    }
  }
  const out: SamplingOverride = {};
  if (r.temperature !== undefined) {
    if (typeof r.temperature !== 'number' || !Number.isFinite(r.temperature)) {
      throw new Error(`subagent ${sourcePath}: 'sampling.temperature' must be a finite number`);
    }
    if (r.temperature < 0 || r.temperature > 2) {
      throw new Error(
        `subagent ${sourcePath}: 'sampling.temperature' must be in [0, 2] (got ${r.temperature})`,
      );
    }
    out.temperature = r.temperature;
  }
  if (r.top_p !== undefined) {
    if (typeof r.top_p !== 'number' || !Number.isFinite(r.top_p)) {
      throw new Error(`subagent ${sourcePath}: 'sampling.top_p' must be a finite number`);
    }
    if (r.top_p <= 0 || r.top_p > 1) {
      throw new Error(
        `subagent ${sourcePath}: 'sampling.top_p' must be in (0, 1] (got ${r.top_p})`,
      );
    }
    out.topP = r.top_p;
  }
  if (r.max_tokens !== undefined) {
    if (typeof r.max_tokens !== 'number' || !Number.isInteger(r.max_tokens) || r.max_tokens <= 0) {
      throw new Error(`subagent ${sourcePath}: 'sampling.max_tokens' must be a positive integer`);
    }
    out.maxTokens = r.max_tokens;
  }
  if (r.thinking_budget !== undefined) {
    if (
      typeof r.thinking_budget !== 'number' ||
      !Number.isInteger(r.thinking_budget) ||
      r.thinking_budget < 0
    ) {
      throw new Error(
        `subagent ${sourcePath}: 'sampling.thinking_budget' must be a non-negative integer (0 disables; got ${r.thinking_budget})`,
      );
    }
    out.thinkingBudget = r.thinking_budget;
  }
  if (r.seed_in_eval !== undefined) {
    if (typeof r.seed_in_eval !== 'boolean') {
      throw new Error(
        `subagent ${sourcePath}: 'sampling.seed_in_eval' must be a boolean (got ${typeof r.seed_in_eval})`,
      );
    }
    out.seedInEval = r.seed_in_eval;
  }
  // Cross-field check (`PLAYBOOKS.md` §1.1). When extended
  // thinking is enabled, the budget MUST be strictly less than
  // the effective max_tokens — providers reject equal-or-greater
  // pairs (Anthropic 400s with an explicit error; Gemini
  // silently caps the budget; OpenAI's reasoning models have
  // their own internal accounting that misbehaves). We gate ONLY
  // on the pair of explicitly-declared values
  // (`sampling.thinking_budget` + `sampling.max_tokens`); when
  // the playbook omits `sampling.max_tokens`, the runtime
  // resolver picks `provider.capabilities.output_max_tokens`
  // (e.g. 64k on Claude 4.x) and the provider adapter
  // (`providers/anthropic/index.ts` for the model the playbook
  // actually runs against) re-runs the cross-check against the
  // resolved value before sending the request. A loader-side
  // floor against a conservative constant (4096 in earlier
  // slices) was rejecting playbooks like `thinking_budget: 8000`
  // with no explicit `max_tokens` even though the actual request
  // would be valid on any model whose capability cap exceeds
  // 8000 — undermining the runtime-capability resolution. The
  // runtime adapter check is the source of truth; the loader
  // limits itself to what it can honestly verify with the values
  // in front of it.
  //
  // Error message stays provider-neutral on purpose: a playbook
  // is portable across providers, so naming a single vendor's
  // failure mode would mislead operators running against other
  // backends.
  if (
    out.thinkingBudget !== undefined &&
    out.thinkingBudget > 0 &&
    out.maxTokens !== undefined &&
    out.thinkingBudget >= out.maxTokens
  ) {
    throw new Error(
      `subagent ${sourcePath}: 'sampling.thinking_budget' (${out.thinkingBudget}) must be strictly less than 'sampling.max_tokens' (${out.maxTokens}) — providers reject equal-or-greater pairs (Anthropic 400s; Gemini silently caps the budget)`,
    );
  }
  return out;
};

// String-array field used by `context_recipe.memory_filter`. Same
// rules as `references` but with a different field path in the
// error message — duplicates and whitespace-padding both refused
// at load time.
const parseStringArray = (raw: unknown, sourcePath: string, fieldPath: string): string[] => {
  if (!Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: '${fieldPath}' must be an array of strings`);
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string') {
      throw new Error(
        `subagent ${sourcePath}: '${fieldPath}[${i}]' must be a string (got ${typeof entry})`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error(`subagent ${sourcePath}: '${fieldPath}[${i}]' must be a non-empty string`);
    }
    if (entry !== entry.trim()) {
      throw new Error(
        `subagent ${sourcePath}: '${fieldPath}[${i}]' has leading or trailing whitespace (got ${JSON.stringify(entry)})`,
      );
    }
    const prior = seen.get(entry);
    if (prior !== undefined) {
      throw new Error(
        `subagent ${sourcePath}: '${fieldPath}' lists ${JSON.stringify(entry)} twice (index ${prior} and index ${i})`,
      );
    }
    seen.set(entry, i);
  }
  return raw as string[];
};

const INCLUDE_REPO_MAP_VALUES: ReadonlyArray<IncludeRepoMap> = ['eager', 'lazy', 'off'];
const STEP_REFLECTION_VALUES: ReadonlyArray<StepReflection> = ['off', 'terse', 'full'];

// Context recipe (`PLAYBOOKS.md` §1.1, canonical recipes in
// `CONTEXT_TUNING.md` §13). Each field validates independently so an
// invalid `step_reflection` doesn't hide a downstream invalid
// `goal_reinjection_every_n_steps` in the same definition.
//
// Slice 9 wires the live fields (memory_filter, step_reflection,
// goal_reinjection); the repo-map / diff / callers
// fields validate at load time but stay no-op at runtime until
// CODE_INDEX lands. Validating today means an author can declare
// the intent now and the consumer slice picks it up automatically.
const parseContextRecipe = (raw: unknown, sourcePath: string): ContextRecipe | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'context_recipe' must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  const knownKeys = new Set([
    'include_repo_map',
    'include_diff',
    'include_callers',
    'goal_reinjection_every_n_steps',
    'fewshot_count',
    'memory_filter',
    'step_reflection',
  ]);
  for (const key of Object.keys(r)) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `subagent ${sourcePath}: 'context_recipe.${key}' is not a recognized option (allowed: ${Array.from(knownKeys).sort().join(', ')})`,
      );
    }
  }
  const out: ContextRecipe = {};
  if (r.include_repo_map !== undefined) {
    if (
      typeof r.include_repo_map !== 'string' ||
      !(INCLUDE_REPO_MAP_VALUES as ReadonlyArray<string>).includes(r.include_repo_map)
    ) {
      throw new Error(
        `subagent ${sourcePath}: 'context_recipe.include_repo_map' must be one of ${INCLUDE_REPO_MAP_VALUES.join(', ')} (got ${JSON.stringify(r.include_repo_map)})`,
      );
    }
    out.includeRepoMap = r.include_repo_map as IncludeRepoMap;
  }
  if (r.include_diff !== undefined) {
    if (typeof r.include_diff !== 'boolean') {
      throw new Error(
        `subagent ${sourcePath}: 'context_recipe.include_diff' must be a boolean (got ${typeof r.include_diff})`,
      );
    }
    out.includeDiff = r.include_diff;
  }
  if (r.include_callers !== undefined) {
    if (typeof r.include_callers !== 'boolean') {
      throw new Error(
        `subagent ${sourcePath}: 'context_recipe.include_callers' must be a boolean (got ${typeof r.include_callers})`,
      );
    }
    out.includeCallers = r.include_callers;
  }
  if (r.goal_reinjection_every_n_steps !== undefined) {
    if (
      typeof r.goal_reinjection_every_n_steps !== 'number' ||
      !Number.isInteger(r.goal_reinjection_every_n_steps) ||
      r.goal_reinjection_every_n_steps <= 0
    ) {
      throw new Error(
        `subagent ${sourcePath}: 'context_recipe.goal_reinjection_every_n_steps' must be a positive integer (got ${r.goal_reinjection_every_n_steps})`,
      );
    }
    out.goalReinjectionEveryNSteps = r.goal_reinjection_every_n_steps;
  }
  if (r.fewshot_count !== undefined) {
    if (
      typeof r.fewshot_count !== 'number' ||
      !Number.isInteger(r.fewshot_count) ||
      r.fewshot_count < 0
    ) {
      throw new Error(
        `subagent ${sourcePath}: 'context_recipe.fewshot_count' must be a non-negative integer (got ${r.fewshot_count})`,
      );
    }
    out.fewshotCount = r.fewshot_count;
  }
  if (r.memory_filter !== undefined) {
    out.memoryFilter = parseStringArray(
      r.memory_filter,
      sourcePath,
      'context_recipe.memory_filter',
    );
  }
  if (r.step_reflection !== undefined) {
    if (
      typeof r.step_reflection !== 'string' ||
      !(STEP_REFLECTION_VALUES as ReadonlyArray<string>).includes(r.step_reflection)
    ) {
      throw new Error(
        `subagent ${sourcePath}: 'context_recipe.step_reflection' must be one of ${STEP_REFLECTION_VALUES.join(', ')} (got ${JSON.stringify(r.step_reflection)})`,
      );
    }
    out.stepReflection = r.step_reflection as StepReflection;
  }
  return out;
};

// Positive-integer version field used by both `prompt_version` and
// `context_recipe_version` (`PLAYBOOKS.md` §1.1). The number is
// surfaced in eval audit so a regression can be traced to a specific
// prompt or recipe edit without bumping the whole subagent file's
// sha. `0` is rejected because version 0 has no consumer-friendly
// meaning (eval audit's "show me what shipped at v0" query is the
// same as "show me everything pre-versioning"); start at 1.
const parsePositiveVersion = (
  raw: unknown,
  sourcePath: string,
  field: string,
): number | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`subagent ${sourcePath}: '${field}' must be a positive integer (got ${raw})`);
  }
  return raw;
};

// Phase declarations (`PLAYBOOKS.md` §1.1). Slice 1 validates shape
// — name kebab-case, optional onEnter/onComplete are strings, no
// duplicate names — but the runtime is deferred until goal_stack
// (`STATE_MACHINE.md` §2.3) lands. Authors can declare phases today
// and they'll start firing automatically when the consumer slice
// arrives.
const parsePhases = (raw: unknown, sourcePath: string): PhaseDef[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'phases' must be an array of phase mappings`);
  }
  const seen = new Map<string, number>();
  const out: PhaseDef[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`subagent ${sourcePath}: 'phases[${i}]' must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    const knownKeys = new Set(['name', 'on_enter', 'on_complete']);
    for (const key of Object.keys(e)) {
      if (!knownKeys.has(key)) {
        throw new Error(
          `subagent ${sourcePath}: 'phases[${i}].${key}' is not a recognized field (allowed: ${Array.from(knownKeys).sort().join(', ')})`,
        );
      }
    }
    const name = e.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`subagent ${sourcePath}: 'phases[${i}].name' must be a non-empty string`);
    }
    if (!KEBAB_RE.test(name)) {
      throw new Error(
        `subagent ${sourcePath}: 'phases[${i}].name' must be kebab-case (got '${name}')`,
      );
    }
    const prior = seen.get(name);
    if (prior !== undefined) {
      throw new Error(
        `subagent ${sourcePath}: 'phases' lists name '${name}' twice (index ${prior} and index ${i})`,
      );
    }
    seen.set(name, i);
    const phase: PhaseDef = { name };
    if (e.on_enter !== undefined) {
      if (typeof e.on_enter !== 'string' || e.on_enter.length === 0) {
        throw new Error(
          `subagent ${sourcePath}: 'phases[${i}].on_enter' must be a non-empty string`,
        );
      }
      phase.onEnter = e.on_enter;
    }
    if (e.on_complete !== undefined) {
      if (typeof e.on_complete !== 'string' || e.on_complete.length === 0) {
        throw new Error(
          `subagent ${sourcePath}: 'phases[${i}].on_complete' must be a non-empty string`,
        );
      }
      phase.onComplete = e.on_complete;
    }
    out.push(phase);
  }
  return out;
};

// Map a parsed file into a SubagentDefinition. The strongly-typed
// fields are extracted; everything else lands in `meta` so future
// playbook surfaces can read additional frontmatter without bumping
// the loader.
const parseDefinition = (
  parsed: ParsedFile,
  scope: SubagentScope,
  sourcePath: string,
  sourceSha256: string,
): SubagentDefinition => {
  const fm = parsed.frontmatter;
  const name = requireString(fm, 'name', sourcePath);
  if (!KEBAB_RE.test(name)) {
    throw new Error(`subagent ${sourcePath}: 'name' must be kebab-case (got '${name}')`);
  }
  const description = requireString(fm, 'description', sourcePath);
  const tools = requireToolNameArray(fm, 'tools', sourcePath);
  if (fm.budget === undefined) {
    throw new Error(`subagent ${sourcePath}: 'budget' is required`);
  }
  const budget = parseBudget(fm.budget, sourcePath);
  const isolation = parseIsolation(fm.isolation, sourcePath);
  if (parsed.body.length === 0) {
    throw new Error(`subagent ${sourcePath}: body (system prompt) is empty`);
  }

  const slash = parseSlash(fm.slash, sourcePath);
  const whenToUse = parseWhenToUse(fm.when_to_use, sourcePath);
  const outputSchema = parseOutputSchema(fm.output_schema, sourcePath);
  const references = parseReferences(fm.references, sourcePath);
  const toolRestrictions = parseToolRestrictions(fm.tool_restrictions, sourcePath);
  const sampling = parseSampling(fm.sampling, sourcePath);
  const contextRecipe = parseContextRecipe(fm.context_recipe, sourcePath);
  const promptVersion = parsePositiveVersion(fm.prompt_version, sourcePath, 'prompt_version');
  const contextRecipeVersion = parsePositiveVersion(
    fm.context_recipe_version,
    sourcePath,
    'context_recipe_version',
  );
  const phases = parsePhases(fm.phases, sourcePath);
  const capabilities = parseCapabilitiesField(fm.capabilities, sourcePath);

  // Every frontmatter key that has a typed parser above is in this
  // set. Anything outside still lands in `meta` for forward
  // compatibility — but the typed surface is large enough now that
  // `meta` should normally be empty.
  const known: ReadonlySet<string> = new Set([
    'name',
    'description',
    'tools',
    'budget',
    'isolation',
    'slash',
    'when_to_use',
    'output_schema',
    'references',
    'tool_restrictions',
    'sampling',
    'context_recipe',
    'prompt_version',
    'context_recipe_version',
    'phases',
    'capabilities',
  ]);
  const meta: Record<string, unknown> = {};
  for (const k of Object.keys(fm)) {
    if (!known.has(k)) meta[k] = fm[k];
  }

  return {
    name,
    description,
    tools,
    budget,
    systemPrompt: parsed.body,
    scope,
    isolation,
    sourcePath,
    sourceSha256,
    ...(slash !== undefined ? { slash } : {}),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(references !== undefined ? { references } : {}),
    ...(toolRestrictions !== undefined ? { toolRestrictions } : {}),
    ...(sampling !== undefined ? { sampling } : {}),
    ...(contextRecipe !== undefined ? { contextRecipe } : {}),
    ...(promptVersion !== undefined ? { promptVersion } : {}),
    ...(contextRecipeVersion !== undefined ? { contextRecipeVersion } : {}),
    ...(phases !== undefined ? { phases } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    meta,
  };
};

// Parse the optional `capabilities` frontmatter field. Each entry is
// a canonical capability string (`read-fs:src/**`, `exec:shell`,
// `net-egress:*`). Validated by round-tripping through parseCapability
// + formatCapability so a typo (`read-fs:` with no scope, or
// `exec:psh`) fails at load time with a source-aware error instead of
// at child spawn (where the catch synthesizes a confusing
// `subagent_escalation` envelope).
//
// Absence ⇒ undefined (legacy behavior; runtime falls back to the
// parent's full envelope). Empty array `[]` is meaningful: spec-
// prescribed "pure-LLM" shape (no capabilities granted) — preserve
// as `[]`, not undefined.
const parseCapabilitiesField = (raw: unknown, sourcePath: string): string[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`subagent ${sourcePath}: 'capabilities' must be an array of strings`);
  }
  const seen = new Map<string, number>();
  const normalized: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string') {
      throw new Error(
        `subagent ${sourcePath}: 'capabilities[${i}]' must be a string (got ${typeof entry})`,
      );
    }
    if (entry.trim().length === 0) {
      throw new Error(
        `subagent ${sourcePath}: 'capabilities[${i}]' must be a non-empty capability`,
      );
    }
    if (entry !== entry.trim()) {
      throw new Error(
        `subagent ${sourcePath}: 'capabilities[${i}]' has leading or trailing whitespace (got ${JSON.stringify(entry)})`,
      );
    }
    let canonical: string;
    try {
      canonical = formatCapability(parseCapability(entry));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `subagent ${sourcePath}: 'capabilities[${i}]' is not a valid capability (got ${JSON.stringify(entry)}): ${msg}`,
      );
    }
    const prior = seen.get(canonical);
    if (prior !== undefined) {
      throw new Error(
        `subagent ${sourcePath}: 'capabilities' lists '${canonical}' twice (index ${prior} and index ${i})`,
      );
    }
    seen.set(canonical, i);
    normalized.push(canonical);
  }
  return normalized;
};

// Parse the optional `isolation` frontmatter field. Defaults to
// 'none' when absent so every existing definition keeps its prior
// behavior. Only 'none' and 'worktree' are accepted — any
// other string fails loud at load time so a typo
// (`isolation: worktee`) doesn't silently downgrade to no isolation.
const parseIsolation = (raw: unknown, sourcePath: string): SubagentIsolation => {
  if (raw === undefined) return 'none';
  if (raw !== 'none' && raw !== 'worktree') {
    throw new Error(
      `subagent ${sourcePath}: 'isolation' must be 'none' or 'worktree' (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
};

const readDir = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push(full);
  }
  out.sort();
  return out;
};

export const loadSubagentFromString = (
  content: string,
  scope: SubagentScope,
  sourcePath: string,
): SubagentDefinition => {
  // Hash the RAW content (frontmatter + body, original line
  // endings preserved) so the fingerprint matches exactly what
  // was on disk at load time. We deliberately do NOT hash the
  // parsed/normalized form — two semantically equivalent files
  // with different whitespace would otherwise alias under one
  // sha and audit lose the distinction.
  const sourceSha256 = createHash('sha256').update(content).digest('hex');
  const parsed = splitFrontmatter(content, sourcePath);
  return parseDefinition(parsed, scope, sourcePath, sourceSha256);
};

export const loadSubagentFromFile = (path: string, scope: SubagentScope): SubagentDefinition => {
  const content = readFileSync(path, 'utf-8');
  return loadSubagentFromString(content, scope, path);
};

export interface LoadSubagentsOptions {
  cwd: string;
  // Test seam — when set, replaces user-scope path discovery so
  // tests don't depend on $HOME / $XDG_CONFIG_HOME. Pass null to
  // explicitly disable the user scope.
  userDir?: string | null;
  // Same shape for project scope. Defaults to <cwd>/.agent/agents.
  projectDir?: string | null;
  // Built-in scope path. Defaults to `src/subagents/builtin/`
  // (resolved at module load via import.meta.dir; see
  // `paths.ts:BUILTIN_AGENTS_DIR`). Pass null to disable entirely
  // (some tests don't want to depend on the shipped definitions).
  builtinDir?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface ShadowedDefinition {
  name: string;
  // The user-scope definition that the project version eclipsed.
  // Diagnostics only — the runtime always picks the project one.
  shadowed: SubagentDefinition;
  winning: SubagentDefinition;
}

export interface SubagentSet {
  // Effective definitions: project-scope wins over user-scope on
  // name collision. Map for O(1) name lookup; iterate values when
  // a list is needed.
  byName: Map<string, SubagentDefinition>;
  // Cross-scope shadows. The CLI surfaces these on stderr at
  // bootstrap time so authors don't wonder why a user-scope tweak
  // isn't being picked up when a project-scope file with the same
  // name exists.
  shadows: ShadowedDefinition[];
}

// Discover and parse every subagent definition under builtin + user +
// project dirs. Precedence: project > user > builtin on name
// collision. Within a single scope, duplicate names ARE an error —
// two files both claiming `name: explore` in the same dir is a
// definition mistake, not a shadow.
//
// Shadow surfacing is asymmetric:
//   - project shadowing user is reported (operator authored both;
//     they want to know which won).
//   - user OR project shadowing builtin is SILENT (operators
//     intentionally override built-in behavior; surfacing every
//     shadow on every boot would be noise — `verify-semantic` is
//     the canonical override target).
export const loadSubagents = (options: LoadSubagentsOptions): SubagentSet => {
  const env = options.env ?? process.env;
  const builtinPath =
    options.builtinDir === null ? null : (options.builtinDir ?? BUILTIN_AGENTS_DIR);
  const userPath = options.userDir === null ? null : (options.userDir ?? userAgentsDir(env));
  const projectPath =
    options.projectDir === null ? null : (options.projectDir ?? projectAgentsDir(options.cwd));

  const loadScope = (dir: string | null, scope: SubagentScope): SubagentDefinition[] => {
    if (dir === null) return [];
    const files = readDir(dir);
    const out: SubagentDefinition[] = [];
    const seen = new Map<string, string>();
    for (const file of files) {
      const def = loadSubagentFromFile(file, scope);
      const prior = seen.get(def.name);
      if (prior !== undefined) {
        throw new Error(
          `subagent name '${def.name}' duplicated in ${scope} scope (${prior} and ${file})`,
        );
      }
      seen.set(def.name, file);
      out.push(def);
    }
    return out;
  };

  // Builtin scope: filesystem first (dev mode). If the default
  // BUILTIN_AGENTS_DIR returns zero defs, fall back to the bundled
  // `EMBEDDED_BUILTINS` table — required under `bun build --compile`
  // where `import.meta.dir` becomes a virtual `/$bunfs/...` path that
  // `readdirSync` cannot enumerate (paths.ts comment for context).
  // The fallback ONLY triggers for the default path so a custom
  // builtinDir (tests, operator override) that's deliberately empty
  // stays empty — that's a fixture choice we honor verbatim.
  const fsBuiltinDefs = loadScope(builtinPath, 'builtin');
  const builtinDefs =
    fsBuiltinDefs.length > 0 || builtinPath !== BUILTIN_AGENTS_DIR
      ? fsBuiltinDefs
      : EMBEDDED_BUILTINS.map(({ filename, raw }) =>
          loadSubagentFromString(raw, 'builtin', `<embedded>/${filename}`),
        );
  const userDefs = loadScope(userPath, 'user');
  const projectDefs = loadScope(projectPath, 'project');

  const byName = new Map<string, SubagentDefinition>();
  for (const def of builtinDefs) byName.set(def.name, def);
  const shadows: ShadowedDefinition[] = [];
  // PROTECTED builtins — shadowing these is allowed (the loader
  // doesn't enforce uniqueness past name precedence) but ALWAYS
  // surfaces as a shadow row so the operator sees that a project /
  // user-scope file has replaced the shipped definition. The S11
  // review surfaced the risk: a project shipping
  // `.agent/agents/verify-semantic.md` with `tools: [bash,
  // write_file]` silently replaces the safe built-in the moment the
  // operator opts into `--memory-verify-llm` in that repo. Surfacing
  // the shadow is defense-in-depth; the operator's trust modal +
  // hooks chain are the actual enforcement.
  // G7: source of truth for protected built-ins lives in
  // `./builtin/index.ts` so a future author registering a new
  // built-in has one obvious place to update — closes the
  // "easy-to-forget hardcoded set" risk.
  for (const def of userDefs) {
    const prior = byName.get(def.name);
    if (prior !== undefined && prior.scope === 'builtin' && PROTECTED_BUILTIN_NAMES.has(def.name)) {
      shadows.push({ name: def.name, shadowed: prior, winning: def });
    }
    // user overrides builtin: shadow is silent for unprotected
    // names (operator-authored shadows of generic built-ins are
    // expected, not a warning surface).
    byName.set(def.name, def);
  }
  for (const def of projectDefs) {
    const prior = byName.get(def.name);
    if (prior !== undefined && prior.scope === 'user') {
      // Operator authored both — surface so they see which won.
      shadows.push({ name: def.name, shadowed: prior, winning: def });
      // G10: if the user def itself shadowed a protected built-in,
      // ALSO surface the project→builtin row so the chain's
      // original protected entry stays visible. Otherwise an
      // operator who set up `user/verify-semantic.md` and then has
      // a project file shadow it would lose visibility on the
      // original built-in replacement.
      if (PROTECTED_BUILTIN_NAMES.has(def.name)) {
        const original = builtinDefs.find((b) => b.name === def.name);
        if (original !== undefined) {
          shadows.push({ name: def.name, shadowed: original, winning: def });
        }
      }
    } else if (
      prior !== undefined &&
      prior.scope === 'builtin' &&
      PROTECTED_BUILTIN_NAMES.has(def.name)
    ) {
      // Project shadow of a protected built-in (no user
      // intermediate) — always loud.
      shadows.push({ name: def.name, shadowed: prior, winning: def });
    }
    byName.set(def.name, def);
  }

  return { byName, shadows };
};
