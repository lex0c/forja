import { describe, expect, test } from 'bun:test';
import {
  FrontmatterError,
  SEED_BODY_MAX_LINES,
  parseMemoryFile,
  serializeMemoryFile,
  validateName,
  validateSeedBody,
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

describe('memory frontmatter seed fields (spec §5.7)', () => {
  const seedRaw = (override?: {
    extras?: string;
    body?: string;
  }): string => `---
name: safe-edit-discipline
description: ler antes de Edit; Edit em existente, Write so para novo
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"${override?.extras ?? ''}
---

${override?.body ?? 'Body content for the seed.'}
`;

  test('parses a canonical vendor seed file', () => {
    const file = parseMemoryFile(seedRaw());
    expect(file.frontmatter.source).toBe('seed');
    expect(file.frontmatter.seed_origin).toBe('vendor');
    expect(file.frontmatter.seed_version).toBe('1.0');
  });

  test.each(['vendor', 'team', 'install'])('accepts seed_origin=%s', (origin) => {
    const raw = seedRaw().replace('seed_origin: vendor', `seed_origin: ${origin}`);
    const file = parseMemoryFile(raw);
    expect(file.frontmatter.seed_origin).toBe(origin);
  });

  test('rejects unknown seed_origin', () => {
    const raw = seedRaw().replace('seed_origin: vendor', 'seed_origin: hacker');
    expect(() => parseMemoryFile(raw)).toThrow(/seed_origin: must be one of/);
  });

  test.each(['1.0', '1.2', '2.0.0', '0.1', '10.0.5'])('accepts seed_version=%s', (version) => {
    const raw = seedRaw().replace('seed_version: "1.0"', `seed_version: "${version}"`);
    const file = parseMemoryFile(raw);
    expect(file.frontmatter.seed_version).toBe(version);
  });

  test.each(['1', '1.x', '1.0.0.0', '01.0', '1.0-beta', ''])(
    'rejects malformed seed_version=%s',
    (version) => {
      const raw = seedRaw().replace('seed_version: "1.0"', `seed_version: "${version}"`);
      expect(() => parseMemoryFile(raw)).toThrow(FrontmatterError);
    },
  );

  test('rejects unquoted seed_version (YAML parses as number, not string)', () => {
    // Operator footgun: `seed_version: 1.0` (no quotes) → YAML 1.2
    // coerces to the JS number `1`. The parser's optionalString
    // helper throws `expected string, got number`. Pin the rejection
    // so a future relaxation (auto-coerce number to canonical
    // string) is a visible test break, not silent drift.
    const raw = `---
name: x
description: y
type: feedback
source: seed
seed_origin: vendor
seed_version: 1.0
---

body
`;
    expect(() => parseMemoryFile(raw)).toThrow(FrontmatterError);
  });

  test('requires seed_origin when source=seed', () => {
    const raw = `---
name: seed-x
description: missing origin
type: feedback
source: seed
seed_version: "1.0"
---

body
`;
    expect(() => parseMemoryFile(raw)).toThrow(/seed_origin: required when source=seed/);
  });

  test('requires seed_version when source=seed', () => {
    const raw = `---
name: seed-x
description: missing version
type: feedback
source: seed
seed_origin: vendor
---

body
`;
    expect(() => parseMemoryFile(raw)).toThrow(/seed_version: required when source=seed/);
  });

  test('forbids expires on seed memories', () => {
    const raw = seedRaw({ extras: '\nexpires: 2026-12-31' });
    expect(() => parseMemoryFile(raw)).toThrow(/expires: forbidden when source=seed/);
  });

  test('forbids trust=untrusted on seed memories', () => {
    const raw = seedRaw({ extras: '\ntrust: untrusted' });
    expect(() => parseMemoryFile(raw)).toThrow(/seed memories cannot be untrusted/);
  });

  test('accepts trust=trusted on seed memories (explicit allowed)', () => {
    const raw = seedRaw({ extras: '\ntrust: trusted' });
    const file = parseMemoryFile(raw);
    expect(file.frontmatter.trust).toBe('trusted');
  });

  test.each(['user_explicit', 'inferred', 'imported'])(
    'forbids seed_origin when source=%s',
    (source) => {
      const raw = `---
name: x
description: y
type: feedback
source: ${source}
seed_origin: vendor
---

body
`;
      expect(() => parseMemoryFile(raw)).toThrow(/seed_origin: only valid when source=seed/);
    },
  );

  test.each(['user_explicit', 'inferred', 'imported'])(
    'forbids seed_version when source=%s',
    (source) => {
      const raw = `---
name: x
description: y
type: feedback
source: ${source}
seed_version: "1.0"
---

body
`;
      expect(() => parseMemoryFile(raw)).toThrow(/seed_version: only valid when source=seed/);
    },
  );

  test(`enforces body <= ${SEED_BODY_MAX_LINES} lines on parse`, () => {
    const longBody = Array.from(
      { length: SEED_BODY_MAX_LINES + 1 },
      (_, i) => `line ${i + 1}`,
    ).join('\n');
    const raw = seedRaw({ body: longBody });
    expect(() => parseMemoryFile(raw)).toThrow(/seed body exceeds 30 lines/);
  });

  test(`accepts body of exactly ${SEED_BODY_MAX_LINES} lines`, () => {
    const exactBody = Array.from({ length: SEED_BODY_MAX_LINES }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const raw = seedRaw({ body: exactBody });
    const file = parseMemoryFile(raw);
    expect(file.frontmatter.source).toBe('seed');
  });

  test('serializer enforces body cap symmetrically', () => {
    const longBody = `${Array.from({ length: SEED_BODY_MAX_LINES + 1 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
    const file: MemoryFile = {
      frontmatter: {
        name: 'too-long-seed',
        description: 'too long',
        type: 'feedback',
        source: 'seed',
        seed_origin: 'vendor',
        seed_version: '1.0',
      },
      body: longBody,
    };
    expect(() => serializeMemoryFile(file)).toThrow(/seed body exceeds 30 lines/);
  });

  test('validateSeedBody counts lines correctly with trailing newline', () => {
    expect(() => validateSeedBody('')).not.toThrow();
    expect(() => validateSeedBody('one\n')).not.toThrow();
    expect(() => validateSeedBody(`${'x\n'.repeat(SEED_BODY_MAX_LINES)}`)).not.toThrow();
    expect(() => validateSeedBody(`${'x\n'.repeat(SEED_BODY_MAX_LINES + 1)}`)).toThrow();
  });

  test('serializer emits seed_origin and seed_version after source', () => {
    const file: MemoryFile = {
      frontmatter: {
        name: 'safe-edit',
        description: 'discipline',
        type: 'feedback',
        source: 'seed',
        seed_origin: 'vendor',
        seed_version: '1.0',
      },
      body: 'body line\n',
    };
    const out = serializeMemoryFile(file);
    const idxSource = out.indexOf('source:');
    const idxOrigin = out.indexOf('seed_origin:');
    const idxVersion = out.indexOf('seed_version:');
    expect(idxSource).toBeLessThan(idxOrigin);
    expect(idxOrigin).toBeLessThan(idxVersion);
  });

  test('serializer pins full canonical field order with every field present', () => {
    // Every field set so the test exercises the complete ordering
    // contract (spec §3.1 + §3.1.1 + §5.7.2): name → description →
    // type → source → seed_origin → seed_version → expires →
    // trust → triggers → state. A refactor that switches to spread
    // (`{ ...file.frontmatter }`) or reorders the `ordered` object
    // literal in serializeMemoryFile breaks this pin instead of
    // silently shifting YAML output. trust is `trusted` (the only
    // value allowed when source=seed); expires is OMITTED because
    // seed forbids it (§5.7.7) — both invariants enforced at parse,
    // so a "every field" fixture for seed can't include expires.
    // To still pin the expires slot relative to the others, the
    // assertion list checks "if expires were present it would land
    // between seed_version and trust" via a non-seed fixture below.
    const file: MemoryFile = {
      frontmatter: {
        name: 'safe-edit-discipline',
        description: 'ler antes de Edit; Edit em existente',
        type: 'feedback',
        source: 'seed',
        seed_origin: 'vendor',
        seed_version: '1.0',
        trust: 'trusted',
        triggers: ['git', 'bash'],
        state: 'active',
      },
      body: 'body\n',
    };
    const out = serializeMemoryFile(file);
    const slots = [
      'name:',
      'description:',
      'type:',
      'source:',
      'seed_origin:',
      'seed_version:',
      'trust:',
      'triggers:',
      'state:',
    ];
    const positions = slots.map((slot) => out.indexOf(slot));
    for (let i = 0; i < positions.length; i += 1) {
      const idx = positions[i] ?? -1;
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < positions.length; i += 1) {
      const prev = positions[i - 1] ?? -1;
      const curr = positions[i] ?? -1;
      expect(prev).toBeLessThan(curr);
    }
  });

  test('serializer places expires between seed_version and trust on non-seed memories', () => {
    // Mirror test for the expires slot. A non-seed memory can carry
    // expires; the slot belongs between the seed pair and trust per
    // the canonical order. Together with the seed test above, this
    // pins every field's relative position.
    const file: MemoryFile = {
      frontmatter: {
        name: 'q2-deadline',
        description: 'workshop deadline',
        type: 'project',
        source: 'user_explicit',
        expires: '2026-12-31',
        trust: 'trusted',
        triggers: ['git'],
        state: 'active',
      },
      body: 'body\n',
    };
    const out = serializeMemoryFile(file);
    const slots = [
      'name:',
      'description:',
      'type:',
      'source:',
      'expires:',
      'trust:',
      'triggers:',
      'state:',
    ];
    const positions = slots.map((slot) => out.indexOf(slot));
    for (let i = 0; i < positions.length; i += 1) {
      const idx = positions[i] ?? -1;
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < positions.length; i += 1) {
      const prev = positions[i - 1] ?? -1;
      const curr = positions[i] ?? -1;
      expect(prev).toBeLessThan(curr);
    }
  });

  test('round-trip preserves seed fields verbatim', () => {
    const file = parseMemoryFile(seedRaw());
    const reparsed = parseMemoryFile(serializeMemoryFile(file));
    expect(reparsed.frontmatter).toEqual(file.frontmatter);
    expect(reparsed.body).toBe(file.body);
  });
});
