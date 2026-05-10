import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { allProtectedRoots } from './protected_paths.ts';
import type { Policy, PolicyMode } from './types.ts';

// Optional validation context for parsePolicy. When supplied, the
// validator additionally rejects allow/confirm patterns that
// redefine a protected path (PERMISSION_ENGINE.md §11 — "Tentativa
// de remoção em policy load → policy_invalid: protected_paths_redefined").
// Production bootstrap supplies `{ home: os.homedir(), cwd:
// process.cwd() }`; tests that build raw policy objects skip the
// context to keep cross-platform setup-free.
export interface ParsePolicyContext {
  home?: string;
  cwd?: string;
}

const expandTilde = (pattern: string, home: string): string => {
  if (pattern === '~') return home;
  if (pattern.startsWith('~/')) return `${home}${pattern.slice(1)}`;
  return pattern;
};

// True when `pattern` targets a protected path WITHOUT relying on
// engine-wide catch-alls. Two shapes flagged:
//   - exact equality with a protected root (`/etc`, `~/.bashrc`)
//   - pattern that descends INTO a protected dir without a leading
//     wildcard (`/etc/hosts`, `/etc/**`, `/proc/1`)
// Engine-wide catch-alls (`/**`, `**`) are not flagged here — the
// runtime classifier in protected_paths.ts catches their matches
// against protected targets at decision time. Flagging catch-alls
// would break the common "allow all writes under cwd" pattern.
const isProtectedRedefinition = (
  pattern: string,
  protectedRoots: readonly string[],
  home: string,
): boolean => {
  const expanded = expandTilde(pattern, home);
  for (const root of protectedRoots) {
    if (expanded === root) return true;
    if (expanded.startsWith(`${root}/`)) return true;
  }
  return false;
};

const enforceProtectedPathInvariants = (
  r: Record<string, unknown>,
  toolName: string,
  context: ParsePolicyContext,
): void => {
  if (context.home === undefined || context.cwd === undefined) return;
  const roots = allProtectedRoots(context.home, context.cwd);
  // Only allow/confirm are restricted — deny_paths is always
  // allowed since operator reinforcing protection is welcome.
  for (const key of ['allow_paths', 'confirm_paths'] as const) {
    const list = r[key];
    if (!Array.isArray(list)) continue;
    for (const pattern of list) {
      if (typeof pattern !== 'string') continue;
      if (isProtectedRedefinition(pattern, roots, context.home)) {
        throw new Error(
          `policy: ${toolName}.${key} pattern '${pattern}' redefines a protected path; use deny_paths if you want to reinforce protection, or rephrase with a broader glob (PERMISSION_ENGINE.md §11)`,
        );
      }
    }
  }
};

const VALID_MODES: ReadonlySet<string> = new Set(['strict', 'acceptEdits', 'bypass']);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

// Reject keys not in the known set. The motivating bug class is
// silent-allow-everything from typos: `allow_path` (singular), `lockd`
// (missing 'e'), etc. A typed-out-of-spec key means the user thought
// they were setting a real rule but actually got nothing. We refuse
// to load a policy with such typos rather than fall through.
const rejectUnknownKeys = (
  r: Record<string, unknown>,
  knownKeys: readonly string[],
  toolName: string,
): void => {
  const known = new Set([...knownKeys, 'locked']);
  for (const key of Object.keys(r)) {
    if (!known.has(key)) {
      throw new Error(
        `policy: ${toolName} has unknown key '${key}' (expected one of: ${[...known].sort().join(', ')})`,
      );
    }
  }
};

const validateLocked = (r: Record<string, unknown>, toolName: string): void => {
  if (r.locked !== undefined && typeof r.locked !== 'boolean') {
    throw new Error(`policy: ${toolName}.locked must be boolean`);
  }
};

const validateBashPolicy = (raw: unknown, toolName: string): void => {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object') {
    throw new Error(`policy: ${toolName} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, ['allow', 'confirm', 'deny'], toolName);
  for (const key of ['allow', 'confirm', 'deny']) {
    if (r[key] !== undefined && !isStringArray(r[key])) {
      throw new Error(`policy: ${toolName}.${key} must be a string array`);
    }
  }
  validateLocked(r, toolName);
};

const validatePathPolicy = (raw: unknown, toolName: string, context: ParsePolicyContext): void => {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object') {
    throw new Error(`policy: ${toolName} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, ['allow_paths', 'confirm_paths', 'deny_paths'], toolName);
  for (const key of ['allow_paths', 'confirm_paths', 'deny_paths']) {
    if (r[key] !== undefined && !isStringArray(r[key])) {
      throw new Error(`policy: ${toolName}.${key} must be a string array`);
    }
  }
  validateLocked(r, toolName);
  enforceProtectedPathInvariants(r, toolName, context);
};

