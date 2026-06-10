// `agent permission replay <seq>` — PERMISSION_ENGINE.md §17.
//
// Slice 12 shipped the minimum viable surface: read an approvals_log
// row by its sequence number, render every field, and flag policy
// drift when the row's `policy_hash` differs from the active hash.
// Subsequent slices grew the replay modes:
//   - slice 16: `--without-classifier` (hint-only impact analysis,
//     pure function of the row's score columns).
//   - slice 16: `--against-current-policy` (re-execute pipeline
//     against the active policy via approval_call_links → tool_calls
//     .input; drift diff).
//   - slice 96: `--against-archived-policy` (re-execute against the
//     ORIGINAL policy bytes via `policy_archive` keyed by
//     row.policy_hash; the canonical §17 reproducibility check).
//     Both rule-pipeline modes carry `caveats` listing engine
//     dimensions NOT replayed (classifier output, grants snapshot,
//     sandbox availability) so the "deterministic" verdict stays
//     honest.
//
// Out of scope (deferred to later slices):
//   - `agent permission diff <id1> <id2>`: cross-row comparison.
//   - Raw args: live in session SQLite (not in approvals_log); a
//     future slice persists them with a TTL. For now replay shows
//     `args_hash` only.
//   - Grants snapshot persistence on the audit row (R11 #35) — until
//     this lands, the grants caveat above remains.
//
// The CLI surface mirrors `agent permission verify` /
// `rotate-chain`: DB-only, no provider, no session start. Exit 0
// on a row found, 1 on bootstrap/DB/missing-row errors.

import { safeJsonParse } from '../broker/safe-json.ts';
import {
  DEFAULT_SCORE_CONFIRM_THRESHOLD,
  createNoopSink,
  createPermissionEngine,
  ensureInstallId,
} from '../permissions/index.ts';
import { type Policy, canonicalHash, resolvePolicy } from '../permissions/index.ts';

