// Shared rendering helpers for the permission policy. Two
// consumers today:
//   - `/perms` slash command (in-REPL): renders the merged
//     policy without layer attribution (the engine doesn't
//     expose provenance to the slash layer yet).
//   - `--explain-permissions` CLI flag (pre-REPL inspection):
//     renders the same policy WITH layer attribution per
//     section.
//
// Both share the per-section formatters (allow/deny/confirm
// rule lists, host lists, path lists). Without this module the
// formatters drift — a change to the elision threshold, the
// rule-quoting convention, or the section ordering would have
// to land in two places. The shared shape also pins the
// `BashPolicy` / `PathPolicy` / `FetchPolicy` types as the
// single source for what fields each section carries.
//
// Higher-level renderers (with vs without layer attribution)
// stay in their respective consumer modules — only the
// per-section formatting and the column layout live here.

import type { SandboxProvenance } from './hierarchy.ts';
import type { BashPolicy, FetchPolicy, PathPolicy, Policy, PolicyToolsSection } from './types.ts';

// Cap the per-rule list at this count; past it we collapse to
// `(N entries)`. The operator can read the YAML directly when
// the rule set is large — chat scrollback isn't the right place
// to dump 50-line allow lists. Sized to fit the spec example
// (5 bash allow + 3 confirm + 4 deny) plus headroom — typical
// real policies stay under this; pathological ones bypass to
// the file.
export const RULE_LIST_CAP = 10;

// Format one rule list (allow/deny/confirm + their _paths and
// _hosts variants share the same shape). Returns null when there
// are no rules to render — caller drops the line. The 6-space
// prefix matches the section indent both consumers use.
export const formatRules = (label: string, rules: readonly string[] | undefined): string | null => {
  if (rules === undefined || rules.length === 0) return null;
  if (rules.length > RULE_LIST_CAP) {
    return `      ${label}: (${rules.length} entries — see policy file)`;
  }
  return `      ${label}: ${rules.map((r) => `'${r}'`).join(', ')}`;
};

// Per-section body formatters. Each returns the rule lines for
// the section (without the section header — that's the caller's
// job, since the header format differs between /perms and
// /explain).
export const formatBash = (p: BashPolicy): string[] => {
  const out: string[] = [];
  const allow = formatRules('allow', p.allow);
  const confirm = formatRules('confirm', p.confirm);
  const deny = formatRules('deny', p.deny);
  if (allow !== null) out.push(allow);
  if (confirm !== null) out.push(confirm);
  if (deny !== null) out.push(deny);
  return out;
};

export const formatPath = (p: PathPolicy): string[] => {
  const out: string[] = [];
  const allow = formatRules('allow_paths', p.allow_paths);
  const confirm = formatRules('confirm_paths', p.confirm_paths);
  const deny = formatRules('deny_paths', p.deny_paths);
  if (allow !== null) out.push(allow);
  if (confirm !== null) out.push(confirm);
  if (deny !== null) out.push(deny);
  return out;
};

export const formatFetch = (p: FetchPolicy): string[] => {
  const out: string[] = [];
  const allow = formatRules('allow_hosts', p.allow_hosts);
  const deny = formatRules('deny_hosts', p.deny_hosts);
  const trusted = formatRules('trusted_hosts', p.trusted_hosts);
  if (allow !== null) out.push(allow);
  if (deny !== null) out.push(deny);
  if (trusted !== null) out.push(trusted);
  return out;
};

// Render every declared section. Sections that exist but carry
// no rule lists (e.g. `{ locked: true }` from a higher layer
// blocking lower-layer overrides) emit no header — printing
// `bash:` with no body looks like a render bug. Tools without
// a section inherit pure default-deny under strict mode — the
// caller (renderPolicy below) surfaces that as the closing
// "(unlisted tools default-deny in strict mode)" line so the
// operator isn't misled into thinking "no entry = allowed".
const pushSection = (out: string[], name: string, body: string[]): void => {
  if (body.length === 0) return;
  out.push(`  ${name}:`);
  out.push(...body);
};

