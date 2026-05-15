import { Glob } from 'bun';
import { matchCommand } from '../permissions/matcher.ts';
import type { HookEvent, HookEventPayload, HookRunResult, HookSpec } from './types.ts';

// Slice 181 — per-pattern Glob cache for the `if` filter. The
// hook chain runs N hooks per tool call; constructing `new Glob`
// per call would O(N×hooks) the regex compile. Keyed by raw
// pattern string. Realistic workloads have ~10 distinct `if`
// patterns; cache stays bounded by config size.
const ifGlobCache = new Map<string, Glob>();
const getIfGlob = (pattern: string): Glob => {
  let glob = ifGlobCache.get(pattern);
  if (glob === undefined) {
    glob = new Glob(pattern);
    ifGlobCache.set(pattern, glob);
  }
  return glob;
};

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

// Eviction-event matcher per EVICTION.md §10.3. Each field is an
// EXACT string match against the corresponding payload key. A
// hook is admitted only when EVERY supplied field matches —
// matcher fields conjunct, not disjunct.
//
// Same semantics as the tool matcher: supplying no field passes
// any payload (the matcher is fully open); supplying one or more
// narrows the conjunctive intersection. Wildcards are NOT
// honored here (motivo/state/actor are closed enums in the
// repo's CHECK constraints — a `*` matcher would be undefined
// against an enum).
const evictionMatcherMatches = (
  spec: HookSpec,
  data: {
    substrate: string;
    motivo: string;
    fromState: string;
    toState: string;
    actor: string;
  },
): boolean => {
  const m = spec.matcher;
  if (m.substrate !== undefined && m.substrate !== data.substrate) return false;
  if (m.motivo !== undefined && m.motivo !== data.motivo) return false;
  if (m.fromState !== undefined && m.fromState !== data.fromState) return false;
  if (m.toState !== undefined && m.toState !== data.toState) return false;
  if (m.actor !== undefined && m.actor !== data.actor) return false;
  return true;
};

// Extract the tool name from a payload, if it's a tool-shaped
// event. Centralizes the discriminant check so callers don't
// repeat `event === 'PreToolUse' || ...`.
const toolNameFromPayload = (payload: HookEventPayload): string | null => {
  if (
    payload.event === 'PreToolUse' ||
    payload.event === 'PostToolUse' ||
    payload.event === 'PostToolUseFailure'
  ) {
    return payload.data.tool.name;
  }
  return null;
};

// Slice 181 — per-handler `if` filter using permission-rule
// syntax. `Bash(rm *)` matches when the bash command (or any of
// its `;`/`&&`/`||`-separated subcommands after env-prefix strip)
// matches the `rm *` glob. `Edit(<glob>)` matches when
// `args.file_path` (or `args.path`) matches the glob.
//
// Behavior: returns true when the hook should run.
//   - No `if` set → always true (matcher-only filter).
//   - `if` set but event isn't tool-shaped → false (operator's
//     filter is unsatisfiable on this event; spec contract is
//     "if-tool-shape only").
//   - `if` set and matches → true.
//   - `if` set and doesn't match → false.
//   - `if` set but malformed (can't parse) → true. Fail-OPEN
//     because the operator's intent was a filter, not a deny —
//     a typo shouldn't silently drop hooks.
const ifFilterMatches = (spec: HookSpec, payload: HookEventPayload): boolean => {
  const ifRule = spec.if;
  if (ifRule === undefined || ifRule.length === 0) return true;
  // The `if` field is only meaningful on tool-shaped events.
  if (
    payload.event !== 'PreToolUse' &&
    payload.event !== 'PostToolUse' &&
    payload.event !== 'PostToolUseFailure'
  ) {
    return false;
  }
  // Parse `Tool(pattern)` shape.
  const openIdx = ifRule.indexOf('(');
  const closeIdx = ifRule.lastIndexOf(')');
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    // Malformed rule — fail-open per docstring.
    return true;
  }
  const ifTool = ifRule.slice(0, openIdx);
  const pattern = ifRule.slice(openIdx + 1, closeIdx);
  // Empty parts also count as malformed.
  if (ifTool.length === 0 || pattern.length === 0) return true;

  const actualTool = payload.data.tool.name;
  // Tool-name normalization for the `if` filter. Operators write
  // patterns using either the spec name (`bash`, `write_file`,
  // `edit_file`, `read_file`) OR the Claude Code-style synonym
  // (`Bash`, `Write`, `Edit`, `Read`). The filter accepts both:
  //   - Bash       == bash
  //   - Edit       == edit_file
  //   - Write      == write_file
  //   - Read       == read_file
  // Other tool names match case-insensitively but as-is.
  const synonyms: Record<string, string> = {
    bash: 'bash',
    edit: 'edit_file',
    write: 'write_file',
    read: 'read_file',
  };
  const ifToolNormalized = synonyms[ifTool.toLowerCase()] ?? ifTool.toLowerCase();
  if (ifToolNormalized !== actualTool.toLowerCase()) return false;

  // For Bash, match against `args.command` (subcommand-aware via
  // matchCommand which handles `;`/`&&`/`||` splits).
  if (actualTool.toLowerCase() === 'bash') {
    const cmd = payload.data.tool.input.command;
    if (typeof cmd !== 'string') return true; // shouldn't happen; fail-open
    return matchCommand(pattern, cmd);
  }
  // For fs-shaped tools, match against the path field.
  if (actualTool === 'write_file' || actualTool === 'edit_file' || actualTool === 'read_file') {
    const path =
      typeof payload.data.tool.input.file_path === 'string'
        ? payload.data.tool.input.file_path
        : typeof payload.data.tool.input.path === 'string'
          ? payload.data.tool.input.path
          : null;
    if (path === null) return true; // missing path arg — fail-open
    // Two-shot path match. Operators write `Edit(*.ts)` expecting
    // the pattern to behave like a filename glob — "matches any
    // `.ts` file regardless of dir". Bun's Glob is path-aware:
    // `*.ts` matches `main.ts` but NOT `src/main.ts`. Two probes:
    //   1. Match the full path verbatim. Operator who wrote
    //      `src/**/*.ts` gets path-segment semantics.
    //   2. If pattern has no `/`, also try matching just the
    //      basename. `*.ts` against basename `main.ts` of
    //      `src/main.ts` matches. Paridade com Claude Code.
    const glob = getIfGlob(pattern);
    if (glob.match(path)) return true;
    if (!pattern.includes('/')) {
      const slashIdx = path.lastIndexOf('/');
      const basename = slashIdx === -1 ? path : path.slice(slashIdx + 1);
      if (glob.match(basename)) return true;
    }
    return false;
  }
  // For other tools, fail-open. Operator that wants finer matching
  // for novel tools can use a more specific `matcher` + script
  // logic; the `if` field's primary surface is bash + fs tools.
  return true;
};

