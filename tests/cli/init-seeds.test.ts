// Bundled vendor seed catalog tests (spec MEMORY.md §5.7.8).
// Validates that every canonical seed ships parseable through the
// memory frontmatter parser AND honors the seed-specific gates
// (source=seed cross-fields, body ≤ 30 lines, trust trusted).

import { describe, expect, test } from 'bun:test';
import { CANONICAL_SEEDS } from '../../src/cli/init-seeds/index.ts';
import { SEED_BODY_MAX_LINES, parseMemoryFile } from '../../src/memory/frontmatter.ts';

describe('CANONICAL_SEEDS — bundled vendor seed catalog', () => {
  test('ships exactly 10 seeds (spec §5.7.7 hard cap)', () => {
    expect(CANONICAL_SEEDS.length).toBeLessThanOrEqual(10);
    expect(CANONICAL_SEEDS).toHaveLength(10);
  });

  test('each canonical seed parses cleanly with seed cross-field rules', () => {
    for (const seed of CANONICAL_SEEDS) {
      // parseMemoryFile throws FrontmatterError on bad frontmatter
      // (including source=seed cross-checks: required seed_origin
      // + seed_version, forbidden expires, forbidden trust=untrusted)
      // AND on bodies exceeding SEED_BODY_MAX_LINES. A regression in
      // any seed surfaces here with a message naming the offending
      // file, before the asset ships.
      const file = parseMemoryFile(seed.content);
      expect(file.frontmatter.source).toBe('seed');
      expect(file.frontmatter.seed_origin).toBe('vendor');
      expect(file.frontmatter.seed_version).toBe('1.0');
      expect(`${file.frontmatter.name}.md`).toBe(seed.filename);
      // The index entry's pinned `name`/`description` must match
      // the frontmatter — the installer copies them into
      // seeds/MEMORY.md without re-parsing each body.
      expect(seed.name).toBe(file.frontmatter.name);
      expect(seed.description).toBe(file.frontmatter.description);
    }
  });

  test('every seed body is within the SEED_BODY_MAX_LINES cap', () => {
    for (const seed of CANONICAL_SEEDS) {
      const file = parseMemoryFile(seed.content);
      // The parser already enforces the cap (throws on >30 lines).
      // This assertion documents the invariant for the reader and
      // double-protects against a regression that loosens the cap.
      const lines = file.body.split('\n');
      const effective = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      expect(effective).toBeLessThanOrEqual(SEED_BODY_MAX_LINES);
    }
  });

  test('filenames are unique and alphabetically ordered', () => {
    const filenames = CANONICAL_SEEDS.map((s) => s.filename);
    expect(new Set(filenames).size).toBe(filenames.length);
    const sorted = [...filenames].sort((a, b) => a.localeCompare(b));
    expect(filenames).toEqual(sorted);
  });

  test('names are unique', () => {
    const names = CANONICAL_SEEDS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
