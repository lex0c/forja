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
//   env-mutate / forja-mutate /
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
  | 'forja-mutate'
  | 'host-passthrough';

// Whether the kind carries a scope component. Scope-less kinds
// stand alone (`env-mutate` is the full capability string); the
// rest require a scope (`read-fs:src/**`, `exec:shell`).
const KINDS_WITHOUT_SCOPE: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  'env-mutate',
  'forja-mutate',
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
  'forja-mutate',
  'host-passthrough',
]);

// Path-shaped fs kinds whose scope is a filesystem path/glob. A `..`
// segment in these scopes is a directory-traversal escape; the
// string-prefix coverage check in `capabilityCovers` is blind to
// it, so the traversal guard there refuses coverage for any such
// scope. Mirrors `FS_KINDS` used on the enforcement side.
const PATH_SCOPED_KINDS: ReadonlySet<CapabilityKind> = new Set<CapabilityKind>([
  'read-fs',
  'write-fs',
  'delete-fs',
]);

// True when a path scope contains a `..` traversal segment in any
// position: bare `..`, leading `../`, embedded `/../`, or trailing
// `/..`. Used only by the spawn-time string-coverage guard; the
// enforcement side canonicalizes instead.
const hasTraversalSegment = (scope: string): boolean => {
  // Treat both separators as delimiters so MIXED forms
  // (`src/..\secret`, `src\..//secret`) are caught: on Windows
  // `node:path` collapses `..` regardless of which slash bounds it,
  // so enumerating only same-separator forms (`/../`, `\..\`) would
  // miss `/..\` and re-open the very escape this guards. Normalize
  // every backslash to a forward slash first, then one set of
  // forward-slash checks covers all combinations.
  const s = scope.replace(/\\/g, '/');
  return s === '..' || s.startsWith('../') || s.includes('/../') || s.endsWith('/..');
};

export interface Capability {
  kind: CapabilityKind;
  // Scope value verbatim. `null` for the scope-less kinds.
  // Resolver authors should keep scopes textually stable (resolved
  // abs path or canonical host) so two equivalent emits produce
  // identical capability strings — chain hash determinism depends
  // on it.
  scope: string | null;
  // OPTIONAL planner hint, meaningful ONLY for `net-egress`. When true, the
  // egress is the command's EXPLICIT, user-invoked purpose (an explicit network
  // tool — `ssh host <cmd>`, curl, scp), NOT egress incidental to a local build.
  // The sandbox build-egress trust-gate (sandbox-plan.ts) strips incidental
  // egress in an untrusted dir but EXEMPTS explicit egress, so an `ssh host cmd`
  // — which ALSO carries `exec:arbitrary` for the remote command, and would
  // otherwise look identical to a dep-manager build — still connects untrusted.
  // In-memory ONLY: not part of `formatCapability` / the chain hash / policy
  // matching (those key on `kind:scope`). Default (omitted) ⇒ gateable
  // (fail-closed: a forgotten mark over-restricts, never leaks egress).
  explicitEgress?: boolean;
  // OPTIONAL posture hint, meaningful ONLY for `git-write`. When true, the git
  // operation publishes to the NETWORK (`push`, `pull`, `clone`), rewrites
  // HISTORY (`commit`/`merge`/`rebase`/`cherry-pick` — which also run repo
  // hooks), or DISCARDS uncommitted work (`reset --hard`, `checkout -f`,
  // `checkout -- <path>`, `restore`, `clean -fd`, `branch -D`, `tag -d`). The
  // autonomous posture (AGENTIC_CLI.md §8.1) auto-approves a LOCAL,
  // non-destructive `git-write` (`add`, `stash`, `switch`, `fetch`) and keeps
  // the modal for these.
  //
  // Why a flag and not a capability kind: no capability separates the pairs the
  // operator wants separated. `curl` and `git push` both emit `net-egress`;
  // `bun install` and `git commit` both emit `exec:arbitrary`. The distinction
  // is the VERB (and sometimes its flags — `reset` vs `reset --hard`), which
  // only the resolver knows. Same in-memory-only posture as `explicitEgress`:
  // absent from `formatCapability` / the chain hash / policy matching.
  //
  // Default (omitted) ⇒ non-destructive, so the resolver must opt IN. That
  // inverts `explicitEgress`'s fail-closed direction — a FORGOTTEN mark here
  // auto-approves rather than over-restricts — so `cmdGit`'s `default` branch
  // (any git verb nobody classified) stamps `destructive: true` explicitly.
  destructive?: boolean;
}

