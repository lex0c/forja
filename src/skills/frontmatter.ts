import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { SkillFile, SkillFrontmatter, SkillSource } from './types.ts';

// Frontmatter parser/writer for skill .md files (spec SKILLS.md §2).
//
// File shape (§2.1–2.2):
//
//   ---
//   <yaml block>
//   ---
//
//   <markdown body — the procedure the LLM follows>
//
// The `yaml` dep is already in package.json (permissions config +
// the memory subsystem). The frontmatter block is bounded by the
// two `---` fences, so we slice it out and hand the slice to
// `parseYaml`. The body is returned verbatim except for ONE leading
// blank line stripped: the canonical writer always emits exactly
// one blank between the closing fence and the body, so the parser
// undoes it. Files hand-edited with zero or two blanks still parse
// (we trim leading newlines, never trailing).

export class SkillFrontmatterError extends Error {
  override readonly name = 'SkillFrontmatterError';
}

const VALID_SOURCES = new Set<SkillSource>(['user', 'project_shared', 'project_local', 'imported']);

// `name` is the canonical id within a scope (§2.1: "kebab-case,
// único por scope"). A leading alphanumeric + `[a-z0-9_-]` keeps
// the `<name>.md` filename portable across filesystems and quote-
// free in any catalog render. The 120-char cap mirrors the memory
// subsystem — long names blow past path limits once the user scope
// root is already deep.
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const NAME_MAX = 120;

// Description is the load-bearing gate input — the model decides
// invocation from it (§0.2, RETRIEVAL §3.4.1). The spec pins "1
// linha ≤120 chars"; we enforce both. A longer or multi-line
// description neighbors the §11 "description vaga" anti-pattern and
// breaks the eager catalog's one-line-per-skill render.
const DESC_MAX = 120;

// ISO `YYYY-MM-DD` shape for `expires` / `created_at` / `updated_at`.
// Shape only — calendar validity (month ≤ 12, day ≤ 31) is a
// lifecycle-layer concern; storage rejects the shape mismatch so
// hand-edit drift surfaces loudly instead of silently.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Bound on a single `trigger_keywords` / `tools` / `requires`
// entry. trigger_keywords are free-form lowercase phrases (the seed
// catalog uses multi-word entries like "test fails sometimes") —
// NO kebab-case constraint, unlike `name`. The cap just stops a
// pathological entry from bloating the per-skill frontmatter peek.
const LIST_ENTRY_MAX = 64;

// `parseYaml` returns `unknown`; we narrow defensively. A field of
// an unexpected type is a hard error, never a silent coerce —
// frontmatter mistakes must fail loudly. The message names the
// offending field.
const requireString = (raw: Record<string, unknown>, field: string): string => {
  const v = raw[field];
  if (typeof v !== 'string') {
    throw new SkillFrontmatterError(`frontmatter.${field}: expected string, got ${typeof v}`);
  }
  return v;
};

const optionalString = (raw: Record<string, unknown>, field: string): string | undefined => {
  if (!(field in raw)) return undefined;
  const v = raw[field];
  // `expires: null` (the seed catalog's idiom for "no deadline")
  // collapses to absent — the serializer then omits the field.
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new SkillFrontmatterError(`frontmatter.${field}: expected string, got ${typeof v}`);
  }
  return v;
};

const optionalNumber = (raw: Record<string, unknown>, field: string): number | undefined => {
  if (!(field in raw)) return undefined;
  const v = raw[field];
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'number') {
    throw new SkillFrontmatterError(`frontmatter.${field}: expected number, got ${typeof v}`);
  }
  return v;
};

const optionalStringArray = (raw: Record<string, unknown>, field: string): string[] | undefined => {
  if (!(field in raw)) return undefined;
  const v = raw[field];
  if (v === null || v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new SkillFrontmatterError(`frontmatter.${field}: expected array of strings`);
  }
  for (const item of v) {
    if (typeof item !== 'string') {
      throw new SkillFrontmatterError(`frontmatter.${field}: array entries must be strings`);
    }
  }
  return v as string[];
};

