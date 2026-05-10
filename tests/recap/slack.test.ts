import { describe, expect, test } from 'bun:test';
import {
  projectSlackDeterministic,
  renderSlackFromStructured,
} from '../../src/recap/slack/index.ts';
import {
  SLACK_LIMITS,
  SLACK_SCHEMA_VERSION,
  type SlackRenderV1,
  validateSlackRenderV1,
} from '../../src/recap/slack/schema.ts';
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

const valid = (): SlackRenderV1 => ({
  schemaVersion: SLACK_SCHEMA_VERSION,
  title: 'Refactor queue retry logic',
  durationLabel: '4m32s',
  costLabel: '$0.04',
  achievements: ['Edited 3 files', 'Tests: 5/5 passing'],
  files: ['/p/x.ts'],
  decisions: ['Did NOT rename validateToken'],
});

describe('validateSlackRenderV1', () => {
  test('accepts a fully populated valid shape', () => {
    expect(validateSlackRenderV1(valid()).ok).toBe(true);
  });

  test('rejects empty title', () => {
    const v = { ...valid(), title: '' };
    expect(validateSlackRenderV1(v).ok).toBe(false);
  });

  test("rejects '*' in title (would corrupt Slack bold span)", () => {
    const v = { ...valid(), title: 'Refactor *queue* logic' };
    const result = validateSlackRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("title must not contain '*'"))).toBe(true);
  });

  test('rejects missing achievements', () => {
    const v = { ...valid(), achievements: [] };
    expect(validateSlackRenderV1(v).ok).toBe(false);
  });

  test('rejects too-long title', () => {
    const v = { ...valid(), title: 'x'.repeat(SLACK_LIMITS.titleMaxChars + 1) };
    expect(validateSlackRenderV1(v).ok).toBe(false);
  });

  test('rejects extra top-level properties', () => {
    expect(validateSlackRenderV1({ ...valid(), tone: 'cheerful' }).ok).toBe(false);
  });

  test('rejects too many decisions', () => {
    const v = {
      ...valid(),
      decisions: Array.from({ length: SLACK_LIMITS.decisionsMaxItems + 1 }, () => 'x'),
    };
    expect(validateSlackRenderV1(v).ok).toBe(false);
  });

  test('files array is allowed to be empty', () => {
    const v = { ...valid(), files: [] };
    expect(validateSlackRenderV1(v).ok).toBe(true);
  });
});

describe('projectSlackDeterministic', () => {
  test('empty intermediate produces a sentinel achievement, never empty array', () => {
    const result = projectSlackDeterministic(baseIntermediate());
    expect(validateSlackRenderV1(result).ok).toBe(true);
    expect(result.achievements).toHaveLength(1);
    expect(result.achievements[0]).toContain('No actions recorded');
  });

  test('title falls back to "Recap" when goal text is empty', () => {
    expect(projectSlackDeterministic(baseIntermediate()).title).toBe('Recap');
  });

  test('title takes the first line of the goal', () => {
    const result = projectSlackDeterministic(
      baseIntermediate({
        goal: { text: 'Refactor queue\n(plus other stuff)', sourceStepId: 'st' },
      }),
    );
    expect(result.title).toBe('Refactor queue');
  });

  test('achievements aggregate action counts', () => {
    const result = projectSlackDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [{ path: '/p/x.ts', linesAdded: 1, linesRemoved: 0, semanticSummary: '' }],
          commandsRun: [{ command: 'echo', exitCode: 0, durationMs: 1 }],
          webFetches: [],
          subagentsSpawned: [],
        },
        outcomes: {
          testsRun: [
            { command: 'bun test', passed: true, durationMs: 1 },
            { command: 'bun integ', passed: false, durationMs: 1 },
          ],
          checkpoints: [],
          artifacts: [],
        },
      }),
    );
    expect(result.achievements).toContain('Edited 1 file(s)');
    expect(result.achievements).toContain('Ran 1 command(s)');
    expect(result.achievements).toContain('Tests: 1/2 passing');
  });

  test('files list contains the literal write paths', () => {
    const result = projectSlackDeterministic(
      baseIntermediate({
        actions: {
          filesRead: [],
          filesWritten: [
            { path: '/p/a.ts', linesAdded: 1, linesRemoved: 0, semanticSummary: '' },
            { path: '/p/b.ts', linesAdded: 2, linesRemoved: 0, semanticSummary: '' },
          ],
          commandsRun: [],
          webFetches: [],
          subagentsSpawned: [],
        },
      }),
    );
    expect(result.files).toEqual(['/p/a.ts', '/p/b.ts']);
  });

  test('decisions: user-decided come first, then hook/policy', () => {
    const result = projectSlackDeterministic(
      baseIntermediate({
        decisions: [
          { stepId: 's', what: 'block bash', why: '', decidedBy: 'policy' },
          { stepId: 's', what: 'rename Foo', why: '', decidedBy: 'user' },
        ],
      }),
    );
    expect(result.decisions[0]).toContain('rename Foo');
    expect(result.decisions[1]).toContain('block bash');
  });

  test('files capped at the schema limit', () => {
    const filesWritten = Array.from({ length: SLACK_LIMITS.filesMaxItems + 5 }, (_, i) => ({
      path: `/p/file-${i}.ts`,
      linesAdded: 1,
      linesRemoved: 0,
      semanticSummary: '',
    }));
    const result = projectSlackDeterministic(
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
    expect(result.files.length).toBeLessThanOrEqual(SLACK_LIMITS.filesMaxItems);
  });
});

