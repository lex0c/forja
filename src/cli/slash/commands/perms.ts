// /perms — show the active permission policy.
//
// Reads via `ctx.baseConfig.permissionEngine.policy()` (deep copy,
// safe to inspect) and renders a human-readable summary as info
// lines: defaults.mode, then each tool section with its rules
// elided to counts past a threshold so the scrollback doesn't
// flood when the policy carries dozens of allow patterns.
//
// Read-only by design. Editing policy goes through the YAML files
// (`.agent/permissions.yaml` etc.) — keeps a single source of
// truth and avoids inventing a runtime mutation path that would
// diverge from the on-disk format. Spec: AGENTIC_CLI §8.

import type {
  BashPolicy,
  FetchPolicy,
  PathPolicy,
  Policy,
  PolicyToolsSection,
} from '../../../permissions/index.ts';
import type { SlashCommand } from '../types.ts';

// Cap the per-rule list at this count; past it we collapse to
// `(N entries)`. The operator can read the YAML directly when
// the rule set is large — chat scrollback isn't the right place
// to dump 50-line allow lists. Sized to fit the spec example
// (5 bash allow + 3 confirm + 4 deny) plus headroom — typical
// real policies stay under this; pathological ones bypass to
// the file.
const RULE_LIST_CAP = 10;

const formatRules = (label: string, rules: readonly string[] | undefined): string | null => {
  if (rules === undefined || rules.length === 0) return null;
  if (rules.length > RULE_LIST_CAP) {
    return `      ${label}: (${rules.length} entries — see policy file)`;
  }
  return `      ${label}: ${rules.map((r) => `'${r}'`).join(', ')}`;
};

const formatBash = (p: BashPolicy): string[] => {
  const out: string[] = [];
  const allow = formatRules('allow', p.allow);
  const confirm = formatRules('confirm', p.confirm);
  const deny = formatRules('deny', p.deny);
  if (allow !== null) out.push(allow);
  if (confirm !== null) out.push(confirm);
  if (deny !== null) out.push(deny);
  return out;
};

const formatPath = (p: PathPolicy): string[] => {
  const out: string[] = [];
  const allow = formatRules('allow_paths', p.allow_paths);
  const confirm = formatRules('confirm_paths', p.confirm_paths);
  const deny = formatRules('deny_paths', p.deny_paths);
  if (allow !== null) out.push(allow);
  if (confirm !== null) out.push(confirm);
  if (deny !== null) out.push(deny);
  return out;
};

const formatFetch = (p: FetchPolicy): string[] => {
  const out: string[] = [];
  const allow = formatRules('allow_hosts', p.allow_hosts);
  const deny = formatRules('deny_hosts', p.deny_hosts);
  if (allow !== null) out.push(allow);
  if (deny !== null) out.push(deny);
  return out;
};

// Render each declared section. Sections that exist but carry
// no rule lists (e.g. `{ locked: true }` from a higher layer
// blocking lower-layer overrides) emit no header — printing
// `bash:` with no body looks like a render bug. Tools without
// a section inherit pure default-deny under strict mode — the
// renderer surfaces that as the closing `(unlisted tools
// default-deny in strict mode)` line so the operator isn't
// misled into thinking "no entry = allowed".
const pushSection = (out: string[], name: string, body: string[]): void => {
  if (body.length === 0) return;
  out.push(`  ${name}:`);
  out.push(...body);
};

const formatSections = (tools: PolicyToolsSection): string[] => {
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

export const renderPolicy = (policy: Policy): string[] => {
  const mode = policy.defaults.mode ?? 'strict';
  const lines: string[] = [`policy: mode=${mode}`];
  const sectionLines = formatSections(policy.tools);
  if (sectionLines.length === 0) {
    lines.push('  (no tool sections defined)');
    if (mode === 'strict') {
      lines.push("  every gated tool will be denied. Create '.agent/permissions.yaml'");
      lines.push('  with allow/confirm rules to enable tool use.');
    }
    return lines;
  }
  lines.push(...sectionLines);
  if (mode === 'strict') {
    lines.push('  (unlisted tools default-deny in strict mode)');
  }
  return lines;
};

export const permsCommand: SlashCommand = {
  name: 'perms',
  description: 'show the active permission policy',
  exec: async (args, ctx) => {
    if (args.length > 0) {
      return { kind: 'error', message: '/perms: takes no arguments' };
    }
    const policy = ctx.baseConfig.permissionEngine.policy();
    return { kind: 'ok', notes: renderPolicy(policy) };
  },
};