export const validateName = (name: string): void => {
  if (name.length === 0) {
    throw new SkillFrontmatterError('frontmatter.name: must be non-empty');
  }
  if (name.length > NAME_MAX) {
    throw new SkillFrontmatterError(`frontmatter.name: exceeds ${NAME_MAX} chars`);
  }
  if (!NAME_RE.test(name)) {
    throw new SkillFrontmatterError(
      `frontmatter.name: must be kebab-case [a-z0-9][a-z0-9_-]* (got ${JSON.stringify(name)})`,
    );
  }
};

const validateDescription = (description: string): void => {
  if (description.length === 0) {
    throw new SkillFrontmatterError('frontmatter.description: must be non-empty');
  }
  if (description.length > DESC_MAX) {
    throw new SkillFrontmatterError(
      `frontmatter.description: exceeds ${DESC_MAX} chars (got ${description.length})`,
    );
  }
  if (description.includes('\n')) {
    throw new SkillFrontmatterError('frontmatter.description: must be a single line');
  }
};

const validateVersion = (version: number): void => {
  if (!Number.isInteger(version) || version < 1) {
    throw new SkillFrontmatterError(
      `frontmatter.version: must be an integer >= 1 (got ${version})`,
    );
  }
};

const validateDate = (field: string, value: string): void => {
  if (!DATE_RE.test(value)) {
    throw new SkillFrontmatterError(
      `frontmatter.${field}: must match YYYY-MM-DD (got ${JSON.stringify(value)})`,
    );
  }
};

const validateStringList = (field: string, entries: readonly string[]): void => {
  for (const e of entries) {
    if (e.length === 0 || e.length > LIST_ENTRY_MAX || e.includes('\n')) {
      throw new SkillFrontmatterError(
        `frontmatter.${field}: each entry must be a non-empty single line <=${LIST_ENTRY_MAX} chars (got ${JSON.stringify(e)})`,
      );
    }
  }
};

const validateSource = (source: string): SkillSource => {
  if (!VALID_SOURCES.has(source as SkillSource)) {
    throw new SkillFrontmatterError(
      `frontmatter.source: must be one of ${[...VALID_SOURCES].join(', ')} (got ${JSON.stringify(source)})`,
    );
  }
  return source as SkillSource;
};

// Canonical frontmatter field order (spec §2.1). Single source of
// truth: the serializer emits in this order, and the parser's
// unknown-field gate (`KNOWN_FIELDS`) derives from it — a v2 field
// is added in ONE place, not three. `satisfies (keyof
// SkillFrontmatter)[]` makes a tuple entry that is not an actual
// field a compile error, so the tuple cannot silently drift from
// the interface.
const SKILL_FIELD_ORDER = [
  'name',
  'description',
  'version',
  'trigger_keywords',
  'tools',
  'requires',
  'source',
  'created_at',
  'updated_at',
  'expires',
] as const satisfies readonly (keyof SkillFrontmatter)[];

// Reject unknown fields. Future-proofing: a future spec revision
// might add a field, and an operator running an older binary
// against a newer file should see a loud error instead of silent
// data loss on round-trip.
const KNOWN_FIELDS: ReadonlySet<string> = new Set(SKILL_FIELD_ORDER);