export const isCapabilityKind = (s: string): s is CapabilityKind => ALL_KINDS.has(s);

// The closed set of valid kinds, in stable declaration order. Exported as
// the SINGLE SOURCE for the "unknown kind" error below and the task tools'
// capability-arg description, so the model sees the allowlist instead of
// inventing kinds by analogy (a model declared `env-read` from the read-fs /
// env-mutate examples — there is no env-read; reading env is not a gated
// capability). Derived from ALL_KINDS, not a second hardcoded list, so the
// two cannot drift.
export const CAPABILITY_KINDS: readonly CapabilityKind[] = [...ALL_KINDS] as CapabilityKind[];

// Reusable suffix for the unknown-kind errors: turns a dead-end "unknown
// kind 'x'" into a self-correcting hint the model can act on next try.
const VALID_KINDS_HINT = `valid kinds: ${CAPABILITY_KINDS.join(', ')}`;

// Sentinel scope emitted when a scoped capability is constructed
// with `scope === null`. The pre-fix path emitted `<kind>:*`
// (wildcard), which silently WIDENED authorization — exactly the
// opposite of "fail-closed". `<invalid>` is intentionally chosen to
// be (a) auditable: grepable in `capabilities_json` for postmortems
// asking "did the bug ship?"; (b) refuse-by-construction:
// `capabilityCovers` short-circuits to false when either side
// carries the sentinel, so a buggy-emitted cap never covers a
// requested action and a permissive `kind:**` policy never covers
// the buggy cap either.
//
// Bug shape that produces this: a resolver builds
// `{ kind: 'read-fs', scope: null }` instead of the correct
// `readFs(path)`. Pre-fix wire form was `read-fs:*` (silent
// widen); post-fix is `read-fs:<invalid>` (refuse + audit signal).
export const INVALID_SCOPE_SENTINEL = '<invalid>';

// Format a capability into its canonical wire form. Scope-less
// kinds stand alone; scoped kinds use `kind:scope` with no whitespace
// on either side. The colon is the first occurrence — scope values
// themselves may legitimately contain `:` (port ranges, identity
// paths) and we don't escape them.
export const formatCapability = (c: Capability): string => {
  if (KINDS_WITHOUT_SCOPE.has(c.kind)) return c.kind;
  if (c.scope === null) {
    // Programming bug: scoped kind constructed without a scope.
    // Emit the sentinel; downstream coverage checks refuse to
    // match this on either side (see INVALID_SCOPE_SENTINEL doc).
    return `${c.kind}:${INVALID_SCOPE_SENTINEL}`;
  }
  return `${c.kind}:${c.scope}`;
};

