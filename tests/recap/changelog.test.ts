import { describe, expect, test } from 'bun:test';
import {
  projectChangelogDeterministic,
  renderChangelogFromStructured,
} from '../../src/recap/changelog/index.ts';
import {
  CHANGELOG_LIMITS,
  CHANGELOG_SCHEMA_VERSION,
  type ChangelogRenderV1,
  validateChangelogRenderV1,
} from '../../src/recap/changelog/schema.ts';
import { RECAP_SCHEMA_VERSION, type RecapIntermediate } from '../../src/recap/types.ts';

const baseIntermediate = (overrides: Partial<RecapIntermediate> = {}): RecapIntermediate => ({
  schemaVersion: RECAP_SCHEMA_VERSION,
  generatedAt: 0,
  scope: { kind: 'session_specific', sessionIds: ['s-1'], range: { start: 0, end: 0 } },
  completeness: { incomplete: false, incompleteSessions: [], incompleteReason: '' },
  goal: { text: '', sourceStepId: '' },
  goalStack: [],
  decisions: [],
  pinnedContext: [],
  actions: {
    filesRead: [],
    filesWritten: [],
    commandsRun: [],
    webFetches: [],
    subagentsSpawned: [],
  },
  outcomes: { testsRun: [], checkpoints: [], artifacts: [] },
  timeline: [],
  costs: {
    tokens: { in: 0, out: 0, cached: 0 },
    usd: 0,
    durationMs: 0,
    model: '',
    cacheHitRatio: 0,
  },
  errors: [],
  notDone: [],
  unresolvedQuestions: [],
  memoryProposed: [],
  ...overrides,
});

describe('validateChangelogRenderV1', () => {
  const valid = (): ChangelogRenderV1 => ({
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    entries: [{ category: 'Changed', bullet: 'Update queue retry logic' }],
  });

  test('accepts a minimal valid shape', () => {
    expect(validateChangelogRenderV1(valid()).ok).toBe(true);
  });

  test('rejects unknown category', () => {
    const v = { ...valid(), entries: [{ category: 'Cool', bullet: 'x' }] };
    expect(validateChangelogRenderV1(v).ok).toBe(false);
  });

  test('rejects empty entries', () => {
    const v = { ...valid(), entries: [] };
    expect(validateChangelogRenderV1(v).ok).toBe(false);
  });

  test('rejects more than max entries', () => {
    const entries = Array.from({ length: CHANGELOG_LIMITS.entriesMaxItems + 1 }, () => ({
      category: 'Changed' as const,
      bullet: 'x',
    }));
    expect(validateChangelogRenderV1({ ...valid(), entries }).ok).toBe(false);
  });

  test('rejects bullet over the cap', () => {
    const v = {
      ...valid(),
      entries: [
        { category: 'Changed' as const, bullet: 'a'.repeat(CHANGELOG_LIMITS.bulletMaxChars + 1) },
      ],
    };
    expect(validateChangelogRenderV1(v).ok).toBe(false);
  });

  test('rejects extra top-level properties', () => {
    expect(validateChangelogRenderV1({ ...valid(), tone: 'cheerful' }).ok).toBe(false);
  });
});

