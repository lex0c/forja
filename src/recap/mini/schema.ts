// RecapMini — subset projection per RECAP §3.1. Lighter and
// cheaper than `RecapIntermediate`; consumed by:
//
//   - `forja --list-sessions --with-recap` (CLI)
//   - `/recap list [filtros]` (slash)
//   - SessionPicker (TUI; future)
//
// The full intermediate is overkill for these surfaces — they
// only need session-level metadata + a one-line summary.
// Computing the full intermediate per session in a list of 50+
// would also blow the picker's <50ms per-row budget (RECAP §3.1).

import type { SessionStatus } from '../../storage/repos/sessions.ts';

export const RECAP_MINI_SCHEMA_VERSION = 'mini-v1' as const;

export type RecapMiniSchemaVersion = typeof RECAP_MINI_SCHEMA_VERSION;

export interface RecapMini {
  schemaVersion: RecapMiniSchemaVersion;
  sessionId: string;
  // First line of the user prompt; truncated to 120 chars.
  goal: string;
  status: SessionStatus;
  startedAt: number;
  // null while status='running'; set when status terminal.
  endedAt: number | null;
  durationMs: number;
  steps: number;
  costUsd: number;
  cwd: string;
  // Display label — basename of cwd (last directory). Operator-
  // friendly; the picker shows this above the full path.
  cwdLabel: string;
  // ≤ 120 chars per RECAP §3.1. LLM-rendered when wired (slice
  // c-mini-2); deterministic fallback today is
  // `"<status>: {N} steps, {M} files, {goal_truncated}"`.
  oneLineSummary: string;
  // Aggregated count of tool_calls that wrote files.
  filesChanged: number;
  // True iff `failure_events` lists a user-visible error for the
  // session. Stays false until the failure_events table is
  // populated upstream — see RECAP §3 schema-fields-blocked
  // tracking.
  hasErrors: boolean;
  // True iff status is non-terminal (running) at projection time.
  // Operator must surface explicitly — SessionPicker badges these
  // rows so an operator does not act on partial data.
  incomplete: boolean;
}

export const RECAP_MINI_LIMITS = {
  goalMaxChars: 120,
  oneLineSummaryMaxChars: 120,
  cwdLabelMaxChars: 64,
} as const;

export const RECAP_MINI_JSON_SCHEMA = {
  type: 'object',
  required: [
    'schemaVersion',
    'sessionId',
    'goal',
    'status',
    'startedAt',
    'endedAt',
    'durationMs',
    'steps',
    'costUsd',
    'cwd',
    'cwdLabel',
    'oneLineSummary',
    'filesChanged',
    'hasErrors',
    'incomplete',
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [RECAP_MINI_SCHEMA_VERSION] },
    sessionId: { type: 'string', minLength: 1 },
    goal: { type: 'string', maxLength: RECAP_MINI_LIMITS.goalMaxChars },
    status: { type: 'string', enum: ['running', 'done', 'interrupted', 'exhausted', 'error'] },
    startedAt: { type: 'integer', minimum: 0 },
    endedAt: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    durationMs: { type: 'integer', minimum: 0 },
    steps: { type: 'integer', minimum: 0 },
    costUsd: { type: 'number', minimum: 0 },
    cwd: { type: 'string' },
    cwdLabel: { type: 'string', maxLength: RECAP_MINI_LIMITS.cwdLabelMaxChars },
    oneLineSummary: { type: 'string', maxLength: RECAP_MINI_LIMITS.oneLineSummaryMaxChars },
    filesChanged: { type: 'integer', minimum: 0 },
    hasErrors: { type: 'boolean' },
    incomplete: { type: 'boolean' },
  },
} as const;

const VALID_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'running',
  'done',
  'interrupted',
  'exhausted',
  'error',
]);

const isStatus = (v: unknown): v is SessionStatus =>
  typeof v === 'string' && VALID_STATUSES.has(v as SessionStatus);

export interface RecapMiniValidationResult {
  ok: boolean;
  errors: string[];
}

export const validateRecapMini = (value: unknown): RecapMiniValidationResult => {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['root must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'sessionId',
    'goal',
    'status',
    'startedAt',
    'endedAt',
    'durationMs',
    'steps',
    'costUsd',
    'cwd',
    'cwdLabel',
    'oneLineSummary',
    'filesChanged',
    'hasErrors',
    'incomplete',
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`unexpected property '${k}'`);
  }
  if (obj.schemaVersion !== RECAP_MINI_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${RECAP_MINI_SCHEMA_VERSION}'`);
  }
  if (typeof obj.sessionId !== 'string' || obj.sessionId.length === 0) {
    errors.push('sessionId must be non-empty string');
  }
  if (typeof obj.goal !== 'string' || obj.goal.length > RECAP_MINI_LIMITS.goalMaxChars) {
    errors.push(`goal must be string ≤ ${RECAP_MINI_LIMITS.goalMaxChars} chars`);
  }
  if (!isStatus(obj.status)) {
    errors.push('status must be one of running|done|interrupted|exhausted|error');
  }
  if (typeof obj.startedAt !== 'number' || obj.startedAt < 0) {
    errors.push('startedAt must be non-negative integer');
  }
  if (obj.endedAt !== null && (typeof obj.endedAt !== 'number' || obj.endedAt < 0)) {
    errors.push('endedAt must be non-negative integer or null');
  }
  if (typeof obj.durationMs !== 'number' || obj.durationMs < 0) {
    errors.push('durationMs must be non-negative integer');
  }
  if (typeof obj.steps !== 'number' || obj.steps < 0) {
    errors.push('steps must be non-negative integer');
  }
  if (typeof obj.costUsd !== 'number' || obj.costUsd < 0) {
    errors.push('costUsd must be non-negative number');
  }
  if (typeof obj.cwd !== 'string') {
    errors.push('cwd must be string');
  }
  if (
    typeof obj.cwdLabel !== 'string' ||
    obj.cwdLabel.length > RECAP_MINI_LIMITS.cwdLabelMaxChars
  ) {
    errors.push(`cwdLabel must be string ≤ ${RECAP_MINI_LIMITS.cwdLabelMaxChars} chars`);
  }
  if (
    typeof obj.oneLineSummary !== 'string' ||
    obj.oneLineSummary.length > RECAP_MINI_LIMITS.oneLineSummaryMaxChars
  ) {
    errors.push(
      `oneLineSummary must be string ≤ ${RECAP_MINI_LIMITS.oneLineSummaryMaxChars} chars`,
    );
  }
  if (typeof obj.filesChanged !== 'number' || obj.filesChanged < 0) {
    errors.push('filesChanged must be non-negative integer');
  }
  if (typeof obj.hasErrors !== 'boolean') errors.push('hasErrors must be boolean');
  if (typeof obj.incomplete !== 'boolean') errors.push('incomplete must be boolean');
  return { ok: errors.length === 0, errors };
};
