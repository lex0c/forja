// Tool-restriction enforcement for playbook subagents
// (`PLAYBOOKS.md` §1.1). Each playbook may declare per-tool
// allow/deny pattern lists in its frontmatter; the loader normalizes
// them into `ToolRestrictionRules` (slice 1). This module turns those
// rules into pre-flight checks the child harness applies before
// dispatching a tool.
//
// Two surfaces share one matcher:
//
//   - Bash-shaped tools (`bash`, `bash_background`, etc.) match the
//     command-string argv against `allow` / `deny`.
//   - Path-shaped tools (`write_file`, `edit_file`) match the
//     target path against `allowPaths` / `denyPaths`.
//
// Glob / prefix only — no regex. CLAUDE.md hard rule: "No regex in
// policy/permissions. Glob + prefix only." `*` matches zero or more
// characters (including `/`); a literal pattern requires an exact
// equal compare. Nothing more.
//
// Refusal codes use the `policy.tool_restricted` error code so the
// child can propagate a clear cause. The shape mirrors how the
// permission engine refuses: a deny match always wins, an allow
// list (when present) requires a match.

import { isAbsolute, relative, resolve } from 'node:path';
import type { Tool } from '../tools/types.ts';
import { type ToolResult, toolError } from '../tools/types.ts';
import type { ToolRestrictionRules, ToolRestrictions } from './types.ts';

// Glob match with `*` as zero-or-more wildcard. Two-pointer
// backtracking — no regex compilation, no third-party dep.
//
// Matches the surface in `PLAYBOOKS.md` §1.1 verbatim:
//
//   `"git diff *"` matches `"git diff main..HEAD"` / `"git diff
//   --stat"` (suffix wildcard).
//   `"src/**"` matches `"src/foo/bar.ts"` (`*` consumes `/` too —
//   no glob-globstar distinction is needed today; if a future spec
//   change wants single-segment vs multi-segment matching, this is
//   the sole call site to revise).
//   `"npm test*"` matches `"npm test"` and `"npm test --watch"`
//   (no leading space — the pattern is matched against the literal
//   command string the model emits).
//   Plain `"git status"` requires an exact equal.
//
// Empty pattern matches only empty input (the literal-equal case).
// Empty input matches only patterns that are themselves empty or
// `*`-only.
const matchGlob = (input: string, pattern: string): boolean => {
  let i = 0;
  let j = 0;
  // Backtrack anchors for the latest `*` we scanned over. -1 = not
  // inside a star window.
  let starI = -1;
  let starJ = -1;
  while (i < input.length) {
    if (j < pattern.length && pattern[j] === input[i]) {
      i++;
      j++;
      continue;
    }
    if (j < pattern.length && pattern[j] === '*') {
      starI = i;
      starJ = j;
      j++;
      continue;
    }
    if (starJ !== -1) {
      // Backtrack: the prior `*` consumes one more character, retry
      // the rest of the pattern from just after it.
      starI++;
      i = starI;
      j = starJ + 1;
      continue;
    }
    return false;
  }
  // Trailing `*`s in the pattern can each consume zero characters.
  while (j < pattern.length && pattern[j] === '*') j++;
  return j === pattern.length;
};

export interface PatternMatch {
  matched: boolean;
  pattern?: string;
}

// Run `input` against a list of patterns. Returns the FIRST pattern
// that matches (callers care about which pattern triggered the
// branch — `allow` reports the matched allow rule; `deny` reports
// the matched deny rule for the operator). Empty list yields
// `{ matched: false }`.
export const matchAny = (input: string, patterns: ReadonlyArray<string>): PatternMatch => {
  for (const pattern of patterns) {
    if (matchGlob(input, pattern)) return { matched: true, pattern };
  }
  return { matched: false };
};

// Normalize a command string for restriction matching: trim
// leading/trailing whitespace and collapse internal runs of
// whitespace (spaces, tabs, newlines, etc.) to a single space.
// Mirrors how the shell tokenizes whitespace before execution —
// without it, ` rm -rf /tmp` (leading space) or `rm\t-rf /tmp`
// (tab) silently bypasses `deny: ["rm -rf *"]` because the
// matcher does literal char-by-char comparison anchored at
// position 0. Applied SYMMETRICALLY to the input and each
// pattern so a double-space typo in a pattern doesn't leak
// coverage either way.
const normalizeCommandForMatch = (s: string): string => s.trim().replace(/\s+/g, ' ');

