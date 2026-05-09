// TerseRenderV1 → markdown. Trivial: emits the sentence with a
// trailing newline. Anonymization runs on embedded paths (rare
// in a single sentence but possible).

import { type RenderOptions, anonymizeText, resolveHome } from '../format.ts';
import type { TerseRenderV1 } from './schema.ts';

export const renderTerseFromStructured = (
  structured: TerseRenderV1,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const text = anon ? anonymizeText(structured.sentence, home) : structured.sentence;
  return `${text}\n`;
};
