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
// Plain text by default. `--json` (slice 38) toggles NDJSON output:
// one `{"kind":"layer",...}` event per loaded YAML file, then one
// `{"kind":"merged",...}` event with the full resolved policy +
// per-section provenance + lockConflicts. Same convention as
// --list-sessions: each line is a self-contained JSON object,
// `kind` discriminates. Consumers stream-parse via jq or similar.

import { projectDirName } from '../config/app-namespace.ts';
import {
  type Layer,
  type LayerPolicy,
  type LockConflict,
  type Policy,
  type SectionProvenance,
  formatBash,
  formatFetch,
  formatPath,
  renderSandbox,
  resolvePolicy,
} from '../permissions/index.ts';

export interface ExplainPermissionsOptions {
  cwd: string;
  // Test seam: skip enterprise / user file lookup so unit tests
  // don't trip on the host's real `/etc/forja/permissions.yaml` or
  // `~/.config/forja/permissions.yaml`. Production callers leave
  // these undefined and the resolver does its normal discovery.
  enterprisePath?: string | null;
  userPath?: string | null;
  // Inject env for path discovery (mirrors resolvePolicy's seam).
  env?: NodeJS.ProcessEnv;
  // NDJSON output mode. When true, the renderer skips the human
  // text and emits one JSON line per layer + a merged-summary line.
  // Lock conflicts move from stderr into the merged event so stdout
  // stays a pure stream (project convention from CLAUDE.md hard
  // rules: "stdout is pure, stderr is for logs").
  json?: boolean;
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

// §6.5 sandbox renderer lives in permissions/render.ts so both
// `/perms` (in-REPL) and this headless surface share the exact same
// formatting. Imported via the barrel.

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

  // §6.5 sandbox section. Per-field attribution per slice 35: each
  // line carries its own writer. The lock is rendered as a footer
  // line (conceptually about the section, not a field value). When
  // no layer wrote sandbox the block is omitted entirely — `/perms
  // why sandbox` outputs nothing for chains that never opted in.
  if (policy.sandbox !== undefined) {
    lines.push(...renderSandbox(policy.sandbox, provenance.sandbox));
  }

  // Footer hint: in strict mode without sections, EVERY gated
  // tool default-denies. Same actionable footer /perms emits.
  const sectionCount = Object.keys(t).length;
  if (sectionCount === 0) {
    lines.push('');
    if (mode === 'strict') {
      lines.push(
        `(no tool sections defined — every gated tool will be denied. Create '${projectDirName()}/permissions.yaml')`,
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

// NDJSON output (slice 38). Two event shapes:
//   - `{"kind":"layer","layer":"<name>","path":"<file>"}` — one per
//     loaded YAML file, in discovery order (enterprise → user →
//     project). Absent `path` field when the resolver knew the
//     layer's existence without a concrete file (rare; tests only).
//   - `{"kind":"merged","policy":<Policy>,"provenance":<SectionProvenance>,
//      "lockConflicts":[<LockConflict>,...]}` — emitted once after
//     the layer events. Carries the full effective shape; consumers
//     don't need to re-resolve. `lockConflicts` is always an array
//     (empty when none), so `jq '.lockConflicts[]'` is safe in
//     either case.
const writeJson = (
  layers: readonly LayerPolicy[],
  policy: Policy,
  provenance: SectionProvenance,
  lockConflicts: readonly LockConflict[],
  out: (s: string) => void,
): void => {
  for (const l of layers) {
    const entry: { kind: 'layer'; layer: Layer; path?: string } = {
      kind: 'layer',
      layer: l.layer,
    };
    if (l.path !== undefined) entry.path = l.path;
    out(`${JSON.stringify(entry)}\n`);
  }
  out(
    `${JSON.stringify({
      kind: 'merged',
      policy,
      provenance,
      lockConflicts,
    })}\n`,
  );
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

  if (options.json === true) {
    // NDJSON output: stdout stays pure (events only), stderr stays
    // silent on the happy path. Lock conflicts move INTO the merged
    // event — consumers parse one stream, not two. Resolve-failure
    // errors still land on stderr (handled above) since they're
    // diagnostics, not data.
    writeJson(
      resolved.layers,
      resolved.policy,
      resolved.provenance,
      resolved.lockConflicts,
      options.out,
    );
    return 0;
  }

  const lines = renderExplainPermissions(resolved.policy, resolved.provenance, resolved.layers);
  for (const line of lines) options.out(`${line}\n`);

  // Lock conflicts are warning-grade — the engine STILL produced a
  // valid merged policy, but a lower-layer override was rejected.
  // Operators auditing the policy benefit from seeing those
  // conflicts surfaced (especially in CI / scripted runs); we
  // route them to stderr to keep stdout grep-friendly for the
  // policy itself. JSON mode folds them into the merged event
  // instead (see above).
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