const validateFetchPolicy = (raw: unknown, toolName: string): void => {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object') {
    throw new Error(`policy: ${toolName} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, ['allow_hosts', 'deny_hosts'], toolName);
  for (const key of ['allow_hosts', 'deny_hosts']) {
    if (r[key] !== undefined && !isStringArray(r[key])) {
      throw new Error(`policy: ${toolName}.${key} must be a string array`);
    }
  }
  validateLocked(r, toolName);
};

// Strict-but-tolerant validator. We refuse to load a policy with a
// malformed shape rather than silently ignoring fields — a typo in
// `allow_path` (singular) instead of `allow_paths` is the kind of mistake
// that turns into a silent allow-everything in production.
//
// When `context.home` and `context.cwd` are provided, the validator
// also enforces the §11 protected-paths invariants: allow/confirm
// patterns that redefine a protected path fail load. Tests building
// hand-crafted policies in-memory typically skip the context;
// production bootstrap supplies both.
export const parsePolicy = (raw: unknown, context: ParsePolicyContext = {}): Policy => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('policy: top-level must be a YAML mapping');
  }
  const r = raw as Record<string, unknown>;

  // Both fields preserve "not present" so the hierarchy resolver
  // can distinguish silence (don't override) from explicit assertion
  // (override the merged value). parsePolicy used to inject
  // mode='strict' as the default, which produced phantom lock
  // conflicts when a lower layer was silent and a higher layer
  // locked mode at non-strict.
  let mode: PolicyMode | undefined;
  let defaultsLocked: boolean | undefined;
  if (r.defaults !== undefined) {
    if (typeof r.defaults !== 'object' || r.defaults === null) {
      throw new Error('policy: `defaults` must be a mapping');
    }
    const d = r.defaults as Record<string, unknown>;
    rejectUnknownKeys(d, ['mode'], 'defaults');
    if (d.mode !== undefined) {
      if (typeof d.mode !== 'string' || !VALID_MODES.has(d.mode)) {
        throw new Error(
          `policy: defaults.mode must be one of strict|acceptEdits|bypass, got '${String(d.mode)}'`,
        );
      }
      mode = d.mode as PolicyMode;
    }
    if (d.locked !== undefined) {
      if (typeof d.locked !== 'boolean') {
        throw new Error('policy: defaults.locked must be boolean');
      }
      defaultsLocked = d.locked;
    }
  }

  const toolsRaw = r.tools;
  if (toolsRaw !== undefined && (typeof toolsRaw !== 'object' || toolsRaw === null)) {
    throw new Error('policy: `tools` must be a mapping');
  }
  const tools = (toolsRaw ?? {}) as Record<string, unknown>;

  validateBashPolicy(tools.bash, 'bash');
  validatePathPolicy(tools.read_file, 'read_file', context);
  validatePathPolicy(tools.write_file, 'write_file', context);
  validatePathPolicy(tools.edit_file, 'edit_file', context);
  validatePathPolicy(tools.glob, 'glob', context);
  validatePathPolicy(tools.grep, 'grep', context);
  validateFetchPolicy(tools.fetch_url, 'fetch_url');

  return {
    defaults: {
      ...(mode !== undefined ? { mode } : {}),
      ...(defaultsLocked !== undefined ? { locked: defaultsLocked } : {}),
    },
    tools: tools as Policy['tools'],
  };
};

export const loadPolicyFromString = (content: string, context: ParsePolicyContext = {}): Policy => {
  const raw = parseYaml(content) as unknown;
  return parsePolicy(raw, context);
};

export const loadPolicyFromFile = (path: string, context: ParsePolicyContext = {}): Policy => {
  const content = readFileSync(path, 'utf-8');
  return loadPolicyFromString(content, context);
};

// Default policy when no config file exists. Strict mode + empty rules =
// every gated tool call is denied. Forces the user to opt in explicitly.
export const defaultPolicy = (): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
});
