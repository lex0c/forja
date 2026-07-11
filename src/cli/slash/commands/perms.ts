// /perms — show the active permission policy.
//
// Reads via `ctx.baseConfig.permissionEngine.policy()` (deep copy,
// safe to inspect) and renders a human-readable summary as info
// lines: defaults.mode, then each tool section with its rules
// elided to counts past a threshold so the scrollback doesn't
// flood when the policy carries dozens of allow patterns.
//
// Sub-mode `/perms why <tool> [args...]` runs an engine dry-check
// against synthetic args and renders the resulting Decision plus
// source attribution (which layer + rule fired). Lets operators
// answer "why was this allowed/denied/confirmed?" without having
// to actually invoke the tool — useful for sanity-checking a new
// rule, debugging an unexpected denial, or confirming a policy
// edit took effect.
//
// Read-only by design. Editing policy goes through the YAML files
// (`.forja/permissions.yaml` etc.) — keeps a single source of
// truth and avoids inventing a runtime mutation path that would
// diverge from the on-disk format. Spec: AGENTIC_CLI §8.

import type { Decision, PolicyCategory, ToolArgs } from '../../../permissions/index.ts';
import { renderPolicy, renderSandbox } from '../../../permissions/render.ts';
import { GIT_MODES } from '../../../tools/builtin/git.ts';
import type { SlashCommand } from '../types.ts';

// Re-export for tests + downstream consumers (a few tests still
// import renderPolicy from this module's path). The
// implementation lives in permissions/render.ts so the
// `--explain-permissions` CLI can share it without copying the
// formatters.
export { renderPolicy };

// Build the per-tool ToolArgs shape from the operator's positional
// inputs. Returns either valid args or a usage-error message — the
// caller surfaces the error verbatim so the operator gets the
// example syntax for the specific tool they asked about.
//
// `category` drives the shape (engine.check is keyed on category,
// not toolName). For bash, `rest` joins with spaces — operators
// type `/perms why bash rm -rf /tmp/cache` and want the full
// command checked, not just the first word. For fs.* and
// web.fetch the shape is single-positional. grep / glob accept
// an optional path/cwd (the engine's default-to-session-cwd
// behavior is itself worth dry-checking).
const buildDryCheckArgs = (
  toolName: string,
  category: PolicyCategory,
  rest: readonly string[],
): { ok: true; args: ToolArgs } | { ok: false; error: string } => {
  if (category === 'bash') {
    if (rest.length === 0) {
      return {
        ok: false,
        error: `/perms why ${toolName}: missing command (e.g. /perms why ${toolName} npm test)`,
      };
    }
    return { ok: true, args: { command: rest.join(' ') } };
  }
  if (toolName === 'git') {
    // git: optional [mode] then optional [path]. The engine keys on `path`
    // (a pathless call defaults to cwd) AND on `mode`: blame/show_file are
    // single-file invocations (engine `isSingleFileInvocation`), which lets
    // an exact-file rule match a file that exists only in HISTORY. So
    // consume a leading mode token (so `/perms why git status` isn't read as
    // a path named "status") but PRESERVE it in the synthetic args —
    // dropping it would make the dry-check default-deny a show_file/blame
    // the real call would allow under the same policy.
    const hasMode = rest.length > 0 && GIT_MODES.has(rest[0] as string);
    const mode = hasMode ? (rest[0] as string) : undefined;
    const tokens = hasMode ? rest.slice(1) : rest;
    if (tokens.length > 1) {
      return {
        ok: false,
        error: '/perms why git: takes [mode] [path] (e.g. /perms why git diff src/foo.ts)',
      };
    }
    const gitArgs: ToolArgs = {
      ...(mode !== undefined ? { mode } : {}),
      ...(tokens.length === 1 ? { path: tokens[0] as string } : {}),
    };
    return { ok: true, args: gitArgs };
  }
  if (category === 'fs.read' || category === 'fs.write') {
    // grep and glob accept an optional search root; everything
    // else (read_file/write_file/edit_file) requires a path.
    const optional = toolName === 'grep' || toolName === 'glob';
    if (rest.length === 0 && !optional) {
      return {
        ok: false,
        error: `/perms why ${toolName}: missing path (e.g. /perms why ${toolName} src/foo.ts)`,
      };
    }
    if (rest.length > 1) {
      return {
        ok: false,
        error: `/perms why ${toolName}: takes a single path (got ${rest.length} args)`,
      };
    }
    if (rest.length === 0) {
      return { ok: true, args: {} };
    }
    // rest.length is 1 here (guarded above); the cast pacifies
    // TS's noUncheckedIndexedAccess without changing the runtime
    // shape (a regression that broke the length guard would surface
    // as a literal undefined in args, which the engine's missing-
    // arg branch already deny-handles).
    const value = rest[0] as string;
    if (toolName === 'glob') {
      return { ok: true, args: { cwd: value } };
    }
    return { ok: true, args: { path: value } };
  }
  if (category === 'web.fetch') {
    if (rest.length !== 1) {
      return {
        ok: false,
        error: `/perms why ${toolName}: takes a single URL (got ${rest.length} args)`,
      };
    }
    return { ok: true, args: { url: rest[0] as string } };
  }
  // misc — no policy section consulted; engine returns allow
  // unconditionally. Args are ignored.
  return { ok: true, args: {} };
};

