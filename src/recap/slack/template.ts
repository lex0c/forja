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

import { stripAnsi } from '../../sanitize/ansi.ts';
import {
  type RenderOptions,
  anonymize,
  anonymizeText,
  redactSecrets,
  resolveHome,
} from '../format.ts';
import type { SlackRenderV1 } from './schema.ts';

export const renderSlackFromStructured = (
  structured: SlackRenderV1,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const path = (p: string): string => (anon ? anonymize(p, home) : p);
  const text = (s: string): string =>
    redactSecrets(anon ? anonymizeText(stripAnsi(s), home) : stripAnsi(s));

  const lines: string[] = [];

  if (options.incomplete !== undefined) {
    // ASCII-only marker per the schema's ASCII contract (see
    // schema.ts). The `⚠` character used by the other renderers
    // would break the rule even though Slack would render it
    // fine — uniform with the bullet markers (`*`/`-`) the
    // template already keeps ASCII.
    const ids = options.incomplete.sessionIds.join(', ');
    lines.push(`> ! Incomplete: ${redactSecrets(options.incomplete.reason)} (${ids})`);
    lines.push('');
  }

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
