import { describe, expect, test } from 'bun:test';
import { renderHuman, renderJson, renderRecap } from '../../src/recap/render.ts';
import { RECAP_SCHEMA_VERSION, type RecapIntermediate } from '../../src/recap/types.ts';

const empty = (): RecapIntermediate => ({
  schemaVersion: RECAP_SCHEMA_VERSION,
  generatedAt: 1_000,
  scope: {
    kind: 'session_specific',
    sessionIds: ['8b3c0a17-1234-4abc-9def-000000000000'],
    range: { start: 0, end: 0 },
  },
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
    model: 'sonnet',
    cacheHitRatio: 0,
  },
  errors: [],
  notDone: [],
  unresolvedQuestions: [],
  memoryProposed: [],
});

describe('renderJson', () => {
  test('emits indented JSON parseable back to the original', () => {
    const data = empty();
    data.actions.filesRead.push({ path: '/home/lex/proj/a.ts', count: 2 });
    const out = renderJson(data);
    expect(out).toContain('"schemaVersion": "v1"');
    expect(JSON.parse(out)).toEqual(data);
  });

  test('json renderer is path-literal regardless of anonymization options', () => {
    const data = empty();
    data.actions.filesRead.push({ path: '/home/lex/secret/x.ts', count: 1 });
    const out = renderRecap(data, 'json', { anonymizePaths: true, home: '/home/lex' });
    expect(out).toContain('/home/lex/secret/x.ts');
  });
});

