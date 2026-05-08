import type { SectionProvenance } from './hierarchy.ts';
import { firstMatchingCommand, firstMatchingHost, firstMatchingPath } from './matcher.ts';
import type {
  BashPolicy,
  Decision,
  FetchPolicy,
  PathPolicy,
  PermissionsView,
  Policy,
  PolicyCategory,
  PolicyLayer,
  PolicyMode,
  PolicySource,
  PolicyToolsSection,
} from './types.ts';

export interface EngineOptions {
  cwd: string;
  // Per-section last-writer tracking from the hierarchy resolver
  // (PolicyLayer in types.ts). When provided, every Decision the
  // engine returns carries `source.layer` populated from the
  // section that fired the rule. Optional to keep test ergonomics
  // (a one-off engine built from a hand-crafted Policy doesn't
  // need to also synthesize provenance) — when absent, every
  // Decision falls back to source.layer='default'.
  provenance?: SectionProvenance;
}

export interface PermissionEngine {
  check(toolName: string, category: PolicyCategory, args: ToolArgs): Decision;
  view(): PermissionsView;
  mode(): PolicyMode;
  // Returns a deep copy of the resolved Policy this engine was
  // built from. Subagent runtime persists the copy on
  // `subagent_runs` so the subprocess child runs under the
  // parent's exact policy even if `.agent/permissions.yaml`
  // etc. are edited mid-run. The deep copy is defensive: a
  // future caller mutating the returned object MUST NOT corrupt
  // the engine's active enforcement state. Cost is negligible
  // (typical policies are sub-10KB) compared to the latent-bug
  // surface a shared reference would expose.
  policy(): Policy;
}

// Loose shape used for argument-shape lookups. The engine reads only the
// fields it knows about per category; unknown fields are ignored. The
// index signature reflects that callers (harness, tests) pass the raw
// tool args which can carry anything (`pattern`, `offset`, etc.).
export interface ToolArgs {
  // bash
  command?: string;
  // fs.* — `path` is the file/dir target for read_file/write_file/edit_file
  // and the optional search root for grep. `cwd` is the optional search
  // root for glob (which has no `path` argument at all).
  path?: string;
  cwd?: string;
  // web.fetch
  url?: string;
  [key: string]: unknown;
}

// Resolves the policy-relevant filesystem target per tool semantics.
// read_file/write_file/edit_file all operate on a single `path`. grep
// and glob are search tools whose effective root differs:
//   - grep: `args.path` (optional; defaults to session cwd)
//   - glob: `args.cwd` (optional; defaults to session cwd; the `pattern`
//     argument defines what's matched, not what's allowed)
//
// Tool args come from model-emitted JSON via `as ToolArgs`; the TS
// shape isn't enforced at runtime. A field that should be a string can
// land here as a number, array, or object. We type-guard before
// returning — passing a non-string to path matching would throw
// ERR_INVALID_ARG_TYPE inside path.resolve, which the harness catches
// as `internalError` and reports as a SQLite-class failure. The right
// behavior is a clean policy deny.
//
// Distinction:
//   - field omitted → fall back to session cwd (grep/glob only;
//     read_file/write_file/edit_file still require the field)
//   - field present but wrong type → null → caller emits deny
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const resolveFsTarget = (toolName: string, args: ToolArgs, cwd: string): string | null => {
  if (toolName === 'glob') {
    if (args.cwd === undefined) return cwd;
    return isNonEmptyString(args.cwd) ? args.cwd : null;
  }
  if (toolName === 'grep') {
    if (args.path === undefined) return cwd;
    return isNonEmptyString(args.path) ? args.path : null;
  }
  return isNonEmptyString(args.path) ? args.path : null;
};

// Resolve the layer that holds a given tools section, falling back
// to 'default' when no layer wrote it (or provenance was absent —
// test-built engines may skip provenance entirely). Return type
// pulled from `PolicyLayer` (not a hand-spelled literal union) so
// adding a future layer (e.g. CLI runtime override) automatically
// flows through here without a silent drift.
const sectionLayer = (
  provenance: SectionProvenance | undefined,
  key: keyof PolicyToolsSection,
): PolicyLayer => {
  if (provenance === undefined) return 'default';
  return provenance[key] ?? 'default';
};