const formatLayer = (layer: string): string =>
  layer === 'default' ? 'built-in default' : `${layer} policy`;

// Render a Decision with full source attribution. Padded labels
// match the columnar feel of the rest of /perms output. Order
// (decision → rule → layer → section → reason) puts the
// operator's first question (allow/deny/confirm?) at the top.
const renderDryCheck = (decision: Decision): string[] => {
  const lines: string[] = [];
  lines.push(`  decision: ${decision.kind}`);
  if (decision.kind === 'confirm') {
    lines.push(`  prompt:   ${decision.prompt}`);
  }
  if (decision.source !== undefined) {
    if (decision.source.rule !== undefined) {
      lines.push(`  rule:     ${decision.source.rule}`);
    }
    lines.push(`  layer:    ${formatLayer(decision.source.layer)}`);
    if (decision.source.section !== undefined) {
      lines.push(`  section:  ${decision.source.section}`);
    }
  }
  if (decision.reason !== undefined && decision.reason.length > 0) {
    lines.push(`  reason:   ${decision.reason}`);
  }
  return lines;
};

// `/perms why sandbox` — sandbox isn't a tool (no dry-check shape),
// so this branch runs SEPARATELY from the per-tool `runWhy`. Renders
// the merged sandbox section + per-field provenance from the engine.
// Emits "(sandbox section not declared)" when no layer wrote it, so
// the operator gets a definite answer instead of empty output.
const runWhySandbox = (
  ctx: Parameters<SlashCommand['exec']>[1],
): ReturnType<SlashCommand['exec']> => {
  const policy = ctx.baseConfig.permissionEngine.policy();
  const provenance = ctx.baseConfig.permissionEngine.provenance();
  if (policy.sandbox === undefined) {
    return Promise.resolve({
      kind: 'ok',
      notes: [
        '/perms why sandbox',
        '  (sandbox section not declared by any policy layer)',
        '  bootstrap defaults: required=false, host_allowed=false',
      ],
    });
  }
  return Promise.resolve({
    kind: 'ok',
    notes: ['/perms why sandbox', ...renderSandbox(policy.sandbox, provenance.sandbox)],
  });
};

const runWhy = (
  args: readonly string[],
  ctx: Parameters<SlashCommand['exec']>[1],
): ReturnType<SlashCommand['exec']> => {
  // args[0] === 'why' (already matched). Operator-typed: tool
  // name + positional arg(s).
  if (args.length < 2) {
    return Promise.resolve({
      kind: 'error',
      message: '/perms why: missing tool name (e.g. /perms why bash npm test)',
    });
  }
  const toolName = args[1];
  if (toolName === undefined || toolName.length === 0) {
    return Promise.resolve({
      kind: 'error',
      message: '/perms why: missing tool name (e.g. /perms why bash npm test)',
    });
  }
  // §6.5 sandbox section introspection — not a tool, no dry-check.
  // Hand off to the dedicated branch.
  if (toolName === 'sandbox') {
    return runWhySandbox(ctx);
  }
  const tool = ctx.baseConfig.toolRegistry.get(toolName);
  if (tool === null) {
    return Promise.resolve({
      kind: 'error',
      message: `/perms why: unknown tool '${toolName}'`,
    });
  }
  const built = buildDryCheckArgs(toolName, tool.metadata.category, args.slice(2));
  if (!built.ok) {
    return Promise.resolve({ kind: 'error', message: built.error });
  }
  const decision = ctx.baseConfig.permissionEngine.check(
    toolName,
    tool.metadata.category,
    built.args,
  );
  // Header line echoes the dry-check input so the operator's
  // scrollback shows what was probed (especially useful when
  // they pipe the modal answer back into a second `why` call).
  const header = `/perms why ${toolName}${args.length > 2 ? ` ${args.slice(2).join(' ')}` : ''}`;
  return Promise.resolve({
    kind: 'ok',
    notes: [header, ...renderDryCheck(decision)],
  });
};

export const permsCommand: SlashCommand = {
  name: 'perms',
  description: 'show the active permission policy (or "/perms why <tool> [args]" for dry-check)',
  argHint: '[why <tool>]',
  exec: async (args, ctx) => {
    if (args.length > 0 && args[0] === 'why') {
      return runWhy(args, ctx);
    }
    if (args.length > 0) {
      return {
        kind: 'error',
        message: '/perms: unknown sub-command (try "/perms" or "/perms why <tool>")',
      };
    }
    const policy = ctx.baseConfig.permissionEngine.policy();
    return { kind: 'ok', notes: renderPolicy(policy) };
  },
};