// Command-shape variant of `matchAny`: normalizes both sides
// before delegating to `matchGlob`, but reports the ORIGINAL
// pattern in the verdict so authors see what they actually wrote
// in the .md frontmatter (not the normalized projection).
const matchCommandAny = (command: string, patterns: ReadonlyArray<string>): PatternMatch => {
  const normalizedCommand = normalizeCommandForMatch(command);
  for (const pattern of patterns) {
    if (matchGlob(normalizedCommand, normalizeCommandForMatch(pattern))) {
      return { matched: true, pattern };
    }
  }
  return { matched: false };
};

// Verdict on an individual restriction check. Internally typed so
// the tool-wrapping factory and the enforce* functions share one
// shape; consumers only care about the `ok` discriminator.
export type RestrictionVerdict =
  | { ok: true }
  | { ok: false; reason: string; matchedPattern?: string };

// Enforce a bash-shaped restriction: the input is the command
// string the tool will invoke (the model's argv as a single line).
//
// Order of checks:
//   1. Deny list — a match always refuses, regardless of allow.
//   2. Allow list — when declared, the input MUST match one entry.
//      An empty allow list (`allow: []`) is interpreted as "no
//      command is allowed" (the playbook author explicitly
//      blanked it). When `allow` is absent (undefined), no allow
//      gate runs.
//
// `allow_paths` / `deny_paths` are NOT consulted here — they are
// the path-flavored gate (`enforcePathRestriction`). A bash rule
// that mistakenly declares `allow_paths` without `allow` is the
// loader's responsibility to catch (slice 1 already validates
// shape; this module trusts the input).
export const enforceBashRestriction = (
  command: string,
  rules: ToolRestrictionRules,
): RestrictionVerdict => {
  if (rules.deny !== undefined) {
    const hit = matchCommandAny(command, rules.deny);
    if (hit.matched) {
      return {
        ok: false,
        reason: `command is denied by tool_restrictions deny pattern '${hit.pattern}'`,
        ...(hit.pattern !== undefined ? { matchedPattern: hit.pattern } : {}),
      };
    }
  }
  if (rules.allow !== undefined) {
    const hit = matchCommandAny(command, rules.allow);
    if (!hit.matched) {
      const list = rules.allow.length > 0 ? rules.allow.join(', ') : '(empty allow list)';
      return {
        ok: false,
        reason: `command does not match any tool_restrictions allow pattern: ${list}`,
      };
    }
  }
  return { ok: true };
};

// Enforce a path-shaped restriction: the input is the target path
// the tool will write to.
//
// Mirror of `enforceBashRestriction` but consults `denyPaths` /
// `allowPaths`. A rule that declares both flavors gets both gates;
// the path gate only applies if the corresponding `*Paths` field
// is present.
export const enforcePathRestriction = (
  path: string,
  rules: ToolRestrictionRules,
): RestrictionVerdict => {
  if (rules.denyPaths !== undefined) {
    const hit = matchAny(path, rules.denyPaths);
    if (hit.matched) {
      return {
        ok: false,
        reason: `path is denied by tool_restrictions deny_paths pattern '${hit.pattern}'`,
        ...(hit.pattern !== undefined ? { matchedPattern: hit.pattern } : {}),
      };
    }
  }
  if (rules.allowPaths !== undefined) {
    const hit = matchAny(path, rules.allowPaths);
    if (!hit.matched) {
      const list =
        rules.allowPaths.length > 0 ? rules.allowPaths.join(', ') : '(empty allow_paths list)';
      return {
        ok: false,
        reason: `path does not match any tool_restrictions allow_paths pattern: ${list}`,
      };
    }
  }
  return { ok: true };
};

// Map a tool name → restriction shape it consumes. The child
// runtime wraps tool dispatch with this map's lookup, so the
// matrix lives in one place. New tools that gate by command
// string land under `bash`; new tools that gate by target path
// land under `path`.
//
// Tools NOT listed here ignore restrictions even if a playbook
// author declared a rule for them — slice 1 accepts arbitrary
// tool names in `tool_restrictions` (forward-compat for future
// tools), and the runtime simply passes them through. This is
// safe because a rule the runtime ignores is not a security
// gate; the playbook's `tools[]` whitelist is the floor.
export type ToolRestrictionShape = 'bash' | 'path';

export const TOOL_RESTRICTION_SHAPE: Readonly<Record<string, ToolRestrictionShape>> = {
  bash: 'bash',
  bash_background: 'bash',
  // Note: bash_kill / bash_output are SAFE without restrictions —
  // bash_kill takes a process id (not a free-form command), and
  // bash_output reads stored output. Listing them here would
  // require a bespoke matcher that does not match the common
  // "command string" or "path" shape.
  write_file: 'path',
  edit_file: 'path',
};

