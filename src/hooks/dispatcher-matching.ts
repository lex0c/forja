import type { HookEvent, HookEventPayload, HookRunResult, HookSpec } from './types.ts';

// Decide whether a hook spec applies given an event + optional
// tool name. Today only `tool` matchers exist; matcher succeeds
// when spec.matcher.tool either equals or glob-prefix-matches
// the supplied tool name. Glob is a single trailing `*`
// (`bash*` matches `bash` and `bash_background`).
//
// Shared by `matchesPayload` and the public `filterMatchingHooks`
// — keeping the rule in one place prevents drift between the
// two call sites.
const specMatches = (spec: HookSpec, event: HookEvent, toolName: string | null): boolean => {
  if (spec.event !== event) return false;
  const toolMatcher = spec.matcher.tool;
  if (toolMatcher === undefined) return true;
  // Tool matcher only meaningful when a tool name is in scope.
  // Non-tool events pass `null` and never match.
  if (toolName === null) return false;
  if (toolMatcher.endsWith('*')) {
    return toolName.startsWith(toolMatcher.slice(0, -1));
  }
  return toolName === toolMatcher;
};

// Extract the tool name from a payload, if it's a tool-shaped
// event. Centralizes the discriminant check so callers don't
// repeat `event === 'PreToolUse' || ...`.
const toolNameFromPayload = (payload: HookEventPayload): string | null => {
  if (payload.event === 'PreToolUse' || payload.event === 'PostToolUse') {
    return payload.data.tool.name;
  }
  return null;
};

export const matchesPayload = (spec: HookSpec, payload: HookEventPayload): boolean =>
  specMatches(spec, payload.event, toolNameFromPayload(payload));

// Map exit code + event to the dispatcher's discriminated
// outcome. See HookRunResult in types.ts for the kind union.
export const classifyExitCode = (
  exitCode: number,
  stdout: string,
  durationMs: number,
  failClosed: boolean,
): HookRunResult => {
  if (exitCode === 0) return { kind: 'allow', stdoutTruncated: stdout, durationMs };
  if (exitCode === 1) return { kind: 'block_silent', durationMs };
  if (exitCode === 2) {
    // Per spec: stdout becomes the reason. Empty stdout still
    // produces a block_message (with empty reason) — operator
    // intent is "block, here's why" even if `why` ended up
    // missing.
    return { kind: 'block_message', message: stdout.trim(), durationMs };
  }
  // Exit > 2: hook error. Caller treats as block iff failClosed.
  return {
    kind: 'error',
    exitCode,
    reason: `hook exited with code ${exitCode}`,
    durationMs,
    shouldBlock: failClosed,
  };
};

export const filterMatchingHooks = (
  hooks: readonly HookSpec[],
  event: HookEvent,
  toolName: string | null = null,
): HookSpec[] => hooks.filter((spec) => specMatches(spec, event, toolName));