describe('renderHuman', () => {
  test('empty intermediate produces minimal valid markdown with cost section', () => {
    const out = renderHuman(empty(), { home: '/home/lex' });
    expect(out).toContain('# Recap —');
    expect(out).toContain('(0ms)');
    expect(out).toContain('## Cost');
    expect(out).toContain('$0.00');
    expect(out).toContain('sonnet');
    expect(out.endsWith('\n')).toBe(true);
    // Empty sections are omitted, not stubbed.
    expect(out).not.toContain('## What changed');
    expect(out).not.toContain('## Decisions');
    expect(out).not.toContain('## Tests');
  });

  test('renders goal, file changes, commands, decisions, tests, cost', () => {
    const data = empty();
    data.goal = {
      text: 'refactor queue retry logic',
      sourceStepId: 'a1b2c3d4-e5f6-1234-9abc-000000000000',
    };
    data.costs = {
      tokens: { in: 12_000, out: 800, cached: 9_000 },
      usd: 0.04,
      durationMs: 4 * 60 * 1000 + 32 * 1000,
      model: 'sonnet-4-6',
      cacheHitRatio: 0.75,
    };
    data.actions.filesRead.push({ path: '/proj/src/a.ts', count: 3 });
    data.actions.filesWritten.push({
      path: '/proj/src/b.ts',
      linesAdded: 0,
      linesRemoved: 0,
      semanticSummary: '',
    });
    data.actions.commandsRun.push({ command: 'bun test', exitCode: 0, durationMs: 1234 });
    data.outcomes.testsRun.push({ command: 'bun test', passed: true, durationMs: 1234 });
    data.decisions.push({
      stepId: 'feedcafe-1111-2222-3333-444444444444',
      what: 'bash: rm -rf /tmp/old',
      why: 'cleanup intentional',
      decidedBy: 'user',
    });
    data.outcomes.checkpoints.push({ id: 'ckpt1', stepId: 'step1', filesAffected: 0 });

    const out = renderHuman(data, { home: '/home/lex' });
    expect(out).toContain('**Goal:** refactor queue retry logic');
    expect(out).toContain('## What changed');
    expect(out).toContain('1 files read');
    expect(out).toContain('1 files edited');
    expect(out).toContain('1 commands run');
    expect(out).toContain('1 checkpoint(s)');
    expect(out).toContain('## Files edited');
    expect(out).toContain('`/proj/src/b.ts`');
    expect(out).toContain('## Tests');
    expect(out).toContain('✓ `bun test`');
    expect(out).toContain('## Decisions');
    expect(out).toContain('feedcaf');
    expect(out).toContain('bash: rm -rf /tmp/old');
    expect(out).toContain('(user)');
    expect(out).toContain('cleanup intentional');
    expect(out).toContain('$0.04');
    expect(out).toContain('12.0k in / 800 out');
    expect(out).toContain('75% cached');
    expect(out).toContain('sonnet-4-6');
    expect(out).toContain('(4m32s)');
  });

  test('anonymizes $HOME paths in human renderer by default', () => {
    const data = empty();
    data.actions.filesWritten.push({
      path: '/home/lex/secret/x.ts',
      linesAdded: 0,
      linesRemoved: 0,
      semanticSummary: '',
    });
    const out = renderHuman(data, { home: '/home/lex' });
    expect(out).toContain('`~/secret/x.ts`');
    expect(out).not.toContain('/home/lex/secret');
  });

  test('anonymizePaths:false leaves paths literal', () => {
    const data = empty();
    data.actions.filesWritten.push({
      path: '/home/lex/secret/x.ts',
      linesAdded: 0,
      linesRemoved: 0,
      semanticSummary: '',
    });
    const out = renderHuman(data, { home: '/home/lex', anonymizePaths: false });
    expect(out).toContain('`/home/lex/secret/x.ts`');
  });

  test('failed test renders ✗ marker', () => {
    const data = empty();
    data.outcomes.testsRun.push({ command: 'pytest', passed: false, durationMs: 50 });
    const out = renderHuman(data);
    expect(out).toContain('✗ `pytest`');
  });

  test('incomplete session surfaces explicit warning callout', () => {
    const data = empty();
    data.completeness = {
      incomplete: true,
      incompleteSessions: ['ffeebbcc-1111-2222-3333-444444444444'],
      incompleteReason: '1 session(s) in non-terminal state',
    };
    const out = renderHuman(data);
    expect(out).toContain('⚠');
    expect(out).toContain('non-terminal state');
    expect(out).toContain('ffeebbc');
  });

  test('open questions section surfaces only when populated', () => {
    const data = empty();
    data.unresolvedQuestions.push('Should we proceed with the second batch?');
    const out = renderHuman(data);
    expect(out).toContain('## Open questions');
    expect(out).toContain('Should we proceed with the second batch?');
  });

  test('not_done section surfaces only when populated', () => {
    const data = empty();
    data.notDone.push({ what: 'src/queue-consumer.ts refactor', reason: 'out of scope' });
    const out = renderHuman(data);
    expect(out).toContain('## Not done');
    expect(out).toContain('out of scope');
  });

  test('memory proposed section surfaces only when populated', () => {
    const data = empty();
    data.memoryProposed.push({ name: 'feedback_no_x', scope: 'project_local', accepted: false });
    const out = renderHuman(data);
    expect(out).toContain('## Memory proposed');
    expect(out).toContain('`feedback_no_x`');
  });

  test('day scope label uses the date window', () => {
    const data = empty();
    data.scope = {
      kind: 'day',
      sessionIds: ['s1', 's2'],
      range: { start: Date.UTC(2026, 4, 7), end: Date.UTC(2026, 4, 8) },
    };
    const out = renderHuman(data);
    expect(out).toContain('# Recap — day 2026-05-07');
  });

  test('range scope label includes session count', () => {
    const data = empty();
    data.scope = {
      kind: 'range',
      sessionIds: ['s1', 's2', 's3'],
      range: { start: 100, end: 1_000 },
    };
    const out = renderHuman(data);
    expect(out).toContain('# Recap — range (3 sessions)');
  });

  test('strips ANSI escapes from goal and command lines', () => {
    const data = empty();
    data.goal = { text: '[31mhostile goal[0m', sourceStepId: 'x' };
    data.outcomes.testsRun.push({
      command: '[31mbun test[0m',
      passed: true,
      durationMs: 1,
    });
    const out = renderHuman(data);
    expect(out).not.toContain('');
    expect(out).toContain('hostile goal');
    expect(out).toContain('bun test');
  });

  test('determinism: same input → byte-identical output', () => {
    const data = empty();
    data.goal = { text: 'do stuff', sourceStepId: 'x' };
    data.actions.commandsRun.push({ command: 'echo hi', exitCode: 0, durationMs: 5 });
    const a = renderHuman(data, { home: '/home/lex' });
    const b = renderHuman(data, { home: '/home/lex' });
    expect(a).toBe(b);
  });
});

describe('renderRecap dispatcher', () => {
  test('json delegates to renderJson', () => {
    const data = empty();
    expect(renderRecap(data, 'json')).toBe(renderJson(data));
  });

  test('human delegates to renderHuman', () => {
    const data = empty();
    const opts = { home: '/home/lex' };
    expect(renderRecap(data, 'human', opts)).toBe(renderHuman(data, opts));
  });
});
