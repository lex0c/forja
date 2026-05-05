import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { projectAgentsDir, userAgentsDir } from './paths.ts';
import type {
  SubagentBudget,
  SubagentDefinition,
  SubagentIsolation,
  SubagentScope,
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
  // `>= 0` alone admits Infinity (YAML `.inf`), which silently
  // disables the spend cap that the field is required to enforce.
  // NaN is already rejected by the `>= 0` clause (NaN comparisons
  // are always false), but `Number.isFinite` catches both with one
  // honest predicate. Reject any non-finite value so every accepted
  // definition has a real numeric ceiling.
  if (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost < 0) {
    throw new Error(
      `subagent ${sourcePath}: 'budget.max_cost_usd' must be a finite non-negative number`,
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

  const known: ReadonlySet<string> = new Set([
    'name',
    'description',
    'tools',
    'budget',
    'isolation',
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
    meta,
  };
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

// Discover and parse every subagent definition under user + project
// dirs. Project shadows user on name collision. Within a single
// scope, duplicate names ARE an error — two files both claiming
// `name: explore` in the same dir is a definition mistake, not a
// shadow.
export const loadSubagents = (options: LoadSubagentsOptions): SubagentSet => {
  const env = options.env ?? process.env;
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

  const userDefs = loadScope(userPath, 'user');
  const projectDefs = loadScope(projectPath, 'project');

  const byName = new Map<string, SubagentDefinition>();
  for (const def of userDefs) byName.set(def.name, def);
  const shadows: ShadowedDefinition[] = [];
  for (const def of projectDefs) {
    const prior = byName.get(def.name);
    if (prior !== undefined && prior.scope === 'user') {
      shadows.push({ name: def.name, shadowed: prior, winning: def });
    }
    byName.set(def.name, def);
  }

  return { byName, shadows };
};
