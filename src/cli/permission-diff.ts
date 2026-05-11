// `agent permission diff <seq1> <seq2>` — PERMISSION_ENGINE.md §17
// cross-row comparison.
//
// Render two audit rows side-by-side with field-by-field diff
// markers, capabilities set diff, and score-components deltas.
// Used for calibration sweeps ("score 0.4 but human clicked deny —
// what changed between this row and that row?"), policy review
// ("two similar calls, different outcomes — which rule fired
// differently?"), and forensic triage.
//
// Read-only: no re-execution, no engine boot. Both rows already
// carry every input the analysis needs as columns. Spec §17's three
// replay modes (default, --against-current-policy, --without-
// classifier) handle re-execution; this verb is the cross-row
// rendering surface.
//
// Cross-install refusal mirrors permission-replay: if either row's
// install_id doesn't match the active install, refuse with
// not_found and name both ids in the message. Prevents forensic-
// data leaks across installs sharing a DB file (rare but possible
// during a restore).

import { ensureInstallId } from '../permissions/index.ts';
import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { type ApprovalLogRow, getApprovalsLogBySeq } from '../storage/repos/approvals-log.ts';

export interface RunPermissionDiffOptions {
  seq1: number;
  seq2: number;
  json?: boolean;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

// Per-field comparison. `same` when both sides match; `different`
// otherwise. Both values rendered for transparency.
interface FieldDiff {
  field: string;
  v1: string;
  v2: string;
  same: boolean;
}

// Set-diff for capability arrays. Both rows already have canonical
// (sorted by formatCapability) lists; we treat them as sets and
// report only-in-1, only-in-2, common.
interface CapabilitiesDiff {
  only_in_seq1: string[];
  only_in_seq2: string[];
  common: string[];
}

// Component-wise diff for score_components. Same key in both rows
// with different values → reported as a `delta` (signed). Keys only
// in one side render as new/dropped contributions.
interface ScoreComponentsDiff {
  only_in_seq1: Record<string, number>;
  only_in_seq2: Record<string, number>;
  deltas: Record<string, { v1: number; v2: number; delta: number }>;
}

interface DiffResult {
  row1: ApprovalLogRow;
  row2: ApprovalLogRow;
  fieldDiffs: FieldDiff[];
  capabilities: CapabilitiesDiff;
  scoreComponents: ScoreComponentsDiff;
}

const fmtValue = (v: unknown): string => {
  if (v === null) return '<null>';
  if (v === undefined) return '<undef>';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toString() : `${v}`;
  return String(v);
};

const fmtSignedNumber = (n: number): string => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

// Field-by-field comparison of the primary scalar columns. The
// JSON / array columns (capabilities, score_components, reason
// chain) get their own dedicated diff blocks below.
const buildFieldDiffs = (r1: ApprovalLogRow, r2: ApprovalLogRow): FieldDiff[] => {
  const fields: { name: string; v1: unknown; v2: unknown }[] = [
    { name: 'tool', v1: r1.tool_name, v2: r2.tool_name },
    { name: 'tool_version', v1: r1.tool_version, v2: r2.tool_version },
    { name: 'resolver_version', v1: r1.resolver_version, v2: r2.resolver_version },
    { name: 'decision', v1: r1.decision, v2: r2.decision },
    { name: 'confidence', v1: r1.confidence, v2: r2.confidence },
    { name: 'score', v1: r1.score.toFixed(2), v2: r2.score.toFixed(2) },
    { name: 'classifier_hash', v1: r1.classifier_hash, v2: r2.classifier_hash },
    {
      name: 'classifier_adjust',
      v1: r1.classifier_adjust === null ? null : r1.classifier_adjust.toFixed(2),
      v2: r2.classifier_adjust === null ? null : r2.classifier_adjust.toFixed(2),
    },
    { name: 'policy_hash', v1: r1.policy_hash, v2: r2.policy_hash },
    { name: 'sandbox_profile', v1: r1.sandbox_profile, v2: r2.sandbox_profile },
    { name: 'args_hash', v1: r1.args_hash, v2: r2.args_hash },
    { name: 'session_id', v1: r1.session_id, v2: r2.session_id },
  ];
  return fields.map((f) => ({
    field: f.name,
    v1: fmtValue(f.v1),
    v2: fmtValue(f.v2),
    same: fmtValue(f.v1) === fmtValue(f.v2),
  }));
};

const parseCapList = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {}
  return [];
};