// Render a refusal as a `ToolResult` error so the child's invoke
// path collapses to its standard error-handling. The hint surfaces
// the refusal reason verbatim, and `details.matched_pattern` lets
// the operator (and any audit pipeline) trace the trigger to the
// exact playbook frontmatter line.
export const toRestrictionError = (
  toolName: string,
  reason: string,
  matchedPattern?: string,
): ToolResult<never> =>
  toolError(RESTRICTION_ERROR_CODE, `tool '${toolName}': ${reason}`, {
    retryable: false,
    hint: 'Adjust the playbook arguments to match the allow patterns, or update the tool_restrictions block in the .md frontmatter if the rule is wrong.',
    ...(matchedPattern !== undefined ? { details: { matched_pattern: matchedPattern } } : {}),
  });

// Re-export the shape from `tools/types.ts` so consumers don't have
// to import twice.
export type { ToolRestrictions, ToolRestrictionRules };
// Wrappers that bind a specific extraction strategy (how to pull
// the command string or target path out of the tool's args object)
// to the matching restriction rule. Defined as separate functions
// so unit tests can exercise them without standing up the full
// tool registry.
//
// `extractFromArgs` may return null when the args do not carry the
// expected field — defensive against a misbehaving caller (e.g., a
// `bash` tool invoked without the `command` argument). In that
// case, the wrapper passes through to the underlying tool, which
// will surface its own validation error. Restrictions are not the
// place to validate input shape.
export interface RestrictionExtractor {
  shape: ToolRestrictionShape;
  // null = "no field to gate on; let the underlying tool handle
  // arg validation". Returning empty string is treated as a
  // present-but-empty input (gates still run; an empty command
  // matched against a non-empty allow list refuses).
  extract: (args: unknown) => string | null;
}

const BASH_EXTRACTOR: RestrictionExtractor = {
  shape: 'bash',
  extract: (args) => {
    if (args === null || typeof args !== 'object') return null;
    const cmd = (args as Record<string, unknown>).command;
    return typeof cmd === 'string' ? cmd : null;
  },
};

const PATH_EXTRACTOR: RestrictionExtractor = {
  shape: 'path',
  extract: (args) => {
    if (args === null || typeof args !== 'object') return null;
    const path = (args as Record<string, unknown>).path;
    return typeof path === 'string' ? path : null;
  },
};

export const TOOL_RESTRICTION_EXTRACTORS: Readonly<Record<string, RestrictionExtractor>> = {
  bash: BASH_EXTRACTOR,
  bash_background: BASH_EXTRACTOR,
  write_file: PATH_EXTRACTOR,
  edit_file: PATH_EXTRACTOR,
};

// Run the relevant restriction check for a tool given its raw
// args. Returns the verdict; the caller renders the refusal into
// a `ToolResult` if needed (the call site has the tool name in
// scope and produces the proper error envelope).
//
// `restrictions` is the full per-playbook map; `toolName` is the
// tool the wrapper is invoking. Both null returns and missing
// extractors collapse to "ok" — the strictest gate that triggers
// is the floor.
//
// `cwd` is the session cwd the underlying tool resolves paths
// against (write_file / edit_file: `resolve(ctx.cwd, args.path)`).
// Path-shape restrictions canonicalize against the same cwd
// before matching so traversal forms like `src/../secrets.txt`
// cannot bypass `allow_paths: ["src/**"]` — the raw arg starts
// with `src/`, but the resolved write target lands outside.
// Bash-shape rules ignore cwd; the parameter is required so a
// forgotten thread-through is a compile error rather than a
// silent canonicalization skip.
export const checkRestriction = (
  toolName: string,
  args: unknown,
  restrictions: ToolRestrictions | undefined,
  cwd: string,
): RestrictionVerdict => {
  if (restrictions === undefined) return { ok: true };
  const rules = restrictions[toolName];
  if (rules === undefined) return { ok: true };
  const extractor = TOOL_RESTRICTION_EXTRACTORS[toolName];
  if (extractor === undefined) {
    // The playbook declared a rule for a tool we don't know how to
    // gate (e.g., a future tool, or a typo). Slice 1 already
    // accepts arbitrary tool names in tool_restrictions, so this
    // branch must pass through — the playbook's `tools[]`
    // whitelist is the floor.
    return { ok: true };
  }
  const input = extractor.extract(args);
  if (input === null) return { ok: true };
  if (extractor.shape === 'bash') return enforceBashRestriction(input, rules);
  // Path shape: canonicalize against cwd before matching. The
  // patterns are interpreted as relative-to-cwd globs (the spec
  // example is `src/**`), so we project the input into the same
  // form. A canonical path that escapes cwd is refused outright —
  // a write outside the session sandbox should not be reachable
  // by any pattern, and folding it into the matcher would invite
  // pattern authors to over-grant by accident.
  const canonical = canonicalizeUnderCwd(input, cwd);
  if (canonical.escaped) {
    return {
      ok: false,
      reason:
        'path resolves outside the session cwd — restrictions evaluate canonical paths under cwd to prevent traversal escapes',
    };
  }
  return enforcePathRestriction(canonical.relPath, rules);
};

