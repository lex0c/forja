// `agent permission calibration-export` — operator surface for
// the spec §6.3.2 step 1 "coletar triples por 30d em deployment
// piloto" data extraction. DB-only path: no provider, no session
// start. Reads `approvals_log` + `outcome_signals` for the
// install_id resolved from the environment.
//
// Default output: human-readable coverage summary on stdout
// (counts by outcome label + decision + signal coverage). With
// `--json`: NDJSON one-triple-per-line on stdout, coverage
// summary on stderr.
//
// Default window: last 30 days. `--since-days N` overrides.
// `--all-decisions` widens the decision filter to '*'; default
// keeps the spec's clean-label set (confirm-allowed + confirm-
// denied).

import {
  type CalibrationCoverage,
  type CalibrationTriple,
  extractCalibrationTriples,
} from '../outcomes/calibration.ts';
import { ensureInstallId } from '../permissions/install_id.ts';
import { MIGRATIONS, closeDb, defaultDbPath, migrate, openDb } from '../storage/index.ts';

export interface RunPermissionCalibrationExportOptions {
  json?: boolean;
  // Time window in days (e.g., 30 → since = now - 30*86400_000).
  // Default 30 per spec §6.3.2 step 1.
  sinceDays?: number;
  // Widen the decision filter to '*' (every row). Default keeps
  // confirm-allowed / confirm-denied only.
  allDecisions?: boolean;
  // Override the row cap. Default 100_000.
  limit?: number;
  // Test seams.
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

const MS_PER_DAY = 86_400_000;

const formatCoverageText = (
  coverage: CalibrationCoverage,
  windowDays: number,
  installId: string,
): string => {
  const lines: string[] = [];
  lines.push(`calibration export — install_id=${installId}`);
  lines.push(`window: last ${windowDays} days`);
  lines.push(`triples: ${coverage.total}`);
  lines.push(`  harmful : ${coverage.harmful}`);
  lines.push(`  harmless: ${coverage.harmless}`);
  lines.push(`  with at least one outcome_signal: ${coverage.withAnySignal}`);
  if (Object.keys(coverage.byDecision).length > 0) {
    lines.push('by decision:');
    const sortedDecisions = Object.entries(coverage.byDecision).sort((a, b) => b[1] - a[1]);
    for (const [decision, count] of sortedDecisions) {
      lines.push(`  ${decision}: ${count}`);
    }
  }
  // Spec §6.3.2 step 4 hints at "approval-fatigue >30%" as a
  // calibration trigger; surface a soft hint when the window is
  // sparse so operators know they may want to wait for more data
  // before running offline regression.
  if (coverage.total < 100) {
    lines.push('');
    lines.push('note: <100 triples in window — calibration sweep recommended at ≥100+ rows.');
  }
  return `${lines.join('\n')}\n`;
};

// Project the CalibrationTriple into a JSON-friendly shape. We
// flatten `outcome` to `outcome.outcome` (label) + composite +
// signal_kinds (array of names) so consumers don't have to walk
// into the nested OutcomeAggregate. signals carries the full
// per-row breakdown for callers that need per-kind subscores.
const triplesToNdjson = (triples: readonly CalibrationTriple[]): string => {
  const lines: string[] = [];
  for (const t of triples) {
    const payload = {
      approval_seq: t.approval_seq,
      ts: t.ts,
      tool_name: t.tool_name,
      decision: t.decision,
      score: t.score,
      score_components: t.score_components,
      outcome: t.outcome.outcome,
      composite: t.outcome.composite,
      signal_kinds: t.outcome.signals.map((s) => s.signal_kind),
    };
    lines.push(JSON.stringify(payload));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

export const runPermissionCalibrationExport = async (
  options: RunPermissionCalibrationExportOptions = {},
): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const now = options.now ?? (() => Date.now());
  const sinceDays = options.sinceDays ?? 30;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) {
    err(`forja permission calibration-export: --since-days must be > 0 (got ${sinceDays})\n`);
    return 1;
  }

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId(options.env !== undefined ? { env: options.env } : {});
  } catch (e) {
    const reason = (e as Error).message;
    err(`forja permission calibration-export: install_id: ${reason}\n`);
    return 1;
  }

  const dbPath = options.dbPath ?? defaultDbPath();
  let triples: CalibrationTriple[];
  try {
    const db = openDb(dbPath);
    migrate(db, MIGRATIONS);
    const extractOpts = {
      installId: identity.install_id,
      sinceMs: now() - sinceDays * MS_PER_DAY,
      ...(options.allDecisions === true ? { decisions: '*' as const } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
    // Extract once, derive coverage from the in-memory result.
    // Pre-fixup the CLI called `summarizeCalibrationCoverage`
    // AND `extractCalibrationTriples` back-to-back with identical
    // options — each walks the full install rowset and issues
    // one signal-lookup query per approval. At the 100k retention
    // ceiling that doubles to ~200k SQL round-trips per CLI call.
    triples = extractCalibrationTriples(db, extractOpts);
    closeDb(db);
  } catch (e) {
    err(`forja permission calibration-export: db: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  // Coverage summary is a pure in-memory fold over `triples`; same
  // algorithm as `summarizeCalibrationCoverage` but without the
  // second DB pass. Keep both code paths in sync — if a future
  // counter lands in the module-level summary, mirror it here.
  const coverage: CalibrationCoverage = {
    total: triples.length,
    harmful: 0,
    harmless: 0,
    byDecision: {},
    withAnySignal: 0,
  };
  for (const t of triples) {
    if (t.outcome.outcome === 'harmful') coverage.harmful += 1;
    else coverage.harmless += 1;
    coverage.byDecision[t.decision] = (coverage.byDecision[t.decision] ?? 0) + 1;
    if (t.outcome.signals.length > 0) coverage.withAnySignal += 1;
  }

  if (json) {
    // NDJSON triples on stdout; coverage summary on stderr (so
    // pipes consuming stdout see only the triples).
    out(triplesToNdjson(triples));
    err(formatCoverageText(coverage, sinceDays, identity.install_id));
  } else {
    out(formatCoverageText(coverage, sinceDays, identity.install_id));
  }
  return 0;
};