const denyDefault = (toolName: string, mode: PolicyMode, source: PolicySource): Decision => ({
  kind: 'deny',
  reason: `no policy rule matched for ${toolName} (mode=${mode})`,
  source,
});

const checkBash = (
  toolName: string,
  args: ToolArgs,
  rules: BashPolicy | undefined,
  mode: PolicyMode,
  provenance: SectionProvenance | undefined,
): Decision => {
  const command = args.command;
  if (typeof command !== 'string' || command.length === 0) {
    // Engine-internal reject (missing arg). No policy was
    // consulted — source.layer='default' so the modal doesn't
    // mislead the operator into editing the wrong YAML.
    return {
      kind: 'deny',
      reason: `${toolName}: missing 'command' argument`,
      source: { layer: 'default' },
    };
  }

  const layer = sectionLayer(provenance, 'bash');

  // Deny rules win over allow/confirm regardless of mode (including bypass-
  // outside-callers, though `bypass` itself short-circuits earlier).
  const denied = firstMatchingCommand(rules?.deny, command);
  if (denied !== null) {
    return {
      kind: 'deny',
      reason: `bash command matched deny rule: ${denied}`,
      source: { layer, rule: denied, section: 'bash' },
    };
  }
  const allowed = firstMatchingCommand(rules?.allow, command);
  if (allowed !== null) {
    return {
      kind: 'allow',
      reason: `bash command matched allow rule: ${allowed}`,
      source: { layer, rule: allowed, section: 'bash' },
    };
  }
  const confirm = firstMatchingCommand(rules?.confirm, command);
  if (confirm !== null) {
    return {
      kind: 'confirm',
      prompt: `Run bash: ${command}`,
      reason: `matched confirm rule: ${confirm}`,
      source: { layer, rule: confirm, section: 'bash' },
    };
  }
  // Default-deny: no rule matched. `layer` still reflects which
  // YAML holds the bash section (so operator knows where to add
  // an allow rule), or 'default' when no layer declared bash at
  // all. Section name set so `/perms why` can point operator at
  // tools.bash.
  return denyDefault(toolName, mode, { layer, section: 'bash' });
};

// Search-tool roots (grep/glob) are policy-allowed when the pattern
// admits a descendant of the root. For example, `allow_paths: ['src/**']`
// and a grep rooted at `src` should pass — the search will only land
// on files under `src`. We probe by appending a synthetic segment to
// the root and matching that. Without this, `src` doesn't match
// `src/**` (the `**` requires at least one path component) and the
// rule is unusable for search tools.
const SYNTHETIC_DESCENDANT = '.forja-check';

const isSearchTool = (toolName: string): boolean => toolName === 'grep' || toolName === 'glob';

const matchTargetForRules = (toolName: string, path: string): string =>
  isSearchTool(toolName) ? `${path}/${SYNTHETIC_DESCENDANT}` : path;

