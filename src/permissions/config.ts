import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Policy, PolicyMode } from './types.ts';

const VALID_MODES: ReadonlySet<string> = new Set(['strict', 'acceptEdits', 'bypass']);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

const validateBashPolicy = (raw: unknown, toolName: string): void => {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object') {
    throw new Error(`policy: ${toolName} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of ['allow', 'confirm', 'deny']) {
    if (r[key] !== undefined && !isStringArray(r[key])) {
      throw new Error(`policy: ${toolName}.${key} must be a string array`);
    }
  }
};

const validatePathPolicy = (raw: unknown, toolName: string): void => {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object') {
    throw new Error(`policy: ${toolName} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of ['allow_paths', 'confirm_paths', 'deny_paths']) {
    if (r[key] !== undefined && !isStringArray(r[key])) {
      throw new Error(`policy: ${toolName}.${key} must be a string array`);
    }
  }
};

const validateFetchPolicy = (raw: unknown, toolName: string): void => {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object') {
    throw new Error(`policy: ${toolName} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of ['allow_hosts', 'deny_hosts']) {
    if (r[key] !== undefined && !isStringArray(r[key])) {
      throw new Error(`policy: ${toolName}.${key} must be a string array`);
    }
  }
};

// Strict-but-tolerant validator. We refuse to load a policy with a
// malformed shape rather than silently ignoring fields — a typo in
// `allow_path` (singular) instead of `allow_paths` is the kind of mistake
// that turns into a silent allow-everything in production.
export const parsePolicy = (raw: unknown): Policy => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('policy: top-level must be a YAML mapping');
  }
  const r = raw as Record<string, unknown>;

  let mode: PolicyMode = 'strict';
  if (r.defaults !== undefined) {
    if (typeof r.defaults !== 'object' || r.defaults === null) {
      throw new Error('policy: `defaults` must be a mapping');
    }
    const d = r.defaults as Record<string, unknown>;
    if (d.mode !== undefined) {
      if (typeof d.mode !== 'string' || !VALID_MODES.has(d.mode)) {
        throw new Error(
          `policy: defaults.mode must be one of strict|acceptEdits|bypass, got '${String(d.mode)}'`,
        );
      }
      mode = d.mode as PolicyMode;
    }
  }

  const toolsRaw = r.tools;
  if (toolsRaw !== undefined && (typeof toolsRaw !== 'object' || toolsRaw === null)) {
    throw new Error('policy: `tools` must be a mapping');
  }
  const tools = (toolsRaw ?? {}) as Record<string, unknown>;

  validateBashPolicy(tools.bash, 'bash');
  validatePathPolicy(tools.read_file, 'read_file');
  validatePathPolicy(tools.write_file, 'write_file');
  validatePathPolicy(tools.edit_file, 'edit_file');
  validatePathPolicy(tools.glob, 'glob');
  validatePathPolicy(tools.grep, 'grep');
  validateFetchPolicy(tools.fetch_url, 'fetch_url');

  return {
    defaults: { mode },
    tools: tools as Policy['tools'],
  };
};

export const loadPolicyFromString = (content: string): Policy => {
  const raw = parseYaml(content) as unknown;
  return parsePolicy(raw);
};

export const loadPolicyFromFile = (path: string): Policy => {
  const content = readFileSync(path, 'utf-8');
  return loadPolicyFromString(content);
};

// Default policy when no config file exists. Strict mode + empty rules =
// every gated tool call is denied. Forces the user to opt in explicitly.
export const defaultPolicy = (): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
});