describe('projectChangelogDeterministic', () => {
  test('empty intermediate produces a sentinel entry, never empty array', () => {
    const result = projectChangelogDeterministic(baseIntermediate());
    expect(validateChangelogRenderV1(result).ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.bullet).toContain('No user-impacting changes');
  });

  test('pure-add file maps to Added category', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [
            { path: '/p/new.ts', linesAdded: 30, linesRemoved: 0, semanticSummary: '' },
          ],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.entries[0]?.category).toBe('Added');
    expect(result.entries[0]?.bullet).toContain('new.ts');
  });

  test('pure-delete file maps to Removed category', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [
            { path: '/p/old.ts', linesAdded: 0, linesRemoved: 10, semanticSummary: '' },
          ],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.entries[0]?.category).toBe('Removed');
  });

  test('mixed-edit file maps to Changed category', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [{ path: '/p/x.ts', linesAdded: 5, linesRemoved: 2, semanticSummary: '' }],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.entries[0]?.category).toBe('Changed');
    expect(result.entries[0]?.bullet).toContain('+5 / -2');
  });

  test('semanticSummary, when present, replaces the line-count bullet', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [
            {
              path: '/p/x.ts',
              linesAdded: 1,
              linesRemoved: 0,
              semanticSummary: 'Add retry backoff helper',
            },
          ],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.entries[0]?.bullet).toBe('Add retry backoff helper');
  });

  test('hook/policy decisions land in Changed by default', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        decisions: [{ stepId: 's', what: 'block bash rm', why: 'policy', decidedBy: 'policy' }],
      }),
    );
    expect(result.entries[0]?.category).toBe('Changed');
  });

  test('decisions with security keywords in `what` land in Security', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        decisions: [
          { stepId: 's', what: 'block secret leak via env var', why: '', decidedBy: 'hook' },
        ],
      }),
    );
    expect(result.entries[0]?.category).toBe('Security');
  });

  test('decisions with security keywords only in `why` also land in Security', () => {
    // Real-world shape: hook label is generic ("block bash"), the
    // forensic detail lives in `why`. Without scanning `why`, the
    // changelog would miss the security signal.
    const result = projectChangelogDeterministic(
      baseIntermediate({
        decisions: [
          {
            stepId: 's',
            what: 'block bash',
            why: 'attempts to read secret env var',
            decidedBy: 'hook',
          },
        ],
      }),
    );
    expect(result.entries[0]?.category).toBe('Security');
  });

  test('recovered errors land in Fixed', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        errors: [{ code: 'ECONNRESET', recovered: true, summary: 'transient network drop' }],
      }),
    );
    expect(result.entries[0]?.category).toBe('Fixed');
    expect(result.entries[0]?.bullet).toContain('transient');
  });

  test('user decisions are skipped (changelog is user-facing impact, not approval log)', () => {
    const result = projectChangelogDeterministic(
      baseIntermediate({
        decisions: [{ stepId: 's', what: 'rename Foo', why: '', decidedBy: 'user' }],
      }),
    );
    expect(result.entries[0]?.bullet).toContain('No user-impacting');
  });

  test('caps total entries at the schema limit', () => {
    const filesWritten = Array.from({ length: CHANGELOG_LIMITS.entriesMaxItems + 5 }, (_, i) => ({
      path: `/p/file-${i}.ts`,
      linesAdded: 1,
      linesRemoved: 0,
      semanticSummary: '',
    }));
    const result = projectChangelogDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten,
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.entries.length).toBeLessThanOrEqual(CHANGELOG_LIMITS.entriesMaxItems);
  });
});

describe('renderChangelogFromStructured', () => {
  test('emits sections in canonical Keep a Changelog order', () => {
    const md = renderChangelogFromStructured({
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      entries: [
        { category: 'Fixed', bullet: 'fix x' },
        { category: 'Added', bullet: 'add y' },
      ],
    });
    const addedIdx = md.indexOf('### Added');
    const fixedIdx = md.indexOf('### Fixed');
    expect(addedIdx).toBeGreaterThan(-1);
    expect(fixedIdx).toBeGreaterThan(addedIdx);
  });

  test('omits sections that have no entries', () => {
    const md = renderChangelogFromStructured({
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      entries: [{ category: 'Added', bullet: 'a' }],
    });
    expect(md).toContain('### Added');
    expect(md).not.toContain('### Removed');
    expect(md).not.toContain('### Security');
  });

  test('output ends with a single trailing newline', () => {
    const md = renderChangelogFromStructured({
      schemaVersion: CHANGELOG_SCHEMA_VERSION,
      entries: [{ category: 'Added', bullet: 'a' }],
    });
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  test('prepends incomplete callout when option is set', () => {
    const md = renderChangelogFromStructured(
      {
        schemaVersion: CHANGELOG_SCHEMA_VERSION,
        entries: [{ category: 'Added', bullet: 'a' }],
      },
      { incomplete: { reason: 'session crashed', sessionIds: ['s-1', 's-2'] } },
    );
    expect(md.startsWith('> ⚠ Incomplete: session crashed (s-1, s-2)')).toBe(true);
    expect(md).toContain('### Added');
  });

  test('anonymizes paths embedded in bullets', () => {
    const md = renderChangelogFromStructured(
      {
        schemaVersion: CHANGELOG_SCHEMA_VERSION,
        entries: [{ category: 'Added', bullet: 'See /home/lex/proj/notes.md' }],
      },
      { home: '/home/lex' },
    );
    expect(md).toContain('~/proj/notes.md');
    expect(md).not.toContain('/home/lex');
  });
});
