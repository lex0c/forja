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
// fields it knows about per category; unknown fields are ignored.
export interface ToolArgs {
  // bash
  command?: string;
  // fs.*
  path?: string;
  // web.fetch
  url?: string;
}

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

const checkPath = (
  toolName: string,
  args: ToolArgs,
  rules: PathPolicy | undefined,
  mode: PolicyMode,
  cwd: string,
  isWrite: boolean,
): Decision => {
  const path = args.path;
  if (typeof path !== 'string' || path.length === 0) {
    return { kind: 'deny', reason: `${toolName}: missing 'path' argument` };
  }

  const denied = firstMatchingPath(rules?.deny_paths, path, cwd);
  if (denied !== null) {
    return { kind: 'deny', reason: `path matched deny rule: ${denied}` };
  }
  const allowed = firstMatchingPath(rules?.allow_paths, path, cwd);
  if (allowed !== null) {
    return { kind: 'allow', reason: `path matched allow rule: ${allowed}` };
  }
  const confirm = firstMatchingPath(rules?.confirm_paths, path, cwd);
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
