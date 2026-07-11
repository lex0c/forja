// Auto-rehydrate text builder per STATE_MACHINE.md §7.6 +
// RECAP.md §3.2. Produces the literal `[resume_context] ...
// [/resume_context]` block the harness prepends to the operator's
// first user prompt after a `--resume`.
//
// Pure: takes a projected RecapIntermediate (already produced by
// `projectRecap` against the resumed session) plus session
// metadata, returns the block + diagnostic counts. No DB access,
// no LLM — the spec is explicit that resume's critical path
// cannot wait on Haiku and stays fully deterministic.
//
// Truncation policy (§7.6 truncation budget):
//   - Pins are NEVER truncated (always-include guarantee).
//   - Decisions are head+tail-truncated when exceeding the cap:
//     keep first 2 + last 2 with `... N decisions elided ...`
//     in the middle.
//   - notDone / todos: included as-is (today notDone is the only
//     source we have; todos sourcing is a separate subsystem).
//
// Token-budget approximation: `text.length / 4` — coarse but
// stable. Real tokenization differs per model but the cap is
// generous (2k tokens default ≈ 8k chars) and the projection's
// own bullet caps already keep individual lines small.

import type { SessionStatus } from '../storage/repos/sessions.ts';
import type { RecapDecision, RecapIntermediate, RecapNotDone } from './types.ts';

const DEFAULT_MAX_TOKENS = 2_000;
const APPROX_CHARS_PER_TOKEN = 4;
const DECISIONS_CAP_DEFAULT = 5;
// When over budget, we keep this many decisions at each end. Spec
// §7.6: "preserva primeiras 2 + últimas 2; meio elide com '...
// N decisions elided ...'".
const HEAD_KEPT = 2;
const TAIL_KEPT = 2;

export interface BuildResumeContextInput {
  // Projection over the resumed session. The function reads
  // `goal.text`, `decisions[]`, `notDone[]`, and `pinnedContext[]`
  // — every other field is ignored.
  intermediate: RecapIntermediate;
  // Status BEFORE the resume kicked in. Surfaces in the trailing
  // `previous status:` line so the operator can tell whether they
  // crashed mid-tool, hit the budget cap, or just `/clear`-ed
  // their way out.
  previousStatus: SessionStatus;
  // Wall-clock at resume time. Surfaces in the trailing
  // `Resumed at:` line as an ISO-8601 string.
  resumedAt: number;
  // Override the soft cap (default 2_000 tokens). Tests pin smaller
  // caps to exercise the truncation path without seeding 200
  // synthetic decisions.
  maxTokens?: number;
  // Optional human-readable description of what was lost across
  // the crash — e.g. "tool_exec mid-call", "compaction trigger
  // before finalize". When null, `unknown` is emitted; either
  // shape is honest.
  lossBound?: string | null;
}

export interface ResumeContextResult {
  text: string;
  decisionCount: number;
  pinCount: number;
  todoCount: number;
  // True when at least one bucket got head+tail-truncated to fit
  // the budget. The harness can surface this in the visibility
  // line so operators see "5 decisions, 3 truncated".
  truncated: boolean;
  // Degraded mode: the projection had no goal text AND no
  // decisions / pins / notDone. Falls back to a minimal block
  // with just `Resumed at:` + previous status. Indistinguishable
  // from a fresh-empty session in shape, but the visibility line
  // can flag it so an operator notices their crash buried the
  // recap entirely.
  degraded: boolean;
}

const formatIsoTimestamp = (ms: number): string => new Date(ms).toISOString();

const formatDecisionLine = (decision: RecapDecision): string => {
  const stepLabel = decision.stepId.length > 0 ? decision.stepId.slice(0, 7) : '--';
  const why = decision.why.length > 0 ? ` — ${decision.why}` : '';
  return `  - step ${stepLabel}: ${decision.what}${why} (decided_by: ${decision.decidedBy})`;
};

const formatNotDoneLine = (item: RecapNotDone): string => {
  const reason = item.reason.length > 0 ? ` (${item.reason})` : '';
  return `  - ${item.what}${reason}`;
};

// Head+tail truncation. Keeps the first HEAD_KEPT and last
// TAIL_KEPT entries and inserts a `... N elided ...` marker in
// between when the source list is longer than the sum.
const truncateMiddle = <T>(items: readonly T[], render: (item: T) => string): string[] => {
  if (items.length <= HEAD_KEPT + TAIL_KEPT) {
    return items.map(render);
  }
  const elided = items.length - HEAD_KEPT - TAIL_KEPT;
  return [
    ...items.slice(0, HEAD_KEPT).map(render),
    `  - ... ${elided} decisions elided ...`,
    ...items.slice(items.length - TAIL_KEPT).map(render),
  ];
};

