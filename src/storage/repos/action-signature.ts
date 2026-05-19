// action_signature parser/serializer (FEEDBACK_ADAPTATION §4).
//
// `action_signature` is the unit being adapted by the loop frio.
// Stored as opaque TEXT in `outcomes` / `policies` for queryability;
// emitters and consumers parse it through this module so the
// naming convention stays load-bearing — sem ela aggregation cruza
// signatures não relacionadas.
//
// Four levels per §4.2:
//
//   L1  alias:<from>:<to>                ex: alias:grep:ripgrep
//   L2  flag:<tool>:<flag>:<value>       ex: flag:bash:cwd_arg:preferred
//   L3  recipe:<id>                      ex: recipe:sql_migration_dry_run
//   L4  strategy:<id>:<scope>            ex: strategy:refactor_batching:js
//
// Adaptation defaults to L1-L2 only (§4.1). L3 requires high N +
// human validation. L4 requires opt-in — classifier errors
// contaminate the signal. The repo doesn't enforce these gates;
// it's an emitter-side discipline. We just parse and serialize.

// Level discriminator. Useful for query consumers that want to
// filter by adaptation risk class (the loop frio aggregator runs
// only on L1+L2 by default).
export type ActionSignatureLevel = 'L1' | 'L2' | 'L3' | 'L4';

// Parsed shape, discriminated by `level`. Each variant carries the
// fields that level admits — emitters construct one of these and
// serialize via `serializeActionSignature`.
export type ParsedActionSignature =
  | { level: 'L1'; from: string; to: string }
  | { level: 'L2'; tool: string; flag: string; value: string }
  | { level: 'L3'; recipeId: string }
  | { level: 'L4'; strategyId: string; scope: string };

// Lowercase + digits + hyphen + underscore. Same vocabulary as
// memory names — keeps `action_signature` hashable and JOIN-safe
// without per-emitter quirks. Colons are reserved as the level/
// field separator; the field-content alphabet excludes them.
const FIELD_RE = /^[a-z0-9][a-z0-9_-]*$/;

const isField = (s: string): boolean => FIELD_RE.test(s);

// Serialize a parsed shape into the canonical TEXT form. Throws
// `InvalidActionSignatureError` when any field contains characters
// outside the allowed alphabet — the storage layer's opaque-string
// contract relies on this invariant.
export const serializeActionSignature = (parsed: ParsedActionSignature): string => {
  switch (parsed.level) {
    case 'L1': {
      if (!isField(parsed.from) || !isField(parsed.to)) {
        throw new InvalidActionSignatureError(
          'L1 alias requires lowercase from/to (alphanumeric + _-)',
        );
      }
      return `alias:${parsed.from}:${parsed.to}`;
    }
    case 'L2': {
      if (!isField(parsed.tool) || !isField(parsed.flag) || !isField(parsed.value)) {
        throw new InvalidActionSignatureError(
          'L2 flag requires lowercase tool/flag/value (alphanumeric + _-)',
        );
      }
      return `flag:${parsed.tool}:${parsed.flag}:${parsed.value}`;
    }
    case 'L3': {
      if (!isField(parsed.recipeId)) {
        throw new InvalidActionSignatureError(
          'L3 recipe requires lowercase id (alphanumeric + _-)',
        );
      }
      return `recipe:${parsed.recipeId}`;
    }
    case 'L4': {
      if (!isField(parsed.strategyId) || !isField(parsed.scope)) {
        throw new InvalidActionSignatureError(
          'L4 strategy requires lowercase strategyId/scope (alphanumeric + _-)',
        );
      }
      return `strategy:${parsed.strategyId}:${parsed.scope}`;
    }
  }
};

// Parse a canonical action_signature string. Returns null when the
// shape doesn't match any level — consumers treat null as "opaque /
// foreign signature; skip" rather than throwing, since the storage
// layer accepts any string and a future emitter could write
// signatures from another vocabulary.
export const parseActionSignature = (s: string): ParsedActionSignature | null => {
  const parts = s.split(':');
  if (parts.length < 2) return null;
  const head = parts[0] as string;
  switch (head) {
    case 'alias': {
      if (parts.length !== 3) return null;
      const from = parts[1] as string;
      const to = parts[2] as string;
      if (!isField(from) || !isField(to)) return null;
      return { level: 'L1', from, to };
    }
    case 'flag': {
      if (parts.length !== 4) return null;
      const tool = parts[1] as string;
      const flag = parts[2] as string;
      const value = parts[3] as string;
      if (!isField(tool) || !isField(flag) || !isField(value)) return null;
      return { level: 'L2', tool, flag, value };
    }
    case 'recipe': {
      if (parts.length !== 2) return null;
      const recipeId = parts[1] as string;
      if (!isField(recipeId)) return null;
      return { level: 'L3', recipeId };
    }
    case 'strategy': {
      if (parts.length !== 3) return null;
      const strategyId = parts[1] as string;
      const scope = parts[2] as string;
      if (!isField(strategyId) || !isField(scope)) return null;
      return { level: 'L4', strategyId, scope };
    }
    default:
      return null;
  }
};

// Convenience: extract just the level without allocating the full
// parsed shape. Returns null when the prefix doesn't match a known
// level. Used by query layers that want to filter by L1/L2 without
// paying parse cost for the entire signature.
export const levelOf = (s: string): ActionSignatureLevel | null => {
  if (s.startsWith('alias:')) return 'L1';
  if (s.startsWith('flag:')) return 'L2';
  if (s.startsWith('recipe:')) return 'L3';
  if (s.startsWith('strategy:')) return 'L4';
  return null;
};

export class InvalidActionSignatureError extends Error {
  constructor(reason: string) {
    super(`action_signature: ${reason}`);
    this.name = 'InvalidActionSignatureError';
  }
}
