// TerseRenderV1 → markdown. Trivial: emits the sentence with a
// trailing newline. Anonymization runs on embedded paths (rare
// in a single sentence but possible).

import { stripAnsi } from '../../sanitize/ansi.ts';
import { anonymizeText, type RenderOptions, redactSecrets, resolveHome } from '../format.ts';
import type { TerseRenderV1 } from './schema.ts';

export const renderTerseFromStructured = (
  structured: TerseRenderV1,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const cleaned = stripAnsi(structured.sentence);
  const sentence = redactSecrets(anon ? anonymizeText(cleaned, home) : cleaned);
  // Incomplete callout precedes the sentence so the operator
  // sees it on a status-line render. Keeps the renderer's
  // "footer / commit body" affordance — the caller chooses
  // whether to include incomplete by passing the option.
  if (options.incomplete !== undefined) {
    const ids = options.incomplete.sessionIds.join(', ');
    return `> ⚠ Incomplete: ${redactSecrets(options.incomplete.reason)} (${ids})\n${sentence}\n`;
  }
  return `${sentence}\n`;
};
