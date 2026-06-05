import { describe, expect, test } from 'bun:test';
import { buildResumeContext, shouldSkipResumeContext } from '../../src/recap/resume-context.ts';
import { RECAP_SCHEMA_VERSION, type RecapIntermediate } from '../../src/recap/types.ts';

const baseIntermediate = (overrides: Partial<RecapIntermediate> = {}): RecapIntermediate => ({
  schemaVersion: RECAP_SCHEMA_VERSION,
  generatedAt: 0,
  scope: { kind: 'session_specific', sessionIds: ['s-1'], range: { start: 0, end: 0 } },
  completeness: { incomplete: false, incompleteSessions: [], incompleteReason: '' },
  goal: { text: 'Refactor queue retry logic', sourceStepId: 'step-1' },
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

const RESUMED_AT = Date.UTC(2026, 4, 9, 12, 0, 0, 0);

describe('buildResumeContext — basic shape', () => {
  test('emits the literal [resume_context] envelope', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate(),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.text.startsWith('[resume_context]\n')).toBe(true);
    expect(result.text.endsWith('[/resume_context]')).toBe(true);
    expect(result.text).toContain('Goal (original task): Refactor queue retry logic');
    expect(result.text).toContain('previous status: interrupted');
    expect(result.text).toContain('loss_bound: unknown');
    expect(result.text).toContain('Resumed at: 2026-05-09T12:00:00.000Z');
  });

  test('honors lossBound when provided', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate(),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
      lossBound: 'tool_exec mid-call',
    });
    expect(result.text).toContain('loss_bound: tool_exec mid-call');
  });

  test('byte-identical for identical input (deterministic)', () => {
    const a = buildResumeContext({
      intermediate: baseIntermediate(),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    const b = buildResumeContext({
      intermediate: baseIntermediate(),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(a.text).toBe(b.text);
  });
});

describe('buildResumeContext — decisions section', () => {
  test('emits "(none)" when no decisions', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate(),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.text).toContain('Decisions taken before crash:\n  - (none)');
    expect(result.decisionCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test('renders each decision with step / what / why / decided_by', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate({
        decisions: [
          {
            stepId: 'abc1234567',
            what: 'extract computeBackoff',
            why: 'testability isolated',
            decidedBy: 'user',
          },
        ],
      }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.text).toContain(
      '  - step abc1234: extract computeBackoff — testability isolated (decided_by: user)',
    );
    expect(result.decisionCount).toBe(1);
  });

  test('caps to last 5 decisions when more are present', () => {
    const decisions = Array.from({ length: 10 }, (_, i) => ({
      stepId: `step-${i}`,
      what: `decision ${i}`,
      why: '',
      decidedBy: 'user' as const,
    }));
    const result = buildResumeContext({
      intermediate: baseIntermediate({ decisions }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    // Last 5 → indexes 5..9
    expect(result.decisionCount).toBe(5);
    expect(result.text).toContain('decision 5');
    expect(result.text).toContain('decision 9');
    expect(result.text).not.toContain('decision 0');
    expect(result.text).not.toContain('decision 4');
  });

  test('head+tail-truncates decisions when over the byte budget', () => {
    // Synthesize 5 long decisions to bust a tight budget. The
    // helper's char-budget approximation is `maxTokens * 4`, so
    // we set maxTokens=20 (≈ 80 chars) — well below a single
    // decision line — to force truncation.
    const decisions = Array.from({ length: 5 }, (_, i) => ({
      stepId: `step-${i}`,
      what: `${'x'.repeat(80)} decision ${i}`,
      why: '',
      decidedBy: 'user' as const,
    }));
    const result = buildResumeContext({
      intermediate: baseIntermediate({ decisions }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
      maxTokens: 20,
    });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('decisions elided');
    // First 2 + last 2 still appear.
    expect(result.text).toContain('decision 0');
    expect(result.text).toContain('decision 1');
    expect(result.text).toContain('decision 3');
    expect(result.text).toContain('decision 4');
    // Middle is the elided marker.
    expect(result.text).toContain('  - ... 1 decisions elided ...');
  });
});

describe('buildResumeContext — pins', () => {
  test('pins are always rendered (never truncated) with kind tag', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate({
        pinnedContext: [
          { kind: 'invariant', text: 'never write to /etc', createdBy: 'user' },
          { kind: 'reminder', text: 'tests live under tests/', createdBy: 'user' },
        ],
      }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.pinCount).toBe(2);
    expect(result.text).toContain('  - [invariant] never write to /etc');
    expect(result.text).toContain('  - [reminder] tests live under tests/');
  });

  test('pins from the pin_context tool get a (model) suffix', () => {
    // createdBy === 'model_proposed_user_approved' marks pins that
    // came through the tool path (operator approved a model
    // proposal via the modal). Operator-direct pins (/pin) get
    // no suffix to keep the common case quiet.
    const result = buildResumeContext({
      intermediate: baseIntermediate({
        pinnedContext: [
          { kind: 'constraint', text: 'operator pin', createdBy: 'user' },
          {
            kind: 'workflow',
            text: 'model-proposed pin',
            createdBy: 'model_proposed_user_approved',
          },
        ],
      }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.text).toContain('  - [constraint] operator pin');
    expect(result.text).not.toContain('  - [constraint] operator pin (model)');
    expect(result.text).toContain('  - [workflow] model-proposed pin (model)');
  });

  test('pins survive an aggressive truncation budget', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate({
        pinnedContext: [
          { kind: 'invariant', text: 'pin-one', createdBy: 'user' },
          { kind: 'reminder', text: 'pin-two', createdBy: 'user' },
        ],
        decisions: Array.from({ length: 5 }, (_, i) => ({
          stepId: `step-${i}`,
          what: `${'y'.repeat(80)} d${i}`,
          why: '',
          decidedBy: 'user' as const,
        })),
      }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
      maxTokens: 30,
    });
    // Pins still rendered even though decisions got truncated.
    expect(result.text).toContain('pin-one');
    expect(result.text).toContain('pin-two');
    expect(result.truncated).toBe(true);
  });
});

describe('buildResumeContext — notDone (Open todos)', () => {
  test('emits "(none)" when notDone is empty', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate(),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.text).toContain('Open todos:\n  - (none)');
    expect(result.todoCount).toBe(0);
  });

  test('renders notDone items with reason when present', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate({
        notDone: [
          { what: 'audit external callers', reason: 'out of scope' },
          { what: 'update changelog', reason: '' },
        ],
      }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.text).toContain('  - audit external callers (out of scope)');
    expect(result.text).toContain('  - update changelog');
    expect(result.todoCount).toBe(2);
  });
});

describe('buildResumeContext — degraded fallback', () => {
  test('flags degraded when projection has no goal / decisions / pins / notDone', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate({
        goal: { text: '', sourceStepId: '' },
      }),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.degraded).toBe(true);
    // Even degraded, the trailing Resumed-at line is present.
    expect(result.text).toContain('Resumed at:');
    expect(result.text).toContain('previous status: interrupted');
  });

  test('not degraded when goal text is present even with no decisions', () => {
    const result = buildResumeContext({
      intermediate: baseIntermediate(),
      previousStatus: 'interrupted',
      resumedAt: RESUMED_AT,
    });
    expect(result.degraded).toBe(false);
  });
});

describe('shouldSkipResumeContext', () => {
  test('skips terminal statuses', () => {
    expect(shouldSkipResumeContext('done')).toBe(true);
    expect(shouldSkipResumeContext('exhausted')).toBe(true);
    expect(shouldSkipResumeContext('error')).toBe(true);
  });

  test('does not skip recoverable statuses', () => {
    expect(shouldSkipResumeContext('running')).toBe(false);
    expect(shouldSkipResumeContext('interrupted')).toBe(false);
  });
});