// Slice 128 (R4 P0-Inj-2): strip CC0+CC1 control characters from
// audit-row-derived strings before stdout interpolation. The
// renderer writes operator-rendered text (notes, rule patterns,
// capability scope strings) directly; a polluted row with
// `note: "\x1b]0;evil\x07"` would corrupt the operator's terminal
// title. Symmetric with welcome.ts and slice 127's pattern.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rule's purpose IS to match control chars
const REPLAY_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const stripControlChars = (s: string): string => s.replace(REPLAY_CONTROL_CHAR_RE, '');
import type { ApprovalPosture, ToolArgs } from '../permissions/index.ts';
import type { Decision, PolicyCategory } from '../permissions/types.ts';
import { type DB, MIGRATIONS, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import { getToolCallByApprovalSeq } from '../storage/repos/approval-call-links.ts';
import { type ApprovalLogRow, getApprovalsLogBySeq } from '../storage/repos/approvals-log.ts';
import { getPolicyArchive } from '../storage/repos/policy-archive.ts';
import { getSession } from '../storage/repos/sessions.ts';
import { getToolCall } from '../storage/repos/tool-calls.ts';
import { createToolRegistry, registerBuiltinTools } from '../tools/index.ts';

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
    components = safeJsonParse(row.score_components_json) as Record<string, number>;
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
  // §17 `--against-current-policy` mode. When true, replay re-runs
  // the engine pipeline against the ACTIVE policy using the row's
  // raw args (recovered via approval_call_links → tool_calls.input).
  // The replayed decision is rendered alongside the original; a diff
  // flags policy drift impact. When the prerequisites are missing
  // (link absent, tool_call garbage-collected by retention,
  // resolver returns refuse), the analysis surfaces "skipped" with
  // the operator-readable cause and the rest of the replay proceeds.
  againstCurrentPolicy?: boolean;
  // §17 `--against-archived-policy` mode (slice 96). The canonical
  // reproducibility test: re-runs the engine against the EXACT policy
  // bytes that produced the row, recovered from `policy_archive` by
  // `row.policy_hash`. When the archive contains the hash, the
  // replayed decision SHOULD match the row (modulo the same caveats
  // surfaced by `--against-current-policy`: classifier output, grants
  // snapshot, sandbox availability are not preserved). When the
  // archive doesn't contain the hash (pre-archive boot, archive
  // rotated out, install_id mismatch), the analysis returns
  // `skipped`.
  againstArchivedPolicy?: boolean;
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

// §17 `--against-current-policy` analysis. Re-executes the engine
// pipeline against a target policy using the row's recovered raw
// args. `verdict` distills the outcome into operationally meaningful
// shape; the four sub-objects below carry the inputs and the
// replayed decision so JSON consumers can build their own diff.
//
//   - `deterministic`     — replayed.kind matches row.decision; the
//                           active policy produces the same outcome.
//   - `changed_decision`  — replayed.kind differs from row.decision.
//                           The active policy would gate differently.
//   - `skipped`           — re-execution prereqs missing: link
//                           absent, tool_calls row GC'd, resolver
//                           refused on the recovered args, etc.
//                           The cause string names the missing piece.
type AgainstCurrentPolicyVerdict = 'deterministic' | 'changed_decision' | 'skipped';

interface AgainstCurrentPolicyAnalysis {
  verdict: AgainstCurrentPolicyVerdict;
  // Row's recorded decision kind, for parity with the replayed side.
  // Always populated; mirrors `row.decision`.
  original_decision: 'allow' | 'deny' | 'confirm';
  // Decision from re-executing against the active policy. Absent on
  // `skipped`; the `skipped_reason` describes why.
  replayed_decision?: 'allow' | 'deny' | 'confirm';
  replayed_reason?: string;
  // Free-form cause string for the `skipped` verdict. Operator-
  // facing. Empty on the other two verdicts.
  skipped_reason?: string;
  // Slice 96 — dimensions the replay engine does NOT model. The
  // "deterministic" verdict above means "the rule pipeline produced
  // the same decision" — NOT "the entire engine was byte-for-byte
  // reproduced". These caveats reset operator expectations:
  // matching here doesn't prove the engine would have done the
  // same thing if classifier / grants / sandbox had been replayed
  // verbatim. Surface in both text and JSON output so audit
  // consumers see the reproducibility bound.
  caveats: readonly string[];
}

// §17 `--against-archived-policy` analysis (slice 96). The canonical
// reproducibility test: re-runs the pipeline against the ORIGINAL
// policy bytes that produced the row. `policy_archive` is populated
// by every engine bootstrap (one row per distinct hash); the row's
// `policy_hash` keys the lookup. When present, the re-execution is
// the strongest reproducibility signal the replay can produce —
// modulo the same engine-dimension caveats `--against-current-policy`
// has (classifier output, grants snapshot, sandbox availability).
type AgainstArchivedPolicyVerdict = 'deterministic' | 'changed_decision' | 'skipped';

interface AgainstArchivedPolicyAnalysis {
  verdict: AgainstArchivedPolicyVerdict;
  original_decision: 'allow' | 'deny' | 'confirm';
  replayed_decision?: 'allow' | 'deny' | 'confirm';
  replayed_reason?: string;
  skipped_reason?: string;
  // The hash the replay looked up. Surfaced so JSON consumers can
  // correlate with `row.policy_hash` (they're equal by construction
  // — the lookup key IS the row's hash — but explicit is better
  // than asking the consumer to re-derive it).
  archived_policy_hash: string;
  // Same caveat list as the current-policy analysis. Even with a
  // perfect policy match, the replay engine doesn't model classifier
  // output / grants snapshot / sandbox availability.
  caveats: readonly string[];
}

// Slice 96 — caveats the replay engine ALWAYS carries. Both replay
// modes use `tryReExecute` which builds a disposable engine without
// classifier/grants/sandbox/telemetry/session_id — the rule pipeline
// is exercised but the side-channels that influence real decisions
// are not. Surfacing these inline keeps the operator-facing "✓
// deterministic" verdict honest: it means "the rule pipeline alone
// produced the same outcome", NOT "the engine would have done the
// same thing end-to-end".
//
// Adding a caveat (e.g. when a future slice persists grants_snapshot
// on the audit row and removes it from this list) is a contract
// change visible in JSON output; downstream tooling that filters
// on caveats should treat the list as monotonically shrinking.
const REPLAY_ENGINE_CAVEATS: readonly string[] = [
  'classifier output not replayed (re-execution runs the deterministic core only)',
  'grants snapshot not preserved on the audit row (row.ttl_expires_at indicates a grant match, but the full grant set at decision time is not recoverable)',
  'sandbox availability not preserved (replay engine omits the sandbox planner; row.sandbox_profile reflects the original plan)',
];

// Caveat appended ONLY when the row was autonomously auto-approved and
// the engine actually re-ran. The posture is reconstructed from the
// reason chain (not a persisted column), and the auto-approval
// eligibility re-check runs without the classifier adjust the live
// decision saw — so a row whose auto-approval hinged on that adjust may
// not reproduce. Surfacing it keeps a "deterministic" verdict on an
// autonomous row honest about HOW it reproduced.
const AUTONOMOUS_POSTURE_CAVEAT =
  'approval posture (autonomous) reconstructed from the reason chain, not a persisted column; the auto-approval eligibility re-check runs without the classifier adjust';

// Caveat appended ONLY when the row's tool is NOT in the builtin
// registry (an MCP or extension tool) and the engine re-ran anyway.
// tryReExecute resolves the PolicyCategory via the builtin registry;
// a non-builtin tool falls through to 'misc', whose default path is
// auto-allow. But the LIVE decision for an MCP tool ran its own
// manifest resolver (or the conservative confirm-forcing default,
// PERMISSION_ENGINE.md §5.3) AND carried the +0.10 supply-chain score
// weight (§6 risk table) — none of which the replay models. So a
// `changed_decision` verdict here may be an artifact of the wrong
// category rather than real policy drift, and a `deterministic`
// verdict is not trustworthy for these tools. Surfacing this keeps the
// verdict honest for exactly the surface an operator is most likely to
// audit. Parameterized by tool name (unlike the static caveats) so the
// operator sees which tool was mis-categorized.
//
// `tool_name` is strip-sanitized: it is an audit-row-derived string that
// lands in operator stdout via the text renderer (renderCaveats → out),
// and for the non-builtin case it originates from an MCP/extension
// manifest — the exact untrusted source slice 128 hardens against. The
// JSON path is already safe (JSON.stringify escapes control chars), but
// the text path is not, so we strip here at the interpolation site.
const nonBuiltinCategoryCaveat = (toolName: string): string =>
  `tool '${stripControlChars(toolName)}' is not in the builtin registry (MCP / extension tool); re-executed as category='misc' (default-allow). The live decision used the tool's own resolver (or the confirm-forcing MCP default) plus the +0.10 supply-chain score weight, none of which are modeled here — the verdict may not reflect the tool's real category`;

interface ReplayResult {
  row: ApprovalLogRow;
  drift: boolean;
  activePolicyHash: string;
  classifierImpact?: ClassifierImpactAnalysis;
  againstCurrentPolicy?: AgainstCurrentPolicyAnalysis;
  againstArchivedPolicy?: AgainstArchivedPolicyAnalysis;
}

// The approvals_log has no `approval_posture` column, but an autonomous
// auto-approval stamps an `approval-posture` stage into the row's
// reason chain (engine.ts). Recover the posture from that stage so
// re-execution reproduces the `allow` the operator's autonomous session
// produced; otherwise the disposable replay engine defaults to
// supervised, returns `confirm` for the same low-risk policy rule, and
// the replay falsely reports `changed_decision` with no policy drift.
const rowApprovalPosture = (row: ApprovalLogRow): ApprovalPosture => {
  let entries: unknown;
  try {
    entries = safeJsonParse(row.reason_chain_json);
  } catch {
    return 'supervised';
  }
  if (!Array.isArray(entries)) return 'supervised';
  return entries.some(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      (e as { stage?: unknown }).stage === 'approval-posture',
  )
    ? 'autonomous'
    : 'supervised';
};

// PERMISSION_ENGINE.md §17 re-execution helper. Pulls together the
// inputs the engine needs from sibling tables — tool_calls.input
// (raw args via approval_call_links), sessions.cwd (engine
// `cwd`), tool registry (PolicyCategory by toolName), and the
// caller-supplied target policy. Builds a DISPOSABLE engine with
// the noop sink so re-execution doesn't write a new audit row,
// runs check(), and returns the resulting Decision.
//
// Graceful skip when any prereq is missing — replay is a forensic
// tool, not a critical path; printing "skipped: <cause>" is more
// useful than aborting the whole replay surface.
const tryReExecute = (params: {
  row: ApprovalLogRow;
  policy: Policy;
  db: DB;
  cwd: string;
  home: string;
  // Recovered from the row's reason chain (rowApprovalPosture). An
  // autonomous posture re-runs the auto-approval, reproducing the
  // `allow` the live session produced for a low-risk policy confirm;
  // supervised (the default) would return `confirm` and fabricate drift.
  approvalPosture: ApprovalPosture;
}): { ok: true; decision: Decision; categoryFallback: boolean } | { ok: false; reason: string } => {
  const { row, policy, db, cwd, home, approvalPosture } = params;

  const toolCallId = getToolCallByApprovalSeq(db, row.seq);
  if (toolCallId === null) {
    return {
      ok: false,
      reason:
        'no tool_call linked to this seq (audit row predates slice 15, or the harness emit/link race surfaced)',
    };
  }
  const toolCall = getToolCall(db, toolCallId);
  if (toolCall === null) {
    return {
      ok: false,
      reason: `tool_call row ${toolCallId} missing (session retention may have GC'd it)`,
    };
  }

  // Resolve category via the builtin tool registry. MCP tools and
  // any extension tools registered at run-time aren't here — they
  // fall through to 'misc', which produces an engine.check() shape
  // that maps to the misc default-allow path. Documented as a
  // known caveat for replay against non-builtin tool surfaces.
  const registry = createToolRegistry();
  registerBuiltinTools(registry);
  const tool = registry.get(row.tool_name);
  // null ⇒ the tool isn't a builtin (MCP / extension). We still
  // re-execute (as 'misc'), but the caller surfaces a caveat because
  // the category — and the MCP resolver + supply-chain weight — diverge
  // from the live decision (see nonBuiltinCategoryCaveat).
  const categoryFallback = tool === null;
  const category: PolicyCategory = tool?.metadata.category ?? 'misc';

  const engine = createPermissionEngine(policy, {
    cwd,
    home,
    audit: createNoopSink(),
    approvalPosture,
  });
  try {
    const decision = engine.check(row.tool_name, category, toolCall.input as ToolArgs);
    return { ok: true, decision, categoryFallback };
  } catch (e) {
    return {
      ok: false,
      reason: `engine.check threw: ${(e as Error).message}`,
    };
  }
};

// Build the §17 against-current-policy analysis. Wrapper around
// `tryReExecute` that resolves the engine inputs from row + DB and
// converts the prereq-missing case into a `skipped` verdict.
const analyzeAgainstCurrentPolicy = (params: {
  row: ApprovalLogRow;
  activePolicy: Policy | null;
  db: DB;
  home: string;
}): AgainstCurrentPolicyAnalysis => {
  const original_decision = params.row.decision as 'allow' | 'deny' | 'confirm';
  if (params.activePolicy === null) {
    return {
      verdict: 'skipped',
      original_decision,
      skipped_reason: 'active policy unavailable (malformed YAML or missing dir)',
      caveats: REPLAY_ENGINE_CAVEATS,
    };
  }
  const session = getSession(params.db, params.row.session_id);
  if (session === null) {
    return {
      verdict: 'skipped',
      original_decision,
      skipped_reason: `session ${params.row.session_id} not found (retention may have GC'd it)`,
      caveats: REPLAY_ENGINE_CAVEATS,
    };
  }
  const posture = rowApprovalPosture(params.row);
  const result = tryReExecute({
    row: params.row,
    policy: params.activePolicy,
    db: params.db,
    cwd: session.cwd,
    home: params.home,
    approvalPosture: posture,
  });
  if (!result.ok) {
    return {
      verdict: 'skipped',
      original_decision,
      skipped_reason: result.reason,
      caveats: REPLAY_ENGINE_CAVEATS,
    };
  }
  // Built after re-execution so the non-builtin caveat can key off
  // result.categoryFallback. Order: base engine caveats, then the
  // conditional posture + category caveats.
  const ranCaveats = [
    ...REPLAY_ENGINE_CAVEATS,
    ...(posture === 'autonomous' ? [AUTONOMOUS_POSTURE_CAVEAT] : []),
    ...(result.categoryFallback ? [nonBuiltinCategoryCaveat(params.row.tool_name)] : []),
  ];
  const replayedKind = result.decision.kind;
  const replayedReason =
    result.decision.kind === 'confirm'
      ? `confirm: ${result.decision.prompt}`
      : (result.decision.reason ?? '');
  if (replayedKind === original_decision) {
    return {
      verdict: 'deterministic',
      original_decision,
      replayed_decision: replayedKind,
      replayed_reason: replayedReason,
      caveats: ranCaveats,
    };
  }
  return {
    verdict: 'changed_decision',
    original_decision,
    replayed_decision: replayedKind,
    replayed_reason: replayedReason,
    caveats: ranCaveats,
  };
};

// Slice 96 — §17 `--against-archived-policy` analysis. Recovers the
// EXACT policy bytes that produced the row via `policy_archive`
// (keyed by `row.policy_hash`), re-executes the engine against
// those bytes, and reports whether the original decision
// reproduces.
//
// Two skip cases distinguish failure modes for triage:
//   - Archive lookup MISSED — the install booted before slice 16
//     (policy_archive migration) or the row's policy was archived
//     and later GC'd. Operator can still replay against current
//     policy.
//   - Archive lookup HIT but `canonical_json` failed to parse —
//     storage corruption. Surfaces the row's stored bytes for
//     forensic inspection.
//
// The deterministic verdict here is the STRONGEST reproducibility
// signal the replay can produce — the rule pipeline against the
// original policy bytes. Modulo the caveats (classifier, grants,
// sandbox), this is the §17 canonical mode.
const analyzeAgainstArchivedPolicy = (params: {
  row: ApprovalLogRow;
  db: DB;
  home: string;
}): AgainstArchivedPolicyAnalysis => {
  const original_decision = params.row.decision as 'allow' | 'deny' | 'confirm';
  const archived_policy_hash = params.row.policy_hash;

  const archive = getPolicyArchive(params.db, params.row.policy_hash);
  if (archive === null) {
    return {
      verdict: 'skipped',
      original_decision,
      archived_policy_hash,
      skipped_reason: `policy hash ${params.row.policy_hash} not in policy_archive (boot predates slice 16, or the archive entry was GC'd)`,
      caveats: REPLAY_ENGINE_CAVEATS,
    };
  }

  let archivedPolicy: Policy;
  try {
    archivedPolicy = safeJsonParse(archive.canonical_json) as Policy;
  } catch (e) {
    return {
      verdict: 'skipped',
      original_decision,
      archived_policy_hash,
      skipped_reason: `archived canonical_json parse failed: ${(e as Error).message}`,
      caveats: REPLAY_ENGINE_CAVEATS,
    };
  }

  const session = getSession(params.db, params.row.session_id);
  if (session === null) {
    return {
      verdict: 'skipped',
      original_decision,
      archived_policy_hash,
      skipped_reason: `session ${params.row.session_id} not found (retention may have GC'd it)`,
      caveats: REPLAY_ENGINE_CAVEATS,
    };
  }

  const posture = rowApprovalPosture(params.row);
  const result = tryReExecute({
    row: params.row,
    policy: archivedPolicy,
    db: params.db,
    cwd: session.cwd,
    home: params.home,
    approvalPosture: posture,
  });
  if (!result.ok) {
    return {
      verdict: 'skipped',
      original_decision,
      archived_policy_hash,
      skipped_reason: result.reason,
      caveats: REPLAY_ENGINE_CAVEATS,
    };
  }
  // Built after re-execution so the non-builtin caveat can key off
  // result.categoryFallback (see analyzeAgainstCurrentPolicy).
  const ranCaveats = [
    ...REPLAY_ENGINE_CAVEATS,
    ...(posture === 'autonomous' ? [AUTONOMOUS_POSTURE_CAVEAT] : []),
    ...(result.categoryFallback ? [nonBuiltinCategoryCaveat(params.row.tool_name)] : []),
  ];
  const replayedKind = result.decision.kind;
  const replayedReason =
    result.decision.kind === 'confirm'
      ? `confirm: ${result.decision.prompt}`
      : (result.decision.reason ?? '');
  if (replayedKind === original_decision) {
    return {
      verdict: 'deterministic',
      original_decision,
      archived_policy_hash,
      replayed_decision: replayedKind,
      replayed_reason: replayedReason,
      caveats: ranCaveats,
    };
  }
  return {
    verdict: 'changed_decision',
    original_decision,
    archived_policy_hash,
    replayed_decision: replayedKind,
    replayed_reason: replayedReason,
    caveats: ranCaveats,
  };
};

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
    entries = safeJsonParse(json) as Entry[];
  } catch {
    return `  reason chain: <malformed JSON: ${json}>`;
  }
  if (!Array.isArray(entries) || entries.length === 0) return '  reason chain: (empty)';
  const lines: string[] = ['  reason chain:'];
  for (const e of entries) {
    // Slice 128 (R4 P0-Inj-2): strip CC0/CC1 from every field
    // interpolated into stdout. The audit row's reason_chain is
    // a JSON-derived structure; a polluted row with `note:
    // "\x1b]0;evil\x07"` would have corrupted the operator's
    // terminal title pre-slice. Same posture as welcome.ts
    // (slice 125) and audit-row-read paths.
    const fragments: string[] = [`stage=${stripControlChars(String(e.stage ?? ''))}`];
    if (e.layer !== undefined) fragments.push(`layer=${stripControlChars(String(e.layer))}`);
    if (e.rule !== undefined) fragments.push(`rule="${stripControlChars(String(e.rule))}"`);
    if (e.section !== undefined) fragments.push(`section=${stripControlChars(String(e.section))}`);
    if (e.note !== undefined) fragments.push(`note="${stripControlChars(String(e.note))}"`);
    lines.push(`    - ${fragments.join(' ')}`);
  }
  return lines.join('\n');
};

