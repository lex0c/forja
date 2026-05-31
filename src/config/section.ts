// Shared TOML-section reader for the per-project `.agent/config.toml`
// loaders (memory, providers, budget). Each loader used to
// reimplement steps 1-7 of "open file, parse TOML, find section,
// validate it's a table" — that boilerplate was ~30 lines per parser
// duplicated by the time the third consumer landed. Extracting
// the common path here keeps field-level validation (which IS
// section-specific) in the per-loader code while collapsing the
// shared plumbing.
//
// Returns a discriminated union so the caller can distinguish:
//
//   `kind: 'absent'`     — file does not exist (or path is null);
//                          loader uses defaults, no diagnostic
//   `kind: 'invalid'`    — read or parse error; loader emits the
//                          warning and uses defaults
//   `kind: 'no-section'` — file exists but section absent; same
//                          path as `absent` for the caller
//   `kind: 'found'`      — section is a TOML table; loader proceeds
//                          with field-level validation

import { existsSync, readFileSync } from 'node:fs';

export type SectionResult =
  | { kind: 'absent' }
  | { kind: 'no-section' }
  | { kind: 'invalid'; warning: string }
  | { kind: 'found'; section: Record<string, unknown> };

export const loadTomlSection = (
  path: string | null,
  sectionName: string,
  source: string,
): SectionResult => {
  if (path === null) return { kind: 'absent' };
  if (!existsSync(path)) return { kind: 'absent' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      kind: 'invalid',
      warning: `${source} config (${path}) could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch (err) {
    return {
      kind: 'invalid',
      warning: `${source} config (${path}) TOML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object') return { kind: 'no-section' };
  const top = parsed as Record<string, unknown>;
  const section = top[sectionName];
  if (section === undefined) return { kind: 'no-section' };
  if (section === null || typeof section !== 'object') {
    return {
      kind: 'invalid',
      warning: `${source} config (${path}): [${sectionName}] is not a table`,
    };
  }
  return { kind: 'found', section: section as Record<string, unknown> };
};
