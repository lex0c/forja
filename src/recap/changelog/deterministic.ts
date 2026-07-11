// Deterministic projection from RecapIntermediate → ChangelogRenderV1.
// Used by `--no-llm-render` and as the LLM-failure fallback.
//
// The projection is conservative: it surfaces categories that are
// mechanically derivable from the audit log and refuses to invent
// the others.
//
// Mapping rules:
//   - filesWritten → 'Changed'    (an edit is the most common case)
//   - filesWritten with linesAdded > 0 AND linesRemoved == 0:
//                  → 'Added'      (pure-add file is a new feature)
//   - filesWritten with linesAdded == 0 AND linesRemoved > 0:
//                  → 'Removed'    (pure-delete is a removal)
//   - decisions decidedBy='hook'/'policy' → 'Security' iff the
//     decision text suggests a security gate (heuristic on common
//     keywords); otherwise 'Changed'
//   - errors with recovered=true → 'Fixed' (a recovered error is
//     work that landed because something needed fixing)
//
// 'Deprecated' is never emitted deterministically — operators
// only deprecate intentionally and rarely write enough metadata
// for the projection to detect it. The LLM render path can fill
// this in when reading decisions or notDone with the relevant
// signals.

import type { RecapFileWrite, RecapIntermediate } from '../types.ts';
import {
  CHANGELOG_LIMITS,
  CHANGELOG_SCHEMA_VERSION,
  type ChangelogCategory,
  type ChangelogEntry,
  type ChangelogRenderV1,
} from './schema.ts';

// Heuristic: the projection cannot read code or recall context;
// it leans on keyword matches over the decision's text to guess
// whether a hook/policy denial was security-relevant. The
// signal often lives in `why` (the policy / hook reason)
// rather than `what` (the action label) — e.g.
// `{what:'block bash', why:'attempts to read secret env var'}`
// — so both fields are matched. Keyword set is intentionally
// narrow — false positives are worse than false negatives here
// (a user does NOT want every hook denial labeled "Security"
// in the changelog).
const SECURITY_KEYWORDS = ['secret', 'token', 'credential', 'key', 'password', 'auth'];

const looksSecurityRelevant = (what: string, why: string): boolean => {
  const lower = `${what} ${why}`.toLowerCase();
  return SECURITY_KEYWORDS.some((kw) => lower.includes(kw));
};

const fileBasename = (path: string): string => {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
};

const fileChangeBullet = (file: RecapFileWrite): string => {
  if (file.semanticSummary.length > 0) return file.semanticSummary;
  const base = fileBasename(file.path);
  if (file.linesAdded > 0 && file.linesRemoved === 0) return `Add ${base}`;
  if (file.linesRemoved > 0 && file.linesAdded === 0) return `Remove ${base}`;
  return `Update ${base} (+${file.linesAdded} / -${file.linesRemoved})`;
};

const fileCategory = (file: RecapFileWrite): ChangelogCategory => {
  if (file.linesAdded > 0 && file.linesRemoved === 0) return 'Added';
  if (file.linesRemoved > 0 && file.linesAdded === 0) return 'Removed';
  return 'Changed';
};

export const projectChangelogDeterministic = (
  intermediate: RecapIntermediate,
): ChangelogRenderV1 => {
  const entries: ChangelogEntry[] = [];

  for (const file of intermediate.actions.filesWritten) {
    if (entries.length >= CHANGELOG_LIMITS.entriesMaxItems) break;
    entries.push({
      category: fileCategory(file),
      bullet: fileChangeBullet(file).slice(0, CHANGELOG_LIMITS.bulletMaxChars),
    });
  }

  for (const decision of intermediate.decisions) {
    if (entries.length >= CHANGELOG_LIMITS.entriesMaxItems) break;
    if (decision.decidedBy === 'user') continue;
    const why = decision.why.length > 0 ? `: ${decision.why}` : '';
    const bullet = `${decision.what}${why}`.slice(0, CHANGELOG_LIMITS.bulletMaxChars);
    if (bullet.length === 0) continue;
    entries.push({
      category: looksSecurityRelevant(decision.what, decision.why) ? 'Security' : 'Changed',
      bullet,
    });
  }

  for (const error of intermediate.errors) {
    if (entries.length >= CHANGELOG_LIMITS.entriesMaxItems) break;
    if (!error.recovered) continue;
    const summary = error.summary.length > 0 ? error.summary : error.code;
    if (summary.length === 0) continue;
    entries.push({
      category: 'Fixed',
      bullet: summary.slice(0, CHANGELOG_LIMITS.bulletMaxChars),
    });
  }

  if (entries.length === 0) {
    // Sentinel: schema requires ≥1 entry. Honest representation
    // of "this scope produced no changelog-worthy change" — the
    // operator sees the explicit message instead of a silently
    // empty changelog (which a downstream tool might publish).
    entries.push({
      category: 'Changed',
      bullet: 'No user-impacting changes recorded for this scope',
    });
  }

  return { schemaVersion: CHANGELOG_SCHEMA_VERSION, entries };
};
