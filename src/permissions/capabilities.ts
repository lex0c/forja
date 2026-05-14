// Canonical capability model.
//
// The engine reasons about WHAT a tool will consume (read a file,
// write a file, exec a process, reach a host) instead of opaque
// tool names. A capability has a `kind` and an optional `scope`
// whose grammar depends on the kind:
//
//   read-fs / write-fs / delete-fs  → path-pattern
//   exec                            → class: 'shell' | 'python' |
//                                       'node' | 'arbitrary'
//   net-egress                      → host-pattern
//   net-ingress                     → port-pattern
//   secret-access                   → identity (store name)
//   git-write                       → identity (repo name)
//   env-mutate / agent-mutate /
//   host-passthrough                → no scope (kind alone is the
//                                       capability)
//
// The format-on-the-wire is `kind:scope` (or just `kind` for
// scope-less kinds). `parseCapability` and `formatCapability`
// round-trip — the audit row stores the formatted form so two
// emits with semantically equal capabilities produce byte-identical
// chain hashes.
//
// Capability VALIDATION (does the scope satisfy the grammar) lands
// when capability-based static rules ship; until then, resolvers
// produce well-formed strings by construction.

export type CapabilityKind =
  | 'read-fs'
  | 'write-fs'
  | 'delete-fs'
  | 'exec'
  | 'net-egress'
  | 'net-ingress'
  | 'secret-access'
  | 'git-write'
  | 'env-mutate'
  | 'agent-mutate'
  | 'host-passthrough';

// Whether the kind carries a scope component. Scope-less kinds
// stand alone (`env-mutate` is the full capability string); the
// rest require a scope (`read-fs:src/**`, `exec:shell`).
const KINDS_WITHOUT_SCOPE: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  'env-mutate',
  'agent-mutate',
  'host-passthrough',
]);

const ALL_KINDS: ReadonlySet<string> = new Set<CapabilityKind>([
  'read-fs',
  'write-fs',
  'delete-fs',
  'exec',
  'net-egress',
  'net-ingress',
  'secret-access',
  'git-write',
  'env-mutate',
  'agent-mutate',
  'host-passthrough',
]);

export interface Capability {
  kind: CapabilityKind;
  // Scope value verbatim. `null` for the scope-less kinds.
  // Resolver authors should keep scopes textually stable (resolved
  // abs path or canonical host) so two equivalent emits produce
  // identical capability strings — chain hash determinism depends
  // on it.
  scope: string | null;
}

export const isCapabilityKind = (s: string): s is CapabilityKind => ALL_KINDS.has(s);

// Format a capability into its canonical wire form. Scope-less
// kinds stand alone; scoped kinds use `kind:scope` with no whitespace
// on either side. The colon is the first occurrence — scope values
// themselves may legitimately contain `:` (port ranges, identity
// paths) and we don't escape them.
export const formatCapability = (c: Capability): string => {
  if (KINDS_WITHOUT_SCOPE.has(c.kind)) return c.kind;
  if (c.scope === null) {
    // Programming bug: scoped kind constructed without a scope.
    // Coerce to wildcard rather than emit a malformed string —
    // wildcard is more conservative than guessing.
    return `${c.kind}:*`;
  }
  return `${c.kind}:${c.scope}`;
};

// Parse the wire form. Throws on unknown kind or malformed shape.
// Tolerant of empty scope only when the kind is scope-less.
export const parseCapability = (s: string): Capability => {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('capability: must be a non-empty string');
  }
  const colon = s.indexOf(':');
  if (colon === -1) {
    if (!isCapabilityKind(s)) {
      throw new Error(`capability: unknown kind '${s}'`);
    }
    if (!KINDS_WITHOUT_SCOPE.has(s)) {
      throw new Error(`capability: kind '${s}' requires a scope`);
    }
    return { kind: s, scope: null };
  }
  const kind = s.slice(0, colon);
  const scope = s.slice(colon + 1);
  if (!isCapabilityKind(kind)) {
    throw new Error(`capability: unknown kind '${kind}'`);
  }
  if (KINDS_WITHOUT_SCOPE.has(kind)) {
    throw new Error(`capability: kind '${kind}' must not carry a scope (got '${scope}')`);
  }
  if (scope.length === 0) {
    throw new Error(`capability: kind '${kind}' requires a non-empty scope`);
  }
  return { kind, scope };
};

