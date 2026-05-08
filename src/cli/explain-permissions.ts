// Pre-REPL permission inspection: resolve the merged policy + layer
// provenance for the current cwd and print it. DB-only path; no
// provider, no API key, no harness loop.
//
// Composes with `/perms` (in-REPL) and `/perms why <tool>` (in-REPL
// dry-check) — this is the headless equivalent. Operators auditing
// a layered policy setup ("does enterprise lock the bash section?
// did my project file actually load?") get the answer without
// committing to a session, and CI / scripts get a deterministic
// stdout to grep against.
//
// Plain text only for now. JSON output is a follow-up — same shape
// pattern as --list-sessions: switch on `json` flag, emit one
// NDJSON line per layer + a summary line.

import {
  type Layer,
  type Policy,
  type SectionProvenance,
  formatBash,
  formatFetch,
  formatPath,
  resolvePolicy,
} from '../permissions/index.ts';

export interface ExplainPermissionsOptions {
  cwd: string;
  // Test seam: skip enterprise / user file lookup so unit tests
  // don't trip on the host's real `/etc/agent/permissions.yaml` or
  // `~/.config/agent/permissions.yaml`. Production callers leave
  // these undefined and the resolver does its normal discovery.
  enterprisePath?: string | null;
  userPath?: string | null;
  // Inject env for path discovery (mirrors resolvePolicy's seam).
  env?: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
}

const formatLayerLabel = (layer: Layer | 'default'): string =>
  layer === 'default' ? 'built-in default' : `${layer} policy`;

// Render one tools.<section> block with its layer attribution.
// Sections that exist but carry no rule lists (e.g. `{ locked:
// true }`) emit only the header + a "(locked)" qualifier so the
// operator sees the lock without phantom rule lines. The body
// formatters (formatBash / formatPath / formatFetch) are
// imported from `permissions/render.ts` — same shape /perms uses
// in scrollback, so the elision threshold and rule-quoting
// convention can't drift between the two surfaces.
const renderSection = (
  name: string,
  layer: Layer | undefined,
  body: string[],
  locked: boolean,
): string[] => {
  const layerHint = layer !== undefined ? ` [from ${layer} policy]` : '';
  const lockHint = locked ? ' (locked)' : '';
  const lines: string[] = [`  ${name}:${layerHint}${lockHint}`];
  lines.push(...body);
  return lines;
};

export const renderExplainPermissions = (
  policy: Policy,
  provenance: SectionProvenance,
  layers: readonly { layer: Layer; path?: string }[],
): string[] => {
  const lines: string[] = [];

  // Header lists which YAML files were loaded so the operator can
  // tell "is my project file even being read?" before parsing the
  // merged shape. Empty layers list is the "no policy file
  // anywhere" signal — engine falls back to default-strict.
  if (layers.length === 0) {
    lines.push('layers: (none — no permission YAML found at enterprise/user/project)');
  } else {
    lines.push('layers:');
    for (const l of layers) {
      const path = l.path !== undefined ? ` ${l.path}` : '';
      lines.push(`  - ${l.layer}${path}`);
    }
  }

  // Mode + provenance — operator sees BOTH "what mode is active"
  // AND "which layer chose it". `defaults: 'default'` means no
  // layer wrote mode; engine falls back to strict at emit.
  const mode = policy.defaults.mode ?? 'strict';
  const modeLayer = formatLayerLabel(provenance.defaults);
  const lockedHint = policy.defaults.locked === true ? ' (locked)' : '';
  lines.push('');
  lines.push(`policy: mode=${mode} [from ${modeLayer}]${lockedHint}`);

  // Per-section attribution. Walk the policy tree in the same
  // order /perms uses (bash → fs.* → web.fetch); sections absent
  // from the merged tree don't render at all.
  const t = policy.tools;
  if (t.bash !== undefined) {
    lines.push(
      ...renderSection('bash', provenance.bash, formatBash(t.bash), t.bash.locked === true),
    );
  }
  if (t.read_file !== undefined) {
    lines.push(
      ...renderSection(
        'read_file',
        provenance.read_file,
        formatPath(t.read_file),
        t.read_file.locked === true,
      ),
    );
  }
  if (t.write_file !== undefined) {
    lines.push(
      ...renderSection(
        'write_file',
        provenance.write_file,
        formatPath(t.write_file),
        t.write_file.locked === true,
      ),
    );
  }
  if (t.edit_file !== undefined) {
    lines.push(
      ...renderSection(
        'edit_file',
        provenance.edit_file,
        formatPath(t.edit_file),
        t.edit_file.locked === true,
      ),
    );
  }
  if (t.glob !== undefined) {
    lines.push(
      ...renderSection('glob', provenance.glob, formatPath(t.glob), t.glob.locked === true),
    );
  }
  if (t.grep !== undefined) {
    lines.push(
      ...renderSection('grep', provenance.grep, formatPath(t.grep), t.grep.locked === true),
    );
  }
  if (t.fetch_url !== undefined) {
    lines.push(
      ...renderSection(
        'fetch_url',
        provenance.fetch_url,
        formatFetch(t.fetch_url),
        t.fetch_url.locked === true,
      ),
    );
  }

  // Footer hint: in strict mode without sections, EVERY gated
  // tool default-denies. Same actionable footer /perms emits.
  const sectionCount = Object.keys(t).length;
  if (sectionCount === 0) {
    lines.push('');
    if (mode === 'strict') {
      lines.push(
        "(no tool sections defined — every gated tool will be denied. Create '.agent/permissions.yaml')",
      );
    } else {
      lines.push('(no tool sections defined)');
    }
  } else if (mode === 'strict') {
    lines.push('');
    lines.push('(unlisted tools default-deny in strict mode)');
  }

  return lines;
};

export const runExplainPermissionsCli = async (
  options: ExplainPermissionsOptions,
): Promise<number> => {
  const resolveOpts: Parameters<typeof resolvePolicy>[0] = {
    cwd: options.cwd,
  };
  if (options.enterprisePath !== undefined) resolveOpts.enterprisePath = options.enterprisePath;
  if (options.userPath !== undefined) resolveOpts.userPath = options.userPath;
  if (options.env !== undefined) resolveOpts.env = options.env;

  let resolved: ReturnType<typeof resolvePolicy>;
  try {
    resolved = resolvePolicy(resolveOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.err(`forja: failed to resolve permission policy: ${msg}\n`);
    return 1;
  }

  const lines = renderExplainPermissions(resolved.policy, resolved.provenance, resolved.layers);
  for (const line of lines) options.out(`${line}\n`);

  // Lock conflicts are warning-grade — the engine STILL produced a
  // valid merged policy, but a lower-layer override was rejected.
  // Operators auditing the policy benefit from seeing those
  // conflicts surfaced (especially in CI / scripted runs); we
  // route them to stderr to keep stdout grep-friendly for the
  // policy itself.
  if (resolved.lockConflicts.length > 0) {
    options.err('\nlock conflicts (rejected lower-layer overrides):\n');
    for (const c of resolved.lockConflicts) {
      options.err(
        `  ${c.section}: locked by ${c.lockedBy}, override attempt by ${c.attemptedBy}\n`,
      );
    }
  }

  return 0;
};