export const buildResumeContext = (input: BuildResumeContextInput): ResumeContextResult => {
  const { intermediate, previousStatus, resumedAt } = input;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;

  // Take the most recent N decisions per spec §3.2 ("últimas 5").
  // The projection already orders chronologically; take the tail.
  const allDecisions = intermediate.decisions;
  const recentDecisions = allDecisions.slice(
    Math.max(0, allDecisions.length - DECISIONS_CAP_DEFAULT),
  );
  const decisionCount = recentDecisions.length;
  const pinCount = intermediate.pinnedContext.length;
  const todoCount = intermediate.notDone.length;

  // Degraded check: projection produced essentially nothing. We
  // still emit the trailing `Resumed at:` line so the operator sees
  // SOME signal — but the visibility flag tells them the rehydrate
  // had no payload.
  const degraded =
    intermediate.goal.text.length === 0 && decisionCount === 0 && pinCount === 0 && todoCount === 0;

  // First-pass build at full fidelity (5 decisions, no truncation).
  // Measure; if over budget, truncate decisions only — pins are
  // always-include per §7.6.
  const buildSection = (
    title: string,
    lines: readonly string[],
    fallback?: string,
  ): readonly string[] => {
    if (lines.length === 0) return fallback !== undefined ? [title, fallback] : [];
    return [title, ...lines];
  };

  const goalLine =
    intermediate.goal.text.length > 0
      ? `Goal (original task): ${intermediate.goal.text}`
      : 'Goal (original task): (none recorded)';

  let decisionLines = recentDecisions.map(formatDecisionLine);
  let truncated = false;

  // Tentative full assembly; we'll re-render with truncation if
  // over the cap.
  const buildBlock = (decisionsRendered: readonly string[]): string => {
    const sections: string[] = [];
    sections.push(goalLine);
    sections.push('');
    sections.push(
      ...buildSection('Decisions taken before crash:', decisionsRendered, '  - (none)'),
    );
    sections.push('');
    sections.push(
      ...buildSection(
        'Pinned context:',
        intermediate.pinnedContext.map((p) => {
          // `[kind]` is informational — same vocabulary the
          // /pin --list view uses, so the operator who pinned it
          // recognizes it immediately. The `(model)` suffix marks
          // pins the model created via the pin_context tool
          // (createdBy 'model'; 'model_proposed_user_approved' is
          // the legacy modal value, kept for old rows). On resume
          // the operator can then tell their own /pin entries
          // (createdBy 'user', no suffix) from constraints the
          // model pinned itself. Gate on `!== 'user'` so any
          // non-operator origin gets the marker.
          const suffix = p.createdBy !== 'user' ? ' (model)' : '';
          return `  - [${p.kind}] ${p.text}${suffix}`;
        }),
        '  - (none)',
      ),
    );
    sections.push('');
    sections.push(
      ...buildSection('Open todos:', intermediate.notDone.map(formatNotDoneLine), '  - (none)'),
    );
    sections.push('');
    sections.push(
      `Resumed at: ${formatIsoTimestamp(resumedAt)}; previous status: ${previousStatus}; loss_bound: ${input.lossBound ?? 'unknown'}.`,
    );
    return ['[resume_context]', ...sections, '[/resume_context]'].join('\n');
  };

  let block = buildBlock(decisionLines);

  // Over-budget? Truncate decisions head+tail. Pins are not
  // touched — they are always-include, and a session whose pins
  // alone exceed the budget is a user-side bug per §7.6.
  if (block.length > maxChars && recentDecisions.length > HEAD_KEPT + TAIL_KEPT) {
    decisionLines = truncateMiddle(recentDecisions, formatDecisionLine);
    truncated = true;
    block = buildBlock(decisionLines);
  }

  return {
    text: block,
    decisionCount,
    pinCount,
    todoCount,
    truncated,
    degraded,
  };
};

// Skip predicate per §7.6 "Quando NÃO injetar". Two of the three
// listed conditions are deterministic from session metadata; the
// third (`paused` with < 5 turns since last user prompt) is
// approximated by looking at the session status alone — a true
// `paused` status doesn't exist in the SessionStatus enum today,
// so this predicate only applies the first condition (terminal
// statuses) until the paused state lands.
export const shouldSkipResumeContext = (status: SessionStatus): boolean => {
  return status === 'done' || status === 'exhausted' || status === 'error';
};
