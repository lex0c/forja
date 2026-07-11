import { existsSync } from 'node:fs';
import { defaultPolicy, loadPolicyFromFile, type ParsePolicyContext } from './config.ts';
import { enterprisePolicyPath, projectPolicyPath, userPolicyPath } from './paths.ts';
import type { Policy, PolicyDefaults, PolicyMode, PolicyToolsSection } from './types.ts';

// Structural JSON stringify that sorts keys at every nesting
// level. Used by the seal-lock deep-equal compare so two
// semantically-equal seal objects with different property ordering
// (e.g., disk-loaded YAML in `{ mode, path, locked }` canonical
// order vs programmatic embedder building `{ path, mode, locked }`)
// produce the same string.
const stableJsonStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableJsonStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
};

// Hierarchy resolution: enterprise → user → project → session,
// with `locked` semantics. Higher-precedence layers can mark
// sections as locked, preventing lower layers from overriding
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

// Provenance of each merged section. Tracks which layer was the
// LAST WRITER for each section in the final merged policy. The
// modal layer + `/perms why` consume this to answer "which YAML
// file holds this rule" without replaying the merge.
//
// `defaults` covers `defaults.mode`. Set to:
//   - the layer that explicitly wrote `defaults.mode`
//   - 'default' when no layer set mode (resolver fell back to
//     'strict' at emit time)
//
// Per-section keys are absent when no layer wrote that section.
// The engine reads provenance for whatever section it consults;
// an absent entry means "no policy section exists" → engine fell
// into default-deny, source.layer='default'.

// Per-field provenance for the sandbox section. Each field tracks
// the layer that LAST wrote it; a lock conflict does NOT update
// the writer (the lower layer's change was discarded). `/perms
// why sandbox.required` reads `required`; `/perms why
// sandbox.locked` reads `locked` — operators get field-level
// attribution instead of a single "last writer of anything"
// Layer.
//
// Aggregate "did anything write this section?" check:
// `provenance.sandbox !== undefined` since the resolver omits the
// whole sub-object when no field was written.
export interface SandboxProvenance {
  required?: Layer;
  hostAllowed?: Layer;
  locked?: Layer;
}

export interface SectionProvenance {
  defaults: Layer | 'default';
  bash?: Layer;
  read_file?: Layer;
  write_file?: Layer;
  edit_file?: Layer;
  glob?: Layer;
  grep?: Layer;
  fetch_url?: Layer;
  mcp?: Layer;
  // Policy-layer sandbox section. Per-field writer attribution.
  // Absent when no layer wrote any sandbox field.
  sandbox?: SandboxProvenance;
  // Sealing section. Single-layer-wins — the layer that LAST set
  // `seal: {...}` is the writer. Absent when no layer wrote a
  // seal section.
  seal?: Layer;
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
  // path patterns. When omitted, the protected-paths check is
  // skipped — tests typically omit; production bootstrap passes
  // the operator's HOME explicitly so a malformed policy file
  // fails load instead of failing at first tool call.
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
  'mcp',
];

