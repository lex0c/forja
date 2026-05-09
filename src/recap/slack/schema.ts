// SlackRenderV1 — structured shape for the `slack` renderer
// (RECAP.md §4.4). Slack-compatible markdown post — short, with
// a clearly-labeled title, achievement bullets, the file list
// the change touched, and the explicit decisions worth flagging
// to the team.
//
// Spec divergence: §4.4's example uses `✓` and `•` characters in
// the template. This implementation uses ASCII-only (`*` and `-`)
// because (a) the renderer's anti-emoji rule from §7.3 should
// apply uniformly to model and template output for consistency,
// and (b) Slack renders the ASCII forms cleanly. The spec patch
// in this slice updates §4.4 to match.

export const SLACK_SCHEMA_VERSION = 'slack-v1' as const;

export type SlackSchemaVersion = typeof SLACK_SCHEMA_VERSION;

export interface SlackRenderV1 {
  schemaVersion: SlackSchemaVersion;
  // One-line title summarizing the change (~60 chars). Surfaces
  // as the bold first line.
  title: string;
  // Wall-clock duration label (e.g. "4m32s"). Deterministic
  // path uses formatDuration; LLM path stays inside the schema
  // cap and lets the operator's locale shape the string.
  durationLabel: string;
  // USD cost label (e.g. "$0.04"). Deterministic path uses
  // formatUsd.
  costLabel: string;
  // 1–5 short achievement bullets. Each ≤ 100 chars.
  achievements: string[];
  // 0–8 file paths touched in this scope. The template lists
  // them as `path/to/file` literal; the operator can paste
  // directly into Slack.
  files: string[];
  // 0–4 decisions worth flagging. Each ≤ 140 chars.
  decisions: string[];
}

export const SLACK_LIMITS = {
  titleMaxChars: 80,
  durationLabelMaxChars: 12,
  costLabelMaxChars: 12,
  achievementsMaxItems: 5,
  achievementsMaxChars: 100,
  filesMaxItems: 8,
  filesMaxChars: 200,
  decisionsMaxItems: 4,
  decisionsMaxChars: 140,
} as const;

export const SLACK_RENDER_V1_JSON_SCHEMA = {
  type: 'object',
  required: [
    'schemaVersion',
    'title',
    'durationLabel',
    'costLabel',
    'achievements',
    'files',
    'decisions',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [SLACK_SCHEMA_VERSION] },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: SLACK_LIMITS.titleMaxChars,
      // Reject `*` so the bold-wrapped template (`*<title>*`)
      // cannot produce a dangling asterisk in Slack output.
      pattern: '^[^*]*$',
    },
    durationLabel: {
      type: 'string',
      minLength: 1,
      maxLength: SLACK_LIMITS.durationLabelMaxChars,
    },
    costLabel: { type: 'string', minLength: 1, maxLength: SLACK_LIMITS.costLabelMaxChars },
    achievements: {
      type: 'array',
      minItems: 1,
      maxItems: SLACK_LIMITS.achievementsMaxItems,
      items: { type: 'string', minLength: 1, maxLength: SLACK_LIMITS.achievementsMaxChars },
    },
    files: {
      type: 'array',
      maxItems: SLACK_LIMITS.filesMaxItems,
      items: { type: 'string', minLength: 1, maxLength: SLACK_LIMITS.filesMaxChars },
    },
    decisions: {
      type: 'array',
      maxItems: SLACK_LIMITS.decisionsMaxItems,
      items: { type: 'string', minLength: 1, maxLength: SLACK_LIMITS.decisionsMaxChars },
    },
  },
} as const;

export interface SlackValidationResult {
  ok: boolean;
  errors: string[];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

const checkStringField = (
  errors: string[],
  obj: Record<string, unknown>,
  key: string,
  maxChars: number,
): void => {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    errors.push(`${key} must be non-empty string`);
    return;
  }
  if (v.length > maxChars) errors.push(`${key} exceeds ${maxChars} chars`);
};

const checkBoundedArray = (
  errors: string[],
  obj: Record<string, unknown>,
  key: string,
  minItems: number,
  maxItems: number,
  maxItemChars: number,
): void => {
  const v = obj[key];
  if (!isStringArray(v)) {
    errors.push(`${key} must be string[]`);
    return;
  }
  if (v.length < minItems || v.length > maxItems) {
    errors.push(`${key} must have ${minItems}..${maxItems} items`);
  }
  v.forEach((s, i) => {
    if (s.length === 0 || s.length > maxItemChars) {
      errors.push(`${key}[${i}] must be 1..${maxItemChars} chars`);
    }
  });
};

export const validateSlackRenderV1 = (value: unknown): SlackValidationResult => {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['root must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'title',
    'durationLabel',
    'costLabel',
    'achievements',
    'files',
    'decisions',
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`unexpected property '${k}'`);
  }
  if (obj.schemaVersion !== SLACK_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${SLACK_SCHEMA_VERSION}'`);
  }
  checkStringField(errors, obj, 'title', SLACK_LIMITS.titleMaxChars);
  // The title is wrapped in `*<title>*` by the template (Slack
  // bold). A literal `*` inside `title` would close the bold
  // span early and leave dangling asterisks in the rendered
  // post. Reject up-front so the model gets a clean error
  // instead of producing a corrupt-looking output.
  if (typeof obj.title === 'string' && obj.title.includes('*')) {
    errors.push("title must not contain '*' (interferes with Slack bold formatting)");
  }
  checkStringField(errors, obj, 'durationLabel', SLACK_LIMITS.durationLabelMaxChars);
  checkStringField(errors, obj, 'costLabel', SLACK_LIMITS.costLabelMaxChars);
  checkBoundedArray(
    errors,
    obj,
    'achievements',
    1,
    SLACK_LIMITS.achievementsMaxItems,
    SLACK_LIMITS.achievementsMaxChars,
  );
  checkBoundedArray(
    errors,
    obj,
    'files',
    0,
    SLACK_LIMITS.filesMaxItems,
    SLACK_LIMITS.filesMaxChars,
  );
  checkBoundedArray(
    errors,
    obj,
    'decisions',
    0,
    SLACK_LIMITS.decisionsMaxItems,
    SLACK_LIMITS.decisionsMaxChars,
  );
  return { ok: errors.length === 0, errors };
};
