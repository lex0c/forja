import { readFileSync } from 'node:fs';
import type { HookConfigPaths } from './paths.ts';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  type HookConfigWarning,
  type HookEvent,
  type HookLayer,
  type HookMatcher,
  type HookSpec,
  MAX_HOOK_TIMEOUT_MS,
  MIN_HOOK_TIMEOUT_MS,
  type ResolvedHookConfig,
} from './types.ts';

// Hook config loader (spec AGENTIC_CLI.md §10.2 + §10.3
// hierarchy line 1007).
//
// Reads the three layer files (enterprise / user / project),
// validates each TOML against the expected `[[hooks]]` shape,
// and merges into a single ordered list with locking semantics.
//
// TOML parsing uses `Bun.TOML.parse` — Bun ships a native parser
// matching the spec format example, so no external dep is
// needed. Errors from the parser are surfaced as
// `unreadable_file` warnings (the layer is treated as empty);
// silent failure here would leave the operator wondering why
// their hook config didn't take effect.
//
// Locking semantics mirror `permissions/hierarchy.ts`:
// - `locked: true` is honored ONLY when declared in the
//   enterprise layer. User/project declarations of `locked` are
//   ignored + warn (operator should know their flag is no-op).
// - Lower layers cannot remove or override locked hooks. The
//   loader doesn't enforce removal because each layer's hooks
//   are independent entries (no key collision); but a future
//   `disable_event` flag could trip this check.
//
// Validation policy: malformed individual entries are dropped
// with a warning; the layer's other entries continue to load.
// A whole-file parse failure drops the entire layer with one
// warning. Forward compat: unknown fields on entries are
// preserved into the warning (so the operator sees their typo)
// but don't fail the entry.

// Closed list of valid event strings. Adding a new event
// requires extending this AND the HookEvent union AND the audit
// table CHECK constraint.
const VALID_EVENTS: ReadonlySet<string> = new Set<HookEvent>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'Notification',
  'PreCheckpoint',
  'MemoryWrite',
  'Stop',
]);

