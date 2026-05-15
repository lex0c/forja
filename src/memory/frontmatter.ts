import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  MEMORY_STATES,
  type MemoryFile,
  type MemoryFrontmatter,
  type MemorySource,
  type MemoryState,
  type MemoryTrust,
  type MemoryType,
} from './types.ts';

// Frontmatter parser/writer for memory .md files.
//
// File shape (spec §3.1):
//
//   ---
//   <yaml block>
//   ---
//
//   <markdown body>
//
// We re-use the existing `yaml` dep (already in package.json for
// permissions config) instead of a hand-rolled parser. The
// frontmatter block is well-bounded by the two `---` fences, so
// we slice it out and hand the slice to `parseYaml`. The body is
// returned verbatim except for ONE leading blank line stripped:
// the canonical writer always emits exactly one blank between
// the closing fence and the body, so the parser undoes that on
// read. Operator-edited files with zero or two blank lines are
// also handled (we trim leading newlines but never trailing).

export class FrontmatterError extends Error {
  override readonly name = 'FrontmatterError';
}

const VALID_TYPES = new Set<MemoryType>(['user', 'feedback', 'project', 'reference']);
const VALID_SOURCES = new Set<MemorySource>(['user_explicit', 'inferred', 'imported']);
const VALID_TRUSTS = new Set<MemoryTrust>(['trusted', 'untrusted']);
const VALID_STATES = new Set<MemoryState>(MEMORY_STATES);

// Memory `name` is the canonical id within a scope. Kebab-case
// per spec line 220 ("kebab-case, único no scope"). We allow
// `[a-z0-9_-]` with a leading alphanumeric so filenames are
// portable across filesystems and the index can quote them
// without escaping. Length cap of 120 prevents pathological
// names from blowing past filesystem path limits when the user
// scope path is already long.
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 120;

// Description is the one-line hook shown in the index. We cap at
// 200 chars to align with the "150 char per index line" guidance
// in spec §3.2 once the leading bullet/title/parens are added.
const DESC_MAX = 200;

// ISO date YYYY-MM-DD. We don't validate semantic date validity
// (e.g. month=13) at the storage layer — the lifecycle slice
// (5.6) parses the date with `new Date()` and treats Invalid Date
// as "expires unknown, leave alone". Storage rejects only the
// shape mismatch so frontmatter drift surfaces immediately.
const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;

const TRIGGER_RE = /^[a-z0-9][a-z0-9_-]*$/;
const TRIGGER_MAX = 64;

// `parseYaml` returns `unknown`; we narrow defensively. Any field
// of unexpected type is a hard error rather than a silent coerce
// — frontmatter mistakes should fail loudly so the operator sees
// them. The error message names the offending field.
const requireString = (raw: Record<string, unknown>, field: string): string => {
  const v = raw[field];
  if (typeof v !== 'string') {
    throw new FrontmatterError(`frontmatter.${field}: expected string, got ${typeof v}`);
  }
  return v;
};

const optionalString = (raw: Record<string, unknown>, field: string): string | undefined => {
  if (!(field in raw)) return undefined;
  const v = raw[field];
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new FrontmatterError(`frontmatter.${field}: expected string, got ${typeof v}`);
  }
  return v;
};

const optionalStringArray = (raw: Record<string, unknown>, field: string): string[] | undefined => {
  if (!(field in raw)) return undefined;
  const v = raw[field];
  if (v === null || v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new FrontmatterError(`frontmatter.${field}: expected array of strings`);
  }
  for (const item of v) {
    if (typeof item !== 'string') {
      throw new FrontmatterError(`frontmatter.${field}: array entries must be strings`);
    }
  }
  return v as string[];
};

