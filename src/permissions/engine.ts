import { firstMatchingCommand, firstMatchingHost, firstMatchingPath } from './matcher.ts';
import type {
  BashPolicy,
  Decision,
  FetchPolicy,
  PathPolicy,
  PermissionsView,
  Policy,
  PolicyCategory,
  PolicyMode,
  PolicyToolsSection,
} from './types.ts';

export interface EngineOptions {
  cwd: string;
}

export interface PermissionEngine {
  check(toolName: string, category: PolicyCategory, args: ToolArgs): Decision;
  view(): PermissionsView;
  mode(): PolicyMode;
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
// Without this resolver the engine deny-rejects glob/grep for
// "missing 'path' argument" before any rule matching can run, making
// `tools.grep.allow_paths` / `tools.glob.allow_paths` unusable.
const resolveFsTarget = (toolName: string, args: ToolArgs, cwd: string): string | null => {
  if (toolName === 'glob') return args.cwd ?? cwd;
  if (toolName === 'grep') return args.path ?? cwd;
  return typeof args.path === 'string' && args.path.length > 0 ? args.path : null;
};

const denyDefault = (toolName: string, mode: PolicyMode): Decision => ({
  kind: 'deny',
  reason: `no policy rule matched for ${toolName} (mode=${mode})`,
});

const checkBash = (
  toolName: string,
  args: ToolArgs,
  rules: BashPolicy | undefined,
  mode: PolicyMode,
): Decision => {
  const command = args.command;
  if (typeof command !== 'string' || command.length === 0) {
    return { kind: 'deny', reason: `${toolName}: missing 'command' argument` };
  }

  // Deny rules win over allow/confirm regardless of mode (including bypass-
  // outside-callers, though `bypass` itself short-circuits earlier).
  const denied = firstMatchingCommand(rules?.deny, command);
  if (denied !== null) {
    return { kind: 'deny', reason: `bash command matched deny rule: ${denied}` };
  }
  const allowed = firstMatchingCommand(rules?.allow, command);
  if (allowed !== null) {
    return { kind: 'allow', reason: `bash command matched allow rule: ${allowed}` };
  }
  const confirm = firstMatchingCommand(rules?.confirm, command);
  if (confirm !== null) {
    return {
      kind: 'confirm',
      prompt: `Run bash: ${command}`,
      reason: `matched confirm rule: ${confirm}`,
    };
  }
  return denyDefault(toolName, mode);
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
): Decision => {
  const path = resolveFsTarget(toolName, args, cwd);
  if (path === null) {
    return { kind: 'deny', reason: `${toolName}: missing 'path' argument` };
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
    return { kind: 'deny', reason: `path matched deny rule: ${denied}` };
  }
  const allowed = firstMatchingPath(rules?.allow_paths, matchTarget, cwd);
  if (allowed !== null) {
    return { kind: 'allow', reason: `path matched allow rule: ${allowed}` };
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
      };
    }
    return {
      kind: 'confirm',
      prompt: `${isWrite ? 'Write to' : 'Read from'} ${path}?`,
      reason: `matched confirm rule: ${confirm}`,
    };
  }

  // Unmatched paths default-deny in every mode (strict and acceptEdits).
  // acceptEdits skips the confirm step for confirmable writes; it does not
  // open writes to anywhere — that's what `bypass` is for.
  return denyDefault(toolName, mode);
};

const checkFetch = (
  toolName: string,
  args: ToolArgs,
  rules: FetchPolicy | undefined,
  mode: PolicyMode,
): Decision => {
  const url = args.url;
  if (typeof url !== 'string' || url.length === 0) {
    return { kind: 'deny', reason: `${toolName}: missing 'url' argument` };
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { kind: 'deny', reason: `${toolName}: invalid URL '${url}'` };
  }

  const denied = firstMatchingHost(rules?.deny_hosts, host);
  if (denied !== null) {
    return { kind: 'deny', reason: `host matched deny rule: ${denied}` };
  }
  const allowed = firstMatchingHost(rules?.allow_hosts, host);
  if (allowed !== null) {
    return { kind: 'allow', reason: `host matched allow rule: ${allowed}` };
  }
  return denyDefault(toolName, mode);
};

const lookupRules = (toolName: string, tools: PolicyToolsSection): unknown =>
  (tools as unknown as Record<string, unknown>)[toolName];

export const createPermissionEngine = (
  policy: Policy,
  options: EngineOptions,
): PermissionEngine => {
  const mode = policy.defaults.mode;
  const cwd = options.cwd;

  const check = (toolName: string, category: PolicyCategory, args: ToolArgs): Decision => {
    if (mode === 'bypass') {
      return { kind: 'allow', reason: 'mode=bypass' };
    }

    switch (category) {
      case 'bash':
        return checkBash(
          toolName,
          args,
          lookupRules(toolName, policy.tools) as BashPolicy | undefined,
          mode,
        );
      case 'fs.read':
        return checkPath(
          toolName,
          args,
          lookupRules(toolName, policy.tools) as PathPolicy | undefined,
          mode,
          cwd,
          false,
        );
      case 'fs.write':
        return checkPath(
          toolName,
          args,
          lookupRules(toolName, policy.tools) as PathPolicy | undefined,
          mode,
          cwd,
          true,
        );
      case 'web.fetch':
        return checkFetch(
          toolName,
          args,
          lookupRules(toolName, policy.tools) as FetchPolicy | undefined,
          mode,
        );
      case 'misc':
        // No category-level policy yet; misc tools must be explicitly
        // safe (no side effects worth gating). Default allow.
        return { kind: 'allow', reason: 'misc category: no gate applied' };
    }
  };

  const view = (): PermissionsView => ({ mode });

  return { check, view, mode: () => mode };
};
