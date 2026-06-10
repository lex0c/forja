// Deterministic projection from RecapIntermediate → SlackRenderV1.
// Used by `--no-llm-render` and as the LLM-failure fallback.
//
// The Slack renderer is a "team-update" surface: brief, factual,
// surfacing what was done and what was decided. Achievements come
// from action counts; files are the literal write paths;
// decisions surface user-decided ones first (the most material to
// the team), then policy/hook denials.

import { formatDuration, formatUsd } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import { SLACK_LIMITS, SLACK_SCHEMA_VERSION, type SlackRenderV1 } from './schema.ts';

const buildTitle = (intermediate: RecapIntermediate): string => {
  if (intermediate.goal.text.length > 0) {
    const firstLine = intermediate.goal.text.split('\n')[0]?.trim() ?? '';
    if (firstLine.length > 0) return firstLine.slice(0, SLACK_LIMITS.titleMaxChars);
  }
  return 'Recap'.slice(0, SLACK_LIMITS.titleMaxChars);
};

const buildAchievements = (intermediate: RecapIntermediate): string[] => {
  const items: string[] = [];
  const a = intermediate.actions;
  if (a.filesWritten.length > 0) {
    items.push(`Edited ${a.filesWritten.length} file(s)`);
  }
  if (a.commandsRun.length > 0) {
    items.push(`Ran ${a.commandsRun.length} command(s)`);
  }
  if (intermediate.outcomes.testsRun.length > 0) {
    const passed = intermediate.outcomes.testsRun.filter((t) => t.passed).length;
    const total = intermediate.outcomes.testsRun.length;
    items.push(`Tests: ${passed}/${total} passing`);
  }
  if (a.subagentsSpawned.length > 0) {
    items.push(`Spawned ${a.subagentsSpawned.length} subagent(s)`);
  }
  if (intermediate.outcomes.checkpoints.length > 0) {
    items.push(`Created ${intermediate.outcomes.checkpoints.length} checkpoint(s)`);
  }
  // Unrecovered failures must surface before the "No actions"
  // sentinel — a team-update that hides a fatal failure behind
  // "No actions recorded" is actively misleading (RECAP §0.6).
  // Recovered failures stay omitted (the run continued); the human
  // surface carries the full list.
  const unrecovered = intermediate.errors.filter((e) => !e.recovered).length;
  if (unrecovered > 0) {
    items.push(`${unrecovered} unresolved error(s)`);
  }
  // Schema requires ≥ 1 achievement. Sentinel for read-only scopes
  // with no failures — never empty.
  if (items.length === 0) items.push('No actions recorded for this scope');
  return items
    .slice(0, SLACK_LIMITS.achievementsMaxItems)
    .map((s) => s.slice(0, SLACK_LIMITS.achievementsMaxChars));
};

const buildFiles = (intermediate: RecapIntermediate): string[] => {
  return intermediate.actions.filesWritten
    .slice(0, SLACK_LIMITS.filesMaxItems)
    .map((f) => f.path.slice(0, SLACK_LIMITS.filesMaxChars));
};

const buildDecisions = (intermediate: RecapIntermediate): string[] => {
  const ordered = [
    ...intermediate.decisions.filter((d) => d.decidedBy === 'user'),
    ...intermediate.decisions.filter((d) => d.decidedBy !== 'user'),
  ];
  const items: string[] = [];
  for (const decision of ordered) {
    if (items.length >= SLACK_LIMITS.decisionsMaxItems) break;
    if (decision.what.length === 0) continue;
    const why = decision.why.length > 0 ? `: ${decision.why}` : '';
    const prefix = decision.decidedBy === 'user' ? '' : `${decision.decidedBy} `;
    items.push(`${prefix}${decision.what}${why}`.slice(0, SLACK_LIMITS.decisionsMaxChars));
  }
  return items;
};

export const projectSlackDeterministic = (intermediate: RecapIntermediate): SlackRenderV1 => ({
  schemaVersion: SLACK_SCHEMA_VERSION,
  title: buildTitle(intermediate),
  durationLabel: formatDuration(intermediate.costs.durationMs).slice(
    0,
    SLACK_LIMITS.durationLabelMaxChars,
  ),
  costLabel: formatUsd(intermediate.costs.usd).slice(0, SLACK_LIMITS.costLabelMaxChars),
  achievements: buildAchievements(intermediate),
  files: buildFiles(intermediate),
  decisions: buildDecisions(intermediate),
});