// Validate a single parsed entry. Returns null + a warning when
// invalid; returns the spec when valid. The layer is passed in
// because lock semantics depend on origin.
const validateEntry = (
  raw: unknown,
  layer: HookLayer,
  sourcePath: string,
  index: number,
): { spec: HookSpec; warning?: HookConfigWarning } | { warning: HookConfigWarning } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      warning: {
        kind: 'invalid_entry',
        layer,
        sourcePath,
        message: `hook entry #${index} is not a table`,
      },
    };
  }
  const obj = raw as Record<string, unknown>;

  const event = obj.event;
  if (typeof event !== 'string' || !VALID_EVENTS.has(event)) {
    return {
      warning: {
        kind: 'invalid_entry',
        layer,
        sourcePath,
        message: `hook entry #${index}: event must be one of: ${[...VALID_EVENTS].join(', ')} (got ${JSON.stringify(event)})`,
      },
    };
  }

  const command = obj.command;
  if (typeof command !== 'string' || command.length === 0) {
    return {
      warning: {
        kind: 'invalid_entry',
        layer,
        sourcePath,
        message: `hook entry #${index} (event ${event}): command must be a non-empty string`,
      },
    };
  }

  // matcher is optional. When present, must be an object
  // (inline table). Today we only honor `tool: string`; other
  // fields are forward-compat noise.
  let matcher: HookMatcher = {};
  const rawMatcher = obj.matcher;
  if (rawMatcher !== undefined) {
    if (rawMatcher === null || typeof rawMatcher !== 'object' || Array.isArray(rawMatcher)) {
      return {
        warning: {
          kind: 'invalid_entry',
          layer,
          sourcePath,
          message: `hook entry #${index}: matcher must be an inline table`,
        },
      };
    }
    const matcherObj = rawMatcher as Record<string, unknown>;
    if (matcherObj.tool !== undefined) {
      if (typeof matcherObj.tool !== 'string' || matcherObj.tool.length === 0) {
        return {
          warning: {
            kind: 'invalid_entry',
            layer,
            sourcePath,
            message: `hook entry #${index}: matcher.tool must be a non-empty string when present`,
          },
        };
      }
      matcher = { tool: matcherObj.tool };
    }
  }

  // timeout_ms: optional, integer ms, clamped to
  // [MIN_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS].
  let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
  let timeoutWarning: HookConfigWarning | undefined;
  const rawTimeout = obj.timeout_ms;
  if (rawTimeout !== undefined) {
    // Number.isInteger rejects non-numbers, NaN, Infinity,
    // AND fractional values in one check. Without the
    // integer guard, `timeout_ms = 2500.5` would silently
    // propagate as a non-integer setTimeout delay (platform
    // may truncate or round inconsistently). The validator's
    // documented contract says "integer ms"; honor it.
    // Common operator
    // mistakes this catches: accidental decimal (`5.0` from a
    // unit-conversion pass) or unit-mismatch (`0.5` intending
    // "half a second" while the field expects ms).
    if (typeof rawTimeout !== 'number' || !Number.isInteger(rawTimeout) || rawTimeout < 0) {
      return {
        warning: {
          kind: 'invalid_entry',
          layer,
          sourcePath,
          message: `hook entry #${index}: timeout_ms must be a non-negative integer`,
        },
      };
    }
    const clamped = Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(MIN_HOOK_TIMEOUT_MS, rawTimeout));
    if (clamped !== rawTimeout) {
      timeoutWarning = {
        kind: 'invalid_entry',
        layer,
        sourcePath,
        message: `hook entry #${index}: timeout_ms ${rawTimeout} clamped to ${clamped} (allowed range: ${MIN_HOOK_TIMEOUT_MS}-${MAX_HOOK_TIMEOUT_MS})`,
      };
    }
    timeoutMs = clamped;
  }

  // fail_closed: optional bool, default false.
  let failClosed = false;
  const rawFailClosed = obj.fail_closed;
  if (rawFailClosed !== undefined) {
    if (typeof rawFailClosed !== 'boolean') {
      return {
        warning: {
          kind: 'invalid_entry',
          layer,
          sourcePath,
          message: `hook entry #${index}: fail_closed must be a boolean`,
        },
      };
    }
    failClosed = rawFailClosed;
  }

  // locked: only enterprise layer can declare. User/project
  // declarations are ignored + warned.
  let locked = false;
  let lockWarning: HookConfigWarning | undefined;
  const rawLocked = obj.locked;
  if (rawLocked !== undefined) {
    if (typeof rawLocked !== 'boolean') {
      return {
        warning: {
          kind: 'invalid_entry',
          layer,
          sourcePath,
          message: `hook entry #${index}: locked must be a boolean`,
        },
      };
    }
    if (rawLocked === true && layer !== 'enterprise') {
      lockWarning = {
        kind: 'lock_ignored',
        layer,
        sourcePath,
        message: `hook entry #${index}: locked=true ignored on ${layer} layer (only enterprise can lock)`,
      };
      locked = false;
    } else {
      locked = rawLocked;
    }
  }

  // Slice 181 — `if` per-handler filter. Optional string in
  // permission-rule syntax (`Bash(rm *)`, `Edit(*.ts)`). Parser
  // here only validates type/shape; semantic parse + match lives
  // in `dispatcher-matching.ts:ifFilterMatches`. Malformed
  // patterns there fail-OPEN at dispatch time — we don't pre-
  // validate the inside-parens glob because the dispatcher's
  // fail-open semantics already protect against typos.
  let ifRule: string | undefined;
  const rawIf = obj.if;
  if (rawIf !== undefined) {
    if (typeof rawIf !== 'string' || rawIf.length === 0) {
      return {
        warning: {
          kind: 'invalid_entry',
          layer,
          sourcePath,
          message: `hook entry #${index}: if must be a non-empty string when present`,
        },
      };
    }
    ifRule = rawIf;
  }

  const spec: HookSpec = {
    layer,
    sourcePath,
    event: event as HookEvent,
    matcher,
    command,
    timeoutMs,
    failClosed,
    locked,
    entryIndex: index,
    ...(ifRule !== undefined ? { if: ifRule } : {}),
  };
  // Both warnings are mutually exclusive in practice (timeout
  // vs lock), but if a future field grows a third warning we'd
  // need to widen this. Single warning per entry is the
  // contract today.
  const warning = timeoutWarning ?? lockWarning;
  if (warning !== undefined) return { spec, warning };
  return { spec };
};