const renderScoreComponents = (json: string): string => {
  let components: Record<string, number>;
  try {
    components = safeJsonParse(json) as Record<string, number>;
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
    caps = safeJsonParse(json) as string[];
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
  // tool_name + tool_version are audit-row-derived strings printed
  // straight to operator stdout; for an MCP/extension row tool_name
  // comes from an untrusted manifest. Strip CC0/CC1 here (slice 128
  // posture) — otherwise a poisoned name corrupts the terminal before
  // the non-builtin caveat below even renders, making that caveat's own
  // sanitize moot. JSON output is already safe via JSON.stringify.
  out(
    `  tool:               ${stripControlChars(r.tool_name)} (version=${stripControlChars(r.tool_version)})\n`,
  );
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

  if (result.againstCurrentPolicy !== undefined) {
    const a = result.againstCurrentPolicy;
    out('\n');
    out('  Re-execution against ACTIVE policy (--against-current-policy):\n');
    out(`    original decision:         ${a.original_decision}\n`);
    if (a.verdict === 'skipped') {
      out(`    replayed decision:         skipped (${a.skipped_reason})\n`);
    } else {
      out(`    replayed decision:         ${a.replayed_decision ?? '<unknown>'}\n`);
      if (a.replayed_reason !== undefined && a.replayed_reason.length > 0) {
        out(`    replayed reason:           ${a.replayed_reason}\n`);
      }
    }
    let verdictLine: string;
    if (a.verdict === 'skipped') {
      verdictLine = 'verdict: re-execution skipped (see reason above)';
    } else if (a.verdict === 'deterministic') {
      verdictLine = 'verdict: ✓ deterministic — active policy would produce the same decision';
    } else {
      verdictLine = `verdict: ⚠ policy drift changed the decision (${a.original_decision} → ${a.replayed_decision})`;
    }
    out(`    ${verdictLine}\n`);
    renderCaveats(a.caveats, out);
  }

  if (result.againstArchivedPolicy !== undefined) {
    const a = result.againstArchivedPolicy;
    out('\n');
    out('  Re-execution against ARCHIVED policy (--against-archived-policy):\n');
    out(`    archived policy hash:      ${a.archived_policy_hash}\n`);
    out(`    original decision:         ${a.original_decision}\n`);
    if (a.verdict === 'skipped') {
      out(`    replayed decision:         skipped (${a.skipped_reason})\n`);
    } else {
      out(`    replayed decision:         ${a.replayed_decision ?? '<unknown>'}\n`);
      if (a.replayed_reason !== undefined && a.replayed_reason.length > 0) {
        out(`    replayed reason:           ${a.replayed_reason}\n`);
      }
    }
    let verdictLine: string;
    if (a.verdict === 'skipped') {
      verdictLine = 'verdict: re-execution skipped (see reason above)';
    } else if (a.verdict === 'deterministic') {
      verdictLine = 'verdict: ✓ deterministic — archived policy reproduces the original decision';
    } else {
      verdictLine = `verdict: ⚠ archived policy diverges from row (${a.original_decision} → ${a.replayed_decision}) — engine non-determinism, missing inputs, or storage corruption`;
    }
    out(`    ${verdictLine}\n`);
    renderCaveats(a.caveats, out);
  }
};

// Slice 96 — render the caveat list for replay analyses that actually
// ran the engine. Caveats are an inherent property of the replay
// engine's bounded scope (no classifier, no grants, no sandbox); they
// don't depend on the verdict. Skipped analyses still carry them so
// JSON consumers see a consistent shape; the text renderer keeps
// them BELOW the verdict line so the operator's eye lands on the
// outcome first.
const renderCaveats = (caveats: readonly string[], out: (s: string) => void): void => {
  if (caveats.length === 0) return;
  out('    caveats (engine dimensions NOT replayed):\n');
  for (const c of caveats) {
    out(`      - ${c}\n`);
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
      return safeJsonParse(r.reason_chain_json) as unknown;
    } catch {
      return r.reason_chain_json;
    }
  })();
  const scoreComponents = (() => {
    try {
      return safeJsonParse(r.score_components_json) as unknown;
    } catch {
      return r.score_components_json;
    }
  })();
  const capabilities = (() => {
    try {
      return safeJsonParse(r.capabilities_json) as unknown;
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
      ...(result.againstCurrentPolicy !== undefined
        ? { against_current_policy: result.againstCurrentPolicy }
        : {}),
      ...(result.againstArchivedPolicy !== undefined
        ? { against_archived_policy: result.againstArchivedPolicy }
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

  const againstCurrentPolicy =
    options.againstCurrentPolicy === true
      ? analyzeAgainstCurrentPolicy({
          row,
          activePolicy,
          db,
          home: env.HOME ?? cwd,
        })
      : undefined;

  // Slice 96 — §17 against-archived-policy mode. The canonical
  // reproducibility test: re-run the row against the EXACT bytes
  // recorded at decision time (via `policy_archive`). When the row
  // predates the archive (slice 16+) the lookup misses and the
  // analysis collapses to `skipped` with the missing-hash cause;
  // any downstream tooling can read the JSON `against_archived_policy
  // .verdict` to triage.
  const againstArchivedPolicy =
    options.againstArchivedPolicy === true
      ? analyzeAgainstArchivedPolicy({
          row,
          db,
          home: env.HOME ?? cwd,
        })
      : undefined;

  const result: ReplayResult = {
    row,
    drift,
    activePolicyHash,
    ...(classifierImpact !== undefined ? { classifierImpact } : {}),
    ...(againstCurrentPolicy !== undefined ? { againstCurrentPolicy } : {}),
    ...(againstArchivedPolicy !== undefined ? { againstArchivedPolicy } : {}),
  };
  if (json) renderJson(result, out);
  else renderText(result, out);
  return 0;
};
