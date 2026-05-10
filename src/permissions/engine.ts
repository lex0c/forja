import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { AuditEmitInput, AuditSink, ReasonChainEntry } from './audit.ts';
import { createNoopSink } from './audit.ts';
import { canonicalHash } from './canonical.ts';
import { type Capability, formatCapability, sortCapabilities } from './capabilities.ts';
import type { SectionProvenance } from './hierarchy.ts';
import {
  containsShellInjection,
  firstMatchingCommand,
  firstMatchingHost,
  firstMatchingPath,
} from './matcher.ts';
import { type ProtectedTier, classifyProtectedPath } from './protected_paths.ts';
// Importing the resolver index registers every builtin resolver at
// module load. Engine consumers don't need a separate wire-up step.
import { type ResolverResult, resolveCapabilities } from './resolvers/index.ts';
import {
  type EngineState,
  type StateController,
  createStateController,
  isRejectingState,
} from './state-machine.ts';
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
  // Home directory used by `classifyProtectedPath` to resolve
  // tilde-rooted protected targets (~/.bashrc, ~/.config/agent).
  // Default `process.env.HOME ?? cwd` — production bootstrap
  // passes the operator's HOME explicitly so tests can swap it
  // without polluting process.env.
  home?: string;
  // Audit sink. Engine emits one row per `check` before returning.
  // Default `createNoopSink()` so unit tests don't need a SQLite
  // DB; production bootstrap injects `createSqliteSink({ db,
  // identity })`.
  audit?: AuditSink;
  // Session ID stamped on every audit row. Default 'session-anon'
  // for tests; production bootstrap passes the active session id
  // from the harness loop.
  sessionId?: string;
  // Initial state (PERMISSION_ENGINE.md §2). Default `ready` for
  // backward-compatible test ergonomics — every existing test that
  // builds an engine directly keeps working. Production bootstrap
  // injects a `stateController` instead and walks the machine
  // explicitly through init → loading-policy → validating-chain.
  initialState?: EngineState;
  // External state controller. When supplied, the engine reads
  // state from this controller instead of owning its own — letting
  // `bootstrapPermissionEngine` walk transitions before the engine
  // is even constructed. Mutually exclusive with `initialState`;
  // when both are present, the controller wins.
  stateController?: StateController;
}