// Example scope for the "requires a scope" errors, so a scope-missing
// message is self-correcting instead of a dead-end. Path kinds get the
// /** form (the directory-coverage footgun a bare path falls into);
// exec/net get a representative scope.
const scopeExampleFor = (kind: CapabilityKind): string => {
  if (PATH_SCOPED_KINDS.has(kind)) return `${kind}:/abs/dir/**`;
  if (kind === 'exec') return `${kind}:shell`;
  if (kind === 'net-egress') return `${kind}:example.com`;
  if (kind === 'net-ingress') return `${kind}:8080`;
  return `${kind}:<scope>`;
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
      throw new Error(`capability: unknown kind '${s}' — ${VALID_KINDS_HINT}`);
    }
    if (!KINDS_WITHOUT_SCOPE.has(s)) {
      throw new Error(`capability: kind '${s}' requires a scope, e.g. '${scopeExampleFor(s)}'`);
    }
    return { kind: s, scope: null };
  }
  const kind = s.slice(0, colon);
  const scope = s.slice(colon + 1);
  if (!isCapabilityKind(kind)) {
    throw new Error(`capability: unknown kind '${kind}' — ${VALID_KINDS_HINT}`);
  }
  if (KINDS_WITHOUT_SCOPE.has(kind)) {
    throw new Error(`capability: kind '${kind}' must not carry a scope (got '${scope}')`);
  }
  if (scope.length === 0) {
    throw new Error(
      `capability: kind '${kind}' requires a non-empty scope, e.g. '${scopeExampleFor(kind)}'`,
    );
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
//   2. Scope-less kinds (env-mutate, forja-mutate, host-passthrough):
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
  // Invalid-scope sentinel: refuse on either side. A buggy-emitted
  // child cap (scope=null → wire form `<kind>:<invalid>` → re-parsed
  // here as scope='<invalid>') must not be covered by a permissive
  // policy like `kind:**`, and a buggy parent cap must not cover a
  // legitimate child. See INVALID_SCOPE_SENTINEL doc for the rationale.
  if (pScope === INVALID_SCOPE_SENTINEL || cScope === INVALID_SCOPE_SENTINEL) return false;

  // Traversal guard (R5 P0-Bypass-3): a `..` segment in a
  // path-shaped scope makes string-prefix coverage UNSOUND. The
  // spawn-time intersection runs this string-only check against
  // the declared scope verbatim — no canonicalization — so a child
  // declaring `read-fs:src/../../secret` textually starts with the
  // parent prefix `src/` and slips into `effective`, then the
  // child engine's `capabilityCoversCwdAware` canonicalizes it to
  // `<cwd>/../secret` and grants a read OUTSIDE the parent's
  // `src/**` grant — privilege escalation across the spawn
  // boundary. The asymmetry: enforcement canonicalizes, the spawn
  // gate did not. Fail closed here — a scope with `..` cannot be
  // proven covered by string matching, so it lands in `excess` and
  // refuses the spawn. Policy-derived parent scopes never carry
  // `..` (authored globs); a declared child scope that wants a
  // sibling tree must name it without traversal.
  if (PATH_SCOPED_KINDS.has(parent.kind)) {
    if (hasTraversalSegment(pScope) || hasTraversalSegment(cScope)) return false;
  }

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

import { resolve as resolvePath } from 'node:path';
import { matchPath } from './matcher.ts';
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
  // Invalid-scope sentinel guard (mirror of capabilityCovers).
  if (pScope === INVALID_SCOPE_SENTINEL || cScope === INVALID_SCOPE_SENTINEL) return false;
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
  // Bare-prefix-dir parity with `capabilityCovers` rule 4.c
  // (`<prefix>/**` covers the bare `<prefix>` dir, not just paths
  // under it). `matchPath('src/**', '<cwd>/src', cwd)` is FALSE —
  // glob `**` matches only paths strictly under `src/`, so the dir
  // root itself is excluded. Without this, a subagent granted
  // `read-fs:src/**` is DENIED any op on `src` itself (`ls src`,
  // a `read_file src` that resolves to the dir, a write that
  // creates `src`), because the resolver emits `read-fs:<cwd>/src`
  // (no trailing slash) and the enforce side wouldn't cover it —
  // while the spawn gate (string-based `capabilityCovers`) DOES.
  // That divergence is the same gate-vs-enforce asymmetry class as
  // the R1 spawn-gate P0; close it here so the two coverage
  // functions agree. Resolve the prefix against cwd so the
  // comparison is in the same absolute space as the resolver-
  // emitted child scope. Sound: covering the root of a granted
  // subtree is exactly what `<prefix>/**` intends.
  if (pScope.endsWith('/**')) {
    const prefix = pScope.slice(0, -3);
    if (prefix.length > 0) {
      const absPrefix = resolvePath(cwd, prefix);
      const absChild = resolvePath(cwd, cScope);
      if (absChild === absPrefix) return true;
    }
  }
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

// When a subagent tool is denied for "outside declared envelope", the
// most common cause is a directory scope declared as a bare path
// (read-fs:/repo) instead of read-fs:/repo/** — the bare form covers
// ONLY that exact path, so every file read inside is uncovered (it
// killed a `general-purpose` explore: denied on every read until
// maxToolErrors). This derives a self-correcting hint for the deny
// message: if some uncovered cap sits under a declared same-kind path
// scope that lacks a trailing glob, suggest the /** form. Returns null
// when no such pattern applies, so the caller appends nothing for
// unrelated denials.
export const bareDirScopeHint = (
  effective: readonly Capability[],
  uncovered: readonly Capability[],
): string | null => {
  for (const u of uncovered) {
    if (!PATH_SCOPED_KINDS.has(u.kind) || u.scope === null) continue;
    for (const e of effective) {
      if (e.kind !== u.kind || e.scope === null) continue;
      // Already a glob/wildcard scope → the bare-dir footgun does not apply.
      if (e.scope.endsWith('*')) continue;
      const base = e.scope.endsWith('/') ? e.scope.slice(0, -1) : e.scope;
      if (base.length > 0 && u.scope.startsWith(`${base}/`)) {
        return `'${formatCapability(e)}' is a bare path that covers only itself — declare '${base}/**' to grant the directory's contents`;
      }
    }
  }
  return null;
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
  // MCP tools are parent-session-scoped (MCP.md §8 — subagent access is a later
  // slice) and not a capability-grant kind, so a `tools.mcp` allow projects NO
  // capability footprint to a subagent.
  mcp: [],
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
  // Bypass mode permits every tool call without an explicit allow rule, so
  // the parent's effective footprint is the UNIVERSAL footprint of every
  // tool. §10.1 ("the subagent inherits the parent's effective set") must
  // reflect that: without this branch a bypass-mode parent derives an EMPTY
  // envelope (bypass never writes the allow rules the loop keys on) and every
  // capability a subagent declares would escalate. Tool-derived kinds only —
  // secret-access / host-passthrough / forja-mutate aren't in any tool
  // footprint, so they stay opt-in even under bypass (they need a profile or
  // sentinel that merely running tools doesn't imply).
  const bypass = policy.defaults.mode === 'bypass';
  const sections = Object.keys(
    TOOL_CAPABILITY_FOOTPRINTS,
  ) as (keyof typeof TOOL_CAPABILITY_FOOTPRINTS)[];
  for (const key of sections) {
    const section = policy.tools[key];
    if (!bypass && !hasAllowRule(section)) continue;
    for (const kind of TOOL_CAPABILITY_FOOTPRINTS[key]) {
      const scopes = bypass ? null : getSectionScopes(section, kind);
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
export const netEgress = (host: string, explicitEgress?: boolean): Capability => ({
  kind: 'net-egress',
  scope: host,
  // Conditional spread: never set `explicitEgress: undefined` (exactOptionalPropertyTypes).
  ...(explicitEgress ? { explicitEgress: true } : {}),
});
export const netIngress = (port: string): Capability => ({ kind: 'net-ingress', scope: port });
export const secretAccess = (store: string): Capability => ({
  kind: 'secret-access',
  scope: store,
});
export const gitWrite = (repo: string, destructive?: boolean): Capability => ({
  kind: 'git-write',
  scope: repo,
  // Conditional spread: never set `destructive: undefined` (exactOptionalPropertyTypes).
  ...(destructive ? { destructive: true } : {}),
});
export const envMutate = (): Capability => ({ kind: 'env-mutate', scope: null });
export const forjaMutate = (): Capability => ({ kind: 'forja-mutate', scope: null });
export const hostPassthrough = (): Capability => ({ kind: 'host-passthrough', scope: null });
