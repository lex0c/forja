import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { allProtectedRoots } from './protected_paths.ts';
import type { Policy, PolicyMode, SealMode, SealOnFailure } from './types.ts';

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
// engine-wide catch-alls. Three shapes flagged:
//   - exact equality with a protected root (`/etc`, `~/.bashrc`)
//   - pattern that descends INTO a protected dir (`/etc/hosts`,
//     `/etc/**`, `/proc/1`) — `${root}/` prefix.
//   - pattern that starts at the protected root and continues with
//     a glob metacharacter (`/etc*`, `/proc?`, `/etc[abc]`) —
//     these match the bare root via glob expansion even though
//     they don't carry the `/` boundary (slice 101, R8 #321).
//
// Engine-wide catch-alls (`/**`, `**`) are not flagged here — the
// runtime classifier in protected_paths.ts catches their matches
// against protected targets at decision time. Flagging catch-alls
// would break the common "allow all writes under cwd" pattern.
const isGlobChar = (ch: string | undefined): boolean => ch === '*' || ch === '?' || ch === '[';

const isProtectedRedefinition = (
  pattern: string,
  protectedRoots: readonly string[],
  home: string,
): boolean => {
  const expanded = expandTilde(pattern, home);
  for (const root of protectedRoots) {
    if (expanded === root) return true;
    if (expanded.startsWith(`${root}/`)) return true;
    // Glob-suffix shapes: `/etc*` (matches /etc + /etcd + /etcetera
    // — admitting the protected /etc via glob expansion), `/proc[1]`,
    // `/etc?`. The check fires when the pattern starts with the root
    // string AND the immediately-following character is a glob
    // metachar. Non-glob continuations (`/etcd`, `/proche`) are NOT
    // protected redefinitions — they reference different paths.
    if (expanded.startsWith(root) && isGlobChar(expanded[root.length])) {
      return true;
    }
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

// §7.3 sealing modes. Currently 'none' (default), 'worm-file'
// (Linux ext4 + chattr +a, slice 54), 'git-anchored' (append to
// file inside a git repo + commit per entry, slice 63). The
// remaining §7.3 backends ship in later slices; listing them as
// RESERVED makes config errors specific ("not yet implemented")
// rather than generic enum-mismatch.
const VALID_SEAL_MODES: ReadonlySet<string> = new Set([
  'none',
  'worm-file',
  'git-anchored',
  'rfc3161-tsa',
  's3-object-lock',
]);
// All §7.3 backends shipped as of slice 89. The set stays for the
// branch in parsePolicy that emits the "reserved for a future
// slice" diagnostic when ops type a mode that's documented but
// unimplemented; today it's empty.
const RESERVED_SEAL_MODES: ReadonlySet<string> = new Set();
const VALID_SEAL_ON_FAILURE: ReadonlySet<string> = new Set(['degrade', 'refuse']);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

// Reject keys not in the known set. The motivating bug class is
// silent-allow-everything from typos: `allow_path` (singular), `lockd`
// (missing 'e'), etc. A typed-out-of-spec key means the user thought
// they were setting a real rule but actually got nothing. We refuse
// to load a policy with such typos rather than fall through.
//
// Slice 101 (R8 #318): pre-slice this added `'locked'` to every
// section unconditionally. `seal: {..., locked: true}` parsed
// silently even though seal has no lock semantics — the operator
// who authored that line thought they locked the seal but got
// nothing. The fix: callers list every supported key explicitly.
// Sections that support locking pass `'locked'`; sections that
// don't (seal today) leave it out and an authored `locked: true`
// surfaces as an unknown-key error pointing the operator at the
// actual supported set.
const rejectUnknownKeys = (
  r: Record<string, unknown>,
  knownKeys: readonly string[],
  toolName: string,
): void => {
  const known = new Set(knownKeys);
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
  rejectUnknownKeys(r, ['allow', 'confirm', 'deny', 'locked'], toolName);
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
  rejectUnknownKeys(r, ['allow_paths', 'confirm_paths', 'deny_paths', 'locked'], toolName);
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
  rejectUnknownKeys(r, ['allow_hosts', 'deny_hosts', 'locked'], toolName);
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
// Top-level keys the parser knows about. Slice 101 (R8 #319):
// pre-slice an authored `defualts: { mode: 'bypass' }` (typo for
// `defaults`) silently dropped because the top-level only matched
// specific known keys via `if (r.X !== undefined)` blocks; everything
// else was ignored. The operator who authored that line thought
// they were setting bypass mode but actually got the empty-defaults
// policy. The fix surfaces top-level typos at parse time with the
// same shape used for nested sections.
const TOP_LEVEL_KEYS: readonly string[] = ['defaults', 'tools', 'sandbox', 'seal'];

// Tool keys the `tools.*` section accepts. Slice 101 (R8 #320):
// pre-slice `tools.bsh: { deny: ['rm -rf *'] }` (typo for `bash`)
// parsed silently — the validator dispatched on specific names
// and ignored everything else. The operator thought they were
// blocking rm but actually authored a no-op section. Same typo
// surface as top-level keys.
const KNOWN_TOOL_KEYS: readonly string[] = [
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'fetch_url',
];

export const parsePolicy = (raw: unknown, context: ParsePolicyContext = {}): Policy => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('policy: top-level must be a YAML mapping');
  }
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, TOP_LEVEL_KEYS, 'policy');

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
    rejectUnknownKeys(d, ['mode', 'locked'], 'defaults');
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
  rejectUnknownKeys(tools, KNOWN_TOOL_KEYS, 'tools');

  validateBashPolicy(tools.bash, 'bash');
  validatePathPolicy(tools.read_file, 'read_file', context);
  validatePathPolicy(tools.write_file, 'write_file', context);
  validatePathPolicy(tools.edit_file, 'edit_file', context);
  validatePathPolicy(tools.glob, 'glob', context);
  validatePathPolicy(tools.grep, 'grep', context);
  validateFetchPolicy(tools.fetch_url, 'fetch_url');

  // PERMISSION_ENGINE.md §6.5 policy-layer sandbox section. Optional;
  // when absent, the bootstrap falls back to hardcoded defaults
  // (`required: false`, hostAllowed: false). Booleans only; YAML
  // uses snake_case (`host_allowed`) and we map to camelCase
  // (`hostAllowed`) at parse time for consistency with the rest of
  // the TS-facing policy shape.
  let sandbox: Policy['sandbox'];
  if (r.sandbox !== undefined) {
    if (typeof r.sandbox !== 'object' || r.sandbox === null || Array.isArray(r.sandbox)) {
      throw new Error('policy: `sandbox` must be a mapping');
    }
    const s = r.sandbox as Record<string, unknown>;
    rejectUnknownKeys(s, ['required', 'host_allowed', 'locked'], 'sandbox');
    let required: boolean | undefined;
    let hostAllowed: boolean | undefined;
    let locked: boolean | undefined;
    if (s.required !== undefined) {
      if (typeof s.required !== 'boolean') {
        throw new Error('policy: sandbox.required must be boolean');
      }
      required = s.required;
    }
    if (s.host_allowed !== undefined) {
      if (typeof s.host_allowed !== 'boolean') {
        throw new Error('policy: sandbox.host_allowed must be boolean');
      }
      hostAllowed = s.host_allowed;
    }
    // Section-level lock (slice 34) — mirrors `defaults.locked` /
    // `BashPolicy.locked` / `PathPolicy.locked`. When set in a
    // higher-precedence layer, lower layers cannot change `required`
    // or `hostAllowed`. Re-affirming the same values is silent.
    if (s.locked !== undefined) {
      if (typeof s.locked !== 'boolean') {
        throw new Error('policy: sandbox.locked must be boolean');
      }
      locked = s.locked;
    }
    if (required !== undefined || hostAllowed !== undefined || locked !== undefined) {
      sandbox = {
        ...(required !== undefined ? { required } : {}),
        ...(hostAllowed !== undefined ? { hostAllowed } : {}),
        ...(locked !== undefined ? { locked } : {}),
      };
    }
  }

  // PERMISSION_ENGINE.md §7.3 sealing section (slice 57).
  // Required field: `mode`. Required IF `mode='worm-file'`: `path`.
  // All other fields optional with documented defaults applied at
  // bootstrap-time (not here — keeping the parsed shape minimal so
  // the hierarchy resolver can tell "operator silenced this field"
  // from "operator chose the default value").
  let seal: Policy['seal'];
  if (r.seal !== undefined) {
    if (typeof r.seal !== 'object' || r.seal === null || Array.isArray(r.seal)) {
      throw new Error('policy: `seal` must be a mapping');
    }
    const s = r.seal as Record<string, unknown>;
    rejectUnknownKeys(
      s,
      [
        'mode',
        'path',
        'endpoint',
        'bucket',
        'region',
        'key_prefix',
        'retention_days',
        'interval_decisions',
        'interval_seconds',
        'on_failure',
      ],
      'seal',
    );
    if (s.mode === undefined) {
      throw new Error('policy: seal.mode is required');
    }
    if (typeof s.mode !== 'string' || !VALID_SEAL_MODES.has(s.mode)) {
      // Reserved modes (currently empty after slice 89) get a
      // deliberately specific error so an operator copy-pasting
      // from a future spec revision gets a clear "not yet
      // implemented" rather than a generic enum mismatch. The
      // branch stays even when the set is empty so future
      // additions are one-line.
      if (RESERVED_SEAL_MODES.has(String(s.mode))) {
        throw new Error(
          `policy: seal.mode='${String(s.mode)}' is reserved for a future slice; current support: none|worm-file|git-anchored|rfc3161-tsa|s3-object-lock`,
        );
      }
      throw new Error(
        `policy: seal.mode must be one of none|worm-file|git-anchored|rfc3161-tsa|s3-object-lock, got '${String(s.mode)}'`,
      );
    }
    const mode = s.mode as SealMode;
    let path: string | undefined;
    if (s.path !== undefined) {
      if (typeof s.path !== 'string' || s.path.length === 0) {
        throw new Error('policy: seal.path must be a non-empty string');
      }
      path = s.path;
    }
    if (
      (mode === 'worm-file' ||
        mode === 'git-anchored' ||
        mode === 'rfc3161-tsa' ||
        mode === 's3-object-lock') &&
      path === undefined
    ) {
      throw new Error(`policy: seal.path is required when seal.mode is ${mode}`);
    }
    let endpoint: string | undefined;
    if (s.endpoint !== undefined) {
      if (typeof s.endpoint !== 'string' || s.endpoint.length === 0) {
        throw new Error('policy: seal.endpoint must be a non-empty string');
      }
      if (!s.endpoint.startsWith('http://') && !s.endpoint.startsWith('https://')) {
        throw new Error(
          `policy: seal.endpoint must start with http:// or https://, got '${s.endpoint}'`,
        );
      }
      endpoint = s.endpoint;
    }
    if (mode === 'rfc3161-tsa' && endpoint === undefined) {
      throw new Error("policy: seal.endpoint is required when seal.mode is 'rfc3161-tsa'");
    }
    // §7.3 s3-object-lock fields (slice 89).
    let bucket: string | undefined;
    if (s.bucket !== undefined) {
      if (typeof s.bucket !== 'string' || s.bucket.length === 0) {
        throw new Error('policy: seal.bucket must be a non-empty string');
      }
      bucket = s.bucket;
    }
    if (mode === 's3-object-lock' && bucket === undefined) {
      throw new Error("policy: seal.bucket is required when seal.mode is 's3-object-lock'");
    }
    let region: string | undefined;
    if (s.region !== undefined) {
      if (typeof s.region !== 'string' || s.region.length === 0) {
        throw new Error('policy: seal.region must be a non-empty string');
      }
      region = s.region;
    }
    let key_prefix: string | undefined;
    if (s.key_prefix !== undefined) {
      if (typeof s.key_prefix !== 'string') {
        throw new Error('policy: seal.key_prefix must be a string');
      }
      if (s.key_prefix.startsWith('/') || s.key_prefix.endsWith('/')) {
        throw new Error(
          `policy: seal.key_prefix must not start or end with '/', got '${s.key_prefix}'`,
        );
      }
      key_prefix = s.key_prefix;
    }
    let retention_days: number | undefined;
    if (s.retention_days !== undefined) {
      if (
        typeof s.retention_days !== 'number' ||
        !Number.isInteger(s.retention_days) ||
        s.retention_days < 1
      ) {
        throw new Error('policy: seal.retention_days must be an integer >= 1');
      }
      retention_days = s.retention_days;
    }
    if (mode === 's3-object-lock' && retention_days === undefined) {
      throw new Error(
        "policy: seal.retention_days is required when seal.mode is 's3-object-lock' (no default — Object Lock COMPLIANCE makes objects undeletable until expiry)",
      );
    }
    let interval_decisions: number | undefined;
    if (s.interval_decisions !== undefined) {
      if (
        typeof s.interval_decisions !== 'number' ||
        !Number.isInteger(s.interval_decisions) ||
        s.interval_decisions < 0
      ) {
        throw new Error('policy: seal.interval_decisions must be a non-negative integer');
      }
      interval_decisions = s.interval_decisions;
    }
    let interval_seconds: number | undefined;
    if (s.interval_seconds !== undefined) {
      if (
        typeof s.interval_seconds !== 'number' ||
        !Number.isInteger(s.interval_seconds) ||
        s.interval_seconds < 0
      ) {
        throw new Error('policy: seal.interval_seconds must be a non-negative integer');
      }
      interval_seconds = s.interval_seconds;
    }
    let on_failure: SealOnFailure | undefined;
    if (s.on_failure !== undefined) {
      if (typeof s.on_failure !== 'string' || !VALID_SEAL_ON_FAILURE.has(s.on_failure)) {
        throw new Error(
          `policy: seal.on_failure must be one of degrade|refuse, got '${String(s.on_failure)}'`,
        );
      }
      on_failure = s.on_failure as SealOnFailure;
    }
    seal = {
      mode,
      ...(path !== undefined ? { path } : {}),
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(bucket !== undefined ? { bucket } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(key_prefix !== undefined ? { key_prefix } : {}),
      ...(retention_days !== undefined ? { retention_days } : {}),
      ...(interval_decisions !== undefined ? { interval_decisions } : {}),
      ...(interval_seconds !== undefined ? { interval_seconds } : {}),
      ...(on_failure !== undefined ? { on_failure } : {}),
    };
  }

  return {
    defaults: {
      ...(mode !== undefined ? { mode } : {}),
      ...(defaultsLocked !== undefined ? { locked: defaultsLocked } : {}),
    },
    tools: tools as Policy['tools'],
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(seal !== undefined ? { seal } : {}),
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
