// Shared formatters and path-anonymization helpers used by every
// recap renderer (human, pr, changelog, slack, terse). Pulled out
// of `render.ts` when the `pr` renderer (M4.2 slice a) needed the
// same `$HOME` redaction and command-normalization logic but did
// not want to depend on the human-renderer module.
//
// Privacy guarantee from RECAP.md §6.2 lives here: any text that
// goes to a human surface (markdown, terminal) runs through
// `anonymizeText` so embedded `$HOME/...` paths get rewritten to
// `~/...`. The JSON renderer is the deliberate exception — audit
// consumers need the literal path.

import { homedir } from 'node:os';
import { stripAnsi } from '../sanitize/ansi.ts';
import { redactSecrets } from '../sanitize/secrets.ts';
import type { RecapIntermediate } from './types.ts';

// Common options for every renderer that emits human-facing text
// (human, pr, changelog, slack, terse). The JSON renderer applies
// `anonymizePaths` and `redactSecrets` selectively to free-text
// fields via `redactSecretsInIntermediate` rather than at the
// template boundary.
export interface RenderOptions {
  // When true (default), absolute paths under `$HOME` are rewritten
  // to `~/...`. Disable for debugging or when consumed by tooling
  // that needs the literal path.
  anonymizePaths?: boolean;
  // Override `$HOME` for deterministic tests.
  home?: string;
  // When set, the renderer prepends an "incomplete session" callout
  // before the regular content. RECAP.md §10 anti-pattern: a recap
  // over a non-terminal session must surface the partial-data
  // status visibly so the operator does not act on it as if it
  // were the final word. The slash command threads the value here
  // from `intermediate.completeness` whenever `incomplete === true`.
  incomplete?: { reason: string; sessionIds: readonly string[] };
}

const HOME_FALLBACK = '/home/__forja_test_home__';

export const resolveHome = (override: string | undefined): string => {
  if (override !== undefined) return override;
  const env = homedir();
  return env.length > 0 ? env : HOME_FALLBACK;
};

// Separator that follows the home prefix in a real path: POSIX
// `/` or Windows `\`. Forja claims Windows support, so the home
// redactor must accept both. Without this, an operator running
// on Windows with `home = 'C:\\Users\\alice'` saw their full
// home path emitted verbatim in every recap.
const isPathSeparator = (ch: string | undefined): boolean => ch === '/' || ch === '\\';

export const anonymize = (path: string, home: string): string => {
  if (path.length === 0) return path;
  if (path === home) return '~';
  if (path.startsWith(home) && isPathSeparator(path[home.length])) {
    return `~${path.slice(home.length)}`;
  }
  return path;
};

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SEP_REGEX_CLASS = '[/\\\\]';

// Negative lookahead listing chars that COULD continue an
// identifier-shaped token after the home prefix. Word chars plus
// `-` and `.` — the two non-word chars that show up most commonly
// inside usernames and filenames. Without `-` and `.` here, a
// `\b` shape rewrote `/home/alice-backup/log.txt` to
// `~-backup/log.txt`. Other shell-meaningful chars (whitespace,
// quotes, separators) ARE allowed to trigger redaction — they
// mark the end of the path token.
const IDENTIFIER_CONTINUATION = '[A-Za-z0-9_\\-.]';

export const anonymizeText = (text: string, home: string): string => {
  if (text.length === 0 || home.length === 0) return text;
  const escaped = escapeRegex(home);
  return text
    .replace(new RegExp(`${escaped}(${SEP_REGEX_CLASS})`, 'g'), '~$1')
    .replace(new RegExp(`${escaped}(?!${IDENTIFIER_CONTINUATION})`, 'g'), '~');
};

