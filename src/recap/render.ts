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

import { homedir } from 'node:os';
import { stripAnsi } from '../sanitize/ansi.ts';
import type { RecapIntermediate } from './types.ts';

export type RecapRenderer = 'human' | 'json';

export interface RenderOptions {
  // When true (default), absolute paths under `$HOME` are rewritten
  // to `~/...`. Disable for debugging or when consumed by tooling
  // that needs the literal path. Only applies to the human
  // renderer; json is always literal.
  anonymizePaths?: boolean;
  // Override `$HOME` for deterministic tests.
  home?: string;
}

const HOME_FALLBACK = '/home/__forja_test_home__';

const resolveHome = (override: string | undefined): string => {
  if (override !== undefined) return override;
  const env = homedir();
  return env.length > 0 ? env : HOME_FALLBACK;
};

const anonymize = (path: string, home: string): string => {
  if (path.length === 0) return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
};

// Regex-escape a literal string so it can be embedded in a
// RegExp without metachars firing. The home path commonly
// contains `.` (`/home/user.local`) and other escapable chars on
// non-Unix layouts; without escaping those would match
// arbitrarily and either over- or under-trigger the redaction.
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Redact `$HOME` paths embedded inside a free-text field (goal
// text, command lines, decision reasons, subagent summaries,
// open questions). The single-path `anonymize` helper above
// handles a string that IS a path; this helper handles strings
// that may CONTAIN a path. RECAP.md §6.2's privacy guarantee
// applies to every human-rendered surface, not just the
// dedicated path columns.
//
// Two passes:
//   1. `<home>/` → `~/`  — the common path-prefix case. Eats
//      the trailing `/` so "cat /home/lex/x" becomes "cat ~/x".
//   2. `<home>\b` → `~`  — bare home with no trailing slash
//      followed by a word boundary (end-of-string, whitespace,
//      non-word punctuation). "cd /home/lex" → "cd ~". The `\b`
//      check distinguishes the home prefix from a longer
//      identifier sharing the same prefix (`/home/lexicon`,
//      `/home/lexa.bak`) — those are NOT redacted because the
//      home segment is part of a different path.
//
// JSON renderer is intentionally NOT wired through this helper:
// audit consumers need the literal path. The human renderer is
// the only surface that runs anonymization.
const anonymizeText = (text: string, home: string): string => {
  if (text.length === 0 || home.length === 0) return text;
  const escaped = escapeRegex(home);
  return text
    .replace(new RegExp(`${escaped}/`, 'g'), '~/')
    .replace(new RegExp(`${escaped}\\b`, 'g'), '~');
};

const formatDuration = (ms: number): string => {
  if (ms < 0 || !Number.isFinite(ms)) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  }
  return `${hours}h${minutes.toString().padStart(2, '0')}m`;
};

const formatUsd = (usd: number): string => {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
};

const formatTokens = (n: number): string => {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
};

const formatPct = (ratio: number): string => {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${Math.round(ratio * 100)}%`;
};

// Short step id — first 7 chars of the UUID. Mirrors git's
// abbreviated-sha convention so operators reading the recap can
// pivot to the audit DB by prefix-match without copying a full
// UUID. Empty input ("" — a synthetic placeholder from projection
// when the source step is unknown) renders as `--` instead of an
// empty cell, which would silently swallow the column.
const shortStep = (id: string): string => (id.length === 0 ? '--' : id.slice(0, 7));

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
};

// Single-line normalization for command rendering. Multi-line bash
// commands (heredocs, $(<<EOF)) collapse onto one line with `; `
// separators so the markdown stays readable. ANSI escapes (rare,
// but possible if a tool result was mis-quoted upstream) are
// stripped at the renderer boundary; this is the same defense the
// TUI applies before drawing untrusted content.
const oneLine = (s: string): string =>
  stripAnsi(s)
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('; ');

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
  }
};
