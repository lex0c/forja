import { describe, expect, test } from 'bun:test';
import {
  projectHumanDeterministic,
  renderHumanFromStructured,
} from '../../src/recap/human/index.ts';
import {
  HUMAN_LIMITS,
  HUMAN_SCHEMA_VERSION,
  type HumanRenderV1,
  validateHumanRenderV1,
} from '../../src/recap/human/schema.ts';
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

describe('validateHumanRenderV1', () => {
  const valid = (): HumanRenderV1 => ({
    schemaVersion: HUMAN_SCHEMA_VERSION,
    summary: ['did the thing'],
  });

  test('accepts a minimal valid shape', () => {
    expect(validateHumanRenderV1(valid()).ok).toBe(true);
  });

  test('rejects empty summary', () => {
    expect(validateHumanRenderV1({ ...valid(), summary: [] }).ok).toBe(false);
  });

  test('rejects too-many summary items', () => {
    const summary = Array.from({ length: HUMAN_LIMITS.summaryMaxItems + 1 }, () => 'x');
    expect(validateHumanRenderV1({ ...valid(), summary }).ok).toBe(false);
  });

  test('rejects sentence over the cap', () => {
    const summary = ['x'.repeat(HUMAN_LIMITS.summaryMaxChars + 1)];
    expect(validateHumanRenderV1({ ...valid(), summary }).ok).toBe(false);
  });

  test('rejects extra top-level properties', () => {
    expect(validateHumanRenderV1({ ...valid(), tone: 'cheerful' }).ok).toBe(false);
  });
});

describe('projectHumanDeterministic', () => {
  test('empty intermediate produces a sentinel summary', () => {
    const result = projectHumanDeterministic(baseIntermediate());
    expect(validateHumanRenderV1(result).ok).toBe(true);
    expect(result.summary[0]).toContain('No actions recorded');
  });

  test('first bullet is the goal first-line', () => {
    const result = projectHumanDeterministic(
      baseIntermediate({
        goal: { text: 'Refactor queue\n(plus other stuff)', sourceStepId: 'st' },
      }),
    );
    expect(result.summary[0]).toBe('Refactor queue');
  });

  test('second bullet is the count summary when present', () => {
    const result = projectHumanDeterministic(
      baseIntermediate({
        goal: { text: 'do thing', sourceStepId: 'st' },
        actions: {
          filesRead: [],
          filesWritten: [{ path: '/p/a.ts', linesAdded: 1, linesRemoved: 0, semanticSummary: '' }],
          commandsRun: [{ command: 'echo', exitCode: 0, durationMs: 1 }],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.summary[1]).toContain('1 files edited');
    expect(result.summary[1]).toContain('1 commands run');
  });

  test('user-decided decisions become bullets', () => {
    const result = projectHumanDeterministic(
      baseIntermediate({
        goal: { text: 'do thing', sourceStepId: 'st' },
        decisions: [
          { stepId: 's', what: 'rename Foo', why: 'clarity', decidedBy: 'user' },
          { stepId: 's', what: 'block bash', why: 'policy', decidedBy: 'policy' },
        ],
      }),
    );
    expect(result.summary.some((s) => s.includes('rename Foo'))).toBe(true);
    expect(result.summary.some((s) => s.includes('block bash'))).toBe(false);
  });

  test('caps total bullets at the schema limit', () => {
    const decisions = Array.from({ length: HUMAN_LIMITS.summaryMaxItems + 5 }, (_, i) => ({
      stepId: 's',
      what: `decision-${i}`,
      why: '',
      decidedBy: 'user' as const,
    }));
    const result = projectHumanDeterministic(
      baseIntermediate({ goal: { text: 'goal', sourceStepId: 'st' }, decisions }),
    );
    expect(result.summary.length).toBeLessThanOrEqual(HUMAN_LIMITS.summaryMaxItems);
  });
});

describe('renderHumanFromStructured', () => {
  test('emits ## Resumo block when summary is non-empty', () => {
    const md = renderHumanFromStructured(
      { schemaVersion: HUMAN_SCHEMA_VERSION, summary: ['did x', 'did y'] },
      baseIntermediate({ goal: { text: 'do thing', sourceStepId: 'st' } }),
    );
    expect(md).toContain('## Resumo');
    expect(md).toContain('- did x');
    expect(md).toContain('- did y');
    // Resumo precedes the deterministic counts section.
    const resumoIdx = md.indexOf('## Resumo');
    const changedIdx = md.indexOf('## What changed');
    if (changedIdx > -1) expect(resumoIdx).toBeLessThan(changedIdx);
  });

  test('preserves the deterministic ## Cost block', () => {
    const md = renderHumanFromStructured(
      { schemaVersion: HUMAN_SCHEMA_VERSION, summary: ['x'] },
      baseIntermediate({
        costs: {
          tokens: { in: 100, out: 50, cached: 10 },
          usd: 0.04,
          durationMs: 4_000,
          model: 'sonnet',
          cacheHitRatio: 0.5,
        },
      }),
    );
    expect(md).toContain('## Cost');
    expect(md).toContain('$0.04');
    expect(md).toContain('sonnet');
  });

  test('prepends incomplete callout when option is set', () => {
    const md = renderHumanFromStructured(
      { schemaVersion: HUMAN_SCHEMA_VERSION, summary: ['x'] },
      baseIntermediate(),
      { incomplete: { reason: 'session crashed', sessionIds: ['s-1'] } },
    );
    expect(md).toContain('> ⚠ Incomplete: session crashed (s-1)');
  });

  test('output ends with a single trailing newline', () => {
    const md = renderHumanFromStructured(
      { schemaVersion: HUMAN_SCHEMA_VERSION, summary: ['x'] },
      baseIntermediate(),
    );
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  test('emits ## Issues with recovered/unrecovered state tags', () => {
    const md = renderHumanFromStructured(
      { schemaVersion: HUMAN_SCHEMA_VERSION, summary: ['x'] },
      baseIntermediate({
        errors: [
          { code: 'provider.rate_limit', recovered: true, summary: 'backed off and retried' },
          { code: 'sandbox.denied', recovered: false, summary: '' },
        ],
      }),
    );
    expect(md).toContain('## Issues');
    expect(md).toContain('- `provider.rate_limit` (recovered) — backed off and retried');
    // Empty summary → no trailing dash clause.
    expect(md).toContain('- `sandbox.denied` (unrecovered)');
    expect(md).not.toContain('(unrecovered) —');
  });

  test('omits ## Issues entirely when there are no errors', () => {
    const md = renderHumanFromStructured(
      { schemaVersion: HUMAN_SCHEMA_VERSION, summary: ['x'] },
      baseIntermediate(),
    );
    expect(md).not.toContain('## Issues');
  });
});