const checkPath = (
  toolName: string,
  args: ToolArgs,
  rules: PathPolicy | undefined,
  mode: PolicyMode,
  cwd: string,
  isWrite: boolean,
  provenance: SectionProvenance | undefined,
  sectionKey: keyof PolicyToolsSection,
): Decision => {
  const path = resolveFsTarget(toolName, args, cwd);
  if (path === null) {
    return {
      kind: 'deny',
      reason: `${toolName}: missing or non-string path argument`,
      source: { layer: 'default' },
    };
  }

  const layer = sectionLayer(provenance, sectionKey);
  const sectionName = sectionKey;

  // For search-tool roots we also need to check the literal path against
  // deny rules — a `deny_paths: ['secrets/**']` should block grep rooted
  // at `secrets`, not just descendants. Run deny against both forms and
  // refuse on either match.
  const matchTarget = matchTargetForRules(toolName, path);
  const deniedLiteral = isSearchTool(toolName)
    ? firstMatchingPath(rules?.deny_paths, path, cwd)
    : null;
  const denied = firstMatchingPath(rules?.deny_paths, matchTarget, cwd) ?? deniedLiteral;
  if (denied !== null) {
    return {
      kind: 'deny',
      reason: `path matched deny rule: ${denied}`,
      source: { layer, rule: denied, section: sectionName },
    };
  }
  const allowed = firstMatchingPath(rules?.allow_paths, matchTarget, cwd);
  if (allowed !== null) {
    return {
      kind: 'allow',
      reason: `path matched allow rule: ${allowed}`,
      source: { layer, rule: allowed, section: sectionName },
    };
  }
  const confirm = firstMatchingPath(rules?.confirm_paths, matchTarget, cwd);
  if (confirm !== null) {
    // acceptEdits per AGENTIC_CLI §8: "aceita edits sem confirmação".
    // For writes, a confirm_paths match becomes an auto-allow — that IS
    // the convenience the mode promises. Reads still require confirmation.
    if (mode === 'acceptEdits' && isWrite) {
      return {
        kind: 'allow',
        reason: `acceptEdits: matched confirm rule (auto-accepted): ${confirm}`,
        source: { layer, rule: confirm, section: sectionName },
      };
    }
    return {
      kind: 'confirm',
      prompt: `${isWrite ? 'Write to' : 'Read from'} ${path}?`,
      reason: `matched confirm rule: ${confirm}`,
      source: { layer, rule: confirm, section: sectionName },
    };
  }

  // Unmatched paths default-deny in every mode (strict and acceptEdits).
  // acceptEdits skips the confirm step for confirmable writes; it does not
  // open writes to anywhere — that's what `bypass` is for.
  return denyDefault(toolName, mode, { layer, section: sectionName });
};

const checkFetch = (
  toolName: string,
  args: ToolArgs,
  rules: FetchPolicy | undefined,
  mode: PolicyMode,
  provenance: SectionProvenance | undefined,
): Decision => {
  const url = args.url;
  if (typeof url !== 'string' || url.length === 0) {
    return {
      kind: 'deny',
      reason: `${toolName}: missing 'url' argument`,
      source: { layer: 'default' },
    };
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return {
      kind: 'deny',
      reason: `${toolName}: invalid URL '${url}'`,
      source: { layer: 'default' },
    };
  }

  const layer = sectionLayer(provenance, 'fetch_url');
  const denied = firstMatchingHost(rules?.deny_hosts, host);
  if (denied !== null) {
    return {
      kind: 'deny',
      reason: `host matched deny rule: ${denied}`,
      source: { layer, rule: denied, section: 'fetch_url' },
    };
  }
  const allowed = firstMatchingHost(rules?.allow_hosts, host);
  if (allowed !== null) {
    return {
      kind: 'allow',
      reason: `host matched allow rule: ${allowed}`,
      source: { layer, rule: allowed, section: 'fetch_url' },
    };
  }
  return denyDefault(toolName, mode, { layer, section: 'fetch_url' });
};

// Resolve the policy section name for a tool. The mapping is mostly
// identity (`read_file` → `tools.read_file`, `bash` → `tools.bash`),
// but the bash family — `bash`, `bash_background`, `bash_output`,
// `bash_kill` — all share `tools.bash` so an operator writes one
// allow/deny list instead of duplicating across four sections.
//
// The policy section is selected per-category, not per-tool: every
// bash-category tool reads `tools.bash`. fs.* and web.fetch keep
// their per-tool lookup because their semantics already differ
// (read_file's allow_paths != write_file's allow_paths).
//
// Returns `undefined` for `misc` (no policy section consulted). Both
// `lookupRules` and source attribution route through this single
// helper — without the unified path, a future fs.* tool whose name
// diverged from its policy section would still match `lookupRules`
// (which casts to string) but produce a bogus `provenance[key]`
// lookup at the source-attribution site, silently mis-attributing
// the rule's layer.
const policySectionFor = (
  toolName: string,
  category: PolicyCategory,
): keyof PolicyToolsSection | undefined => {
  if (category === 'bash') return 'bash';
  if (category === 'misc') return undefined;
  // fs.read / fs.write / web.fetch — section key is the literal
  // tool name. The cast asserts the tool's name is a known section
  // key; tools that aren't surface a clean default-deny via
  // lookupRules' undefined rules path. The narrower-than-`string`
  // return type also kills the silent drift risk a string return
  // hid (caller could pass anything to `provenance[key]` and get
  // 'default' back instead of the right layer).
  return toolName as keyof PolicyToolsSection;
};

