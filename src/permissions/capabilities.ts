// Canonical capability model per PERMISSION_ENGINE.md §3.
//
// The engine reasons about WHAT a tool will consume (read a file,
// write a file, exec a process, reach a host) instead of opaque
// tool names. A capability has a `kind` (drawn from §3.1) and an
// optional `scope` whose grammar depends on the kind:
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
// Capability VALIDATION (does the scope satisfy the grammar from
// §4) lands when capability-based static rules ship — until then,
// the resolvers produce well-formed strings by construction.

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
// rest require a scope (`read-fs:./src/**`, `exec:shell`).
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
  // Scope value verbatim. `null` for the scope-less kinds (§3.1
  // table). Resolver authors should keep scopes textually stable
  // (resolved abs path or canonical host) so two equivalent emits
  // produce identical capability strings — chain hash determinism
  // depends on it.
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

// Convenience helpers for resolver authors. Read most resolvers as:
//   readFs(path) → { kind: 'read-fs', scope: path }
// instead of literal object literals — keeps shape consistent.
// Does a `parent` capability cover a `child` capability per
// PERMISSION_ENGINE.md §10.1 ("declared_caps ⊆ parent_caps")?
// Coverage rules (deliberately small — extending the surface
// requires a spec PR + conformance case):
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
// Rules 4.c handles the common policy idiom (`read-fs:src/**`
// covers `read-fs:src/index.ts`) without bringing in a full
// glob-vs-glob containment solver. The slice 9 spec PR records this
// minimal-but-sound stance; broader patterns escalate to a future
// slice with a real subset checker.
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

// Apply the §10.1 intersection rule. Each `declared` capability that
// IS covered by some `parent` capability survives into `effective`;
// anything NOT covered lands in `excess`. The caller decides the
// outcome (the spec says ANY excess → deny with `subagent_escalation`),
// but exposing both arrays keeps the primitive composable.
//
// Behavior on empty inputs:
//   - declared=[] → effective=[], excess=[]. Spec §10.1 maps this to
//     "subagent receives NO capability" (pure-LLM); the empty
//     effective list is exactly that signal.
//   - parent=[] AND declared=[X, Y] → effective=[], excess=[X, Y].
//     Every declared capability is unbacked.
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