// Canonicalize a tool-supplied path against `cwd` and decide
// whether it stays inside the sandbox. Mirrors what `write_file` /
// `edit_file` do at write time (`resolve(ctx.cwd, args.path)`)
// but ALSO rejects results that fall outside `cwd`, where the
// write tools would happily proceed against the resolved absolute
// path. This is the security boundary that turns the path
// restriction into a true sandbox: glob authors write
// `allow_paths: ["src/**"]` and the runtime guarantees that no
// canonical path matched against that glob can escape `src/`,
// regardless of how the model formats the arg (`src/../etc/x`,
// `./src/../etc/x`, an absolute path outside cwd, etc.).
const canonicalizeUnderCwd = (
  input: string,
  cwd: string,
): { escaped: false; relPath: string } | { escaped: true } => {
  // `resolve(cwd, input)` collapses `.` / `..` segments and
  // honors absolute `input` (when input is absolute, cwd is
  // ignored). Both cases land at the same canonical absolute
  // path the write tools would write to.
  const abs = resolve(cwd, input);
  // `relative(cwd, abs)` returns native-separator output:
  // `foo/bar` on POSIX, `foo\bar` on Windows. Patterns in
  // `allow_paths` / `deny_paths` are authored with POSIX
  // separators per the spec example (`src/**`), so we project
  // the relative path onto `/` before matching. Without this,
  // every Windows run silently denies legitimate writes because
  // `src\file.ts` cannot match `src/**` literally — turning a
  // platform-neutral policy surface into a POSIX-only one.
  //
  // POSIX trade-off: a filename that legitimately contains `\`
  // (a valid POSIX path char) gets its backslash rewritten to
  // `/`, mismatching what the file tools would actually write.
  // Accepted because (a) backslashes in POSIX filenames are
  // exotic-to-the-point-of-pathological and (b) glob patterns
  // are universally authored with `/`, so normalization aligns
  // with the dominant author intent on every platform.
  const rel = relative(cwd, abs).split('\\').join('/');
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return { escaped: true };
  }
  return { escaped: false, relPath: rel };
};

// Convenience: the tool-error code for restriction refusals. Kept
// at one literal so the audit/display layers can grep for it. Not
// added to `ERROR_CODES` (`tools/types.ts`) because that union
// catalogues HARNESS-level error families; `policy.tool_restricted`
// is a per-playbook gate, scoped to subagents.
export const RESTRICTION_ERROR_CODE = 'policy.tool_restricted';

// Wrap a tool so its `execute` is preceded by the restriction
// check. The returned Tool is byte-identical to the input on every
// surface except `execute`: same name, same input/output schemas,
// same metadata. The wrapper catches a refusal before the tool
// runs at all — no permission-engine call, no provider call, no
// filesystem touch.
//
// `restrictions` is the per-playbook map; the wrapper consults it
// each call (cheap — one map lookup + one matcher pass) so a
// future runtime that mutates rules at session granularity does
// not need to rebuild the registry.
//
// When restrictions for this tool are absent (rule undefined or
// extractor missing), `checkRestriction` returns `ok` and the
// wrapper invokes the underlying tool unchanged. The wrapper is
// therefore safe to apply unconditionally — slice 5's child path
// wraps every registered tool, gates apply only to the ones with
// rules.
export const wrapToolWithRestrictions = <I, O>(
  tool: Tool<I, O>,
  restrictions: ToolRestrictions | undefined,
): Tool<I, O> => {
  if (restrictions === undefined) return tool;
  // Build a closure that captures the snapshot. The fresh
  // execute MUST keep `this` and the original tool's argument
  // shape verbatim; nothing in the contract here is invented.
  return {
    ...tool,
    execute: (args, ctx) => {
      const verdict = checkRestriction(tool.name, args, restrictions, ctx.cwd);
      if (verdict.ok) return tool.execute(args, ctx);
      const result: ToolResult<O> = toRestrictionError(
        tool.name,
        verdict.reason,
        verdict.matchedPattern,
      ) as ToolResult<O>;
      return Promise.resolve(result);
    },
  };
};