export const createPermissionEngine = (
  policy: Policy,
  options: EngineOptions,
): PermissionEngine => {
  // Mode is optional on parsed policies (so the resolver can tell
  // "user file was silent" from "user file said strict explicitly")
  // but the engine needs a concrete value. Default to strict — same
  // policy as the empty-file fallback.
  const mode = policy.defaults.mode ?? 'strict';
  const cwd = options.cwd;
  const provenance = options.provenance;

  const check = (toolName: string, category: PolicyCategory, args: ToolArgs): Decision => {
    if (mode === 'bypass') {
      // `bypass` is a defaults-level setting — source.layer points
      // at whichever YAML chose `mode='bypass'` so the operator
      // can find and undo it. No section/rule (mode-driven, not
      // rule-driven).
      return {
        kind: 'allow',
        reason: 'mode=bypass',
        source: { layer: provenance?.defaults ?? 'default' },
      };
    }

    // Single source of truth for section key + rule lookup. Both
    // `lookupRules` (rule matching) and the path/fetch source-
    // attribution branches read `key` here, so a future change to
    // tool→section mapping (e.g. a new fs.* tool routing to a
    // shared section) updates one site instead of two.
    const sectionKey = policySectionFor(toolName, category);
    const sectionRules =
      sectionKey === undefined
        ? undefined
        : (policy.tools as unknown as Record<string, unknown>)[sectionKey];

    switch (category) {
      case 'bash':
        // `sectionKey` is always 'bash' here (policySectionFor
        // collapses the bash family); checkBash hardcodes the
        // section name internally.
        return checkBash(toolName, args, sectionRules as BashPolicy | undefined, mode, provenance);
      case 'fs.read':
        // `sectionKey` is non-undefined for non-misc categories.
        // The non-null assertion is safe (typed branch) and
        // documented at policySectionFor.
        return checkPath(
          toolName,
          args,
          sectionRules as PathPolicy | undefined,
          mode,
          cwd,
          false,
          provenance,
          sectionKey as keyof PolicyToolsSection,
        );
      case 'fs.write':
        return checkPath(
          toolName,
          args,
          sectionRules as PathPolicy | undefined,
          mode,
          cwd,
          true,
          provenance,
          sectionKey as keyof PolicyToolsSection,
        );
      case 'web.fetch':
        return checkFetch(
          toolName,
          args,
          sectionRules as FetchPolicy | undefined,
          mode,
          provenance,
        );
      case 'misc':
        // No category-level policy yet; misc tools must be explicitly
        // safe (no side effects worth gating). Default allow.
        // source.layer='default' — engine-internal decision, no
        // policy section consulted.
        return {
          kind: 'allow',
          reason: 'misc category: no gate applied',
          source: { layer: 'default' },
        };
    }
  };

  const view = (): PermissionsView => ({ mode });

  return {
    check,
    view,
    mode: () => mode,
    // Deep clone via structuredClone — the resolved Policy is
    // pure data (parsed YAML), no functions or DOM references,
    // so structuredClone is both correct and ~µs for realistic
    // sizes. Returning the captured `policy` reference directly
    // would let any caller silently mutate the engine's
    // enforcement state. JSON.parse(JSON.stringify(...)) would
    // also work but loses Date/Map shapes if a future Policy
    // grows them; structuredClone preserves them.
    policy: () => structuredClone(policy),
  };
};
