// Operator-owned model catalog — file I/O, validation, serialization.
//
// Kept SDK-free on purpose: `forja init` imports this to materialize the
// seed (`serializeModelProviders`) and the boot path imports it to read
// the catalog, but neither should pull the provider SDKs. The factory
// wiring (which DOES import the SDKs) lives in catalog-file.ts. The
// split mirrors the init handler's "pure filesystem work, no provider
// deps" posture (src/cli/init.ts header).
//
// This file is the RUNTIME SOURCE OF TRUTH for the model catalog
// (AGENTIC_CLI §14.2). The in-binary seed (seed-catalog.ts) only
// materializes it at `forja init`. Fail-soft posture mirrors
// seeds-manifest.ts:
//   - file absent / unreadable / not JSON / no valid models ⇒ error
//     (boot aborts pointing at `forja init`)
//   - a single malformed entry ⇒ warn + skip; the valid ones load
//   - a duplicate id ⇒ warn + first occurrence wins

import { existsSync, readFileSync } from 'node:fs';
import { userAgentPath } from '../config/agent-paths.ts';
import type { ModelProviderEntry, ProviderCapabilities, ProviderFamily } from './types.ts';

// On-disk filename and the schema version stamped into the file (a
// forward-compat seam — a breaking schema change bumps it).
export const MODEL_PROVIDERS_FILENAME = 'model_providers.json';
export const CATALOG_VERSION = 1;

// Families Forja ships an adapter for. The file may name only these; an
// unknown family (a typo, or a not-yet-implemented one) is dropped fail-soft.
// Narrower than `ProviderFamily`, which also carries members without an adapter
// (llama_cpp, mistral).
const SUPPORTED_FAMILIES = new Set<ProviderFamily>([
  'anthropic',
  'openai',
  'ollama',
  'google',
  'openrouter',
]);

// Whether Forja ships an adapter for this family. Exported so the
// subagent child can validate a persisted model_entry_snapshot's family
// before rebuilding from it: a corrupt snapshot (shape-valid but with an
// unsupported family) falls back to re-reading the catalog file instead
// of throwing lazily at factory() time.
export const isSupportedFamily = (family: string): boolean =>
  SUPPORTED_FAMILIES.has(family as ProviderFamily);

// Profile-aware user-scope path, or null on a stripped-down env with no
// derivable config root (containers / CI without HOME).
export const modelProvidersPath = (env: NodeJS.ProcessEnv = process.env): string | null =>
  userAgentPath(MODEL_PROVIDERS_FILENAME, env);

// POSIX env var name shape ([A-Za-z_][A-Za-z0-9_]*), checked char by
// char — the project bans regex on config/security-adjacent surfaces.
const isValidEnvVarName = (s: string): boolean => {
  if (s.length === 0) return false;
  const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const isDigit = (c: number): boolean => c >= 48 && c <= 57;
  const first = s.charCodeAt(0);
  if (!(isAlpha(first) || first === 95)) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(isAlpha(c) || isDigit(c) || c === 95)) return false;
  }
  return true;
};

const TOOLS_VALUES = new Set(['native', 'adapted']);
const CACHE_VALUES = new Set(['server_5min', 'server_persistent', 'client_only']);
const CONSTRAINED_VALUES = new Set(['gbnf', 'json_mode', 'tools', 'regex']);

// Validate the REQUIRED ProviderCapabilities fields (types.ts:29).
// Optional fields (cache costs, supports_* flags, dialect hints) pass
// through verbatim — a malformed optional surfaces at adapter time, not
// here — keeping this the minimum gate that makes an entry registerable.
const validateCapabilities = (
  v: unknown,
): { ok: true; caps: ProviderCapabilities } | { ok: false; reason: string } => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, reason: 'capabilities must be an object' };
  }
  const c = v as Record<string, unknown>;
  const errs: string[] = [];
  const enumOrFalse = (val: unknown, set: Set<string>, name: string): void => {
    if (val === false) return;
    if (typeof val === 'string' && set.has(val)) return;
    errs.push(`${name} must be false or one of ${[...set].join('/')}`);
  };
  // tools: a catalog model is selectable as the agent model, and the agent
  // loop is tool-driven — so, unlike cache/constrained (which degrade
  // gracefully when `false`), the model MUST declare a tool-calling mode.
  // (Auxiliary surfaces such as `[recap].render_model` render via
  // `constrained`, not tools, but the catalog doesn't distinguish
  // auxiliary-only entries, so every entry has to be main-eligible.) A
  // `tools: false` entry would be announced as usable then 400 / stall as
  // the agent model — reject it at load so the capability is load-bearing
  // rather than documentary.
  if (typeof c.tools !== 'string' || !TOOLS_VALUES.has(c.tools)) {
    errs.push(
      `tools must be one of ${[...TOOLS_VALUES].join('/')} — a catalog model is selectable as the agent model, which requires tool calling`,
    );
  }
  enumOrFalse(c.cache, CACHE_VALUES, 'cache');
  enumOrFalse(c.constrained, CONSTRAINED_VALUES, 'constrained');
  if (typeof c.vision !== 'boolean') errs.push('vision must be a boolean');
  if (typeof c.streaming !== 'boolean') errs.push('streaming must be a boolean');
  // Token counts: positive integers. A zero/negative/fractional window or
  // output cap would feed invalid math into the budget/compaction logic and
  // an invalid `max_tokens` into provider requests.
  for (const k of ['context_window', 'output_max_tokens'] as const) {
    const n = c[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      errs.push(`${k} must be a positive integer`);
    }
  }
  // Prices ($/1k tokens): non-negative finite numbers (0 is valid — local
  // models are free). A negative rate would corrupt cost accounting.
  for (const k of ['cost_per_1k_input', 'cost_per_1k_output'] as const) {
    const n = c[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      errs.push(`${k} must be a non-negative number`);
    }
  }
  if (!Array.isArray(c.notes) || !c.notes.every((n) => typeof n === 'string')) {
    errs.push('notes must be an array of strings');
  }
  if (errs.length > 0) return { ok: false, reason: errs.join('; ') };
  return { ok: true, caps: v as ProviderCapabilities };
};

