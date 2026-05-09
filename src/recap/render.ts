// Renderers for `RecapIntermediate`. M4.1 ships only the
// deterministic surface (RECAP.md §4.1 human + §4.5 json). The
// LLM-driven prose sections (§4.1 "Resumo", §4.2 PR description,
// §4.6 terse) land in M4.2 — slice (b) emits the structural
// markdown and json-cru that the LLM renderer will later wrap.
//
// Privacy guarantee from RECAP.md §6.2: paths under `$HOME` are
// rewritten to `~/...` before output. Applied at the renderer
// boundary (not the projection) so audit / json consumers still
// see the literal path on disk; only the human-facing markdown is
// anonymized.

import {
  type RenderOptions,
  anonymize,
  anonymizeText,
  formatDuration,
  formatPct,
  formatTokens,
  formatUsd,
  oneLine,
  resolveHome,
  shortStep,
  truncate,
} from './format.ts';
import { renderPrDeterministic } from './pr/index.ts';
import type { RecapIntermediate } from './types.ts';

export type { RenderOptions } from './format.ts';

export type RecapRenderer = 'human' | 'json' | 'pr';

export const renderJson = (intermediate: RecapIntermediate): string => {
  return JSON.stringify(intermediate, null, 2);
};

export const renderHuman = (
  intermediate: RecapIntermediate,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const path = (p: string): string => (anon ? anonymize(p, home) : p);
  // Free-text variant: redacts `$HOME` paths embedded anywhere
  // inside an arbitrary string. Used for every human-rendered
  // surface that carries operator-authored or model-emitted
  // prose (goal text, commands, decision reasons, summaries,
  // questions). Without this, the privacy guarantee only
  // covered the dedicated "Files edited" column and any other
  // surface that happened to mention an absolute path leaked.
  const text = (s: string): string => (anon ? anonymizeText(s, home) : s);

  const lines: string[] = [];

  const sessionLabel =
    intermediate.scope.kind === 'day'
      ? `day ${new Date(intermediate.scope.range.start).toISOString().slice(0, 10)}`
      : intermediate.scope.kind === 'range'
        ? `range (${intermediate.scope.sessionIds.length} sessions)`
        : (intermediate.scope.sessionIds[0] ?? 'unknown');

  const duration = formatDuration(intermediate.costs.durationMs);
  lines.push(`# Recap — ${sessionLabel} (${duration})`);
  lines.push('');

  if (intermediate.goal.text.length > 0) {
    lines.push(`**Goal:** ${text(oneLine(intermediate.goal.text))}`);
    lines.push('');
  }

  if (intermediate.completeness.incomplete) {
    const ids = intermediate.completeness.incompleteSessions.map(shortStep).join(', ');
    lines.push(`> ⚠ ${intermediate.completeness.incompleteReason}: ${ids}`);
    lines.push('');
  }

  // O que mudou — counts only in deterministic mode. Empty
  // sections are omitted entirely (no "0 files edited" noise).
  const changes: string[] = [];
  const a = intermediate.actions;
  if (a.filesRead.length > 0) {
    const totalReads = a.filesRead.reduce((acc, f) => acc + f.count, 0);
    changes.push(`${a.filesRead.length} files read (${totalReads} reads total)`);
  }
  if (a.filesWritten.length > 0) {
    changes.push(`${a.filesWritten.length} files edited`);
  }
  if (a.commandsRun.length > 0) {
    changes.push(`${a.commandsRun.length} commands run`);
  }
  if (a.subagentsSpawned.length > 0) {
    changes.push(`${a.subagentsSpawned.length} subagent(s) spawned`);
  }
  if (intermediate.outcomes.checkpoints.length > 0) {
    changes.push(`${intermediate.outcomes.checkpoints.length} checkpoint(s)`);
  }
  if (changes.length > 0) {
    lines.push('## What changed');
    lines.push('');
    for (const c of changes) lines.push(`- ${c}`);
    lines.push('');
  }

  if (a.filesWritten.length > 0) {
    lines.push('## Files edited');
    lines.push('');
    for (const f of a.filesWritten) lines.push(`- \`${path(f.path)}\``);
    lines.push('');
  }

  if (intermediate.outcomes.testsRun.length > 0) {
    lines.push('## Tests');
    lines.push('');
    for (const t of intermediate.outcomes.testsRun) {
      const status = t.passed ? '✓' : '✗';
      lines.push(
        `- ${status} \`${truncate(text(oneLine(t.command)), 80)}\` (${formatDuration(t.durationMs)})`,
      );
    }
    lines.push('');
  }

  if (intermediate.decisions.length > 0) {
    lines.push('## Decisions');
    lines.push('');
    for (const d of intermediate.decisions) {
      const why = d.why.length > 0 ? ` — ${text(d.why)}` : '';
      lines.push(`- step ${shortStep(d.stepId)}: ${text(d.what)} (${d.decidedBy})${why}`);
    }
    lines.push('');
  }

  if (intermediate.actions.subagentsSpawned.length > 0) {
    lines.push('## Subagents');
    lines.push('');
    for (const s of intermediate.actions.subagentsSpawned) {
      const summary =
        s.outputSummary.length > 0 ? ` — ${truncate(text(oneLine(s.outputSummary)), 100)}` : '';
      lines.push(`- ${shortStep(s.name)} (${s.status})${summary}`);
    }
    lines.push('');
  }

  if (intermediate.notDone.length > 0) {
    lines.push('## Not done');
    lines.push('');
    for (const nd of intermediate.notDone) {
      lines.push(`- ${text(nd.what)} — ${text(nd.reason)}`);
    }
    lines.push('');
  }

  if (intermediate.unresolvedQuestions.length > 0) {
    lines.push('## Open questions');
    lines.push('');
    for (const q of intermediate.unresolvedQuestions) {
      lines.push(`- ${text(oneLine(q))}`);
    }
    lines.push('');
  }

  if (intermediate.memoryProposed.length > 0) {
    lines.push('## Memory proposed');
    lines.push('');
    for (const m of intermediate.memoryProposed) {
      lines.push(`- \`${m.name}\` (${m.scope})`);
    }
    lines.push('');
  }

  // Cost section is always present (counts may be zero, but the
  // line is informational and pinning its presence avoids consumers
  // having to detect "did the renderer omit cost on accident").
  const c = intermediate.costs;
  const costParts = [
    formatUsd(c.usd),
    `${formatTokens(c.tokens.in)} in / ${formatTokens(c.tokens.out)} out`,
    `${formatPct(c.cacheHitRatio)} cached`,
  ];
  if (c.model.length > 0) costParts.push(c.model);
  lines.push('## Cost');
  lines.push('');
  lines.push(costParts.join(' · '));
  lines.push('');

  // Trailing newline is dropped — the join below preserves only
  // the explicit blank-line separators that mark section breaks.
  // Consumers writing to stdout get a clean EOF.
  return `${lines.join('\n').trimEnd()}\n`;
};

export const renderRecap = (
  intermediate: RecapIntermediate,
  renderer: RecapRenderer,
  options: RenderOptions = {},
): string => {
  switch (renderer) {
    case 'json':
      return renderJson(intermediate);
    case 'human':
      return renderHuman(intermediate, options);
    case 'pr':
      // Deterministic only — the LLM render path is wired through
      // the slash command (it needs the provider / cache / audit
      // context that this pure dispatcher does not see).
      return renderPrDeterministic(intermediate, options);
  }
};
