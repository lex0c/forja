// ChangelogRenderV1 — structured shape for the `changelog`
// renderer (RECAP.md §4.3). User-facing changelog entry
// following Keep a Changelog conventions
// (https://keepachangelog.com/): every entry is bucketed by
// category and surfaced as a one-line bullet without technical
// detail. This is the renderer that ends up in CHANGELOG.md or
// release notes — so it stays terse and impact-oriented.
//
// Schema vs prose: like `pr`, the LLM emits the structured shape
// (entries grouped by category) and a deterministic template
// produces the markdown. The model never sees the
// "### Added"/"### Fixed" header itself — it just labels each
// entry with its category.

export const CHANGELOG_SCHEMA_VERSION = 'changelog-v1' as const;

export type ChangelogSchemaVersion = typeof CHANGELOG_SCHEMA_VERSION;

// Keep a Changelog vocabulary, verbatim. The set is closed —
// adding a category would require a schema bump.
export type ChangelogCategory =
  | 'Added'
  | 'Changed'
  | 'Fixed'
  | 'Removed'
  | 'Deprecated'
  | 'Security';

export const CHANGELOG_CATEGORIES: readonly ChangelogCategory[] = [
  'Added',
  'Changed',
  'Fixed',
  'Removed',
  'Deprecated',
  'Security',
];

export interface ChangelogEntry {
  category: ChangelogCategory;
  // Single-line bullet, ≤ 160 chars. Keep a Changelog convention
  // is "user-impacting, short, no commit-id / file-path noise".
  bullet: string;
}

export interface ChangelogRenderV1 {
  schemaVersion: ChangelogSchemaVersion;
  // 1–8 entries total across all categories. A read-only or
  // failed session may produce zero user-impacting changes; the
  // deterministic projection emits a single sentinel entry in
  // that case rather than an empty changelog (which would be a
  // silently misleading "nothing changed" claim).
  entries: ChangelogEntry[];
}

export const CHANGELOG_LIMITS = {
  entriesMaxItems: 8,
  bulletMaxChars: 160,
} as const;

export const CHANGELOG_RENDER_V1_JSON_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'entries'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [CHANGELOG_SCHEMA_VERSION] },
    entries: {
      type: 'array',
      minItems: 1,
      maxItems: CHANGELOG_LIMITS.entriesMaxItems,
      items: {
        type: 'object',
        required: ['category', 'bullet'],
        additionalProperties: false,
        properties: {
          category: { type: 'string', enum: CHANGELOG_CATEGORIES },
          bullet: { type: 'string', minLength: 1, maxLength: CHANGELOG_LIMITS.bulletMaxChars },
        },
      },
    },
  },
} as const;

export interface ChangelogValidationResult {
  ok: boolean;
  errors: string[];
}

const isCategory = (v: unknown): v is ChangelogCategory =>
  typeof v === 'string' && (CHANGELOG_CATEGORIES as readonly string[]).includes(v);

export const validateChangelogRenderV1 = (value: unknown): ChangelogValidationResult => {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['root must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'entries']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`unexpected property '${k}'`);
  }
  if (obj.schemaVersion !== CHANGELOG_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${CHANGELOG_SCHEMA_VERSION}'`);
  }
  if (!Array.isArray(obj.entries)) {
    errors.push('entries must be array');
  } else {
    if (obj.entries.length === 0 || obj.entries.length > CHANGELOG_LIMITS.entriesMaxItems) {
      errors.push(`entries must have 1..${CHANGELOG_LIMITS.entriesMaxItems} items`);
    }
    obj.entries.forEach((e, i) => {
      if (typeof e !== 'object' || e === null) {
        errors.push(`entries[${i}] must be object`);
        return;
      }
      const entry = e as Record<string, unknown>;
      const allowedKeys = new Set(['category', 'bullet']);
      for (const k of Object.keys(entry)) {
        if (!allowedKeys.has(k)) errors.push(`entries[${i}] unexpected property '${k}'`);
      }
      if (!isCategory(entry.category)) {
        errors.push(`entries[${i}].category must be one of ${CHANGELOG_CATEGORIES.join('|')}`);
      }
      if (
        typeof entry.bullet !== 'string' ||
        entry.bullet.length === 0 ||
        entry.bullet.length > CHANGELOG_LIMITS.bulletMaxChars
      ) {
        errors.push(
          `entries[${i}].bullet must be string 1..${CHANGELOG_LIMITS.bulletMaxChars} chars`,
        );
      }
    });
  }
  return { ok: errors.length === 0, errors };
};