// Equality: kind matches AND scope matches verbatim. Scope normalization
// (resolving symlinks, canonicalizing host case) is the resolver's job
// — equality here is exact-match on the formatted form.
export const capabilityEquals = (a: Capability, b: Capability): boolean =>
  a.kind === b.kind && a.scope === b.scope;

// Lex-sort a list of capabilities by formatted form. Used before
// emitting `capabilities_json` so two runs against equivalent inputs
// produce byte-identical JSON (and therefore byte-identical audit
// chain hashes). Resolver implementation order doesn't leak into the
// chain.
export const sortCapabilities = (caps: readonly Capability[]): Capability[] => {
  const formatted = caps.map((c) => ({ c, key: formatCapability(c) }));
  formatted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return formatted.map((entry) => entry.c);
};

// Does a `parent` capability cover a `child` capability
// ("declared_caps ⊆ parent_caps")? Coverage rules (deliberately
// small — extending the surface requires a spec change +
// conformance case):
//
//   1. Different kinds → never. exec doesn't cover read-fs, etc.
//   2. Scope-less kinds (env-mutate, agent-mutate, host-passthrough):
//      identity match (the kind alone IS the capability).
//   3. exec hierarchy: `exec:arbitrary` covers every other class
//      (`shell`, `python`, `node`); within the non-arbitrary set,
//      only literal match (`exec:shell` does NOT cover `exec:python`).
//   4. Scoped kinds with path/host patterns (read-fs, write-fs,
//      delete-fs, git-write, net-egress, net-ingress, secret-access):
//      coverage holds when the parent scope is one of —
//        a. Universal wildcard `**` or `*`.
//        b. Literal equality with the child scope.
//        c. Prefix glob `<prefix>/**` where the child scope starts
//           with `<prefix>/` or equals `<prefix>`.
//      Anything more exotic (mid-pattern wildcards, character
//      classes, brace expansion) is NOT recognized — parent has to
//      use a supported shape, or the child capability cannot be
//      proven safely covered.
//
// Rule 4.c handles the common policy idiom (`read-fs:src/**`
// covers `read-fs:src/index.ts`) without bringing in a full
// glob-vs-glob containment solver. Broader patterns would need a
// real subset checker.
export const capabilityCovers = (parent: Capability, child: Capability): boolean => {
  if (parent.kind !== child.kind) return false;

  // Scope-less kinds: the kind IS the capability.
  if (KINDS_WITHOUT_SCOPE.has(parent.kind)) return true;

  const pScope = parent.scope;
  const cScope = child.scope;
  if (pScope === null || cScope === null) return false;

  // exec hierarchy. `arbitrary` is the umbrella; everything else is
  // a literal class name.
  if (parent.kind === 'exec') {
    if (pScope === 'arbitrary') return true;
    return pScope === cScope;
  }

  // Universal wildcards.
  if (pScope === '**' || pScope === '*') return true;

  // Literal equality.
  if (pScope === cScope) return true;

  // Prefix glob `<prefix>/**` covers `<prefix>` and `<prefix>/...`.
  if (pScope.endsWith('/**')) {
    const prefix = pScope.slice(0, -3);
    if (prefix.length === 0) return true; // `**` alone, but handled above
    return cScope === prefix || cScope.startsWith(`${prefix}/`);
  }

  return false;
};