describe('renderSlackFromStructured', () => {
  test('emits ASCII bullets (no ✓ / •)', () => {
    const md = renderSlackFromStructured({
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'x',
      durationLabel: '1s',
      costLabel: '$0.00',
      achievements: ['did a thing'],
      files: [],
      decisions: ['decided x'],
    });
    expect(md).toContain('* did a thing');
    expect(md).toContain('- decided x');
    expect(md).not.toContain('✓');
    expect(md).not.toContain('•');
  });

  test('omits empty files block', () => {
    const md = renderSlackFromStructured({
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'x',
      durationLabel: '1s',
      costLabel: '$0.00',
      achievements: ['a'],
      files: [],
      decisions: [],
    });
    expect(md).not.toContain('Files:');
    expect(md).not.toContain('Decisions:');
  });

  test('renders title with bold marker and metadata in parens', () => {
    const md = renderSlackFromStructured({
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'Refactor queue',
      durationLabel: '4m32s',
      costLabel: '$0.04',
      achievements: ['a'],
      files: [],
      decisions: [],
    });
    expect(md.split('\n')[0]).toBe('*Refactor queue* (4m32s, $0.04)');
  });

  test('anonymizes paths in files block', () => {
    const md = renderSlackFromStructured(
      {
        schemaVersion: SLACK_SCHEMA_VERSION,
        title: 'x',
        durationLabel: '1s',
        costLabel: '$0.00',
        achievements: ['a'],
        files: ['/home/lex/proj/x.ts'],
        decisions: [],
      },
      { home: '/home/lex' },
    );
    expect(md).toContain('`~/proj/x.ts`');
    expect(md).not.toContain('/home/lex');
  });

  test('prepends incomplete callout when option is set', () => {
    const md = renderSlackFromStructured(
      {
        schemaVersion: SLACK_SCHEMA_VERSION,
        title: 'x',
        durationLabel: '1s',
        costLabel: '$0',
        achievements: ['a'],
        files: [],
        decisions: [],
      },
      { incomplete: { reason: 'crash', sessionIds: ['sid-1'] } },
    );
    // Slack template is ASCII-only by schema contract — `!`
    // marker, never `⚠`. The other renderers keep `⚠`.
    expect(md.startsWith('> ! Incomplete: crash (sid-1)')).toBe(true);
    expect(md).toContain('*x*');
  });

  test('output ends with a single trailing newline', () => {
    const md = renderSlackFromStructured({
      schemaVersion: SLACK_SCHEMA_VERSION,
      title: 'x',
      durationLabel: '1s',
      costLabel: '$0.00',
      achievements: ['a'],
      files: [],
      decisions: [],
    });
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });
});