const buildCapabilitiesDiff = (r1: ApprovalLogRow, r2: ApprovalLogRow): CapabilitiesDiff => {
  const c1 = new Set(parseCapList(r1.capabilities_json));
  const c2 = new Set(parseCapList(r2.capabilities_json));
  const only_in_seq1: string[] = [];
  const only_in_seq2: string[] = [];
  const common: string[] = [];
  for (const cap of c1) {
    if (c2.has(cap)) common.push(cap);
    else only_in_seq1.push(cap);
  }
  for (const cap of c2) {
    if (!c1.has(cap)) only_in_seq2.push(cap);
  }
  return {
    only_in_seq1: only_in_seq1.sort(),
    only_in_seq2: only_in_seq2.sort(),
    common: common.sort(),
  };
};

const parseComponents = (json: string): Record<string, number> => {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
  } catch {}
  return {};
};

const buildScoreComponentsDiff = (r1: ApprovalLogRow, r2: ApprovalLogRow): ScoreComponentsDiff => {
  const c1 = parseComponents(r1.score_components_json);
  const c2 = parseComponents(r2.score_components_json);
  const only_in_seq1: Record<string, number> = {};
  const only_in_seq2: Record<string, number> = {};
  const deltas: Record<string, { v1: number; v2: number; delta: number }> = {};
  const allKeys = new Set([...Object.keys(c1), ...Object.keys(c2)]);
  for (const k of allKeys) {
    const inFirst = Object.hasOwn(c1, k);
    const inSecond = Object.hasOwn(c2, k);
    if (inFirst && !inSecond) only_in_seq1[k] = c1[k] as number;
    else if (!inFirst && inSecond) only_in_seq2[k] = c2[k] as number;
    else if (inFirst && inSecond) {
      const v1 = c1[k] as number;
      const v2 = c2[k] as number;
      if (v1 !== v2) deltas[k] = { v1, v2, delta: v2 - v1 };
    }
  }
  return { only_in_seq1, only_in_seq2, deltas };
};

const renderText = (result: DiffResult, out: (s: string) => void): void => {
  const r1 = result.row1;
  const r2 = result.row2;
  out(`Diff seq=${r1.seq} vs seq=${r2.seq} (install_id=${r1.install_id}):\n`);

  // Field-by-field block. Right-pad value columns so the comparison
  // markers align cleanly across rows. Cap each value to 40 chars
  // so a long hash doesn't push the marker off-screen.
  const truncate = (s: string, max: number): string =>
    s.length <= max ? s : `${s.slice(0, max - 1)}…`;
  const maxFieldLen = result.fieldDiffs.reduce((acc, f) => Math.max(acc, f.field.length), 0);
  for (const f of result.fieldDiffs) {
    const marker = f.same ? '✓ same' : '⚠ different';
    out(
      `  ${`${f.field}:`.padEnd(maxFieldLen + 2)} ${truncate(f.v1, 40).padEnd(42)} ${truncate(f.v2, 40).padEnd(42)} ${marker}\n`,
    );
  }

  // Capabilities set diff.
  out('\n');
  out('  capabilities (set diff):\n');
  const c = result.capabilities;
  out(
    `    only in seq=${r1.seq}: ${c.only_in_seq1.length === 0 ? '(none)' : c.only_in_seq1.join(', ')}\n`,
  );
  out(
    `    only in seq=${r2.seq}: ${c.only_in_seq2.length === 0 ? '(none)' : c.only_in_seq2.join(', ')}\n`,
  );
  out(`    common:           ${c.common.length === 0 ? '(none)' : c.common.join(', ')}\n`);

  // Score-components diff.
  out('\n');
  out('  score_components diff:\n');
  const s = result.scoreComponents;
  const renderObj = (obj: Record<string, number>): string =>
    Object.keys(obj).length === 0
      ? '(none)'
      : Object.entries(obj)
          .map(([k, v]) => `${k}=${fmtSignedNumber(v)}`)
          .join(', ');
  out(`    only in seq=${r1.seq}: ${renderObj(s.only_in_seq1)}\n`);
  out(`    only in seq=${r2.seq}: ${renderObj(s.only_in_seq2)}\n`);
  if (Object.keys(s.deltas).length === 0) {
    out('    deltas:           (no shared components changed)\n');
  } else {
    out('    deltas:\n');
    for (const [k, { v1, v2, delta }] of Object.entries(s.deltas)) {
      out(
        `      ${k}: ${fmtSignedNumber(v1)} → ${fmtSignedNumber(v2)} (Δ ${fmtSignedNumber(delta)})\n`,
      );
    }
  }
};

