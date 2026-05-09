// PrRenderV1 → markdown. Pure, deterministic, no LLM. Used by:
//   - The deterministic renderer (deterministic.ts) for the
//     `--no-llm-render` path and the LLM-fallback path.
//   - The LLM renderer (llm.ts) once the model returns a validated
//     PrRenderV1.
//
// Output shape (RECAP.md §4.2):
//   ## Summary
//   - bullet
//   ...
//   ## Changes
//   ### `path/to/file`
//   - bullet
//   ...
//   ## Test plan
//   - [x] item
//   - [ ] item
//   - [~] item    (manual — needs human action)
//   ## Notes
//   - note
//   ...
//
// Sections are omitted when empty. Trailing newline is appended so
// `--out` writes land cleanly (no missing-EOF warning).

import { type RenderOptions, anonymize, anonymizeText, resolveHome } from '../format.ts';
import type { PrRenderV1, PrTestPlanItem } from './schema.ts';

const renderTestPlanLine = (item: PrTestPlanItem): string => {
  const marker = item.status === 'done' ? '[x]' : item.status === 'manual' ? '[~]' : '[ ]';
  return `- ${marker} ${item.item}`;
};

export const renderPrFromStructured = (
  structured: PrRenderV1,
  options: RenderOptions = {},
): string => {
  const home = resolveHome(options.home);
  const anon = options.anonymizePaths !== false;
  const path = (p: string): string => (anon ? anonymize(p, home) : p);
  const text = (s: string): string => (anon ? anonymizeText(s, home) : s);

  const lines: string[] = [];

  if (structured.summary.length > 0) {
    lines.push('## Summary');
    lines.push('');
    for (const s of structured.summary) lines.push(`- ${text(s)}`);
    lines.push('');
  }

  if (structured.changes.length > 0) {
    lines.push('## Changes');
    lines.push('');
    for (const change of structured.changes) {
      lines.push(`### \`${path(change.path)}\``);
      lines.push('');
      for (const bullet of change.bullets) lines.push(`- ${text(bullet)}`);
      lines.push('');
    }
  }

  if (structured.testPlan.length > 0) {
    lines.push('## Test plan');
    lines.push('');
    for (const item of structured.testPlan) lines.push(renderTestPlanLine(item));
    lines.push('');
  }

  if (structured.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const n of structured.notes) lines.push(`- ${text(n)}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
};
