// Bundled seed-catalog tests (spec SKILLS.md §6). Validates the
// canonical skills ship parseable and that `agent init` installs a
// catalog every entry resolves into.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_SKILLS } from '../../src/cli/init-skills/index.ts';
import { runInit } from '../../src/cli/init.ts';
import { createSkillCatalog, parseSkillFile } from '../../src/skills/index.ts';

describe('CANONICAL_SKILLS — bundled seed catalog', () => {
  test('ships 15 skills, each parseable with its filename matching the frontmatter name', () => {
    expect(CANONICAL_SKILLS).toHaveLength(15);
    for (const skill of CANONICAL_SKILLS) {
      // parseSkillFile throws SkillFrontmatterError on bad
      // frontmatter — a malformed seed surfaces here, before it
      // ships, with a message naming the offending skill.
      const parsed = parseSkillFile(skill.content);
      expect(`${parsed.frontmatter.name}.md`).toBe(skill.filename);
    }
  });

  test('agent init installs the catalog and every skill resolves cleanly', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'forja-init-skills-'));
    try {
      const code = runInit({
        cwd,
        mode: 'strict',
        only: ['skills'],
        out: () => {},
        err: () => {},
      });
      expect(code).toBe(0);
      const catalog = createSkillCatalog({
        roots: {
          user: null,
          projectShared: join(cwd, '.agent', 'skills', 'shared'),
          projectLocal: join(cwd, '.agent', 'skills', 'local'),
        },
      });
      expect(catalog.count()).toBe(15);
      expect(catalog.filtered()).toHaveLength(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