// Load and validate one layer file. Returns the parsed entries
// + warnings; missing file returns empty entries (no warning —
// absence is the operator's "no hooks here" signal).
const loadLayer = (
  path: string | null,
  layer: HookLayer,
): {
  specs: HookSpec[];
  warnings: HookConfigWarning[];
  // Slice 181 — per-layer kill switch from top-level
  // `disable_all_hooks = true`. `resolveHookConfig` ORs across
  // layers so any layer can opt out locally; enterprise effectively
  // pins (lower layers can't un-set an OR).
  disableAllHooks: boolean;
} => {
  if (path === null) return { specs: [], warnings: [], disableAllHooks: false };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { specs: [], warnings: [], disableAllHooks: false };
    }
    return {
      specs: [],
      warnings: [
        {
          kind: 'unreadable_file',
          layer: null,
          sourcePath: path,
          message: `cannot read hooks config: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      disableAllHooks: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch (err) {
    return {
      specs: [],
      warnings: [
        {
          kind: 'unreadable_file',
          layer: null,
          sourcePath: path,
          message: `TOML parse failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      disableAllHooks: false,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      specs: [],
      warnings: [
        {
          kind: 'invalid_entry',
          layer,
          sourcePath: path,
          message: 'TOML root must be a table',
        },
      ],
      disableAllHooks: false,
    };
  }

  const root = parsed as Record<string, unknown>;
  const warnings: HookConfigWarning[] = [];

  // Slice 181 — top-level kill switch. Non-boolean value drops
  // the flag with a warning (operator wrote a typo or got the
  // type wrong — we don't want a string `"true"` to silently
  // count as falsy).
  let disableAllHooks = false;
  const rawDisable = root.disable_all_hooks;
  if (rawDisable !== undefined) {
    if (typeof rawDisable !== 'boolean') {
      warnings.push({
        kind: 'invalid_entry',
        layer,
        sourcePath: path,
        message: `disable_all_hooks must be a boolean (got ${JSON.stringify(rawDisable)})`,
      });
    } else {
      disableAllHooks = rawDisable;
    }
  }

  const hooksField = root.hooks;
  if (hooksField === undefined) {
    // Empty layer — operator wrote a hooks.toml with no
    // [[hooks]] yet. Treat as zero hooks, no warning. (A bare
    // file with only `disable_all_hooks = true` is also valid
    // and lands here.)
    return { specs: [], warnings, disableAllHooks };
  }
  if (!Array.isArray(hooksField)) {
    warnings.push({
      kind: 'invalid_entry',
      layer,
      sourcePath: path,
      message: '`hooks` field must be an array of tables (use [[hooks]])',
    });
    return { specs: [], warnings, disableAllHooks };
  }

  const specs: HookSpec[] = [];
  for (let i = 0; i < hooksField.length; i++) {
    const result = validateEntry(hooksField[i], layer, path, i);
    if ('spec' in result) {
      specs.push(result.spec);
      if (result.warning !== undefined) warnings.push(result.warning);
    } else {
      warnings.push(result.warning);
    }
  }
  return { specs, warnings, disableAllHooks };
};

// Resolve all three layers into one ordered hook list. Order:
// enterprise (in declaration order) → user → project. Caller
// (dispatcher) iterates the list per event and matches against
// `event` + `matcher`.
export const resolveHookConfig = (paths: HookConfigPaths): ResolvedHookConfig => {
  const warnings: HookConfigWarning[] = [];
  const enterprise = loadLayer(paths.enterprise, 'enterprise');
  warnings.push(...enterprise.warnings);
  const user = loadLayer(paths.user, 'user');
  warnings.push(...user.warnings);
  const project = loadLayer(paths.project, 'project');
  warnings.push(...project.warnings);

  // Slice 181 — OR the per-layer kill switches. Any layer can
  // opt into "no hooks at all"; once any one is true the chain
  // short-circuits at dispatch. Enterprise gets de-facto locking
  // for free (lower layers can only add more `true`, never
  // un-set). Lower layers can disable hooks locally for debug
  // when enterprise didn't pin — matches the "any layer can
  // disable" mental model.
  const disableAllHooks =
    enterprise.disableAllHooks || user.disableAllHooks || project.disableAllHooks;

  return {
    hooks: [...enterprise.specs, ...user.specs, ...project.specs],
    disableAllHooks,
    warnings,
  };
};
