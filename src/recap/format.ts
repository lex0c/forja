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
// Patterns ordered most-specific first so a JWT does not get
// caught by the more permissive Bearer rule, etc.
interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  // When true, the pattern's first capturing group is preserved
  // (typically the env-var key) so the operator sees what was
  // redacted. When false, the entire match is replaced.
  readonly preserveKey: boolean;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Anthropic API keys: `sk-ant-...`. Length is open-ended in
  // practice (40+ alphanumerics with `_-`).
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, preserveKey: false },
  // OpenAI keys: `sk-...`, `sk-proj-...`. Negative lookahead
  // excludes Anthropic-shaped keys (handled above).
  { name: 'openai-key', pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g, preserveKey: false },
  // AWS access key IDs.
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, preserveKey: false },
  // GitHub fine-grained / PAT / OAuth / app tokens.
  {
    name: 'github-token',
    pattern: /\b(?:ghp|ghs|gho|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    preserveKey: false,
  },
  // Google API keys: `AIza` prefix + 35 chars of `[A-Za-z0-9_-]`
  // (per Google's published format). Length is fixed; bounding
  // with `\b` on the right is critical because the trailing chars
  // can include `-` and `_` which `\b` treats as word boundaries.
  // SECURITY_GUIDELINE §6.1 lists this as a required pattern.
  {
    name: 'google-api-key',
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    preserveKey: false,
  },
  // Slack tokens: bot (`xoxb-`), user (`xoxp-`), workspace
  // (`xoxa-`/`xoxr-`), Slack-Internal (`xoxs-`). Body is hyphen-
  // separated digit/alpha segments; the conservative shape
  // `[A-Za-z0-9-]{20,}` catches every variant without
  // over-matching neighboring text. SECURITY_GUIDELINE §6.1.
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    preserveKey: false,
  },
  // JWT shape: header.payload.signature, all base64url. Has to
  // come BEFORE the bearer rule — a JWT after `Bearer` would
  // otherwise get caught by the broader bearer pattern with a
  // less informative label.
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    preserveKey: false,
  },
  // `Bearer <token>` carrying anything that smells like a token.
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
    preserveKey: false,
  },
  // KEY=VALUE forms where the key name suggests a secret. Key
  // is preserved so the operator knows what was redacted; value
  // is replaced. Catches both `FOO_API_KEY=...` and inline
  // `--api-key foo123`. Quoted values supported.
  {
    name: 'env-secret',
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH_KEY|PRIVATE_KEY))\s*=\s*['"]?([A-Za-z0-9_./+=:-]{8,})['"]?/g,
    preserveKey: true,
  },
];

export const redactSecrets = (text: string): string => {
  if (text.length === 0) return text;
  let result = text;
  for (const { name, pattern, preserveKey } of SECRET_PATTERNS) {
    if (preserveKey) {
      result = result.replace(pattern, (_match, key) => `${key}=<redacted:${name}>`);
    } else {
      result = result.replace(pattern, `<redacted:${name}>`);
    }
  }
  return result;
};

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
