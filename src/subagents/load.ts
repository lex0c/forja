import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { projectAgentsDir, userAgentsDir } from './paths.ts';
import type { SubagentBudget, SubagentDefinition, SubagentScope } from './types.ts';

// Spec §11.1 + PLAYBOOKS.md §1.1: definitions are `.md` files with a
// YAML frontmatter block delimited by `---` lines. The body below the
// frontmatter is the system prompt. We refuse anything malformed at
// the file level — a typo in `name` or a missing budget should NOT
// silently land as a no-op subagent that the runtime later rejects
// with a confusing tool-error.

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

const FRONTMATTER_DELIM = '---';

// Tools whose effects escape `cwd` and CANNOT be rolled back by a
// working-tree restore (CHECKPOINTS.md §2.6). In Step 4.1 subagents
// run in-process with checkpoints OFF for the child — a writing
// subagent here would mutate the parent's tree without any reverse
// path, and the parent's `--undo` would NOT capture the child's
// writes (the chain is keyed by session id). Step 4.2 lifts this
// restriction by giving writing subagents a dedicated worktree
// (`isolation: worktree`); until then, refuse the definition at
// load time so the author finds out at bootstrap rather than at
// the first surprise diff.
const TOOLS_BLOCKED_UNTIL_WORKTREE: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'bash',
  'bash_background',
  'bash_kill',
]);

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

const requireStringArray = (
  fm: Record<string, unknown>,
  key: string,
  sourcePath: string,
): string[] => {
  const v = fm[key];
  if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
    throw new Error(`subagent ${sourcePath}: '${key}' must be an array of strings`);
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
  if (typeof maxCost !== 'number' || !(maxCost >= 0)) {
    throw new Error(`subagent ${sourcePath}: 'budget.max_cost_usd' must be a non-negative number`);
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
): SubagentDefinition => {
  const fm = parsed.frontmatter;
  const name = requireString(fm, 'name', sourcePath);
  if (!KEBAB_RE.test(name)) {
    throw new Error(`subagent ${sourcePath}: 'name' must be kebab-case (got '${name}')`);
  }
  const description = requireString(fm, 'description', sourcePath);
  const tools = requireStringArray(fm, 'tools', sourcePath);
  for (const t of tools) {
    if (TOOLS_BLOCKED_UNTIL_WORKTREE.has(t)) {
      throw new Error(
        `subagent ${sourcePath}: tool '${t}' cannot appear in subagent.tools[] in Step 4.1 — write/exec tools require worktree isolation (Step 4.2). Until then, the parent's --undo cannot revert the child's writes and the child's checkpoints are unreachable from the parent's session id. Remove the tool or wait for worktree support.`,
      );
    }
  }
  if (fm.budget === undefined) {
    throw new Error(`subagent ${sourcePath}: 'budget' is required`);
  }
  const budget = parseBudget(fm.budget, sourcePath);
  if (parsed.body.length === 0) {
    throw new Error(`subagent ${sourcePath}: body (system prompt) is empty`);
  }

  const known: ReadonlySet<string> = new Set(['name', 'description', 'tools', 'budget']);
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
    sourcePath,
    meta,
  };
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
  const parsed = splitFrontmatter(content, sourcePath);
  return parseDefinition(parsed, scope, sourcePath);
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
