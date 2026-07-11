import { describe, expect, test } from 'bun:test';
import { projectPrDeterministic } from '../../src/recap/pr/deterministic.ts';
import { PR_SCHEMA_VERSION, validatePrRenderV1 } from '../../src/recap/pr/schema.ts';
import { renderPrFromStructured } from '../../src/recap/pr/template.ts';
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

describe('projectPrDeterministic', () => {
  test('produces a schema-valid PrRenderV1 for an empty intermediate', () => {
    const result = projectPrDeterministic(baseIntermediate());
    const validation = validatePrRenderV1(result);
    expect(validation.ok).toBe(true);
    expect(result.schemaVersion).toBe(PR_SCHEMA_VERSION);
    expect(result.summary).toEqual(['No changes recorded for this scope']);
  });

  test('first summary bullet is the first line of the goal', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        goal: { text: 'extract backoff helper\n(plus other stuff)', sourceStepId: 'st-1' },
      }),
    );
    expect(result.summary[0]).toBe('extract backoff helper');
  });

  test('second summary bullet aggregates action counts', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        goal: { text: 'do refactor', sourceStepId: 'st-1' },
        actions: {
          filesRead: [{ path: '/a', count: 1 }],
          filesWritten: [
            { path: '/x', linesAdded: 1, linesRemoved: 0, semanticSummary: '' },
            { path: '/y', linesAdded: 2, linesRemoved: 1, semanticSummary: '' },
          ],
          commandsRun: [{ command: 'echo hi', exitCode: 0, durationMs: 1 }],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.summary[1]).toContain('2 files edited');
    expect(result.summary[1]).toContain('1 files read');
    expect(result.summary[1]).toContain('1 commands run');
  });

  test('user-decided decisions become summary bullets', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        goal: { text: 'do thing', sourceStepId: 'st-1' },
        decisions: [
          { stepId: 'st-1', what: 'rename Foo', why: 'clarity', decidedBy: 'user' },
          { stepId: 'st-2', what: 'block bash', why: 'policy', decidedBy: 'policy' },
        ],
      }),
    );
    // user decision lifted into summary; policy decision must NOT be there
    expect(result.summary.some((s) => s.includes('rename Foo'))).toBe(true);
    expect(result.summary.some((s) => s.includes('block bash'))).toBe(false);
  });

  test('non-user decisions surface as notes', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        decisions: [
          { stepId: 'st-2', what: 'block bash', why: 'policy', decidedBy: 'policy' },
          { stepId: 'st-3', what: 'block edit', why: 'hook', decidedBy: 'hook' },
        ],
      }),
    );
    expect(result.notes.some((n) => n.startsWith('policy block bash'))).toBe(true);
    expect(result.notes.some((n) => n.startsWith('hook block edit'))).toBe(true);
  });

  test('changes[].bullets fall back when line counts are unknown', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [{ path: '/p/a.ts', linesAdded: 0, linesRemoved: 0, semanticSummary: '' }],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.changes[0]?.bullets).toEqual(['edited (line counts unavailable)']);
  });

  test('changes[].bullets include semanticSummary when present', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [
            { path: '/p/a.ts', linesAdded: 7, linesRemoved: 1, semanticSummary: 'extract helper' },
          ],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.changes[0]?.bullets).toEqual(['+7 / -1 lines', 'extract helper']);
  });

  test('passing tests become done; failing become todo', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        outcomes: {
          testsRun: [
            { command: 'bun test', passed: true, durationMs: 1 },
            { command: 'bun integration', passed: false, durationMs: 2 },
          ],
          checkpoints: [],
          artifacts: [],
        },
      }),
    );
    expect(result.testPlan[0]).toEqual({ item: 'bun test', status: 'done' });
    expect(result.testPlan[1]).toEqual({ item: 'bun integration', status: 'todo' });
  });

  test('notDone[] entries become manual testPlan items', () => {
    const result = projectPrDeterministic(
      baseIntermediate({ notDone: [{ what: 'audit external callers', reason: 'out of scope' }] }),
    );
    expect(result.testPlan).toContainEqual({ item: 'audit external callers', status: 'manual' });
  });

  test('notes are capped at 3 items even when many candidates exist', () => {
    const result = projectPrDeterministic(
      baseIntermediate({
        decisions: [
          { stepId: 's', what: 'a', why: '', decidedBy: 'policy' },
          { stepId: 's', what: 'b', why: '', decidedBy: 'policy' },
          { stepId: 's', what: 'c', why: '', decidedBy: 'policy' },
          { stepId: 's', what: 'd', why: '', decidedBy: 'policy' },
        ],
        unresolvedQuestions: ['q1?', 'q2?'],
      }),
    );
    expect(result.notes.length).toBeLessThanOrEqual(3);
  });
});

describe('renderPrFromStructured', () => {
  test('omits sections that are empty (no changes section for read-only)', () => {
    const md = renderPrFromStructured({
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['read 3 files'],
      changes: [],
      testPlan: [],
      notes: [],
    });
    expect(md).toContain('## Summary');
    expect(md).not.toContain('## Changes');
    expect(md).not.toContain('## Test plan');
    expect(md).not.toContain('## Notes');
  });

  test('test_plan markers map to checkbox / tilde / blank', () => {
    const md = renderPrFromStructured({
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['x'],
      changes: [],
      testPlan: [
        { item: 'unit', status: 'done' },
        { item: 'integration', status: 'todo' },
        { item: 'manual sweep', status: 'manual' },
      ],
      notes: [],
    });
    expect(md).toContain('- [x] unit');
    expect(md).toContain('- [ ] integration');
    expect(md).toContain('- [~] manual sweep');
  });

  test('anonymizes paths under the supplied home', () => {
    const md = renderPrFromStructured(
      {
        schemaVersion: PR_SCHEMA_VERSION,
        summary: ['x'],
        changes: [{ path: '/home/lex/proj/a.ts', bullets: ['+1 / -0'] }],
        testPlan: [],
        notes: [],
      },
      { home: '/home/lex' },
    );
    expect(md).toContain('### `~/proj/a.ts`');
    expect(md).not.toContain('/home/lex');
  });

  test('output ends with a single trailing newline', () => {
    const md = renderPrFromStructured({
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['x'],
      changes: [],
      testPlan: [],
      notes: [],
    });
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  test('prepends incomplete callout when option is set (RECAP §10)', () => {
    const md = renderPrFromStructured(
      {
        schemaVersion: PR_SCHEMA_VERSION,
        summary: ['x'],
        changes: [],
        testPlan: [],
        notes: [],
      },
      { incomplete: { reason: 'session crashed', sessionIds: ['s-1'] } },
    );
    expect(md.startsWith('> ⚠ Incomplete: session crashed (s-1)')).toBe(true);
    expect(md).toContain('## Summary');
  });
});
