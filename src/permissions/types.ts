// Permission engine types per AGENTIC_CLI §8.
//
// Categories group tools by what they do, so policy rules can target the
// behavior rather than every individual tool name. New tools join an
// existing category instead of inventing a new section.
export type PolicyCategory = 'fs.read' | 'fs.write' | 'bash' | 'web.fetch' | 'misc';

export type PolicyMode = 'strict' | 'acceptEdits' | 'bypass';

// Policy rules per category. Each section is optional; absence means "no
// opinion at this layer" (engine falls through to defaults).
export interface BashPolicy {
  allow?: readonly string[];
  confirm?: readonly string[];
  deny?: readonly string[];
}

export interface PathPolicy {
  allow_paths?: readonly string[];
  confirm_paths?: readonly string[];
  deny_paths?: readonly string[];
}

export interface FetchPolicy {
  allow_hosts?: readonly string[];
  deny_hosts?: readonly string[];
}

export interface PolicyToolsSection {
  bash?: BashPolicy;
  read_file?: PathPolicy;
  write_file?: PathPolicy;
  edit_file?: PathPolicy;
  glob?: PathPolicy;
  grep?: PathPolicy;
  fetch_url?: FetchPolicy;
  // Future tools fall back to category-level policy until a section exists.
}

export interface PolicyDefaults {
  mode: PolicyMode;
}

export interface Policy {
  defaults: PolicyDefaults;
  tools: PolicyToolsSection;
}

// What the engine returns from a check. The harness converts `confirm`
// into a UI prompt at invocation time; without a confirmFn, the harness
// must default to deny — silently auto-allowing a `confirm` decision is
// the bug class this type prevents.
export type Decision =
  | { kind: 'allow'; reason?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; prompt: string; reason?: string };

// Snapshot view of permissions handed to a tool's ToolContext (per
// CONTRACTS §2 line 63). Read-only — tools must not mutate. Currently
// just exposes the active mode; tools that need to short-circuit a
// multi-step plan should call back into the engine via the harness with
// the right tool name (the view can't know which tool's per-tool rules
// to consult by category alone).
export interface PermissionsView {
  mode: PolicyMode;
}
