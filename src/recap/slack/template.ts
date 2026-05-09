// SlackRenderV1 → markdown. ASCII-only by design (see schema.ts
// comment): `*` for achievement bullets and `-` for sub-lists,
// no `✓` / `•`. Slack renders both forms cleanly; staying ASCII
// keeps the renderer's anti-decoration rule consistent across
// model output and template output.
//
// Output shape:
//   *<title>* (<duration>, <cost>)
//
//   * <achievement>
//   * ...
//
//   Files: `<file>`, `<file>`, ...
//
//   Decisions:
//   - <decision>
//   - ...
//
// Empty `files` / `decisions` arrays omit their respective blocks.

import { type RenderOptions, anonymize, anonymizeText, resolveHome } from '../format.ts';
import type { SlackRenderV1 } from './schema.ts';

export const renderSlackFromStructured = (
  structured: SlackRenderV1,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const path = (p: string): string => (anon ? anonymize(p, home) : p);
  const text = (s: string): string => (anon ? anonymizeText(s, home) : s);

  const lines: string[] = [];

  lines.push(`*${text(structured.title)}* (${structured.durationLabel}, ${structured.costLabel})`);
  lines.push('');

  for (const achievement of structured.achievements) lines.push(`* ${text(achievement)}`);

  if (structured.files.length > 0) {
    lines.push('');
    const list = structured.files.map((f) => `\`${path(f)}\``).join(', ');
    lines.push(`Files: ${list}`);
  }

  if (structured.decisions.length > 0) {
    lines.push('');
    lines.push('Decisions:');
    for (const decision of structured.decisions) lines.push(`- ${text(decision)}`);
  }

  return `${lines.join('\n').trimEnd()}\n`;
};