export interface PermissionEngine {
  check(toolName: string, category: PolicyCategory, args: ToolArgs): Decision;
  view(): PermissionsView;
  mode(): PolicyMode;
  // Current state per PERMISSION_ENGINE.md §2. Bootstrap walks the
  // engine through `init → loading-policy → validating-chain → ready`
  // before exposing it to the harness; runtime can transition between
  // `ready` and `degraded` based on subsystem health, or fall to
  // `refusing` on a fatal event (chain break, policy reload failure
  // in strict mode).
  state(): EngineState;
  // Transition the engine to a degraded state — happens when an
  // auxiliary subsystem (classifier, sandbox, sealing target) goes
  // offline mid-session. `check()` keeps running but every `allow`
  // is upgraded to `confirm`. `reason` lands in the transition event
  // and (future slice) flows into the audit row's reason_chain.
  degrade(reason: string): void;
  // Recover from `degraded` back to `ready`. Inverse of `degrade`.
  // Used when the failing subsystem comes back up.
  restore(reason: string): void;
  // Fatal transition. After `refuse`, every `check` returns deny
  // until the operator builds a new engine (typically via a fresh
  // bootstrap with `--accept-broken-chain` or `--rotate-chain`).
  refuse(reason: string): void;
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
  // Append a pattern to the session-scoped allowlist for the
  // given section. Used by the REPL's "Yes, don't ask again
  // for: <rule>" modal answer — the bridge calls this BEFORE
  // returning true so subsequent calls matching the pattern
  // skip the modal entirely.
  //
  // The pattern semantics depend on the section:
  //   - bash → matched against `args.command` (glob).
  //   - read_file / write_file / edit_file / glob / grep → matched
  //     against the resolved fs target as an `allow_paths` entry.
  //   - fetch_url → matched against the request URL's host as an
  //     `allow_hosts` entry.
  //
  // Session rules consult BEFORE base allow rules, so an operator's
  // session-allow shortcuts past any per-tool confirm rule that
  // would otherwise fire. Deny rules still win.
  //
  // Decisions emitted via a session rule carry
  // `source.layer = 'session'`, so the modal (if it ever pops
  // again — it shouldn't, because the rule allows) and `/perms
  // why` audit can attribute the rule to the runtime override.
  //
  // In-memory only — the engine's session state vanishes when the
  // process exits. Promoting session rules to a persistent layer
  // is a separate slice (TODO: permission ergonomics Tier 5
  // `/perms commit`).
  addSessionAllow(section: keyof PolicyToolsSection, pattern: string): void;
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
// read_file/write_file/edit_file all operate on a single path (named
// `file_path` in slice-3+ tools per Anthropic SDK convention, named
// `path` in the v1 contract). grep and glob are search tools whose
// effective root differs:
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

// Resolve the path arg for non-search tools. Accepts either
// `file_path` (slice-3+ convention) or `path` (v1 contract) — same
// dual-name compat as the FS resolvers.
const filePathOf = (args: ToolArgs): string | null => {
  if (isNonEmptyString(args.file_path)) return args.file_path as string;
  if (isNonEmptyString(args.path)) return args.path;
  return null;
};

const resolveFsTarget = (toolName: string, args: ToolArgs, cwd: string): string | null => {
  if (toolName === 'glob') {
    if (args.cwd === undefined) return cwd;
    return isNonEmptyString(args.cwd) ? args.cwd : null;
  }
  if (toolName === 'grep') {
    if (args.path === undefined) return cwd;
    return isNonEmptyString(args.path) ? args.path : null;
  }
  return filePathOf(args);
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
  sessionAllow: readonly string[] | undefined,
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

  // Deny rules win over everything (including compound commands,
  // session-allow, and bypass — though bypass short-circuits
  // before this fn). Run deny FIRST so a hostile compound like
  // `git status; rm -rf /tmp/*` still gets denied if the literal
  // matches a deny pattern. Operator session-allow can never
  // override a deny.
  const denied = firstMatchingCommand(rules?.deny, command);
  if (denied !== null) {
    return {
      kind: 'deny',
      reason: `bash command matched deny rule: ${denied}`,
      source: { layer, rule: denied, section: 'bash' },
    };
  }

  // Session-allow check: operator's "Yes, don't ask again for:
  // <rule>" promotes a pattern into an in-memory session
  // allowlist. Matches BEFORE the compound guard and the base
  // allowlist so a session-trusted shape skips the modal next
  // time. Deny already ran above. Compound guard is bypassed
  // intentionally — operator explicitly authorized this pattern
  // for the session, the safety net for ACCIDENTAL compounds is
  // the modal that fired the first time.
  const sessionMatched = firstMatchingCommand(sessionAllow, command);
  if (sessionMatched !== null) {
    return {
      kind: 'allow',
      reason: `bash command matched session-allow rule: ${sessionMatched}`,
      source: { layer: 'session', rule: sessionMatched, section: 'bash' },
    };
  }

  // Compound-command guard: glob `*` in an allow pattern admits
  // injection (`git status; <anything>` matches `git status*`).
  // Force confirm on any command containing shell metacharacters
  // (`;`, `&&`, `||`, `|`, `$(...)`, backticks). Operator always
  // sees the literal command for a compound and decides
  // explicitly. Deny rules already ran above; base allow rules
  // are skipped — by design, no base allow pattern can silently
  // admit a compound. Operator who needs a specific compound
  // silenced narrows the policy with a deny exception, runs the
  // commands separately, or session-allows the literal pattern
  // (the path that already cleared the modal once).
  if (containsShellInjection(command)) {
    return {
      kind: 'confirm',
      prompt: `Run bash: ${command}`,
      reason:
        'compound shell command (contains ; && || | $(...) or backticks) — confirming explicitly to surface the literal command',
      source: { layer, section: 'bash' },
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

// Resolve a path to its symlink-followed absolute form for protected
// path classification. Mirrors the matcher's `resolveSymlinks` so a
// symlink at `./safe → /etc/passwd` is caught by the protected check
// just like the matcher catches it for rule matching. realpath fails
// on paths that don't exist (write_file creating a new file); fall
// back to realpathing the parent + joining the basename (catches
// symlink parents) and finally to the textual absolute form.
const resolveForProtected = (rawPath: string, cwd: string): string => {
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
};

const checkPath = (
  toolName: string,
  args: ToolArgs,
  rules: PathPolicy | undefined,
  mode: PolicyMode,
  cwd: string,
  home: string,
  isWrite: boolean,
  provenance: SectionProvenance | undefined,
  sectionKey: keyof PolicyToolsSection,
  sessionAllow: readonly string[] | undefined,
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

  // Protected-path classification per PERMISSION_ENGINE.md §11.
  // Runs against the SYMLINK-RESOLVED absolute form so a symlink
  // inside cwd pointing at /etc/passwd is still classified as
  // protected. Tier `deny` returns immediately (any op, any rule).
  // Tier `escalate` is carried as a flag — if downstream rule
  // lookup produces `allow`, we upgrade it to `confirm` per
  // §11's "write/delete sempre escala pra confirm no mínimo".
  // Reads of escalate-tier paths pass through unchanged.
  const protectedAbsPath = resolveForProtected(path, cwd);
  const protectedTier: ProtectedTier | null = classifyProtectedPath({
    absPath: protectedAbsPath,
    op: isWrite ? 'write' : 'read',
    home,
    cwd,
  });
  if (protectedTier === 'deny') {
    return {
      kind: 'deny',
      reason: `path is in protected zone (deny tier): ${protectedAbsPath}`,
      source: { layer: 'default', section: 'protected' },
    };
  }

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
  // Session-allow check: same semantics as base `allow_paths` but
  // sourced from the operator's runtime "Yes, don't ask again for:
  // <pattern>" answers. Runs before base allow so operator's
  // session decision shortcuts past any base confirm rule that
  // would otherwise fire. Deny already ran above.
  const sessionMatched = firstMatchingPath(sessionAllow, matchTarget, cwd);
  if (sessionMatched !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        prompt: `Write to ${path}? (protected path)`,
        reason: `path matched session-allow '${sessionMatched}' but is in protected zone; escalated to confirm per §11`,
        source: { layer: 'session', rule: sessionMatched, section: sectionName },
      };
    }
    return {
      kind: 'allow',
      reason: `path matched session-allow rule: ${sessionMatched}`,
      source: { layer: 'session', rule: sessionMatched, section: sectionName },
    };
  }
  const allowed = firstMatchingPath(rules?.allow_paths, matchTarget, cwd);
  if (allowed !== null) {
    if (protectedTier === 'escalate') {
      return {
        kind: 'confirm',
        prompt: `Write to ${path}? (protected path)`,
        reason: `path matched allow rule '${allowed}' but is in protected zone; escalated to confirm per §11`,
        source: { layer, rule: allowed, section: sectionName },
      };
    }
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
    // BUT: protected-tier `escalate` paths block the auto-accept —
    // §11's "no mínimo confirm" wins over acceptEdits's convenience.
    if (mode === 'acceptEdits' && isWrite && protectedTier !== 'escalate') {
      return {
        kind: 'allow',
        reason: `acceptEdits: matched confirm rule (auto-accepted): ${confirm}`,
        source: { layer, rule: confirm, section: sectionName },
      };
    }
    return {
      kind: 'confirm',
      prompt: `${isWrite ? 'Write to' : 'Read from'} ${path}?${protectedTier === 'escalate' ? ' (protected path)' : ''}`,
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
  sessionAllow: readonly string[] | undefined,
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
  // Session-allow check: same precedence as the bash/path branches.
  // Pattern matched against the URL host (not the full URL); the
  // base `allow_hosts` semantics carry over.
  const sessionMatched = firstMatchingHost(sessionAllow, host);
  if (sessionMatched !== null) {
    return {
      kind: 'allow',
      reason: `host matched session-allow rule: ${sessionMatched}`,
      source: { layer: 'session', rule: sessionMatched, section: 'fetch_url' },
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

// Map an engine Decision to the discrete audit row enum. The audit
// log distinguishes pre-modal 'confirm' from post-modal 'confirm-
// allowed' / 'confirm-denied' — the post-modal update path lands
// in the modal-bridge slice. Today every `confirm` returned from
// `check()` is the pre-modal form.
const decisionToAuditEnum = (kind: Decision['kind']): 'allow' | 'deny' | 'confirm' => kind;

// Build the reason chain entry for a Decision. Each stage produces
// one entry — for now the engine emits a single entry capturing the
// final stage. Future slices append entries from `resolve`,
// `risk-score`, `classifier`, `sandbox-plan`, `approval-gate` per
// spec §6.
//
// Stage selection order:
//   - 'protected-path' — Decision was produced by §11 (deny or
//     escalate). Detected via `source.section === 'protected'`.
//   - 'session-allow' — operator promoted a rule into the in-memory
//     session allowlist (`source.layer === 'session'`).
//   - 'static-rule' — a configured allow/deny/confirm rule matched
//     (rule literal present in `source`).
//   - 'default-deny' — no rule matched and the engine fell through
//     to default-deny (`kind === 'deny'` AND no rule).
//   - 'engine-default' — engine-internal allow path (bypass mode,
//     misc category) with no rule consulted.
// Upgrade an `allow` Decision into a `confirm` for the degraded path
// (spec §2: "toda decisão `allow` automática vira `confirm`").
// Preserves source attribution so the modal still shows the rule that
// would have fired; the reason explicitly cites the degraded state
// so operators see why a normally-silent allow surfaced as a prompt.
// Non-allow decisions pass through unchanged — degraded never
// downgrades a `deny` or `confirm`.
const degradeAllowToConfirm = (decision: Decision): Decision => {
  if (decision.kind !== 'allow') return decision;
  return {
    kind: 'confirm',
    prompt: 'Engine is in degraded mode — confirm before continuing.',
    reason: `degraded state forced confirm (was: ${decision.reason ?? 'allow'})`,
    ...(decision.source !== undefined ? { source: decision.source } : {}),
  };
};

// Optional reason-chain entry appended when the engine intercepts a
// decision via state. Returns undefined for `ready` so the normal
// chain stays one entry long. Audit row gains a second entry tagged
// `engine-state` whenever degraded forced an upgrade or a non-ready
// state forced a deny.
const degradedStageEntry = (state: EngineState): ReasonChainEntry | undefined => {
  if (state === 'ready') return undefined;
  return { stage: 'engine-state', note: `state=${state}` };
};

// Reason-chain entry for the resolver stage. Fires when the resolver
// forced a confirm upgrade — Conservative or `Ok confidence: low`.
// The note captures the precise cause (resolver's `reason` for
// Conservative; the confidence label for low) so the audit row +
// modal preview show "we forced a confirm because the bash command
// was a compound" or "...because the registry has no resolver for
// tool X" without recomputing from the capability set.
const resolverStageEntry = (result: ResolverResult | null): ReasonChainEntry | undefined => {
  if (result === null) return undefined;
  if (result.kind === 'conservative') {
    return { stage: 'resolve', note: `conservative: ${result.reason}` };
  }
  if (result.kind === 'ok' && result.confidence === 'low') {
    return { stage: 'resolve', note: `confidence=${result.confidence}` };
  }
  return undefined;
};

const reasonChainFor = (decision: Decision): ReasonChainEntry[] => {
  let stage: string;
  if (decision.source?.section === 'protected') {
    stage = 'protected-path';
  } else if (decision.source?.layer === 'session') {
    stage = 'session-allow';
  } else if (decision.source?.rule !== undefined) {
    stage = 'static-rule';
  } else if (decision.kind === 'deny') {
    stage = 'default-deny';
  } else {
    stage = 'engine-default';
  }
  const entry: ReasonChainEntry = { stage };
  if (decision.source?.layer !== undefined) entry.layer = decision.source.layer;
  if (decision.source?.rule !== undefined) entry.rule = decision.source.rule;
  if (decision.source?.section !== undefined) entry.section = decision.source.section;
  if (decision.reason !== undefined) entry.note = decision.reason;
  return [entry];
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
  const home = options.home ?? process.env.HOME ?? cwd;
  const provenance = options.provenance;
  const audit = options.audit ?? createNoopSink();
  const sessionId = options.sessionId ?? 'session-anon';
  // State controller — caller-supplied (production: bootstrap walks
  // init → loading-policy → validating-chain → ready) or built
  // internally with `initialState` (default `ready` for backward
  // test compat). The engine always reads from this controller on
  // every `check` so external transitions (degrade / refuse fired
  // by health-watcher slices) take effect immediately.
  const stateController =
    options.stateController ?? createStateController({ initial: options.initialState ?? 'ready' });
  // policy_hash is stamped on every audit row. Computed ONCE at
  // construction — the policy doesn't change for an engine
  // instance (hot reload is a separate slice that builds a new
  // engine). Canonical hash so two engines with semantically
  // equivalent policies produce the same hash.
  const policyHash = `sha256:${canonicalHash(policy)}`;

  // Session-scoped allowlist: per-section list of patterns the
  // operator promoted via the modal's "Yes, don't ask again
  // for: <rule>" answer. In-memory only — survives the lifetime
  // of this engine instance, vanishes on process exit. The Map
  // grows append-only during a session; rules are NEVER removed
  // (a future `/perms forget` slash would clear them, but for
  // now operator restarts the session to revoke trust).
  const sessionAllow = new Map<keyof PolicyToolsSection, string[]>();

  const emitAudit = (
    toolName: string,
    args: ToolArgs,
    decision: Decision,
    capabilities: readonly Capability[],
    extraStage?: ReasonChainEntry,
  ): void => {
    const chain = reasonChainFor(decision);
    if (extraStage !== undefined) chain.push(extraStage);
    const input: AuditEmitInput = {
      session_id: sessionId,
      tool_name: toolName,
      args,
      decision: decisionToAuditEnum(decision.kind),
      policy_hash: policyHash,
      reason_chain: chain,
      // Canonical sort so the audit row's capabilities_json is
      // byte-stable across runs — chain hash determinism depends on
      // it. Resolver implementation order doesn't leak into the
      // ledger.
      capabilities: sortCapabilities(capabilities).map(formatCapability),
    };
    audit.emit(input);
  };

  const check = (toolName: string, category: PolicyCategory, args: ToolArgs): Decision => {
    // State machine gate (PERMISSION_ENGINE.md §2 + §6 approval-gate).
    // Runs BEFORE bypass and before any rule lookup: an engine in
    // init / loading-policy / validating-chain hasn't proven it can
    // safely decide anything; refusing is the fatal sink. In each
    // of those states return deny with a state-specific reason so
    // the operator (and audit log) sees exactly why. degraded falls
    // through to the normal pipeline but with an allow → confirm
    // upgrade after the decision is built.
    const currentState = stateController.get();
    if (isRejectingState(currentState)) {
      const decision: Decision = {
        kind: 'deny',
        reason: `engine not ready (state=${currentState})`,
        source: { layer: 'default', section: 'engine-state' },
      };
      emitAudit(toolName, args, decision, []);
      return decision;
    }

    // Resolve capabilities (PERMISSION_ENGINE.md §5). Runs BEFORE
    // bypass, before rule lookup — `Refuse` is structural rejection
    // (dynamic eval, malformed args, no-safe-resolution commands
    // like `dd`/`mkfs`) and trumps any allow rule. The resolved
    // capabilities flow into the audit row and into the modal's
    // preview; even a `bypass` mode decision carries an honest
    // capability set so the operator can see what the model
    // intended to consume.
    //
    // `misc` category skips resolution entirely — those tools are
    // declared "no side effects worth gating" and shouldn't pay
    // the resolver cost (or risk a stub-resolver mismatch). They
    // emit with an empty capability list, which is honest about
    // their declared shape.
    let resolverResult: ResolverResult | null = null;
    let resolvedCapabilities: Capability[] = [];
    if (category !== 'misc') {
      resolverResult = resolveCapabilities(toolName, args as Record<string, unknown>, {
        cwd,
        home,
      });
      if (resolverResult.kind === 'refuse') {
        const decision: Decision = {
          kind: 'deny',
          reason: `resolver refused: ${resolverResult.reason}`,
          source: { layer: 'default', section: 'resolver-refuse' },
        };
        emitAudit(toolName, args, decision, []);
        return decision;
      }
      resolvedCapabilities = resolverResult.capabilities;
    }
    // What forces a `confirm` upgrade after the normal pipeline:
    //   - Conservative outcome (the resolver couldn't pin a precise
    //     set; the operator deserves the modal).
    //   - Ok with `confidence: low` (genuinely ambiguous).
    // We intentionally do NOT upgrade on `confidence: medium`.
    // Spec §5.1 says "Confidence < high force human approval", but
    // calibrating that against operator fatigue is the risk-score
    // slice's job — medium covers "well-understood read-only with
    // some uncertainty" (e.g. `find` against a path) and shouldn't
    // pop the modal on every invocation. The slice 3 BACKLOG entry
    // calls this out as an explicit decision to revisit when the
    // scoring formula lands.
    const resolverForcesConfirm =
      resolverResult !== null &&
      (resolverResult.kind === 'conservative' ||
        (resolverResult.kind === 'ok' && resolverResult.confidence === 'low'));

    if (mode === 'bypass') {
      // `bypass` is a defaults-level setting — source.layer points
      // at whichever YAML chose `mode='bypass'` so the operator
      // can find and undo it. No section/rule (mode-driven, not
      // rule-driven).
      //
      // degraded loses the bypass shortcut (spec §2: "toda decisão
      // `allow` automática vira `confirm`"). Resolver-driven
      // confirm is a softer signal — operators who explicitly
      // chose bypass are committing to the broader risk surface,
      // and a Conservative result shouldn't undo that decision.
      // The audit row still carries the resolved capabilities so
      // the row remains a faithful summary of what the tool will
      // touch, even when the decision was `allow`.
      const baseAllow: Decision = {
        kind: 'allow',
        reason: 'mode=bypass',
        source: { layer: provenance?.defaults ?? 'default' },
      };
      const upgraded = currentState === 'degraded' ? degradeAllowToConfirm(baseAllow) : baseAllow;
      emitAudit(toolName, args, upgraded, resolvedCapabilities, degradedStageEntry(currentState));
      return upgraded;
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

    let decision: Decision;
    switch (category) {
      case 'bash':
        // `sectionKey` is always 'bash' here (policySectionFor
        // collapses the bash family); checkBash hardcodes the
        // section name internally.
        decision = checkBash(
          toolName,
          args,
          sectionRules as BashPolicy | undefined,
          mode,
          provenance,
          sessionAllow.get('bash'),
        );
        break;
      case 'fs.read':
        // `sectionKey` is non-undefined for non-misc categories.
        // The non-null assertion is safe (typed branch) and
        // documented at policySectionFor.
        decision = checkPath(
          toolName,
          args,
          sectionRules as PathPolicy | undefined,
          mode,
          cwd,
          home,
          false,
          provenance,
          sectionKey as keyof PolicyToolsSection,
          sessionAllow.get(sectionKey as keyof PolicyToolsSection),
        );
        break;
      case 'fs.write':
        decision = checkPath(
          toolName,
          args,
          sectionRules as PathPolicy | undefined,
          mode,
          cwd,
          home,
          true,
          provenance,
          sectionKey as keyof PolicyToolsSection,
          sessionAllow.get(sectionKey as keyof PolicyToolsSection),
        );
        break;
      case 'web.fetch':
        decision = checkFetch(
          toolName,
          args,
          sectionRules as FetchPolicy | undefined,
          mode,
          provenance,
          sessionAllow.get('fetch_url'),
        );
        break;
      case 'misc':
        // No category-level policy yet; misc tools must be explicitly
        // safe (no side effects worth gating). Default allow.
        // source.layer='default' — engine-internal decision, no
        // policy section consulted.
        decision = {
          kind: 'allow',
          reason: 'misc category: no gate applied',
          source: { layer: 'default' },
        };
        break;
    }
    // Degraded upgrade applied AFTER the normal pipeline so the
    // rule that would have fired keeps its attribution in `source`
    // — the operator sees "rule X matched, but engine is degraded
    // so I'm asking anyway" in the modal. Same shape for
    // resolver-driven upgrade (Conservative or low confidence).
    //
    // Session-allow is intentionally exempt from the resolver
    // upgrade: the operator already saw the modal once for this
    // shape and explicitly authorized it ("Yes, don't ask again
    // for: <rule>"). Resolver Conservative would re-prompt every
    // time — same approval-fatigue regression the session-allow
    // mechanism exists to prevent. degraded state, however, DOES
    // override session-allow: a subsystem-health signal overrides
    // operator trust because the trust was given under the
    // expectation of a healthy engine.
    const sessionAllowed = decision.source?.layer === 'session';
    if (currentState === 'degraded' || (resolverForcesConfirm && !sessionAllowed)) {
      decision = degradeAllowToConfirm(decision);
    }
    const extraStage =
      currentState === 'degraded'
        ? degradedStageEntry(currentState)
        : resolverForcesConfirm && !sessionAllowed
          ? resolverStageEntry(resolverResult)
          : undefined;
    emitAudit(toolName, args, decision, resolvedCapabilities, extraStage);
    return decision;
  };

  const view = (): PermissionsView => ({ mode });

  const addSessionAllow = (section: keyof PolicyToolsSection, pattern: string): void => {
    // Empty/whitespace-only pattern is a programming bug (the
    // bridge should never call us with one). Silently drop
    // instead of corrupting the allowlist with a glob that
    // matches every input — a `''` pattern compiled to `^$`
    // matches the empty string only, harmless, but a future
    // refactor that strips/normalizes could turn it into `*`.
    // Defense-in-depth.
    const trimmed = pattern.trim();
    if (trimmed.length === 0) return;
    const existing = sessionAllow.get(section);
    if (existing === undefined) {
      sessionAllow.set(section, [trimmed]);
      return;
    }
    // Skip duplicates so repeated session-allow on the same
    // pattern doesn't grow the list unboundedly across a long
    // session. Order is preserved (`firstMatchingCommand` walks
    // left-to-right; the original promotion wins for diagnostic
    // attribution).
    if (existing.includes(trimmed)) return;
    existing.push(trimmed);
  };

  return {
    check,
    view,
    mode: () => mode,
    state: () => stateController.get(),
    degrade: (reason) => {
      stateController.transition('degraded', reason);
    },
    restore: (reason) => {
      stateController.transition('ready', reason);
    },
    refuse: (reason) => {
      stateController.transition('refusing', reason);
    },
    // Deep clone via structuredClone — the resolved Policy is
    // pure data (parsed YAML), no functions or DOM references,
    // so structuredClone is both correct and ~µs for realistic
    // sizes. Returning the captured `policy` reference directly
    // would let any caller silently mutate the engine's
    // enforcement state. JSON.parse(JSON.stringify(...)) would
    // also work but loses Date/Map shapes if a future Policy
    // grows them; structuredClone preserves them.
    policy: () => structuredClone(policy),
    addSessionAllow,
  };
};
