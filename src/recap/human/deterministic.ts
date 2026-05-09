// Deterministic projection from RecapIntermediate → HumanRenderV1.
// Used by `--no-llm-render`, the LLM-failure fallback, and any
// caller of `renderHumanDeterministic`. The deterministic Resumo
// is intentionally less polished than the LLM path's — it is
// `goal text + counts + most-material decisions`, which matches
// the operator's "what happened in this session" mental model
// without inventing prose.

import type { RecapIntermediate } from '../types.ts';
import { HUMAN_LIMITS, HUMAN_SCHEMA_VERSION, type HumanRenderV1 } from './schema.ts';

const buildSummary = (intermediate: RecapIntermediate): string[] => {
  const parts: string[] = [];
  if (intermediate.goal.text.length > 0) {
    const firstLine = intermediate.goal.text.split('\n')[0]?.trim() ?? '';
    if (firstLine.length > 0) parts.push(firstLine.slice(0, HUMAN_LIMITS.summaryMaxChars));
  }

  const counts: string[] = [];
  const a = intermediate.actions;
  if (a.filesWritten.length > 0) counts.push(`${a.filesWritten.length} files edited`);
  if (a.filesRead.length > 0) counts.push(`${a.filesRead.length} files read`);
  if (a.commandsRun.length > 0) counts.push(`${a.commandsRun.length} commands run`);
  if (a.subagentsSpawned.length > 0) {
    counts.push(`${a.subagentsSpawned.length} subagent(s) spawned`);
  }
  if (intermediate.outcomes.checkpoints.length > 0) {
    counts.push(`${intermediate.outcomes.checkpoints.length} checkpoint(s)`);
  }
  if (counts.length > 0) {
    parts.push(counts.join(', ').slice(0, HUMAN_LIMITS.summaryMaxChars));
  }

  // Surface user-decided decisions individually — they're the most
  // material thing for a reviewer to see at a glance.
  for (const decision of intermediate.decisions) {
    if (decision.decidedBy !== 'user') continue;
    const what = decision.what.length > 0 ? decision.what : 'decision';
    const line = decision.why.length > 0 ? `${what} — ${decision.why}` : what;
    parts.push(line.slice(0, HUMAN_LIMITS.summaryMaxChars));
    if (parts.length >= HUMAN_LIMITS.summaryMaxItems) break;
  }

  if (parts.length === 0) parts.push('No actions recorded for this scope');
  return parts.slice(0, HUMAN_LIMITS.summaryMaxItems);
};

export const projectHumanDeterministic = (intermediate: RecapIntermediate): HumanRenderV1 => ({
  schemaVersion: HUMAN_SCHEMA_VERSION,
  summary: buildSummary(intermediate),
});