// Validate a parsed YAML object and project it onto the strict
// `SkillFrontmatter` shape. Throws `SkillFrontmatterError` on any
// mismatch.
export const validateFrontmatter = (raw: unknown): SkillFrontmatter => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillFrontmatterError('frontmatter: must be a YAML mapping');
  }
  const obj = raw as Record<string, unknown>;

  const name = requireString(obj, 'name');
  validateName(name);

  const description = requireString(obj, 'description');
  validateDescription(description);

  const fm: SkillFrontmatter = { name, description };

  const version = optionalNumber(obj, 'version');
  if (version !== undefined) {
    validateVersion(version);
    fm.version = version;
  }

  const triggerKeywords = optionalStringArray(obj, 'trigger_keywords');
  if (triggerKeywords !== undefined) {
    validateStringList('trigger_keywords', triggerKeywords);
    fm.trigger_keywords = triggerKeywords;
  }

  const tools = optionalStringArray(obj, 'tools');
  if (tools !== undefined) {
    validateStringList('tools', tools);
    fm.tools = tools;
  }

  const requires = optionalStringArray(obj, 'requires');
  if (requires !== undefined) {
    validateStringList('requires', requires);
    fm.requires = requires;
  }

  const source = optionalString(obj, 'source');
  if (source !== undefined) {
    fm.source = validateSource(source);
  }

  const createdAt = optionalString(obj, 'created_at');
  if (createdAt !== undefined) {
    validateDate('created_at', createdAt);
    fm.created_at = createdAt;
  }

  const updatedAt = optionalString(obj, 'updated_at');
  if (updatedAt !== undefined) {
    validateDate('updated_at', updatedAt);
    fm.updated_at = updatedAt;
  }

  const expires = optionalString(obj, 'expires');
  if (expires !== undefined) {
    validateDate('expires', expires);
    fm.expires = expires;
  }

  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new SkillFrontmatterError(`frontmatter: unknown field ${JSON.stringify(key)}`);
    }
  }

  return fm;
};

// Parse a skill .md file from raw text. Fence detection is strict:
// the file MUST start with `---\n` on the first byte. A missing
// opening fence is a hard error — the file is either not a skill
// file or it was corrupted, and silent acceptance hides the problem.
export const parseSkillFile = (raw: string): SkillFile => {
  // Normalize CRLF to LF before splitting so a Windows-edited skill
  // round-trips identically.
  const text = raw.replace(/\r\n/g, '\n');

  if (!text.startsWith('---\n')) {
    throw new SkillFrontmatterError('skill file must start with `---` frontmatter fence');
  }
  // Closing fence: the next `\n---` after the opening one.
  const closeIdx = text.indexOf('\n---', 3);
  if (closeIdx === -1) {
    throw new SkillFrontmatterError('skill file missing closing `---` frontmatter fence');
  }
  // The closing fence must sit on its own line — followed by `\n`
  // or end-of-file.
  const afterClose = closeIdx + 4; // skip "\n---"
  if (afterClose !== text.length && text[afterClose] !== '\n') {
    throw new SkillFrontmatterError('skill file closing `---` must be on its own line');
  }

  const yamlBlock = text.slice(4, closeIdx);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SkillFrontmatterError(`frontmatter: YAML parse failed: ${msg}`);
  }
  const frontmatter = validateFrontmatter(parsed);

  // Body: everything after the closing fence's trailing newline.
  // Strip ONE leading newline (the canonical writer emits a single
  // blank between fence and body).
  let body = afterClose < text.length ? text.slice(afterClose + 1) : '';
  if (body.startsWith('\n')) body = body.slice(1);
  return { frontmatter, body };
};

// Serialize a `SkillFile` back to canonical text. Output is stable
// across round-trips: fields emit in spec order (§2.1) regardless
// of insertion order, absent optionals stay absent (not coerced to
// defaults), and the body is preceded by exactly one blank line.
export const serializeSkillFile = (file: SkillFile): string => {
  // Validate before writing so a caller can't smuggle drift past
  // the parser (e.g. a hand-built frontmatter object with an
  // invalid name).
  validateFrontmatter(file.frontmatter);

  // Emit in canonical order, skipping absent optionals. `name` and
  // `description` are always defined, so they always lead.
  const fm = file.frontmatter;
  const ordered: Record<string, unknown> = {};
  for (const field of SKILL_FIELD_ORDER) {
    const value = fm[field];
    if (value !== undefined) ordered[field] = value;
  }

  // `lineWidth: 0` disables wrapping so a long description never
  // gets folded onto multiple lines and breaks the frontmatter
  // shape. `stringifyYaml` already emits a trailing newline.
  const yamlBody = stringifyYaml(ordered, { lineWidth: 0 });

  const body = file.body.length === 0 ? '' : `\n${file.body}`;
  return `---\n${yamlBody}---${body}`;
};
