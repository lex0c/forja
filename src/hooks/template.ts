// Template expansion for hook commands (spec AGENTIC_CLI.md §10.2
// example: `prettier --write {{tool.input.path}}`).
//
// Operator declares a shell command with `{{path.to.field}}`
// placeholders. At dispatch time, each placeholder is looked up
// in the event payload and substituted.
//
// SECURITY CONTRACT — shell injection defense:
//
// The expanded command is run via `sh -c "<expanded>"` (so
// pipelines, redirections, and env var interpolation work — what
// operators expect from "shell command"). Without quoting, a
// value containing shell metachars would be parsed twice and
// could execute arbitrary code. Example without quoting:
//
//   command:  audit.sh {{tool.input.command}}
//   payload:  tool.input.command = "ls; rm -rf /"
//   expanded: audit.sh ls; rm -rf /         (DOUBLE-EVAL)
//
// We default-quote every interpolated value with POSIX
// single-quote escaping so the value is a single shell argument
// regardless of content. The operator can opt out for a specific
// placeholder via `{{!path}}` (raw — no quoting) when they want
// to splice in pre-quoted shell-safe data; the `!` prefix is the
// explicit-danger marker.
//
// Missing-key policy: a template referring to a non-existent
// path resolves to the empty string (quoted as `''`). Spec
// doesn't mandate behavior here; we pick "empty" over "error"
// because hook commands often opt into optional fields
// (`audit.sh {{tool.input.path}} {{tool.input.linter_args}}`)
// where the second one may legitimately be absent.

const TEMPLATE_RE = /\{\{(!?)([^}]+)\}\}/g;

// POSIX single-quote escape: wrap in single quotes; replace any
// internal single quote with the four-char sequence `'\''`
// (close, escaped quote, open). The result is a single shell
// argument no matter what's inside.
const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// Look up a dotted key path against the payload. Walks the
// object tree; returns null if any segment is missing OR if the
// final value is not stringifiable as a primitive (we won't
// splice JSON-stringified objects into a shell command — that's
// almost always a bug).
//
// PROTOTYPE-POLLUTION DEFENSE: each segment must be an OWN
// property of its parent. Without this guard, an operator-
// authored template like `{{constructor.name}}` would resolve
// against `Object.prototype.constructor.name` and splice the
// literal `'Object'` into the shell command — operator gets a
// surprising hook execution despite the payload not carrying
// such a key. `Object.hasOwn` rejects all inherited props,
// including `__proto__`, `constructor`, `toString`, etc.
const resolveKey = (payload: unknown, path: string): string | null => {
  const parts = path.trim().split('.');
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return null;
    }
    if (!Object.hasOwn(current as object, part)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || current === undefined) return null;
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  // Object / array → bug-shape; treat as missing rather than
  // splice `[object Object]` into the command.
  return null;
};

export interface TemplateExpansionResult {
  expanded: string;
  // Keys referenced by the template. Useful for audit (which
  // fields did this hook consume?) and for tests asserting the
  // template parse.
  references: ReadonlyArray<{ key: string; raw: boolean; resolved: boolean }>;
}

// Expand `{{...}}` placeholders in `command` against `payload`.
// Returns the expanded command + a list of referenced keys with
// their resolution status. The expanded command is safe to pass
// to `sh -c "<expanded>"`.
export const expandTemplate = (command: string, payload: unknown): TemplateExpansionResult => {
  const references: { key: string; raw: boolean; resolved: boolean }[] = [];
  const expanded = command.replace(TEMPLATE_RE, (_match, bang: string, keyRaw: string) => {
    const key = keyRaw.trim();
    const raw = bang === '!';
    const value = resolveKey(payload, key);
    references.push({ key, raw, resolved: value !== null });
    if (value === null) {
      // Missing key: empty quoted argument so the placeholder's
      // position is preserved in the argv. Operator can detect
      // empty values inside the hook script.
      return raw ? '' : "''";
    }
    return raw ? value : shellQuote(value);
  });
  return { expanded, references };
};
