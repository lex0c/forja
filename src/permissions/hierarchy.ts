import { existsSync } from 'node:fs';
import { type ParsePolicyContext, defaultPolicy, loadPolicyFromFile } from './config.ts';
import { enterprisePolicyPath, projectPolicyPath, userPolicyPath } from './paths.ts';
import type { Policy, PolicyDefaults, PolicyMode, PolicyToolsSection } from './types.ts';

// Hierarchy resolution per AGENTIC_CLI §8: enterprise → user → project
// → session, with `locked` semantics. Higher-precedence layers can
// mark sections as locked, preventing lower layers from overriding
// them. Absent files at any layer are skipped (no error).
//
// Merge semantics for non-locked sections: REPLACE, not extend. A
// lower layer that defines `tools.bash` fully replaces the higher
// layer's `tools.bash`. Predictable + matches how most config systems
// behave; users who want to extend re-list everything. The lock bit
// on a section is the override-blocking primitive — once set, lower
// layers' attempts to redefine that section are dropped (with a
// warning surfaced via the `lockConflicts` array).

export type Layer = 'enterprise' | 'user' | 'project' | 'session';

export interface LayerPolicy {
  layer: Layer;
  policy: Policy;
  // Path the policy was loaded from (for diagnostics). Absent for
  // layers that were synthesized rather than loaded from disk —
  // notably 'session' which today comes from runtime injection.
  path?: string;
}

export interface LockConflict {
  // Which section was locked + which lower layer tried to override.
  section: string;
  lockedBy: Layer;
  attemptedBy: Layer;
}

// Provenance of each merged section (PolicyLayer in types.ts).
// Tracks which layer was the LAST WRITER for each section in the
// final merged policy. The modal layer + `/perms why` consume
// this to answer "which YAML file holds this rule" without
// replaying the merge.
//
// `defaults` covers `defaults.mode`. Set to:
//   - the layer that explicitly wrote `defaults.mode`
//   - 'default' when no layer set mode (resolver fell back to
//     'strict' at emit time)
//
// Per-section keys are absent when no layer wrote that section.
// The engine reads provenance for whatever section it consults;
// an absent entry means "no policy section exists" → engine
// fell into default-deny, source.layer='default'.
export interface SectionProvenance {
  defaults: Layer | 'default';
  bash?: Layer;
  read_file?: Layer;
  write_file?: Layer;
  edit_file?: Layer;
  glob?: Layer;
  grep?: Layer;
  fetch_url?: Layer;
  // PERMISSION_ENGINE.md §6.5 policy-layer sandbox section.
  // Tracks the last writer of `policy.sandbox` (any field). Absent
  // when no layer wrote a sandbox block — bootstrap falls back to
  // hardcoded defaults (`required: false`, `hostAllowed: false`).
  sandbox?: Layer;
}

export interface ResolveResult {
  policy: Policy;
  layers: LayerPolicy[];
  lockConflicts: LockConflict[];
  provenance: SectionProvenance;
}

export interface ResolveOptions {
  cwd: string;
  // Test seams + override hooks. When provided, these short-circuit
  // path discovery for the corresponding layer.
  enterprisePath?: string | null;
  userPath?: string | null;
  // Session-layer policy (CLI flags or runtime overrides). Optional;
  // typically empty in M1.
  session?: Policy;
  // Inject the env table for path discovery. Lets tests run with a
  // controlled XDG_CONFIG_HOME without touching process.env.
  env?: NodeJS.ProcessEnv;
  // Home directory used by parsePolicy when validating protected
  // path patterns (PERMISSION_ENGINE.md §11). When omitted, the
  // protected-paths check is skipped — tests typically omit; the
  // production bootstrap passes the operator's HOME explicitly so
  // a malformed policy file fails load instead of failing at first
  // tool call.
  home?: string;
}

const SECTION_KEYS: readonly (keyof PolicyToolsSection)[] = [
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'fetch_url',
];

