import { describe, expect, test } from 'bun:test';
import {
  projectTerseDeterministic,
  renderTerseFromStructured,
} from '../../src/recap/terse/index.ts';
import {
  TERSE_LIMITS,
  TERSE_SCHEMA_VERSION,
  type TerseRenderV1,
  validateTerseRenderV1,
} from '../../src/recap/terse/schema.ts';
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

describe('validateTerseRenderV1', () => {
  const valid = (): TerseRenderV1 => ({
    schemaVersion: TERSE_SCHEMA_VERSION,
    sentence: 'Refactored queue retry logic. 4m32s, $0.04.',
  });

  test('accepts a minimal valid shape', () => {
    expect(validateTerseRenderV1(valid()).ok).toBe(true);
  });

  test('rejects empty sentence', () => {
    expect(validateTerseRenderV1({ ...valid(), sentence: '' }).ok).toBe(false);
  });

  test('rejects sentence over 200 chars', () => {
    const v = { ...valid(), sentence: 'x'.repeat(TERSE_LIMITS.sentenceMaxChars + 1) };
    expect(validateTerseRenderV1(v).ok).toBe(false);
  });

  test('rejects extra top-level properties', () => {
    expect(validateTerseRenderV1({ ...valid(), tone: 'x' }).ok).toBe(false);
  });

  test('rejects wrong schemaVersion', () => {
    expect(validateTerseRenderV1({ ...valid(), schemaVersion: 'terse-v0' as 'terse-v1' }).ok).toBe(
      false,
    );
  });
});

describe('projectTerseDeterministic', () => {
  test('empty intermediate produces sentinel sentence', () => {
    const result = projectTerseDeterministic(baseIntermediate());
    expect(validateTerseRenderV1(result).ok).toBe(true);
    expect(result.sentence).toContain('No actions recorded');
    expect(result.sentence).toContain('$0.00');
  });

  test('sentence under the schema cap', () => {
    const result = projectTerseDeterministic(
      baseIntermediate({
        goal: { text: 'do many things', sourceStepId: 'st' },
        actions: {
          filesRead: [],
          filesWritten: [{ path: '/p/a.ts', linesAdded: 1, linesRemoved: 0, semanticSummary: '' }],
          commandsRun: [{ command: 'echo', exitCode: 0, durationMs: 1 }],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.sentence.length).toBeLessThanOrEqual(TERSE_LIMITS.sentenceMaxChars);
  });

  test('combines goal text and counts when both present', () => {
    const result = projectTerseDeterministic(
      baseIntermediate({
        goal: { text: 'Refactor queue', sourceStepId: 'st' },
        actions: {
          filesRead: [],
          filesWritten: [{ path: '/p/a.ts', linesAdded: 1, linesRemoved: 0, semanticSummary: '' }],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.sentence).toContain('Refactor queue');
    expect(result.sentence).toContain('1 files edited');
  });

  test('long goal text is truncated to schema cap', () => {
    const longGoal = 'x'.repeat(500);
    const result = projectTerseDeterministic(
      baseIntermediate({ goal: { text: longGoal, sourceStepId: 'st' } }),
    );
    expect(result.sentence.length).toBeLessThanOrEqual(TERSE_LIMITS.sentenceMaxChars);
  });

  test('sentence ends with cost label', () => {
    const result = projectTerseDeterministic(
      baseIntermediate({
        costs: {
          tokens: { in: 0, out: 0, cached: 0 },
          usd: 0.04,
          durationMs: 272_000,
          model: 'sonnet',
          cacheHitRatio: 0,
        },
      }),
    );
    expect(result.sentence).toContain('4m32s');
    expect(result.sentence).toContain('$0.04');
  });

  test('surfaces unrecovered failures but omits recovered ones', () => {
    const result = projectTerseDeterministic(
      baseIntermediate({
        goal: { text: 'run the migration', sourceStepId: 'st' },
        errors: [
          { code: 'storage.reset', recovered: true, summary: 'retried' },
          { code: 'storage.migration_failed', recovered: false, summary: 'aborted' },
        ],
      }),
    );
    // Only the unrecovered one changes the headline.
    expect(result.sentence).toContain('1 unresolved error(s)');
  });

  test('a session with only recovered failures reads as success (no error clause)', () => {
    const result = projectTerseDeterministic(
      baseIntermediate({
        goal: { text: 'tighten backoff', sourceStepId: 'st' },
        errors: [{ code: 'provider.rate_limit', recovered: true, summary: 'backed off' }],
      }),
    );
    expect(result.sentence).not.toContain('unresolved error');
  });
});

describe('renderTerseFromStructured', () => {
  test('emits the sentence followed by a single newline', () => {
    const md = renderTerseFromStructured({
      schemaVersion: TERSE_SCHEMA_VERSION,
      sentence: 'Did a thing.',
    });
    expect(md).toBe('Did a thing.\n');
  });

  test('prepends incomplete callout when option is set', () => {
    const md = renderTerseFromStructured(
      { schemaVersion: TERSE_SCHEMA_VERSION, sentence: 'Did a thing.' },
      { incomplete: { reason: 'crash', sessionIds: ['sid-1'] } },
    );
    expect(md).toBe('> ⚠ Incomplete: crash (sid-1)\nDid a thing.\n');
  });

  test('anonymizes paths in the sentence', () => {
    const md = renderTerseFromStructured(
      {
        schemaVersion: TERSE_SCHEMA_VERSION,
        sentence: 'Edited /home/lex/proj/x.ts.',
      },
      { home: '/home/lex' },
    );
    expect(md).toBe('Edited ~/proj/x.ts.\n');
  });
});