// Validate one entry. `id` must equal `${family}/${model_name}` so the
// three fields can't disagree — resolution keys off `id`, the factory
// off `model_name`.
const validateEntry = (
  raw: unknown,
  idx: number,
  path: string,
): { ok: true; entry: ModelProviderEntry } | { ok: false; warning: string } => {
  const bad = (msg: string): { ok: false; warning: string } => ({
    ok: false,
    warning: `${path}: models[${idx}] dropped (${msg})`,
  });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return bad('id must be a non-empty string');
  if (typeof r.family !== 'string' || !SUPPORTED_FAMILIES.has(r.family as ProviderFamily)) {
    return bad(`family must be one of ${[...SUPPORTED_FAMILIES].join('/')}`);
  }
  if (typeof r.model_name !== 'string' || r.model_name.length === 0) {
    return bad('model_name must be a non-empty string');
  }
  const family = r.family as ProviderFamily;
  if (r.id !== `${family}/${r.model_name}`) {
    return bad(`id must equal "${family}/${r.model_name}"`);
  }
  if (
    r.api_key_env !== undefined &&
    (typeof r.api_key_env !== 'string' || !isValidEnvVarName(r.api_key_env))
  ) {
    return bad('api_key_env must be a valid env var name');
  }
  if (r.base_url !== undefined && (typeof r.base_url !== 'string' || r.base_url.length === 0)) {
    return bad('base_url must be a non-empty string');
  }
  if (
    r.num_ctx !== undefined &&
    (typeof r.num_ctx !== 'number' || !Number.isInteger(r.num_ctx) || r.num_ctx <= 0)
  ) {
    return bad('num_ctx must be a positive integer');
  }
  const caps = validateCapabilities(r.capabilities);
  if (!caps.ok) return bad(caps.reason);
  const entry: ModelProviderEntry = {
    id: r.id,
    family,
    model_name: r.model_name,
    capabilities: caps.caps,
  };
  if (typeof r.api_key_env === 'string') entry.api_key_env = r.api_key_env;
  if (typeof r.base_url === 'string') entry.base_url = r.base_url;
  if (typeof r.num_ctx === 'number') entry.num_ctx = r.num_ctx;
  return { ok: true, entry };
};

export type LoadCatalogResult =
  | { ok: true; entries: ModelProviderEntry[]; warnings: string[] }
  | { ok: false; error: string };

// Read + validate the catalog file. Fail-soft per entry; hard error
// only when there is nothing usable to boot with.
export const loadModelProvidersFile = (env: NodeJS.ProcessEnv = process.env): LoadCatalogResult => {
  const path = modelProvidersPath(env);
  if (path === null) {
    return { ok: false, error: 'cannot resolve the user config dir (no HOME / XDG_CONFIG_HOME)' };
  }
  if (!existsSync(path)) {
    return { ok: false, error: `no model catalog at ${path} — run \`forja init\`` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `cannot read ${path}: ${msg}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `${path} is not valid JSON (${msg}) — fix it or re-run \`forja init --force=model_providers\``,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${path}: top level must be an object with a "models" array` };
  }
  const models = (parsed as Record<string, unknown>).models;
  if (!Array.isArray(models)) {
    return { ok: false, error: `${path}: "models" must be an array` };
  }
  const warnings: string[] = [];
  const entries: ModelProviderEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < models.length; i++) {
    const v = validateEntry(models[i], i, path);
    if (!v.ok) {
      warnings.push(v.warning);
      continue;
    }
    if (seen.has(v.entry.id)) {
      warnings.push(`${path}: models[${i}] duplicate id "${v.entry.id}" ignored (first wins)`);
      continue;
    }
    seen.add(v.entry.id);
    entries.push(v.entry);
  }
  if (entries.length === 0) {
    return {
      ok: false,
      error: `${path}: no valid models — fix it or re-run \`forja init --force=model_providers\``,
    };
  }
  return { ok: true, entries, warnings };
};

// Canonical-JSON serialization (stable top-level key order per entry +
// 2-space indent + trailing newline) — used by `forja init` to
// materialize the seed. Mirrors the seeds-manifest writer's stable-diff
// posture so a vendor bump diffs only the rows that changed.
export const serializeModelProviders = (entries: ReadonlyArray<ModelProviderEntry>): string => {
  const ordered = entries.map((e) => {
    const out: Record<string, unknown> = { id: e.id, family: e.family, model_name: e.model_name };
    if (e.api_key_env !== undefined) out.api_key_env = e.api_key_env;
    if (e.base_url !== undefined) out.base_url = e.base_url;
    if (e.num_ctx !== undefined) out.num_ctx = e.num_ctx;
    out.capabilities = e.capabilities;
    return out;
  });
  return `${JSON.stringify({ version: CATALOG_VERSION, models: ordered }, null, 2)}\n`;
};