export const matchesPayload = (spec: HookSpec, payload: HookEventPayload): boolean => {
  if (!specMatches(spec, payload.event, toolNameFromPayload(payload))) return false;
  if (payload.event === 'Eviction' && !evictionMatcherMatches(spec, payload.data)) return false;
  return ifFilterMatches(spec, payload);
};

// Slice 181 — parse the hook's stdout as JSON output if it looks
// JSON-shaped. Returns the parsed fields when valid, null when
// the stdout isn't JSON or doesn't carry recognized fields. The
// caller (dispatcher) merges these into the `allow` HookRunResult.
//
// Recognized fields:
//   - `additionalContext` (string) — injected into LLM context
//     by the chain consumer.
//   - `updatedInput` (object) — replaces tool input on PreToolUse.
//     Last-wins across the chain.
//   - `suppressOutput` (bool) — hides hook stdout from debug log.
//
// Defensive: malformed JSON, wrong field types, or arrays in
// place of strings are treated as plain stdout (returns null
// instead of throwing). Hook output is hostile input — never
// trust shape blindly.
//
// Size cap: the dispatcher truncates stdout to 4KB BEFORE this
// parser runs (HOOK_STDOUT_MAX_BYTES in types.ts). A hook that
// emits more than 4KB of JSON has its stdout cut mid-string,
// making the JSON unparseable — the parser returns null and the
// hook's output is treated as plain text. Operators wanting more
// than 4KB of additionalContext must split into multiple hooks.
// The 4KB ceiling is intentional: hook output is a side channel,
// not a context-window fill.
export interface HookJsonOutput {
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
  suppressOutput?: boolean;
}
export const parseHookJsonOutput = (stdout: string): HookJsonOutput | null => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  // Cheap pre-filter: JSON object must start with `{`. If not,
  // it's plain text — skip the parse entirely (hot path).
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const out: HookJsonOutput = {};
  if (typeof obj.additionalContext === 'string') {
    out.additionalContext = obj.additionalContext;
  }
  if (
    obj.updatedInput !== undefined &&
    obj.updatedInput !== null &&
    typeof obj.updatedInput === 'object' &&
    !Array.isArray(obj.updatedInput)
  ) {
    out.updatedInput = obj.updatedInput as Record<string, unknown>;
  }
  if (typeof obj.suppressOutput === 'boolean') {
    out.suppressOutput = obj.suppressOutput;
  }
  // If JSON parsed but had zero recognized fields, treat as no-op
  // (caller still records the run as `allow` with the stdout
  // text). Returning {} instead of null distinguishes "valid JSON,
  // no fields" from "not JSON".
  return out;
};

// Map exit code + event to the dispatcher's discriminated
// outcome. See HookRunResult in types.ts for the kind union.
//
// Slice 181 — on exit 0, attempts to parse stdout as JSON. When
// the JSON carries recognized fields (`additionalContext`,
// `updatedInput`, `suppressOutput`), the allow result surfaces
// them so the chain consumer can act on them. Plain-text stdout
// is preserved as `stdoutTruncated`; the operator still sees
// the verbatim output in debug logs / audit rows.
export const classifyExitCode = (
  exitCode: number,
  stdout: string,
  durationMs: number,
  failClosed: boolean,
): HookRunResult => {
  if (exitCode === 0) {
    const jsonOut = parseHookJsonOutput(stdout);
    const result: HookRunResult = { kind: 'allow', stdoutTruncated: stdout, durationMs };
    if (jsonOut !== null) {
      if (jsonOut.additionalContext !== undefined) {
        result.additionalContext = jsonOut.additionalContext;
      }
      if (jsonOut.updatedInput !== undefined) {
        result.updatedInput = jsonOut.updatedInput;
      }
      if (jsonOut.suppressOutput !== undefined) {
        result.suppressOutput = jsonOut.suppressOutput;
      }
    }
    return result;
  }
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