// Cwd-aware coverage variant for child-side enforcement. The
// spawn-time intersection (`capabilityCovers` above) is string-
// symmetric — both `parent_caps` and `declared_caps` arrive in the
// SAME form (relative scopes, model + policy YAML authored). The
// child engine's evaluation case is asymmetric: the persisted
// effective set is the model's relative declared form
// (`read-fs:src/**`), while the resolver-emitted capability is the
// LEXICAL-ABSOLUTE form (`read-fs:/abs/cwd/src/auth/login.ts`)
// that the FS resolvers produce via `path.resolve(cwd, ...)`.
//
// Pure string prefix matching fails this combination: `src/**` is
// not a prefix of `/abs/cwd/src/auth/login.ts`. The cwd-aware
// variant resolves both scopes against the engine's cwd via
// `matchPath` so the relative pattern admits the absolute target
// when the target lives inside cwd's subtree. Non-fs kinds (exec,
// net-egress, env-mutate, etc.) defer to `capabilityCovers` —
// those scopes are textual identities (class names, host strings)
// that don't need cwd resolution.
//
// Symlink defense: `matchPath` already resolves symlinks on the
// target. A symlink inside cwd pointing at `/etc/passwd` is
// treated as `/etc/passwd` here, which doesn't lie under the cwd
// subtree, so the relative pattern `src/**` won't match it. Same
// property the engine's path rules enforce.
//
// This helper is the evaluation-side check for the child-envelope
// constraint. No flag / config / prompt can override.
import { matchPath } from './matcher.ts';

const FS_KINDS: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  'read-fs',
  'write-fs',
  'delete-fs',
]);

export const capabilityCoversCwdAware = (
  parent: Capability,
  child: Capability,
  cwd: string,
): boolean => {
  if (parent.kind !== child.kind) return false;
  if (!FS_KINDS.has(parent.kind)) return capabilityCovers(parent, child);
  const pScope = parent.scope;
  const cScope = child.scope;
  if (pScope === null || cScope === null) return false;
  // Universal wildcards short-circuit — `matchPath` would resolve
  // `**` against cwd and miss targets OUTSIDE cwd that the
  // universal form should cover (e.g. a system-wide `read-fs:**`
  // from a parent policy that allowed reads under `/usr/share/`).
  // The semantics of `capabilityCovers` treat `**`/`*` as "covers
  // everything of this kind" — preserve that contract here.
  if (pScope === '**' || pScope === '*') return true;
  // Literal equality wins before the matcher — covers the textual-
  // identity case (declared `read-fs:src/index.ts` against
  // resolved `read-fs:src/index.ts` without absolutization).
  // Cheap pre-check.
  if (pScope === cScope) return true;
  return matchPath(pScope, cScope, cwd);
};

// Split a resolved capability set into (covered, uncovered)
// against an effective bound. The engine's `check()` stage
// consumes the `uncovered` list to build the deny envelope's
// reason and the audit row's `capabilities_json` (the uncovered
// caps are the ones that pushed the child over its declared
// envelope).
//
// Empty `effective` is the pure-LLM case: every non-empty
// resolved cap is uncovered. An empty `resolved` (misc category)
// is trivially covered regardless of effective — no side-effect
// capability was requested, so the effective bound doesn't apply.
export interface EffectiveCoverResult {
  covered: Capability[];
  uncovered: Capability[];
}

export const effectiveCovers = (
  effective: readonly Capability[],
  resolved: readonly Capability[],
  cwd: string,
): EffectiveCoverResult => {
  const covered: Capability[] = [];
  const uncovered: Capability[] = [];
  for (const r of resolved) {
    const isCovered = effective.some((e) => capabilityCoversCwdAware(e, r, cwd));
    if (isCovered) covered.push(r);
    else uncovered.push(r);
  }
  return { covered, uncovered };
};

// Apply the intersection rule. Each `declared` capability covered
// by some `parent` capability survives into `effective`; anything
// NOT covered lands in `excess`. The caller decides the outcome
// (ANY excess → deny with `subagent_escalation`), but exposing
// both arrays keeps the primitive composable.
//
// Behavior on empty inputs:
//   - declared=[] → effective=[], excess=[]. Maps to "subagent
//     receives NO capability" (pure-LLM); the empty effective
//     list is exactly that signal.
//   - parent=[] AND declared=[X, Y] → effective=[],
//     excess=[X, Y]. Every declared capability is unbacked.
//
// Order: `effective` preserves declared order so a downstream
// audit/format step renders capabilities in the order the model
// requested them; `excess` likewise.
export interface IntersectionResult {
  effective: Capability[];
  excess: Capability[];
}

