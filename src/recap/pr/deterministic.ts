// Deterministic projection from RecapIntermediate → PrRenderV1.
// No LLM, no prose generation — every field is built mechanically
// from the intermediate. Output is golden-testable byte-for-byte.
//
// This module exists because:
//   1. `--no-llm-render` always uses it (operator opt-out).
//   2. The LLM render path falls back to it on any failure
//      (provider down, schema violation, fidelity mismatch). The
//      operator must always get a recap; what they trade for the
//      LLM call is prose density, not availability.
//   3. The 5 goldens in `evals/recap/golden/0{1..5}.pr.md` pin
//      this output, so a regression here breaks CI.
//
// The output is "honest but dense": it surfaces every action /
// decision / outcome but never invents prose. Where the LLM would
// generate a one-line summary of a file change, this module
// emits "+47 / -12 lines" and (if non-empty) the projection's
// pre-recorded `semanticSummary` (which is only set today by
// approval reason fallthrough; see RECAP.md §5).

import type { RecapIntermediate } from '../types.ts';
import { PR_SCHEMA_VERSION, type PrRenderV1, type PrTestPlanItem } from './schema.ts';

const buildSummary = (intermediate: RecapIntermediate): string[] => {
  const parts: string[] = [];
  if (intermediate.goal.text.length > 0) {
    // First-line of goal text, capped to the schema's char limit.
    const firstLine = intermediate.goal.text.split('\n')[0]?.trim() ?? '';
    if (firstLine.length > 0) parts.push(firstLine.slice(0, 140));
  }
  const a = intermediate.actions;
  const counts: string[] = [];
  if (a.filesWritten.length > 0) counts.push(`${a.filesWritten.length} files edited`);
  if (a.filesRead.length > 0) counts.push(`${a.filesRead.length} files read`);
  if (a.commandsRun.length > 0) counts.push(`${a.commandsRun.length} commands run`);
  if (a.subagentsSpawned.length > 0) {
    counts.push(`${a.subagentsSpawned.length} subagent(s) spawned`);
  }
  if (intermediate.outcomes.checkpoints.length > 0) {
    counts.push(`${intermediate.outcomes.checkpoints.length} checkpoint(s)`);
  }
  if (counts.length > 0) parts.push(counts.join(', ').slice(0, 140));
  // Surface user-decided decisions individually — they're the
  // most material thing for a reviewer.
  for (const decision of intermediate.decisions) {
    if (decision.decidedBy !== 'user') continue;
    const what = decision.what.length > 0 ? decision.what : 'decision';
    const line = decision.why.length > 0 ? `${what} (${decision.why})` : what;
    parts.push(line.slice(0, 140));
    if (parts.length >= 5) break;
  }
  if (parts.length === 0) parts.push('No changes recorded for this scope');
  return parts.slice(0, 5);
};

const buildChange = (path: string, linesAdded: number, linesRemoved: number, summary: string) => {
  const bullets: string[] = [];
  if (linesAdded > 0 || linesRemoved > 0) {
    bullets.push(`+${linesAdded} / -${linesRemoved} lines`);
  } else {
    bullets.push('edited (line counts unavailable)');
  }
  if (summary.length > 0) bullets.push(summary.slice(0, 120));
  return { path, bullets };
};

const buildTestPlan = (intermediate: RecapIntermediate): PrTestPlanItem[] => {
  const items: PrTestPlanItem[] = [];
  for (const test of intermediate.outcomes.testsRun) {
    const line = test.command.split('\n')[0]?.trim() ?? '';
    if (line.length === 0) continue;
    items.push({
      item: line.slice(0, 100),
      status: test.passed ? 'done' : 'todo',
    });
  }
  // notDone[] entries surface as 'manual' items so a reviewer knows
  // the agent intentionally left work unverified.
  for (const nd of intermediate.notDone) {
    if (nd.what.length === 0) continue;
    items.push({ item: nd.what.slice(0, 100), status: 'manual' });
  }
  return items;
};

const buildNotes = (intermediate: RecapIntermediate): string[] => {
  const notes: string[] = [];
  // Carry over decisions whose decided_by is hook or policy — those
  // are constraints the reviewer should know were enforced.
  for (const d of intermediate.decisions) {
    if (d.decidedBy === 'user') continue;
    const why = d.why.length > 0 ? `: ${d.why}` : '';
    notes.push(`${d.decidedBy} ${d.what}${why}`.slice(0, 140));
    if (notes.length >= 3) return notes;
  }
  // Then unresolved questions. Truncated so the schema cap holds.
  for (const q of intermediate.unresolvedQuestions) {
    notes.push(`open question: ${q}`.slice(0, 140));
    if (notes.length >= 3) return notes;
  }
  // Finally errors that were recovered — surface so reviewer
  // knows there was turbulence even if it healed.
  for (const e of intermediate.errors) {
    if (!e.recovered) continue;
    notes.push(`recovered: ${e.code} — ${e.summary}`.slice(0, 140));
    if (notes.length >= 3) return notes;
  }
  return notes;
};

export const projectPrDeterministic = (intermediate: RecapIntermediate): PrRenderV1 => ({
  schemaVersion: PR_SCHEMA_VERSION,
  summary: buildSummary(intermediate),
  changes: intermediate.actions.filesWritten.map((f) =>
    buildChange(f.path, f.linesAdded, f.linesRemoved, f.semanticSummary),
  ),
  testPlan: buildTestPlan(intermediate),
  notes: buildNotes(intermediate),
});