export const formatDuration = (ms: number): string => {
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

export const formatUsd = (usd: number): string => {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
};

export const formatTokens = (n: number): string => {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
};

export const formatPct = (ratio: number): string => {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${Math.round(ratio * 100)}%`;
};

// Short step id — first 7 chars of the UUID. Mirrors git's
// abbreviated-sha convention so operators reading the recap can
// pivot to the audit DB by prefix-match without copying a full
// UUID. Empty input ("" — a synthetic placeholder from projection
// when the source step is unknown) renders as `--`.
export const shortStep = (id: string): string => (id.length === 0 ? '--' : id.slice(0, 7));

export const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
};

// Single-line normalization for command rendering. Multi-line bash
// commands collapse onto one line with `; ` separators. ANSI
// escapes are stripped at the renderer boundary; same defense the
// TUI applies before drawing untrusted content.
export const oneLine = (s: string): string =>
  stripAnsi(s)
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('; ');

// RECAP.md §6.2 — heuristic redaction of secret-shaped tokens.
// Operating on the rendered text (commands, decision reasons,
// summaries, etc.) catches the common leak vectors:
//   - API keys pasted into bash commands or env exports
//   - Bearer tokens in command lines
//   - KEY=value pairs where the key name suggests sensitivity
//
// The patterns are intentionally narrow — false positives in a
// recap (which an operator reads for review) are visible noise,
// while false negatives leak secrets into PR descriptions and
// Slack posts. Each pattern carries a label so the redacted output
// names what was hidden, e.g. `<redacted:anthropic-key>`. This is a
// best-effort defense, not a substitute for not-pasting-secrets;
// the spec acknowledges this as heuristic.
//
// Slice 177 (review — P1). The pattern table + `redactSecrets`
// function moved to `src/sanitize/secrets.ts` so the permissions
// engine can use the same redactor for operator-visible prompts
// without a `permissions → recap` layering reversal. Re-export
// here so existing recap consumers keep working unchanged.
export { redactSecrets } from '../sanitize/secrets.ts';

// Selective redaction over a `RecapIntermediate`. The JSON
// renderer needs the same §6.2 privacy guarantee as the markdown
// renderers, but a blanket deep-traversal would corrupt
// structured fields (paths that happen to look like
// `sk-anything-with-dashes` would be falsely matched if not
// guarded). This helper visits only the well-known free-text
// fields where leaked secrets actually land — commands, decision
// reasons, summaries, prompts — and leaves IDs, paths, numbers,
// and enum-shaped strings alone.
//
// Returns a structurally-equal copy with the same keys and a
// `(...)' shape; the input intermediate is not mutated. This is
// the "pure" boundary: every renderer downstream of this point
// can assume free-text fields are already redacted, so they can
// focus on layout.
export const redactSecretsInIntermediate = (
  intermediate: RecapIntermediate,
): RecapIntermediate => ({
  ...intermediate,
  goal: { ...intermediate.goal, text: redactSecrets(intermediate.goal.text) },
  completeness: {
    ...intermediate.completeness,
    incompleteReason: redactSecrets(intermediate.completeness.incompleteReason),
  },
  decisions: intermediate.decisions.map((d) => ({
    ...d,
    what: redactSecrets(d.what),
    why: redactSecrets(d.why),
  })),
  actions: {
    ...intermediate.actions,
    filesWritten: intermediate.actions.filesWritten.map((f) => ({
      ...f,
      semanticSummary: redactSecrets(f.semanticSummary),
    })),
    commandsRun: intermediate.actions.commandsRun.map((c) => ({
      ...c,
      command: redactSecrets(c.command),
    })),
    subagentsSpawned: intermediate.actions.subagentsSpawned.map((s) => ({
      ...s,
      outputSummary: redactSecrets(s.outputSummary),
    })),
  },
  outcomes: {
    ...intermediate.outcomes,
    testsRun: intermediate.outcomes.testsRun.map((t) => ({
      ...t,
      command: redactSecrets(t.command),
    })),
  },
  timeline: intermediate.timeline.map((t) => ({ ...t, detail: redactSecrets(t.detail) })),
  errors: intermediate.errors.map((e) => ({ ...e, summary: redactSecrets(e.summary) })),
  notDone: intermediate.notDone.map((n) => ({
    ...n,
    what: redactSecrets(n.what),
    reason: redactSecrets(n.reason),
  })),
  unresolvedQuestions: intermediate.unresolvedQuestions.map((q) => redactSecrets(q)),
});