// Load each layer if its file exists. enterprisePath=null disables
// the enterprise lookup entirely (test seam to avoid touching /etc).
const loadLayers = (options: ResolveOptions): LayerPolicy[] => {
  const out: LayerPolicy[] = [];

  // Same parse context for every layer. Each loaded policy file runs
  // through the same §11 validation; a higher layer (e.g. enterprise)
  // that ships a protected-path redefinition fails the entire boot,
  // not just its own layer.
  const parseCtx: ParsePolicyContext = {
    cwd: options.cwd,
    ...(options.home !== undefined ? { home: options.home } : {}),
  };

  const enterprisePath =
    options.enterprisePath === null
      ? null
      : (options.enterprisePath ?? enterprisePolicyPath(undefined, options.env));
  if (enterprisePath !== null && existsSync(enterprisePath)) {
    out.push({
      layer: 'enterprise',
      policy: loadPolicyFromFile(enterprisePath, parseCtx),
      path: enterprisePath,
    });
  }

  const userPath =
    options.userPath === null ? null : (options.userPath ?? userPolicyPath(options.env));
  if (userPath !== null && existsSync(userPath)) {
    out.push({
      layer: 'user',
      policy: loadPolicyFromFile(userPath, parseCtx),
      path: userPath,
    });
  }

  const projPath = projectPolicyPath(options.cwd);
  if (existsSync(projPath)) {
    out.push({
      layer: 'project',
      policy: loadPolicyFromFile(projPath, parseCtx),
      path: projPath,
    });
  }

  if (options.session !== undefined) {
    out.push({ layer: 'session', policy: options.session });
  }

  return out;
};

