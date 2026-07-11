// HumanRenderV1 + RecapIntermediate → markdown. The deterministic
// surface (cost, files edited, decisions, subagents, etc.) comes
// directly from the intermediate; only the `## Resumo` section
// is filled by `structured.summary` (LLM or deterministic
// projection).
//
// The output mirrors RECAP.md §4.1 verbatim with one addition: an
// "Incomplete" callout precedes the `**Goal:**` line whenever the
// projection flags a non-terminal session, threaded via
// `options.incomplete`. Sections with empty content are omitted to
// keep the rendered markdown tight ("0 files edited" is noise, not
// signal).

import { stripAnsi } from '../../sanitize/ansi.ts';
import {
  anonymize,
  anonymizeText,
  formatDuration,
  formatPct,
  formatTokens,
  formatUsd,
  oneLine,
  type RenderOptions,
  redactSecrets,
  resolveHome,
  shortStep,
  truncate,
} from '../format.ts';
import type { RecapIntermediate } from '../types.ts';
import type { HumanRenderV1 } from './schema.ts';

export const renderHumanFromStructured = (
  structured: HumanRenderV1,
  intermediate: RecapIntermediate,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const path = (p: string): string => (anon ? anonymize(p, home) : p);
  // Strip ANSI before anonymize / redact so escape sequences in
  // model-emitted prose or operator-pasted goal text never reach
  // the rendered surface. Same defense the TUI applies before
  // drawing untrusted content.
  const text = (s: string): string =>
    redactSecrets(anon ? anonymizeText(stripAnsi(s), home) : stripAnsi(s));

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

  // Incomplete callout — RECAP §10 anti-pattern guard. Threaded
  // via options so the caller can override / suppress; the slash
  // command always passes it when intermediate.completeness flags
  // the session as non-terminal.
  if (options.incomplete !== undefined) {
    const ids = options.incomplete.sessionIds.join(', ');
    lines.push(`> ⚠ Incomplete: ${redactSecrets(options.incomplete.reason)} (${ids})`);
    lines.push('');
  } else if (intermediate.completeness.incomplete) {
    // Backwards-compat path: when no explicit option is set but
    // the projection itself flagged incompleteness, render the
    // legacy callout shape (used by the eval runner before slice
    // (c-quick)). Slash always sends the option, so this branch
    // is reached only by direct callers of renderHumanFromStructured.
    const ids = intermediate.completeness.incompleteSessions.map(shortStep).join(', ');
    lines.push(`> ⚠ ${intermediate.completeness.incompleteReason}: ${ids}`);
    lines.push('');
  }

  // ## Resumo — the LLM-fillable section. Deterministic path
  // populates `structured.summary` from goal + counts + user
  // decisions; LLM path can rephrase under the schema cap. Always
  // present (RECAP §4.1).
  if (structured.summary.length > 0) {
    lines.push('## Resumo');
    lines.push('');
    for (const s of structured.summary) lines.push(`- ${text(s)}`);
    lines.push('');
  }

  // O que mudou — counts only in deterministic mode. Empty
  // sections are omitted entirely.
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

  // ## Issues — user-visible failures surfaced from failure_events
  // (RECAP §5). Both recovered and unrecovered are shown with an
  // explicit state tag; the human view is the full retrospective,
  // so a fatal failure that ended the session must not be hidden
  // here (changelog/pr curate to recovered-only for their
  // audiences). Omitted entirely when the session had none.
  if (intermediate.errors.length > 0) {
    lines.push('## Issues');
    lines.push('');
    for (const e of intermediate.errors) {
      const state = e.recovered ? 'recovered' : 'unrecovered';
      const detail = e.summary.length > 0 ? ` — ${text(oneLine(e.summary))}` : '';
      lines.push(`- \`${e.code}\` (${state})${detail}`);
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
  // line is informational; pinning its presence avoids consumers
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

  return `${lines.join('\n').trimEnd()}\n`;
};
