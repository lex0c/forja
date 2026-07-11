import { describe, expect, test } from 'bun:test';
import {
  parseSkillFile,
  SkillFrontmatterError,
  serializeSkillFile,
  validateFrontmatter,
  validateName,
} from '../../src/skills/frontmatter.ts';
import type { SkillFile, SkillFrontmatter } from '../../src/skills/types.ts';

const minimal = (override: Partial<SkillFrontmatter> = {}): SkillFrontmatter => ({
  name: 'rename-symbol',
  description: 'Rename a symbol respecting scope, update callers.',
  ...override,
});

const CANONICAL = `---
name: rename-symbol
description: Rename a symbol respecting scope, update callers.
---

Procedure body.
`;

describe('parseSkillFile — structure', () => {
  test('parses a canonical file with only the required fields', () => {
    const file = parseSkillFile(CANONICAL);
    expect(file.frontmatter).toEqual({
      name: 'rename-symbol',
      description: 'Rename a symbol respecting scope, update callers.',
    });
    expect(file.body).toBe('Procedure body.\n');
  });

  test('parses and preserves every optional field', () => {
    const raw = `---
name: triage-flaky-test
description: Diagnose a non-deterministic test.
version: 2
trigger_keywords:
  - flaky test
  - intermittent
tools:
  - bash
  - edit
requires:
  - STATE_MACHINE
source: project_shared
created_at: 2026-02-01
updated_at: 2026-05-08
expires: 2026-12-31
---

Body.
`;
    const file = parseSkillFile(raw);
    expect(file.frontmatter.version).toBe(2);
    expect(file.frontmatter.trigger_keywords).toEqual(['flaky test', 'intermittent']);
    expect(file.frontmatter.tools).toEqual(['bash', 'edit']);
    expect(file.frontmatter.requires).toEqual(['STATE_MACHINE']);
    expect(file.frontmatter.source).toBe('project_shared');
    expect(file.frontmatter.created_at).toBe('2026-02-01');
    expect(file.frontmatter.updated_at).toBe('2026-05-08');
    expect(file.frontmatter.expires).toBe('2026-12-31');
  });

  test('treats `expires: null` as absent (the seed-catalog idiom)', () => {
    const raw = `---
name: bump-patch
description: Increment the patch version.
expires: null
---

Body.
`;
    expect(parseSkillFile(raw).frontmatter.expires).toBeUndefined();
  });

  test('treats `version: null` as absent (uniform null handling)', () => {
    const raw = `---
name: bump-patch
description: Increment the patch version.
version: null
---

Body.
`;
    expect(parseSkillFile(raw).frontmatter.version).toBeUndefined();
  });

  test('strips exactly one leading blank line from the body', () => {
    expect(parseSkillFile(CANONICAL).body).toBe('Procedure body.\n');
  });

  test('handles an empty body', () => {
    const file = parseSkillFile('---\nname: x\ndescription: a skill\n---\n');
    expect(file.body).toBe('');
  });

  test('normalizes CRLF line endings', () => {
    const raw = '---\r\nname: x\r\ndescription: a skill\r\n---\r\n\r\nBody.\r\n';
    const file = parseSkillFile(raw);
    expect(file.frontmatter.name).toBe('x');
    expect(file.body).toBe('Body.\n');
  });

  test('rejects a file with no opening fence', () => {
    expect(() => parseSkillFile('name: x\ndescription: d\n')).toThrow(SkillFrontmatterError);
  });

  test('rejects a file with no closing fence', () => {
    expect(() => parseSkillFile('---\nname: x\ndescription: d\n')).toThrow(SkillFrontmatterError);
  });

  test('rejects a closing fence that is not on its own line', () => {
    expect(() => parseSkillFile('---\nname: x\ndescription: d\n---x\n')).toThrow(
      SkillFrontmatterError,
    );
  });

  test('wraps a YAML parse failure as a SkillFrontmatterError', () => {
    expect(() => parseSkillFile('---\nname: [unclosed\n---\n\nbody')).toThrow(
      SkillFrontmatterError,
    );
  });

  test('round-trips canonical input', () => {
    const file = parseSkillFile(CANONICAL);
    expect(parseSkillFile(serializeSkillFile(file))).toEqual(file);
  });
});