export const validateName = (name: string): void => {
  if (name.length === 0) {
    throw new FrontmatterError('frontmatter.name: must be non-empty');
  }
  if (name.length > NAME_MAX) {
    throw new FrontmatterError(`frontmatter.name: exceeds ${NAME_MAX} chars`);
  }
  if (!NAME_RE.test(name)) {
    throw new FrontmatterError(
      `frontmatter.name: must be kebab-case [a-z0-9][a-z0-9_-]* (got ${JSON.stringify(name)})`,
    );
  }
};

const validateDescription = (description: string): void => {
  if (description.length === 0) {
    throw new FrontmatterError('frontmatter.description: must be non-empty');
  }
  if (description.length > DESC_MAX) {
    throw new FrontmatterError(`frontmatter.description: exceeds ${DESC_MAX} chars`);
  }
  if (description.includes('\n')) {
    throw new FrontmatterError('frontmatter.description: must be a single line');
  }
};

const validateType = (type: string): MemoryType => {
  if (!VALID_TYPES.has(type as MemoryType)) {
    throw new FrontmatterError(
      `frontmatter.type: must be one of ${[...VALID_TYPES].join(', ')} (got ${JSON.stringify(type)})`,
    );
  }
  return type as MemoryType;
};

const validateSource = (source: string): MemorySource => {
  if (!VALID_SOURCES.has(source as MemorySource)) {
    throw new FrontmatterError(
      `frontmatter.source: must be one of ${[...VALID_SOURCES].join(', ')} (got ${JSON.stringify(source)})`,
    );
  }
  return source as MemorySource;
};

const validateTrust = (trust: string): MemoryTrust => {
  if (!VALID_TRUSTS.has(trust as MemoryTrust)) {
    throw new FrontmatterError(
      `frontmatter.trust: must be one of ${[...VALID_TRUSTS].join(', ')} (got ${JSON.stringify(trust)})`,
    );
  }
  return trust as MemoryTrust;
};

const validateState = (state: string): MemoryState => {
  if (!VALID_STATES.has(state as MemoryState)) {
    throw new FrontmatterError(
      `frontmatter.state: must be one of ${[...VALID_STATES].join(', ')} (got ${JSON.stringify(state)})`,
    );
  }
  return state as MemoryState;
};

const validateExpires = (expires: string): void => {
  if (!EXPIRES_RE.test(expires)) {
    throw new FrontmatterError(
      `frontmatter.expires: must match YYYY-MM-DD (got ${JSON.stringify(expires)})`,
    );
  }
};

const validateTriggers = (triggers: string[]): void => {
  for (const t of triggers) {
    if (t.length === 0 || t.length > TRIGGER_MAX || !TRIGGER_RE.test(t)) {
      throw new FrontmatterError(
        `frontmatter.triggers: each entry must be kebab-case <=${TRIGGER_MAX} chars (got ${JSON.stringify(t)})`,
      );
    }
  }
};

// Validate a parsed YAML object and project it onto the strict
// MemoryFrontmatter shape. Throws FrontmatterError on any
// mismatch.
export const validateFrontmatter = (raw: unknown): MemoryFrontmatter => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrontmatterError('frontmatter: must be a YAML mapping');
  }
  const obj = raw as Record<string, unknown>;

  const name = requireString(obj, 'name');
  validateName(name);

  const description = requireString(obj, 'description');
  validateDescription(description);

  const type = validateType(requireString(obj, 'type'));
  const source = validateSource(requireString(obj, 'source'));

  const fm: MemoryFrontmatter = { name, description, type, source };

  const expires = optionalString(obj, 'expires');
  if (expires !== undefined) {
    validateExpires(expires);
    fm.expires = expires;
  }

  const trust = optionalString(obj, 'trust');
  if (trust !== undefined) {
    fm.trust = validateTrust(trust);
  }

  const triggers = optionalStringArray(obj, 'triggers');
  if (triggers !== undefined) {
    validateTriggers(triggers);
    fm.triggers = triggers;
  }

  const state = optionalString(obj, 'state');
  if (state !== undefined) {
    fm.state = validateState(state);
  }

  // Reject unknown fields. Future-proofing: a future spec
  // revision might add `tags`, `priority`, etc. — the operator
  // running an older binary against newer files should see a
  // loud error instead of silent data loss on round-trip.
  const known = new Set([
    'name',
    'description',
    'type',
    'source',
    'expires',
    'trust',
    'triggers',
    'state',
  ]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      throw new FrontmatterError(`frontmatter: unknown field ${JSON.stringify(key)}`);
    }
  }

  return fm;
};