const renderJson = (result: DiffResult, out: (s: string) => void): void => {
  const r1 = result.row1;
  const r2 = result.row2;
  out(
    `${JSON.stringify({
      ok: true,
      seq1: r1.seq,
      seq2: r2.seq,
      install_id: r1.install_id,
      rows: {
        seq1: { tool_name: r1.tool_name, decision: r1.decision, score: r1.score },
        seq2: { tool_name: r2.tool_name, decision: r2.decision, score: r2.score },
      },
      diff: {
        fields: result.fieldDiffs,
        capabilities: result.capabilities,
        score_components: result.scoreComponents,
      },
    })}\n`,
  );
};

export const runPermissionDiff = async (options: RunPermissionDiffOptions): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const env = options.env ?? process.env;

  for (const seq of [options.seq1, options.seq2]) {
    if (!Number.isInteger(seq) || seq <= 0) {
      const message = `agent permission diff: <seq> must be a positive integer (got ${seq})`;
      if (json) {
        out(`${JSON.stringify({ ok: false, error: 'invalid_seq', message })}\n`);
      } else {
        err(`${message}\n`);
      }
      return 1;
    }
  }

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId({ env });
  } catch (e) {
    const message = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message })}\n`);
    } else {
      err(`agent permission diff: ${message}\n`);
    }
    return 1;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(dbPath);
    migrate(db, MIGRATIONS);
  } catch (e) {
    const message = (e as Error).message;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'db',
          message,
          install_id: identity.install_id,
        })}\n`,
      );
    } else {
      err(`agent permission diff: ${message}\n`);
    }
    return 1;
  }

  const row1 = getApprovalsLogBySeq(db, options.seq1);
  const row2 = getApprovalsLogBySeq(db, options.seq2);
  if (row1 === null || row1.install_id !== identity.install_id) {
    const message =
      row1 === null
        ? `no approval row found at seq=${options.seq1}`
        : `approval row at seq=${options.seq1} belongs to a different install_id (row.install_id=${row1.install_id}, current=${identity.install_id})`;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'not_found',
          message,
          install_id: identity.install_id,
          seq: options.seq1,
        })}\n`,
      );
    } else {
      err(`agent permission diff: ${message}\n`);
    }
    return 1;
  }
  if (row2 === null || row2.install_id !== identity.install_id) {
    const message =
      row2 === null
        ? `no approval row found at seq=${options.seq2}`
        : `approval row at seq=${options.seq2} belongs to a different install_id (row.install_id=${row2.install_id}, current=${identity.install_id})`;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'not_found',
          message,
          install_id: identity.install_id,
          seq: options.seq2,
        })}\n`,
      );
    } else {
      err(`agent permission diff: ${message}\n`);
    }
    return 1;
  }

  const result: DiffResult = {
    row1,
    row2,
    fieldDiffs: buildFieldDiffs(row1, row2),
    capabilities: buildCapabilitiesDiff(row1, row2),
    scoreComponents: buildScoreComponentsDiff(row1, row2),
  };
  if (json) renderJson(result, out);
  else renderText(result, out);
  return 0;
};