export const formatSections = (tools: PolicyToolsSection): string[] => {
  const out: string[] = [];
  if (tools.bash !== undefined) pushSection(out, 'bash', formatBash(tools.bash));
  if (tools.read_file !== undefined) pushSection(out, 'read_file', formatPath(tools.read_file));
  if (tools.write_file !== undefined) pushSection(out, 'write_file', formatPath(tools.write_file));
  if (tools.edit_file !== undefined) pushSection(out, 'edit_file', formatPath(tools.edit_file));
  if (tools.glob !== undefined) pushSection(out, 'glob', formatPath(tools.glob));
  if (tools.grep !== undefined) pushSection(out, 'grep', formatPath(tools.grep));
  if (tools.fetch_url !== undefined) pushSection(out, 'fetch_url', formatFetch(tools.fetch_url));
  return out;
};

// Render the sandbox section. Used by both `renderPolicy` (in-REPL
// `/perms`, no provenance available) and
// `renderExplainPermissions` (headless `agent perms`, with
// provenance from the layer resolver). When provenance is
// undefined every field renders bare (`required: true`); when
// provided the per-field writer becomes a `[from <layer> policy]`
// hint.
//
// Lock renders as a footer line (`(locked by <layer> policy)`) — the
// lock is conceptually about the section, not a field value. With no
// provenance the locking layer attribution drops: just `(locked)`.
//
// Body indent is 6 spaces matching `formatRules` — same shape as
// every other section so the operator's eye doesn't have to track
// two different layouts.
export const renderSandbox = (
  sandbox: NonNullable<Policy['sandbox']>,
  provenance: SandboxProvenance | undefined,
): string[] => {
  const lines: string[] = ['  sandbox:'];
  if (sandbox.required !== undefined) {
    const layer = provenance?.required;
    const hint = layer !== undefined ? ` [from ${layer} policy]` : '';
    lines.push(`      required: ${sandbox.required}${hint}`);
  }
  if (sandbox.hostAllowed !== undefined) {
    const layer = provenance?.hostAllowed;
    const hint = layer !== undefined ? ` [from ${layer} policy]` : '';
    lines.push(`      host_allowed: ${sandbox.hostAllowed}${hint}`);
  }
  if (sandbox.locked === true) {
    const layer = provenance?.locked;
    const lockHint = layer !== undefined ? ` by ${layer} policy` : '';
    lines.push(`      (locked${lockHint})`);
  }
  return lines;
};

// Render the full merged policy without layer attribution. This
// is the format the `/perms` slash command emits in the REPL
// scrollback. The pre-REPL `--explain-permissions` flag uses a
// richer renderer (in cli/explain-permissions.ts) that adds
// per-section layer hints + a layers-loaded preamble.
export const renderPolicy = (policy: Policy): string[] => {
  const mode = policy.defaults.mode ?? 'strict';
  const lines: string[] = [`policy: mode=${mode}`];
  const sectionLines = formatSections(policy.tools);
  // Render sandbox after tools.* — same order as `renderExplainPermissions`,
  // and matches the YAML layout convention (`tools:` then `sandbox:`).
  // Without provenance the renderer emits bare values; introspection
  // with attribution lives at `/perms why sandbox` and `agent perms`.
  const sandboxLines = policy.sandbox !== undefined ? renderSandbox(policy.sandbox, undefined) : [];
  if (sectionLines.length === 0 && sandboxLines.length === 0) {
    lines.push('  (no tool sections defined)');
    if (mode === 'strict') {
      lines.push("  every gated tool will be denied. Create '.forja/permissions.yaml'");
      lines.push('  with allow/confirm rules to enable tool use.');
    }
    return lines;
  }
  lines.push(...sectionLines, ...sandboxLines);
  if (mode === 'strict' && sectionLines.length > 0) {
    lines.push('  (unlisted tools default-deny in strict mode)');
  }
  return lines;
};