describe('validateFrontmatter — field rules', () => {
  test('accepts the minimal required pair', () => {
    expect(validateFrontmatter({ name: 'ok-name', description: 'd' })).toEqual({
      name: 'ok-name',
      description: 'd',
    });
  });

  test('accepts source: imported even though the imported scope is v2', () => {
    expect(validateFrontmatter({ name: 'x', description: 'd', source: 'imported' }).source).toBe(
      'imported',
    );
  });

  test('rejects a non-mapping frontmatter', () => {
    expect(() => validateFrontmatter(null)).toThrow(SkillFrontmatterError);
    expect(() => validateFrontmatter([1, 2])).toThrow(SkillFrontmatterError);
    expect(() => validateFrontmatter('a string')).toThrow(SkillFrontmatterError);
  });

  test('rejects a missing name or description', () => {
    expect(() => validateFrontmatter({ description: 'd' })).toThrow(SkillFrontmatterError);
    expect(() => validateFrontmatter({ name: 'x' })).toThrow(SkillFrontmatterError);
  });

  test('rejects a non-kebab-case name', () => {
    expect(() => validateFrontmatter({ name: 'BadName', description: 'd' })).toThrow(
      SkillFrontmatterError,
    );
    expect(() => validateFrontmatter({ name: '-leading', description: 'd' })).toThrow(
      SkillFrontmatterError,
    );
    expect(() => validateFrontmatter({ name: 'with/slash', description: 'd' })).toThrow(
      SkillFrontmatterError,
    );
  });

  test('rejects an empty, over-long, or multi-line description', () => {
    expect(() => validateFrontmatter({ name: 'x', description: '' })).toThrow(
      SkillFrontmatterError,
    );
    expect(() => validateFrontmatter({ name: 'x', description: 'a'.repeat(121) })).toThrow(
      SkillFrontmatterError,
    );
    expect(() => validateFrontmatter({ name: 'x', description: 'line\nbreak' })).toThrow(
      SkillFrontmatterError,
    );
  });

  test('accepts a description exactly at the 120-char cap', () => {
    expect(
      validateFrontmatter({ name: 'x', description: 'a'.repeat(120) }).description.length,
    ).toBe(120);
  });

  test('rejects a version that is not a positive integer', () => {
    expect(() => validateFrontmatter({ name: 'x', description: 'd', version: 0 })).toThrow(
      SkillFrontmatterError,
    );
    expect(() => validateFrontmatter({ name: 'x', description: 'd', version: 1.5 })).toThrow(
      SkillFrontmatterError,
    );
    expect(() => validateFrontmatter({ name: 'x', description: 'd', version: '1' })).toThrow(
      SkillFrontmatterError,
    );
  });

  test('rejects a date field with the wrong shape', () => {
    expect(() => validateFrontmatter({ name: 'x', description: 'd', expires: '2026-1-1' })).toThrow(
      SkillFrontmatterError,
    );
    expect(() => validateFrontmatter({ name: 'x', description: 'd', created_at: 'soon' })).toThrow(
      SkillFrontmatterError,
    );
  });

  test('rejects a list entry that is empty, over-long, or non-string', () => {
    expect(() =>
      validateFrontmatter({ name: 'x', description: 'd', trigger_keywords: ['ok', ''] }),
    ).toThrow(SkillFrontmatterError);
    expect(() =>
      validateFrontmatter({ name: 'x', description: 'd', trigger_keywords: ['a'.repeat(65)] }),
    ).toThrow(SkillFrontmatterError);
    expect(() => validateFrontmatter({ name: 'x', description: 'd', tools: [123] })).toThrow(
      SkillFrontmatterError,
    );
  });

  test('rejects an unknown source value', () => {
    expect(() => validateFrontmatter({ name: 'x', description: 'd', source: 'team' })).toThrow(
      SkillFrontmatterError,
    );
  });

  test('rejects an unknown frontmatter field', () => {
    expect(() => validateFrontmatter({ name: 'x', description: 'd', priority: 'high' })).toThrow(
      SkillFrontmatterError,
    );
  });
});

describe('serializeSkillFile', () => {
  test('round-trips a file carrying every optional field', () => {
    const file: SkillFile = {
      frontmatter: minimal({
        version: 3,
        trigger_keywords: ['rename', 'refactor'],
        tools: ['edit', 'bash'],
        requires: ['TREE_SITTER'],
        source: 'user',
        created_at: '2026-05-15',
        updated_at: '2026-05-21',
        expires: '2026-12-31',
      }),
      body: 'Body.\n',
    };
    expect(parseSkillFile(serializeSkillFile(file))).toEqual(file);
  });

  test('round-trips source: imported (the value with no v1 scope)', () => {
    const file: SkillFile = {
      frontmatter: minimal({ source: 'imported' }),
      body: 'Body.\n',
    };
    expect(parseSkillFile(serializeSkillFile(file))).toEqual(file);
  });

  test('emits fields in spec order regardless of insertion order', () => {
    const out = serializeSkillFile({
      frontmatter: minimal({
        expires: '2026-12-31',
        version: 1,
        source: 'user',
        tools: ['edit'],
      }),
      body: 'Body.\n',
    });
    const order = ['name:', 'description:', 'version:', 'tools:', 'source:', 'expires:'];
    const positions = order.map((k) => out.indexOf(k));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i - 1]).toBeLessThan(positions[i] as number);
    }
  });

  test('refuses to serialize an invalid hand-built frontmatter', () => {
    expect(() =>
      serializeSkillFile({ frontmatter: minimal({ name: 'Bad Name' }), body: 'x' }),
    ).toThrow(SkillFrontmatterError);
  });
});

describe('validateName', () => {
  test('accepts kebab-case identifiers', () => {
    expect(() => validateName('git-bisect-regression')).not.toThrow();
    expect(() => validateName('skill_2')).not.toThrow();
  });

  test('rejects empty, over-long, and non-kebab-case names', () => {
    expect(() => validateName('')).toThrow(SkillFrontmatterError);
    expect(() => validateName('a'.repeat(121))).toThrow(SkillFrontmatterError);
    expect(() => validateName('../escape')).toThrow(SkillFrontmatterError);
  });
});