// Load each layer if its file exists. enterprisePath=null disables
// the enterprise lookup entirely (test seam to avoid touching /etc).
const loadLayers = (options: ResolveOptions): LayerPolicy[] => {
  const out: LayerPolicy[] = [];

  // Same parse context for every layer. Each loaded policy file
  // runs through the same protected-paths validation; a higher
  // layer (e.g. enterprise) that ships a protected-path
  // redefinition fails the entire boot, not just its own layer.
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
  // Sandbox section. Field-by-field last-writer wins UNTIL a
  // layer sets `locked: true`; from that point lower layers can't
  // change `required` or `hostAllowed` (re-affirming the same
  // values is silent; an actual change records a `lockConflict`).
  // Per-field writers tracked separately so `/perms why
  // sandbox.required` reads the `required` writer, etc.
  let sandboxRequired: boolean | undefined;
  let sandboxHostAllowed: boolean | undefined;
  let sandboxLockedBy: Layer | null = null;
  let sandboxRequiredWriter: Layer | null = null;
  let sandboxHostAllowedWriter: Layer | null = null;
  let sandboxLockedWriter: Layer | null = null;
  // Seal section. Single-layer-wins semantics — whatever layer is
  // LAST to set `seal: { ... }` defines the entire section.
  // Cross-layer field merge would create surprising configs
  // (enterprise sets mode, user accidentally overrides path);
  // all-or-nothing keeps operator intent obvious.
  //
  // Lock semantics: with `locked: true` at a higher layer, lower
  // layers can't override; re-asserting the EXACT same config is
  // silent (compared via canonical-JSON deep equality); actual
  // differences flag a `lockConflict` and the lower layer's
  // version is discarded. Without this lock, an enterprise-
  // mandated `worm-file` config could be silently swapped for
  // `mode: none` by project policy, defeating the forensic
  // guarantee.
  let mergedSeal: Policy['seal'];
  let sealWriter: Layer | null = null;
  let sealLockedBy: Layer | null = null;
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

    // Sandbox section — field-by-field last-writer wins until a
    // layer sets `locked: true`. After that, lower layers can
    // re-affirm the same field values silently, but any actual
    // change records a `lockConflict` and is discarded.
    if (policy.sandbox !== undefined) {
      const incoming = policy.sandbox;
      if (sandboxLockedBy !== null) {
        // Already locked by an earlier layer. Re-affirmations
        // (setting a field to its current merged value) are silent;
        // actual changes flag a conflict and are dropped. Same
        // semantics as `defaults.locked` / tools.* locks above.
        const requiredChanged =
          incoming.required !== undefined && incoming.required !== sandboxRequired;
        const hostAllowedChanged =
          incoming.hostAllowed !== undefined && incoming.hostAllowed !== sandboxHostAllowed;
        if (requiredChanged || hostAllowedChanged) {
          lockConflicts.push({
            section: 'sandbox',
            lockedBy: sandboxLockedBy,
            attemptedBy: layer,
          });
        }
        // Locked layers never mutate sandboxRequired / sandboxHostAllowed.
      } else {
        if (incoming.required !== undefined) {
          sandboxRequired = incoming.required;
          sandboxRequiredWriter = layer;
        }
        if (incoming.hostAllowed !== undefined) {
          sandboxHostAllowed = incoming.hostAllowed;
          sandboxHostAllowedWriter = layer;
        }
        if (incoming.locked === true) {
          sandboxLockedBy = layer;
          // Activating the lock attributes the `locked` field's
          // provenance to this layer. `required` / `hostAllowed`
          // writers stay at whoever last set them (or null if no
          // layer set them, which captures the "lock-only layer
          // freezes inherited undefined state" case).
          sandboxLockedWriter = layer;
        }
      }
    }

    // Seal section — last-writer-wins for the whole section, with
    // lock semantics layered on. When a higher layer set
    // `locked: true`, lower layers can re-affirm the same seal
    // config silently (deep-equal compare via canonical JSON) but
    // actual differences flag a lockConflict.
    if (policy.seal !== undefined) {
      const incoming = policy.seal;
      if (sealLockedBy !== null) {
        // Already locked. Compare incoming to merged via
        // canonical-JSON deep-equal. parsePolicy normalizes keys
        // to canonical order for YAML-loaded policies, so a
        // direct `JSON.stringify(a) === JSON.stringify(b)` would
        // work there. But `options.session` is forwarded WITHOUT
        // re-parsing — a programmatic caller building `{ path,
        // mode, locked }` (different key order vs the canonical
        // `{ mode, path, locked }`) would spurious-flag
        // lockConflict. Sort keys before stringify so the
        // equality is structural.
        const incomingJson = stableJsonStringify(incoming);
        const mergedJson = mergedSeal === undefined ? undefined : stableJsonStringify(mergedSeal);
        if (incomingJson !== mergedJson) {
          lockConflicts.push({
            section: 'seal',
            lockedBy: sealLockedBy,
            attemptedBy: layer,
          });
        }
        // Locked layers never mutate mergedSeal.
      } else {
        mergedSeal = incoming;
        sealWriter = layer;
        if (incoming.locked === true) {
          sealLockedBy = layer;
        }
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
  // back to 'default' when no layer wrote mode (so the engine can
  // render "default-deny — strict mode (built-in default)"
  // honestly, distinct from "user policy chose strict mode").
  //
  // Sandbox provenance is per-field — `/perms why sandbox.required`
  // and `.hostAllowed` and `.locked` each read their own writer.
  // The aggregate sub-object is omitted entirely when no field was
  // written.
  const sandboxProvenance: SandboxProvenance | undefined =
    sandboxRequiredWriter !== null ||
    sandboxHostAllowedWriter !== null ||
    sandboxLockedWriter !== null
      ? {
          ...(sandboxRequiredWriter !== null ? { required: sandboxRequiredWriter } : {}),
          ...(sandboxHostAllowedWriter !== null ? { hostAllowed: sandboxHostAllowedWriter } : {}),
          ...(sandboxLockedWriter !== null ? { locked: sandboxLockedWriter } : {}),
        }
      : undefined;
  const provenance: SectionProvenance = {
    defaults: defaultsModeWriter ?? 'default',
    ...(sectionWriter.bash !== undefined ? { bash: sectionWriter.bash } : {}),
    ...(sectionWriter.read_file !== undefined ? { read_file: sectionWriter.read_file } : {}),
    ...(sectionWriter.write_file !== undefined ? { write_file: sectionWriter.write_file } : {}),
    ...(sectionWriter.edit_file !== undefined ? { edit_file: sectionWriter.edit_file } : {}),
    ...(sectionWriter.glob !== undefined ? { glob: sectionWriter.glob } : {}),
    ...(sectionWriter.grep !== undefined ? { grep: sectionWriter.grep } : {}),
    ...(sectionWriter.fetch_url !== undefined ? { fetch_url: sectionWriter.fetch_url } : {}),
    ...(sectionWriter.mcp !== undefined ? { mcp: sectionWriter.mcp } : {}),
    ...(sandboxProvenance !== undefined ? { sandbox: sandboxProvenance } : {}),
  };

  // Sandbox section: emit only when at least one field was
  // written by some layer OR when a layer activated the lock.
  // Bootstrap's defaults (`required: false`, `hostAllowed: false`)
  // handle the absent case. The `locked` flag flows through so
  // downstream consumers can render "frozen by enterprise" in
  // `/perms why sandbox`.
  const mergedSandbox: Policy['sandbox'] =
    sandboxRequired !== undefined || sandboxHostAllowed !== undefined || sandboxLockedBy !== null
      ? {
          ...(sandboxRequired !== undefined ? { required: sandboxRequired } : {}),
          ...(sandboxHostAllowed !== undefined ? { hostAllowed: sandboxHostAllowed } : {}),
          ...(sandboxLockedBy !== null ? { locked: true } : {}),
        }
      : undefined;

  return {
    policy: {
      defaults: mergedDefaults,
      tools: mergedTools,
      ...(mergedSandbox !== undefined ? { sandbox: mergedSandbox } : {}),
      ...(mergedSeal !== undefined ? { seal: mergedSeal } : {}),
    },
    lockConflicts,
    provenance: {
      ...provenance,
      ...(sealWriter !== null ? { seal: sealWriter } : {}),
    },
  };
};

// Direct merge over a hand-constructed LayerPolicy[] — bypasses
// `loadLayers`'s file-discovery step. The conformance runner uses
// this to test hierarchy precedence + locked-section behavior with
// raw YAML strings as setup, no temp files required. Production
// code uses `resolvePolicy` (which calls `loadLayers` then this
// merge); the export is intentionally minimal so test surfaces
// can't accidentally smuggle production behavior changes through.
export const mergeLayers = (
  layers: readonly LayerPolicy[],
): { policy: Policy; lockConflicts: LockConflict[]; provenance: SectionProvenance } => {
  return merge(layers);
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
