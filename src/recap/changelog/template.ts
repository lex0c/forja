// ChangelogRenderV1 → markdown. Output follows Keep a Changelog
// (https://keepachangelog.com/) section ordering: categories
// appear in the canonical Added → Changed → Fixed → Removed →
// Deprecated → Security order, and an empty category is omitted.
// Within a category, entries preserve the order the projection /
// LLM emitted them in.

import { stripAnsi } from '../../sanitize/ansi.ts';
import { type RenderOptions, anonymizeText, redactSecrets, resolveHome } from '../format.ts';
import {
  CHANGELOG_CATEGORIES,
  type ChangelogCategory,
  type ChangelogEntry,
  type ChangelogRenderV1,
} from './schema.ts';

const groupByCategory = (
  entries: readonly ChangelogEntry[],
): Map<ChangelogCategory, ChangelogEntry[]> => {
  const map = new Map<ChangelogCategory, ChangelogEntry[]>();
  for (const entry of entries) {
    const bucket = map.get(entry.category) ?? [];
    bucket.push(entry);
    map.set(entry.category, bucket);
  }
  return map;
};

export const renderChangelogFromStructured = (
  structured: ChangelogRenderV1,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const text = (s: string): string =>
    redactSecrets(anon ? anonymizeText(stripAnsi(s), home) : stripAnsi(s));

  const grouped = groupByCategory(structured.entries);
  const lines: string[] = [];

  if (options.incomplete !== undefined) {
    const ids = options.incomplete.sessionIds.join(', ');
    lines.push(`> ⚠ Incomplete: ${redactSecrets(options.incomplete.reason)} (${ids})`);
    lines.push('');
  }

  for (const category of CHANGELOG_CATEGORIES) {
    const bucket = grouped.get(category);
    if (bucket === undefined || bucket.length === 0) continue;
    lines.push(`### ${category}`);
    lines.push('');
    for (const entry of bucket) lines.push(`- ${text(entry.bullet)}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
};
