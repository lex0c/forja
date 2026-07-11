import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Boot-time trigger evaluation (spec MEMORY.md §4.3).
//
// Spec §4.3 lists three trigger types in its examples table:
//
//   | Trigger                       | What loads                          |
//   |-------------------------------|-------------------------------------|
//   | `git commit` mentioned        | feedback memories with tag `git`    |
//   | Directory with `.env`         | feedback memories with tag `secrets`|
//   | Tool `bash` called            | feedback memories with tag `bash`   |
//
// The triggers fall into TWO categories:
//
//   1. BOOT-TIME (filesystem state when the session starts):
//      `.env` present, AGENTS.md present, `.git` directory
//      present, `package.json` present, etc. Evaluable
//      synchronously at bootstrap, no harness-loop hook required.
//
//   2. RUNTIME (events DURING the session): user message
//      mentioning a phrase, a tool call firing, a checkpoint
//      created. These need a hook in the harness loop so each
//      event gets a chance to lazy-load matching memories.
//
// This module covers boot-time triggers only. Runtime triggers
// land in a follow-up that grows the harness-loop hook surface
// (per spec §6.4 PreCompact / §6.3 slash commands seam). The
// frontmatter `triggers:` field is shared between both — operators
// list whichever tags apply (boot or runtime), and each layer
// matches its own.
//
// Trigger NAMING convention: kebab-case-strings, validated by
// frontmatter.ts (`TRIGGER_RE = /^[a-z0-9][a-z0-9_-]*$/`). The set
// of "well-known" boot triggers is closed at this module — operator-
// defined triggers that don't match any well-known name simply never
// fire. We don't error on unknown triggers because (a) they may match
// a future runtime trigger that lands later, and (b) they may be tags
// the operator wants for their own /memory list filters.

// Closed set of triggers this module evaluates. Operator triggers
// that don't appear here pass through to the registry but never
// match the boot context — they're "documented but inactive at
// boot". Adding a new well-known trigger is a one-line append to
// `TRIGGER_PROBES`; the type and the `ALL_BOOT_TRIGGERS` lookup
// derive from there so the three pieces can't drift.
export type BootTrigger = 'git' | 'env' | 'package' | 'agents-md' | 'tsconfig' | 'cargo';

// Probe table. Each entry is `[trigger, relativePath]`. `existsSync`
// is fine for these — single fixed paths under cwd, and the call is
// one-shot per session boot. ENOENT / EACCES → false (trigger not
// fired); other surprising errors propagate, which is the right
// answer (operator should see disk-level failures).
//
// SOURCE OF TRUTH for the well-known trigger set: this table
// drives both `evaluateBootTriggers` (which probes the cwd) and
// the `ALL_BOOT_TRIGGERS` lookup that `shouldEagerLoadByTriggers`
// uses to classify operator-supplied trigger tags.
const TRIGGER_PROBES: ReadonlyArray<readonly [BootTrigger, string]> = [
  ['git', '.git'],
  ['env', '.env'],
  ['package', 'package.json'],
  ['agents-md', 'AGENTS.md'],
  ['tsconfig', 'tsconfig.json'],
  ['cargo', 'Cargo.toml'],
];

// Derived from TRIGGER_PROBES so a hand-edit can't desync the type
// union, the probe table, and the lookup. `Set` for O(1) `has`
// checks in `shouldEagerLoadByTriggers`.
const ALL_BOOT_TRIGGERS: ReadonlySet<BootTrigger> = new Set(TRIGGER_PROBES.map(([name]) => name));

export interface BootContext {
  // Set of triggers that fired at boot. Frozen after construction
  // — the consumer (`assembleMemorySection`) is the only reader,
  // and treating it as immutable matches the read-only nature of
  // the data (filesystem state at one specific moment).
  triggers: ReadonlySet<BootTrigger>;
}

// Empty context — no triggers fired. Useful for tests and for
// callers that want to bypass trigger filtering entirely.
export const EMPTY_BOOT_CONTEXT: BootContext = {
  triggers: new Set(),
};

// Build a BootContext from a working directory. Synchronous — runs
// during bootstrap, before the harness wires anything async.
//
// `.env` probe is intentionally NOT recursive: a per-subdirectory
// `.env` doesn't trigger `secrets` memories at boot because the
// session's cwd defines the root. Operator who wants subtree-aware
// matches uses runtime triggers when those land.
//
// Trigger evaluation is "any-match across well-known triggers".
// Operator memories with multiple triggers (e.g., `triggers: [git,
// bash]`) match if EITHER context entry fires — a memory tagged
// for git activity AND bash activity loads when either is present.
// This matches the spec's example where a single feedback memory
// might apply across multiple workflow contexts.
export const evaluateBootTriggers = (cwd: string): BootContext => {
  const triggers = new Set<BootTrigger>();
  for (const [name, rel] of TRIGGER_PROBES) {
    if (existsSync(join(cwd, rel))) triggers.add(name);
  }
  return { triggers };
};

// Given a memory's `triggers:` frontmatter list and a boot context,
// decide whether the memory should eager-load. Three rules, in
// order:
//
//   1. Memory has NO `triggers:` field (or empty array): UNCONDITIONAL
//      eager-load.
//   2. Memory has triggers but ALL of them are unknown to this
//      module (operator-defined runtime tags): UNCONDITIONAL.
//      The operator chose to tag the memory for runtime-only;
//      until the runtime trigger machinery lands, "documented but
//      inactive at boot" means "unconditional at boot" — silently
//      hiding the memory until runtime would surprise the operator.
//   3. Memory has at least one well-known boot trigger: load IFF
//      any of those well-known triggers fired in the context.
//      Mixed lists (well-known + operator-defined) match on the
//      well-known half; the operator-defined half is ignored at
//      boot.
//
// Rule 2 is the conservative choice. Alternative: hide memories
// with any non-empty triggers list whose triggers don't all fire.
// That's stricter but creates a foot-gun: an operator who tags
// `triggers: [my-custom-runtime-tag]` would silently lose the
// memory from base context until they realize boot-time
// evaluation doesn't know that tag. Rule 2 keeps such memories
// visible by default; the operator can move them to a runtime
// trigger when the surface lands.
export const shouldEagerLoadByTriggers = (
  memTriggers: readonly string[] | undefined,
  ctx: BootContext,
): boolean => {
  if (memTriggers === undefined || memTriggers.length === 0) return true;
  const wellKnown = memTriggers.filter((t): t is BootTrigger =>
    ALL_BOOT_TRIGGERS.has(t as BootTrigger),
  );
  if (wellKnown.length === 0) {
    // All triggers are operator-defined runtime tags; let the
    // memory through unconditionally at boot.
    return true;
  }
  return wellKnown.some((t) => ctx.triggers.has(t));
};