export const intersectCapabilities = (
  parent: readonly Capability[],
  declared: readonly Capability[],
): IntersectionResult => {
  const effective: Capability[] = [];
  const excess: Capability[] = [];
  for (const child of declared) {
    const covered = parent.some((p) => capabilityCovers(p, child));
    if (covered) effective.push(child);
    else excess.push(child);
  }
  return { effective, excess };
};

// Parent-capability derivation from the live policy.
//
// Per-section mapping:
//   - BashPolicy.allow         → command patterns (NOT path globs),
//                                 every footprint kind stays universal.
//   - PathPolicy.allow_paths   → one cap per path, per fs kind in
//                                 the footprint (read-fs, write-fs).
//   - FetchPolicy.allow_hosts  → one cap per host (net-egress).
//
// After emission, two passes run:
//   1. Dedupe by formatted form. Two sections that emit the same
//      (kind, scope) tuple contribute a single cap.
//   2. Subsumption via `capabilityCovers`. A cap is dropped if
//      ANY other cap in the set covers it — `read-fs:**` from
//      bash subsumes `read-fs:src/**` from read_file. The
//      intersection step doesn't need the narrower entry;
//      dropping it keeps the parent set readable in
//      `/perms inspect`.
//
// Result: parent capabilities reflect what the operator
// authorized AT THE SCOPE LEVEL. A subagent declaring
// `read-fs:/etc/passwd` doesn't slip through just because
// read_file has any allow rule — the declared scope must lie
// inside an `allow_paths` entry (or under a universal bash
// footprint, if bash is allowed).
//
// `bash` remains the broadest section — its command-shaped
// `allow` can't be projected into path scopes without re-parsing
// shell, so each kind in the bash footprint emits at universal
// scope. A policy that opens bash explicitly accepts that breadth.
import type { Policy } from './types.ts';

export const TOOL_CAPABILITY_FOOTPRINTS: Record<
  keyof NonNullable<Policy['tools']>,
  readonly CapabilityKind[]
> = {
  bash: ['exec', 'read-fs', 'write-fs', 'delete-fs', 'net-egress', 'git-write'],
  read_file: ['read-fs'],
  write_file: ['read-fs', 'write-fs'],
  edit_file: ['read-fs', 'write-fs'],
  glob: ['read-fs'],
  grep: ['read-fs'],
  fetch_url: ['net-egress'],
};

// True when a policy section has any allow-shaped rule. The
// presence of allow / allow_paths / allow_hosts signals operator
// intent to enable some workload of that kind; absence (or
// confirm/deny only) means "no path through this section that the
// parent uses without prompting" → don't delegate. Conservative.
const hasAllowRule = (
  section: NonNullable<Policy['tools']>[keyof NonNullable<Policy['tools']>] | undefined,
): boolean => {
  if (section === undefined) return false;
  // BashPolicy.allow
  if (Array.isArray((section as { allow?: readonly string[] }).allow)) {
    return ((section as { allow?: readonly string[] }).allow?.length ?? 0) > 0;
  }
  // PathPolicy.allow_paths
  if (Array.isArray((section as { allow_paths?: readonly string[] }).allow_paths)) {
    return ((section as { allow_paths?: readonly string[] }).allow_paths?.length ?? 0) > 0;
  }
  // FetchPolicy.allow_hosts
  if (Array.isArray((section as { allow_hosts?: readonly string[] }).allow_hosts)) {
    return ((section as { allow_hosts?: readonly string[] }).allow_hosts?.length ?? 0) > 0;
  }
  return false;
};

// Universal scope per kind. `exec` is a hierarchy enum (`shell` /
// `python` / `node` / `arbitrary`); `**` isn't a valid exec class
// and wouldn't cover `python` under `capabilityCovers`. The umbrella
// is `arbitrary`. Every other scoped kind uses path/host-shaped
// scopes that DO honor `**` (per `capabilityCovers` literal-and-
// glob coverage).
const universalScopeFor = (kind: CapabilityKind): string | null => {
  if (KINDS_WITHOUT_SCOPE.has(kind)) return null;
  if (kind === 'exec') return 'arbitrary';
  return '**';
};

