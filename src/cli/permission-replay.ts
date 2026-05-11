// `agent permission replay <seq>` — PERMISSION_ENGINE.md §17.
//
// Slice 12 ships the minimum viable replay surface: read an
// approvals_log row by its sequence number, render every field
// preserved on the row, and flag policy drift when the row's
// `policy_hash` differs from the hash of the currently-loaded
// policy. Operators investigating a past decision get every input
// the engine saw at decision time, in one stable view.
//
// Out of scope (next slices, all of them documented in BACKLOG):
//   - `--against-current-policy`: real re-execution against the
//     active policy. Requires a `policy_archive` table (the spec's
//     §17 lookup) so the ORIGINAL policy can be reconstructed; the
//     active policy alone isn't enough.
//   - `--without-classifier`: re-run scoring with the classifier
//     branch suppressed; same archive prerequisite.
//   - `agent permission diff <id1> <id2>`: cross-row comparison.
//   - Raw args: live in session SQLite (not in approvals_log); a
//     future slice persists them with a TTL. For now replay shows
//     `args_hash` only.
//
// The CLI surface mirrors `agent permission verify` /
// `rotate-chain`: DB-only, no provider, no session start. Exit 0
// on a row found, 1 on bootstrap/DB/missing-row errors.

import { DEFAULT_SCORE_CONFIRM_THRESHOLD, ensureInstallId } from '../permissions/index.ts';
import { type Policy, canonicalHash, resolvePolicy } from '../permissions/index.ts';
import { MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { type ApprovalLogRow, getApprovalsLogBySeq } from '../storage/repos/approvals-log.ts';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

// §17 `--without-classifier` analysis. Pure function of the row's
// columns — no DB or engine state consulted. The audit row stores
// `score_components_json` (the per-feature deterministic
// contributions) and `classifier_adjust` (the clamped hint applied
// at decision time) as separate fields; we recover the deterministic
// score by summing the components, then re-apply the §6.6 threshold
// rule both with and without the adjust to surface the impact.
const analyzeClassifierImpact = (
  row: ApprovalLogRow,
  threshold: number,
): ClassifierImpactAnalysis => {
  let components: Record<string, number>;
  try {
    components = JSON.parse(row.score_components_json) as Record<string, number>;
  } catch {
    components = {};
  }
  const deterministicSum = Object.values(components).reduce(
    (acc, v) => acc + (typeof v === 'number' ? v : 0),
    0,
  );
  const deterministic_score = clamp01(deterministicSum);
  const final_score = row.score;
  const classifier_adjust = row.classifier_adjust;
  const would_gate_with_classifier = final_score >= threshold;
  const would_gate_without_classifier = deterministic_score >= threshold;

  let verdict: ClassifierImpactVerdict;
  if (classifier_adjust === null) {
    verdict = 'not_run';
  } else if (would_gate_with_classifier === would_gate_without_classifier) {
    verdict = 'no_change';
  } else {
    verdict = 'changed_decision';
  }

  return {
    verdict,
    deterministic_score,
    final_score,
    classifier_adjust,
    threshold,
    would_gate_with_classifier,
    would_gate_without_classifier,
  };
};

export interface RunPermissionReplayOptions {
  seq: number;
  json?: boolean;
  // §17 `--without-classifier` mode. When true, replay decomposes
  // the row's score into deterministic + classifier components and
  // surfaces whether the classifier moved the decision across the
  // §6.6 threshold. Default mode is unchanged.
  withoutClassifier?: boolean;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  cwd?: string;
}

// Verdict from `--without-classifier`. Captures the three operationally
// meaningful outcomes of "what would have happened without the hint":
//
//   - `not_run`     — classifier didn't fire for this row (classifier_adjust=null).
//                     Replay shows the deterministic-only path is identical to
//                     what's already recorded.
//   - `no_change`   — classifier fired but didn't move the decision across the
//                     §6.6 score threshold. Operator sees "noise but no impact".
//   - `changed_decision` — classifier moved the decision across the threshold.
//                          Replay names the would-be outcome both ways. The
//                          §6.6 row 5 rule (confidence != high → confirm) is
//                          NOT modeled here because it doesn't consult the
//                          score-side gate; this verdict tracks the score-side
//                          gate only.
type ClassifierImpactVerdict = 'not_run' | 'no_change' | 'changed_decision';

interface ClassifierImpactAnalysis {
  verdict: ClassifierImpactVerdict;
  // Deterministic score (sum of feature components), capped [0, 1].
  // Equals what the engine produced before adding the classifier
  // adjust. Always present.
  deterministic_score: number;
  // Final recorded score from the row. Equals the deterministic
  // score when verdict='not_run'.
  final_score: number;
  // Effective adjust applied at decision time. null when classifier
  // didn't run. Already CLAMPED to [-0.2, 0.2] by the engine.
  classifier_adjust: number | null;
  // §6.6 threshold the row was decided under. Surfaced so the
  // analysis is self-explanatory without re-reading the engine
  // constant.
  threshold: number;
  // Hypothetical decisions on each side of the threshold. Both
  // populated; equal when verdict is 'no_change' or 'not_run'.
  would_gate_with_classifier: boolean;
  would_gate_without_classifier: boolean;
}

interface ReplayResult {
  row: ApprovalLogRow;
  drift: boolean;
  activePolicyHash: string;
  classifierImpact?: ClassifierImpactAnalysis;
}

const loadActivePolicy = (cwd: string, env: NodeJS.ProcessEnv): Policy | null => {
  try {
    const resolved = resolvePolicy({ cwd, home: env.HOME ?? cwd, env });
    return resolved.policy;
  } catch {
    // Policy unloadable (malformed YAML, missing required section).
    // Replay can still render the row; we just can't compare hashes.
    return null;
  }
};

// Format the row's reason_chain JSON into one bullet per stage.
// Stable order — whatever the engine stored is what replay shows.
const renderReasonChain = (json: string): string => {
  type Entry = {
    stage: string;
    layer?: string;
    rule?: string;
    section?: string;
    note?: string;
  };
  let entries: Entry[];
  try {
    entries = JSON.parse(json) as Entry[];
  } catch {
    return `  reason chain: <malformed JSON: ${json}>`;
  }
  if (!Array.isArray(entries) || entries.length === 0) return '  reason chain: (empty)';
  const lines: string[] = ['  reason chain:'];
  for (const e of entries) {
    const fragments: string[] = [`stage=${e.stage}`];
    if (e.layer !== undefined) fragments.push(`layer=${e.layer}`);
    if (e.rule !== undefined) fragments.push(`rule="${e.rule}"`);
    if (e.section !== undefined) fragments.push(`section=${e.section}`);
    if (e.note !== undefined) fragments.push(`note="${e.note}"`);
    lines.push(`    - ${fragments.join(' ')}`);
  }
  return lines.join('\n');
};

const renderScoreComponents = (json: string): string => {
  let components: Record<string, number>;
  try {
    components = JSON.parse(json) as Record<string, number>;
  } catch {
    return `  score components: <malformed JSON: ${json}>`;
  }
  const entries = Object.entries(components);
  if (entries.length === 0) return '  score components: (none — score=0 baseline)';
  // Sort by descending magnitude so the biggest contributors show
  // first; ties fall back to alphabetical for replay determinism.
  entries.sort((a, b) => {
    const diff = Math.abs(b[1]) - Math.abs(a[1]);
    if (diff !== 0) return diff;
    return a[0] < b[0] ? -1 : 1;
  });
  const lines = ['  score components:'];
  for (const [k, v] of entries) {
    const sign = v >= 0 ? '+' : '';
    lines.push(`    ${k}: ${sign}${v.toFixed(2)}`);
  }
  return lines.join('\n');
};

const renderCapabilities = (json: string): string => {
  let caps: string[];
  try {
    caps = JSON.parse(json) as string[];
  } catch {
    return `  capabilities: <malformed JSON: ${json}>`;
  }
  if (!Array.isArray(caps) || caps.length === 0) return '  capabilities: (none)';
  return `  capabilities: ${caps.join(', ')}`;
};

const renderText = (result: ReplayResult, out: (s: string) => void): void => {
  const r = result.row;
  out(`Replay approval seq=${r.seq} (install_id=${r.install_id}):\n`);
  out(`  ts:                 ${r.ts}\n`);
  out(`  tool:               ${r.tool_name} (version=${r.tool_version})\n`);
  out(`  resolver_version:   ${r.resolver_version}\n`);
  out(`  session_id:         ${r.session_id}\n`);
  if (r.parent_approval_id !== null) {
    out(`  parent_approval_id: ${r.parent_approval_id}\n`);
  }
  out(`  decision:           ${r.decision}\n`);
  out(`  confidence:         ${r.confidence}\n`);
  out(`  args_hash:          ${r.args_hash}\n`);
  out(`${renderCapabilities(r.capabilities_json)}\n`);
  out(`  score:              ${r.score.toFixed(2)}\n`);
  out(`${renderScoreComponents(r.score_components_json)}\n`);
  out(
    `  classifier:         hash=${r.classifier_hash ?? '<none>'}, adjust=${
      r.classifier_adjust === null ? '<none>' : r.classifier_adjust.toFixed(2)
    }\n`,
  );
  out(`  sandbox profile:    ${r.sandbox_profile ?? '(not planned)'}\n`);
  if (r.ttl_expires_at !== null) {
    out(`  ttl expires at:     ${r.ttl_expires_at}\n`);
  }
  out(`${renderReasonChain(r.reason_chain_json)}\n`);
  out(`  policy_hash:        ${r.policy_hash}\n`);
  if (result.drift) {
    out(`  policy drift:       ⚠ active policy hash differs (${result.activePolicyHash})\n`);
    out('                      Use git/blame on the policy file to find the change.\n');
  } else if (result.activePolicyHash === r.policy_hash) {
    out('  policy drift:       ✓ active policy matches the row\n');
  } else {
    out('  policy drift:       (active policy unavailable — not compared)\n');
  }
  out(`  prev_hash:          ${r.prev_hash}\n`);
  out(`  this_hash:          ${r.this_hash}\n`);

  if (result.classifierImpact !== undefined) {
    const c = result.classifierImpact;
    out('\n');
    out('  Classifier impact analysis (--without-classifier):\n');
    out(`    deterministic score:       ${c.deterministic_score.toFixed(2)}\n`);
    out(
      `    classifier adjust:         ${c.classifier_adjust === null ? '<not run>' : c.classifier_adjust.toFixed(2)}\n`,
    );
    out(`    final score (recorded):    ${c.final_score.toFixed(2)}\n`);
    out(`    §6.6 threshold:            ${c.threshold.toFixed(2)}\n`);
    out(
      `    would gate (with):         ${c.would_gate_with_classifier ? 'yes (≥ threshold)' : 'no (< threshold)'}\n`,
    );
    out(
      `    would gate (without):      ${c.would_gate_without_classifier ? 'yes (≥ threshold)' : 'no (< threshold)'}\n`,
    );
    let verdictLine: string;
    if (c.verdict === 'not_run') {
      verdictLine = 'verdict: classifier did not run for this row (analysis is informational only)';
    } else if (c.verdict === 'no_change') {
      verdictLine = 'verdict: no change (classifier did not move the decision across §6.6)';
    } else {
      verdictLine = c.would_gate_with_classifier
        ? 'verdict: ⚠ classifier RAISED the score across §6.6 (without it, no gate would have fired)'
        : 'verdict: ⚠ classifier LOWERED the score below §6.6 (without it, the gate would have fired)';
    }
    out(`    ${verdictLine}\n`);
  }
};

const renderJson = (result: ReplayResult, out: (s: string) => void): void => {
  // Emit the row's columns verbatim plus the drift flag. JSON shape
  // is intentionally a flat object — no nesting beyond what's already
  // serialized inside *_json columns (which we surface as parsed
  // sub-objects for downstream tooling).
  const r = result.row;
  const reasonChain = (() => {
    try {
      return JSON.parse(r.reason_chain_json) as unknown;
    } catch {
      return r.reason_chain_json;
    }
  })();
  const scoreComponents = (() => {
    try {
      return JSON.parse(r.score_components_json) as unknown;
    } catch {
      return r.score_components_json;
    }
  })();
  const capabilities = (() => {
    try {
      return JSON.parse(r.capabilities_json) as unknown;
    } catch {
      return r.capabilities_json;
    }
  })();
  out(
    `${JSON.stringify({
      ok: true,
      seq: r.seq,
      ts: r.ts,
      install_id: r.install_id,
      session_id: r.session_id,
      parent_approval_id: r.parent_approval_id,
      tool_name: r.tool_name,
      tool_version: r.tool_version,
      resolver_version: r.resolver_version,
      args_hash: r.args_hash,
      capabilities,
      decision: r.decision,
      score: r.score,
      score_components: scoreComponents,
      confidence: r.confidence,
      classifier_hash: r.classifier_hash,
      classifier_adjust: r.classifier_adjust,
      policy_hash: r.policy_hash,
      sandbox_profile: r.sandbox_profile,
      ttl_expires_at: r.ttl_expires_at,
      reason_chain: reasonChain,
      prev_hash: r.prev_hash,
      this_hash: r.this_hash,
      policy_drift: result.drift,
      active_policy_hash: result.activePolicyHash,
      ...(result.classifierImpact !== undefined
        ? { classifier_impact: result.classifierImpact }
        : {}),
    })}\n`,
  );
};

export const runPermissionReplay = async (options: RunPermissionReplayOptions): Promise<number> => {
  const out = options.out ?? ((s) => process.stdout.write(s));
  const err = options.err ?? ((s) => process.stderr.write(s));
  const json = options.json === true;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  if (!Number.isInteger(options.seq) || options.seq <= 0) {
    const message = `agent permission replay: <seq> must be a positive integer (got ${options.seq})`;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'invalid_seq', message })}\n`);
    } else {
      err(`${message}\n`);
    }
    return 1;
  }

  let identity: { install_id: string; created_at_ms: number };
  try {
    identity = ensureInstallId({ env });
  } catch (e) {
    const message = (e as Error).message;
    if (json) {
      out(`${JSON.stringify({ ok: false, error: 'install_id', message })}\n`);
    } else {
      err(`agent permission replay: ${message}\n`);
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
      err(`agent permission replay: ${message}\n`);
    }
    return 1;
  }

  const row = getApprovalsLogBySeq(db, options.seq);
  if (row === null || row.install_id !== identity.install_id) {
    const message =
      row === null
        ? `no approval row found at seq=${options.seq}`
        : `approval row at seq=${options.seq} belongs to a different install_id (row.install_id=${row.install_id}, current=${identity.install_id})`;
    if (json) {
      out(
        `${JSON.stringify({
          ok: false,
          error: 'not_found',
          message,
          install_id: identity.install_id,
          seq: options.seq,
        })}\n`,
      );
    } else {
      err(`agent permission replay: ${message}\n`);
    }
    return 1;
  }

  const activePolicy = loadActivePolicy(cwd, env);
  const activePolicyHash =
    activePolicy !== null ? `sha256:${canonicalHash(activePolicy)}` : '<unavailable>';
  const drift = activePolicy !== null && activePolicyHash !== row.policy_hash;

  const classifierImpact =
    options.withoutClassifier === true
      ? analyzeClassifierImpact(row, DEFAULT_SCORE_CONFIRM_THRESHOLD)
      : undefined;

  const result: ReplayResult = {
    row,
    drift,
    activePolicyHash,
    ...(classifierImpact !== undefined ? { classifierImpact } : {}),
  };
  if (json) renderJson(result, out);
  else renderText(result, out);
  return 0;
};
