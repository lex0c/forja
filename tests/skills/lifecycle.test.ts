import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createSkill, createSkillCatalog, deleteSkill, moveSkill } from '../../src/skills/index.ts';
import { brokenDoc, cleanupTmpDirs, makeRoots, makeTmp, skillDoc, writeSkill } from './_helpers.ts';

afterEach(cleanupTmpDirs);

describe('createSkill', () => {
  test('scaffolds a skill file the catalog fully parses (template round-trips)', () => {
    const roots = makeRoots(makeTmp());
    const result = createSkill(roots, 'project_local', 'new-skill');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(result.path)).toBe(true);
    // `read` re-parses frontmatter AND body — a stronger check than
    // `lookup` (which only needs `frontmatter.name` to match).
    const read = createSkillCatalog({ roots }).read('new-skill');
    expect(read.kind).toBe('present');
    if (read.kind === 'present') expect(read.scope).toBe('project_local');
  });

  test('reports scope_unavailable when the scope root does not resolve', () => {
    const roots = { ...makeRoots(makeTmp()), user: null };
    const result = createSkill(roots, 'user', 'homeless');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('scope_unavailable');
  });

  test('refuses to overwrite an existing skill', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'dup', skillDoc('dup'));
    const result = createSkill(roots, 'project_local', 'dup');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_exists');
  });

  test('rejects a traversal-shaped name', () => {
    const result = createSkill(makeRoots(makeTmp()), 'project_local', '../escape');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_name');
  });
});

describe('moveSkill', () => {
  test('moves a skill between scopes — source gone, target present', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'mover', skillDoc('mover'));
    const result = moveSkill(roots, 'mover', 'project_local', 'project_shared');
    expect(result.ok).toBe(true);
    expect(existsSync(join(roots.projectLocal, 'mover.md'))).toBe(false);
    expect(existsSync(join(roots.projectShared, 'mover.md'))).toBe(true);
  });

  test('not_found when the source scope has no such skill', () => {
    const result = moveSkill(makeRoots(makeTmp()), 'ghost', 'project_local', 'project_shared');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  test('already_exists when the target scope holds the same name', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'clash', skillDoc('clash'));
    writeSkill(roots.projectShared, 'clash', skillDoc('clash'));
    const result = moveSkill(roots, 'clash', 'project_local', 'project_shared');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_exists');
  });

  test('refuses to move a malformed source', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'broken', brokenDoc('broken'));
    const result = moveSkill(roots, 'broken', 'project_local', 'project_shared');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  test('refuses to move a symlinked source', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'real', skillDoc('real'));
    mkdirSync(roots.projectLocal, { recursive: true });
    symlinkSync(join(roots.projectShared, 'real.md'), join(roots.projectLocal, 'linked.md'));
    const result = moveSkill(roots, 'linked', 'project_local', 'project_shared');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  test('rolls back the destination when the source delete fails', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectLocal, 'stuck', skillDoc('stuck'));
    // Read-only source dir makes rmSync(source) fail — unlink needs
    // write on the parent — exercising the post-write failure path.
    chmodSync(roots.projectLocal, 0o555);
    try {
      const result = moveSkill(roots, 'stuck', 'project_local', 'project_shared');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('io_error');
      // A failed move must mutate nothing: the destination is rolled
      // back, the source still resolves.
      expect(existsSync(join(roots.projectShared, 'stuck.md'))).toBe(false);
      expect(existsSync(join(roots.projectLocal, 'stuck.md'))).toBe(true);
    } finally {
      chmodSync(roots.projectLocal, 0o755);
    }
  });
});

describe('deleteSkill', () => {
  test('removes the file', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'gone', skillDoc('gone'));
    const result = deleteSkill(roots, 'project_shared', 'gone');
    expect(result.ok).toBe(true);
    expect(existsSync(join(roots.projectShared, 'gone.md'))).toBe(false);
  });

  test('not_found when the skill is absent', () => {
    const result = deleteSkill(makeRoots(makeTmp()), 'project_shared', 'ghost');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  test('removes a file whose filename is not kebab-case', () => {
    const roots = makeRoots(makeTmp());
    writeSkill(roots.projectShared, 'Upper', skillDoc('upper'));
    const result = deleteSkill(roots, 'project_shared', 'Upper');
    expect(result.ok).toBe(true);
    expect(existsSync(join(roots.projectShared, 'Upper.md'))).toBe(false);
  });

  test('still refuses a traversal name with the format gate skipped', () => {
    const result = deleteSkill(makeRoots(makeTmp()), 'project_shared', '../escape');
    expect(result.ok).toBe(false);
  });
});