// Scope-shaped allow entries for a (section, kind) pair, or `null`
// when the section's allow rules don't project into this kind's
// scope grammar (so the caller should emit universal).
//
// - PathPolicy.allow_paths feeds fs kinds (read-fs/write-fs). Other
//   kinds in the footprint (none today for path sections) would
//   stay universal.
// - FetchPolicy.allow_hosts feeds net-egress. Other kinds aren't
//   in the fetch footprint.
// - BashPolicy.allow is command-shaped, never scope-shaped. Returns
//   `null` for every kind so bash's footprint stays universal.
const getSectionScopes = (
  section: NonNullable<Policy['tools']>[keyof NonNullable<Policy['tools']>] | undefined,
  kind: CapabilityKind,
): readonly string[] | null => {
  if (section === undefined) return null;
  const allowPaths = (section as { allow_paths?: readonly string[] }).allow_paths;
  if (Array.isArray(allowPaths) && allowPaths.length > 0) {
    if (kind === 'read-fs' || kind === 'write-fs' || kind === 'delete-fs') {
      return allowPaths;
    }
    return null;
  }
  const allowHosts = (section as { allow_hosts?: readonly string[] }).allow_hosts;
  if (Array.isArray(allowHosts) && allowHosts.length > 0) {
    if (kind === 'net-egress') return allowHosts;
    return null;
  }
  return null;
};

// Drop any cap in `caps` that is covered by SOME OTHER cap in the
// same list. Mutually-covering pairs can't survive earlier dedupe
// (formatted form is unique), so this filter only ever removes
// strictly narrower caps. Keeps the parent set readable: a policy
// with `bash` allow + `read_file.allow_paths: ['src/**']` renders
// `read-fs:**` only, not `read-fs:**` + `read-fs:src/**`.
const subsumeCovered = (caps: readonly Capability[]): Capability[] =>
  caps.filter((c) => !caps.some((p) => p !== c && capabilityCovers(p, c)));

// Build the parent capability snapshot at spawn time. Emits scope
// from `allow_paths` / `allow_hosts` when the section is scope-
// shaped; otherwise emits universal per kind. Dedupes by formatted
// form, then subsumes covered caps so the rendered set has no
// redundant narrowings.
export const deriveParentCapabilities = (policy: Policy): Capability[] => {
  const raw: Capability[] = [];
  const sections = Object.keys(
    TOOL_CAPABILITY_FOOTPRINTS,
  ) as (keyof typeof TOOL_CAPABILITY_FOOTPRINTS)[];
  for (const key of sections) {
    const section = policy.tools[key];
    if (!hasAllowRule(section)) continue;
    for (const kind of TOOL_CAPABILITY_FOOTPRINTS[key]) {
      const scopes = getSectionScopes(section, kind);
      if (scopes === null) {
        raw.push({ kind, scope: universalScopeFor(kind) });
      } else {
        for (const scope of scopes) {
          raw.push({ kind, scope });
        }
      }
    }
  }
  const seen = new Set<string>();
  const deduped: Capability[] = [];
  for (const c of raw) {
    const k = formatCapability(c);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(c);
  }
  return subsumeCovered(deduped);
};

export const readFs = (scope: string): Capability => ({ kind: 'read-fs', scope });
export const writeFs = (scope: string): Capability => ({ kind: 'write-fs', scope });
export const deleteFs = (scope: string): Capability => ({ kind: 'delete-fs', scope });
export const exec = (cls: 'shell' | 'python' | 'node' | 'arbitrary'): Capability => ({
  kind: 'exec',
  scope: cls,
});
export const netEgress = (host: string): Capability => ({ kind: 'net-egress', scope: host });
export const netIngress = (port: string): Capability => ({ kind: 'net-ingress', scope: port });
export const secretAccess = (store: string): Capability => ({
  kind: 'secret-access',
  scope: store,
});
export const gitWrite = (repo: string): Capability => ({ kind: 'git-write', scope: repo });
export const envMutate = (): Capability => ({ kind: 'env-mutate', scope: null });
export const agentMutate = (): Capability => ({ kind: 'agent-mutate', scope: null });
export const hostPassthrough = (): Capability => ({ kind: 'host-passthrough', scope: null });
