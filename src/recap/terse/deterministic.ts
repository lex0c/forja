// Deterministic projection from RecapIntermediate → TerseRenderV1.
// One-sentence summary: goal text (truncated) plus the most
// material counts plus duration / cost. Honest about empty
// sessions: "No actions recorded for this scope (Xs, $0.00)" is
// the sentinel.
//
// Building the sentence deterministically requires a small
// formatter: the structure is "<goal-prefix> — <count summary>.
// <duration>, <cost>." with each piece conditionally present.

import { formatDuration, formatUsd } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import { TERSE_LIMITS, TERSE_SCHEMA_VERSION, type TerseRenderV1 } from './schema.ts';

const buildSentence = (intermediate: RecapIntermediate): string => {
  const segments: string[] = [];

  if (intermediate.goal.text.length > 0) {
    const firstLine = intermediate.goal.text.split('\n')[0]?.trim() ?? '';
    if (firstLine.length > 0) segments.push(firstLine);
  }

  const counts: string[] = [];
  const a = intermediate.actions;
  if (a.filesWritten.length > 0) counts.push(`${a.filesWritten.length} files edited`);
  if (a.commandsRun.length > 0) counts.push(`${a.commandsRun.length} commands run`);
  if (intermediate.outcomes.testsRun.length > 0) {
    const passed = intermediate.outcomes.testsRun.filter((t) => t.passed).length;
    counts.push(`${passed}/${intermediate.outcomes.testsRun.length} tests passing`);
  }
  if (a.subagentsSpawned.length > 0) {
    counts.push(`${a.subagentsSpawned.length} subagent(s) spawned`);
  }

  let body: string;
  if (segments.length === 0 && counts.length === 0) {
    body = 'No actions recorded for this scope';
  } else if (counts.length === 0) {
    body = segments.join(' ');
  } else if (segments.length === 0) {
    body = counts.join(', ');
  } else {
    body = `${segments.join(' ')} — ${counts.join(', ')}`;
  }

  const meta = `${formatDuration(intermediate.costs.durationMs)}, ${formatUsd(intermediate.costs.usd)}`;
  const sentence = `${body}. ${meta}.`;
  return sentence.slice(0, TERSE_LIMITS.sentenceMaxChars);
};

export const projectTerseDeterministic = (intermediate: RecapIntermediate): TerseRenderV1 => ({
  schemaVersion: TERSE_SCHEMA_VERSION,
  sentence: buildSentence(intermediate),
});