// Walk layers in precedence order (enterprise first, session last).
// Each layer can REPLACE earlier sections OR be REJECTED by an
// earlier lock. The first time a section is set, its `locked` field
// is sticky — subsequent layers can no longer modify that section.
const merge = (
  layers: readonly LayerPolicy[],
): { policy: Policy; lockConflicts: LockConflict[]; provenance: SectionProvenance } => {
  // Track mode as `undefined` until a layer explicitly sets it. The
  // final fallback to 'strict' happens at emit time so layers that
  // omit `defaults.mode` don't trip the lock-conflict log against a
  // higher-precedence layer that locked the field.
  let mergedMode: PolicyMode | undefined;
  let defaultsLocked: boolean | undefined;
  let defaultsLockedBy: Layer | null = null;
  // Last-writer for `defaults.mode`. Stays null until a layer
  // sets mode explicitly; the resolver flips it to 'default' at
  // emit time when no layer wrote.
  let defaultsModeWriter: Layer | null = null;
  const mergedTools: PolicyToolsSection = {};
  const sectionLockedBy: Partial<Record<keyof PolicyToolsSection, Layer>> = {};
  const sectionWriter: Partial<Record<keyof PolicyToolsSection, Layer>> = {};
  // §6.5 sandbox section. Field-by-field last-writer wins; no
  // section-level lock yet (documented in PolicySandbox). The
  // writer tracker captures the LAST layer that wrote ANY sandbox
  // field — for provenance + `/perms why sandbox` introspection.
  let sandboxRequired: boolean | undefined;
  let sandboxHostAllowed: boolean | undefined;
  let sandboxWriter: Layer | null = null;
  const lockConflicts: LockConflict[] = [];

  for (const { layer, policy } of layers) {
    // defaults.mode and defaults.locked are independent — a layer
    // can set `locked: true` WITHOUT setting `mode` to freeze the
    // inherited (or default) value, and the lock must still apply.
    // The prior implementation nested `locked` inside the
    // mode-was-set branch, so a "lock-only" layer silently failed
    // to lock anything and lower layers could override the mode
    // with no conflict reported.
    const incomingMode = policy.defaults.mode;
    const incomingLocked = policy.defaults.locked === true;

    if (defaultsLockedBy !== null) {
      // Already locked by an earlier layer. This layer can't
      // change mode; only flag a conflict when it explicitly
      // tried (mode set AND different from merged value). A
      // layer that re-asserts the same mode or sets locked:true
      // (re-affirming the lock) is silently OK.
      if (incomingMode !== undefined && incomingMode !== mergedMode) {
        lockConflicts.push({
          section: 'defaults.mode',
          lockedBy: defaultsLockedBy,
          attemptedBy: layer,
        });
      }
    } else {
      // Not yet locked. Apply mode change and/or lock activation.
      if (incomingMode !== undefined) {
        mergedMode = incomingMode;
        defaultsModeWriter = layer;
      }
      if (incomingLocked) {
        // Lock applies to whatever mergedMode is — possibly
        // inherited from an earlier layer, possibly still
        // undefined (resolver fills with default 'strict' at
        // emit). Either way the freeze is enforced from here on.
        defaultsLocked = true;
        defaultsLockedBy = layer;
      }
    }

    // §6.5 sandbox section — field-by-field last-writer wins.
    // A layer that omits a field doesn't override the inherited
    // value; a layer that sets a field overrides it. No
    // section-level lock for sandbox in this slice.
    if (policy.sandbox !== undefined) {
      const incoming = policy.sandbox;
      let wroteSomething = false;
      if (incoming.required !== undefined) {
        sandboxRequired = incoming.required;
        wroteSomething = true;
      }
      if (incoming.hostAllowed !== undefined) {
        sandboxHostAllowed = incoming.hostAllowed;
        wroteSomething = true;
      }
      if (wroteSomething) {
        sandboxWriter = layer;
      }
    }

    // tools.* sections
    for (const key of SECTION_KEYS) {
      const incoming = policy.tools[key];
      const lockedBy = sectionLockedBy[key];
      if (lockedBy !== undefined) {
        // Locked by an earlier layer; reject any non-empty override.
        if (incoming !== undefined) {
          lockConflicts.push({
            section: `tools.${key}`,
            lockedBy,
            attemptedBy: layer,
          });
        }
        continue;
      }
      if (incoming !== undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: section types differ per key — narrowing per branch would not improve safety.
        (mergedTools as any)[key] = incoming;
        sectionWriter[key] = layer;
        if (incoming.locked === true) {
          sectionLockedBy[key] = layer;
        }
      }
    }
  }

  // Fall back to strict at emit time when no layer set mode. Engine
  // also guards (`?? 'strict'`) but emitting a concrete value keeps
  // the merged policy self-describing for `agent perms` introspection.
  const mergedDefaults: PolicyDefaults = {
    mode: mergedMode ?? 'strict',
    ...(defaultsLocked !== undefined ? { locked: defaultsLocked } : {}),
  };

  // Build provenance from the writer trackers. `defaults` falls
  // back to 'default' when no layer wrote mode (so the engine
  // can render "default-deny — strict mode (built-in default)"
  // honestly, distinct from "user policy chose strict mode").
  const provenance: SectionProvenance = {
    defaults: defaultsModeWriter ?? 'default',
    ...(sectionWriter.bash !== undefined ? { bash: sectionWriter.bash } : {}),
    ...(sectionWriter.read_file !== undefined ? { read_file: sectionWriter.read_file } : {}),
    ...(sectionWriter.write_file !== undefined ? { write_file: sectionWriter.write_file } : {}),
    ...(sectionWriter.edit_file !== undefined ? { edit_file: sectionWriter.edit_file } : {}),
    ...(sectionWriter.glob !== undefined ? { glob: sectionWriter.glob } : {}),
    ...(sectionWriter.grep !== undefined ? { grep: sectionWriter.grep } : {}),
    ...(sectionWriter.fetch_url !== undefined ? { fetch_url: sectionWriter.fetch_url } : {}),
    ...(sandboxWriter !== null ? { sandbox: sandboxWriter } : {}),
  };

  // §6.5 sandbox section: emit only when at least one field was
  // written by some layer. Bootstrap's defaults (`required: false`,
  // `hostAllowed: false`) handle the absent case.
  const mergedSandbox: Policy['sandbox'] =
    sandboxRequired !== undefined || sandboxHostAllowed !== undefined
      ? {
          ...(sandboxRequired !== undefined ? { required: sandboxRequired } : {}),
          ...(sandboxHostAllowed !== undefined ? { hostAllowed: sandboxHostAllowed } : {}),
        }
      : undefined;

  return {
    policy: {
      defaults: mergedDefaults,
      tools: mergedTools,
      ...(mergedSandbox !== undefined ? { sandbox: mergedSandbox } : {}),
    },
    lockConflicts,
    provenance,
  };
};

// Public entry — discover layers, merge, return the effective policy
// plus the layer trail and any lock conflicts. Bootstrap consumes
// `policy`; CLI rendering / debug surfaces consume `layers` and
// `lockConflicts` for `agent perms` style introspection. Engine
// consumes `provenance` so each Decision can carry the source
// layer/section it came from (modal layer + `/perms why` render
// this for the operator).
export const resolvePolicy = (options: ResolveOptions): ResolveResult => {
  const layers = loadLayers(options);
  if (layers.length === 0) {
    return {
      policy: defaultPolicy(),
      layers: [],
      lockConflicts: [],
      // No layer means everything is built-in default. Engine
      // will read this and stamp source.layer='default' on every
      // Decision.
      provenance: { defaults: 'default' },
    };
  }
  const { policy, lockConflicts, provenance } = merge(layers);
  return { policy, layers, lockConflicts, provenance };
};