// Parse a memory .md file from its raw text. The fence detection
// is strict: the file MUST start with `---\n` (or `---\r\n`) on
// the first byte; a missing opening fence is a hard error
// because we only ever write canonical files and a missing fence
// in input means either a) the file isn't a memory file at all
// or b) it was corrupted. Either way silent acceptance hides the
// problem.
export const parseMemoryFile = (raw: string): MemoryFile => {
  // Normalize CRLF to LF before splitting. Operators on Windows
  // editing memories would otherwise round-trip differently.
  const text = raw.replace(/\r\n/g, '\n');

  if (!text.startsWith('---\n')) {
    throw new FrontmatterError('memory file must start with `---` frontmatter fence');
  }
  // Find the closing fence: a line that is exactly `---` after
  // the opening one. We search from index 4 (past the opening
  // fence + newline). The closing match needs to be at start of
  // line, which means preceded by `\n` or be the start.
  const closeIdx = text.indexOf('\n---', 3);
  if (closeIdx === -1) {
    throw new FrontmatterError('memory file missing closing `---` frontmatter fence');
  }
  // The closing fence must be on its own line: preceded by `\n`
  // and followed by `\n` or end-of-file.
  const afterClose = closeIdx + 4; // skip "\n---"
  if (afterClose !== text.length && text[afterClose] !== '\n') {
    throw new FrontmatterError('memory file closing `---` must be on its own line');
  }

  const yamlBlock = text.slice(4, closeIdx);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FrontmatterError(`frontmatter: YAML parse failed: ${msg}`);
  }
  const frontmatter = validateFrontmatter(parsed);

  // Body: everything after the closing fence's trailing newline.
  // Strip ONE leading newline (the canonical writer emits a
  // single blank between fence and body).
  let body = afterClose < text.length ? text.slice(afterClose + 1) : '';
  if (body.startsWith('\n')) body = body.slice(1);
  return { frontmatter, body };
};

// Serialize a MemoryFile back to canonical text. The output is
// stable across round-trips: fields are emitted in spec order
// (name, description, type, source, expires, trust, triggers)
// regardless of insertion order, optional absent fields stay
// absent (not coerced to defaults), and the body is preceded by
// exactly one blank line.
export const serializeMemoryFile = (file: MemoryFile): string => {
  // Validate before writing so callers can't smuggle drift past
  // the parser (e.g. constructing a MemoryFrontmatter object by
  // hand with an invalid name).
  validateFrontmatter(file.frontmatter);

  const ordered: Record<string, unknown> = {
    name: file.frontmatter.name,
    description: file.frontmatter.description,
    type: file.frontmatter.type,
    source: file.frontmatter.source,
  };
  if (file.frontmatter.expires !== undefined) ordered.expires = file.frontmatter.expires;
  if (file.frontmatter.trust !== undefined) ordered.trust = file.frontmatter.trust;
  if (file.frontmatter.triggers !== undefined) ordered.triggers = file.frontmatter.triggers;
  if (file.frontmatter.state !== undefined) ordered.state = file.frontmatter.state;

  // `stringifyYaml` emits a trailing newline already. We force
  // single-line strings (lineWidth: 0 effectively disables
  // wrapping) so the description never gets folded onto multiple
  // lines and breaks the frontmatter shape.
  const yamlBody = stringifyYaml(ordered, { lineWidth: 0 });

  const body = file.body.length === 0 ? '' : `\n${file.body}`;
  return `---\n${yamlBody}---${body}`;
};
