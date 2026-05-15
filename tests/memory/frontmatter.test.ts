import { describe, expect, test } from 'bun:test';
import {
  FrontmatterError,
  parseMemoryFile,
  serializeMemoryFile,
  validateName,
} from '../../src/memory/frontmatter.ts';
import type { MemoryFile, MemoryFrontmatter } from '../../src/memory/types.ts';

const minimal = (override: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter => ({
  name: 'commit-style',
  description: 'Title Case verbs in commits',
  type: 'feedback',
  source: 'user_explicit',
  ...override,
});

describe('memory frontmatter parser', () => {
  test('parses canonical file with all required fields', () => {
    const raw = `---
name: commit-style
description: Title Case verbs in commits
type: feedback
source: user_explicit
---

Body content here.
`;
    const file = parseMemoryFile(raw);
    expect(file.frontmatter).toEqual({
      name: 'commit-style',
      description: 'Title Case verbs in commits',
      type: 'feedback',
      source: 'user_explicit',
    });
    expect(file.body).toBe('Body content here.\n');
  });

  test('parses optional fields and preserves them', () => {
    const raw = `---
name: q2-deadline
description: workshop demo deadline 2026-08-15
type: project
source: user_explicit
expires: 2026-09-01
trust: trusted
triggers:
  - git
  - secrets
---

Why and how.
`;
    const file = parseMemoryFile(raw);
    expect(file.frontmatter.expires).toBe('2026-09-01');
    expect(file.frontmatter.trust).toBe('trusted');
    expect(file.frontmatter.triggers).toEqual(['git', 'secrets']);
  });

  test('round-trips canonical input verbatim', () => {
    const raw = `---
name: commit-style
description: Title Case verbs in commits
type: feedback
source: user_explicit
---

Body content here.
`;
    const file = parseMemoryFile(raw);
    const serialized = serializeMemoryFile(file);
    expect(parseMemoryFile(serialized)).toEqual(file);
  });

  test('round-trips with optional fields preserved in spec order', () => {
    const file: MemoryFile = {
      frontmatter: minimal({ expires: '2026-12-31', trust: 'untrusted', triggers: ['git'] }),
      body: 'Body.\n',
    };
    const out = serializeMemoryFile(file);
    // Spec order: name, description, type, source, expires, trust, triggers
    const idxName = out.indexOf('name:');
    const idxDesc = out.indexOf('description:');
    const idxType = out.indexOf('type:');
    const idxSource = out.indexOf('source:');
    const idxExpires = out.indexOf('expires:');
    const idxTrust = out.indexOf('trust:');
    const idxTriggers = out.indexOf('triggers:');
    expect(idxName).toBeLessThan(idxDesc);
    expect(idxDesc).toBeLessThan(idxType);
    expect(idxType).toBeLessThan(idxSource);
    expect(idxSource).toBeLessThan(idxExpires);
    expect(idxExpires).toBeLessThan(idxTrust);
    expect(idxTrust).toBeLessThan(idxTriggers);
  });

  test('handles empty body', () => {
    const file: MemoryFile = { frontmatter: minimal(), body: '' };
    const out = serializeMemoryFile(file);
    expect(out.endsWith('---')).toBe(true);
    const parsed = parseMemoryFile(out);
    expect(parsed.body).toBe('');
  });

  test('normalizes CRLF on parse', () => {
    const raw =
      '---\r\nname: commit-style\r\ndescription: x\r\ntype: feedback\r\nsource: user_explicit\r\n---\r\n\r\nBody.\r\n';
    const file = parseMemoryFile(raw);
    expect(file.frontmatter.name).toBe('commit-style');
    expect(file.body).toBe('Body.\n');
  });

  test('rejects missing opening fence', () => {
    expect(() => parseMemoryFile('name: x\ntype: user\n')).toThrow(FrontmatterError);
  });

  test('rejects missing closing fence', () => {
    const raw = `---
name: commit-style
description: x
type: feedback
source: user_explicit
`;
    expect(() => parseMemoryFile(raw)).toThrow(FrontmatterError);
  });

  test('rejects closing fence not on its own line', () => {
    const raw = `---
name: x
description: y
type: feedback
source: user_explicit
---trailing
`;
    expect(() => parseMemoryFile(raw)).toThrow(FrontmatterError);
  });

  test('rejects invalid type', () => {
    const raw = `---
name: x
description: y
type: bogus
source: user_explicit
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(/type:.*one of/);
  });

  test('rejects invalid source', () => {
    const raw = `---
name: x
description: y
type: user
source: weird
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(/source:.*one of/);
  });

  test('rejects invalid trust', () => {
    const raw = `---
name: x
description: y
type: user
source: inferred
trust: maybe
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(/trust:.*one of/);
  });

  test('rejects multi-line description', () => {
    const fm = minimal();
    expect(() =>
      serializeMemoryFile({ frontmatter: { ...fm, description: 'a\nb' }, body: '' }),
    ).toThrow(/single line/);
  });

  test('rejects unknown frontmatter field', () => {
    const raw = `---
name: x
description: y
type: user
source: inferred
priority: high
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(/unknown field/);
  });

  test('rejects expires not in YYYY-MM-DD', () => {
    const raw = `---
name: x
description: y
type: project
source: inferred
expires: tomorrow
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(/YYYY-MM-DD/);
  });

  test('rejects triggers with non-string entries', () => {
    const raw = `---
name: x
description: y
type: feedback
source: user_explicit
triggers:
  - git
  - 42
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(/triggers/);
  });

  test('rejects triggers with bad pattern', () => {
    const raw = `---
name: x
description: y
type: feedback
source: user_explicit
triggers:
  - "Bad Trigger"
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(/triggers/);
  });
});

describe('validateName', () => {
  test.each([
    'commit-style',
    'q2-deadline',
    'feedback_no_auto_commit',
    'a',
    'user1',
    'mixed-1_kebab',
  ])('accepts %s', (name) => {
    expect(() => validateName(name)).not.toThrow();
  });

  test.each([
    '',
    '-leading-dash',
    '_leading-underscore',
    'UPPER',
    'has spaces',
    'has/slash',
    'has\\backslash',
    '..',
    '../escape',
    '.dotfile',
    'has.dot',
  ])('rejects %s', (name) => {
    expect(() => validateName(name)).toThrow(FrontmatterError);
  });

  test('rejects names exceeding 120 chars', () => {
    expect(() => validateName('a'.repeat(121))).toThrow(/exceeds/);
  });

  test('accepts names exactly 120 chars', () => {
    expect(() => validateName('a'.repeat(120))).not.toThrow();
  });
});

describe('serializer guards', () => {
  test('serialize re-validates frontmatter so callers cannot smuggle invalid state', () => {
    const file: MemoryFile = {
      // Cast to bypass TS so we exercise the runtime guard.
      frontmatter: { ...minimal(), name: 'BAD NAME' } as MemoryFrontmatter,
      body: '',
    };
    expect(() => serializeMemoryFile(file)).toThrow(FrontmatterError);
  });
});

describe('memory frontmatter state field (spec §3.1.1)', () => {
  test.each(['proposed', 'active', 'quarantined', 'invalidated', 'evicted', 'purged'])(
    'parses state=%s round-trip',
    (state) => {
      const raw = `---
name: x
description: y
type: feedback
source: user_explicit
state: ${state}
---
`;
      const file = parseMemoryFile(raw);
      expect(file.frontmatter.state).toBe(state as Exclude<typeof state, never>);
    },
  );

  test('absence of state preserves undefined (no default coerce on read)', () => {
    const raw = `---
name: x
description: y
type: feedback
source: user_explicit
---
`;
    const file = parseMemoryFile(raw);
    expect(file.frontmatter.state).toBeUndefined();
  });

  test('rejects unknown state value', () => {
    const raw = `---
name: x
description: y
type: feedback
source: user_explicit
state: banana
---
`;
    expect(() => parseMemoryFile(raw)).toThrow(FrontmatterError);
    expect(() => parseMemoryFile(raw)).toThrow(/state/);
  });

  test('serializer emits state last in canonical order (after triggers)', () => {
    const file: MemoryFile = {
      frontmatter: minimal({ state: 'quarantined', triggers: ['t1'] }),
      body: '',
    };
    const out = serializeMemoryFile(file);
    // Triggers comes before state — confirms canonical ordering
    // (name, description, type, source, expires, trust, triggers, state).
    const triggersIdx = out.indexOf('triggers:');
    const stateIdx = out.indexOf('state:');
    expect(triggersIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeGreaterThan(triggersIdx);
  });

  test('serializer omits state line when frontmatter.state is undefined', () => {
    const file: MemoryFile = { frontmatter: minimal(), body: '' };
    const out = serializeMemoryFile(file);
    expect(out).not.toContain('state:');
  });

  test('round-trip parse -> serialize -> parse preserves state', () => {
    const original = `---
name: x
description: y
type: feedback
source: user_explicit
trust: untrusted
state: invalidated
---

body line
`;
    const parsed = parseMemoryFile(original);
    const reserialized = serializeMemoryFile(parsed);
    const reparsed = parseMemoryFile(reserialized);
    expect(reparsed.frontmatter.state).toBe('invalidated');
    expect(reparsed.frontmatter.trust).toBe('untrusted');
  });
});
